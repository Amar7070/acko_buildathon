function unionKeys(first, second) {
  return [...new Set([...first.keys(), ...second.keys()])].sort();
}

function enumEqual(first, second) {
  if (first === null && second === null) {
    return true;
  }
  if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) {
    return false;
  }

  const normalise = (value) => JSON.stringify(value);
  const left = first.map(normalise).sort();
  const right = second.map(normalise).sort();
  return left.every((value, index) => value === right[index]);
}

function endpointName(operation) {
  return `${operation.method} ${operation.canonicalPath}`;
}

function fieldName(path) {
  return path === "" ? "body" : path;
}

function parameterSummary(parameter) {
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.required,
    schema: parameter.schema,
  };
}

function makeChange({
  kind,
  operation,
  location,
  direction,
  fieldPath = null,
  contentType = null,
  statusCode = null,
  parameter = null,
  before = null,
  after = null,
  description,
}) {
  return {
    kind,
    method: operation.method,
    path: operation.canonicalPath,
    location,
    direction,
    fieldPath,
    contentType,
    statusCode,
    parameter,
    before,
    after,
    isInternal: operation.internal === true,
    description,
  };
}

function describeTarget(context) {
  if (context.parameter) {
    return `${context.parameter.in || "unknown"} parameter ${context.parameter.name}`;
  }
  return fieldName(context.fieldPath || "");
}

function compareSchemaDescriptor(prefix, context, oldSchema, newSchema, changes) {
  const target = describeTarget(context);

  if (oldSchema.type !== newSchema.type) {
    changes.push(
      makeChange({
        ...context,
        kind: `${prefix}_type_changed`,
        before: oldSchema.type,
        after: newSchema.type,
        description: `${target} type changed from ${oldSchema.type || "none"} to ${newSchema.type || "none"} on ${endpointName(context.operation)}.`,
      }),
    );
  }

  if (oldSchema.format !== newSchema.format) {
    changes.push(
      makeChange({
        ...context,
        kind: `${prefix}_format_changed`,
        before: oldSchema.format,
        after: newSchema.format,
        description: `${target} format changed from ${oldSchema.format || "none"} to ${newSchema.format || "none"} on ${endpointName(context.operation)}.`,
      }),
    );
  }

  if (oldSchema.nullable !== newSchema.nullable) {
    changes.push(
      makeChange({
        ...context,
        kind: `${prefix}_nullable_changed`,
        before: oldSchema.nullable,
        after: newSchema.nullable,
        description: `${target} nullable changed from ${oldSchema.nullable} to ${newSchema.nullable} on ${endpointName(context.operation)}.`,
      }),
    );
  }

  if (!enumEqual(oldSchema.enum, newSchema.enum)) {
    changes.push(
      makeChange({
        ...context,
        kind: `${prefix}_enum_changed`,
        before: oldSchema.enum,
        after: newSchema.enum,
        description: `${target} allowed values changed on ${endpointName(context.operation)}.`,
      }),
    );
  }

  if (oldSchema.deprecated !== newSchema.deprecated) {
    changes.push(
      makeChange({
        ...context,
        kind: `${prefix}_deprecated_changed`,
        before: oldSchema.deprecated,
        after: newSchema.deprecated,
        description: `${target} is ${newSchema.deprecated ? "now" : "no longer"} marked deprecated on ${endpointName(context.operation)}.`,
      }),
    );
  }

  if (oldSchema.sunset !== newSchema.sunset) {
    changes.push(
      makeChange({
        ...context,
        kind: `${prefix}_sunset_changed`,
        before: oldSchema.sunset,
        after: newSchema.sunset,
        description: `${target} sunset date changed from ${oldSchema.sunset || "none"} to ${newSchema.sunset || "none"} on ${endpointName(context.operation)}.`,
      }),
    );
  }
}

