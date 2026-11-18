# Design Document — Contract Guard

This document describes the architecture and main workflow of the Contract Guard implementation, the key design choices (with rationale and alternatives), technical trade-offs and limitations, and a real end-to-end example using the company’s starter-kit API specifications and consumer manifests. **`PLAN.md` and the original starter files (`specs/`, `consumers/`) are not modified.**

## 1. Architecture

### 1.1 System overview

Contract Guard is a small, cohesive system that registers provider services and their OpenAPI contracts, tracks consumer dependencies, computes semantic differences between spec versions, classifies risk, evaluates consumer impact, and gates publishing.

- **`backend/` (Node.js + Express 5 + SQLite)** — API, domain logic, persistence.
  - `src/routes/` — HTTP endpoints (services, specs, consumers, metrics, health).
  - `src/services/` — orchestration/use-cases (registry, spec upload, compare, consumer import, publish, changelog, metrics).
  - `src/domain/` — core logic: contract normalization (`openapi-contract.js`), semantic diff (`diff.js`), classification (`classify.js`), consumer impact (`impact.js`), changelog formatting (`changelog.js`).
  - `src/db/` — `better-sqlite3` connection and `schema.sql` (applied idempotently).
  - `src/middleware/`, `src/utils/` — error handling and typed app errors.
  - `scripts/` — `seed-starter-kit.js`, `import-consumers.js`.
- **`frontend/` (React 18 + Vite 6 + Tailwind CSS 3)** — SPA dashboard consuming `/api/v1/*` for listing, upload, comparison, impact, publishing, attempts, changelog, and metrics (loading/error/empty states, responsive UI).
- **`specs/`, `consumers/`** — original company starter-kit inputs (read-only in our usage; mounted/copied read-only for Docker/seed).
- **`webhook-receiver/`** — provided kit component (notification sink placeholder).
- **`docker-compose.yml`** — `frontend` (nginx serving SPA + proxying `/api`), `backend` (API + SQLite volume, read-only spec/consumer mounts), `webhook-receiver`.

### 1.2 Data model (SQLite)

| Table | Purpose |
|---|---|
| `services` | Provider APIs (slug, name, owner team). |
| `spec_versions` | Uploaded OpenAPI documents: declared version/revision, hash, format, raw/parsed content, status (`draft`/`published`/`rejected`), timestamps, uploader. Unique per `(service, spec_hash)` and `(service, declared_version, revision)`. |
| `consumers` | Consumer services/teams. |
| `consumer_endpoints` | Declared usages per consumer/provider operation: method, canonical path template, `sends`/`reads`, `source_file`. |
| `publish_attempts` | Every publish attempt: candidate/base, outcome (`published`/`blocked`), counts, actor/note, time. |
| `attempt_changes` | Snapshot of classified/impacted changes recorded for an attempt (severity, kind, location/field, reason, internal flag, before/after). |

Foreign keys and indexes support integrity and common queries (by service, status, outcome, attempt).

### 1.3 Component interaction (high level)

```text
Browser (React SPA)
   │  /api/* (Vite dev proxy or Nginx reverse proxy)
   ▼
Express API (routes) ──► Services (orchestration)
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
           Domain logic     SQLite DB     Starter kit files
     (normalize/diff/   (specs, consumers,  (specs/, consumers/,
      classify/impact/   attempts, metrics)   read-only inputs)
       changelog)
```

## 2. Main workflow

