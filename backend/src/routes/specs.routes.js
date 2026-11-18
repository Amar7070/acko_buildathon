const express = require("express");
const specService = require("../services/spec.service");
const compareService = require("../services/compare.service");
const publishService = require("../services/publish.service");

function createSpecsRouter(db) {
  const router = express.Router();

  router.post("/:id/publish", async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const result = await publishService.publishSpec(db, req.params.id, {
      actor: req.get("x-actor") || body.actor,
      note: body.note,
    });

    res.status(result.outcome === "published" ? 201 : 409).json(result);
  });

  router.get("/:id/impact", async (req, res) => {
    const specRow = specService.getSpecRowById(db, req.params.id);
    const comparison = await compareService.compareSpecImpact(db, specRow, req.query.base);
    res.json(comparison);
  });

  router.get("/:id", (req, res) => {
    res.json({ version: specService.getSpecById(db, req.params.id) });
  });

  return router;
}

module.exports = { createSpecsRouter };
