const SEVERITY = Object.freeze({
  BREAKING: "BREAKING",
  POTENTIAL: "POTENTIAL",
  NON_BREAKING: "NON_BREAKING",
  WARNING: "WARNING",
  INTERNAL: "INTERNAL",
});

const SEVERITY_LABELS = Object.freeze({
  BREAKING: "Breaking",
  POTENTIAL: "Potentially breaking",
  NON_BREAKING: "Non-breaking",
  WARNING: "Warning",
  INTERNAL: "Internal only",
});

function endpointLabel(change) {
  return `${change.method} ${change.path}`;
}

function fieldLabel(change) {
  return change.fieldPath || "body";
}

function parameterLabel(change) {
  const parameter = change.parameter || {};
  return `${parameter.in || "unknown"} parameter ${parameter.name || "<unnamed>"}`;
}

function normaliseEnum(value) {
  return Array.isArray(value) ? value : [];
}

function enumDelta(before, after) {
  const beforeValues = normaliseEnum(before);
  const afterValues = normaliseEnum(after);
  const beforeKeys = new Set(beforeValues.map((value) => JSON.stringify(value)));
  const afterKeys = new Set(afterValues.map((value) => JSON.stringify(value)));

  return {
    added: afterValues.filter((value) => !beforeKeys.has(JSON.stringify(value))),
    removed: beforeValues.filter((value) => !afterKeys.has(JSON.stringify(value))),
    hadEnum: Array.isArray(before),
    hasEnum: Array.isArray(after),
  };
}