1. **Register provider service** — create a service record (slug/name/owner team).
2. **Register/import consumers** — load YAML/JSON manifests (folder import or API). Each usage declares provider, `METHOD + path`, and `sends`/`reads` fields. Manifests are validated against known services/operations shape before persistence.
3. **Upload specification** — submit OpenAPI 3.0.x (YAML/JSON). The backend parses/validates, dereferences (`$ref`, circular-safe), normalizes to a comparable contract, computes a content hash, deduplicates, assigns revision/version metadata, and stores the spec as a **draft** (invalid specs rejected with details).
4. **Compare & assess impact (on demand)** — select two versions (or defaults). The system normalizes both, computes a semantic diff, classifies each change, matches affected registered consumers (`sends`/`reads` vs changed request/response elements), and derives impact/blocking signals.
5. **Publish (gated)** — request publish for a draft:
   - Resolve **baseline** = latest **published** spec with `revision < candidate` (or none for first publish).
   - Recompute diff/classification/impact against baseline and record a **publish attempt** (always).
   - **Allow (201)** if no blocking consumer-breaking impact (or no baseline) → mark spec `published`.
   - **Block (409)** if any `BREAKING` change affects a registered external consumer → keep spec **draft** (re-attemptable) and return the impact report.
6. **Changelog & history** — generate changelog between versions (public view omits internal-only changes) and expose attempt history.
7. **Metrics** — aggregate upload/publish/impact outcomes for visibility into protection effectiveness.

**Seeded workflow:** `scripts/seed-starter-kit.js` automates steps 1–3/consumer import using the original kit files in order, surfacing validation rejections (e.g. the intentionally invalid claims spec) without mutating sources.

## 3. Major design approaches — rationale and alternatives

| Approach | Why chosen | Alternatives considered |
|---|---|---|
| **Semantic diff on a normalized internal contract** (dereference `$ref`, merge `allOf`, canonicalize paths, walk parameters/bodies/fields/status codes/content types, recursion-safe) | Contract compatibility is about behavior/shape, not text layout. Normalization avoids false positives from formatting, `$ref` structure, or path-param naming, and enables precise rule application (nested fields, enums, required/type/format). | **Raw/text or JSON diff** — noisy and semantically blind. **Off-the-shelf OpenAPI diff library** — faster to integrate, but custom logic gives exact control over the required rules (path-param rename neutrality, `[]`/ancestor field matching, internal-op handling, publish policy) and keeps behavior explicit/testable. |
| **Rule-based classification + separate consumer-impact stage + publish gate** (severity ≠ blocking; block only on `BREAKING` changes affecting registered external consumers; `INTERNAL` excluded) | Separates *API compatibility* from *actual consumer risk*, making decisions explainable and auditable (reasons, affected consumers, per-attempt records). Aligns with “safe to publish when no real consumer is broken” while still reporting potential/non-breaking/warnings. | **Block on any breaking change** — simpler/safer but can halt harmless releases. **Warn-only / manual approval** — higher delivery risk. **Telemetry/runtime-usage-based impact** — higher fidelity but requires instrumentation/data not present in the kit. |
| **Draft-until-published, immutable version records, baseline = latest published, and full attempt history** (blocked specs remain drafts and re-attemptable; every attempt stored) | Prevents unsafe specs from becoming “current”, preserves a stable published lineage, supports iteration after a block, and provides an audit trail/metrics. Re-evaluating against the latest published baseline avoids drifting comparisons. | **Auto-publish on upload** — no safety gate. **Reject-and-discard on block** — loses work/history. **Mutable “latest” record** — weak traceability. **Store only final outcomes** — loses visibility into blocked attempts. |
| **Embedded SQLite (`better-sqlite3`) with relational schema** | Zero external dependency, easy local/dev setup, ACID transactions (important for atomic imports/attempt recording), straightforward persistence via a Docker volume, and sufficient for a single-instance registry workload. | **PostgreSQL/MySQL** — better concurrency/multi-instance scaling but added operational complexity. **Document/file/JSON storage** — weaker integrity/querying for relations (versions, usages, attempts). **In-memory** — no durability. |
| **Declared consumer manifests (`sends`/`reads`, folder/API import)** matched by canonical operation and field paths | Explicit, reviewable dependency contracts; deterministic, explainable matching over the provided kit artifacts without needing runtime access. | **Runtime traffic/log/mesh analysis or code scanning** — broader and behavior-accurate but complex and unavailable here. **Coarse service-to-service dependency only** — cannot attribute field-level breakage. |
| **Monolithic backend API + SPA frontend; `/api` reverse proxy (Vite dev, Nginx in Docker)** | Keeps domain logic consistent in one place, simple deployment/topology, and avoids CORS/env coupling in production (same-origin `/api`). Frontend stays a thin, real-data view over the API. | **SSR/meta-framework or BFF** — extra complexity for this scope. **Microservices** — unnecessary decomposition. **Direct cross-origin API calls in prod** — more configuration/CORS surface. |
| **Idempotent seeding/import from original kit files (read-only mounts/copies)** | Reproducible demos/tests with the real company specs/consumers while preserving originals and supporting containerized runs. | **Manual DB seeding or mutating source files** — error-prone and non-reproducible. |

