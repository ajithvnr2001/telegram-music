-- state for the MTProto channel scanner (auth session, progress)
CREATE TABLE IF NOT EXISTS scanner_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
