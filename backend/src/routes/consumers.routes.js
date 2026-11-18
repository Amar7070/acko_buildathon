const express = require("express");
const consumerService = require("../services/consumer.service");

function createConsumersRouter(db) {
  const router = express.Router();

  router.post("/import", (req, res) => {
    const directory =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body.directory
        : undefined;
    const result = consumerService.importConsumersFromDirectory(db, directory);
    res.status(result.created > 0 ? 201 : 200).json(result);
  });

  router.post("/", (req, res) => {
    const input = consumerService.extractConsumerInput(req);
    const result = consumerService.upsertConsumer(db, input);
    res.status(result.created ? 201 : 200).json(result);
  });

  router.get("/", (req, res) => {
    res.json({ consumers: consumerService.listConsumers(db) });
  });

  router.get("/:slug", (req, res) => {
    res.json({ consumer: consumerService.getConsumerBySlug(db, req.params.slug) });
  });

  router.delete("/:slug", (req, res) => {
    consumerService.deleteConsumer(db, req.params.slug);
    res.status(204).end();
  });

  return router;
}

module.exports = { createConsumersRouter };
