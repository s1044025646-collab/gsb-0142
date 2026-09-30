export const SCHEMA_VERSION = 1;

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL UNIQUE,
    note TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    point_id INTEGER NOT NULL REFERENCES points(id) ON DELETE CASCADE,
    sample_rate INTEGER NOT NULL,
    sample_count INTEGER NOT NULL,
    samples BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    idempotency_key TEXT,
    imported_at_ms INTEGER NOT NULL,
    UNIQUE(point_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
    onset INTEGER NOT NULL,
    noise_start INTEGER NOT NULL,
    noise_end INTEGER NOT NULL,
    integration_end INTEGER NOT NULL,
    set_at_ms INTEGER NOT NULL,
    revised_reason TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
    window_id INTEGER NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
    param_version TEXT NOT NULL,
    report_json TEXT NOT NULL,
    frozen INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    UNIQUE(response_id, window_id, param_version)
  );

  CREATE INDEX IF NOT EXISTS idx_responses_point ON responses(point_id);
  CREATE INDEX IF NOT EXISTS idx_windows_response ON windows(response_id);
  CREATE INDEX IF NOT EXISTS idx_analyses_response ON analyses(response_id);
  `,
];
