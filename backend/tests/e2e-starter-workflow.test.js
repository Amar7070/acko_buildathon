const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDatabase } = require("../src/db");
const { createApp } = require("../src/app");

const KIT_ROOT = path.resolve(__dirname, "../..");
const SPECS_ROOT = path.join(KIT_ROOT, "specs");
const CONSUMERS_ROOT = path.join(KIT_ROOT, "consumers");

const SERVICES = [
  { slug: "quote-api", name: "Quote API", ownerTeam: "Quotes" },
  { slug: "policy-api", name: "Policy API", ownerTeam: "Policy" },
  { slug: "claims-api", name: "Claims API", ownerTeam: "Claims" },
];

const SPEC_ORDER = {
  "quote-api": [
    "1-initial.yaml",
    "2-reorganised.yaml",
    "3-price-lines.yaml",
    "4-ncb-and-taxes.yaml",
  ],
  "policy-api": [
    "1-initial.yaml",
    "2-deprecations.yaml",
    "3-remove-old-fields.yaml",
    "4-endorsement-rules.yaml",
  ],
  "claims-api": [
    "1-initial.yaml",
    "2-channel-and-notes.yaml",
    "3-channel-and-notes-fixed.yaml",
    "4-approval-later.yaml",
  ],
};

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contract-guard-e2e-"));
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
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body };
}

function slugs(items = []) {
  return items.map((item) => item.slug).sort();
}

