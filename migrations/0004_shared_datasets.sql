CREATE TABLE IF NOT EXISTS shared_datasets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  observed_date TEXT NOT NULL,
  unit TEXT NOT NULL,
  period TEXT NOT NULL,
  license TEXT NOT NULL,
  filename TEXT NOT NULL,
  format TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  storage_bytes INTEGER NOT NULL,
  stats_json TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  edited_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS shared_datasets_author ON shared_datasets(user_id, created_at);
CREATE INDEX IF NOT EXISTS shared_datasets_kind ON shared_datasets(kind, created_at, id);
CREATE TABLE IF NOT EXISTS shared_dataset_chunks (
  dataset_id TEXT NOT NULL REFERENCES shared_datasets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('original','normalized')),
  position INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (dataset_id,kind,position)
);
