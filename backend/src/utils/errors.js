class AppError extends Error {
  constructor(status, code, message, details, meta) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.meta = meta;
  }
}

function notFound(code, message) {
  return new AppError(404, code, message);
}

function badRequest(code, message, details) {
  return new AppError(400, code, message, details);
}

function conflict(code, message, details, meta) {
  return new AppError(409, code, message, details, meta);
}

module.exports = { AppError, notFound, badRequest, conflict };
