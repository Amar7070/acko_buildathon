# Contract Guard — Plan

**Goal:** build an API contract registry that tells teams exactly what changed between two
versions of an OpenAPI spec, which consuming services would break, and blocks unsafe
publishing.

**Build order: backend first.** The UI is deliberately left until the registry, diff,
impact and publish gate work through the API.

---

## 1. Problem in my words

Today an API owner can rename a field, add a required parameter or delete an endpoint
without knowing who calls it. The change ships, a consuming service breaks in production,
and nobody can say what changed, who is affected, or who approved it.

**Users and what they need**

| User | Needs |
| --- | --- |
| API owner (Quotes, Policy, Claims teams) | Register a service, upload spec versions, see what changed, publish safely |
| Consumer-team engineer (Mobile, Payments, Notifications, Partners) | Register what their service sends and reads, see whether a proposed version affects them |
| Platform lead | See a history of risky changes, blocked publishes and protection metrics |

**Outcome that matters:** a dangerous change cannot reach production unnoticed. A safe
change still ships quickly. Every publish attempt and its outcome is explainable later.

---

## 2. Scope

### Must-haves (all in scope)

1. Service + spec registry with owners; upload YAML/JSON through the API (and later UI).
2. Validation that rejects malformed or invalid OpenAPI 3.0.x specs with clear errors.
3. `$ref` resolution and semantic comparison — component renames and re-organisation must
   not create fake changes.
4. Diff of endpoints, methods, parameters, request/response fields (nested objects and
   arrays), types, required flags, enums and response status codes.
5. Direction-aware classification with a plain-English reason for every change.
6. Consumer registration: provider, method, path, fields sent, fields read.
7. Impact report: which consumers a proposed version affects, and through which changes.
8. Publish gate: block a version when it has breaking changes that hit registered consumers.
9. Changelog between any two versions + history of every publish attempt and outcome.
10. Metrics endpoint, seed/import of the starter kit, and one-command startup.
11. UI: services, versions, diff/impact, publish result, history, metrics.

### Explicitly out of scope for the MVP

| Left out | Why |
| --- | --- |
| Login / SSO / RBAC | Six-hour build; record an `actor` name on uploads and publish attempts instead |
| Live traffic analysis | The kit gives consumer manifests, not traffic; use those as the source of truth |
| OpenAPI 3.1 and Swagger 2 | The kit is 3.0.3; support 3.0.x and reject the rest clearly |
| AI migration guides | Stretch idea only; must-haves and correctness come first |
| Enforcing semver rules | Kits contain two `claims-api` specs with the same declared version; track revisions instead |
| Editing specs in the product | Contract Guard is a registry, not an editor |

**Stretch, only after the gate:** webhook notifications, CI check endpoint, migration hints.

---

## 3. Product-owner questions and working assumptions

The brief says to ask; these are the decisions I need confirmed. Until then the listed
assumption is what the backend will implement.

| Question | Working assumption for v1 |
| --- | --- |
| Does a breaking change block publishing when no registered consumer uses it? | No. Publish with a warning. Blocking needs both a breaking change and at least one affected consumer. |
| Can someone force-publish a blocked version? | No override in the MVP. The attempt is recorded as blocked. If needed later: explicit approver + reason. |
| What does `x-internal: true` mean? | Internal-only operation. Still diffed and marked `internal`, but never counted as public impact and not shown in the public changelog. |
| What do `deprecated` and `x-sunset` mean? | Warning only; show the sunset date; do not block. |
| Is a response field becoming optional breaking? | Potentially breaking. Report it and mark affected readers, but do not block by default. |
| How are enum changes treated? | Request: removing a value is breaking, adding is safe. Response: adding a value is potentially breaking for exhaustive clients, removing is safe. |
| Can `info.version` repeat? | Yes. Store a per-service revision number as well as the declared version; warn on a repeated declared version with different content. |
| Should affected teams be notified? | Useful stretch: POST to the kit's webhook receiver after a blocked or successful publish. Never let a webhook failure block publishing. |
| Who is the actor? | No auth; accept `uploadedBy` / `actor`, default to `system`. |

---

## 4. Short research notes

- **oasdiff / openapi-diff:** the useful idea is a rule table that considers request vs
  response direction; a generic "type changed" warning is not enough. We will implement
  our own rules so every result has an explainable reason.
- **Bump.sh / SwaggerHub:** version timelines, changelogs and a service detail page are
  the right information architecture. We do not need accounts or hosted docs.
