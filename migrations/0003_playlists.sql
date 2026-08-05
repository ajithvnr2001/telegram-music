CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_songs (
  playlist_id INTEGER NOT NULL,
  song_id INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, song_id)
);
CREATE INDEX IF NOT EXISTS idx_ps_playlist ON playlist_songs (playlist_id);
CREATE INDEX IF NOT EXISTS idx_ps_song ON playlist_songs (song_id);