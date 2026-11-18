# Contract Guard

Contract Guard is an API contract registry and publish gate built against the included starter kit. It lets teams register provider services, upload and version OpenAPI specifications, compare versions semantically, classify changes, evaluate real consumer impact, block unsafe publishes, review publish attempts/changelogs, and track protection metrics through an API and dashboard UI.

> **Starter-kit rules:** `PLAN.md` and the original starter files in `specs/` and `consumers/` are not modified. Evaluators can test against the original kit; copy files elsewhere if you want to experiment.

For implementation status and design details, see [`progress.md`](./progress.md) and [`design.md`](./design.md).

## What is implemented

- **Service & spec registry (backend, Node.js + Express 5 + SQLite):** register/list provider services; upload OpenAPI 3.0.x specs (YAML/JSON), validate/parse/dereference, normalize, deduplicate by content hash, version/revision tracking, and store uploads as **drafts** by default. Invalid/unsupported specs are rejected with structured errors.
- **Semantic diff & classification:** compare versions by `METHOD +` canonical path (path-parameter name differences are not treated as contract changes), covering parameters, request/response bodies, nested fields, required/nullable/type/format/enum, status codes/content types, deprecations and `x-sunset`. Each change is classified as `BREAKING`, `POTENTIAL`, `NON_BREAKING`, `WARNING`, or `INTERNAL` (internal-only operations, e.g. `x-internal`, are excluded from external/public consumer impact) with a human-readable reason.
- **Consumer registry & impact analysis:** register/import consumer manifests (YAML/JSON) declaring `provider/method/path` and `sends`/`reads`; bulk folder import with validation/transactional persistence; match consumers to changed operations/fields (including ancestor/descendant and `[]` normalization) and report affected consumers. **Publishing is blocked only when a `BREAKING` change affects a registered external consumer.**
- **Publish gate & history:** `POST /api/v1/specs/:id/publish` compares a draft against the **latest published baseline**. Returns **201** when published or **409** when blocked; blocked specs remain **drafts** and can be re-attempted. **Every publish attempt is recorded** (actor/note, outcome, counts, compared changes).
- **Changelog & metrics:** generate changelogs between versions (public view omits internal-only entries) and expose protection metrics (uploads/statuses, attempts/outcomes, breaking/dangerous changes caught, affected consumers, coverage, etc.).
- **Frontend dashboard (React + Vite + Tailwind):** uses real backend APIs (no hardcoded data) for service listing/registration, spec upload, version history, version comparison, breaking-change details, consumer impact analysis, publish controls/results (including blocked drafts), changelog, publish attempts, consumers, and metrics with loading/error/empty states and responsive layout.
- **Starter-kit seeding:** import original `specs/` and `consumers/` through the normal validation/upload/import paths.

## Project structure

- `backend/` — Express API, domain logic, SQLite schema/DB, scripts, and tests
  - `src/routes`, `src/services`, `src/domain`, `src/db`, `src/middleware`, `src/utils`
  - `scripts/seed-starter-kit.js`, `scripts/import-consumers.js`
- `frontend/` — React dashboard (Vite + Tailwind), Nginx config for Docker
- `specs/` — original company OpenAPI specifications (**do not modify**)
- `consumers/` — original consumer manifests (**do not modify**)
- `webhook-receiver/` — provided webhook receiver
- `docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`
- `progress.md`, `design.md` — implementation progress and architecture/design notes

## Quick start (Docker / Podman)

From the repository root:

- **Docker:** `docker compose up --build`
- **Podman:** `podman compose up --build` (requires `podman compose` or `podman-compose`)

Services and default ports:

| Service | URL / Port | Notes |
| --- | --- | --- |
| Frontend dashboard | http://localhost:3000 | Nginx serves the SPA and proxies `/api` to the backend (`FRONTEND_PORT` to override) |
| Backend API | http://localhost:5000 | Express + SQLite (`BACKEND_PORT` to override) |
| Webhook receiver | http://localhost:9900 | Provided kit receiver (`WEBHOOK_PORT` to override, e.g. `WEBHOOK_PORT=9950 docker compose up --build`) |

Compose also creates a persistent SQLite volume (`backend-data`) and mounts the original `./specs` and `./consumers` into the backend container read-only for import/seeding.

### Seed/import the original starter-kit data (Docker)

With the stack running, you can seed services, specs, and consumers from the mounted kit files:

```bash
docker compose exec backend node scripts/seed-starter-kit.js
```

(You can also import consumers via the API/UI after services/specs are available: `POST /api/v1/consumers/import`.)

## Local development

### Prerequisites
- Node.js (LTS recommended) and npm
- (Optional) Docker/Podman for containerized runs

### Backend

```bash
cd backend
npm install
npm start          # starts API (default PORT=5000)
# or
npm run dev        # nodemon
```

