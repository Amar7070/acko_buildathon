const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDatabase } = require("../src/db");
const { createApp } = require("../src/app");

const CONSUMER_ROOT = path.resolve(__dirname, "../../consumers");

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contract-guard-consumers-"));
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

  return { baseUrl: `http://127.0.0.1:${server.address().port}`, db };
}

async function call(baseUrl, method, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, { method, ...options });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function registerProvider(baseUrl, slug, name, ownerTeam) {
  const result = await call(baseUrl, "POST", "/api/v1/services", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, name, ownerTeam }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
}

async function registerProviders(baseUrl) {
  await registerProvider(baseUrl, "quote-api", "Quote API", "Quotes");
  await registerProvider(baseUrl, "policy-api", "Policy API", "Policy");
  await registerProvider(baseUrl, "claims-api", "Claims API", "Claims");
}

test("imports a starter consumer manifest from raw YAML and replaces it idempotently", async (t) => {
  const { baseUrl } = await startTestServer(t);
  await registerProviders(baseUrl);

  const yaml = fs.readFileSync(path.join(CONSUMER_ROOT, "mobile-app.yaml"), "utf8");
  const imported = await call(baseUrl, "POST", "/api/v1/consumers", {
    headers: { "Content-Type": "application/yaml" },
    body: yaml,
  });

  assert.equal(imported.response.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.created, true);
  assert.equal(imported.body.consumer.slug, "mobile-app");
  assert.equal(imported.body.consumer.team, "Mobile");
  assert.equal(imported.body.consumer.uses.length, 4);

  const quoteCreate = imported.body.consumer.uses.find(
    (use) => use.provider === "quote-api" && use.method === "POST",
  );
  assert.equal(quoteCreate.canonicalPath, "/quotes");
  assert.deepEqual(quoteCreate.sends, ["vehicle.make", "vehicle.cc", "rider.age"]);
  assert.ok(quoteCreate.reads.includes("premium.breakdown[].amount"));

  const quoteGet = imported.body.consumer.uses.find(
    (use) => use.provider === "quote-api" && use.method === "GET",
  );
  assert.equal(quoteGet.path, "/quotes/{id}");
  assert.equal(quoteGet.canonicalPath, "/quotes/{}");

  const replaced = await call(baseUrl, "POST", "/api/v1/consumers", {
    headers: { "Content-Type": "application/yaml" },
    body: yaml,
  });
  assert.equal(replaced.response.status, 200, JSON.stringify(replaced.body));
  assert.equal(replaced.body.created, false);

  const listed = await call(baseUrl, "GET", "/api/v1/consumers");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.consumers.length, 1);

  const detail = await call(baseUrl, "GET", "/api/v1/consumers/mobile-app");
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.consumer.uses.length, 4);
});

test("accepts a JSON consumer body and canonicalises path parameter names", async (t) => {
  const { baseUrl } = await startTestServer(t);
  await registerProviders(baseUrl);

  const created = await call(baseUrl, "POST", "/api/v1/consumers", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consumer: "quote-console",
      name: "Quote Console",
      team: "Developer Tools",
      uses: [
        {
          provider: "quote-api",
          method: "get",
          path: "/quotes/{quoteId}",
          sends: ["quoteId"],
          reads: ["premium.total", "status"],
        },
      ],
    }),
  });

  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.consumer.slug, "quote-console");
  assert.equal(created.body.consumer.uses[0].method, "GET");
  assert.equal(created.body.consumer.uses[0].canonicalPath, "/quotes/{}");
});

test("rejects unknown providers and invalid consumer manifests with clear errors", async (t) => {
  const { baseUrl } = await startTestServer(t);
  await registerProviders(baseUrl);

  const unknownProvider = await call(baseUrl, "POST", "/api/v1/consumers", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consumer: "ghost-client",
      team: "Ghosts",
      uses: [{ provider: "ghost-api", method: "GET", path: "/ghosts", reads: ["id"] }],
    }),
  });
  assert.equal(unknownProvider.response.status, 422);
  assert.equal(unknownProvider.body.error.code, "INVALID_CONSUMER");
  assert.match(unknownProvider.body.error.message, /Unknown provider/);

  const missingTeam = await call(baseUrl, "POST", "/api/v1/consumers", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ consumer: "no-team", uses: [] }),
  });
  assert.equal(missingTeam.response.status, 422);
  assert.equal(missingTeam.body.error.code, "INVALID_CONSUMER");

  const badMethod = await call(baseUrl, "POST", "/api/v1/consumers", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consumer: "bad-method",
      team: "QA",
      uses: [{ provider: "quote-api", method: "FETCH", path: "/quotes" }],
    }),
  });
  assert.equal(badMethod.response.status, 422);
  assert.equal(badMethod.body.error.code, "INVALID_CONSUMER");

  const malformed = await call(baseUrl, "POST", "/api/v1/consumers", {
    headers: { "Content-Type": "application/yaml" },
    body: "consumer: [",
  });
  assert.equal(malformed.response.status, 422);
  assert.equal(malformed.body.error.code, "INVALID_CONSUMER");
});

test("imports every company consumer manifest from the consumers folder", async (t) => {
  const { baseUrl, db } = await startTestServer(t);
  await registerProviders(baseUrl);

  const imported = await call(baseUrl, "POST", "/api/v1/consumers/import", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(imported.response.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.imported, 4);
  assert.equal(imported.body.created, 4);
  assert.equal(imported.body.updated, 0);
  assert.deepEqual(
    imported.body.consumers.map((consumer) => consumer.slug),
    ["mobile-app", "notifications-svc", "partner-portal", "payments-svc"],
  );
  assert.ok(
    imported.body.consumers.every((consumer) => consumer.file.endsWith(".yaml")),
  );

  const mobile = await call(baseUrl, "GET", "/api/v1/consumers/mobile-app");
  assert.equal(mobile.response.status, 200);
  assert.equal(mobile.body.consumer.uses.length, 4);
  assert.ok(mobile.body.consumer.uses.every((use) => use.sourceFile === "mobile-app.yaml"));

  const again = await call(baseUrl, "POST", "/api/v1/consumers/import", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory: "consumers" }),
  });
  assert.equal(again.response.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.imported, 4);
  assert.equal(again.body.created, 0);
  assert.equal(again.body.updated, 4);

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM consumers").get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM consumer_endpoints").get().count, 10);

  const missing = await call(baseUrl, "POST", "/api/v1/consumers/import", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory: "does-not-exist" }),
  });
  assert.equal(missing.response.status, 400);
  assert.equal(missing.body.error.code, "INVALID_CONSUMER_DIRECTORY");
});

test("deletes a consumer and its usages", async (t) => {
  const { baseUrl, db } = await startTestServer(t);
  await registerProviders(baseUrl);

  const yaml = fs.readFileSync(path.join(CONSUMER_ROOT, "payments-svc.yaml"), "utf8");
  const created = await call(baseUrl, "POST", "/api/v1/consumers", {
    headers: { "Content-Type": "application/yaml" },
    body: yaml,
  });
  assert.equal(created.response.status, 201);

  const removed = await call(baseUrl, "DELETE", "/api/v1/consumers/payments-svc");
  assert.equal(removed.response.status, 204);

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM consumer_endpoints").get().count, 0);
  const missing = await call(baseUrl, "GET", "/api/v1/consumers/payments-svc");
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, "CONSUMER_NOT_FOUND");
});
