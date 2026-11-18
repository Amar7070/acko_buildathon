const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDatabase } = require("../src/db");
const { createApp } = require("../src/app");

const SPEC_ROOT = path.resolve(__dirname, "../../specs");

const QUOTE_SPECS = [
  ["quote-api/1-initial.yaml", "1.0.0"],
  ["quote-api/2-reorganised.yaml", "1.1.0"],
  ["quote-api/3-price-lines.yaml", "2.0.0"],
  ["quote-api/4-ncb-and-taxes.yaml", "2.1.0"],
];

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contract-guard-diff-"));
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

async function uploadYaml(baseUrl, service, relativeFile) {
  const content = fs.readFileSync(path.join(SPEC_ROOT, relativeFile), "utf8");
  const result = await call(baseUrl, "POST", `/api/v1/services/${service}/specs`, {
    headers: { "Content-Type": "application/yaml" },
    body: content,
  });
  assert.equal(result.response.status, 201, `${relativeFile}: ${JSON.stringify(result.body)}`);
  return result.body.version;
}

async function setupQuoteService(t) {
  const context = await startTestServer(t);

  const registered = await call(context.baseUrl, "POST", "/api/v1/services", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "quote-api", name: "Quote API", ownerTeam: "Quotes" }),
  });
  assert.equal(registered.response.status, 201);

  const versions = [];
  for (const [file] of QUOTE_SPECS) {
    versions.push(await uploadYaml(context.baseUrl, "quote-api", file));
  }

  return { ...context, versions };
}

function kinds(changes) {
  return changes.map((change) => change.kind).sort();
}

test("diff over real starter specs: renames and inlining produce no changes", async (t) => {
  const { baseUrl, versions } = await setupQuoteService(t);

  const comparison = await call(
    baseUrl,
    "GET",
    `/api/v1/services/quote-api/diff?from=${versions[0].id}&to=${versions[1].id}`,
  );

  assert.equal(comparison.response.status, 200, JSON.stringify(comparison.body));
  assert.equal(comparison.body.from.revision, 1);
  assert.equal(comparison.body.to.revision, 2);
  assert.equal(comparison.body.from.declaredVersion, "1.0.0");
  assert.equal(comparison.body.to.declaredVersion, "1.1.0");

  // Revision 1 references Vehicle/Rider/BreakdownItem; revision 2 inlines them,
  // renames the path parameter id -> quoteId, and moves Premium -> PremiumDetails.
  // None of that changes the wire contract.
  assert.deepEqual(comparison.body.changes, []);
  assert.equal(comparison.body.summary.total, 0);
});

test("diff detects renamed response fields and an added required parameter", async (t) => {
  const { baseUrl, versions } = await setupQuoteService(t);

  const comparison = await call(
    baseUrl,
    "GET",
    `/api/v1/services/quote-api/diff?from=${versions[1].id}&to=${versions[2].id}`,
  );

  assert.equal(comparison.response.status, 200, JSON.stringify(comparison.body));
  const { changes, summary } = comparison.body;

  assert.equal(summary.total, 7, JSON.stringify(changes, null, 2));
  assert.deepEqual(kinds(changes), [
    "parameter_added",
    "response_field_added",
    "response_field_added",
    "response_field_enum_changed",
    "response_field_enum_changed",
    "response_field_removed",
    "response_field_removed",
  ]);

  const enumChanges = changes.filter((change) => change.kind === "response_field_enum_changed");
  assert.ok(enumChanges.every((change) => change.fieldPath === "status"));
  assert.ok(enumChanges.every((change) => change.before.join(",") === "DRAFT,FINAL"));
  assert.ok(enumChanges.every((change) => change.after.join(",") === "DRAFT,FINAL,EXPIRED"));

  const added = changes.filter((change) => change.kind === "response_field_added");
  assert.ok(added.every((change) => change.fieldPath === "premium.breakdown[].value"));
  assert.ok(added.every((change) => change.after.type === "number"));

  const removed = changes.filter((change) => change.kind === "response_field_removed");
  assert.ok(removed.every((change) => change.fieldPath === "premium.breakdown[].amount"));
  assert.ok(removed.every((change) => change.before.type === "number"));

  const parameter = changes.find((change) => change.kind === "parameter_added");
  assert.equal(parameter.parameter.name, "region");
  assert.equal(parameter.parameter.in, "query");
  assert.equal(parameter.parameter.required, true);

  assert.deepEqual(
    changes.map((change) => `${change.method} ${change.path}`).sort(),
    [
      "DELETE /internal/pricing-cache",
      "GET /quotes/{}",
      "GET /quotes/{}",
      "GET /quotes/{}",
      "POST /quotes",
      "POST /quotes",
      "POST /quotes",
    ],
  );
});

