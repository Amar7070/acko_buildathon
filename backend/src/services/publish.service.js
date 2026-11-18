const { conflict } = require("../utils/errors");
const { summarizeImpact } = require("../domain/impact");
const registry = require("./registry.service");
const compareService = require("./compare.service");
const consumerService = require("./consumer.service");
const { getSpecRowById, mapSpecVersion } = require("./spec.service");

const MAX_ACTOR_LENGTH = 120;
const MAX_NOTE_LENGTH = 1000;

function normaliseActor(value) {
  const actor = typeof value === "string" ? value.trim() : "";
  return (actor || "system").slice(0, MAX_ACTOR_LENGTH);
}

function normaliseNote(value) {
  const note = typeof value === "string" ? value.trim() : "";
  return note ? note.slice(0, MAX_NOTE_LENGTH) : null;
}

function jsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJsonOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function baselineComparison(candidateRow) {
  const impact = summarizeImpact([]);

  return {
    from: null,
    to: mapSpecVersion(candidateRow),
    summary: {
      total: 0,
      byKind: {},
      byDirection: {},
      byLocation: {},
      bySeverity: { ...impact.bySeverity },
    },
    impact,
    changes: [],
  };
}

function latestPublishedBase(db, serviceId, candidateRevision) {
  return db
    .prepare(
      "SELECT * FROM spec_versions WHERE service_id = ? AND status = 'published' AND revision < ? ORDER BY revision DESC LIMIT 1",
    )
    .get(serviceId, candidateRevision);
}

function changeKey(change) {
  return [
    change.kind,
    change.method,
    change.path,
    change.location,
    change.direction,
    change.fieldPath || "",
    change.parameter ? `${change.parameter.in || ""}:${change.parameter.name || ""}` : "",
    change.statusCode || "",
    change.contentType || "",
  ].join("|");
}

function mapAttemptChange(row) {
  return {
    id: row.id,
    changeKey: row.change_key,
    method: row.method,
    path: row.path,
    location: row.location,
    fieldPath: row.field_path || null,
    kind: row.kind,
    direction: row.direction,
    severity: row.severity,
    reason: row.reason,
    isInternal: row.is_internal === 1,
    before: parseJsonOrNull(row.before_json),
    after: parseJsonOrNull(row.after_json),
  };
}

function listAttemptChanges(db, attemptId) {
  return db
    .prepare("SELECT * FROM attempt_changes WHERE attempt_id = ? ORDER BY id")
    .all(attemptId)
    .map(mapAttemptChange);
}

const ATTEMPT_SELECT = `
  SELECT
    pa.*,
    s.slug AS service_slug,
    s.name AS service_name,
    cs.declared_version AS candidate_declared_version,
    cs.revision AS candidate_revision,
    cs.status AS candidate_status,
    bs.declared_version AS base_declared_version,
    bs.revision AS base_revision,
    bs.status AS base_status
  FROM publish_attempts pa
  JOIN services s ON s.id = pa.service_id
  JOIN spec_versions cs ON cs.id = pa.candidate_spec_id
  LEFT JOIN spec_versions bs ON bs.id = pa.base_spec_id
`;

function mapAttemptRow(db, row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    serviceId: row.service_id,
    serviceSlug: row.service_slug,
    serviceName: row.service_name,
    candidateSpecId: row.candidate_spec_id,
    baseSpecId: row.base_spec_id || null,
    outcome: row.outcome,
    breakingCount: row.breaking_count,
    potentialCount: row.potential_count,
    affectedConsumerCount: row.affected_consumer_count,
    actor: row.actor,
    note: row.note || null,
    createdAt: row.created_at,
    candidate: {
      id: row.candidate_spec_id,
      declaredVersion: row.candidate_declared_version,
      revision: row.candidate_revision,
      status: row.candidate_status,
    },
    base: row.base_spec_id
      ? {
          id: row.base_spec_id,
          declaredVersion: row.base_declared_version,
          revision: row.base_revision,
          status: row.base_status,
        }
      : null,
    changes: listAttemptChanges(db, row.id),
  };
}

