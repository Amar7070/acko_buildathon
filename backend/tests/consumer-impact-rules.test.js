const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDatabase } = require("../src/db");
const { createApp } = require("../src/app");
const { classifyChange } = require("../src/domain/classify");
const { attachImpact } = require("../src/domain/impact");
const consumerService = require("../src/services/consumer.service");

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contract-guard-impact-rules-"));
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

async function setup(t) {
  const context = await startTestServer(t);

  await registerProvider(context.baseUrl, "quote-api", "Quote API", "Quotes");
  await registerProvider(context.baseUrl, "policy-api", "Policy API", "Policy");
  await registerProvider(context.baseUrl, "claims-api", "Claims API", "Claims");

  const imported = await call(context.baseUrl, "POST", "/api/v1/consumers/import", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory: "consumers" }),
  });
  assert.equal(imported.response.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.imported, 4);

  const usagesFor = (slug) => {
    const service = context.db.prepare("SELECT id FROM services WHERE slug = ?").get(slug);
    assert.ok(service, `Missing provider service ${slug}.`);
    return consumerService.listUsagesForService(context.db, service.id);
  };

  return { ...context, quoteUsages: usagesFor("quote-api"), claimsUsages: usagesFor("claims-api") };
}

function makeChange(overrides = {}) {
  return {
    kind: "response_field_removed",
    method: "POST",
    path: "/quotes",
    location: "response",
    direction: "response",
    fieldPath: null,
    contentType: null,
    statusCode: null,
    parameter: null,
    before: null,
    after: null,
    isInternal: false,
    ...overrides,
  };
}

function impacted(usages, overrides) {
  const [change] = attachImpact([classifyChange(makeChange(overrides))], usages);
  return change;
}

function slugs(change) {
  return change.affectedConsumers.map((consumer) => consumer.slug);
}

