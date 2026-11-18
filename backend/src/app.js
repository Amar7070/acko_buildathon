const express = require("express");
const cors = require("cors");
const { createServicesRouter } = require("./routes/services.routes");
const { createSpecsRouter } = require("./routes/specs.routes");
const { createConsumersRouter } = require("./routes/consumers.routes");
const { createMetricsRouter } = require("./routes/metrics.routes");
const { errorHandler } = require("./middleware/error.middleware");
const { AppError } = require("./utils/errors");

function createApp(db) {
  if (!db) {
    throw new Error("createApp requires a database connection.");
  }

  const app = express();
  app.locals.db = db;

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use(
    express.text({
      type: ["application/yaml", "application/x-yaml", "text/yaml", "text/plain"],
      limit: "2mb",
    }),
  );

  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      service: "Contract Guard Backend",
    });
  });

  app.use("/api/v1/services", createServicesRouter(db));
  app.use("/api/v1/specs", createSpecsRouter(db));
  app.use("/api/v1/consumers", createConsumersRouter(db));
  app.use("/api/v1/metrics", createMetricsRouter(db));

  app.use((req, res, next) => {
    next(new AppError(404, "NOT_FOUND", `No route matches ${req.method} ${req.originalUrl}.`));
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
