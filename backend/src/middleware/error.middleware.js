const { AppError } = require("../utils/errors");

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof AppError) {
    const payload = {
      code: err.code,
      message: err.message,
    };

    if (err.details) {
      payload.details = err.details;
    }
    if (err.meta) {
      Object.assign(payload, err.meta);
    }

    return res.status(err.status).json({ error: payload });
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      error: {
        code: "INVALID_JSON",
        message: "The request body is not valid JSON.",
      },
    });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "The uploaded specification is too large.",
      },
    });
  }

  console.error("Unhandled error:", err);
  return res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected server error occurred.",
    },
  });
}

module.exports = { errorHandler };
