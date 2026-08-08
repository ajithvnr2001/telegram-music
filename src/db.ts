import type { Env, Song } from "./types";

export function songRow(row: Record<string, unknown>): Song {
  return {
    id: Number(row.id),
    tg_file_id: String(row.tg_file_id),
    tg_unique_id: row.tg_unique_id ? String(row.tg_unique_id) : null,
    chat_id: String(row.chat_id),
    message_id: Number(row.message_id),
    file_name: row.file_name ? String(row.file_name) : null,
    title: row.title ? String(row.title) : null,
    artist: row.artist ? String(row.artist) : null,
    mime_type: row.mime_type ? String(row.mime_type) : null,
    media_type: (row.media_type as Song["media_type"]) ?? "document",
    size: Number(row.size ?? 0),
    duration: row.duration ? Number(row.duration) : null,
    width: row.width ? Number(row.width) : null,
    height: row.height ? Number(row.height) : null,
    added_at: Number(row.added_at),
    added_by: row.added_by ? Number(row.added_by) : null,
    album: row.album ? String(row.album) : null,
    genre: row.genre ? String(row.genre) : null,
    year: row.year ? String(row.year) : null,
    codec: row.codec ? String(row.codec) : null,
    sample_rate: row.sample_rate ? Number(row.sample_rate) : null,
    channels: row.channels ? Number(row.channels) : null,
    bitrate: row.bitrate ? Number(row.bitrate) : null,
    language: row.language ? String(row.language) : null,
  };
}

export async function insertSong(env: Env, s: Omit<Song, "id">): Promise<Song | null> {
  const res = await env.DB.prepare(
    `INSERT INTO songs (tg_file_id, tg_unique_id, chat_id, message_id, file_name, title, artist,
                        mime_type, media_type, size, duration, width, height, added_at, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO UPDATE SET
       tg_file_id = excluded.tg_file_id,
       file_name = excluded.file_name,
       title = excluded.title,
       artist = excluded.artist,
       mime_type = excluded.mime_type,
       media_type = excluded.media_type,
       size = excluded.size,
       duration = excluded.duration,
       width = excluded.width,
       height = excluded.height`,
  )
    .bind(
      s.tg_file_id,
      s.tg_unique_id,
      s.chat_id,
      s.message_id,
      s.file_name,
      s.title,
      s.artist,
      s.mime_type,
      s.media_type,
      s.size,
      s.duration,
      s.width,
      s.height,
      s.added_at,
      s.added_by,
    )
    .run();
  if (!res.success) return null;
  const found = await env.DB.prepare(
    `SELECT * FROM songs WHERE chat_id = ? AND message_id = ?`,
  )
    .bind(s.chat_id, s.message_id)
    .first();
  return found ? songRow(found) : null;
}

export async function listSongs(env: Env, limit = 1000): Promise<Song[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM songs ORDER BY added_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return (rows.results ?? []).map(songRow);
}

export async function getSong(env: Env, id: number): Promise<Song | null> {
  const row = await env.DB.prepare(`SELECT * FROM songs WHERE id = ?`).bind(id).first();
  return row ? songRow(row) : null;
}

export async function getSongByFileId(env: Env, fileId: string): Promise<Song | null> {
  const row = await env.DB.prepare(`SELECT * FROM songs WHERE tg_file_id = ? LIMIT 1`)
    .bind(fileId)
    .first();
  return row ? songRow(row) : null;
}

export async function deleteSong(env: Env, id: number): Promise<Song | null> {
  const song = await getSong(env, id);
  if (!song) return null;
  await env.DB.prepare(`DELETE FROM songs WHERE id = ?`).bind(id).run();
  return song;
}

export async function searchSongs(env: Env, query: string, limit = 10): Promise<Song[]> {
  const like = `%${query}%`;
  const rows = await env.DB.prepare(
    `SELECT * FROM songs
     WHERE file_name LIKE ? OR title LIKE ? OR artist LIKE ?
     ORDER BY added_at DESC LIMIT ?`,
  )
    .bind(like, like, like, limit)
    .all();
  return (rows.results ?? []).map(songRow);
}

export interface Playlist {
  id: number;
  name: string;
  song_count: number;
  created_at: number;
}

export async function listPlaylists(env: Env): Promise<Playlist[]> {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.created_at,
            (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id) AS song_count
     FROM playlists p
     ORDER BY p.created_at DESC`,
  ).all();
  return (rows.results ?? []).map((r: any) => ({
    id: Number(r.id),
    name: String(r.name),
    song_count: Number(r.song_count ?? 0),
    created_at: Number(r.created_at),
  }));
}

export async function createPlaylist(env: Env, name: string): Promise<Playlist | null> {
  const res = await env.DB.prepare("INSERT INTO playlists (name, created_at) VALUES (?, ?)")
    .bind(name, Date.now())
    .run();
  const id = res.meta.last_row_id;
  return { id: Number(id), name, song_count: 0, created_at: Date.now() };
}

export async function deletePlaylist(env: Env, id: number): Promise<boolean> {
  await env.DB.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").bind(id).run();
  const res = await env.DB.prepare("DELETE FROM playlists WHERE id = ?").bind(id).run();
  return res.meta.changes > 0;
}

export async function getPlaylistSongs(env: Env, id: number): Promise<Song[]> {
  const rows = await env.DB.prepare(
    `SELECT s.* FROM playlist_songs ps
     JOIN songs s ON s.id = ps.song_id
     WHERE ps.playlist_id = ?
     ORDER BY ps.pos`,
  )
    .bind(id)
    .all();
  return (rows.results ?? []).map(songRow);
}

export async function addSongToPlaylist(env: Env, playlistId: number, songId: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO playlist_songs (playlist_id, song_id, pos, added_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(pos), 0) + 1 FROM playlist_songs WHERE playlist_id = ?1), ?)
     ON CONFLICT(playlist_id, song_id) DO NOTHING`,
  )
    .bind(playlistId, songId, Date.now())
    .run();
}

export async function removeSongFromPlaylist(env: Env, playlistId: number, songId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?")
    .bind(playlistId, songId)
    .run();
}

export async function bumpStat(env: Env, key: string, delta = 1): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO stats (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
  )
    .bind(key, delta)
    .run();
}

export async function getStats(env: Env): Promise<{ songs: number; audio: number; video: number }> {
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN media_type = 'audio' THEN 1 ELSE 0 END) AS audio,
            SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) AS video
     FROM songs`,
  ).first();
  return {
    songs: Number(totals?.total ?? 0),
    audio: Number(totals?.audio ?? 0),
    video: Number(totals?.video ?? 0),
  };
}
