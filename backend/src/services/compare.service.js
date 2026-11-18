const SwaggerParser = require("@apidevtools/swagger-parser");
const { normalizeDocument } = require("../domain/openapi-contract");
const { compareContracts } = require("../domain/diff");
const { AppError, badRequest, notFound } = require("../utils/errors");
const { getSpecRowById, mapSpecVersion } = require("./spec.service");

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

async function compareSummary(fromRow, toRow) {
  const [fromDocument, toDocument] = await Promise.all([
    dereferenceRow(fromRow),
    dereferenceRow(toRow),
  ]);

  const fromContract = normalizeDocument(fromDocument);
  const toContract = normalizeDocument(toDocument);
  const { summary, changes } = compareContracts(fromContract, toContract);

  return {
    from: mapSpecVersion(fromRow),
    to: mapSpecVersion(toRow),
    summary,
    changes,
  };
}

async function compareVersions(db, service, fromId, toId) {
  const { fromRow, toRow } = selectVersions(db, service, fromId, toId);
  return compareSummary(fromRow, toRow);
}

module.exports = {
  compareVersions,
  compareSummary,
  selectVersions,
};
