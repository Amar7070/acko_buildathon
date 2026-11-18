const { formatChangelog } = require("../domain/changelog");
const compareService = require("./compare.service");
const consumerService = require("./consumer.service");

/**
 * Generate a changelog between two versions. Without explicit ids, uses the
 * same latest-two default as the diff endpoint.
 */
async function getChangelog(db, service, fromId, toId) {
  const { fromRow, toRow } = compareService.selectVersions(db, service, fromId, toId);
  const usages = consumerService.listUsagesForService(db, service.id);
  const comparison = await compareService.compareSummary(fromRow, toRow, usages);

  return formatChangelog(comparison, service);
}

module.exports = {
  getChangelog,
};
