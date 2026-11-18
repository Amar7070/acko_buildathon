const express = require("express");
const metricsService = require("../services/metrics.service");

function createMetricsRouter(db) {
  const router = express.Router();

  router.get("/", (req, res) => {
    res.json({ metrics: metricsService.getMetrics(db) });
  });

  return router;
}

module.exports = { createMetricsRouter };