test("end-to-end: complete workflow with original starter specs and consumers", async (t) => {
  const { baseUrl, db } = await startTestServer(t);

  let q1, q2, q3, q4, p1, p2, p3, p4, c1, c3, c4;

  await t.test("health and service registration", async () => {
    const health = await call(baseUrl, "GET", "/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.status, "ok");

    for (const service of SERVICES) {
      const created = await call(baseUrl, "POST", "/api/v1/services", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(service),
      });
      assert.equal(created.response.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.service.slug, service.slug);
      assert.equal(created.body.service.ownerTeam, service.ownerTeam);
    }

    const listed = await call(baseUrl, "GET", "/api/v1/services");
    assert.equal(listed.response.status, 200);
    assert.deepEqual(slugs(listed.body.services), ["claims-api", "policy-api", "quote-api"]);
  });

  await t.test("imports all original spec files in publish order (claims-api 2 rejected)", async () => {
    const outcomes = {};

    for (const service of SERVICES) {
      for (const file of SPEC_ORDER[service.slug]) {
        const content = fs.readFileSync(path.join(SPECS_ROOT, service.slug, file), "utf8");
        const result = await call(baseUrl, "POST", `/api/v1/services/${service.slug}/specs`, {
          headers: { "Content-Type": "application/yaml" },
          body: content,
        });

        outcomes[`${service.slug}/${file}`] = result;

        if (service.slug === "claims-api" && file === "2-channel-and-notes.yaml") {
          assert.equal(result.response.status, 422, JSON.stringify(result.body));
          assert.equal(result.body.error.code, "INVALID_SPEC");
          assert.match(JSON.stringify(result.body.error.details), /ClaimDocumnt/);
        } else {
          assert.equal(
            result.response.status,
            201,
            `${service.slug}/${file}: ${JSON.stringify(result.body)}`,
          );
          assert.equal(result.body.version.status, "draft");
          assert.equal(result.body.version.sourceFormat, "yaml");
        }
      }
    }

    q1 = outcomes["quote-api/1-initial.yaml"].body.version;
    q2 = outcomes["quote-api/2-reorganised.yaml"].body.version;
    q3 = outcomes["quote-api/3-price-lines.yaml"].body.version;
    q4 = outcomes["quote-api/4-ncb-and-taxes.yaml"].body.version;
    p1 = outcomes["policy-api/1-initial.yaml"].body.version;
    p2 = outcomes["policy-api/2-deprecations.yaml"].body.version;
    p3 = outcomes["policy-api/3-remove-old-fields.yaml"].body.version;
    p4 = outcomes["policy-api/4-endorsement-rules.yaml"].body.version;
    c1 = outcomes["claims-api/1-initial.yaml"].body.version;
    c3 = outcomes["claims-api/3-channel-and-notes-fixed.yaml"].body.version;
    c4 = outcomes["claims-api/4-approval-later.yaml"].body.version;

    assert.deepEqual([q1, q2, q3, q4].map((v) => v.revision), [1, 2, 3, 4]);
    assert.deepEqual([p1, p2, p3, p4].map((v) => v.revision), [1, 2, 3, 4]);
    // Invalid #2 is not stored, so fixed #3 and #4 become revisions 2 and 3.
    assert.deepEqual([c1, c3, c4].map((v) => v.revision), [1, 2, 3]);
    assert.equal(c3.declaredVersion, "1.1.0");
    assert.equal(c4.declaredVersion, "2.0.0");

    const stored = db
      .prepare("SELECT status, COUNT(*) AS count FROM spec_versions GROUP BY status ORDER BY status")
      .all();
    assert.deepEqual(stored, [{ status: "draft", count: 11 }]);

    const perService = db
      .prepare(
        `SELECT s.slug, COUNT(v.id) AS versions
         FROM services s JOIN spec_versions v ON v.service_id = s.id
         GROUP BY s.id ORDER BY s.slug`,
      )
      .all();
    assert.deepEqual(perService, [
      { slug: "claims-api", versions: 3 },
      { slug: "policy-api", versions: 4 },
      { slug: "quote-api", versions: 4 },
    ]);
  });

  await t.test("imports all original consumer manifests from folder", async () => {
    const imported = await call(baseUrl, "POST", "/api/v1/consumers/import", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: "consumers" }),
    });

    assert.equal(imported.response.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.imported, 4);
    assert.equal(imported.body.created, 4);
    assert.deepEqual(slugs(imported.body.consumers), [
      "mobile-app",
      "notifications-svc",
      "partner-portal",
      "payments-svc",
    ]);

    const listed = await call(baseUrl, "GET", "/api/v1/consumers");
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.consumers.length, 4);

    const mobile = listed.body.consumers.find((consumer) => consumer.slug === "mobile-app");
    assert.ok(mobile);
    assert.equal(mobile.team, "Mobile");
    assert.equal(mobile.uses.length, 4);

    const totalUsages = db.prepare("SELECT COUNT(*) AS count FROM consumer_endpoints").get().count;
    assert.equal(totalUsages, 10);
  });

  await t.test("semantic diffs and consumer impact match the starter-kit expectations", async () => {
    const quote12 = await call(baseUrl, "GET", `/api/v1/services/quote-api/diff?from=${q1.id}&to=${q2.id}`);
    assert.equal(quote12.response.status, 200);
    assert.deepEqual(quote12.body.changes, []);
    assert.equal(quote12.body.impact.blocked, false);

    const quote23 = await call(baseUrl, "GET", `/api/v1/services/quote-api/diff?from=${q2.id}&to=${q3.id}`);
    assert.equal(quote23.response.status, 200);
    assert.equal(quote23.body.impact.blocked, true);
    assert.deepEqual(slugs(quote23.body.impact.affectedConsumers), [
      "mobile-app",
      "notifications-svc",
    ]);
    const mobileBreaking = quote23.body.changes.find(
      (change) =>
        change.fieldPath === "premium.breakdown[].amount" &&
        change.kind === "response_field_removed" &&
        slugs(change.affectedConsumers).includes("mobile-app"),
    );
    assert.ok(mobileBreaking, "mobile-app must be affected by premium.breakdown[].amount removal");
    assert.equal(mobileBreaking.blocksPublish, true);
    const internalRegion = quote23.body.changes.find(
      (change) => change.severity === "INTERNAL" && change.parameter && change.parameter.name === "region",
    );
    assert.ok(internalRegion);
    assert.deepEqual(internalRegion.affectedConsumers, []);

    const quote34 = await call(baseUrl, "GET", `/api/v1/services/quote-api/diff?from=${q3.id}&to=${q4.id}`);
    assert.equal(quote34.response.status, 200);
    assert.equal(quote34.body.impact.blocked, false);
    assert.equal(quote34.body.impact.affectedConsumerCount, 0);
    assert.equal(quote34.body.summary.bySeverity.BREAKING, 0);

    const policy23 = await call(baseUrl, "GET", `/api/v1/services/policy-api/diff?from=${p2.id}&to=${p3.id}`);
    assert.equal(policy23.response.status, 200);
    assert.equal(policy23.body.impact.blocked, true);
    assert.deepEqual(slugs(policy23.body.impact.affectedConsumers), ["payments-svc"]);
    const legacy = policy23.body.changes.find((change) => change.fieldPath === "legacyCode");
    assert.ok(legacy);
    assert.deepEqual(slugs(legacy.affectedConsumers), ["payments-svc"]);

    const policy34 = await call(baseUrl, "GET", `/api/v1/services/policy-api/diff?from=${p3.id}&to=${p4.id}`);
    assert.equal(policy34.response.status, 200);
    assert.equal(policy34.body.impact.blocked, true);
    assert.deepEqual(slugs(policy34.body.impact.affectedConsumers), ["partner-portal"]);

    const claims13 = await call(baseUrl, "GET", `/api/v1/services/claims-api/diff?from=${c1.id}&to=${c3.id}`);
    assert.equal(claims13.response.status, 200);
    assert.equal(claims13.body.impact.blocked, false);
    assert.equal(claims13.body.impact.affectedConsumerCount, 0);

    const claims34 = await call(baseUrl, "GET", `/api/v1/services/claims-api/diff?from=${c3.id}&to=${c4.id}`);
    assert.equal(claims34.response.status, 200);
    assert.equal(claims34.body.impact.blocked, false);
    assert.ok(claims34.body.summary.bySeverity.POTENTIAL >= 1);
  });

  await t.test("publishing: safe versions publish, unsafe versions are blocked and stay draft", async () => {
    const publish = (id) =>
      call(baseUrl, "POST", `/api/v1/specs/${id}/publish`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "e2e" }),
      });

    const pubQ1 = await publish(q1.id);
    assert.equal(pubQ1.response.status, 201, JSON.stringify(pubQ1.body));
    assert.equal(pubQ1.body.outcome, "published");
    assert.equal(pubQ1.body.spec.status, "published");

    const pubQ2 = await publish(q2.id);
    assert.equal(pubQ2.response.status, 201, JSON.stringify(pubQ2.body));
    assert.equal(pubQ2.body.outcome, "published");

    const pubQ3 = await publish(q3.id);
    assert.equal(pubQ3.response.status, 409, JSON.stringify(pubQ3.body));
    assert.equal(pubQ3.body.outcome, "blocked");
    assert.equal(pubQ3.body.spec.status, "draft");
    assert.equal(pubQ3.body.spec.publishedAt, null);
    assert.equal(pubQ3.body.impact.blocked, true);
    assert.deepEqual(slugs(pubQ3.body.impact.affectedConsumers), [
      "mobile-app",
      "notifications-svc",
    ]);

    const q3StillDraft = await call(baseUrl, "GET", `/api/v1/specs/${q3.id}`);
    assert.equal(q3StillDraft.body.version.status, "draft");

    // q4 is still unsafe relative to published q2 (removes premium.breakdown[].amount).
    const pubQ4 = await publish(q4.id);
    assert.equal(pubQ4.response.status, 409, JSON.stringify(pubQ4.body));
    assert.equal(pubQ4.body.outcome, "blocked");
    assert.equal(pubQ4.body.spec.status, "draft");

    const pubP1 = await publish(p1.id);
    assert.equal(pubP1.response.status, 201, JSON.stringify(pubP1.body));
    const pubP2 = await publish(p2.id);
    assert.equal(pubP2.response.status, 201, JSON.stringify(pubP2.body));

    const pubP3 = await publish(p3.id);
    assert.equal(pubP3.response.status, 409, JSON.stringify(pubP3.body));
    assert.deepEqual(slugs(pubP3.body.impact.affectedConsumers), ["payments-svc"]);
    assert.equal(pubP3.body.spec.status, "draft");

    // Compared against latest published baseline (p2), p4 includes p3 removals
    // (legacyCode -> payments-svc, holder.phone) and p4 endorsement-rule changes
    // (enum narrowing + required requestedBy -> partner-portal), so it is blocked.
    const pubP4 = await publish(p4.id);
    assert.equal(pubP4.response.status, 409, JSON.stringify(pubP4.body));
    assert.equal(pubP4.body.outcome, "blocked");
    assert.equal(pubP4.body.spec.status, "draft");
    assert.equal(pubP4.body.from.id, p2.id);
    assert.deepEqual(slugs(pubP4.body.impact.affectedConsumers), [
      "partner-portal",
      "payments-svc",
    ]);

    const pubC1 = await publish(c1.id);
    assert.equal(pubC1.response.status, 201, JSON.stringify(pubC1.body));
    const pubC3 = await publish(c3.id);
    assert.equal(pubC3.response.status, 201, JSON.stringify(pubC3.body));
    const pubC4 = await publish(c4.id);
    assert.equal(pubC4.response.status, 201, JSON.stringify(pubC4.body));
  });

  await t.test("changelogs, publish attempts, and metrics are exposed", async () => {
    const changelog = await call(
      baseUrl,
      "GET",
      `/api/v1/services/quote-api/changelog?from=${q2.id}&to=${q3.id}`,
    );
    assert.equal(changelog.response.status, 200, JSON.stringify(changelog.body));
    assert.ok(changelog.body.markdown.includes("Changelog"));
    assert.ok(changelog.body.markdown.includes("mobile-app"));
    assert.ok(Array.isArray(changelog.body.entries) && changelog.body.entries.length > 0);
    assert.ok(!changelog.body.entries.some((entry) => entry.severity === "INTERNAL"));
    assert.ok(
      changelog.body.entries.some((entry) => (entry.affectedConsumers || []).includes("mobile-app")),
    );

    const attempts = await call(baseUrl, "GET", "/api/v1/services/quote-api/attempts");
    assert.equal(attempts.response.status, 200);
    assert.equal(attempts.body.attempts.length, 4);
    assert.deepEqual(
      attempts.body.attempts.map((attempt) => attempt.outcome).sort(),
      ["blocked", "blocked", "published", "published"],
    );

    const metrics = await call(baseUrl, "GET", "/api/v1/metrics");
    assert.equal(metrics.response.status, 200, JSON.stringify(metrics.body));
    const m = metrics.body.metrics;

    // 12 original files attempted: 11 stored drafts total, 1 invalid rejected at upload (not stored).
    assert.equal(m.servicesRegistered, 3);
    assert.equal(m.specsUploaded, 11);
    assert.equal(m.specsDraft, 4); // q3, q4, p3, p4 remain blocked drafts
    assert.equal(m.specsPublished, 7);
    assert.equal(m.specsRejected, 0);
    assert.equal(m.consumersRegistered, 4);
    assert.equal(m.usagesRegistered, 10);

    // q1,q2,p1,p2,c1,c3,c4 published; q3,q4,p3,p4 blocked.
    assert.equal(m.publishAttempts, 11);
    assert.equal(m.publishedPublishes, 7);
    assert.equal(m.blockedPublishes, 4);
    assert.equal(m.publishSuccessRatio, 0.6364);

    assert.ok(m.breakingChanges >= 1);
    assert.ok(m.dangerousChangesCaught >= 1);
    assert.ok(m.affectedConsumers >= 1);
    assert.ok(m.proposedVersionsWithConsumerImpact >= 1);
    assert.ok(Array.isArray(m.breakingChangesByService));
    assert.ok(m.breakingChangesByService.some((entry) => entry.slug === "quote-api"));
    assert.ok(m.breakingChangesByService.some((entry) => entry.slug === "policy-api"));
  });
});