- **Optic:** captures real traffic to infer usage. We have no traffic, so consumer YAML
  manifests are our usage source.
- **Spectral:** specs should be linted before comparison. We reuse the validation step
  but keep errors focused on things that stop a comparison.

No code is copied; these only inform the design.

---

## 5. System architecture

### Stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js 22 | Same ecosystem as the starter backend |
| HTTP | Express 5 | Already in the starter kit |
| Database | SQLite via `better-sqlite3` | Relational, transactional, one file, no extra service to run |
| Spec parsing | `yaml` + `@apidevtools/swagger-parser` | Parse YAML/JSON, validate OpenAPI 3.0.x, resolve `$ref` |
| Validation | `zod` | Validate our own request bodies and route params |
| Tests | Vitest + Supertest | Fast unit tests and HTTP integration tests |
| UI (later) | React + Vite | Simple screens against the JSON API |

SQLite is a deliberate trade-off: it makes `docker compose up --build` reliable and keeps
the demo self-contained. The schema stays portable if we later move to Postgres.

### Component diagram

```text
                    +----------------------+
                    |  React UI (phase 6)  |
                    +----------+-----------+
                               | HTTP/JSON
+------------------------------v---------------------------------------+
|                        Express API (backend)                        |
|                                                                     |
|  Registry        Spec pipeline        Comparison        Publishing  |
|  services   -->  parse               normalize     -->  gate       |
|  specs           validate            diff               attempts   |
|  consumers       dereference         classify           changelog  |
|                  store contract      impact             metrics    |
|                                                                     |
+-------------------------------+-------------------------------------+
                                |
                    +-----------v-----------+
                    | SQLite (one file)     |
                    | data/contract-guard.db|
                    +-----------------------+

Seed script reads ../specs and ../consumers (read-only) and calls the same services.
Optional notifier POSTs to the kit's webhook receiver.
```

### Backend folder structure

```text
backend/
  src/
    app.js                 # createApp(db) - export for tests, no listen
    server.js              # loads config and listens
    config.js
    db/
      index.js             # open DB, WAL, foreign keys
      schema.sql           # tables + indexes
      seed.js              # import the three services, 12 specs, 4 consumers
    routes/                # services, specs, consumers, diffs, metrics
    controllers/           # thin HTTP <-> service mapping
    middleware/            # error handler, request validation
    domain/
      contract.js          # normalized contract model
      flatten.js           # schema tree -> field paths
      diff.js              # semantic change detection
      classify.js          # rule table
      impact.js            # consumer matching
    services/
      registry.service.js
      spec.service.js      # upload/validate/normalize
      compare.service.js   # diff + classify + impact orchestration
      publish.service.js   # gate, attempts, changelog
      metrics.service.js
      notify.service.js    # optional
  tests/
    unit/ integration/ acceptance/ fixtures/
  package.json
```

The starter's `backend/app.js` currently duplicates what should be `src/app.js`, and the
`dev`/`start` scripts point at a file that does not exist. Phase 0 fixes that. `createApp`
takes a database handle so integration tests can use an in-memory database.

### Core data flow

1. **Upload:** parse -> validate -> dereference -> normalize to a contract JSON -> store as
   a `draft` (or store a `rejected` row with validation errors if invalid).
2. **Compare:** diff candidate against the latest published version -> classify each change
   -> match consumers -> return changes + impact (preview does not persist).
3. **Publish:** rerun compare -> if any `BREAKING` change has at least one affected consumer,
   return `409` and persist a blocked attempt; otherwise mark the spec published and persist
   the successful attempt and its changes.
4. **Changelog/history:** changelog is computed on demand between any two stored specs;
   publish history comes from the attempt tables.
5. **Metrics:** aggregate uploads, blocks, dangerous changes caught and affected consumers.

### Semantic normalization rules

Comparison happens on the *behaviour* of the API, not the file layout.

- Resolve every `$ref`; traverse with a cycle guard so recursive schemas do not loop.
- Ignore component/schema names, `$ref` vs inline layout, property order, descriptions,
  examples, summaries and tags for behaviour changes.
- Canonical path template: `/quotes/{id}` and `/quotes/{quoteId}` become `/quotes/{}`.
  Path parameters are matched by position and compared on type/required, not name.
- Query/header/cookie parameters are matched by name and location.
- Flatten each request/response body into field paths:
  `premium.breakdown[].amount`, `holder.email`. `[]` marks array items.
- Keep per-field: type, format, required (relative to its parent), nullable, enum,
  min/max, and array item type.
