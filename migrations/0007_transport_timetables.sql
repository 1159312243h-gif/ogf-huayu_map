CREATE TABLE IF NOT EXISTS transport_trips (
 dataset_id TEXT NOT NULL REFERENCES shared_datasets(id) ON DELETE CASCADE,
 trip_index INTEGER NOT NULL, mode TEXT NOT NULL, trip_id TEXT NOT NULL,
 search_text TEXT NOT NULL, data_json TEXT NOT NULL,
 PRIMARY KEY(dataset_id,trip_index)
);
CREATE INDEX IF NOT EXISTS transport_trips_mode ON transport_trips(mode,dataset_id,trip_index);
CREATE TABLE IF NOT EXISTS transport_calls (
 dataset_id TEXT NOT NULL, trip_index INTEGER NOT NULL, position INTEGER NOT NULL, stop_key TEXT NOT NULL,
 PRIMARY KEY(dataset_id,trip_index,position,stop_key),
 FOREIGN KEY(dataset_id,trip_index) REFERENCES transport_trips(dataset_id,trip_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS transport_calls_lookup ON transport_calls(stop_key,dataset_id,trip_index,position);
