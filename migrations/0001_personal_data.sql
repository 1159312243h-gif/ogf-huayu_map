PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS search_history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query_key TEXT NOT NULL,
  query TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, query_key)
);

CREATE INDEX IF NOT EXISTS search_history_recent ON search_history(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  favorite_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, favorite_key)
);

CREATE INDEX IF NOT EXISTS favorites_recent ON favorites(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS image_overlays (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  west REAL NOT NULL,
  south REAL NOT NULL,
  east REAL NOT NULL,
  north REAL NOT NULL,
  opacity REAL NOT NULL DEFAULT 0.75,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS image_overlays_user_id ON image_overlays(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS image_overlay_blobs (
  overlay_id TEXT PRIMARY KEY REFERENCES image_overlays(id) ON DELETE CASCADE,
  image_data BLOB NOT NULL
);