- Preserve `x-internal`, `deprecated` and `x-sunset` on operations and fields.

### Diff + classification rules

`BREAKING` can block a publish. `POTENTIAL` is shown but does not block. `INTERNAL` is
excluded from public impact. `NON_BREAKING` and `WARNING` are informational.

| Area | Change | Classification |
| --- | --- | --- |
| Endpoint | Removed | `BREAKING` |
| Endpoint | Added | `NON_BREAKING` |
| Path parameter | Renamed, same position/type | `NON_BREAKING` (normalized away) |
| Parameter | Required added | `BREAKING` |
| Parameter | Removed | `POTENTIAL` |
| Parameter | Type/format changed or enum narrowed | `BREAKING` |
| Request field | Added and required | `BREAKING` |
| Request field | Added and optional | `NON_BREAKING` |
| Request field | Removed | `POTENTIAL` |
| Request field | Became required, type changed, nullable tightened, enum narrowed, constraint tightened | `BREAKING` |
| Request field | Became optional, enum widened, constraint relaxed | `NON_BREAKING` |
| Response field | Removed | `BREAKING` |
| Response field | Added | `NON_BREAKING` |
| Response field | Required -> optional | `POTENTIAL` |
| Response field | Optional -> required | `NON_BREAKING` |
| Response field | Type changed | `BREAKING` |
| Response enum | Value added | `POTENTIAL` |
| Response enum | Value removed | `NON_BREAKING` |
| Response status | Code removed | `BREAKING` |
| Response status | Code added | `NON_BREAKING` |
| Metadata | `deprecated` / `x-sunset` added or changed | `WARNING` |
| Any change on an `x-internal` operation | — | `INTERNAL` |

Every change gets a reason string, for example:
`Response field premium.breakdown[].amount was removed and mobile-app reads it.`

### Consumer impact matching

- Match operations by `METHOD + canonical path`. A removed endpoint affects every consumer
  of that operation.
- **Request change:** affected if a consumer sends the exact path, an ancestor or a
  descendant. A newly required request field or a new required parameter affects every
  consumer of the operation, because all callers must now send it.
- **Response change:** affected if a consumer reads the exact path, an ancestor or a
  descendant. Removing a response status affects every consumer of that operation.
- **Parameter change:** query/header parameters match names in `sends`; a required
  parameter being added affects all callers. Path params match by position.
- Do not match changes on `x-internal` operations to external consumers.
- `[]` is just another path segment, so `premium` matches
  `premium.breakdown[].amount`, and vice versa.
- Consumers are assumed to use the latest published version. Version pinning per consumer
  is out of scope; the model can add it later.

### Publish policy

```
block if exists(change.severity == BREAKING
                and change.isInternal == false
                and affectedConsumers(change).length > 0)
```

A blocked candidate stays a draft, remains visible with its impact report, and may be
published again after consumers change. Every attempt is stored, successful or blocked.

---

## 6. API surface (backend contract)

All routes use `/api/v1`; `/api/health` stays as the starter's health check.

| Method + path | Purpose |
| --- | --- |
| `GET /api/health` | Liveness |
| `POST /api/v1/services` | Register service + owner |
| `GET /api/v1/services` | List services with latest published version and counts |
| `GET /api/v1/services/:slug` | Service detail + versions |
| `POST /api/v1/services/:slug/specs` | Upload spec as JSON `{content, uploadedBy}` or raw YAML/JSON body |
| `GET /api/v1/services/:slug/specs` | Version/revision list, including rejected rows |
| `GET /api/v1/specs/:id` | Spec metadata |
| `GET /api/v1/specs/:id/contract` | Normalized contract |
| `GET /api/v1/services/:slug/diff?from=&to=` | Semantic diff, defaults to latest published -> latest draft |
| `GET /api/v1/specs/:id/impact` | Impact against latest published version |
| `POST /api/v1/specs/:id/publish` | Run the gate; `201` published or `409` blocked, both with a report |
| `GET /api/v1/services/:slug/changelog?from=&to=` | Human-readable changelog |
| `GET /api/v1/services/:slug/attempts` | Publish history |
| `POST /api/v1/consumers` | Register a consumer with its `uses` entries (JSON or YAML) |
| `GET /api/v1/consumers` | Consumers and their usages |
| `GET /api/v1/metrics` | Protection metrics |
| `POST /api/v1/ci/check` | Stretch: body is a proposed spec; returns pass/fail without storing |

Consistent error shape:

```json
{ "error": { "code": "INVALID_SPEC", "message": "...", "details": [{ "path": "...", "message": "..." }] } }
```

