CREATE TABLE IF NOT EXISTS feature_contribution_properties (
  contribution_id TEXT NOT NULL REFERENCES feature_contributions(id) ON DELETE CASCADE,
  property_key TEXT NOT NULL,
  property_value TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (contribution_id, property_key)
);
