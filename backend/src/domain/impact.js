function normaliseSegment(segment) {
  // `[]` marks an array item, not a different field. Treat breakdown[] and
  // breakdown as the same segment when matching consumer paths.
  return String(segment).replace(/\[\]$/, "");
}

function fieldSegments(value) {
  return String(value || "")
    .split(".")
    .map(normaliseSegment)
    .filter((segment) => segment.length > 0);
}

/**
 * Consumer paths match when they are equal or when one is an ancestor of the
 * other. `premium` matches `premium.breakdown[].amount` and vice versa.
 */
function pathsOverlap(first, second) {
  const left = fieldSegments(first);
  const right = fieldSegments(second);

  if (left.length === 0 || right.length === 0) {
    return left.length === right.length;
  }

  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function operationUsages(change, usages) {
  return usages.filter(
    (usage) => usage.method === change.method && usage.pathTemplate === change.path,
  );
}

function sendsMatch(usages, change) {
  return usages.filter((usage) =>
    (usage.sends || []).some((field) => pathsOverlap(field, change.fieldPath)),
  );
}

function readsMatch(usages, change) {
  return usages.filter((usage) =>
    (usage.reads || []).some((field) => pathsOverlap(field, change.fieldPath)),
  );
}

function sendsParameter(usages, parameter) {
  const name = parameter && parameter.name;
  if (!name) {
    return [];
  }
  return usages.filter((usage) => (usage.sends || []).includes(name));
}

function allOf(usages, via) {
  return usages.map((usage) => ({ usage, via, fields: [] }));
}

function matchingFields(usage, change, direction) {
  const paths = direction === "reads" ? usage.reads || [] : usage.sends || [];
  return paths.filter((field) => pathsOverlap(field, change.fieldPath));
}

/**
 * Return the raw usage matches for one classified change.
 * Internal operations never affect external consumers.
 */
function findMatches(change, usages) {
  if (
    change.isInternal ||
    change.severity === "INTERNAL" ||
    change.severity === "NON_BREAKING" ||
    !Array.isArray(usages)
  ) {
    return [];
  }

  const matching = operationUsages(change, usages);
  if (matching.length === 0) {
    return [];
  }

  if (change.location === "endpoint") {
    return change.kind === "endpoint_removed" ? allOf(matching, "operation") : [];
  }

  if (change.location === "parameter") {
    const parameter = change.parameter || {};

    if (change.kind === "parameter_added" && parameter.required) {
      return allOf(matching, "operation");
    }

    if (change.kind === "parameter_required_changed" && change.after === true) {
      return allOf(matching, "operation");
    }

    // Path parameters are always part of every call, regardless of the name a
    // consumer wrote in its manifest.
    if (parameter.in === "path") {
      return allOf(matching, "operation");
    }

    return sendsParameter(matching, parameter).map((usage) => ({
      usage,
      via: "sends",
      fields: [parameter.name],
    }));
  }

  if (change.direction === "request") {
    if (
      change.kind.startsWith("request_body_") ||
      change.kind.startsWith("request_content_type_")
    ) {
      return allOf(matching, "operation");
    }

    if (
      (change.kind === "request_field_added" && change.after && change.after.required) ||
      (change.kind === "request_field_required_changed" && change.after === true)
    ) {
      return allOf(matching, "operation");
    }

    return sendsMatch(matching, change).map((usage) => ({
      usage,
      via: "sends",
      fields: matchingFields(usage, change, "sends"),
    }));
  }

  if (change.direction === "response") {
    if (
      change.kind === "response_status_removed" ||
      change.kind === "response_content_type_removed"
    ) {
      return allOf(matching, "operation");
    }

    if (
      change.kind === "response_status_added" ||
      change.kind === "response_content_type_added" ||
      change.kind === "response_field_added"
    ) {
      return [];
    }

    return readsMatch(matching, change).map((usage) => ({
      usage,
      via: "reads",
      fields: matchingFields(usage, change, "reads"),
    }));
  }

  return [];
}

function toConsumer(match) {
  return {
    id: match.usage.consumerId,
    slug: match.usage.consumerSlug,
    name: match.usage.consumerName,
    team: match.usage.team,
    via: match.via,
    matchedFields: [...new Set(match.fields)].sort(),
  };
}

function dedupeMatches(matches) {
  const byConsumer = new Map();

  for (const match of matches) {
    const key = match.usage.consumerId;
    const existing = byConsumer.get(key);

    if (!existing) {
      byConsumer.set(key, toConsumer(match));
      continue;
    }

    if (!existing.via.split(",").includes(match.via)) {
      existing.via = `${existing.via},${match.via}`;
    }
    existing.matchedFields = [...new Set([...existing.matchedFields, ...match.fields])].sort();
  }

  return [...byConsumer.values()].sort((first, second) => first.slug.localeCompare(second.slug));
}

function findAffectedConsumers(change, usages) {
  return dedupeMatches(findMatches(change, usages));
}

/**
 * Attach affected consumers and the publish-blocking flag to every change.
 */
function attachImpact(changes, usages) {
  return changes.map((change) => {
    const affectedConsumers = findAffectedConsumers(change, usages);
    const blocksPublish = change.severity === "BREAKING" && affectedConsumers.length > 0;
    const reason =
      affectedConsumers.length > 0
        ? `${change.reason} Affects ${affectedConsumers.map((consumer) => consumer.slug).join(", ")}.`
        : change.reason;

    return {
      ...change,
      reason,
      affectedConsumers,
      blocksPublish,
    };
  });
}

function summarizeImpact(changes) {
  const bySeverity = {
    BREAKING: 0,
    POTENTIAL: 0,
    NON_BREAKING: 0,
    WARNING: 0,
    INTERNAL: 0,
  };
  const consumers = new Map();
  let blockingChangeCount = 0;

  for (const change of changes) {
    bySeverity[change.severity] = (bySeverity[change.severity] || 0) + 1;

    if (change.blocksPublish) {
      blockingChangeCount += 1;
    }

    for (const consumer of change.affectedConsumers || []) {
      let entry = consumers.get(consumer.id);

      if (!entry) {
        entry = {
          id: consumer.id,
          slug: consumer.slug,
          name: consumer.name,
          team: consumer.team,
          changeCount: 0,
          severities: new Set(),
          vias: new Set(),
          changes: [],
        };
        consumers.set(consumer.id, entry);
      }

      entry.changeCount += 1;
      entry.severities.add(change.severity);
      for (const via of consumer.via.split(",")) {
        entry.vias.add(via);
      }
      entry.changes.push({
        kind: change.kind,
        severity: change.severity,
        method: change.method,
        path: change.path,
        fieldPath: change.fieldPath,
        statusCode: change.statusCode,
        parameter: change.parameter ? change.parameter.name : null,
      });
    }
  }

  return {
    blocked: blockingChangeCount > 0,
    blockingChangeCount,
    affectedConsumerCount: consumers.size,
    affectedConsumers: [...consumers.values()]
      .map((entry) => ({
        id: entry.id,
        slug: entry.slug,
        name: entry.name,
        team: entry.team,
        changeCount: entry.changeCount,
        severities: [...entry.severities],
        vias: [...entry.vias],
        changes: entry.changes,
      }))
      .sort((first, second) => first.slug.localeCompare(second.slug)),
    bySeverity,
  };
}

module.exports = {
  pathsOverlap,
  fieldSegments,
  findAffectedConsumers,
  attachImpact,
  summarizeImpact,
};