- Default DB: `backend/data/contract-guard.db` (override with `DB_PATH`).
- Health check: `GET /api/health`.
- Environment: `PORT`, `DB_PATH` (see `backend/src/config.js`, `.env` supported).

**Seed the starter kit (local):**

```bash
cd backend
npm run seed
# equivalent: node scripts/seed-starter-kit.js [specsDir] [consumersDir]
# env: DB_PATH, SPECS_DIR, CONSUMERS_DIR
```

This registers `quote-api` (Quotes), `policy-api` (Policy), `claims-api` (Claims), imports specs from `specs/<service>/` in order through the normal validation/upload path, and imports consumer manifests from `consumers/`. With the original kit this yields **11 specs uploaded and 1 rejected** (`claims-api/2-channel-and-notes.yaml`, missing `$ref` `#/components/schemas/ClaimDocumnt`, not stored) and **4 consumer manifests / 10 endpoint usages** imported.

**Import consumers only:** `npm run import:consumers` (or `POST /api/v1/consumers/import`).

### Frontend

```bash
cd frontend
npm install
npm run dev        # Vite dev server (proxies /api to http://localhost:5000 by default)
npm run build      # production build
npm run preview    # preview built app
```

- Set `VITE_API_PROXY_TARGET` to point the dev/preview proxy at a different backend if needed.
- In Docker, the frontend is built and served by Nginx, which proxies `/api` to the `backend` service.

## API overview

Base URL: `http://localhost:5000` (local default)

- **Health:** `GET /api/health`
- **Services:** `POST /api/v1/services`, `GET /api/v1/services`, `GET /api/v1/services/:serviceRef`
- **Specs (upload/list context):** `POST /api/v1/services/:serviceRef/specs`
- **Comparison:** `GET /api/v1/services/:slug/diff?from=&to=` (defaults to latest two when omitted, per implementation)
- **Publish & impact:** `POST /api/v1/specs/:id/publish` (body: `{ "actor", "note" }` optional), `GET /api/v1/specs/:id/impact`, `GET /api/v1/specs/:id`
- **Attempts & changelog:** `GET /api/v1/services/:slug/attempts`, `GET /api/v1/services/:slug/changelog?from=&to=`
- **Consumers:** `POST /api/v1/consumers/import`, `POST /api/v1/consumers`, `GET /api/v1/consumers`, `GET /api/v1/consumers/:slug`, `DELETE /api/v1/consumers/:slug`
- **Metrics:** `GET /api/v1/metrics`

Notes: spec uploads are stored as drafts until published by the gate; blocked publishes return **409** with the impact report while keeping the spec draft and recording the attempt.

## Starter-kit data (original files)

### API specifications: `specs/`

Three provider services, each with four OpenAPI 3.0.3 specification versions, numbered in intended publish order:

| Service | Owner | Files |
| --- | --- | --- |
| `quote-api` | Quotes team | `specs/quote-api/1-initial.yaml` … `4-ncb-and-taxes.yaml` |
| `policy-api` | Policy team | `specs/policy-api/1-initial.yaml` … `4-endorsement-rules.yaml` |
| `claims-api` | Claims team | `specs/claims-api/1-initial.yaml` … `4-approval-later.yaml` |

- Version numbers are in `info.version`.
- Specifications reuse components via `$ref` (intra-file references).
- Some specs include extensions such as `x-internal` and `x-sunset`, and some versions contain issues Contract Guard is expected to catch (e.g. the invalid `claims-api/2-channel-and-notes.yaml`).

### Consumers: `consumers/`

One YAML manifest per consuming service: `mobile-app`, `partner-portal`, `payments-svc`, `notifications-svc`. Each declares operations used and the fields sent/read:

```yaml
consumer: mobile-app
team: Mobile
uses:
  - provider: quote-api
    method: POST
    path: /quotes
    sends: [vehicle.make, vehicle.cc, rider.age]
    reads: [quoteId, premium.breakdown[].amount]
```

Field paths use dots for nesting and `[]` for list items. Consumer files reflect usage at the time written and may lag behind spec evolution.

### Webhook receiver

The provided webhook receiver (`webhook-receiver/`) can be run via Compose at http://localhost:9900. It stands in for chat/email sinks: anything POSTed to it appears on its page, `GET /api/received` returns the list as JSON, and `DELETE /api/received` clears it.

## Testing

From `backend/`:

```bash
npm test
```

Runs the backend test suite (`node --test`), including spec upload/validation, diff/classification/impact (unit and acceptance against starter kit), consumer import/rules, publish/changelog/attempt/metrics, and end-to-end workflow coverage against the original `specs/` and `consumers/`. **Current status: 70 tests passing.**

Frontend production build: `cd frontend && npm run build`.

## Documentation

- [`progress.md`](./progress.md) — what has been implemented and verified
- [`design.md`](./design.md) — architecture, main workflow, design rationale/alternatives, trade-offs/limitations, and a real starter-kit example
- `PLAN.md` — original problem/plan reference (**not modified**)
