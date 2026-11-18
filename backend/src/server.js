const config = require("./config");
const { createDatabase } = require("./db");
const { createApp } = require("./app");

const db = createDatabase(config.dbPath);
const app = createApp(db);
const server = app.listen(config.port, () => {
  console.log(`Contract Guard backend running on port ${config.port}`);
  console.log(`Database: ${config.dbPath}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
