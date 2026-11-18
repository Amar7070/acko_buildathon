const SwaggerParser = require("@apidevtools/swagger-parser");
const { normalizeDocument } = require("../domain/openapi-contract");
const { compareContracts } = require("../domain/diff");
const { classifyChanges, summarizeSeverity } = require("../domain/classify");
const { attachImpact, summarizeImpact } = require("../domain/impact");
const { AppError, badRequest, notFound } = require("../utils/errors");
const { getSpecRowById, mapSpecVersion } = require("./spec.service");
const registry = require("./registry.service");
const consumerService = require("./consumer.service");

async function dereferenceRow(row) {
  let parsed;

  try {
    parsed = JSON.parse(row.parsed_spec_json);
  } catch (err) {
    throw new AppError(
      422,
      "COMPARISON_FAILED",
      `Specification revision ${row.revision} could not be read.`,
      [{ path: "", message: "The stored specification is not valid JSON." }],
    );
  }

  try {
    // Circular references are left as $ref nodes and are skipped by the
    // schema walker, so recursive schemas cannot cause infinite traversal.
    return await SwaggerParser.dereference(parsed, {
      dereference: { circular: "ignore" },
    });
  } catch (err) {
    throw new AppError(
      422,
      "COMPARISON_FAILED",
      `Specification revision ${row.revision} could not be dereferenced for comparison.`,
      [{ path: "", message: err.message }],
    );
  }
}

function ensureSpecBelongsToService(row, service) {
  if (row.service_id !== service.id) {
    throw notFound("SPEC_NOT_IN_SERVICE", `Specification version ${row.id} does not belong to service "${service.slug}".`);
  }
}

function selectVersions(db, service, fromId, toId) {
  const hasFrom = fromId !== undefined && fromId !== null && String(fromId).trim() !== "";
  const hasTo = toId !== undefined && toId !== null && String(toId).trim() !== "";

  if (hasFrom !== hasTo) {
    throw badRequest(
      "COMPARISON_TARGET_REQUIRED",
      "Provide both from and to specification ids, or neither to compare the latest two versions.",
    );
  }

  if (hasFrom && hasTo) {
    const fromRow = getSpecRowById(db, fromId);
    const toRow = getSpecRowById(db, toId);
    ensureSpecBelongsToService(fromRow, service);
    ensureSpecBelongsToService(toRow, service);

    if (fromRow.id === toRow.id) {
      throw badRequest("SAME_SPEC_VERSION", "Choose two different specification versions to compare.");
    }

    return { fromRow, toRow };
  }

  const rows = db
    .prepare("SELECT * FROM spec_versions WHERE service_id = ? ORDER BY revision DESC LIMIT 2")
    .all(service.id);

  if (rows.length < 2) {
    throw badRequest(
      "NOT_ENOUGH_VERSIONS",
      "At least two specification versions are needed to compare.",
    );
  }

  // Latest first from the query; compare older -> newer.
  return { fromRow: rows[1], toRow: rows[0] };
}

async function compareSummary(fromRow, toRow, usages = []) {
  const [fromDocument, toDocument] = await Promise.all([
    dereferenceRow(fromRow),
    dereferenceRow(toRow),
  ]);

  const fromContract = normalizeDocument(fromDocument);
  const toContract = normalizeDocument(toDocument);
  const { summary, changes } = compareContracts(fromContract, toContract);

  const classified = attachImpact(classifyChanges(changes), usages);

  return {
    from: mapSpecVersion(fromRow),
    to: mapSpecVersion(toRow),
    summary: {
      ...summary,
      bySeverity: summarizeSeverity(classified),
    },
    impact: summarizeImpact(classified),
    changes: classified,
  };
}

function selectBaseRow(db, service, candidate, baseId) {
  const hasBase = baseId !== undefined && baseId !== null && String(baseId).trim() !== "";

  if (hasBase) {
    const row = getSpecRowById(db, baseId);
    ensureSpecBelongsToService(row, service);

    if (row.id === candidate.id) {
      throw badRequest("SAME_SPEC_VERSION", "Choose a base version different from the candidate version.");
    }

    return row;
  }

  const published = db
    .prepare(
      "SELECT * FROM spec_versions WHERE service_id = ? AND status = 'published' AND revision < ? ORDER BY revision DESC LIMIT 1",
    )
    .get(service.id, candidate.revision);

  if (published) {
    return published;
  }

  const previous = db
    .prepare(
      "SELECT * FROM spec_versions WHERE service_id = ? AND revision < ? ORDER BY revision DESC LIMIT 1",
    )
    .get(service.id, candidate.revision);

  if (previous) {
    return previous;
  }

  throw badRequest(
    "NO_BASE_VERSION",
    "This specification has no earlier version or published baseline to compare against.",
  );
}

async function compareSpecImpact(db, specRow, baseId) {
  const service = registry.getServiceById(db, specRow.service_id);
  const baseRow = selectBaseRow(db, service, specRow, baseId);
  const usages = consumerService.listUsagesForService(db, service.id);

  return compareSummary(baseRow, specRow, usages);
}

async function compareVersions(db, service, fromId, toId) {
  const { fromRow, toRow } = selectVersions(db, service, fromId, toId);
  const usages = consumerService.listUsagesForService(db, service.id);
  return compareSummary(fromRow, toRow, usages);
}

module.exports = {
  compareVersions,
  compareSummary,
  compareSpecImpact,
  selectVersions,
  selectBaseRow,
};
