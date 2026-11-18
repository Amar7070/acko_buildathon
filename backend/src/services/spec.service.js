const crypto = require("node:crypto");
const YAML = require("yaml");
const SwaggerParser = require("@apidevtools/swagger-parser");
const { AppError, badRequest, conflict, notFound } = require("../utils/errors");

const SUPPORTED_OPENAPI = /^3\.0\.\d+$/;
const MAX_ACTOR_LENGTH = 120;

function parseSpecContent(content) {
  if (typeof content !== "string" || !content.trim()) {
    throw badRequest("EMPTY_SPEC", "No specification content was provided.", [
      { path: "content", message: "Upload a YAML or JSON OpenAPI document." },
    ]);
  }

  let parsed;
  try {
    parsed = YAML.parse(content);
  } catch (err) {
    const position = err.linePos && err.linePos[0];
    throw new AppError(
      422,
      "INVALID_SPEC",
      "The specification could not be parsed as YAML or JSON.",
      [
        {
          path: position ? `line ${position.line}, column ${position.col}` : "",
          message: err.message,
        },
      ],
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError(
      422,
      "INVALID_SPEC",
      "The specification must be a YAML or JSON object.",
    );
  }

  return parsed;
}

function assertOpenApi30(parsed) {
  if (parsed.swagger) {
    throw new AppError(
      422,
      "UNSUPPORTED_OPENAPI_VERSION",
      "Only OpenAPI 3.0.x specifications are supported.",
      [{ path: "swagger", message: `Received Swagger ${parsed.swagger}.` }],
    );
  }

  if (typeof parsed.openapi !== "string" || !SUPPORTED_OPENAPI.test(parsed.openapi)) {
    throw new AppError(
      422,
      "UNSUPPORTED_OPENAPI_VERSION",
      "Only OpenAPI 3.0.x specifications are supported.",
      [
        {
          path: "openapi",
          message: `Expected a version such as "3.0.3", received ${JSON.stringify(parsed.openapi)}.`,
        },
      ],
    );
  }

  if (
    !parsed.info ||
    typeof parsed.info !== "object" ||
    typeof parsed.info.version !== "string" ||
    !parsed.info.version.trim()
  ) {
    throw new AppError(422, "INVALID_SPEC", 'The specification needs info.version, for example "version: 1.0.0".', [
      { path: "info.version", message: "A non-empty version string is required." },
    ]);
  }
}

function formatValidationDetails(err) {
  const details = err.details || err.errors;

  if (Array.isArray(details) && details.length > 0) {
    return details.map((detail) => ({
      path: detail.instancePath || detail.dataPath || detail.path || "",
      message: detail.message || "Invalid value.",
    }));
  }

  if (Array.isArray(err.path) && err.path.length > 0) {
    return [{ path: `/${err.path.join("/")}`, message: err.message }];
  }

  return [{ path: "", message: err.message || "The specification is invalid." }];
}

async function validateSpec(parsed) {
  assertOpenApi30(parsed);

  try {
    // swagger-parser dereferences the object it validates, so give it a copy.
    const candidate = JSON.parse(JSON.stringify(parsed));
    await SwaggerParser.validate(candidate);
  } catch (err) {
    throw new AppError(
      422,
      "INVALID_SPEC",
      "The uploaded specification is not a valid OpenAPI 3.0 document.",
      formatValidationDetails(err),
    );
  }
}

function detectSourceFormat(content, formatHint) {
  const hint = typeof formatHint === "string" ? formatHint.trim().toLowerCase() : "";
  if (hint === "json" || hint === "yaml") {
    return hint;
  }

  const firstCharacter = content.trimStart()[0];
  return firstCharacter === "{" || firstCharacter === "[" ? "json" : "yaml";
}

function extractUploadInput(req) {
  const body = req.body;
  let content;
  let formatHint;
  let uploadedBy = req.get("x-actor") || "system";

  if (typeof body === "string") {
    content = body;
  } else if (body && typeof body === "object" && !Array.isArray(body)) {
    if (typeof body.content === "string") {
      content = body.content;
      formatHint = body.format;
    } else if (body.content && typeof body.content === "object") {
      content = JSON.stringify(body.content, null, 2);
      formatHint = "json";
    } else if (body.openapi || body.swagger) {
      content = JSON.stringify(body, null, 2);
      formatHint = "json";
    } else {
      throw badRequest("INVALID_UPLOAD", "The request does not contain a specification.", [
        { path: "content", message: "Send raw YAML/JSON or a JSON body with a content field." },
      ]);
    }

    if (typeof body.uploadedBy === "string" && body.uploadedBy.trim()) {
      uploadedBy = body.uploadedBy.trim();
    }
  } else {
    throw badRequest("EMPTY_SPEC", "No specification content was provided.");
  }

  if (formatHint !== undefined && formatHint !== null) {
    if (!["yaml", "json"].includes(String(formatHint).toLowerCase())) {
      throw badRequest("INVALID_FORMAT", 'format must be either "yaml" or "json".');
    }
    formatHint = String(formatHint).toLowerCase();
  }

  return {
    content,
    formatHint,
    uploadedBy: String(uploadedBy).slice(0, MAX_ACTOR_LENGTH),
  };
}

function mapSpecVersion(row) {
  if (!row) {
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(row.parsed_spec_json);
  } catch {
    parsed = null;
  }

  return {
    id: row.id,
    serviceId: row.service_id,
    declaredVersion: row.declared_version,
    revision: row.revision,
    status: row.status,
    sourceFormat: row.source_format,
    specHash: row.spec_hash,
    title: parsed && parsed.info ? parsed.info.title || null : null,
    pathCount: parsed && parsed.paths ? Object.keys(parsed.paths).length : 0,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    publishedAt: row.published_at || null,
  };
}

async function uploadSpec(db, service, input) {
  const parsed = parseSpecContent(input.content);
  await validateSpec(parsed);

  const sourceFormat = detectSourceFormat(input.content, input.formatHint);
  const specHash = crypto.createHash("sha256").update(input.content).digest("hex");

  const duplicate = db
    .prepare("SELECT * FROM spec_versions WHERE service_id = ? AND spec_hash = ?")
    .get(service.id, specHash);

  if (duplicate) {
    throw conflict(
      "SPEC_ALREADY_EXISTS",
      `This specification is already stored as revision ${duplicate.revision}.`,
      [{ path: "content", message: "The uploaded content is identical to an existing version." }],
      { existingSpecId: duplicate.id },
    );
  }

  const previousRevision = db
    .prepare("SELECT revision FROM spec_versions WHERE service_id = ? AND declared_version = ? ORDER BY revision DESC LIMIT 1")
    .get(service.id, parsed.info.version);

  const createdAt = new Date().toISOString();
  const rawSpec = input.content;
  const parsedSpecJson = JSON.stringify(parsed);

  const insertVersion = db.transaction(() => {
    const next = db
      .prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM spec_versions WHERE service_id = ?")
      .get(service.id);

    const result = db
      .prepare(`
        INSERT INTO spec_versions (
          service_id, declared_version, revision, spec_hash, source_format,
          raw_spec, parsed_spec_json, status, uploaded_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
      `)
      .run(
        service.id,
        parsed.info.version,
        next.revision,
        specHash,
        sourceFormat,
        rawSpec,
        parsedSpecJson,
        input.uploadedBy || "system",
        createdAt,
      );

    return result.lastInsertRowid;
  });

  const id = insertVersion();
  const row = db.prepare("SELECT * FROM spec_versions WHERE id = ?").get(id);
  const warnings = [];

  if (previousRevision) {
    warnings.push(
      `Declared version ${parsed.info.version} was already used by revision ${previousRevision.revision}; stored as revision ${row.revision}.`,
    );
  }

  return {
    version: mapSpecVersion(row),
    warnings,
  };
}

function listSpecsForService(db, serviceId) {
  const rows = db
    .prepare("SELECT * FROM spec_versions WHERE service_id = ? ORDER BY revision DESC")
    .all(serviceId);

  return rows.map(mapSpecVersion);
}

function getSpecById(db, id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1) {
    throw notFound("SPEC_NOT_FOUND", "Specification version not found.");
  }

  const row = db.prepare("SELECT * FROM spec_versions WHERE id = ?").get(numericId);
  if (!row) {
    throw notFound("SPEC_NOT_FOUND", "Specification version not found.");
  }

  return mapSpecVersion(row);
}

module.exports = {
  uploadSpec,
  listSpecsForService,
  getSpecById,
  parseSpecContent,
  validateSpec,
  detectSourceFormat,
  extractUploadInput,
  mapSpecVersion,
};
