const path = require("node:path");
const config = require("../src/config");
const { createDatabase } = require("../src/db");
const consumerService = require("../src/services/consumer.service");

const directory = process.argv[2] || process.env.CONSUMERS_DIR || path.resolve(__dirname, "../../consumers");
const db = createDatabase(config.dbPath);

try {
  const result = consumerService.importConsumersFromDirectory(db, directory);

  console.log(
    `Imported ${result.imported} consumer manifest(s) from ${result.directory} ` +
      `(${result.created} created, ${result.updated} updated).`,
  );

  for (const consumer of result.consumers) {
    console.log(
      `- ${consumer.slug} (${consumer.file}): ${consumer.useCount} endpoint usage(s), ` +
        `${consumer.created ? "created" : "updated"}`,
    );
  }
} catch (err) {
  console.error(err.message);
  if (err.details) {
    for (const detail of err.details) {
      console.error(`  ${detail.path || "<root>"}: ${detail.message}`);
    }
  }
  process.exitCode = 1;
} finally {
  db.close();
}
