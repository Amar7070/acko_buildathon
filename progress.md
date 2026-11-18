# Progress Report — Contract Guard

This document summarizes what has been implemented and verified so far for the Contract Guard build (API contract registry, semantic diff/classification, consumer impact analysis, safe publishing, changelog, and metrics). **`PLAN.md` and the company’s original starter files (`specs/`, `consumers/`) have not been modified.**

## 1. Backend (Node.js + Express 5 + SQLite)

**Stack:** Node.js (CommonJS), Express 5, SQLite via `better-sqlite3`, OpenAPI parsing/validation via `@apidevtools/swagger-parser` and `yaml`. Layered structure: `routes` → `services` → `domain` (pure comparison/classification/impact/changelog/contract logic) → `db`/`utils`.

**Implemented capabilities**
- **Service registry:** register/list/get provider services (`/api/v1/services`).
- **Spec ingestion & versioning:** upload OpenAPI 3.0.x specs (YAML/JSON), parse and validate, dereference (circular refs handled safely), normalize to an internal contract, deduplicate by content hash per service, assign revisions/declared versions, store as **drafts** by default; rejects invalid/unsupported specs with structured errors (e.g. missing `$ref`, non-3.0).
- **Semantic diff:** compare versions by `METHOD +` canonicalized path/template (path-parameter name differences are not treated as contract changes), including parameters, request/response bodies, nested fields, required/nullable/type/format/enum changes, status codes/content types, and deprecation/sunset (`x-sunset`) signals. Handles `$ref`/`allOf` merging and recursion safely.
- **Classification:** each change classified as `BREAKING`, `POTENTIAL`, `NON_BREAKING`, `WARNING`, or `INTERNAL` with a human-readable reason. Operations marked internal-only (`x-internal`) are treated as `INTERNAL` and excluded from external/public consumer impact.
- **Consumer registry & import:** consumer manifest schema/validation (YAML/JSON), upsert/list/get/delete APIs, and bulk folder import `POST /api/v1/consumers/import` (defaults to project `consumers/`, supports provided directory). Validates all manifests before writing, persists transactionally, records `sourceFile`; CLI `npm run import:consumers`. Idempotent re-import supported.
- **Impact analysis:** matches consumers to provider operations via `METHOD +` canonical path and declared `sends`/`reads`, with ancestor/descendant field matching and `[]` normalization. Reports affected consumers/services and whether changes block publish. `NON_BREAKING` reports no affected consumers; `INTERNAL` excluded from external impact; newly required params/fields affect all callers as applicable. **Publish is blocked only when a `BREAKING` change affects a registered external consumer.**
- **Publish gate:** `POST /api/v1/specs/:id/publish` compares the candidate draft to the **latest published baseline** (`status='published'`, `revision < candidate`). Returns **201** (published) or **409** (blocked). Blocked specs remain **drafts** and can be re-attempted; a safe draft can publish against the published baseline. Baseline-less first publish is allowed. **Every publish attempt is recorded** with actor/note and compared changes.
- **Attempt history:** `GET /api/v1/services/:slug/attempts` returns recorded attempts (outcome, counts, actor/note, baseline/candidate, changes).
- **Changelog:** `GET /api/v1/services/:slug/changelog?from=&to=` generates a stable, human-readable changelog (entries/text/markdown) between versions (defaults to latest two). Public entries/markdown omit `INTERNAL` changes; summaries and affected consumers included.
- **Metrics:** `GET /api/v1/metrics` aggregates protection metrics from stored specs/attempts/changes/consumers (services/specs uploaded & by status, validation failure rate, publish attempts/published/blocked/success ratio, breaking & dangerous changes caught, affected consumers/impacted proposals, consumers/usages, breaking changes by service).
- **Database schema:** `services`, `spec_versions`, `consumers`, `consumer_endpoints`, `publish_attempts`, `attempt_changes` with indexes and foreign keys (`backend/src/db/schema.sql`, applied idempotently).

**Key API surface (v1)**
- Services: `POST/GET /api/v1/services`, `GET /api/v1/services/:serviceRef`, `POST /services/:serviceRef/specs`, `GET /services/:slug/diff`, `GET /services/:slug/changelog`, `GET /services/:slug/attempts`
- Specs: `GET /api/v1/specs/:id`, `GET /api/v1/specs/:id/impact`, `POST /api/v1/specs/:id/publish`
- Consumers: `POST /api/v1/consumers/import`, `POST/GET /api/v1/consumers`, `GET/DELETE /api/v1/consumers/:slug`
- Metrics/health: `GET /api/v1/metrics`, `GET /api/health`

## 2. Starter-kit data import & seeding

- **Seed script:** `backend/scripts/seed-starter-kit.js` (`npm run seed` / `npm run seed:starter`).
  - Ensures provider services `quote-api` (Quotes), `policy-api` (Policy), `claims-api` (Claims).
  - Imports original specs from `specs/<service>/` in publish order through the normal upload/validation path (drafts, dedupe/revision rules apply).
  - Imports original consumer manifests from `consumers/` via folder import.
  - Configurable via `DB_PATH`, `SPECS_DIR`, `CONSUMERS_DIR` or CLI args.
