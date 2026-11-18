const express = require("express");
const specService = require("../services/spec.service");

function createSpecsRouter(db) {
  const router = express.Router();

  router.get("/:id", (req, res) => {
    res.json({ version: specService.getSpecById(db, req.params.id) });
  });

  return router;
}

module.exports = { createSpecsRouter };
