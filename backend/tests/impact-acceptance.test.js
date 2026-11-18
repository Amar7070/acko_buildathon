const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDatabase } = require("../src/db");
const { createApp } = require("../src/app");

const KIT_ROOT = path.resolve(__dirname, "../..");

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contract-guard-impact-"));
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

async function registerService(baseUrl, slug, name, ownerTeam) {
  const result = await call(baseUrl, "POST", "/api/v1/services", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, name, ownerTeam }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
}

async function uploadSpec(baseUrl, service, relativeFile) {
  const content = fs.readFileSync(path.join(KIT_ROOT, "specs", relativeFile), "utf8");
  const result = await call(baseUrl, "POST", `/api/v1/services/${service}/specs`, {
    headers: { "Content-Type": "application/yaml" },
    body: content,
  });
  assert.equal(result.response.status, 201, `${relativeFile}: ${JSON.stringify(result.body)}`);
  return result.body.version;
}

async function importAllConsumers(baseUrl) {
  const result = await call(baseUrl, "POST", "/api/v1/consumers/import", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory: "consumers" }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.imported, 4);
  return result.body.consumers;
}

async function setupKit(t) {
  const context = await startTestServer(t);
  const { baseUrl } = context;

  await registerService(baseUrl, "quote-api", "Quote API", "Quotes");
  await registerService(baseUrl, "policy-api", "Policy API", "Policy");
  await registerService(baseUrl, "claims-api", "Claims API", "Claims");

  const versions = {
    q1: await uploadSpec(baseUrl, "quote-api", "quote-api/1-initial.yaml"),
    q2: await uploadSpec(baseUrl, "quote-api", "quote-api/2-reorganised.yaml"),
    q3: await uploadSpec(baseUrl, "quote-api", "quote-api/3-price-lines.yaml"),
    q4: await uploadSpec(baseUrl, "quote-api", "quote-api/4-ncb-and-taxes.yaml"),
    p1: await uploadSpec(baseUrl, "policy-api", "policy-api/1-initial.yaml"),
    p2: await uploadSpec(baseUrl, "policy-api", "policy-api/2-deprecations.yaml"),
    p3: await uploadSpec(baseUrl, "policy-api", "policy-api/3-remove-old-fields.yaml"),
    p4: await uploadSpec(baseUrl, "policy-api", "policy-api/4-endorsement-rules.yaml"),
    c1: await uploadSpec(baseUrl, "claims-api", "claims-api/1-initial.yaml"),
    c3: await uploadSpec(baseUrl, "claims-api", "claims-api/3-channel-and-notes-fixed.yaml"),
    c4: await uploadSpec(baseUrl, "claims-api", "claims-api/4-approval-later.yaml"),
  };

  await importAllConsumers(baseUrl);

  return { ...context, versions };
}

function diff(baseUrl, service, from, to) {
  return call(baseUrl, "GET", `/api/v1/services/${service}/diff?from=${from.id}&to=${to.id}`);
}

function slugs(consumers) {
  return consumers.map((consumer) => consumer.slug);
}

