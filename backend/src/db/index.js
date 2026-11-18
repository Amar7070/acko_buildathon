const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const DEFAULT_DB_PATH = path.resolve(__dirname, "../../data/contract-guard.db");

function createDatabase(filename = process.env.DB_PATH || DEFAULT_DB_PATH) {
  const isMemory = filename === ":memory:";

  if (!isMemory) {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }

  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  if (!isMemory) {
    db.pragma("journal_mode = WAL");
  }

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  return db;
}

module.exports = { createDatabase, DEFAULT_DB_PATH };
