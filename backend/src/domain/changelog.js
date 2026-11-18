const SEVERITY_ORDER = ["BREAKING", "POTENTIAL", "WARNING", "NON_BREAKING", "INTERNAL"];

const SEVERITY_LABELS = {
  BREAKING: "Breaking",
  POTENTIAL: "Potentially breaking",
  WARNING: "Warning",
  NON_BREAKING: "Non-breaking",
  INTERNAL: "Internal only",
};

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

function compareEntries(first, second) {
  return (
    severityRank(first.severity) - severityRank(second.severity) ||
    String(first.method).localeCompare(String(second.method)) ||
    String(first.path).localeCompare(String(second.path)) ||
    String(first.fieldPath || "").localeCompare(String(second.fieldPath || "")) ||
    String(first.kind).localeCompare(String(second.kind))
  );
}

function toEntry(change) {
  return {
    severity: change.severity,
    kind: change.kind,
    method: change.method,
    path: change.path,
    location: change.location,
    direction: change.direction,
    fieldPath: change.fieldPath || null,
    statusCode: change.statusCode || null,
    contentType: change.contentType || null,
    parameter: change.parameter
      ? { name: change.parameter.name, in: change.parameter.in }
      : null,
    text: change.reason,
    affectedConsumers: (change.affectedConsumers || []).map((consumer) => consumer.slug),
    blocksPublish: change.blocksPublish === true,
  };
}

function paragraphs(entries, service) {
  const lines = [`# Changelog: ${service.name || service.slug}`];

  if (entries.length === 0) {
    lines.push("", "No public behavioural changes.");
    return lines.join("\n");
  }

  for (const severity of SEVERITY_ORDER) {
    const group = entries.filter((entry) => entry.severity === severity);

    if (group.length === 0) {
      continue;
    }

    lines.push("", `## ${SEVERITY_LABELS[severity]} (${group.length})`, "");
    for (const entry of group) {
      lines.push(`- **${entry.method} ${entry.path}** — ${entry.text}`);
    }
  }

  return lines.join("\n");
}

/**
 * Turn a comparison into a stable, human-readable public changelog.
 * Internal-only operations are counted in the summary but omitted from the
 * public entries and markdown, as required by the publish policy.
 */
function formatChangelog(comparison, service) {
  const publicChanges = comparison.changes.filter(
    (change) => !change.isInternal && change.severity !== "INTERNAL",
  );
  const entries = publicChanges.map(toEntry).sort(compareEntries);

  const publicSummary = {
    total: entries.length,
    byKind: {},
    byDirection: {},
    byLocation: {},
    bySeverity: SEVERITY_ORDER.reduce((counts, severity) => {
      counts[severity] = 0;
      return counts;
    }, {}),
  };

  for (const change of publicChanges) {
    publicSummary.byKind[change.kind] = (publicSummary.byKind[change.kind] || 0) + 1;
    publicSummary.byDirection[change.direction] =
      (publicSummary.byDirection[change.direction] || 0) + 1;
    publicSummary.byLocation[change.location] =
      (publicSummary.byLocation[change.location] || 0) + 1;
    publicSummary.bySeverity[change.severity] =
      (publicSummary.bySeverity[change.severity] || 0) + 1;
  }

  const markdown = paragraphs(entries, service);

  return {
    from: comparison.from,
    to: comparison.to,
    summary: comparison.summary,
    publicSummary,
    impact: comparison.impact,
    entries,
    changelog: entries.map((entry) => entry.text),
    text: entries.length === 0 ? "No public behavioural changes." : entries.map((entry) => entry.text).join("\n"),
    markdown,
  };
}

module.exports = {
  SEVERITY_ORDER,
  SEVERITY_LABELS,
  formatChangelog,
  compareEntries,
  toEntry,
};
