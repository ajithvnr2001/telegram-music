CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_file_id TEXT NOT NULL,
  tg_unique_id TEXT,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  file_name TEXT,
  title TEXT,
  artist TEXT,
  mime_type TEXT,
  media_type TEXT,
  size INTEGER DEFAULT 0,
  duration INTEGER,
  width INTEGER,
  height INTEGER,
  added_at INTEGER NOT NULL,
  added_by INTEGER,
  UNIQUE(chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_songs_mime ON songs(mime_type);
CREATE INDEX IF NOT EXISTS idx_songs_name ON songs(file_name);

CREATE TABLE IF NOT EXISTS stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