function getAttemptById(db, id) {
  const row = db.prepare(`${ATTEMPT_SELECT} WHERE pa.id = ?`).get(id);
  return mapAttemptRow(db, row);
}

function listAttemptsForService(db, serviceId) {
  const rows = db
    .prepare(`${ATTEMPT_SELECT} WHERE pa.service_id = ? ORDER BY pa.id DESC`)
    .all(serviceId);
  return rows.map((row) => mapAttemptRow(db, row));
}

/**
 * Run the publish gate for a draft specification. A draft is blocked when at
 * least one BREAKING change affects a registered external consumer.
 *
 * Every attempt is recorded, whether it is published or blocked.
 */
async function publishSpec(db, specId, options = {}) {
  const candidateRow = getSpecRowById(db, specId);
  const service = registry.getServiceById(db, candidateRow.service_id);

  if (candidateRow.status === "published") {
    throw conflict(
      "SPEC_ALREADY_PUBLISHED",
      `Specification revision ${candidateRow.revision} (${candidateRow.declared_version}) is already published.`,
    );
  }

  if (candidateRow.status === "rejected") {
    throw conflict(
      "SPEC_REJECTED",
      `Specification revision ${candidateRow.revision} was rejected at upload and cannot be published.`,
    );
  }

  const baseRow = latestPublishedBase(db, service.id, candidateRow.revision);
  const usages = consumerService.listUsagesForService(db, service.id);
  const comparison = baseRow
    ? await compareService.compareSummary(baseRow, candidateRow, usages)
    : baselineComparison(candidateRow);

  const blocked = comparison.impact.blocked === true;
  const outcome = blocked ? "blocked" : "published";
  const actor = normaliseActor(options.actor);
  const note = normaliseNote(options.note);
  const createdAt = new Date().toISOString();
  let attemptId;

  const persist = db.transaction(() => {
    const inserted = db
      .prepare(`
        INSERT INTO publish_attempts (
          service_id, candidate_spec_id, base_spec_id, outcome,
          breaking_count, potential_count, affected_consumer_count,
          actor, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        service.id,
        candidateRow.id,
        baseRow ? baseRow.id : null,
        outcome,
        comparison.summary.bySeverity.BREAKING || 0,
        comparison.summary.bySeverity.POTENTIAL || 0,
        comparison.impact.affectedConsumerCount || 0,
        actor,
        note,
        createdAt,
      );

    attemptId = inserted.lastInsertRowid;

    const insertChange = db.prepare(`
      INSERT INTO attempt_changes (
        attempt_id, change_key, method, path, location, field_path,
        kind, direction, severity, reason, is_internal, before_json, after_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const change of comparison.changes) {
      insertChange.run(
        attemptId,
        changeKey(change),
        change.method,
        change.path,
        change.location,
        change.fieldPath || null,
        change.kind,
        change.direction,
        change.severity,
        change.reason,
        change.isInternal ? 1 : 0,
        jsonOrNull(change.before),
        jsonOrNull(change.after),
      );
    }

    if (!blocked) {
      db.prepare("UPDATE spec_versions SET status = 'published', published_at = ? WHERE id = ?").run(
        createdAt,
        candidateRow.id,
      );
    }
  });

  persist();

  const updatedRow = db.prepare("SELECT * FROM spec_versions WHERE id = ?").get(candidateRow.id);

  return {
    outcome,
    blocked,
    published: outcome === "published",
    spec: mapSpecVersion(updatedRow),
    attempt: getAttemptById(db, attemptId),
    from: comparison.from,
    to: comparison.to,
    summary: comparison.summary,
    impact: comparison.impact,
    changes: comparison.changes,
  };
}

module.exports = {
  publishSpec,
  getAttemptById,
  listAttemptsForService,
  changeKey,
  baselineComparison,
};
