const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");

const { createDatabase } = require("../src/db");
const { createApp } = require("../src/app");

const STARTER_ROOT = path.resolve(__dirname, "../..");

const SERVICES = [
  {
    slug: "quote-api",
    name: "Quote API",
    ownerTeam: "Quotes",
    validSpecs: [
      ["quote-api/1-initial.yaml", "1.0.0"],
      ["quote-api/2-reorganised.yaml", "1.1.0"],
      ["quote-api/3-price-lines.yaml", "2.0.0"],
      ["quote-api/4-ncb-and-taxes.yaml", "2.1.0"],
    ],
  },
  {
    slug: "policy-api",
    name: "Policy API",
    ownerTeam: "Policy",
    validSpecs: [
      ["policy-api/1-initial.yaml", "1.0.0"],
      ["policy-api/2-deprecations.yaml", "1.1.0"],
      ["policy-api/3-remove-old-fields.yaml", "2.0.0"],
      ["policy-api/4-endorsement-rules.yaml", "2.1.0"],
    ],
  },
  {
    slug: "claims-api",
    name: "Claims API",
    ownerTeam: "Claims",
    validSpecs: [
      ["claims-api/1-initial.yaml", "1.0.0"],
      ["claims-api/3-channel-and-notes-fixed.yaml", "1.1.0"],
      ["claims-api/4-approval-later.yaml", "2.0.0"],
    ],
  },
];

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contract-guard-starter-"));
  const db = createDatabase(path.join(directory, "test.db"));
  const app = createApp(db);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    db,
  };
}

async function call(baseUrl, method, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, { method, ...options });
  const body = await response.json();
  return { response, body };
}

async function upload(baseUrl, service, content, contentType) {
  return call(baseUrl, "POST", `/api/v1/services/${service}/specs`, {
    headers: { "Content-Type": contentType },
    body: content,
  });
}

