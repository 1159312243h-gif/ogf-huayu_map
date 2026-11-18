CREATE TABLE IF NOT EXISTS brand_manager_applications (
 id TEXT PRIMARY KEY,
 brand_key TEXT NOT NULL, brand_name TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 statement TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','withdrawn','revoked','banned')),
 decision_source TEXT NOT NULL CHECK(decision_source IN ('auto','admin','applicant')),
 review_note TEXT NOT NULL DEFAULT '', reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 decision_token TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 UNIQUE(brand_key,user_id)
);
CREATE INDEX IF NOT EXISTS brand_applications_inbox ON brand_manager_applications(status,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS brand_applications_user ON brand_manager_applications(user_id,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS brand_manager_grants (
 brand_key TEXT NOT NULL, brand_name TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 application_id TEXT NOT NULL UNIQUE REFERENCES brand_manager_applications(id) ON DELETE CASCADE,
 granted_by TEXT REFERENCES users(id) ON DELETE SET NULL, granted_at INTEGER NOT NULL,
 PRIMARY KEY(brand_key,user_id)
);
CREATE TABLE IF NOT EXISTS brand_manager_bans (
 brand_key TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reason TEXT NOT NULL, banned_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(brand_key,user_id)
);
CREATE TABLE IF NOT EXISTS brand_profiles (
 brand_key TEXT PRIMARY KEY, brand_name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '',
 edited_by TEXT REFERENCES users(id) ON DELETE SET NULL, updated_at INTEGER NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS brand_management_events (
 id TEXT PRIMARY KEY,
 application_id TEXT NOT NULL REFERENCES brand_manager_applications(id) ON DELETE CASCADE,
 status TEXT NOT NULL, decision_source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
 actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS brand_events_application ON brand_management_events(application_id,created_at,id);