function formatValues(values) {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function requestEnumReason(change, delta) {
  if (!delta.hadEnum && delta.hasEnum) {
    return `Request field ${fieldLabel(change)} now restricts values to ${formatValues(delta.added)}; callers sending anything else will be rejected.`;
  }
  if (delta.removed.length > 0) {
    return `Request field ${fieldLabel(change)} no longer accepts ${formatValues(delta.removed)}; callers sending those values will be rejected.`;
  }
  return `Request field ${fieldLabel(change)} now also accepts ${formatValues(delta.added)}; callers can use the new values.`;
}

function requestEnumSeverity(delta) {
  return (!delta.hadEnum && delta.hasEnum) || delta.removed.length > 0
    ? SEVERITY.BREAKING
    : SEVERITY.NON_BREAKING;
}

function responseEnumReason(change, delta) {
  if (delta.added.length > 0) {
    return `Response field ${fieldLabel(change)} can now return ${formatValues(delta.added)}; clients that handle the enum exhaustively may break.`;
  }
  return `Response field ${fieldLabel(change)} no longer returns ${formatValues(delta.removed)}; clients handling the removed values are unaffected.`;
}

function classifyParameter(change) {
  const label = parameterLabel(change);

  switch (change.kind) {
    case "parameter_added":
      return change.parameter.required
        ? {
            severity: SEVERITY.BREAKING,
            reason: `Required ${label} was added; every caller must now send it.`,
          }
        : {
            severity: SEVERITY.NON_BREAKING,
            reason: `Optional ${label} was added; existing callers can ignore it.`,
          };

    case "parameter_removed":
      return {
        severity: SEVERITY.POTENTIAL,
        reason: `${label} was removed; callers that still send it may fail or be ignored.`,
      };

    case "parameter_required_changed":
      return change.after
        ? {
            severity: SEVERITY.BREAKING,
            reason: `${label} became required; every caller must now send it.`,
          }
        : {
            severity: SEVERITY.NON_BREAKING,
            reason: `${label} became optional; existing callers can keep sending it.`,
          };

    case "parameter_type_changed":
    case "parameter_format_changed":
      return {
        severity: SEVERITY.BREAKING,
        reason: `${label} changed ${change.kind.endsWith("type_changed") ? "type" : "format"} from ${JSON.stringify(change.before)} to ${JSON.stringify(change.after)}; callers must update their values.`,
      };

    case "parameter_nullable_changed":
      return change.after
        ? {
            severity: SEVERITY.NON_BREAKING,
            reason: `${label} now accepts null; existing non-null values remain valid.`,
          }
        : {
            severity: SEVERITY.BREAKING,
            reason: `${label} no longer accepts null; callers sending null will fail.`,
          };

    case "parameter_enum_changed": {
      const delta = enumDelta(change.before, change.after);
      if (!delta.hadEnum && delta.hasEnum) {
        return {
          severity: SEVERITY.BREAKING,
          reason: `${label} now restricts values to ${formatValues(delta.added)}; callers sending anything else will be rejected.`,
        };
      }
      if (delta.removed.length > 0) {
        return {
          severity: SEVERITY.BREAKING,
          reason: `${label} no longer accepts ${formatValues(delta.removed)}; callers sending those values will be rejected.`,
        };
      }
      return {
        severity: SEVERITY.NON_BREAKING,
        reason: `${label} now also accepts ${formatValues(delta.added)}; callers can use the new values.`,
      };
    }

    default:
      return {
        severity: SEVERITY.WARNING,
        reason: `${label} changed (${change.kind}); review the before/after values.`,
      };
  }
}

function classifyRequestBody(change) {
  switch (change.kind) {
    case "request_body_added":
      return change.after && change.after.required
        ? {
            severity: SEVERITY.BREAKING,
            reason: `A required request body was added to ${endpointLabel(change)}; every caller must send it.`,
          }
        : {
            severity: SEVERITY.NON_BREAKING,
            reason: `An optional request body was added to ${endpointLabel(change)}.`,
          };

    case "request_body_removed":
      return {
        severity: SEVERITY.POTENTIAL,
        reason: `The request body was removed from ${endpointLabel(change)}; callers may still send it.`,
      };

    case "request_body_required_changed":
      return change.after
        ? {
            severity: SEVERITY.BREAKING,
            reason: `The request body on ${endpointLabel(change)} became required; callers must now send it.`,
          }
        : {
            severity: SEVERITY.NON_BREAKING,
            reason: `The request body on ${endpointLabel(change)} became optional.`,
          };

    case "request_content_type_added":
      return {
        severity: SEVERITY.NON_BREAKING,
        reason: `${endpointLabel(change)} now accepts request content type ${change.contentType}.`,
      };

    case "request_content_type_removed":
      return {
        severity: SEVERITY.BREAKING,
        reason: `${endpointLabel(change)} no longer accepts request content type ${change.contentType}; callers sending it will fail.`,
      };

    default:
      return {
        severity: SEVERITY.WARNING,
        reason: `The request body on ${endpointLabel(change)} changed (${change.kind}); review the before/after values.`,
      };
  }
}

function classifyRequestField(change) {
  const field = fieldLabel(change);

  switch (change.kind) {
    case "request_field_added":
      return change.after && change.after.required
        ? {
            severity: SEVERITY.BREAKING,
            reason: `Request field ${field} was added as required on ${endpointLabel(change)}; every caller must now send it.`,
          }
        : {
            severity: SEVERITY.NON_BREAKING,
            reason: `Optional request field ${field} was added on ${endpointLabel(change)}; existing callers are unaffected.`,
          };

    case "request_field_removed":
      return {
        severity: SEVERITY.POTENTIAL,
        reason: `Request field ${field} was removed from ${endpointLabel(change)}; callers that still send it may fail or be ignored.`,
      };

    case "request_field_required_changed":
      return change.after
        ? {
            severity: SEVERITY.BREAKING,
            reason: `Request field ${field} became required on ${endpointLabel(change)}; every caller must now send it.`,
          }
        : {
            severity: SEVERITY.NON_BREAKING,
            reason: `Request field ${field} became optional on ${endpointLabel(change)}; existing callers are unaffected.`,
          };

    case "request_field_type_changed":
    case "request_field_format_changed":
      return {
        severity: SEVERITY.BREAKING,
        reason: `Request field ${field} changed ${change.kind.endsWith("type_changed") ? "type" : "format"} from ${JSON.stringify(change.before)} to ${JSON.stringify(change.after)} on ${endpointLabel(change)}; callers must update their values.`,
      };

    case "request_field_nullable_changed":
      return change.after
        ? {
            severity: SEVERITY.NON_BREAKING,
            reason: `Request field ${field} now accepts null on ${endpointLabel(change)}; existing values remain valid.`,
          }
        : {
            severity: SEVERITY.BREAKING,
            reason: `Request field ${field} no longer accepts null on ${endpointLabel(change)}; callers sending null will fail.`,
          };

    case "request_field_enum_changed": {
      const delta = enumDelta(change.before, change.after);
      return {
        severity: requestEnumSeverity(delta),
        reason: requestEnumReason(change, delta),
      };
    }

    case "request_field_deprecated_changed":
      return {
        severity: SEVERITY.WARNING,
        reason: `Request field ${field} is ${change.after ? "now" : "no longer"} marked deprecated on ${endpointLabel(change)}.`,
      };

    case "request_field_sunset_changed":
      return {
        severity: SEVERITY.WARNING,
        reason: `Request field ${field} sunset date changed from ${change.before || "none"} to ${change.after || "none"} on ${endpointLabel(change)}.`,
      };

    default:
      return {
        severity: SEVERITY.WARNING,
        reason: `Request field ${field} changed (${change.kind}) on ${endpointLabel(change)}; review the before/after values.`,
      };
  }
}

function classifyResponseField(change) {
  const field = fieldLabel(change);

  switch (change.kind) {
    case "response_field_added":
      return {
        severity: SEVERITY.NON_BREAKING,
        reason: `Response field ${field} was added to ${endpointLabel(change)}; existing readers are unaffected.`,
      };

    case "response_field_removed":
      return {
        severity: SEVERITY.BREAKING,
        reason: `Response field ${field} was removed from ${endpointLabel(change)}; consumers reading it will break.`,
      };

    case "response_field_required_changed":
      return change.before === true && change.after === false
        ? {
            severity: SEVERITY.POTENTIAL,
            reason: `Response field ${field} is no longer guaranteed on ${endpointLabel(change)}; consumers reading it must handle its absence.`,
          }
        : {
            severity: SEVERITY.NON_BREAKING,
            reason: `Response field ${field} is now always present on ${endpointLabel(change)}.`,
          };

    case "response_field_type_changed":
    case "response_field_format_changed":
      return {
        severity: SEVERITY.BREAKING,
        reason: `Response field ${field} changed ${change.kind.endsWith("type_changed") ? "type" : "format"} from ${JSON.stringify(change.before)} to ${JSON.stringify(change.after)} on ${endpointLabel(change)}; consumers must update their parsing.`,
      };

    case "response_field_nullable_changed":
      return change.after
        ? {
            severity: SEVERITY.POTENTIAL,
            reason: `Response field ${field} can now be null on ${endpointLabel(change)}; consumers that assume a value must handle null.`,
          }
        : {
            severity: SEVERITY.NON_BREAKING,
            reason: `Response field ${field} can no longer be null on ${endpointLabel(change)}; consumers get a stronger guarantee.`,
          };

    case "response_field_enum_changed": {
      const delta = enumDelta(change.before, change.after);
      return {
        severity: delta.added.length > 0 ? SEVERITY.POTENTIAL : SEVERITY.NON_BREAKING,
        reason: responseEnumReason(change, delta),
      };
    }

    case "response_field_deprecated_changed":
      return {
        severity: SEVERITY.WARNING,
        reason: `Response field ${field} is ${change.after ? "now" : "no longer"} marked deprecated on ${endpointLabel(change)}.`,
      };

    case "response_field_sunset_changed":
      return {
        severity: SEVERITY.WARNING,
        reason: `Response field ${field} sunset date changed from ${change.before || "none"} to ${change.after || "none"} on ${endpointLabel(change)}.`,
      };

    default:
      return {
        severity: SEVERITY.WARNING,
        reason: `Response field ${field} changed (${change.kind}) on ${endpointLabel(change)}; review the before/after values.`,
      };
  }
}

function classifyResponseStatus(change) {
  return change.kind === "response_status_removed"
    ? {
        severity: SEVERITY.BREAKING,
        reason: `${endpointLabel(change)} no longer returns status ${change.statusCode}; consumers handling that response will break.`,
      }
    : {
        severity: SEVERITY.NON_BREAKING,
        reason: `${endpointLabel(change)} now also returns status ${change.statusCode}.`,
      };
}

function classifyContentType(change) {
  if (change.direction === "request") {
    return change.kind === "request_content_type_removed"
      ? {
          severity: SEVERITY.BREAKING,
          reason: `${endpointLabel(change)} no longer accepts request content type ${change.contentType}; callers sending it will fail.`,
        }
      : {
          severity: SEVERITY.NON_BREAKING,
          reason: `${endpointLabel(change)} now accepts request content type ${change.contentType}.`,
        };
  }

  return change.kind === "response_content_type_removed"
    ? {
        severity: SEVERITY.BREAKING,
        reason: `${endpointLabel(change)} no longer returns response content type ${change.contentType}; consumers expecting it will break.`,
      }
    : {
        severity: SEVERITY.NON_BREAKING,
        reason: `${endpointLabel(change)} now returns response content type ${change.contentType}.`,
      };
}

function classifyEndpoint(change) {
  switch (change.kind) {
    case "endpoint_added":
      return {
        severity: SEVERITY.NON_BREAKING,
        reason: `Endpoint ${endpointLabel(change)} was added.`,
      };

    case "endpoint_removed":
      return {
        severity: SEVERITY.BREAKING,
        reason: `Endpoint ${endpointLabel(change)} was removed; every existing caller will fail.`,
      };

    case "operation_internal_changed":
      return {
        severity: SEVERITY.WARNING,
        reason: `Endpoint ${endpointLabel(change)} changed its internal-only flag from ${change.before} to ${change.after}.`,
      };

    default:
      return {
        severity: SEVERITY.WARNING,
        reason: `Endpoint ${endpointLabel(change)} changed (${change.kind}); review the before/after values.`,
      };
  }
}

function ruleFor(change) {
  if (change.kind.startsWith("parameter_")) {
    return classifyParameter(change);
  }
  if (change.kind.startsWith("request_body_")) {
    return classifyRequestBody(change);
  }
  if (change.kind.startsWith("request_field_")) {
    return classifyRequestField(change);
  }
  if (change.kind === "request_content_type_added" || change.kind === "request_content_type_removed") {
    return classifyContentType(change);
  }
  if (change.kind.startsWith("response_field_")) {
    return classifyResponseField(change);
  }
  if (change.kind.startsWith("response_status_")) {
    return classifyResponseStatus(change);
  }
  if (change.kind === "response_content_type_added" || change.kind === "response_content_type_removed") {
    return classifyContentType(change);
  }
  if (change.location === "endpoint") {
    return classifyEndpoint(change);
  }

  return {
    severity: SEVERITY.WARNING,
    reason: `${endpointLabel(change)} changed (${change.kind}); review the before/after values.`,
  };
}

/**
 * Add a severity and a plain-English reason to a raw comparison change.
 * Changes on x-internal operations are always INTERNAL and excluded from
 * external consumer impact.
 */
function classifyChange(change) {
  const rule = ruleFor(change);

  if (change.isInternal) {
    return {
      ...change,
      severity: SEVERITY.INTERNAL,
      reason: `${rule.reason} This operation is marked internal-only, so external consumers are not affected.`,
      isInternal: true,
    };
  }

  return {
    ...change,
    severity: rule.severity,
    reason: rule.reason,
    isInternal: false,
  };
}

function classifyChanges(changes) {
  return changes.map(classifyChange);
}

function summarizeSeverity(changes) {
  const bySeverity = {
    BREAKING: 0,
    POTENTIAL: 0,
    NON_BREAKING: 0,
    WARNING: 0,
    INTERNAL: 0,
  };

  for (const change of changes) {
    bySeverity[change.severity] = (bySeverity[change.severity] || 0) + 1;
  }

  return bySeverity;
}

module.exports = {
  SEVERITY,
  SEVERITY_LABELS,
  classifyChange,
  classifyChanges,
  summarizeSeverity,
  enumDelta,
};
