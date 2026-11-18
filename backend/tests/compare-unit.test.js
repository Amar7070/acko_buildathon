const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeDocument } = require("../src/domain/openapi-contract");
const { compareContracts } = require("../src/domain/diff");

function spec(path, operation, operationPath = path) {
  return {
    openapi: "3.0.3",
    info: { title: "Diff Test", version: "1.0.0" },
    paths: {
      [path]: {
        get: {
          operationId: "getThing",
          ...operation,
        },
      },
    },
    _operationPath: operationPath,
  };
}

function findChange(changes, kind, predicate = () => true) {
  return changes.find((change) => change.kind === kind && predicate(change));
}

test("compares parameters, nested request/response fields, types, required flags, enums and status codes", () => {
  const oldDocument = spec("/things/{id}", {
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      {
        name: "filter",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["a", "b"] },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              note: { type: "string", enum: ["x", "y"] },
              payload: {
                type: "object",
                required: ["score"],
                properties: { score: { type: "number" } },
              },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "ok",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["id", "count", "status", "nested"],
              properties: {
                id: { type: "string" },
                count: { type: "integer" },
                status: { type: "string", enum: ["A", "B"] },
                nested: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["value"],
                    properties: { value: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      "404": { description: "not found" },
    },
  });

  const newDocument = spec("/things/{thingId}", {
    parameters: [
      { name: "thingId", in: "path", required: true, schema: { type: "string" } },
      {
        name: "filter",
        in: "query",
        required: true,
        schema: { type: "integer", enum: [1] },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["name", "note"],
            properties: {
              name: { type: "string" },
              note: { type: "string", enum: ["x"] },
              payload: {
                type: "object",
                required: ["score"],
                properties: { score: { type: "string" } },
              },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "ok",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["id", "count", "status", "nested", "label"],
              properties: {
                id: { type: "string" },
                count: { type: "number" },
                status: { type: "string", enum: ["A", "B", "C"] },
                nested: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["value"],
                    properties: { value: { type: "string", nullable: true } },
                  },
                },
                label: { type: "string" },
              },
            },
          },
        },
      },
      "201": {
        description: "created",
        content: {
          "application/json": {
            schema: { type: "object", properties: { id: { type: "string" } } },
          },
        },
      },
    },
  });

  const oldContract = normalizeDocument(oldDocument);
  const newContract = normalizeDocument(newDocument);
  const { summary, changes } = compareContracts(oldContract, newContract);

  assert.equal(summary.total, 12, JSON.stringify(changes, null, 2));

  assert.ok(
    findChange(
      changes,
      "parameter_required_changed",
      (change) => change.parameter.name === "filter" && change.before === false && change.after === true,
    ),
  );
  assert.ok(
    findChange(
      changes,
      "parameter_type_changed",
      (change) => change.parameter.name === "filter" && change.before === "string" && change.after === "integer",
    ),
  );
  assert.ok(findChange(changes, "parameter_enum_changed", (change) => change.parameter.name === "filter"));

  assert.ok(
    findChange(
      changes,
      "request_field_required_changed",
      (change) => change.fieldPath === "note" && change.before === false && change.after === true,
    ),
  );
  assert.ok(findChange(changes, "request_field_enum_changed", (change) => change.fieldPath === "note"));
  assert.ok(
    findChange(
      changes,
      "request_field_type_changed",
      (change) => change.fieldPath === "payload.score" && change.before === "number" && change.after === "string",
    ),
  );

  assert.ok(
    findChange(
      changes,
      "response_field_type_changed",
      (change) => change.fieldPath === "count" && change.before === "integer" && change.after === "number",
    ),
  );
  assert.ok(findChange(changes, "response_field_enum_changed", (change) => change.fieldPath === "status"));
  assert.ok(
    findChange(
      changes,
      "response_field_nullable_changed",
      (change) => change.fieldPath === "nested[].value" && change.before === false && change.after === true,
    ),
  );
  assert.ok(
    findChange(
      changes,
      "response_field_added",
      (change) => change.fieldPath === "label" && change.after.required === true,
    ),
  );
  assert.ok(findChange(changes, "response_status_added", (change) => change.statusCode === "201"));
  assert.ok(findChange(changes, "response_status_removed", (change) => change.statusCode === "404"));

  // Renaming a path parameter does not change what callers send over HTTP.
  assert.equal(changes.filter((change) => change.direction === "parameter").length, 3);
});

test("merges allOf schemas before comparing nested fields", () => {
  function allOfDocument(nameType, nameRequired) {
    return spec("/composed", {
      responses: {
        "200": {
          description: "ok",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string" } },
                  },
                  {
                    type: "object",
                    required: nameRequired ? ["name"] : [],
                    properties: { name: { type: nameType } },
                  },
                ],
              },
            },
          },
        },
      },
    });
  }

  const { summary, changes } = compareContracts(
    normalizeDocument(allOfDocument("string", false)),
    normalizeDocument(allOfDocument("integer", true)),
  );

  assert.equal(summary.total, 2, JSON.stringify(changes, null, 2));
  assert.ok(
    findChange(
      changes,
      "response_field_type_changed",
      (change) => change.fieldPath === "name" && change.before === "string" && change.after === "integer",
    ),
  );
  assert.ok(
    findChange(
      changes,
      "response_field_required_changed",
      (change) => change.fieldPath === "name" && change.before === false && change.after === true,
    ),
  );
});

test("recursive schemas are traversed safely and still compared", () => {
  function nodeSchema(extraDepth) {
    return {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        // Circular edge: swagger-parser leaves this as a $ref after dereferencing.
        child: { $ref: "#/components/schemas/Node" },
        ...(extraDepth ? { depth: { type: "integer" } } : {}),
      },
    };
  }

  function recursiveDocument(extraDepth) {
    return {
      openapi: "3.0.3",
      info: { title: "Recursive", version: "1.0.0" },
      paths: {
        "/tree": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    // Simulates the resolved root while the cycle stays a $ref.
                    schema: nodeSchema(extraDepth),
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  const oldContract = normalizeDocument(recursiveDocument(false));
  const newContract = normalizeDocument(recursiveDocument(true));

  const { summary, changes } = compareContracts(oldContract, newContract);
  assert.equal(summary.total, 1, JSON.stringify(changes, null, 2));
  assert.ok(
    findChange(
      changes,
      "response_field_added",
      (change) => change.fieldPath === "depth" && change.after.type === "integer",
    ),
  );
});