Upload accepts raw YAML/JSON (`Content-Type: application/yaml` etc.) or a JSON envelope
with `content`. The UI can read the file as text; no multipart parser is needed.

---

## 7. Database design

SQLite, foreign keys on, WAL mode. Schema lives in `src/db/schema.sql`; startup applies it
idempotently. IDs are integer primary keys; services and consumers also have a unique slug.

```text
services 1 ──── * spec_versions
services 1 ──── * consumer_endpoints * ──── 1 consumers
services 1 ──── * publish_attempts 1 ──── * attempt_changes
spec_versions 1 ──── * publish_attempts (candidate_spec_id, base_spec_id)
```

### `services`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `slug` | TEXT UNIQUE | `quote-api`, `policy-api`, `claims-api` |
| `name` | TEXT | Display name |
| `owner_team` | TEXT | Quotes / Policy / Claims |
| `description` | TEXT | |
| `created_at` | TEXT | ISO timestamp |

### `spec_versions`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | Internal identity used for diffing |
| `service_id` | FK services | |
| `declared_version` | TEXT | `info.version` |
| `revision` | INTEGER | Per-service sequence; handles repeated `info.version` |
| `spec_hash` | TEXT | SHA-256 of raw content |
| `source_format` | TEXT | `yaml` or `json` |
| `raw_spec` | TEXT | Original upload |
| `contract_json` | TEXT | Normalized contract, null when rejected |
| `status` | TEXT | `draft`, `published`, `rejected` |
| `validation_errors_json` | TEXT | Populated for rejected rows |
| `uploaded_by` | TEXT | |
| `created_at` | TEXT | |
| `published_at` | TEXT | |

Constraints: `UNIQUE(service_id, spec_hash)` (dedupe uploads),
`UNIQUE(service_id, declared_version, revision)`. Index on
`(service_id, status, created_at)`.

### `consumers`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `slug` | TEXT UNIQUE | `mobile-app` |
| `name` | TEXT | |
| `team` | TEXT | |
| `created_at` | TEXT | |

### `consumer_endpoints`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `consumer_id` | FK consumers | |
| `service_id` | FK services | Provider |
| `method` | TEXT | Upper-case |
| `path_template` | TEXT | Canonical path, `/quotes/{}` |
| `raw_path` | TEXT | Original `/quotes/{id}` |
| `sends_json` | TEXT | JSON array of field/parameter paths |
| `reads_json` | TEXT | JSON array of field paths |
| `source_file` | TEXT | Import traceability |

Index on `(service_id, method, path_template)`.

### `publish_attempts`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `service_id` | FK services | |
| `candidate_spec_id` | FK spec_versions | The proposed version |
| `base_spec_id` | FK spec_versions, nullable | Latest published at the time |
| `outcome` | TEXT | `published` or `blocked` |
| `breaking_count` | INTEGER | |
| `potential_count` | INTEGER | |
| `affected_consumer_count` | INTEGER | |
| `actor` | TEXT | |
| `note` | TEXT | |
| `created_at` | TEXT | |

### `attempt_changes`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `attempt_id` | FK publish_attempts | |
| `change_key` | TEXT | Stable identity for the change |
| `method` | TEXT | |
| `path` | TEXT | Canonical endpoint |
| `location` | TEXT | `endpoint`, `parameter`, `request`, `response` |
| `field_path` | TEXT | `premium.breakdown[].amount` or null |
| `kind` | TEXT | `removed`, `added`, `required_changed`, `type_changed`, `enum_changed`, `status_added`, ... |
| `direction` | TEXT | `request`, `response`, `parameter`, `endpoint`, `metadata` |
| `severity` | TEXT | `BREAKING`, `POTENTIAL`, `NON_BREAKING`, `INTERNAL`, `WARNING` |
| `reason` | TEXT | Plain English |
| `is_internal` | INTEGER | 0/1 |
| `before_json` | TEXT | |
| `after_json` | TEXT | |

Index on `(attempt_id, severity)`.

### Optional `notifications`

`id`, `attempt_id`, `event`, `target_url`, `payload_json`, `status_code`, `created_at`.
Only added if the webhook stretch is implemented; webhook failures are logged, never fatal.

Why store diffs only on publish attempts: changelogs and previews are deterministic from
the stored normalized contracts. Persisting every preview would add noise without value.
Publish attempts are the audit trail that metrics and history need.

---

## 8. Testing plan

### Unit tests

