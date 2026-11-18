PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_team TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spec_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL,
  declared_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  spec_hash TEXT NOT NULL,
  source_format TEXT NOT NULL CHECK (source_format IN ('yaml', 'json')),
  raw_spec TEXT NOT NULL,
  parsed_spec_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'rejected')),
  uploaded_by TEXT NOT NULL DEFAULT 'system',
  validation_errors_json TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  UNIQUE (service_id, spec_hash),
  UNIQUE (service_id, declared_version, revision)
);

CREATE INDEX IF NOT EXISTS idx_spec_versions_service_created
  ON spec_versions (service_id, created_at);

CREATE INDEX IF NOT EXISTS idx_spec_versions_service_status
  ON spec_versions (service_id, status);

CREATE TABLE IF NOT EXISTS consumers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consumer_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consumer_id INTEGER NOT NULL,
  service_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  path_template TEXT NOT NULL,
  raw_path TEXT NOT NULL,
  sends_json TEXT NOT NULL DEFAULT '[]',
  reads_json TEXT NOT NULL DEFAULT '[]',
  source_file TEXT,
  FOREIGN KEY (consumer_id) REFERENCES consumers (id) ON DELETE CASCADE,
  FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  UNIQUE (consumer_id, service_id, method, path_template)
);

CREATE INDEX IF NOT EXISTS idx_consumer_endpoints_operation
  ON consumer_endpoints (service_id, method, path_template);

CREATE TABLE IF NOT EXISTS publish_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL,
  candidate_spec_id INTEGER NOT NULL,
  base_spec_id INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('published', 'blocked')),
  breaking_count INTEGER NOT NULL DEFAULT 0,
  potential_count INTEGER NOT NULL DEFAULT 0,
  affected_consumer_count INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL DEFAULT 'system',
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  FOREIGN KEY (candidate_spec_id) REFERENCES spec_versions (id) ON DELETE CASCADE,
  FOREIGN KEY (base_spec_id) REFERENCES spec_versions (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_publish_attempts_service_created
  ON publish_attempts (service_id, created_at);

CREATE INDEX IF NOT EXISTS idx_publish_attempts_outcome
  ON publish_attempts (outcome);

CREATE TABLE IF NOT EXISTS attempt_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL,
  change_key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  location TEXT NOT NULL,
  field_path TEXT,
  kind TEXT NOT NULL,
  direction TEXT NOT NULL,
  severity TEXT NOT NULL,
  reason TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 0,
  before_json TEXT,
  after_json TEXT,
  FOREIGN KEY (attempt_id) REFERENCES publish_attempts (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attempt_changes_attempt_severity
  ON attempt_changes (attempt_id, severity);