test("diff detects deeply nested request and response additions", async (t) => {
  const { baseUrl, versions } = await setupQuoteService(t);

  const comparison = await call(
    baseUrl,
    "GET",
    `/api/v1/services/quote-api/diff?from=${versions[2].id}&to=${versions[3].id}`,
  );

  assert.equal(comparison.response.status, 200, JSON.stringify(comparison.body));
  const { changes, summary } = comparison.body;

  assert.equal(summary.total, 3, JSON.stringify(changes, null, 2));

  const requestField = changes.find((change) => change.direction === "request");
  assert.equal(requestField.kind, "request_field_added");
  assert.equal(requestField.fieldPath, "rider.ncbPercent");
  assert.equal(requestField.after.type, "integer");
  assert.equal(requestField.after.required, false);

  const responseFields = changes.filter((change) => change.direction === "response");
  assert.equal(responseFields.length, 2);
  assert.ok(responseFields.every((change) => change.kind === "response_field_added"));
  assert.ok(responseFields.every((change) => change.fieldPath === "premium.taxes"));
  assert.ok(responseFields.every((change) => change.after.type === "number"));

  assert.deepEqual(
    comparison.body.summary.byDirection,
    { request: 1, response: 2 },
  );
});

test("diff defaults to the latest two versions and validates its targets", async (t) => {
  const { baseUrl, versions } = await setupQuoteService(t);

  const latest = await call(baseUrl, "GET", "/api/v1/services/quote-api/diff");
  assert.equal(latest.response.status, 200, JSON.stringify(latest.body));
  assert.equal(latest.body.from.revision, 3);
  assert.equal(latest.body.to.revision, 4);

  const same = await call(
    baseUrl,
    "GET",
    `/api/v1/services/quote-api/diff?from=${versions[0].id}&to=${versions[0].id}`,
  );
  assert.equal(same.response.status, 400);
  assert.equal(same.body.error.code, "SAME_SPEC_VERSION");

  const partial = await call(
    baseUrl,
    "GET",
    `/api/v1/services/quote-api/diff?from=${versions[0].id}`,
  );
  assert.equal(partial.response.status, 400);
  assert.equal(partial.body.error.code, "COMPARISON_TARGET_REQUIRED");

  const unknown = await call(baseUrl, "GET", "/api/v1/services/nope/diff");
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error.code, "SERVICE_NOT_FOUND");

  const unknownSpec = await call(baseUrl, "GET", "/api/v1/services/quote-api/diff?from=1&to=9999");
  assert.equal(unknownSpec.response.status, 404);
  assert.equal(unknownSpec.body.error.code, "SPEC_NOT_FOUND");
});

test("diff only compares versions belonging to the requested service", async (t) => {
  const { baseUrl, versions } = await setupQuoteService(t);

  const registered = await call(baseUrl, "POST", "/api/v1/services", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "policy-api", name: "Policy API", ownerTeam: "Policy" }),
  });
  assert.equal(registered.response.status, 201);

  const policyVersion = await uploadYaml(baseUrl, "policy-api", "policy-api/1-initial.yaml");

  const crossService = await call(
    baseUrl,
    "GET",
    `/api/v1/services/quote-api/diff?from=${versions[0].id}&to=${policyVersion.id}`,
  );
  assert.equal(crossService.response.status, 404);
  assert.equal(crossService.body.error.code, "SPEC_NOT_IN_SERVICE");

  const notEnoughVersions = await call(baseUrl, "GET", "/api/v1/services/policy-api/diff");
  assert.equal(notEnoughVersions.response.status, 400);
  assert.equal(notEnoughVersions.body.error.code, "NOT_ENOUGH_VERSIONS");
});