- Parsing: valid YAML, valid JSON, malformed YAML, non-3.0 spec, unresolved `$ref`.
- Normalization: `$ref` renames/inlining produce no change; path parameter rename produces
  no change; nested objects/arrays flatten correctly; required is relative to parent.
- Diff rules: one small inline spec pair per rule in the classification table, including
  enum direction, status codes, required changes, constraints and `x-internal`.
- Impact matcher: exact path, ancestor, descendant, `[]`, path-param position, removed
  endpoint, newly required field affecting all callers, internal operation exclusion.
- Changelog formatter: stable ordering and readable sentences.
- Metrics calculations.

### Integration tests

Use Supertest against `createApp(testDb)` with an in-memory SQLite database.

- Register a service; upload a valid spec; upload an invalid spec -> `422` with details and
  a `rejected` row.
- Duplicate upload (`spec_hash`) -> `409`; same declared version with new content -> new
  revision and a warning.
- Upload -> diff -> impact -> blocked publish -> attempt recorded -> metrics change.
- Safe publish -> `published` row, attempt history, changelog between two versions.
- Register consumers from YAML; unknown provider -> `422`.
- Baseline publish with no previous version succeeds.
- Raw YAML body and JSON envelope both work.

### Acceptance / fixture tests against the real kit

Read the original `specs/` and `consumers/` files; never modify them.

| Comparison | Expected result |
| --- | --- |
| `quote-api` 1 -> 2 | No behavioural changes: schema renames, inlining and `id` -> `quoteId` are normalized away |
| `quote-api` 2 -> 3 | `BREAKING` response field rename `premium.breakdown[].amount` -> `value`; affects `mobile-app`. Status enum `+EXPIRED` is `POTENTIAL`. Internal `region` parameter stays `INTERNAL` |
| `quote-api` 3 -> 4 | `NON_BREAKING`: optional `rider.ncbPercent` with bounds, additive `premium.taxes` |
| `policy-api` 1 -> 2 | `WARNING` only: deprecations and sunset dates, publish allowed |
| `policy-api` 2 -> 3 | `BREAKING`: `legacyCode` removed (read by `payments-svc`), `holder.phone` removed (no reader). Publish blocked because of `payments-svc` |
| `policy-api` 3 -> 4 | `BREAKING`: request enum loses `VEHICLE` and required `requestedBy` is added; affects `partner-portal` |
| `claims-api` 1 -> 2 | Rejected: `ClaimDocumnt` is not a valid `$ref` |
| `claims-api` 1 -> 3 | `NON_BREAKING`: optional `channel` and `assessorNotes` added |
| `claims-api` 3 -> 4 | `POTENTIAL`: `amountApproved` is no longer required (read by `mobile-app`); added `202` response is additive |
| `claims-api` 1.1.0 twice | Two revisions accepted and distinguishable; no false duplicate-version error |

Full acceptance script:

1. Seed quote/policy/claims services, their first specs, and all four consumers.
2. Publish quote 2.0.0 draft -> blocked with `mobile-app` in impact.
3. Publish policy 2.0.0 -> blocked with `payments-svc`.
4. Publish claims 1.1.0 (bad ref) -> rejected at upload.
5. Publish safe quote 2.1.0 -> allowed.
6. Assert attempt history, changelog and metrics contain the expected counts.

### Commands and coverage

- `npm test` — unit + integration.
- `npm run test:acceptance` — fixture scenarios.
- `npm run seed` — import the starter kit.
- Target: ~70%+ statements in `src/domain` and `src/services`; every classification rule
  and every acceptance fixture must have a test.

---

## 9. Metrics

Exposed at `GET /api/v1/metrics` and shown on the dashboard later.

| Metric | How it is calculated |
| --- | --- |
| Services registered | Count of `services` |
| Specs uploaded / published / rejected | Counts by `spec_versions.status` |
| Validation failure rate | Rejected / all uploads |
| Publish attempts | Count of `publish_attempts` |
| Blocked publishes | Attempts with `outcome = blocked` |
| Dangerous changes caught | Sum of `breaking_count` on blocked attempts |
| Proposed versions with consumer impact | Attempts with `affected_consumer_count > 0` |
| Consumers registered / usages registered | Counts |
| Breaking changes by service | Group `attempt_changes` by service |
| Publish success ratio | Published / all attempts |

These show protection, not vanity traffic: how many unsafe changes were stopped and how
many teams were spared a production break.

---

## 10. Development steps — backend first

Timeboxes assume the six-hour build-day schedule; the order matters more than the clock.
Do not start the UI until milestones M1–M4 work from `curl`/tests.