test("acceptance: all company starter specs behave correctly through the API and database", async (t) => {
  const { baseUrl, db } = await startTestServer(t);

  for (const service of SERVICES) {
    const registered = await call(baseUrl, "POST", "/api/v1/services", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: service.slug,
        name: service.name,
        ownerTeam: service.ownerTeam,
      }),
    });
    assert.equal(registered.response.status, 201, JSON.stringify(registered.body));
  }

  const listedServices = await call(baseUrl, "GET", "/api/v1/services");
  assert.equal(listedServices.response.status, 200);
  assert.deepEqual(
    listedServices.body.services.map((service) => service.slug).sort(),
    ["claims-api", "policy-api", "quote-api"],
  );

  // Upload every valid YAML specification from the starter kit.
  for (const service of SERVICES) {
    for (const [index, [relativeFile, declaredVersion]] of service.validSpecs.entries()) {
      const content = fs.readFileSync(path.join(STARTER_ROOT, "specs", relativeFile), "utf8");
      const result = await upload(baseUrl, service.slug, content, "application/yaml");
      assert.equal(result.response.status, 201, `${relativeFile}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.version.declaredVersion, declaredVersion);
      assert.equal(result.body.version.revision, index + 1);
      assert.equal(result.body.version.status, "draft");
      assert.equal(result.body.version.sourceFormat, "yaml");
    }
  }

  // Upload a JSON version converted from a real starter spec.
  const quoteJson = JSON.stringify(
    YAML.parse(fs.readFileSync(path.join(STARTER_ROOT, "specs/quote-api/3-price-lines.yaml"), "utf8")),
  );
  const quoteJsonUpload = await upload(baseUrl, "quote-api", quoteJson, "application/json");
  assert.equal(quoteJsonUpload.response.status, 201, JSON.stringify(quoteJsonUpload.body));
  assert.equal(quoteJsonUpload.body.version.declaredVersion, "2.0.0");
  assert.equal(quoteJsonUpload.body.version.revision, 5);
  assert.equal(quoteJsonUpload.body.version.sourceFormat, "json");
  assert.equal(quoteJsonUpload.body.version.status, "draft");
  assert.match(quoteJsonUpload.body.warnings[0], /Declared version 2\.0\.0 was already used by revision 3/);

  // Claim 2 from the starter kit has an invalid $ref and must be rejected.
  const claimsBeforeInvalid = db
    .prepare("SELECT COUNT(*) AS count FROM spec_versions WHERE service_id = (SELECT id FROM services WHERE slug = 'claims-api')")
    .get().count;

  const invalidClaims = fs.readFileSync(
    path.join(STARTER_ROOT, "specs/claims-api/2-channel-and-notes.yaml"),
    "utf8",
  );
  const invalidClaimsUpload = await upload(baseUrl, "claims-api", invalidClaims, "application/yaml");
  assert.equal(invalidClaimsUpload.response.status, 422);
  assert.equal(invalidClaimsUpload.body.error.code, "INVALID_SPEC");
  assert.match(invalidClaimsUpload.body.error.details[0].message, /ClaimDocumnt/);

  const claimsAfterInvalid = db
    .prepare("SELECT COUNT(*) AS count FROM spec_versions WHERE service_id = (SELECT id FROM services WHERE slug = 'claims-api')")
    .get().count;
  assert.equal(claimsAfterInvalid, claimsBeforeInvalid, "invalid spec must not be stored");

  // Malformed YAML and unsupported OpenAPI versions must also be rejected.
  const malformed = await upload(baseUrl, "policy-api", "openapi: [3.0.3", "application/yaml");
  assert.equal(malformed.response.status, 422);
  assert.equal(malformed.body.error.code, "INVALID_SPEC");

  const unsupported = await upload(
    baseUrl,
    "policy-api",
    JSON.stringify({ openapi: "3.1.0", info: { title: "Test", version: "1.0.0" }, paths: {} }),
    "application/json",
  );
  assert.equal(unsupported.response.status, 422);
  assert.equal(unsupported.body.error.code, "UNSUPPORTED_OPENAPI_VERSION");

  // Exact duplicate uploads are rejected.
  const duplicate = await upload(
    baseUrl,
    "quote-api",
    fs.readFileSync(path.join(STARTER_ROOT, "specs/quote-api/1-initial.yaml"), "utf8"),
    "application/yaml",
  );
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, "SPEC_ALREADY_EXISTS");

  // API listing: all stored versions are drafts with sequential revisions.
  for (const service of SERVICES) {
    const versions = await call(baseUrl, "GET", `/api/v1/services/${service.slug}/specs`);
    assert.equal(versions.response.status, 200);
    const expectedCount = service.slug === "quote-api" ? 5 : service.validSpecs.length;
    assert.equal(versions.body.versions.length, expectedCount);
    assert.ok(versions.body.versions.every((version) => version.status === "draft"));
    assert.deepEqual(
      versions.body.versions.map((version) => version.revision).sort((a, b) => a - b),
      Array.from({ length: expectedCount }, (_, index) => index + 1),
    );
  }

  // Database verification: 12 stored drafts, no invalid or published rows.
  const stored = db.prepare("SELECT * FROM spec_versions ORDER BY service_id, revision").all();
  assert.equal(stored.length, 12);
  assert.ok(stored.every((row) => row.status === "draft"));
  assert.ok(stored.every((row) => row.raw_spec.trim().length > 0));
  assert.ok(stored.every((row) => row.parsed_spec_json.trim().length > 0));
  assert.equal(stored.filter((row) => row.source_format === "json").length, 1);
  assert.equal(stored.filter((row) => row.source_format === "yaml").length, 11);
  assert.equal(stored.filter((row) => row.status === "rejected").length, 0);
  assert.equal(stored.filter((row) => row.status === "published").length, 0);

  const byService = db
    .prepare(`
      SELECT s.slug, COUNT(v.id) AS versions, MIN(v.revision) AS first_revision, MAX(v.revision) AS last_revision
      FROM services s
      JOIN spec_versions v ON v.service_id = s.id
      GROUP BY s.id
      ORDER BY s.slug
    `)
    .all();

  assert.deepEqual(
    byService.map((row) => ({ ...row })),
    [
      { slug: "claims-api", versions: 3, first_revision: 1, last_revision: 3 },
      { slug: "policy-api", versions: 4, first_revision: 1, last_revision: 4 },
      { slug: "quote-api", versions: 5, first_revision: 1, last_revision: 5 },
    ],
  );
});
