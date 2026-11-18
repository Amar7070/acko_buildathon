const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { createDatabase } = require("../src/db");
const registry = require("../src/services/registry.service");
const specService = require("../src/services/spec.service");
const consumerService = require("../src/services/consumer.service");
const { AppError } = require("../src/utils/errors");

const SERVICE_DEFS = [
  { slug: "quote-api", name: "Quote API", ownerTeam: "Quotes" },
  { slug: "policy-api", name: "Policy API", ownerTeam: "Policy" },
  { slug: "claims-api", name: "Claims API", ownerTeam: "Claims" },
];

const DEFAULT_SPECS_DIR = path.resolve(__dirname, "../../specs");
const DEFAULT_CONSUMERS_DIR = path.resolve(__dirname, "../../consumers");

function resolveDir(value, fallback) {
  const source = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return path.isAbsolute(source) ? path.resolve(source) : path.resolve(process.cwd(), source);
}

function listSpecFiles(specsDir, serviceSlug) {
  const dir = path.join(specsDir, serviceSlug);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Specs directory not found for ${serviceSlug}: ${dir}`);
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function ensureServices(db) {
  const services = [];
  for (const def of SERVICE_DEFS) {
    try {
      const service = registry.registerService(db, def);
      console.log(`+ service ${service.slug} (${service.name}, ${service.ownerTeam})`);
      services.push(service);
    } catch (err) {
      if (err instanceof AppError && err.code === "SERVICE_ALREADY_EXISTS") {
        const service = registry.resolveService(db, def.slug);
        console.log(`= service ${service.slug} already exists`);
        services.push(service);
      } else {
        throw err;
      }
    }
  }
  return services;
}

async function importSpecs(db, specsDir) {
  const summary = {
    services: 0,
    attempted: 0,
    uploaded: 0,
    duplicates: 0,
    rejected: 0,
    results: [],
  };

  for (const def of SERVICE_DEFS) {
    const service = registry.resolveService(db, def.slug);
    summary.services += 1;
    const files = listSpecFiles(specsDir, def.slug);

    for (const file of files) {
      summary.attempted += 1;
      const relative = `${def.slug}/${file}`;
      const content = fs.readFileSync(path.join(specsDir, def.slug, file), "utf8");

      try {
        const result = await specService.uploadSpec(db, service, {
          content,
          uploadedBy: "seed-starter-kit",
        });
        summary.uploaded += 1;
        summary.results.push({
          file: relative,
          status: "uploaded",
          specId: result.version.id,
          declaredVersion: result.version.declaredVersion,
          revision: result.version.revision,
          warnings: result.warnings || [],
        });
        console.log(
          `  + ${relative} -> draft v${result.version.declaredVersion} r${result.version.revision} (#${result.version.id})`,
        );
      } catch (err) {
        if (err instanceof AppError && err.code === "SPEC_ALREADY_EXISTS") {
          summary.duplicates += 1;
          summary.results.push({
            file: relative,
            status: "duplicate",
            existingSpecId: err.meta ? err.meta.existingSpecId : null,
            message: err.message,
          });
          console.log(`  = ${relative} -> duplicate (${err.message})`);
          continue;
        }

        if (err instanceof AppError && (err.status === 422 || err.status === 400)) {
          summary.rejected += 1;
          summary.results.push({
            file: relative,
            status: "rejected",
            code: err.code,
            message: err.message,
            details: err.details || [],
          });
          console.log(`  ! ${relative} -> rejected: [${err.code}] ${err.message}`);
          if (Array.isArray(err.details)) {
            for (const detail of err.details) {
              console.log(`      - ${detail.path || "<root>"}: ${detail.message}`);
            }
          }
          continue;
        }

        throw err;
      }
    }
  }

  return summary;
}

function importConsumers(db, consumersDir) {
  try {
    const result = consumerService.importConsumersFromDirectory(db, consumersDir);
    console.log(
      `Imported ${result.imported} consumer manifest(s) from ${result.directory} (${result.created} created, ${result.updated} updated).`,
    );
    for (const consumer of result.consumers) {
      console.log(
        `  - ${consumer.slug} (${consumer.file}): ${consumer.useCount} usage(s), ${consumer.created ? "created" : "updated"}`,
      );
    }
    return { status: "imported", ...result };
  } catch (err) {
    const message = err instanceof AppError ? `[${err.code}] ${err.message}` : err.message;
    console.log(`Consumer import skipped/failed: ${message}`);
    if (err.details) {
      for (const detail of err.details) {
        console.log(`  - ${detail.path || "<root>"}: ${detail.message}`);
      }
    }
    return { status: "failed", error: { message, details: err.details || null } };
  }
}

async function main() {
  const specsDir = resolveDir(process.argv[2] || process.env.SPECS_DIR, DEFAULT_SPECS_DIR);
  const consumersDir = resolveDir(process.argv[3] || process.env.CONSUMERS_DIR, DEFAULT_CONSUMERS_DIR);
  const db = createDatabase(config.dbPath);

  console.log(`Database: ${config.dbPath}`);
  console.log(`Specs:    ${specsDir}`);
  console.log(`Consumers:${consumersDir}`);

  try {
    ensureServices(db);
    const specs = await importSpecs(db, specsDir);
    const consumers = importConsumers(db, consumersDir);

    console.log("\nStarter kit import complete.");
    console.log(
      `Specs: ${specs.uploaded} uploaded, ${specs.duplicates} duplicate, ${specs.rejected} rejected (of ${specs.attempted} attempted).`,
    );
    if (consumers.status === "imported") {
      console.log(`Consumers: ${consumers.imported} imported.`);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