| Phase | Time | Work | Done when |
| --- | --- | --- | --- |
| 0. Setup | 0:00–0:20 | Fix scripts; add deps; `createApp`/`server`; DB schema + migrations; error middleware; health | `npm run dev`, `npm test`, and an empty DB start cleanly |
| 1. Registry + ingestion | 0:20–1:20 | Services CRUD, spec upload, YAML/JSON parse, validation, deref, store draft/rejected, hash/revision rules | **M1:** a valid spec uploads and an invalid one returns clear `422` details |
| 2. Normalization + diff | 1:20–2:20 | Contract model, flatten, canonical paths, diff all dimensions, diff API | **M2:** unit tests + kit fixtures produce the expected change list |
| 3. Classification + consumers + impact | 2:20–3:15 | Rule table with reasons, consumer YAML import, impact matching, impact API | **M3:** quote 2->3 shows `mobile-app`; policy 3->4 shows `partner-portal` |
| 4. Publish gate + history + changelog + metrics | 3:15–3:45 | Attempts, blocked/published outcomes, attempt changes, changelog, metrics | **M4:** unsafe fixture publishes return `409`; safe ones publish; history is complete |
| 5. Seed, integration + acceptance, Docker, docs | 3:45–4:45 | Seed script, Supertest suite, acceptance script, backend Dockerfile + compose service, README/API examples | `docker compose up --build` runs the seedable backend; `npm test` is green |
| 6. UI MVP | 4:45–5:30 | Services list, service detail, upload, diff + impact, publish result, history, metrics | Demo flows work through the UI without touching the DB |
| 7. Finish | 5:30–6:00 | README, PROGRESS, DECISIONS, REVIEW, transcripts, demo script, final test run | Submission checklist complete |

### Immediate backend sequence (start here)

1. `backend/package.json`: add `better-sqlite3`, `@apidevtools/swagger-parser`, `zod`,
   `vitest`, `supertest`; fix `dev`/`start` to `src/server.js`.
2. Create `src/db/schema.sql` from section 7 and `src/db/index.js`; return `:memory:` in tests.
3. Create `src/app.js` with CORS, JSON, a raw text parser for YAML, error middleware and a
   health route; keep `src/server.js` as the only `listen`.
4. Implement services + spec upload tests first, then normalization/diff.

### Docker changes

Add a backend service to the existing compose file (keep the webhook receiver untouched),
with `DB_PATH=/data/contract-guard.db`, a named volume and `WEBHOOK_URL` pointing at
`http://webhook-receiver:9000`. The frontend container comes in phase 6.

---

## 11. UI sketches (deferred until backend is stable)

1. **Services:** cards/table with owner, latest version, published/draft counts, warning badge.
2. **Service detail:** version timeline with status, upload button, publish action, attempts.
3. **Diff view:** grouped by endpoint; colored severity; filters for breaking/internal;
   before/after values and the reason sentence.
4. **Impact panel:** consumer list per change, with the exact fields each reads or sends.
5. **Publish result:** blocked modal with affected teams and a link to each change; safe
   success with changelog.
6. **Changelog/history:** readable list; every attempt with actor, time and outcome.
7. **Metrics:** cards for dangerous changes caught, blocked publishes, affected consumers.

---

## 12. Main risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `$ref` aliasing creates fake diffs | Compare dereferenced, normalized contracts, never raw files; golden test quote 1->2 must be empty |
| Classification debates consume the build | Fix the rule table in this plan and cover every rule with a test; record later changes in `DECISIONS.md` |
| Duplicate `info.version` in claims API | Per-service revision plus hash; reject only identical content |
| Consumer impact over/under-matching | Explicit ancestor/descendant rules and fixture tests for every consumer file |
| Time lost on UI polish | Backend milestones M1–M4 are the gate; UI uses the stable API |
| SQLite native module in Docker | Node 22 bookworm base, `npm ci`; install build tools only if the prebuilt binary is unavailable |

---

## 13. Definition of done

- All ten must-haves work through the API and are demonstrable in the UI.
- `docker compose up --build` starts the product; `npm run seed` imports the kit.
- Every kit fixture behaves exactly as the acceptance table above.
- `npm test` and `npm run test:acceptance` pass.
- A blocked publish shows the affected consumers and a plain-English reason for every
  blocking change; history and metrics agree.
- README explains setup, API examples, what works and what does not.
- Plan decisions made after Gate 1 are recorded in `DECISIONS.md` rather than rewriting
  this file.
