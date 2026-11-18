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
