const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyChange, classifyChanges, summarizeSeverity, SEVERITY } = require("../src/domain/classify");

function change(kind, overrides = {}) {
  return {
    kind,
    method: "POST",
    path: "/things",
    location: "request",
    direction: "request",
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

function field(direction, suffix, overrides = {}) {
  return change(`${direction}_field_${suffix}`, {
    location: direction,
    direction,
    fieldPath: "thing.value",
    ...overrides,
  });
}

test("classifies endpoint changes", () => {
  const removed = classifyChange(
    change("endpoint_removed", { location: "endpoint", direction: "endpoint" }),
  );
  assert.equal(removed.severity, SEVERITY.BREAKING);
  assert.match(removed.reason, /removed/i);

  const added = classifyChange(
    change("endpoint_added", { location: "endpoint", direction: "endpoint" }),
  );
  assert.equal(added.severity, SEVERITY.NON_BREAKING);
});

test("classifies parameter changes by direction and required flag", () => {
  const parameter = { name: "filter", in: "query", required: true, schema: {} };

  assert.equal(
    classifyChange(change("parameter_added", { location: "parameter", direction: "parameter", parameter })).severity,
    SEVERITY.BREAKING,
  );
  assert.equal(
    classifyChange(
      change("parameter_added", {
        location: "parameter",
        direction: "parameter",
        parameter: { ...parameter, required: false },
      }),
    ).severity,
    SEVERITY.NON_BREAKING,
  );
  assert.equal(
    classifyChange(change("parameter_removed", { location: "parameter", direction: "parameter", parameter })).severity,
    SEVERITY.POTENTIAL,
  );
  assert.equal(
    classifyChange(
      change("parameter_required_changed", {
        location: "parameter",
        direction: "parameter",
        parameter,
        before: false,
        after: true,
      }),
    ).severity,
    SEVERITY.BREAKING,
  );
  assert.equal(
    classifyChange(
      change("parameter_type_changed", {
        location: "parameter",
        direction: "parameter",
        parameter,
        before: "string",
        after: "integer",
      }),
    ).severity,
    SEVERITY.BREAKING,
  );
  assert.equal(
    classifyChange(
      change("parameter_enum_changed", {
        location: "parameter",
        direction: "parameter",
        parameter,
        before: ["a", "b"],
        after: ["a"],
      }),
    ).severity,
    SEVERITY.BREAKING,
  );
  assert.equal(
    classifyChange(
      change("parameter_enum_changed", {
        location: "parameter",
        direction: "parameter",
        parameter,
        before: ["a"],
        after: ["a", "b"],
      }),
    ).severity,
    SEVERITY.NON_BREAKING,
  );
});

test("classifies request fields", () => {
  assert.equal(
    classifyChange(field("request", "added", { after: { required: true } })).severity,
    SEVERITY.BREAKING,
  );
  assert.equal(
    classifyChange(field("request", "added", { after: { required: false } })).severity,
    SEVERITY.NON_BREAKING,
  );
  assert.equal(classifyChange(field("request", "removed")).severity, SEVERITY.POTENTIAL);
  assert.equal(
    classifyChange(field("request", "required_changed", { before: false, after: true })).severity,
    SEVERITY.BREAKING,
  );
  assert.equal(
    classifyChange(field("request", "required_changed", { before: true, after: false })).severity,
    SEVERITY.NON_BREAKING,
  );
  assert.equal(
    classifyChange(field("request", "type_changed", { before: "string", after: "integer" })).severity,
    SEVERITY.BREAKING,
  );
  assert.equal(
    classifyChange(field("request", "nullable_changed", { before: true, after: false })).severity,
    SEVERITY.BREAKING,
  );
  assert.equal(
    classifyChange(field("request", "nullable_changed", { before: false, after: true })).severity,
    SEVERITY.NON_BREAKING,
  );
  assert.equal(
    classifyChange(
      field("request", "enum_changed", { before: ["A", "B", "VEHICLE"], after: ["A", "B"] }),
    ).severity,
    SEVERITY.BREAKING,
  );
  assert.equal(
    classifyChange(field("request", "enum_changed", { before: ["A"], after: ["A", "B"] })).severity,
    SEVERITY.NON_BREAKING,
  );
});

test("classifies response fields", () => {
  assert.equal(classifyChange(field("response", "removed")).severity, SEVERITY.BREAKING);
  assert.equal(
    classifyChange(field("response", "added", { after: { required: false } })).severity,
    SEVERITY.NON_BREAKING,
  );
  assert.equal(
    classifyChange(field("response", "required_changed", { before: true, after: false })).severity,
    SEVERITY.POTENTIAL,
  );
  assert.equal(
    classifyChange(field("response", "required_changed", { before: false, after: true })).severity,
    SEVERITY.NON_BREAKING,
  );
  assert.equal(
    classifyChange(field("response", "type_changed", { before: "integer", after: "number" })).severity,
    SEVERITY.BREAKING,
  );
  assert.equal(
    classifyChange(field("response", "nullable_changed", { before: false, after: true })).severity,
    SEVERITY.POTENTIAL,
  );
  assert.equal(
    classifyChange(field("response", "enum_changed", { before: ["A", "B"], after: ["A", "B", "C"] })).severity,
    SEVERITY.POTENTIAL,
  );
  assert.equal(
    classifyChange(field("response", "enum_changed", { before: ["A", "B"], after: ["A"] })).severity,
    SEVERITY.NON_BREAKING,
  );
});

test("classifies response status codes", () => {
  assert.equal(
    classifyChange(
      change("response_status_removed", {
        location: "response",
        direction: "response",
        statusCode: "404",
      }),
    ).severity,
    SEVERITY.BREAKING,
  );
  assert.equal(
    classifyChange(
      change("response_status_added", {
        location: "response",
        direction: "response",
        statusCode: "202",
      }),
    ).severity,
    SEVERITY.NON_BREAKING,
  );
});

test("classifies deprecations and sunset dates as warnings with reasons", () => {
  const deprecated = classifyChange(
    field("response", "deprecated_changed", { before: false, after: true }),
  );
  assert.equal(deprecated.severity, SEVERITY.WARNING);
  assert.match(deprecated.reason, /deprecated/i);

  const sunset = classifyChange(
    field("response", "sunset_changed", { before: null, after: "2026-11-01" }),
  );
  assert.equal(sunset.severity, SEVERITY.WARNING);
  assert.match(sunset.reason, /2026-11-01/);
});

test("internal operations override every rule and are excluded from public impact", () => {
  const internal = classifyChange(
    change("response_field_removed", {
      location: "response",
      direction: "response",
      fieldPath: "premium.total",
      isInternal: true,
    }),
  );

  assert.equal(internal.severity, SEVERITY.INTERNAL);
  assert.equal(internal.isInternal, true);
  assert.match(internal.reason, /internal-only/i);

  const summary = summarizeSeverity(classifyChanges([internal]));
  assert.deepEqual(summary, {
    BREAKING: 0,
    POTENTIAL: 0,
    NON_BREAKING: 0,
    WARNING: 0,
    INTERNAL: 1,
  });
});