test("acceptance: classification and consumer impact across the starter kit", async (t) => {
  const { baseUrl, versions } = await setupKit(t);

  await t.test("quote-api 1 -> 2 has no behavioural changes or impact", async () => {
    const { response, body } = await diff(baseUrl, "quote-api", versions.q1, versions.q2);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.changes, []);
    assert.equal(body.impact.blocked, false);
    assert.equal(body.impact.affectedConsumerCount, 0);
    assert.deepEqual(body.summary.bySeverity, {
      BREAKING: 0,
      POTENTIAL: 0,
      NON_BREAKING: 0,
      WARNING: 0,
      INTERNAL: 0,
    });
  });

  await t.test("quote-api 3 -> 4 is additive and non-breaking", async () => {
    const { response, body } = await diff(baseUrl, "quote-api", versions.q3, versions.q4);
    assert.equal(response.status, 200, JSON.stringify(body));

    assert.equal(body.changes.length, 3);
    assert.equal(body.summary.bySeverity.BREAKING, 0);
    assert.equal(body.summary.bySeverity.POTENTIAL, 0);
    assert.equal(body.summary.bySeverity.NON_BREAKING, 3);
    assert.ok(
      body.changes.some(
        (change) =>
          change.kind === "request_field_added" &&
          change.fieldPath === "rider.ncbPercent" &&
          change.after.required === false,
      ),
    );
    assert.ok(
      body.changes.some(
        (change) =>
          change.kind === "response_field_added" &&
          change.fieldPath === "premium.taxes",
      ),
    );

    assert.equal(body.impact.blocked, false);
    assert.equal(body.impact.affectedConsumerCount, 0);
  });

  await t.test("quote-api 2 -> 3 blocks mobile-app on the response field rename", async () => {
    const { response, body } = await diff(baseUrl, "quote-api", versions.q2, versions.q3);
    assert.equal(response.status, 200, JSON.stringify(body));

    assert.equal(body.changes.length, 7);
    assert.deepEqual(body.summary.bySeverity, {
      BREAKING: 2,
      POTENTIAL: 2,
      NON_BREAKING: 2,
      WARNING: 0,
      INTERNAL: 1,
    });

    const removed = body.changes.filter((change) => change.kind === "response_field_removed");
    assert.equal(removed.length, 2);
    assert.ok(removed.every((change) => change.severity === "BREAKING"));
    assert.ok(removed.every((change) => change.fieldPath === "premium.breakdown[].amount"));

    const postRemoved = removed.find((change) => change.method === "POST");
    const getRemoved = removed.find((change) => change.method === "GET");
    assert.deepEqual(slugs(postRemoved.affectedConsumers), ["mobile-app"]);
    assert.equal(postRemoved.blocksPublish, true);
    assert.match(postRemoved.reason, /mobile-app/);
    assert.deepEqual(getRemoved.affectedConsumers, []);
    assert.equal(getRemoved.blocksPublish, false);

    const internal = body.changes.find((change) => change.severity === "INTERNAL");
    assert.equal(internal.kind, "parameter_added");
    assert.equal(internal.parameter.name, "region");
    assert.deepEqual(internal.affectedConsumers, []);
    assert.equal(internal.blocksPublish, false);

    assert.equal(body.impact.blocked, true);
    assert.equal(body.impact.blockingChangeCount, 1);
    assert.deepEqual(slugs(body.impact.affectedConsumers), ["mobile-app", "notifications-svc"]);

    const mobile = body.impact.affectedConsumers.find((consumer) => consumer.slug === "mobile-app");
    assert.equal(mobile.team, "Mobile");
    assert.ok(mobile.severities.includes("BREAKING"));
  });

  await t.test("policy-api 1 -> 2 is warnings only and does not block", async () => {
    const { response, body } = await diff(baseUrl, "policy-api", versions.p1, versions.p2);
    assert.equal(response.status, 200, JSON.stringify(body));

    assert.equal(body.summary.bySeverity.BREAKING, 0);
    assert.equal(body.summary.bySeverity.POTENTIAL, 0);
    assert.equal(body.summary.bySeverity.NON_BREAKING, 0);
    assert.ok(body.summary.bySeverity.WARNING >= 4);
    assert.ok(body.changes.every((change) => change.severity === "WARNING"));
    assert.ok(body.changes.some((change) => /deprecated/i.test(change.reason)));
    assert.ok(body.changes.some((change) => /2026-11-01/.test(change.reason)));

    assert.equal(body.impact.blocked, false);
    assert.deepEqual(slugs(body.impact.affectedConsumers), ["payments-svc"]);
  });

  await t.test("policy-api 2 -> 3 blocks payments-svc when legacyCode is removed", async () => {
    const { response, body } = await diff(baseUrl, "policy-api", versions.p2, versions.p3);
    assert.equal(response.status, 200, JSON.stringify(body));

    const removed = body.changes.filter((change) => change.kind === "response_field_removed");
    assert.equal(body.summary.bySeverity.BREAKING, removed.length);
    assert.ok(removed.some((change) => change.fieldPath === "legacyCode"));
    assert.ok(removed.some((change) => change.fieldPath === "holder.phone"));

    const legacy = removed.filter((change) => change.fieldPath === "legacyCode");
    assert.ok(legacy.every((change) => change.severity === "BREAKING"));
    assert.ok(
      legacy.some((change) => slugs(change.affectedConsumers).includes("payments-svc")),
    );

    const phone = removed.filter((change) => change.fieldPath === "holder.phone");
    assert.ok(phone.every((change) => change.affectedConsumers.length === 0));

    assert.equal(body.impact.blocked, true);
    assert.deepEqual(slugs(body.impact.affectedConsumers), ["payments-svc"]);
  });

  await t.test("policy-api 3 -> 4 blocks partner-portal on enum narrowing and required field", async () => {
    const { response, body } = await diff(baseUrl, "policy-api", versions.p3, versions.p4);
    assert.equal(response.status, 200, JSON.stringify(body));

    assert.deepEqual(body.summary.bySeverity, {
      BREAKING: 2,
      POTENTIAL: 0,
      NON_BREAKING: 0,
      WARNING: 0,
      INTERNAL: 0,
    });

    const enumChange = body.changes.find((change) => change.kind === "request_field_enum_changed");
    assert.equal(enumChange.fieldPath, "type");
    assert.equal(enumChange.severity, "BREAKING");
    assert.deepEqual(enumChange.affectedConsumers.map((consumer) => consumer.slug), [
      "partner-portal",
    ]);

    const added = body.changes.find((change) => change.kind === "request_field_added");
    assert.equal(added.fieldPath, "requestedBy");
    assert.equal(added.after.required, true);
    assert.equal(added.severity, "BREAKING");
    assert.deepEqual(added.affectedConsumers.map((consumer) => consumer.slug), [
      "partner-portal",
    ]);

    assert.equal(body.impact.blocked, true);
    assert.deepEqual(slugs(body.impact.affectedConsumers), ["partner-portal"]);
  });

  await t.test("claims-api 3 -> 4 is potentially breaking and does not block", async () => {
    const { response, body } = await diff(baseUrl, "claims-api", versions.c3, versions.c4);
    assert.equal(response.status, 200, JSON.stringify(body));

    assert.deepEqual(body.summary.bySeverity, {
      BREAKING: 0,
      POTENTIAL: 2,
      NON_BREAKING: 1,
      WARNING: 0,
      INTERNAL: 0,
    });

    const optionalField = body.changes.filter(
      (change) => change.kind === "response_field_required_changed",
    );
    assert.ok(optionalField.every((change) => change.fieldPath === "amountApproved"));
    assert.ok(optionalField.every((change) => change.severity === "POTENTIAL"));
    assert.ok(
      optionalField.some((change) => slugs(change.affectedConsumers).includes("mobile-app")),
    );

    const addedStatus = body.changes.find(
      (change) => change.kind === "response_status_added",
    );
    assert.equal(addedStatus.statusCode, "202");
    assert.equal(addedStatus.severity, "NON_BREAKING");

    assert.equal(body.impact.blocked, false);
    assert.deepEqual(slugs(body.impact.affectedConsumers), ["mobile-app"]);
  });

  await t.test("claims-api 1 -> 3 is additive and affects nobody", async () => {
    const { response, body } = await diff(baseUrl, "claims-api", versions.c1, versions.c3);
    assert.equal(response.status, 200, JSON.stringify(body));

    assert.equal(body.summary.bySeverity.BREAKING, 0);
    assert.equal(body.summary.bySeverity.POTENTIAL, 0);
    assert.ok(body.summary.bySeverity.NON_BREAKING >= 2);
    assert.equal(body.impact.blocked, false);
    assert.equal(body.impact.affectedConsumerCount, 0);
  });

  await t.test("spec impact defaults to the previous revision and accepts an explicit base", async () => {
    const defaulted = await call(baseUrl, "GET", `/api/v1/specs/${versions.q3.id}/impact`);
    assert.equal(defaulted.response.status, 200, JSON.stringify(defaulted.body));
    assert.equal(defaulted.body.from.id, versions.q2.id);
    assert.equal(defaulted.body.to.id, versions.q3.id);
    assert.equal(defaulted.body.impact.blocked, true);

    const explicit = await call(
      baseUrl,
      "GET",
      `/api/v1/specs/${versions.q4.id}/impact?base=${versions.q3.id}`,
    );
    assert.equal(explicit.response.status, 200, JSON.stringify(explicit.body));
    assert.equal(explicit.body.from.id, versions.q3.id);
    assert.equal(explicit.body.to.id, versions.q4.id);
    assert.equal(explicit.body.impact.blocked, false);

    const noBase = await call(baseUrl, "GET", `/api/v1/specs/${versions.q1.id}/impact`);
    assert.equal(noBase.response.status, 400);
    assert.equal(noBase.body.error.code, "NO_BASE_VERSION");

    const sameBase = await call(
      baseUrl,
      "GET",
      `/api/v1/specs/${versions.q3.id}/impact?base=${versions.q3.id}`,
    );
    assert.equal(sameBase.response.status, 400);
    assert.equal(sameBase.body.error.code, "SAME_SPEC_VERSION");
  });
});