- **Verified against the original kit:** **11 specs uploaded, 0 duplicate, 1 rejected (of 12 attempted)**. `claims-api/2-channel-and-notes.yaml` rejected `[INVALID_SPEC]` (missing `$ref` `#/components/schemas/ClaimDocumnt`) and not stored; claims fixed/approval stored as revisions 2 and 3. **4 consumer manifests imported** (`mobile-app`, `notifications-svc`, `partner-portal`, `payments-svc`) with **10 endpoint usages**.

## 3. Docker integration

- **Backend image:** `backend/Dockerfile` (Node 20 bookworm-slim + build deps for `better-sqlite3`, prod deps, copies `backend/` and starter `specs/`/`consumers/` into the image). Env: `PORT=5000`, `DB_PATH=/data/contract-guard.db`, `SPECS_DIR=/app/specs`, `CONSUMERS_DIR=/app/consumers`. `backend/.dockerignore` added.
- **Frontend image:** `frontend/Dockerfile` (multi-stage: Node 20 Alpine build → Nginx Alpine serves `dist/`), `frontend/nginx.conf` (SPA fallback, `client_max_body_size 10m`, reverse-proxy `/api/` → `backend:5000`), `frontend/.dockerignore`.
- **Compose:** `docker-compose.yml` now defines `frontend` (`${FRONTEND_PORT:-3000}:80`, depends on backend), `backend` (`${BACKEND_PORT:-5000}:5000`, persistent `backend-data:/data`, read-only mounts of original `./specs` and `./consumers`), and `webhook-receiver` (`${WEBHOOK_PORT:-9900}:9000`).
- **Status:** `docker compose config` validates successfully. A full container runtime start was not executed in this environment because the Docker daemon was unavailable at the time; backend+SQLite startup was verified programmatically and the compose wiring/config is in place.

## 4. Frontend (React + Vite + Tailwind)

**Stack:** React 18, Vite 6, React Router 6, Tailwind CSS 3 (`frontend/`). All data is fetched from real backend APIs (no hardcoded examples).

**Implemented UI**
- **Layout/navigation:** responsive dashboard shell (Services, Consumers, Metrics).
- **Services:** list registered services with version/status/count summaries, register service, refresh, loading/error/empty states.
- **Service detail workflow:**
  - Upload OpenAPI spec (YAML/JSON) → stored as draft; shows upload result/warnings and validation errors.
  - API version history (revisions, status, timestamps) with per-draft **Impact vs baseline** and **Publish** actions.
  - Publish result handling for **201 (published)** and **409 (blocked)**: outcome, draft-retained-when-blocked, attempt info, severity/impact summary, and recorded changes.
  - Version comparison (from/to or latest-two): semantic diff, severity counts, consumer impact/blocking, and detailed change records (kind/location/field/param/status/before/after, reason, affected consumers).
  - Changelog (from/to or latest-two): public summary and markdown/entries (internal-only excluded from public view) with affected consumers.
  - Publish attempts history with recorded changes and impact.
- **Consumers:** list consumers and their usages (provider/operation/sends/reads/source), import from folder, loading/error/empty states.
- **Metrics:** protection metrics and breaking-changes-by-service views.
- **UX/ops:** loading spinners, error states with retry and backend detail messages, empty states, responsive layouts. `frontend/src/lib/api.js` normalizes errors and treats publish `409` as a handled result; Vite dev/preview proxies `/api` (`VITE_API_PROXY_TARGET`), and nginx proxies `/api` in Docker. **Frontend production build succeeds**.

## 5. Testing & verification

- **Automated backend tests:** `cd backend && npm test` → **70 tests, 70 passed, 0 failed**.
  - Suites include: `spec-upload`, `starter-files`, `compare-unit`, `diff-api`, `classify-unit`, `impact-unit`, `consumer-api`, `consumer-impact-rules`, `impact-acceptance`, `publish-api`, and `e2e-starter-workflow`.
  - `e2e-starter-workflow` exercises the complete workflow against the original `specs/` and `consumers/` (service registration, ordered spec import with invalid-claims rejection, consumer import, semantic diff/impact, safe vs blocked publishing with draft retention and attempts, changelog, and metrics).
- **End-to-end workflow (real kit data):** seeded demo DB from original files, ran backend and built frontend preview, and verified via the same real API flows the UI uses:
  - 3 services, 11 specs stored / 1 rejected, 4 consumers / 10 usages.
  - `quote-api 2→3` reported **breaking/blocked** impact (e.g. `premium.breakdown[].amount` removal affecting **mobile-app**, `blocksPublish`; internal `DELETE /internal/pricing-cache` `region` marked `INTERNAL` with no external consumer impact; potential status-enum impact reported).
  - Publishing: safe/baseline versions published (**201**), unsafe versions blocked (**409**) with specs remaining drafts and attempts recorded (including re-evaluation vs latest published baseline); policy `legacyCode` removal blocked affecting **payments-svc**; claims fixed/approval published.
  - Changelog, attempts, and metrics returned real, consistent data.
- **Compose validation:** `docker compose config` succeeds. Compose files/config and Dockerfiles are in place for frontend+backend+webhook+DB volume.

## 6. Current state / notes

- Core required flows are implemented and covered by passing tests using the company’s original starter specifications and consumer manifests.
- Runtime container bring-up (`docker compose up --build`) depends on a running Docker/Podman engine; not executed to completion in the constrained environment, but configuration/build definitions are validated/prepared.
- `PLAN.md`, `specs/`, and `consumers/` remain unchanged. Backend/frontend implementation artifacts (including Dockerfiles, compose updates, seed script, tests, and this report) were added.