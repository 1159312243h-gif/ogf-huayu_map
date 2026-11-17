CREATE TABLE IF NOT EXISTS feature_contributions (
  id TEXT PRIMARY KEY,
  feature_type TEXT NOT NULL CHECK (feature_type IN ('node', 'way', 'relation')),
  feature_id INTEGER NOT NULL CHECK (feature_id > 0),
  feature_name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  edited_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS feature_contributions_feature ON feature_contributions(feature_type, feature_id, created_at, id);
CREATE INDEX IF NOT EXISTS feature_contributions_author ON feature_contributions(user_id, created_at);
