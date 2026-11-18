CREATE TABLE IF NOT EXISTS brand_logos (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('brand','operator','transit')),
 name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, aliases_json TEXT NOT NULL DEFAULT '[]',
 source TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '',
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 edited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 image_data BLOB NOT NULL, image_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS brand_logos_author ON brand_logos(user_id,updated_at);
