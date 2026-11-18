const { badRequest, conflict, notFound } = require("../utils/errors");

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SERVICE_SELECT = `
  SELECT
    s.*,
    (SELECT COUNT(*) FROM spec_versions v WHERE v.service_id = s.id) AS spec_count,
    (SELECT COUNT(*) FROM spec_versions v WHERE v.service_id = s.id AND v.status = 'draft') AS draft_count,
    (SELECT COUNT(*) FROM spec_versions v WHERE v.service_id = s.id AND v.status = 'published') AS published_count,
    (SELECT v.declared_version FROM spec_versions v WHERE v.service_id = s.id ORDER BY v.revision DESC LIMIT 1) AS latest_version,
    (SELECT v.status FROM spec_versions v WHERE v.service_id = s.id ORDER BY v.revision DESC LIMIT 1) AS latest_status
  FROM services s
`;

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mapService(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    ownerTeam: row.owner_team,
    description: row.description,
    createdAt: row.created_at,
    specCount: row.spec_count === undefined ? undefined : row.spec_count,
    draftCount: row.draft_count === undefined ? undefined : row.draft_count,
    publishedCount: row.published_count === undefined ? undefined : row.published_count,
    latestVersion: row.latest_version || null,
    latestStatus: row.latest_status || null,
  };
}

function normaliseServiceInput(input) {
  const body = input || {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const ownerTeamSource = body.ownerTeam ?? body.owner_team ?? body.owner;
  const ownerTeam = typeof ownerTeamSource === "string" ? ownerTeamSource.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : null;
  const requestedSlug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const slug = requestedSlug || slugify(name);

  if (!name) {
    throw badRequest("INVALID_SERVICE", "Service name is required.", [
      { path: "name", message: "Provide a non-empty service name." },
    ]);
  }

  if (!ownerTeam) {
    throw badRequest("INVALID_SERVICE", "Owner team is required.", [
      { path: "ownerTeam", message: "Provide the team that owns this service." },
    ]);
  }

  if (!slug || !SLUG_PATTERN.test(slug)) {
    throw badRequest(
      "INVALID_SERVICE",
      "Service slug must contain only lowercase letters, numbers and single hyphens.",
      [{ path: "slug", message: `Received "${slug || "<empty>"}".` }],
    );
  }

  return { name, ownerTeam, description, slug };
}

function registerService(db, input) {
  const service = normaliseServiceInput(input);
  const insert = db.prepare(`
    INSERT INTO services (slug, name, owner_team, description, created_at)
    VALUES (@slug, @name, @ownerTeam, @description, @createdAt)
  `);

  try {
    const result = insert.run({
      ...service,
      createdAt: new Date().toISOString(),
    });

    return getServiceById(db, result.lastInsertRowid);
  } catch (err) {
    if (String(err.code || "").startsWith("SQLITE_CONSTRAINT")) {
      throw conflict("SERVICE_ALREADY_EXISTS", `A service with slug "${service.slug}" already exists.`, [
        { path: "slug", message: "Choose a different slug." },
      ]);
    }
    throw err;
  }
}

function getServiceById(db, id) {
  const row = db.prepare(`${SERVICE_SELECT} WHERE s.id = ?`).get(id);

  if (!row) {
    throw notFound("SERVICE_NOT_FOUND", "Service not found.");
  }

  return mapService(row);
}

function resolveService(db, reference) {
  const value = String(reference || "").trim();
  if (!value) {
    throw notFound("SERVICE_NOT_FOUND", "Service not found.");
  }

  if (/^\d+$/.test(value)) {
    return getServiceById(db, Number(value));
  }

  const row = db.prepare(`${SERVICE_SELECT} WHERE s.slug = ?`).get(value);

  if (!row) {
    throw notFound("SERVICE_NOT_FOUND", `Service "${value}" not found.`);
  }

  return mapService(row);
}

function listServices(db) {
  const rows = db.prepare(`${SERVICE_SELECT} ORDER BY s.name COLLATE NOCASE`).all();
  return rows.map(mapService);
}

module.exports = {
  registerService,
  getServiceById,
  resolveService,
  listServices,
  mapService,
  slugify,
};