function compareParameters(oldOperation, newOperation, changes) {
  for (const key of unionKeys(oldOperation.parameters, newOperation.parameters)) {
    const oldParameter = oldOperation.parameters.get(key);
    const newParameter = newOperation.parameters.get(key);
    const parameter = newParameter || oldParameter;
    const parameterContext = {
      operation: newOperation,
      location: "parameter",
      direction: "parameter",
      parameter: parameterSummary(parameter),
    };

    if (!oldParameter) {
      changes.push(
        makeChange({
          ...parameterContext,
          kind: "parameter_added",
          after: parameterSummary(newParameter),
          description: `Added ${newParameter.required ? "required " : ""}${newParameter.in} parameter ${newParameter.name} to ${endpointName(newOperation)}.`,
        }),
      );
      continue;
    }

    if (!newParameter) {
      changes.push(
        makeChange({
          ...parameterContext,
          kind: "parameter_removed",
          before: parameterSummary(oldParameter),
          description: `Removed ${oldParameter.in} parameter ${oldParameter.name} from ${endpointName(newOperation)}.`,
        }),
      );
      continue;
    }

    if (oldParameter.required !== newParameter.required) {
      changes.push(
        makeChange({
          ...parameterContext,
          kind: "parameter_required_changed",
          before: oldParameter.required,
          after: newParameter.required,
          description: `${newParameter.in} parameter ${newParameter.name} changed from ${oldParameter.required ? "required" : "optional"} to ${newParameter.required ? "required" : "optional"} on ${endpointName(newOperation)}.`,
        }),
      );
    }

    compareSchemaDescriptor("parameter", parameterContext, oldParameter.schema, newParameter.schema, changes);
  }
}

function compareFields(direction, operation, statusCode, contentType, oldContent, newContent, changes) {
  for (const path of unionKeys(oldContent.fields, newContent.fields)) {
    const oldField = oldContent.fields.get(path);
    const newField = newContent.fields.get(path);
    const displayPath = path === "" ? "$" : path;
    const fieldContext = {
      operation,
      location: direction,
      direction,
      fieldPath: displayPath,
      contentType,
      statusCode,
    };

    if (!oldField) {
      changes.push(
        makeChange({
          ...fieldContext,
          kind: `${direction}_field_added`,
          after: newField,
          description: `Added ${direction} field ${displayPath} to ${endpointName(operation)}${statusCode ? ` ${statusCode}` : ""}.`,
        }),
      );
      continue;
    }

    if (!newField) {
      changes.push(
        makeChange({
          ...fieldContext,
          kind: `${direction}_field_removed`,
          before: oldField,
          description: `Removed ${direction} field ${displayPath} from ${endpointName(operation)}${statusCode ? ` ${statusCode}` : ""}.`,
        }),
      );
      continue;
    }

    if (oldField.required !== newField.required && oldField.required !== null && newField.required !== null) {
      changes.push(
        makeChange({
          ...fieldContext,
          kind: `${direction}_field_required_changed`,
          before: oldField.required,
          after: newField.required,
          description: `${direction} field ${displayPath} changed from ${oldField.required ? "required" : "optional"} to ${newField.required ? "required" : "optional"} on ${endpointName(operation)}${statusCode ? ` ${statusCode}` : ""}.`,
        }),
      );
    }

    compareSchemaDescriptor(`${direction}_field`, fieldContext, oldField, newField, changes);
  }
}

function compareContent(direction, operation, statusCode, oldContent, newContent, changes) {
  for (const contentType of unionKeys(oldContent, newContent)) {
    const oldMediaType = oldContent.get(contentType);
    const newMediaType = newContent.get(contentType);

    if (!oldMediaType) {
      changes.push(
        makeChange({
          kind: `${direction}_content_type_added`,
          operation,
          location: direction,
          direction,
          contentType,
          statusCode,
          after: { contentType },
          description: `Added ${direction} content type ${contentType} to ${endpointName(operation)}${statusCode ? ` ${statusCode}` : ""}.`,
        }),
      );
      continue;
    }

    if (!newMediaType) {
      changes.push(
        makeChange({
          kind: `${direction}_content_type_removed`,
          operation,
          location: direction,
          direction,
          contentType,
          statusCode,
          before: { contentType },
          description: `Removed ${direction} content type ${contentType} from ${endpointName(operation)}${statusCode ? ` ${statusCode}` : ""}.`,
        }),
      );
      continue;
    }

    compareFields(direction, operation, statusCode, contentType, oldMediaType, newMediaType, changes);
  }
}