test("company consumer manifests import from the folder and drive impact matching", async (t) => {
  const { db, quoteUsages, claimsUsages } = await setup(t);

  assert.deepEqual(
    db
      .prepare("SELECT slug FROM consumers ORDER BY slug")
      .all()
      .map((row) => row.slug),
    ["mobile-app", "notifications-svc", "partner-portal", "payments-svc"],
  );
  assert.equal(quoteUsages.length, 4);
  assert.equal(claimsUsages.length, 3);

  await t.test("endpoint removals affect every caller of that operation", () => {
    const quoteCreate = impacted(quoteUsages, {
      kind: "endpoint_removed",
      location: "endpoint",
      direction: "endpoint",
    });
    assert.deepEqual(slugs(quoteCreate), ["mobile-app", "partner-portal"]);
    assert.equal(quoteCreate.blocksPublish, true);

    const quoteRead = impacted(quoteUsages, {
      kind: "endpoint_removed",
      method: "GET",
      path: "/quotes/{}",
      location: "endpoint",
      direction: "endpoint",
    });
    assert.deepEqual(slugs(quoteRead), ["mobile-app", "notifications-svc"]);
  });

  await t.test("added endpoints and non-breaking changes do not affect consumers", () => {
    const added = impacted(quoteUsages, {
      kind: "endpoint_added",
      location: "endpoint",
      direction: "endpoint",
    });
    assert.deepEqual(slugs(added), []);

    const optionalParameter = impacted(quoteUsages, {
      kind: "parameter_added",
      location: "parameter",
      direction: "parameter",
      parameter: { name: "region", in: "query", required: false, schema: {} },
    });
    assert.deepEqual(slugs(optionalParameter), []);

    const optionalField = impacted(quoteUsages, {
      kind: "request_field_added",
      location: "request",
      direction: "request",
      fieldPath: "rider.ncbPercent",
      after: { required: false, type: "integer" },
    });
    assert.deepEqual(slugs(optionalField), []);
  });

  await t.test("required parameters affect all callers, other parameter changes match senders", () => {
    const requiredAdded = impacted(quoteUsages, {
      kind: "parameter_added",
      location: "parameter",
      direction: "parameter",
      parameter: { name: "region", in: "query", required: true, schema: {} },
    });
    assert.deepEqual(slugs(requiredAdded), ["mobile-app", "partner-portal"]);
    assert.ok(requiredAdded.affectedConsumers.every((consumer) => consumer.via === "operation"));

    const becameRequired = impacted(quoteUsages, {
      kind: "parameter_required_changed",
      method: "GET",
      path: "/quotes/{}",
      location: "parameter",
      direction: "parameter",
      parameter: { name: "id", in: "path", required: true, schema: {} },
      before: false,
      after: true,
    });
    assert.deepEqual(slugs(becameRequired), ["mobile-app", "notifications-svc"]);

    const removedQuery = impacted(quoteUsages, {
      kind: "parameter_removed",
      location: "parameter",
      direction: "parameter",
      parameter: { name: "rider.city", in: "query", required: false, schema: {} },
    });
    assert.deepEqual(slugs(removedQuery), ["partner-portal"]);
    assert.equal(removedQuery.affectedConsumers[0].via, "sends");

    const pathTypeChanged = impacted(quoteUsages, {
      kind: "parameter_type_changed",
      method: "GET",
      path: "/quotes/{}",
      location: "parameter",
      direction: "parameter",
      parameter: { name: "id", in: "path", required: true, schema: {} },
      before: "string",
      after: "integer",
    });
    assert.deepEqual(slugs(pathTypeChanged), ["mobile-app", "notifications-svc"]);
  });

  await t.test("request fields match senders, and newly required fields affect all callers", () => {
    const requiredAdded = impacted(quoteUsages, {
      kind: "request_field_added",
      location: "request",
      direction: "request",
      fieldPath: "rider.ncbPercent",
      after: { required: true, type: "integer" },
    });
    assert.deepEqual(slugs(requiredAdded), ["mobile-app", "partner-portal"]);
    assert.ok(requiredAdded.affectedConsumers.every((consumer) => consumer.via === "operation"));

    const removed = impacted(quoteUsages, {
      kind: "request_field_removed",
      location: "request",
      direction: "request",
      fieldPath: "rider.city",
    });
    assert.deepEqual(slugs(removed), ["partner-portal"]);
    assert.deepEqual(removed.affectedConsumers[0].matchedFields, ["rider.city"]);

    const narrowed = impacted(quoteUsages, {
      kind: "request_field_enum_changed",
      location: "request",
      direction: "request",
      fieldPath: "vehicle.make",
      before: ["HONDA", "TOYOTA", "TESLA"],
      after: ["HONDA", "TOYOTA"],
    });
    assert.equal(narrowed.severity, "BREAKING");
    assert.deepEqual(slugs(narrowed), ["mobile-app", "partner-portal"]);
  });

  await t.test("response fields match readers, and removed status codes affect all callers", () => {
    const removedAmount = impacted(quoteUsages, {
      fieldPath: "premium.breakdown[].amount",
    });
    assert.deepEqual(slugs(removedAmount), ["mobile-app"]);
    assert.deepEqual(removedAmount.affectedConsumers[0].matchedFields, [
      "premium.breakdown[].amount",
    ]);

    const removedAncestor = impacted(quoteUsages, { fieldPath: "premium" });
    assert.deepEqual(slugs(removedAncestor), ["mobile-app", "partner-portal"]);

    const added = impacted(quoteUsages, {
      kind: "response_field_added",
      fieldPath: "premium.taxes",
      after: { required: false, type: "number" },
    });
    assert.deepEqual(slugs(added), []);

    const statusRemoved = impacted(quoteUsages, {
      kind: "response_status_removed",
      location: "response",
      direction: "response",
      statusCode: "404",
    });
    assert.deepEqual(slugs(statusRemoved), ["mobile-app", "partner-portal"]);

    const statusAdded = impacted(quoteUsages, {
      kind: "response_status_added",
      location: "response",
      direction: "response",
      statusCode: "202",
    });
    assert.deepEqual(slugs(statusAdded), []);
  });

  await t.test("response enum additions and optional guarantees reach only readers", () => {
    const enumExpanded = impacted(quoteUsages, {
      kind: "response_field_enum_changed",
      fieldPath: "status",
      before: ["QUOTED", "ACCEPTED"],
      after: ["QUOTED", "ACCEPTED", "EXPIRED"],
    });
    assert.equal(enumExpanded.severity, "POTENTIAL");
    assert.deepEqual(slugs(enumExpanded), ["mobile-app"]);
    assert.equal(enumExpanded.blocksPublish, false);

    const amountApproved = impacted(claimsUsages, {
      kind: "response_field_required_changed",
      method: "GET",
      path: "/claims/{}",
      fieldPath: "amountApproved",
      before: true,
      after: false,
    });
    assert.equal(amountApproved.severity, "POTENTIAL");
    assert.deepEqual(slugs(amountApproved), ["mobile-app"]);
  });

  await t.test("internal operations never affect external consumers", () => {
    const internal = impacted(quoteUsages, {
      kind: "parameter_added",
      location: "parameter",
      direction: "parameter",
      parameter: { name: "region", in: "query", required: true, schema: {} },
      isInternal: true,
    });
    assert.equal(internal.severity, "INTERNAL");
    assert.deepEqual(slugs(internal), []);
    assert.equal(internal.blocksPublish, false);
  });
});
