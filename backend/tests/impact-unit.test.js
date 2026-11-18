const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyChange } = require("../src/domain/classify");
const {
  pathsOverlap,
  findAffectedConsumers,
  attachImpact,
  summarizeImpact,
} = require("../src/domain/impact");

const usages = [
  {
    consumerId: 1,
    consumerSlug: "mobile-app",
    consumerName: "Mobile App",
    team: "Mobile",
    method: "POST",
    pathTemplate: "/quotes",
    sends: ["vehicle.make", "rider.age", "id"],
    reads: ["quoteId", "status", "premium.total", "premium.breakdown[].amount"],
  },
  {
    consumerId: 2,
    consumerSlug: "partner-portal",
    consumerName: "Partner Portal",
    team: "Partner Integrations",
    method: "POST",
    pathTemplate: "/quotes",
    sends: ["vehicle.model", "rider.city"],
    reads: ["quoteId", "premium.total"],
  },
  {
    consumerId: 3,
    consumerSlug: "policy-viewer",
    consumerName: "Policy Viewer",
    team: "Policy",
    method: "GET",
    pathTemplate: "/policies/{}",
    sends: ["policyId"],
    reads: ["policyId", "status"],
  },
  {
    consumerId: 4,
    consumerSlug: "search-ui",
    consumerName: "Search UI",
    team: "Search",
    method: "GET",
    pathTemplate: "/policies",
    sends: ["holder"],
    reads: ["policyId"],
  },
];

function change(kind, overrides = {}) {
  return classifyChange({
    kind,
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
  });
}

function slugs(consumers) {
  return consumers.map((consumer) => consumer.slug);
}

test("consumer field paths match exact, ancestor and descendant paths", () => {
  assert.equal(pathsOverlap("premium", "premium.breakdown[].amount"), true);
  assert.equal(pathsOverlap("premium.breakdown", "premium.breakdown[].amount"), true);
  assert.equal(pathsOverlap("premium.breakdown[].amount", "premium"), true);
  assert.equal(pathsOverlap("premium.total", "premium.breakdown[].amount"), false);
  assert.equal(pathsOverlap("holder.email", "holder.phone"), false);
  assert.equal(pathsOverlap("status", "status"), true);
});

test("a removed response field affects only consumers that read it", () => {
  const affected = findAffectedConsumers(
    change("response_field_removed", { fieldPath: "premium.breakdown[].amount" }),
    usages,
  );

  assert.deepEqual(slugs(affected), ["mobile-app"]);
  assert.equal(affected[0].via, "reads");
  assert.deepEqual(affected[0].matchedFields, ["premium.breakdown[].amount"]);
});

test("a removed ancestor response field affects readers of nested fields", () => {
  const affected = findAffectedConsumers(
    change("response_field_removed", { fieldPath: "premium" }),
    usages,
  );

  assert.deepEqual(slugs(affected), ["mobile-app", "partner-portal"]);
  assert.ok(affected.every((consumer) => consumer.via === "reads"));
});

test("a newly required request field or parameter affects every caller of the operation", () => {
  const fieldAffected = findAffectedConsumers(
    change("request_field_added", {
      location: "request",
      direction: "request",
      fieldPath: "rider.ncbPercent",
      after: { required: true, type: "integer" },
    }),
    usages,
  );
  assert.deepEqual(slugs(fieldAffected), ["mobile-app", "partner-portal"]);
  assert.ok(fieldAffected.every((consumer) => consumer.via === "operation"));

  const parameterAffected = findAffectedConsumers(
    change("parameter_added", {
      location: "parameter",
      direction: "parameter",
      parameter: { name: "region", in: "query", required: true, schema: {} },
      after: { required: true },
    }),
    usages,
  );
  assert.deepEqual(slugs(parameterAffected), ["mobile-app", "partner-portal"]);
});

test("parameter changes match senders by name, and path parameters affect all callers", () => {
  const queryRemoved = findAffectedConsumers(
    change("parameter_removed", {
      method: "GET",
      path: "/policies",
      location: "parameter",
      direction: "parameter",
      parameter: { name: "holder", in: "query", required: false, schema: {} },
    }),
    usages,
  );
  assert.deepEqual(slugs(queryRemoved), ["search-ui"]);
  assert.equal(queryRemoved[0].via, "sends");

  const pathTypeChanged = findAffectedConsumers(
    change("parameter_type_changed", {
      method: "GET",
      path: "/policies/{}",
      location: "parameter",
      direction: "parameter",
      parameter: { name: "policyId", in: "path", required: true, schema: {} },
      before: "string",
      after: "integer",
    }),
    usages,
  );
  assert.deepEqual(slugs(pathTypeChanged), ["policy-viewer"]);
  assert.equal(pathTypeChanged[0].via, "operation");
});

test("removed endpoints and status codes affect every consumer of the operation", () => {
  const endpoint = findAffectedConsumers(
    change("endpoint_removed", { location: "endpoint", direction: "endpoint" }),
    usages,
  );
  assert.deepEqual(slugs(endpoint), ["mobile-app", "partner-portal"]);

  const status = findAffectedConsumers(
    change("response_status_removed", {
      location: "response",
      direction: "response",
      statusCode: "404",
    }),
    usages,
  );
  assert.deepEqual(slugs(status), ["mobile-app", "partner-portal"]);
});

test("additive response fields and internal operations do not affect consumers", () => {
  assert.deepEqual(
    findAffectedConsumers(
      change("response_field_added", { fieldPath: "premium.taxes", after: { required: false } }),
      usages,
    ),
    [],
  );

  assert.deepEqual(
    findAffectedConsumers(
      change("response_field_removed", { fieldPath: "premium.total", isInternal: true }),
      usages,
    ),
    [],
  );
});

test("attachImpact marks blocking changes and appends affected consumers to the reason", () => {
  const [breaking, nonBreaking] = attachImpact(
    [
      change("response_field_removed", { fieldPath: "premium.breakdown[].amount" }),
      change("response_field_added", { fieldPath: "premium.taxes", after: { required: false } }),
    ],
    usages,
  );

  assert.equal(breaking.blocksPublish, true);
  assert.match(breaking.reason, /mobile-app/);

  assert.equal(nonBreaking.blocksPublish, false);
  assert.deepEqual(nonBreaking.affectedConsumers, []);
});

test("summarizeImpact aggregates consumers, severities and blocking state", () => {
  const changes = attachImpact(
    [
      change("response_field_removed", { fieldPath: "premium.breakdown[].amount" }),
      change("response_field_removed", { fieldPath: "premium" }),
      change("response_status_removed", {
        location: "response",
        direction: "response",
        statusCode: "400",
      }),
    ],
    usages,
  );
  const impact = summarizeImpact(changes);

  assert.equal(impact.blocked, true);
  assert.equal(impact.blockingChangeCount, 3);
  assert.equal(impact.affectedConsumerCount, 2);
  assert.deepEqual(
    impact.affectedConsumers.map((consumer) => consumer.slug),
    ["mobile-app", "partner-portal"],
  );
  assert.deepEqual(impact.bySeverity, {
    BREAKING: 3,
    POTENTIAL: 0,
    NON_BREAKING: 0,
    WARNING: 0,
    INTERNAL: 0,
  });
});