## 4. Technical trade-offs and limitations

- **Scalability & concurrency:** `better-sqlite3` is synchronous and single-node; write concurrency and horizontal scaling are limited (acceptable for this scope). WAL is used for file DBs; very high throughput or multi-instance deployment would favor a client-server RDBMS.
- **Comparison scope/fidelity:** normalization and a bounded schema walker cover common OpenAPI 3.0 structures (`$ref`, `allOf`, objects/arrays, primitives, params, responses), but advanced constructs (e.g. `oneOf`/`anyOf`/`discriminator` polymorphism, complex composition nuances, non-JSON content schemas, callbacks/links) are not fully modeled. Some changes are compared conservatively at coarser granularity.
- **On-the-fly evaluation vs stored diffs:** diff/impact can be recomputed from stored parsed specs and the *current* consumer registry (flexible), while publish attempts persist the evaluated snapshot. Recompute has cost on large specs; historical “what-if” views depend on recorded attempts or re-running comparisons.
- **Impact accuracy:** based on declared manifests (`sends`/`reads`), not runtime traffic—unregistered/unknown consumers are not protected, and declared fields may under/over-approximate real usage. Field matching is path-based with ancestor/descendant and `[]` normalization (pragmatic, but edge cases exist).
- **Spec support:** OpenAPI 3.0.x focus; validation is structural/spec-level (via parser) rather than full lint/style governance.
- **Security/operations:** no authentication/authorization/RBAC, rate limiting, or audit hardening beyond recorded attempts; webhook receiver integration is not wired as an active notification pipeline; no background job queue.
- **Frontend:** lightweight SPA without offline caching/optimistic conflict handling; relies on backend for correctness. E2E confidence is primarily from backend/API and workflow tests (automated browser-driver tooling was not available in the environment for screenshot-based UI automation).
- **Docker runtime verification:** compose and images/config are validated, but a live `docker compose up` run depends on an available container engine in the environment.

## 5. Real example — company starter-kit specifications

**Inputs (original, unchanged):** `specs/quote-api/{1-initial,2-reorganised,3-price-lines,4-ncb-and-taxes}.yaml`, `specs/policy-api/{1..4}.yaml`, `specs/claims-api/{1..4}.yaml`, and consumer manifests in `consumers/` (`mobile-app`, `notifications-svc`, `partner-portal`, `payments-svc`, 10 declared usages total).

### 5.1 Seed/import outcome
- Services registered: **quote-api (Quotes), policy-api (Policy), claims-api (Claims)**.
- Specs imported in publish order: **11 stored as drafts, 1 rejected**. `claims-api/2-channel-and-notes.yaml` is rejected (`422 INVALID_SPEC`) due to `Missing $ref ... "ClaimDocumnt"` and is not stored; the fixed spec becomes `claims-api` revision 2 (`v1.1.0`) and the approval spec revision 3 (`v2.0.0`).
- Consumers imported: **4 manifests / 10 endpoint usages** (e.g. `mobile-app` reads `premium.breakdown[].amount` and `status` from `quote-api`, `payments-svc` reads `legacyCode` from `policy-api`, `partner-portal` uses policy endorsements).

