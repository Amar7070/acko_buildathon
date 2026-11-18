const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDatabase } = require("../src/db");
const { createApp } = require("../src/app");

const KIT_ROOT = path.resolve(__dirname, "../..");

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contract-guard-publish-"));
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
  return result.body.service;
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

async function uploadContent(baseUrl, service, content) {
  const result = await call(baseUrl, "POST", `/api/v1/services/${service}/specs`, {
    headers: { "Content-Type": "application/yaml" },
    body: content,
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.version;
}

async function registerConsumer(baseUrl, consumer) {
  const result = await call(baseUrl, "POST", "/api/v1/consumers", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(consumer),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.consumer;
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

async function publish(baseUrl, specId, payload = {}) {
  return call(baseUrl, "POST", `/api/v1/specs/${specId}/publish`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function consumerSlugs(affectedConsumers = []) {
  return affectedConsumers.map((consumer) => consumer.slug).sort();
}

test("publish gate blocks unsafe versions, allows safe ones, and records every attempt", async (t) => {
  const { baseUrl, db } = await startTestServer(t);

  await registerService(baseUrl, "quote-api", "Quote API", "Quotes");
  await registerService(baseUrl, "policy-api", "Policy API", "Policy");
  await registerService(baseUrl, "claims-api", "Claims API", "Claims");

  const q1 = await uploadSpec(baseUrl, "quote-api", "quote-api/1-initial.yaml");
  const q2 = await uploadSpec(baseUrl, "quote-api", "quote-api/2-reorganised.yaml");
  const q3 = await uploadSpec(baseUrl, "quote-api", "quote-api/3-price-lines.yaml");
  const q4 = await uploadSpec(baseUrl, "quote-api", "quote-api/4-ncb-and-taxes.yaml");
  const p1 = await uploadSpec(baseUrl, "policy-api", "policy-api/1-initial.yaml");
  const p2 = await uploadSpec(baseUrl, "policy-api", "policy-api/2-deprecations.yaml");
  const p3 = await uploadSpec(baseUrl, "policy-api", "policy-api/3-remove-old-fields.yaml");
  const c1 = await uploadSpec(baseUrl, "claims-api", "claims-api/1-initial.yaml");
  const c3 = await uploadSpec(baseUrl, "claims-api", "claims-api/3-channel-and-notes-fixed.yaml");

  await importAllConsumers(baseUrl);

  await t.test("publishes a baseline draft when there is no prior version", async () => {
    const result = await publish(baseUrl, q1.id, { actor: "ci", note: "baseline" });
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.outcome, "published");
    assert.equal(result.body.blocked, false);
    assert.equal(result.body.published, true);
    assert.equal(result.body.spec.status, "published");
    assert.ok(result.body.spec.publishedAt);
    assert.equal(result.body.from, null);
    assert.equal(result.body.to.id, q1.id);
    assert.equal(result.body.summary.total, 0);
    assert.equal(result.body.impact.blocked, false);
    assert.equal(result.body.attempt.outcome, "published");
    assert.equal(result.body.attempt.actor, "ci");
    assert.equal(result.body.attempt.note, "baseline");
    assert.equal(result.body.attempt.baseSpecId, null);

    const spec = await call(baseUrl, "GET", `/api/v1/specs/${q1.id}`);
    assert.equal(spec.body.version.status, "published");
  });

  await t.test("publishes a safe version with no breaking consumer impact", async () => {
    const result = await publish(baseUrl, q2.id, { actor: "quotes-bot" });
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.outcome, "published");
    assert.equal(result.body.spec.status, "published");
    assert.equal(result.body.from.id, q1.id);
    assert.equal(result.body.to.id, q2.id);
    assert.deepEqual(result.body.changes, []);
    assert.equal(result.body.impact.blocked, false);
    assert.equal(result.body.impact.affectedConsumerCount, 0);
  });

  await t.test("blocks a breaking change that affects a registered consumer and keeps the draft", async () => {
    const result = await publish(baseUrl, q3.id, { actor: "quotes-bot", note: "price lines" });
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.outcome, "blocked");
    assert.equal(result.body.blocked, true);
    assert.equal(result.body.published, false);
    assert.equal(result.body.spec.status, "draft");
    assert.equal(result.body.spec.publishedAt, null);
    assert.equal(result.body.from.id, q2.id);
    assert.equal(result.body.to.id, q3.id);
    assert.equal(result.body.summary.bySeverity.BREAKING, 2);
    assert.equal(result.body.summary.bySeverity.INTERNAL, 1);
    assert.equal(result.body.impact.blocked, true);
    assert.equal(result.body.impact.blockingChangeCount, 1);
    assert.deepEqual(consumerSlugs(result.body.impact.affectedConsumers), [
      "mobile-app",
      "notifications-svc",
    ]);
    assert.ok(result.body.changes.some((change) => change.blocksPublish === true));
    assert.ok(
      result.body.changes.some(
        (change) =>
          change.fieldPath === "premium.breakdown[].amount" &&
          consumerSlugs(change.affectedConsumers).includes("mobile-app"),
      ),
    );
    assert.equal(result.body.attempt.outcome, "blocked");
    assert.equal(result.body.attempt.breakingCount, 2);
    assert.equal(result.body.attempt.affectedConsumerCount, 2);
    assert.equal(result.body.attempt.candidateSpecId, q3.id);
    assert.equal(result.body.attempt.baseSpecId, q2.id);
    assert.ok(result.body.attempt.changes.length >= 7);

    const spec = await call(baseUrl, "GET", `/api/v1/specs/${q3.id}`);
    assert.equal(spec.body.version.status, "draft");

    const attempts = await call(baseUrl, "GET", "/api/v1/services/quote-api/attempts");
    assert.equal(attempts.response.status, 200);
    assert.deepEqual(
      attempts.body.attempts.map((attempt) => attempt.outcome),
      ["blocked", "published", "published"],
    );
    assert.equal(attempts.body.attempts[0].candidate.id, q3.id);
  });

  await t.test("re-attempting a blocked draft records another attempt against the published baseline", async () => {
    // quote-api 4 still removes premium.breakdown[].amount relative to published q2,
    // so the gate must block it and keep it draft.
    const result = await publish(baseUrl, q4.id, { actor: "quotes-bot", note: "retry-safe-looking" });
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.outcome, "blocked");
    assert.equal(result.body.spec.status, "draft");
    assert.equal(result.body.from.id, q2.id);
    assert.equal(result.body.to.id, q4.id);
    assert.equal(result.body.impact.blocked, true);
    assert.deepEqual(consumerSlugs(result.body.impact.affectedConsumers), [
      "mobile-app",
      "notifications-svc",
    ]);

    const attempts = await call(baseUrl, "GET", "/api/v1/services/quote-api/attempts");
    assert.equal(attempts.response.status, 200);
    assert.equal(attempts.body.attempts.length, 4);
    assert.equal(attempts.body.attempts[0].outcome, "blocked");
    assert.equal(attempts.body.attempts[0].candidate.id, q4.id);
    assert.equal(attempts.body.attempts[0].note, "retry-safe-looking");
  });

  await t.test("publishes a safe version after a blocked attempt on the same service", async () => {
    await registerService(baseUrl, "gadget-api", "Gadget API", "Gadgets");
    await registerConsumer(baseUrl, {
      consumer: "gadget-app",
      team: "Mobile",
      uses: [
        {
          provider: "gadget-api",
          method: "GET",
          path: "/gadgets/{id}",
          sends: [],
          reads: ["name"],
        },
      ],
    });

    const v1 = await uploadContent(
      baseUrl,
      "gadget-api",
      `openapi: 3.0.3
info:
  title: Gadget API
  version: 1.0.0
paths:
  /gadgets/{id}:
    get:
      operationId: getGadget
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [id, name]
                properties:
                  id: { type: string }
                  name: { type: string }
`,
    );
    const v2 = await uploadContent(
      baseUrl,
      "gadget-api",
      `openapi: 3.0.3
info:
  title: Gadget API
  version: 1.1.0
paths:
  /gadgets/{id}:
    get:
      operationId: getGadget
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [id]
                properties:
                  id: { type: string }
`,
    );
    const v3 = await uploadContent(
      baseUrl,
      "gadget-api",
      `openapi: 3.0.3
info:
  title: Gadget API
  version: 1.2.0
paths:
  /gadgets/{id}:
    get:
      operationId: getGadget
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [id, name]
                properties:
                  id: { type: string }
                  name: { type: string }
                  color: { type: string }
`,
    );

    const baseline = await publish(baseUrl, v1.id);
    assert.equal(baseline.response.status, 201, JSON.stringify(baseline.body));

    const blocked = await publish(baseUrl, v2.id);
    assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.outcome, "blocked");
    assert.equal(blocked.body.spec.status, "draft");
    assert.deepEqual(consumerSlugs(blocked.body.impact.affectedConsumers), ["gadget-app"]);
    assert.equal(blocked.body.from.id, v1.id);

    // Safe relative to the latest published baseline (v1), even though a newer
    // draft (v2) was blocked earlier.
    const safe = await publish(baseUrl, v3.id);
    assert.equal(safe.response.status, 201, JSON.stringify(safe.body));
    assert.equal(safe.body.outcome, "published");
    assert.equal(safe.body.from.id, v1.id);
    assert.equal(safe.body.to.id, v3.id);
    assert.equal(safe.body.spec.status, "published");
    assert.equal(safe.body.impact.blocked, false);

    const attempts = await call(baseUrl, "GET", "/api/v1/services/gadget-api/attempts");
    assert.deepEqual(
      attempts.body.attempts.map((attempt) => ({ outcome: attempt.outcome, candidate: attempt.candidate.id })),
      [
        { outcome: "published", candidate: v3.id },
        { outcome: "blocked", candidate: v2.id },
        { outcome: "published", candidate: v1.id },
      ],
    );
  });

  await t.test("generates changelogs between API versions", async () => {
    const quote = await call(
      baseUrl,
      "GET",
      `/api/v1/services/quote-api/changelog?from=${q2.id}&to=${q3.id}`,
    );
    assert.equal(quote.response.status, 200, JSON.stringify(quote.body));
    assert.equal(quote.body.from.id, q2.id);
    assert.equal(quote.body.to.id, q3.id);
    assert.ok(quote.body.changelog.length >= 5);
    assert.equal(quote.body.publicSummary.bySeverity.INTERNAL, 0);
    assert.equal(quote.body.publicSummary.bySeverity.BREAKING, 2);
    assert.equal(quote.body.publicSummary.bySeverity.POTENTIAL, 2);
    assert.ok(!quote.body.entries.some((entry) => entry.severity === "INTERNAL"));
    assert.ok(quote.body.entries.some((entry) => entry.affectedConsumers.includes("mobile-app")));
    assert.match(quote.body.markdown, /^# Changelog: Quote API/m);
    assert.match(quote.body.markdown, /## Breaking \(2\)/);
    assert.match(quote.body.markdown, /mobile-app/);
    assert.doesNotMatch(quote.body.markdown, /Internal only/);

    const noChange = await call(
      baseUrl,
      "GET",
      `/api/v1/services/quote-api/changelog?from=${q1.id}&to=${q2.id}`,
    );
    assert.equal(noChange.response.status, 200, JSON.stringify(noChange.body));
    assert.deepEqual(noChange.body.entries, []);
    assert.equal(noChange.body.text, "No public behavioural changes.");
    assert.match(noChange.body.markdown, /No public behavioural changes/);

    const latest = await call(baseUrl, "GET", "/api/v1/services/claims-api/changelog");
    assert.equal(latest.response.status, 200, JSON.stringify(latest.body));
    assert.equal(latest.body.from.id, c1.id);
    assert.equal(latest.body.to.id, c3.id);
  });

  await t.test("records blocked and safe publishes for other starter services", async () => {
    const pub1 = await publish(baseUrl, p1.id);
    assert.equal(pub1.response.status, 201, JSON.stringify(pub1.body));
    const pub2 = await publish(baseUrl, p2.id);
    assert.equal(pub2.response.status, 201, JSON.stringify(pub2.body));

    const blocked = await publish(baseUrl, p3.id, { actor: "policy-bot" });
    assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.spec.status, "draft");
    assert.deepEqual(consumerSlugs(blocked.body.impact.affectedConsumers), ["payments-svc"]);
    assert.equal(blocked.body.attempt.outcome, "blocked");

    const claims1 = await publish(baseUrl, c1.id);
    assert.equal(claims1.response.status, 201, JSON.stringify(claims1.body));
    const claims3 = await publish(baseUrl, c3.id);
    assert.equal(claims3.response.status, 201, JSON.stringify(claims3.body));
    assert.equal(claims3.body.impact.blocked, false);
  });

  await t.test("exposes protection metrics for uploaded specs, breaking changes, blocked publishes, and affected consumers", async () => {
    const metricsResult = await call(baseUrl, "GET", "/api/v1/metrics");
    assert.equal(metricsResult.response.status, 200, JSON.stringify(metricsResult.body));
    const { metrics } = metricsResult.body;

    // quote-api (4), policy-api (3), claims-api (2), gadget-api (3)
    assert.equal(metrics.servicesRegistered, 4);
    assert.equal(metrics.specsUploaded, 12);
    assert.equal(metrics.specsPublished, 8);
    assert.equal(metrics.specsDraft, 4);
    assert.equal(metrics.specsRejected, 0);
    assert.equal(metrics.validationFailureRate, 0);

    // Attempts: quote 4 (2 published, 2 blocked), gadget 3 (2 published, 1 blocked),
    // policy 3 (2 published, 1 blocked), claims 2 (2 published).
    assert.equal(metrics.publishAttempts, 12);
    assert.equal(metrics.publishedPublishes, 8);
    assert.equal(metrics.blockedPublishes, 4);
    assert.equal(metrics.publishSuccessRatio, 0.6667);

    // Breaking changes recorded on attempts: quote q3(2)+q4(2), gadget v2(1), policy p3(4) = 9.
    assert.equal(metrics.breakingChanges, 9);
    assert.equal(metrics.dangerousChangesCaught, 9);

    // Affected consumer counts summed per attempt:
    // blocked: quote q3(2)+q4(2), gadget v2(1), policy p3(1) = 6.
    // published with impact (warnings only): policy p2 affects payments-svc = +1.
    assert.equal(metrics.affectedConsumers, 7);
    assert.equal(metrics.affectedConsumersOnBlocked, 6);
    assert.equal(metrics.proposedVersionsWithConsumerImpact, 5);

    assert.equal(metrics.consumersRegistered, 5);
    assert.equal(metrics.usagesRegistered, 11);

    const byService = Object.fromEntries(
      metrics.breakingChangesByService.map((entry) => [entry.slug, entry.breakingCount]),
    );
    assert.equal(byService["policy-api"], 4);
    assert.equal(byService["quote-api"], 4);
    assert.equal(byService["gadget-api"], 1);

    const rows = db
      .prepare(
        "SELECT outcome, COUNT(*) AS count FROM publish_attempts GROUP BY outcome ORDER BY outcome",
      )
      .all();
    assert.deepEqual(rows, [
      { outcome: "blocked", count: 4 },
      { outcome: "published", count: 8 },
    ]);
  });

  await t.test("rejects invalid publish attempts cleanly", async () => {
    const alreadyPublished = await publish(baseUrl, c3.id);
    assert.equal(alreadyPublished.response.status, 409, JSON.stringify(alreadyPublished.body));
    assert.equal(alreadyPublished.body.error.code, "SPEC_ALREADY_PUBLISHED");

    const blockedAgain = await publish(baseUrl, q3.id);
    assert.equal(blockedAgain.response.status, 409, JSON.stringify(blockedAgain.body));
    assert.equal(blockedAgain.body.outcome, "blocked");
    assert.equal(blockedAgain.body.spec.status, "draft");

    const missing = await publish(baseUrl, 999999);
    assert.equal(missing.response.status, 404, JSON.stringify(missing.body));
    assert.equal(missing.body.error.code, "SPEC_NOT_FOUND");
  });
});