function compareRequestBody(oldOperation, newOperation, changes) {
  const oldBody = oldOperation.requestBody;
  const newBody = newOperation.requestBody;

  if (!oldBody && newBody) {
    changes.push(
      makeChange({
        kind: "request_body_added",
        operation: newOperation,
        location: "request",
        direction: "request",
        after: {
          required: newBody.required,
          contentTypes: [...newBody.content.keys()],
        },
        description: `Added a request body to ${endpointName(newOperation)}.`,
      }),
    );
    return;
  }

  if (oldBody && !newBody) {
    changes.push(
      makeChange({
        kind: "request_body_removed",
        operation: newOperation,
        location: "request",
        direction: "request",
        before: {
          required: oldBody.required,
          contentTypes: [...oldBody.content.keys()],
        },
        description: `Removed the request body from ${endpointName(newOperation)}.`,
      }),
    );
    return;
  }

  if (!oldBody || !newBody) {
    return;
  }

  if (oldBody.required !== newBody.required) {
    changes.push(
      makeChange({
        kind: "request_body_required_changed",
        operation: newOperation,
        location: "request",
        direction: "request",
        before: oldBody.required,
        after: newBody.required,
        description: `Request body changed from ${oldBody.required ? "required" : "optional"} to ${newBody.required ? "required" : "optional"} on ${endpointName(newOperation)}.`,
      }),
    );
  }

  compareContent("request", newOperation, null, oldBody.content, newBody.content, changes);
}

function compareResponses(oldOperation, newOperation, changes) {
  for (const statusCode of unionKeys(oldOperation.responses, newOperation.responses)) {
    const oldResponse = oldOperation.responses.get(statusCode);
    const newResponse = newOperation.responses.get(statusCode);

    if (!oldResponse) {
      changes.push(
        makeChange({
          kind: "response_status_added",
          operation: newOperation,
          location: "response",
          direction: "response",
          statusCode,
          after: {
            statusCode,
            contentTypes: [...newResponse.content.keys()],
          },
          description: `Added response status ${statusCode} to ${endpointName(newOperation)}.`,
        }),
      );
      continue;
    }

    if (!newResponse) {
      changes.push(
        makeChange({
          kind: "response_status_removed",
          operation: newOperation,
          location: "response",
          direction: "response",
          statusCode,
          before: {
            statusCode,
            contentTypes: [...oldResponse.content.keys()],
          },
          description: `Removed response status ${statusCode} from ${endpointName(newOperation)}.`,
        }),
      );
      continue;
    }

    compareContent("response", newOperation, statusCode, oldResponse.content, newResponse.content, changes);
  }
}

function compareOperations(oldContract, newContract, changes) {
  for (const key of unionKeys(oldContract.operations, newContract.operations)) {
    const oldOperation = oldContract.operations.get(key);
    const newOperation = newContract.operations.get(key);

    if (!oldOperation) {
      changes.push(
        makeChange({
          kind: "endpoint_added",
          operation: newOperation,
          location: "endpoint",
          direction: "endpoint",
          after: {
            operationId: newOperation.operationId,
            internal: newOperation.internal,
          },
          description: `Added endpoint ${endpointName(newOperation)}.`,
        }),
      );
      continue;
    }

    if (!newOperation) {
      changes.push(
        makeChange({
          kind: "endpoint_removed",
          operation: oldOperation,
          location: "endpoint",
          direction: "endpoint",
          before: {
            operationId: oldOperation.operationId,
            internal: oldOperation.internal,
          },
          description: `Removed endpoint ${endpointName(oldOperation)}.`,
        }),
      );
      continue;
    }

    if (oldOperation.internal !== newOperation.internal) {
      changes.push(
        makeChange({
          kind: "operation_internal_changed",
          operation: newOperation,
          location: "endpoint",
          direction: "endpoint",
          before: oldOperation.internal,
          after: newOperation.internal,
          description: `Endpoint ${endpointName(newOperation)} changed its internal-only flag.`,
        }),
      );
    }

    compareParameters(oldOperation, newOperation, changes);
    compareRequestBody(oldOperation, newOperation, changes);
    compareResponses(oldOperation, newOperation, changes);
  }
}

function summarizeChanges(changes) {
  const byKind = {};
  const byDirection = {};
  const byLocation = {};

  for (const change of changes) {
    byKind[change.kind] = (byKind[change.kind] || 0) + 1;
    byDirection[change.direction] = (byDirection[change.direction] || 0) + 1;
    byLocation[change.location] = (byLocation[change.location] || 0) + 1;
  }

  return {
    total: changes.length,
    byKind,
    byDirection,
    byLocation,
  };
}

function compareContracts(oldContract, newContract) {
  const changes = [];
  compareOperations(oldContract, newContract, changes);

  return {
    summary: summarizeChanges(changes),
    changes,
  };
}

module.exports = {
  compareContracts,
  summarizeChanges,
  enumEqual,
};
