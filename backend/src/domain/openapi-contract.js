const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

const MERGED_SCHEMA_KEYS = [
  "type",
  "format",
  "items",
  "enum",
  "nullable",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "additionalProperties",
];

function canonicalizePath(path) {
  return String(path).replace(/\{[^}]+\}/g, "{}");
}

function pathParameterOrder(path) {
  const order = new Map();
  let index = 0;

  String(path).replace(/\{([^}]+)\}/g, (match, name) => {
    if (!order.has(name)) {
      order.set(name, index);
      index += 1;
    }
    return match;
  });

  return order;
}

function parameterKey(parameter, pathOrder) {
  if (parameter.in === "path") {
    const position = pathOrder.get(parameter.name);
    // A path parameter's name is not part of the HTTP contract. Match it by
    // position so renaming {id} to {quoteId} is not reported as a change.
    return position === undefined ? `path:${parameter.name}` : `path:${position}`;
  }

  return `${parameter.in || "unknown"}:${parameter.name || ""}`;
}

function inferType(schema) {
  if (Array.isArray(schema.type)) {
    return schema.type.join("|");
  }
  if (schema.type) {
    return schema.type;
  }
  if (schema.properties) {
    return "object";
  }
  if (schema.items) {
    return "array";
  }
  return null;
}

/**
 * OpenAPI 3.0 schemas can compose objects with allOf. Merge the parts so the
 * flattened field paths describe the effective schema rather than the file layout.
 */
function mergeAllOf(schema, stack = new Set()) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.$ref) {
    return schema || {};
  }

  if (!Array.isArray(schema.allOf) || schema.allOf.length === 0 || stack.has(schema)) {
    return schema;
  }

  const nextStack = new Set(stack);
  nextStack.add(schema);

  const merged = {
    ...schema,
    properties: { ...(schema.properties || {}) },
  };
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  delete merged.allOf;

  for (const rawPart of schema.allOf) {
    const part = mergeAllOf(rawPart, nextStack);
    if (!part || typeof part !== "object" || part.$ref) {
      continue;
    }

    Object.assign(merged.properties, part.properties || {});
    for (const name of part.required || []) {
      required.add(name);
    }
    for (const key of MERGED_SCHEMA_KEYS) {
      if (merged[key] === undefined && part[key] !== undefined) {
        merged[key] = part[key];
      }
    }
  }

  if (Object.keys(merged.properties).length === 0) {
    delete merged.properties;
  } else {
    merged.properties = { ...merged.properties };
  }

  if (required.size > 0) {
    merged.required = [...required];
  } else {
    delete merged.required;
  }

  return merged;
}

function describeSchema(schema) {
  const effective = mergeAllOf(schema);

  return {
    type: inferType(effective),
    format: effective.format || null,
    nullable: effective.nullable === true,
    enum: Array.isArray(effective.enum) ? [...effective.enum] : null,
  };
}

/**
 * Convert a schema tree into a map keyed by field path. Array items use [].
 * Examples: `premium.total`, `premium.breakdown[].amount`.
 *
 * `required` is relative to the immediate parent object. The body root and
 * array-item schemas have a null required value.
 */
function flattenSchema(schema) {
  const fields = new Map();
  const ancestors = new Set();

  function walk(rawSchema, path, required) {
    if (
      !rawSchema ||
      typeof rawSchema !== "object" ||
      Array.isArray(rawSchema) ||
      typeof rawSchema.$ref === "string"
    ) {
      return;
    }

    if (ancestors.has(rawSchema)) {
      return;
    }

    ancestors.add(rawSchema);
    const effective = mergeAllOf(rawSchema);
    if (effective !== rawSchema) {
      ancestors.add(effective);
    }

    fields.set(path, {
      path,
      required: required === undefined ? null : required,
      ...describeSchema(effective),
    });

    const requiredNames = new Set(Array.isArray(effective.required) ? effective.required : []);

    if (
      effective.properties &&
      typeof effective.properties === "object" &&
      !Array.isArray(effective.properties)
    ) {
      for (const [name, child] of Object.entries(effective.properties)) {
        walk(child, path ? `${path}.${name}` : name, requiredNames.has(name));
      }
    }

    if (effective.items && typeof effective.items === "object") {
      walk(effective.items, `${path}[]`, null);
    }

    ancestors.delete(effective);
    ancestors.delete(rawSchema);
  }

  walk(schema || {}, "", null);
  return fields;
}

function normalizeParameter(parameter, key) {
  return {
    key,
    name: parameter.name || null,
    in: parameter.in || null,
    required: parameter.required === true,
    schema: describeSchema(parameter.schema || {}),
  };
}

function normalizeContent(content) {
  const result = new Map();

  if (!content || typeof content !== "object") {
    return result;
  }

  for (const [contentType, mediaType] of Object.entries(content)) {
    const schema = mediaType && typeof mediaType === "object" ? mediaType.schema : undefined;
    result.set(contentType, {
      fields: flattenSchema(schema || {}),
    });
  }

  return result;
}

function normalizeRequestBody(requestBody) {
  if (!requestBody || typeof requestBody !== "object" || requestBody.$ref) {
    return null;
  }

  return {
    required: requestBody.required === true,
    content: normalizeContent(requestBody.content),
  };
}

function normalizeResponses(responses) {
  const result = new Map();

  if (!responses || typeof responses !== "object") {
    return result;
  }

  for (const [statusCode, response] of Object.entries(responses)) {
    if (!response || typeof response !== "object" || response.$ref) {
      result.set(String(statusCode), { statusCode: String(statusCode), content: new Map() });
      continue;
    }

    result.set(String(statusCode), {
      statusCode: String(statusCode),
      content: normalizeContent(response.content),
    });
  }

  return result;
}

/**
 * Normalize a dereferenced OpenAPI document into the comparison model.
 * Component names and $ref structure are intentionally discarded here.
 */
function normalizeDocument(document) {
  const operations = new Map();
  const paths = document && document.paths && typeof document.paths === "object" ? document.paths : {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object" || pathItem.$ref) {
      continue;
    }

    const pathOrder = pathParameterOrder(path);
    const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") {
        continue;
      }

      const parameters = new Map();
      const allParameters = [
        ...pathParameters,
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ];

      for (const parameter of allParameters) {
        if (!parameter || typeof parameter !== "object" || parameter.$ref) {
          continue;
        }
        const key = parameterKey(parameter, pathOrder);
        // Operation-level parameters override path-level parameters with the same key.
        parameters.set(key, normalizeParameter(parameter, key));
      }

      const canonicalPath = canonicalizePath(path);
      const key = `${method.toUpperCase()} ${canonicalPath}`;

      operations.set(key, {
        key,
        method: method.toUpperCase(),
        path,
        canonicalPath,
        operationId: operation.operationId || null,
        internal: operation["x-internal"] === true,
        parameters,
        requestBody: normalizeRequestBody(operation.requestBody),
        responses: normalizeResponses(operation.responses),
      });
    }
  }

  return {
    title: document && document.info ? document.info.title || null : null,
    version: document && document.info ? document.info.version || null : null,
    operations,
  };
}

module.exports = {
  HTTP_METHODS,
  canonicalizePath,
  pathParameterOrder,
  parameterKey,
  inferType,
  mergeAllOf,
  describeSchema,
  flattenSchema,
  normalizeDocument,
};