### 5.2 Quote API: semantic diff, impact, and gated publish (`2-reorganised` → `3-price-lines`)

Comparing `quote-api` `v1.1.0 r2` (draft) to `v2.0.0 r3` (candidate) yields breaking consumer impact and a **blocked** publish:

- **Breaking (consumer-affecting, blocks publish):** response field `premium.breakdown[].amount` removed from `POST /quotes` (201). **`mobile-app`** declares `reads: [premium.breakdown[].amount, ...]` for `POST /quotes`, so it is affected and this change sets `blocksPublish = true`.
- **Breaking (not consumer-attributed):** corresponding `premium.breakdown[].amount` removal on `GET /quotes/{id}` (200) reported as breaking; no registered consumer read matches it in the manifest, so it does not itself add a blocking consumer.
- **Potential:** response field `status` enum expanded (can return `EXPIRED`) on `POST /quotes` and `GET /quotes/{id}` — affects declared readers (`mobile-app`, and `notifications-svc` for GET) as potentially breaking (exhaustive handling risk) but not treated as a blocking `BREAKING` change.
- **Non-breaking:** `premium.breakdown[].value` added on responses.
- **Internal-only:** required query parameter `region` added to `DELETE /internal/pricing-cache` — classified **`INTERNAL`** (operation marked internal-only), excluded from external/public consumer impact and does not block publish.
- **Aggregate impact:** blocked, with affected consumers including **mobile-app** and **notifications-svc**; internal change reported separately.

**Publish behavior:**
- `quote-api v1.0.0` and `v1.1.0` publish successfully (**201**, `published`).
- Publishing `v2.0.0 r3` is **blocked (409)**: outcome `blocked`, spec remains `draft` (not published), impact and affected consumers returned, and the attempt is recorded.
- Publishing `v2.1.0 r4` (ncb-and-taxes) while `v2.0.0` is still draft is evaluated against the **latest published baseline** (`v1.1.0 r2`), so it is also **blocked (409)** because the breaking `premium.breakdown[].amount` removal (relative to the published contract) still affects consumers. A later safe candidate relative to the published baseline can publish.
- Attempt history and metrics reflect all attempts (including blocked) and their recorded changes/impact.

**Changelog (`2→3`):** public changelog lists the breaking/potential/non-breaking entries with reasons and affected consumers (e.g. notes that `POST /quotes` amount removal affects `mobile-app`); internal-only operation changes are omitted from public entries/markdown while retained in overall accounting as applicable.

### 5.3 Policy API and Claims API highlights

- **`policy-api 1.1.0 → 2.0.0` (`2-deprecations` → `3-remove-old-fields`):** removal of deprecated `legacyCode` (and `holder.phone`) is breaking; **`payments-svc`** reads `legacyCode` from `GET /policies/{policyId}` (`payments-svc.yaml`), so the change affects **payments-svc** and publish is **blocked (409)**.
- **`policy-api 2.0.0 → 2.1.0` (`3-remove-old-fields` → `4-endorsement-rules`):** endorsement-rule changes affect **`partner-portal`**; when evaluated against the latest published baseline (`v1.1.0`), accumulated breaking removals (e.g. `legacyCode` affecting `payments-svc`) and endorsement changes can both contribute to blocking/impact.
- **`claims-api`:** version 2 is invalid and rejected at upload (as above); `1.0.0 → 1.1.0` is additive (no blocking consumer impact) and `1.1.0 → 2.0.0` introduces potentially breaking changes (e.g. for `mobile-app`) but not a blocking `BREAKING`+affected-consumer case in this flow, so the valid versions can publish (**201**) through the gate.

These behaviors were verified against the original starter-kit files via automated tests (70/70 passing, including end-to-end workflow coverage) and by exercising the running backend/frontend against a seeded demo database.