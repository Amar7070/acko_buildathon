const path = require("node:path");
require("dotenv").config();

module.exports = {
  port: Number(process.env.PORT || 5000),
  dbPath: process.env.DB_PATH || path.resolve(__dirname, "../data/contract-guard.db"),
};
