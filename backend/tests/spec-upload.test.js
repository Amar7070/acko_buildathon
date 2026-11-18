const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");

const { createDatabase } = require("../src/db");
const { createApp } = require("../src/app");

const QUOTE_SPEC_DIR = path.resolve(__dirname, "../../specs/quote-api");
const QUOTE_SPECS = [
  ["1-initial.yaml", "1.0.0"],
  ["2-reorganised.yaml", "1.1.0"],
  ["3-price-lines.yaml", "2.0.0"],
  ["4-ncb-and-taxes.yaml", "2.1.0"],
];

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contract-guard-"));
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

async function registerQuoteService(baseUrl) {
  return call(baseUrl, "POST", "/api/v1/services", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Quote API",
      ownerTeam: "Quotes",
      description: "Bike insurance quotes",
    }),
  });
}

async function uploadYaml(baseUrl, service, filename) {
  const content = fs.readFileSync(path.join(QUOTE_SPEC_DIR, filename), "utf8");
  const result = await call(baseUrl, "POST", `/api/v1/services/${service}/specs`, {
    headers: { "Content-Type": "application/yaml" },
    body: content,
  });
  return { ...result, content };
}

test("registers a service and derives a slug", async (t) => {
  const { baseUrl } = await startTestServer(t);

  const created = await registerQuoteService(baseUrl);
  assert.equal(created.response.status, 201);
  assert.equal(created.body.service.slug, "quote-api");
  assert.equal(created.body.service.ownerTeam, "Quotes");
  assert.equal(created.body.service.specCount, 0);

  const listed = await call(baseUrl, "GET", "/api/v1/services");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.services.length, 1);
  assert.equal(listed.body.services[0].slug, "quote-api");

  const detail = await call(baseUrl, "GET", "/api/v1/services/quote-api");
  assert.equal(detail.response.status, 200);
  assert.deepEqual(detail.body.versions, []);
});

test("imports all four quote-api YAML specs as drafts and deduplicates exact uploads", async (t) => {
  const { baseUrl } = await startTestServer(t);
  await registerQuoteService(baseUrl);

  for (const [index, [filename, declaredVersion]] of QUOTE_SPECS.entries()) {
    const uploaded = await uploadYaml(baseUrl, "quote-api", filename);
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.version.declaredVersion, declaredVersion);
    assert.equal(uploaded.body.version.revision, index + 1);
    assert.equal(uploaded.body.version.status, "draft");
    assert.equal(uploaded.body.version.sourceFormat, "yaml");
    assert.equal(uploaded.body.version.title, "Quote API");
    assert.ok(uploaded.body.version.pathCount >= 2);
    assert.deepEqual(uploaded.body.warnings, []);
  }

  const versions = await call(baseUrl, "GET", "/api/v1/services/quote-api/specs");
  assert.equal(versions.response.status, 200);
  assert.equal(versions.body.versions.length, 4);
  assert.deepEqual(versions.body.versions.map((version) => version.revision), [4, 3, 2, 1]);
  assert.ok(versions.body.versions.every((version) => version.status === "draft"));

  const detail = await call(baseUrl, "GET", "/api/v1/services/quote-api");
  assert.equal(detail.body.service.specCount, 4);
  assert.equal(detail.body.service.draftCount, 4);
  assert.equal(detail.body.service.publishedCount, 0);
  assert.equal(detail.body.service.latestVersion, "2.1.0");

  const duplicate = await uploadYaml(baseUrl, "quote-api", "1-initial.yaml");
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, "SPEC_ALREADY_EXISTS");
  assert.equal(typeof duplicate.body.error.existingSpecId, "number");
});

test("accepts raw JSON specs and JSON upload envelopes", async (t) => {
  const { baseUrl } = await startTestServer(t);
  await registerQuoteService(baseUrl);

  const yaml = fs.readFileSync(path.join(QUOTE_SPEC_DIR, "2-reorganised.yaml"), "utf8");
  const parsed = YAML.parse(yaml);

  const rawJson = await call(baseUrl, "POST", "/api/v1/services/quote-api/specs", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed),
  });
  assert.equal(rawJson.response.status, 201, JSON.stringify(rawJson.body));
  assert.equal(rawJson.body.version.sourceFormat, "json");
  assert.equal(rawJson.body.version.declaredVersion, "1.1.0");
  assert.equal(rawJson.body.version.revision, 1);

  const envelope = await call(baseUrl, "POST", "/api/v1/services/quote-api/specs", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: YAML.stringify(parsed),
      format: "yaml",
      uploadedBy: "test-engineer",
    }),
  });
  assert.equal(envelope.response.status, 201, JSON.stringify(envelope.body));
  assert.equal(envelope.body.version.sourceFormat, "yaml");
  assert.equal(envelope.body.version.revision, 2);
  assert.equal(envelope.body.version.uploadedBy, "test-engineer");
  assert.equal(envelope.body.warnings.length, 1);
  assert.match(envelope.body.warnings[0], /Declared version 1\.1\.0 was already used by revision 1/);
});

test("rejects malformed, unsupported and invalid specifications", async (t) => {
  const { baseUrl } = await startTestServer(t);
  await registerQuoteService(baseUrl);

  const malformed = await call(baseUrl, "POST", "/api/v1/services/quote-api/specs", {
    headers: { "Content-Type": "application/yaml" },
    body: "openapi: [3.0.3",
  });
  assert.equal(malformed.response.status, 422);
  assert.equal(malformed.body.error.code, "INVALID_SPEC");
  assert.ok(malformed.body.error.details.length > 0);

  const unsupported = await call(baseUrl, "POST", "/api/v1/services/quote-api/specs", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {},
    }),
  });
  assert.equal(unsupported.response.status, 422);
  assert.equal(unsupported.body.error.code, "UNSUPPORTED_OPENAPI_VERSION");

  const missingVersion = await call(baseUrl, "POST", "/api/v1/services/quote-api/specs", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Test" },
      paths: {},
    }),
  });
  assert.equal(missingVersion.response.status, 422);
  assert.equal(missingVersion.body.error.code, "INVALID_SPEC");

  const empty = await call(baseUrl, "POST", "/api/v1/services/quote-api/specs", {
    headers: { "Content-Type": "application/yaml" },
    body: "",
  });
  assert.equal(empty.response.status, 400);
  assert.equal(empty.body.error.code, "EMPTY_SPEC");
});

test("returns clear errors for unknown services and invalid registrations", async (t) => {
  const { baseUrl } = await startTestServer(t);

  const missingService = await call(baseUrl, "POST", "/api/v1/services/nope/specs", {
    headers: { "Content-Type": "application/yaml" },
    body: "openapi: 3.0.3\ninfo:\n  title: X\n  version: 1.0.0\npaths: {}\n",
  });
  assert.equal(missingService.response.status, 404);
  assert.equal(missingService.body.error.code, "SERVICE_NOT_FOUND");

  const missingOwner = await call(baseUrl, "POST", "/api/v1/services", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "No Owner API" }),
  });
  assert.equal(missingOwner.response.status, 400);
  assert.equal(missingOwner.body.error.code, "INVALID_SERVICE");

  const badSlug = await call(baseUrl, "POST", "/api/v1/services", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Bad Slug API", slug: "Bad Slug!", ownerTeam: "Team" }),
  });
  assert.equal(badSlug.response.status, 400);
  assert.equal(badSlug.body.error.code, "INVALID_SERVICE");
});
