CREATE TABLE models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dimensions TEXT NOT NULL,
  revision TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX models_expiry ON models(expires_at);
-- Register objects before upload so interrupted uploads are also collectable.
CREATE TABLE objects (
  object_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX objects_created ON objects(created_at);
