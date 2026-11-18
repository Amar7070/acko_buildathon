function roundRatio(value) {
  return Math.round(value * 10000) / 10000;
}

function countStatuses(rows) {
  const counts = { draft: 0, published: 0, rejected: 0 };
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

/**
 * Protection metrics for the dashboard: what was uploaded, what was caught,
 * and how often publishing was blocked because real consumers were affected.
 */
function getMetrics(db) {
  const specsByStatus = countStatuses(
    db.prepare("SELECT status, COUNT(*) AS count FROM spec_versions GROUP BY status").all(),
  );
  const specsUploaded = specsByStatus.draft + specsByStatus.published + specsByStatus.rejected;

  const attemptsByOutcome = { published: 0, blocked: 0 };
  let publishAttempts = 0;
  for (const row of db
    .prepare("SELECT outcome, COUNT(*) AS count FROM publish_attempts GROUP BY outcome")
    .all()) {
    attemptsByOutcome[row.outcome] = row.count;
    publishAttempts += row.count;
  }

  const attemptTotals = db
    .prepare(`
      SELECT
        COALESCE(SUM(breaking_count), 0) AS breaking_changes,
        COALESCE(SUM(CASE WHEN outcome = 'blocked' THEN breaking_count ELSE 0 END), 0) AS dangerous_changes,
        COALESCE(SUM(affected_consumer_count), 0) AS affected_consumers,
        COALESCE(SUM(CASE WHEN outcome = 'blocked' THEN affected_consumer_count ELSE 0 END), 0) AS affected_consumers_blocked,
        COALESCE(SUM(CASE WHEN affected_consumer_count > 0 THEN 1 ELSE 0 END), 0) AS proposed_with_impact
      FROM publish_attempts
    `)
    .get();

  const breakingChangesByService = db
    .prepare(`
      SELECT
        s.id AS service_id,
        s.slug,
        s.name,
        COUNT(ac.id) AS breaking_count
      FROM attempt_changes ac
      JOIN publish_attempts pa ON pa.id = ac.attempt_id
      JOIN services s ON s.id = pa.service_id
      WHERE ac.severity = 'BREAKING'
      GROUP BY s.id, s.slug, s.name
      ORDER BY breaking_count DESC, s.name COLLATE NOCASE
    `)
    .all()
    .map((row) => ({
      serviceId: row.service_id,
      slug: row.slug,
      name: row.name,
      breakingCount: row.breaking_count,
    }));

  const servicesRegistered = db.prepare("SELECT COUNT(*) AS count FROM services").get().count;
  const consumersRegistered = db.prepare("SELECT COUNT(*) AS count FROM consumers").get().count;
  const usagesRegistered = db.prepare("SELECT COUNT(*) AS count FROM consumer_endpoints").get().count;

  return {
    servicesRegistered,
    specsUploaded,
    specsDraft: specsByStatus.draft,
    specsPublished: specsByStatus.published,
    specsRejected: specsByStatus.rejected,
    validationFailureRate:
      specsUploaded === 0 ? 0 : roundRatio(specsByStatus.rejected / specsUploaded),
    publishAttempts,
    publishedPublishes: attemptsByOutcome.published,
    blockedPublishes: attemptsByOutcome.blocked,
    publishSuccessRatio:
      publishAttempts === 0 ? 0 : roundRatio(attemptsByOutcome.published / publishAttempts),
    breakingChanges: attemptTotals.breaking_changes,
    dangerousChangesCaught: attemptTotals.dangerous_changes,
    affectedConsumers: attemptTotals.affected_consumers,
    affectedConsumersOnBlocked: attemptTotals.affected_consumers_blocked,
    proposedVersionsWithConsumerImpact: attemptTotals.proposed_with_impact,
    consumersRegistered,
    usagesRegistered,
    breakingChangesByService,
  };
}

module.exports = {
  getMetrics,
};
