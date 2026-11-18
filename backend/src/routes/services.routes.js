const express = require("express");
const registry = require("../services/registry.service");
const specService = require("../services/spec.service");
const compareService = require("../services/compare.service");

function createServicesRouter(db) {
  const router = express.Router();

  router.post("/", (req, res) => {
    const service = registry.registerService(db, req.body);
    res.status(201).json({ service });
  });

  router.get("/", (req, res) => {
    res.json({ services: registry.listServices(db) });
  });

  router.get("/:serviceRef", (req, res) => {
    const service = registry.resolveService(db, req.params.serviceRef);
    res.json({
      service,
      versions: specService.listSpecsForService(db, service.id),
    });
  });

  router.post("/:serviceRef/specs", async (req, res) => {
    const service = registry.resolveService(db, req.params.serviceRef);
    const upload = specService.extractUploadInput(req);
    const result = await specService.uploadSpec(db, service, upload);
    res.status(201).json(result);
  });

  router.get("/:serviceRef/specs", (req, res) => {
    const service = registry.resolveService(db, req.params.serviceRef);
    res.json({ versions: specService.listSpecsForService(db, service.id) });
  });

  router.get("/:serviceRef/diff", async (req, res) => {
    const service = registry.resolveService(db, req.params.serviceRef);
    const comparison = await compareService.compareVersions(db, service, req.query.from, req.query.to);
    res.json(comparison);
  });

  return router;
}

module.exports = { createServicesRouter };
