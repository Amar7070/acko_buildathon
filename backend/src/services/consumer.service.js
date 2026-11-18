const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const registry = require("./registry.service");
const { canonicalizePath } = require("../domain/openapi-contract");
const { AppError, badRequest, notFound } = require("../utils/errors");

const HTTP_METHODS = new Set(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"]);
const MANIFEST_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_CONSUMERS_DIRECTORY = process.env.CONSUMERS_DIR
  ? path.resolve(process.env.CONSUMERS_DIR)
  : path.join(PROJECT_ROOT, "consumers");

function invalidConsumer(message, details) {
  return new AppError(422, "INVALID_CONSUMER", message, details);
}

function parseYamlDocument(content) {
  try {
    return YAML.parse(content);
  } catch (err) {
    throw invalidConsumer("The consumer manifest could not be parsed as YAML or JSON.", [
      { path: "", message: err.message },
    ]);
  }
}

function extractConsumerInput(req) {
  const body = req.body;
  let document;

  if (typeof body === "string") {
    document = parseYamlDocument(body);
  } else if (body && typeof body === "object" && !Array.isArray(body)) {
    if (typeof body.content === "string") {
      document = parseYamlDocument(body.content);
    } else if (body.content && typeof body.content === "object" && !Array.isArray(body.content)) {
      document = body.content;
    } else {
      document = body;
    }
  } else {
    throw badRequest("EMPTY_CONSUMER", "No consumer manifest was provided.");
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw invalidConsumer("The consumer manifest must be a YAML or JSON object.");
  }

  return document;
}

function normaliseStringList(value, fieldPath) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidConsumer(`${fieldPath} must be a list of field names.`, [
      { path: fieldPath, message: "Expected an array of strings." },
    ]);
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function normaliseUses(db, uses) {
  if (!Array.isArray(uses)) {
    throw invalidConsumer("Consumer uses must be a list of provider operations.", [
      { path: "uses", message: "Expected an array." },
    ]);
  }

  return uses.map((use, index) => {
    const path = `uses[${index}]`;
    if (!use || typeof use !== "object" || Array.isArray(use)) {
      throw invalidConsumer(`${path} must be an object.`, [
        { path, message: "Expected a provider usage object." },
      ]);
    }

    const provider = typeof use.provider === "string" ? use.provider.trim() : "";
    const method = typeof use.method === "string" ? use.method.trim().toUpperCase() : "";
    const rawPath = typeof use.path === "string" ? use.path.trim() : "";

    if (!provider) {
      throw invalidConsumer(`${path}.provider is required.`, [
        { path: `${path}.provider`, message: "Name the provider service slug." },
      ]);
    }
    if (!HTTP_METHODS.has(method)) {
      throw invalidConsumer(`${path}.method must be a valid HTTP method.`, [
        { path: `${path}.method`, message: `Received ${JSON.stringify(use.method)}.` },
      ]);
    }
    if (!rawPath.startsWith("/")) {
      throw invalidConsumer(`${path}.path must start with "/".`, [
        { path: `${path}.path`, message: `Received ${JSON.stringify(use.path)}.` },
      ]);
    }

    let service;
    try {
      service = registry.resolveService(db, provider);
    } catch (err) {
      if (err instanceof AppError && err.code === "SERVICE_NOT_FOUND") {
        throw invalidConsumer(`Unknown provider service "${provider}".`, [
          {
            path: `${path}.provider`,
            message: "Register the provider service before registering consumers of it.",
          },
        ]);
      }
      throw err;
    }

    return {
      serviceId: service.id,
      provider: service.slug,
      method,
      rawPath,
      pathTemplate: canonicalizePath(rawPath),
      sends: normaliseStringList(use.sends, `${path}.sends`),
      reads: normaliseStringList(use.reads, `${path}.reads`),
      sourceFile: typeof use.sourceFile === "string" ? use.sourceFile.trim() : null,
    };
  });
}

function normaliseConsumerInput(db, document) {
  const raw = document.consumer && typeof document.consumer === "object" && !Array.isArray(document.consumer)
    ? document.consumer
    : document;
  const nameSource = typeof raw.name === "string" ? raw.name.trim() : "";
  const slugSource =
    typeof raw.slug === "string"
      ? raw.slug.trim()
      : typeof raw.consumer === "string"
        ? raw.consumer.trim()
        : "";
  const slug = slugSource || registry.slugify(nameSource);
  const name = nameSource || slug;
  const teamSource = raw.team ?? raw.ownerTeam ?? raw.owner_team;
  const team = typeof teamSource === "string" ? teamSource.trim() : "";

  if (!slug) {
    throw invalidConsumer("Consumer slug is required.", [
      { path: "consumer", message: "Provide a consumer name or slug." },
    ]);
  }
  if (!name) {
    throw invalidConsumer("Consumer name is required.", [
      { path: "name", message: "Provide a non-empty consumer name." },
    ]);
  }
  if (!team) {
    throw invalidConsumer("Consumer team is required.", [
      { path: "team", message: "Provide the team that owns this consumer." },
    ]);
  }

  return {
    slug,
    name,
    team,
    uses: normaliseUses(db, raw.uses),
  };
}

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapUsageRow(row) {
  return {
    id: row.id,
    serviceId: row.service_id,
    provider: row.provider_slug,
    providerName: row.provider_name,
    method: row.method,
    path: row.raw_path,
    canonicalPath: row.path_template,
    sends: parseJsonList(row.sends_json),
    reads: parseJsonList(row.reads_json),
    sourceFile: row.source_file || null,
  };
}

function listUsagesForConsumer(db, consumerId) {
  return db
    .prepare(`
      SELECT ce.*, s.slug AS provider_slug, s.name AS provider_name
      FROM consumer_endpoints ce
      JOIN services s ON s.id = ce.service_id
      WHERE ce.consumer_id = ?
      ORDER BY s.slug, ce.method, ce.path_template
    `)
    .all(consumerId)
    .map(mapUsageRow);
}

function getConsumerById(db, id) {
  const row = db.prepare("SELECT * FROM consumers WHERE id = ?").get(id);

  if (!row) {
    throw notFound("CONSUMER_NOT_FOUND", "Consumer not found.");
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    team: row.team,
    createdAt: row.created_at,
    uses: listUsagesForConsumer(db, row.id),
  };
}

function getConsumerBySlug(db, slug) {
  const row = db.prepare("SELECT id FROM consumers WHERE slug = ?").get(String(slug || "").trim());
  if (!row) {
    throw notFound("CONSUMER_NOT_FOUND", `Consumer "${slug}" not found.`);
  }
  return getConsumerById(db, row.id);
}

function listConsumers(db) {
  const rows = db.prepare("SELECT id FROM consumers ORDER BY slug").all();
  return rows.map((row) => getConsumerById(db, row.id));
}

function writeConsumer(db, consumer) {
  const existing = db.prepare("SELECT id FROM consumers WHERE slug = ?").get(consumer.slug);
  const createdAt = new Date().toISOString();
  let consumerId;

  if (existing) {
    consumerId = existing.id;
    db.prepare("UPDATE consumers SET name = ?, team = ? WHERE id = ?").run(
      consumer.name,
      consumer.team,
      consumerId,
    );
    db.prepare("DELETE FROM consumer_endpoints WHERE consumer_id = ?").run(consumerId);
  } else {
    const result = db
      .prepare("INSERT INTO consumers (slug, name, team, created_at) VALUES (?, ?, ?, ?)")
      .run(consumer.slug, consumer.name, consumer.team, createdAt);
    consumerId = result.lastInsertRowid;
  }

  const insertUsage = db.prepare(`
    INSERT INTO consumer_endpoints (
      consumer_id, service_id, method, path_template, raw_path,
      sends_json, reads_json, source_file
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const use of consumer.uses) {
    insertUsage.run(
      consumerId,
      use.serviceId,
      use.method,
      use.pathTemplate,
      use.rawPath,
      JSON.stringify(use.sends),
      JSON.stringify(use.reads),
      use.sourceFile,
    );
  }

  return { created: !existing, consumerId };
}

function upsertConsumer(db, input) {
  const consumer = normaliseConsumerInput(db, input);
  const write = db.transaction(() => writeConsumer(db, consumer));
  const { created, consumerId } = write();

  return {
    created,
    consumer: getConsumerById(db, consumerId),
  };
}

function resolveConsumersDirectory(directoryInput) {
  const source =
    typeof directoryInput === "string" && directoryInput.trim()
      ? directoryInput.trim()
      : DEFAULT_CONSUMERS_DIRECTORY;
  const resolved = path.isAbsolute(source) ? path.resolve(source) : path.resolve(PROJECT_ROOT, source);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw badRequest(
      "INVALID_CONSUMER_DIRECTORY",
      `Consumer manifest directory "${source}" does not exist.`,
    );
  }

  return resolved;
}

function withFileContext(err, file) {
  if (err instanceof AppError) {
    return new AppError(err.status, err.code, `${file}: ${err.message}`, err.details, err.meta);
  }

  return invalidConsumer(`${file}: ${err.message}`, [{ path: file, message: err.message }]);
}

/**
 * Read every YAML/JSON consumer manifest in a directory and register it.
 * All files are validated before any rows are written, then written in one
 * transaction so a bad manifest cannot leave a half-imported directory.
 */
function importConsumersFromDirectory(db, directoryInput) {
  const directory = resolveConsumersDirectory(directoryInput);
  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MANIFEST_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();

  const prepared = files.map((file) => {
    const absolutePath = path.join(directory, file);
    let document;

    try {
      document = parseYamlDocument(fs.readFileSync(absolutePath, "utf8"));
    } catch (err) {
      throw withFileContext(err, file);
    }

    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw invalidConsumer(`${file}: the consumer manifest must be a YAML or JSON object.`);
    }

    const withSource = Array.isArray(document.uses)
      ? {
          ...document,
          uses: document.uses.map((use) =>
            use && typeof use === "object" && !Array.isArray(use) && !use.sourceFile
              ? { ...use, sourceFile: file }
              : use,
          ),
        }
      : document;

    try {
      return {
        file,
        consumer: normaliseConsumerInput(db, withSource),
      };
    } catch (err) {
      throw withFileContext(err, file);
    }
  });

  const writeAll = db.transaction(() =>
    prepared.map(({ file, consumer }) => {
      const { created } = writeConsumer(db, consumer);

      return {
        file,
        slug: consumer.slug,
        name: consumer.name,
        team: consumer.team,
        useCount: consumer.uses.length,
        created,
      };
    }),
  );

  const imported = writeAll();
  const created = imported.filter((entry) => entry.created).length;

  return {
    directory,
    imported: imported.length,
    created,
    updated: imported.length - created,
    consumers: imported,
  };
}

function deleteConsumer(db, slug) {
  const row = db.prepare("SELECT id FROM consumers WHERE slug = ?").get(String(slug || "").trim());
  if (!row) {
    throw notFound("CONSUMER_NOT_FOUND", `Consumer "${slug}" not found.`);
  }
  db.prepare("DELETE FROM consumers WHERE id = ?").run(row.id);
}

/**
 * Flat usage rows used by the impact matcher.
 */
function listUsagesForService(db, serviceId) {
  return db
    .prepare(`
      SELECT
        ce.id, ce.consumer_id, ce.service_id, ce.method, ce.path_template,
        ce.raw_path, ce.sends_json, ce.reads_json,
        c.slug AS consumer_slug, c.name AS consumer_name, c.team
      FROM consumer_endpoints ce
      JOIN consumers c ON c.id = ce.consumer_id
      WHERE ce.service_id = ?
    `)
    .all(serviceId)
    .map((row) => ({
      consumerId: row.consumer_id,
      consumerSlug: row.consumer_slug,
      consumerName: row.consumer_name,
      team: row.team,
      serviceId: row.service_id,
      method: row.method,
      pathTemplate: row.path_template,
      rawPath: row.raw_path,
      sends: parseJsonList(row.sends_json),
      reads: parseJsonList(row.reads_json),
    }));
}

module.exports = {
  extractConsumerInput,
  normaliseConsumerInput,
  upsertConsumer,
  importConsumersFromDirectory,
  listConsumers,
  getConsumerById,
  getConsumerBySlug,
  deleteConsumer,
  listUsagesForService,
};
