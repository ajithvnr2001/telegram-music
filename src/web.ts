import type { Song } from "./types";

export function renderPlayerPage(passwordProtected: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tele Music Player</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎵</text></svg>">
<style>
  :root { color-scheme: dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(1200px 600px at 20% -10%, #1d2b4a 0%, #0b1020 55%, #070a14 100%) fixed;
    color: #e8ecf4; min-height: 100vh; padding-bottom: 190px;
  }
  .container { max-width: 780px; margin: 0 auto; padding: 24px 16px; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; flex-wrap: wrap; }
  .logo { width: 44px; height: 44px; border-radius: 12px; background: linear-gradient(135deg, #4f7dff, #9b5cff); display: flex; align-items: center; justify-content: center; font-size: 22px; box-shadow: 0 4px 18px rgba(79,125,255,.35); }
  h1 { font-size: 22px; font-weight: 700; letter-spacing: .3px; }
  .sub { color: #8a93a8; font-size: 13px; margin-top: 2px; }
  .spacer { flex: 1; }
  .count { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); padding: 6px 14px; border-radius: 999px; font-size: 13px; color: #aeb8cc; }
  #search { width: 100%; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); color: #e8ecf4; border-radius: 12px; padding: 13px 18px; font-size: 15px; outline: none; margin-bottom: 20px; transition: border .2s; }
  #search:focus { border-color: #4f7dff; }
  #search::placeholder { color: #5d6880; }
  #list { display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; cursor: pointer; transition: background .15s, transform .15s; }
  .row:hover { background: rgba(255,255,255,.09); }
  .row.playing { background: rgba(79,125,255,.16); border-color: rgba(79,125,255,.5); }
  .idx { width: 26px; text-align: center; color: #5d6880; font-size: 13px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .icon { font-size: 20px; flex-shrink: 0; }
  .info { flex: 1; min-width: 0; }
  .name { font-weight: 600; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { color: #8a93a8; font-size: 12.5px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dur { color: #6f7a92; font-size: 12.5px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .tglink { text-decoration: none; color: #7f9bff; font-size: 14px; padding: 4px 8px; border-radius: 8px; flex-shrink: 0; }
  .tglink:hover { background: rgba(127,155,255,.15); }
  #addBtn { background: linear-gradient(135deg, #4f7dff, #9b5cff); border: none; color: #fff; font-size: 13px; font-weight: 600; padding: 8px 16px; border-radius: 999px; cursor: pointer; box-shadow: 0 3px 14px rgba(79,125,255,.35); transition: filter .15s; }
  #addBtn:hover { filter: brightness(1.1); }
  #plBtn { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.16); color: #cfe0ff; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 999px; cursor: pointer; transition: background .15s; }
  #plBtn:hover { background: rgba(255,255,255,.14); }
  #plBtn.active { background: rgba(79,125,255,.25); border-color: #4f7dff; }
  .pltag { display: inline-flex; align-items: center; gap: 8px; background: rgba(79,125,255,.16); border: 1px solid #4f7dff; color: #bcd2ff; padding: 5px 12px; border-radius: 999px; font-size: 12.5px; margin-bottom: 14px; }
  .pltag button { background: none; border: none; color: #bcd2ff; cursor: pointer; font-size: 13px; padding: 0 2px; }
  .row .listbtn { flex-shrink: 0; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); color: #9fb3dc; font-size: 12px; padding: 5px 9px; border-radius: 8px; cursor: pointer; }
  .row .listbtn:hover { background: rgba(127,155,255,.18); border-color: #4f7dff; }
  #plOverlay { position: fixed; inset: 0; background: rgba(5,8,18,.82); backdrop-filter: blur(6px); z-index: 65; display: none; align-items: center; justify-content: center; padding: 20px; }
  #plOverlay.show { display: flex; }
  .pl-card { background: #111827; border: 1px solid #2b3550; border-radius: 16px; padding: 24px; width: 100%; max-width: 460px; max-height: 82vh; overflow-y: auto; }
  .pl-card h2 { font-size: 17px; margin-bottom: 4px; }
  .pl-card .hint { color: #8a93a8; font-size: 12.5px; margin-bottom: 14px; }
  .pl-new { display: flex; gap: 8px; margin-bottom: 14px; }
  .pl-new input { flex: 1; background: #0b1020; border: 1px solid #2b3550; color: #e8ecf4; border-radius: 9px; padding: 10px 12px; font-size: 13.5px; outline: none; }
  .pl-new input:focus { border-color: #4f7dff; }
  .pl-new button { background: linear-gradient(135deg, #4f7dff, #9b5cff); border: none; color: #fff; border-radius: 9px; padding: 0 14px; font-weight: 600; cursor: pointer; }
  .pl-list { display: flex; flex-direction: column; gap: 6px; }
  .pl-item { display: flex; align-items: center; gap: 10px; padding: 11px 12px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; }
  .pl-item .nm { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pl-item .cnt { color: #8a93a8; font-size: 12px; flex-shrink: 0; }
  .pl-item .act { background: none; border: 1px solid rgba(255,255,255,.14); color: #c6d6ff; border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; flex-shrink: 0; }
  .pl-item .act:hover { background: rgba(127,155,255,.18); }
  .pl-item .sel { border-color: #4f7dff; background: rgba(79,125,255,.14); }
  .pl-item .del { border-color: rgba(255,107,107,.4); color: #ff8f8f; }
  .pl-item .del:hover { background: rgba(255,107,107,.14); }
  .pl-close { margin-top: 14px; width: 100%; padding: 10px; border: none; border-radius: 10px; background: rgba(255,255,255,.08); color: #e8ecf4; font-size: 13.5px; font-weight: 600; cursor: pointer; }
  .pl-close:hover { background: rgba(255,255,255,.14); }
  #songPlOverlay { position: fixed; inset: 0; background: rgba(5,8,18,.82); backdrop-filter: blur(6px); z-index: 66; display: none; align-items: center; justify-content: center; padding: 20px; }
  #songPlOverlay.show { display: flex; }
  #songPlOverlay .pl-card { max-width: 380px; max-height: auto; }
  #uploadOverlay { position: fixed; inset: 0; background: rgba(5,8,18,.8); backdrop-filter: blur(6px); z-index: 60; display: none; align-items: center; justify-content: center; padding: 20px; }
  #uploadOverlay.show { display: flex; }
  .upload-card { background: #111827; border: 1px solid #2b3550; border-radius: 16px; padding: 24px; width: 100%; max-width: 440px; }
  .upload-card h2 { font-size: 17px; margin-bottom: 4px; }
  .upload-card .hint { color: #8a93a8; font-size: 12.5px; margin-bottom: 14px; }
  .drop { border: 2px dashed #2b3550; border-radius: 12px; padding: 34px 16px; text-align: center; color: #8a93a8; font-size: 14px; cursor: pointer; transition: border .2s, background .2s; }
  .drop:hover, .drop.drag { border-color: #4f7dff; background: rgba(79,125,255,.06); }
  .drop .big { font-size: 30px; margin-bottom: 8px; }
  .drop input { display: none; }
  .uplist { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto; }
  .upitem { display: flex; align-items: center; gap: 10px; font-size: 13px; padding: 8px 10px; background: rgba(255,255,255,.05); border-radius: 8px; }
  .upitem .nm { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .upitem .st { font-size: 12px; flex-shrink: 0; }
  .upitem .st.ok { color: #4ade80; }
  .upitem .st.fail { color: #ff6b6b; }
  .upitem .st.prog { color: #7f9bff; }
  .uplink { font-size: 12px; color: #7f9bff; text-decoration: none; word-break: break-all; }
  .upload-close { margin-top: 14px; width: 100%; padding: 10px; border: none; border-radius: 10px; background: rgba(255,255,255,.08); color: #e8ecf4; font-size: 13.5px; font-weight: 600; cursor: pointer; }
  .upload-close:hover { background: rgba(255,255,255,.14); }
  .empty { text-align: center; color: #5d6880; padding: 60px 0; font-size: 15px; }
  .empty .big { font-size: 44px; margin-bottom: 14px; }
  #toast { position: fixed; bottom: 180px; left: 50%; transform: translateX(-50%) translateY(20px); background: #111827; border: 1px solid #2b3550; color: #e8ecf4; padding: 10px 20px; border-radius: 10px; font-size: 13.5px; opacity: 0; pointer-events: none; transition: all .25s; z-index: 50; }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #player { position: fixed; left: 0; right: 0; bottom: 0; background: rgba(10,14,26,.92); backdrop-filter: blur(14px); border-top: 1px solid rgba(255,255,255,.1); padding: 14px 16px; z-index: 40; }
  #videoWrap { display: none; text-align: center; margin-bottom: 12px; }
  #videoWrap.show { display: block; }
  #video { max-width: 640px; width: 100%; max-height: 260px; border-radius: 10px; background: #000; }
  #nowPlaying { display: flex; align-items: center; gap: 12px; max-width: 780px; margin: 0 auto; }
  .np-info { flex: 1; min-width: 0; }
  .np-title { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .np-sub { color: #8a93a8; font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .controls { display: flex; align-items: center; gap: 8px; }
  .btn { background: none; border: none; color: #c6cfe0; font-size: 22px; cursor: pointer; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: background .15s; }
  .btn:hover { background: rgba(255,255,255,.1); }
  .btn.play { background: linear-gradient(135deg, #4f7dff, #9b5cff); color: #fff; font-size: 18px; box-shadow: 0 3px 14px rgba(79,125,255,.4); }
  .btn.play:hover { filter: brightness(1.1); }
  #audio { display: none; }
  #progress { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 120px; }
  .bar { -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 2px; background: rgba(255,255,255,.15); outline: none; cursor: pointer; }
  .bar::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%; background: #4f7dff; border: 2px solid #fff; }
  .times { display: flex; justify-content: space-between; font-size: 11.5px; color: #7c86a0; font-variant-numeric: tabular-nums; }
  .muted { color: #5d6880; }
  #authOverlay { position: fixed; inset: 0; background: rgba(5,8,18,.94); z-index: 100; display: none; align-items: center; justify-content: center; padding: 20px; }
  #authOverlay.show { display: flex; }
  .auth-card { background: #111827; border: 1px solid #2b3550; border-radius: 16px; padding: 32px; width: 100%; max-width: 340px; text-align: center; }
  .auth-card h2 { font-size: 18px; margin-bottom: 8px; }
  .auth-card p { color: #8a93a8; font-size: 13px; margin-bottom: 18px; }
  .auth-card input { width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #2b3550; background: #0b1020; color: #e8ecf4; font-size: 14px; outline: none; margin-bottom: 12px; }
  .auth-card input:focus { border-color: #4f7dff; }
  .auth-card button { width: 100%; padding: 12px; border: none; border-radius: 10px; background: linear-gradient(135deg, #4f7dff, #9b5cff); color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  .auth-err { color: #ff6b6b; font-size: 12.5px; min-height: 18px; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">🎵</div>
    <div>
      <h1>Tele Music</h1>
      <div class="sub">Streaming from Telegram channel</div>
    </div>
    <div class="spacer"></div>
    <button id="plBtn">🎵 Playlists</button>
    <button id="addBtn">＋ Add songs</button>
    <div class="count" id="count">Loading…</div>
  </header>
  <input id="search" type="text" placeholder="🔍  Search songs…" autocomplete="off">
  <div id="plTag" class="pltag" style="display:none"></div>
  <div id="list"></div>
</div>

<div id="player">
  <div id="videoWrap"><video id="video" controls playsinline preload="metadata"></video></div>
  <div id="nowPlaying">
    <button class="btn" id="prevBtn" title="Previous">⏮</button>
    <button class="btn play" id="playBtn" title="Play/Pause">▶</button>
    <button class="btn" id="nextBtn" title="Next">⏭</button>
    <div id="progress">
      <input id="bar" class="bar" type="range" min="0" max="1000" value="0">
      <div class="times"><span id="tCur">0:00</span><span id="tDur">0:00</span></div>
    </div>
    <div class="np-info">
      <div class="np-title" id="npTitle">Nothing playing</div>
      <div class="np-sub" id="npSub">Select a song to start</div>
    </div>
  </div>
  <audio id="audio" preload="metadata"></audio>
</div>

<div id="authOverlay">
  <div class="auth-card">
    <div style="font-size:38px;margin-bottom:10px">🔒</div>
    <h2>Private library</h2>
    <p>Enter the access password to play music.</p>
    <input id="passInput" type="password" placeholder="Password" autocomplete="off">
    <div class="auth-err" id="authErr"></div>
    <button id="passBtn">Unlock</button>
  </div>
</div>

<div id="uploadOverlay">
  <div class="upload-card">
    <h2>＋ Add songs</h2>
    <div class="hint">Up to 50 MB per file — they are stored in the Telegram channel and stream from here.</div>
    <div class="drop" id="dropZone">
      <div class="big">📥</div>
      <div>Drag &amp; drop audio or video files here<br>or <b>click to browse</b></div>
      <input id="fileInput" type="file" multiple accept=".mp3,.m4a,.ogg,.oga,.opus,.flac,.wav,.aac,.weba,.mp4,.mkv,.webm,.mov,.avi,.m4v,.ts,.3gp,audio/*,video/*">
    </div>
    <div class="uplist" id="uplist"></div>
    <button class="upload-close" id="uploadClose">Done</button>
  </div>
</div>

<div id="toast"></div>

<div id="plOverlay">
  <div class="pl-card">
    <h2>🎵 Playlists</h2>
    <div class="hint">Create playlists, add songs to them, and play them here.</div>
    <div class="pl-new">
      <input id="plName" type="text" placeholder="New playlist name…" autocomplete="off">
      <button id="plCreate">Create</button>
    </div>
    <div class="pl-list" id="plList"></div>
    <button class="pl-close" id="plClose">Close</button>
  </div>
</div>

<div id="songPlOverlay">
  <div class="pl-card">
    <h2 id="songPlTitle">Add to playlist</h2>
    <div class="hint">Choose a playlist to add this song to.</div>
    <div class="pl-new">
      <input id="spName" type="text" placeholder="New playlist name…" autocomplete="off">
      <button id="spCreate">Create</button>
    </div>
    <div class="pl-list" id="spList"></div>
    <button class="pl-close" id="spClose">Close</button>
  </div>
</div>

<script>
(() => {
  const PASS_KEY = "tmplayer_pass";
  let songs = [];
  let filtered = [];
  let current = -1;
  let playing = false;
  let needsAuth = ${passwordProtected ? "true" : "false"};
  let authToken = sessionStorage.getItem(PASS_KEY) || "";

  const $ = (id) => document.getElementById(id);
  const audio = $("audio"), video = $("video"), bar = $("bar");
  const playBtn = $("playBtn"), listEl = $("list"), searchEl = $("search");
  const videoWrap = $("videoWrap");
  const flacCache = new Map();
  let ffmpegPromise = null;
  let actx = null;
  let waSrc = null;
  let waBuffer = null;
  let waOffset = 0;
  let waStart = 0;
  let waActive = false;
  let waTimer = null;
  let userSeeking = false;

  function ensureAudio() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    return actx;
  }
  function stopWA() {
    waActive = false;
    if (waTimer) { clearInterval(waTimer); waTimer = null; }
    if (waSrc) { try { waSrc.stop(); } catch {} try { waSrc.disconnect(); } catch {} waSrc = null; }
    waBuffer = null;
  }
  function waTime() {
    if (!waActive || !actx) return 0;
    return waOffset + (actx.currentTime - waStart);
  }
  function updateWATime() {
    if (!waActive) return;
    const t = waTime();
    $("tCur").textContent = fmtTime(t);
    bar.value = Math.min(Math.round(t * 1000), bar.max || 1000);
  }
  function playWA(abuf, s) {
    const ctx = ensureAudio();
    stopWA();
    waActive = true;
    waBuffer = abuf;
    waOffset = 0;
    waStart = ctx.currentTime;
    waSrc = ctx.createBufferSource();
    waSrc.buffer = abuf;
    waSrc.connect(ctx.destination);
    waSrc.onended = () => { if (waActive) next(true); };
    waSrc.start(0);
    playing = true;
    playBtn.textContent = "⏸";
    $("tDur").textContent = fmtTime(abuf.duration);
    bar.max = Math.round(abuf.duration * 1000);
    waTimer = setInterval(updateWATime, 500);
  }
  function waSeek(t) {
    if (!waActive || !waBuffer || !actx) return;
    const act = actx;
    if (waSrc) { try { waSrc.stop(); } catch {} try { waSrc.disconnect(); } catch {} waSrc = null; }
    waOffset = Math.max(0, Math.min(waBuffer.duration, t));
    if (waOffset >= waBuffer.duration - 0.3) waOffset = Math.max(0, waBuffer.duration - 0.3);
    waStart = act.currentTime;
    waSrc = act.createBufferSource();
    waSrc.buffer = waBuffer;
    waSrc.connect(act.destination);
    waSrc.onended = () => { if (waActive && !userSeeking) next(true); };
    waSrc.start(0, waOffset);
    if (!playing) act.suspend();
    updateWATime();
  }

  function authHeaders() {
    return needsAuth && authToken ? { "X-Auth": authToken } : {};
  }
  function streamUrl(id) {
    return "/stream?id=" + id + (needsAuth && authToken ? "&p=" + encodeURIComponent(authToken) : "");
  }
  function fmtSize(b) {
    if (!b) return "";
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b/1024).toFixed(1) + " KB";
    return (b/1048576).toFixed(1) + " MB";
  }
  function fmtTime(s) {
    if (s == null || !isFinite(s)) return "0:00";
    s = Math.round(s);
    const m = Math.floor(s/60), sec = s % 60;
    return m + ":" + String(sec).padStart(2, "0");
  }
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2200);
  }
  function typeOf(s) {
    const mt = (s.mime_type || "").toLowerCase();
    if (mt.startsWith("video/") || s.media_type === "video") return "video";
    if (mt.startsWith("audio/") || s.media_type === "audio") return "audio";
    return "other";
  }
  function displayName(s) {
    if (s.title) return s.artist ? s.artist + " - " + s.title : s.title;
    return s.file_name || "Song #" + s.id;
  }
  function render() {
    const q = searchEl.value.trim().toLowerCase();
    filtered = q ? songs.filter(s => (s.file_name||"").toLowerCase().includes(q)
        || (s.title||"").toLowerCase().includes(q)
        || (s.artist||"").toLowerCase().includes(q)) : songs;
    $("count").textContent = filtered.length + (q ? " / " + songs.length : "") + " song" + (filtered.length === 1 ? "" : "s");
    renderPlTag();
    if (!filtered.length) {
      listEl.innerHTML = '<div class="empty"><div class="big">🎧</div>' + (songs.length ? "No matches found" : "Library is empty — send a song to the bot on Telegram") + "</div>";
      return;
    }
    listEl.innerHTML = "";
    filtered.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "row" + (i === current ? " playing" : "");
      row.innerHTML =
        '<div class="idx">' + (i + 1) + "</div>" +
        '<div class="icon">' + (typeOf(s) === "video" ? "🎬" : "🎵") + "</div>" +
        '<div class="info"><div class="name">' + esc(displayName(s)) + '</div>' +
        '<div class="meta">' + esc(s.file_name || "") + ' · ' + fmtSize(s.size) + "</div></div>" +
        '<div class="dur">' + fmtTime(s.duration) + "</div>" +
        '<a class="tglink" target="_blank" rel="noopener" title="Open in Telegram" href="' + esc(tgLink(s)) + '">↗</a>' +
        '<button class="listbtn" title="Add to playlist">＋</button>';
      row.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        if (e.target.closest(".listbtn")) { openSongPicker(s); return; }
        playAt(i);
      });
      listEl.appendChild(row);
    });
  }
  function esc(s) { return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function tgLink(s) { return "https://t.me/c/" + String(s.chat_id).replace(/^-100/, "") + "/" + s.message_id; }

  function playAt(i, autoplay = true) {
    const s = filtered[i];
    if (!s) return;
    stopWA();
    current = i;
    render();
    $("npTitle").textContent = displayName(s);
    $("npSub").textContent = (s.file_name || "") + " · " + fmtSize(s.size);
    bar.value = 0;
    $("tCur").textContent = "0:00";
    if (s.duration && isFinite(s.duration) && s.duration > 0) {
      $("tDur").textContent = fmtTime(s.duration);
      bar.max = Math.round(s.duration * 1000);
    } else {
      $("tDur").textContent = "0:00";
      bar.max = 1000;
    }
    const isVideo = typeOf(s) === "video";
    const el = isVideo ? video : audio;
    if (isVideo) { videoWrap.classList.add("show"); audio.pause(); }
    else { videoWrap.classList.remove("show"); video.pause(); }
    ensureAudio();
    if (!isVideo && flacCache.has(s.id)) {
      flacCache.get(s.id).decoded.then(abuf => {
        if (current === i && s.id === (filtered[current] || {}).id) playWA(abuf, s);
      }).catch(() => toast("Could not decode this song"));
      return;
    }
    el.onerror = null;
    el.src = streamUrl(s.id);
    playBtn.textContent = "⏸";
    let fellBack = false;
    const fallback = () => {
      if (fellBack || isVideo) return;
      fellBack = true;
      convertToFlac(s).catch((e) => {
        playing = false;
        playBtn.textContent = "▶";
        toast("Could not play this song" + (e && e.message ? ": " + e.message : ""));
      });
    };
    el.play().then(() => { playing = true; }).catch(fallback);
    el.onerror = fallback;
  }

  function ensureFFmpeg() {
    if (!ffmpegPromise) {
      ffmpegPromise = new Promise((resolve, reject) => {
        const loadScript = (src) => new Promise((res, rej) => {
          const scr = document.createElement("script");
          scr.src = src;
          scr.onload = res;
          scr.onerror = () => rej(new Error("failed to load " + src));
          document.head.appendChild(scr);
        });
        const coreBase = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
        Promise.all([
          loadScript("https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js"),
          loadScript("https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js"),
        ]).then(async () => {
          try {
            const { FFmpeg } = window.FFmpegWASM;
            const { toBlobURL } = window.FFmpegUtil;
            const ffmpeg = new FFmpeg();
            ffmpeg.setLogger(({ type, message }) => {
              if (type === "error") console.error("[ffmpeg]", message);
            });
            await ffmpeg.load({
              coreURL: await toBlobURL(coreBase + "/ffmpeg-core.js", "text/javascript"),
              wasmURL: await toBlobURL(coreBase + "/ffmpeg-core.wasm", "application/wasm"),
            });
            resolve(ffmpeg);
          } catch (e) { reject(e); }
        }, reject);
      });
    }
    return ffmpegPromise;
  }

  async function convertToFlac(s) {
    const cached = flacCache.get(s.id);
    if (cached) {
      playWA(await cached.decoded, s);
      return;
    }
    toast("Converting to FLAC (lossless)…");
    const ffmpeg = await ensureFFmpeg();
    const resp = await fetch(streamUrl(s.id));
    if (!resp.ok) throw new Error("stream failed");
    const buf = await resp.arrayBuffer();
    ffmpeg.writeFile("in.m4a", new Uint8Array(buf));
    await ffmpeg.exec(["-i", "in.m4a", "-vn", "-c:a", "flac", "out.flac"]);
    let out;
    try {
      out = await ffmpeg.readFile("out.flac");
    } catch (e) {
      throw new Error("conversion failed (out.flac missing)");
    }
    ffmpeg.deleteFile("in.m4a");
    ffmpeg.deleteFile("out.flac");
    const entry = { buf: out.slice().buffer, decoded: null };
    entry.decoded = ensureAudio().decodeAudioData(entry.buf.slice(0))
      .catch(() => { throw new Error("decode failed"); });
    flacCache.set(s.id, entry);
    playWA(await entry.decoded, s);
    toast("Playing lossless FLAC");
  }

  function toggle() {
    if (waActive) {
      if (playing) { actx.suspend(); playing = false; playBtn.textContent = "▶"; }
      else { actx.resume().then(() => { if (waActive) { playing = true; playBtn.textContent = "⏸"; } }); }
      return;
    }
    const el = typeOf(filtered[current]) === "video" ? video : audio;
    if (current < 0 && songs.length) playAt(0);
    if (playing) { el.pause(); playing = false; playBtn.textContent = "▶"; }
    else { el.play().then(() => { playing = true; playBtn.textContent = "⏸"; }).catch(() => {}); }
  }
  function next(auto = false) {
    if (!filtered.length) return;
    const i = current < 0 ? 0 : (current + 1) % filtered.length;
    if (auto && i === 0 && current >= 0) { stopWA(); audio.pause(); video.pause(); current = -1; render(); $("npTitle").textContent = "Nothing playing"; return; }
    playAt(i);
  }
  function prev() {
    if (!filtered.length) return;
    if (waActive && waTime() > 3) { waSeek(0); return; }
    if (audio.currentTime > 3 || video.currentTime > 3) { audio.currentTime = 0; video.currentTime = 0; return; }
    playAt(current <= 0 ? filtered.length - 1 : current - 1);
  }

  playBtn.addEventListener("click", toggle);
  $("prevBtn").addEventListener("click", prev);
  $("nextBtn").addEventListener("click", () => next());
  searchEl.addEventListener("input", render);

  function bindTimes(el) {
    el.addEventListener("loadedmetadata", () => {
      const d = el.duration;
      $("tDur").textContent = fmtTime(isFinite(d) ? d : null);
      bar.max = isFinite(d) && d > 0 ? Math.round(d * 1000) : 1000;
    });
  }
  bindTimes(audio); bindTimes(video);

  function bindBar(el) {
    el.addEventListener("timeupdate", () => {
      $("tCur").textContent = fmtTime(el.currentTime);
      if (isFinite(el.duration) && el.duration > 0) bar.value = Math.round(el.currentTime * 1000);
    });
    el.addEventListener("progress", () => {
      if (isFinite(el.duration) && el.duration > 0) bar.max = Math.round(el.duration * 1000);
    });
  }
  bindBar(audio); bindBar(video);

  bar.addEventListener("input", () => {
    if (waActive) { waSeek(bar.value / 1000); return; }
    userSeeking = true;
    const el = typeOf(filtered[current]) === "video" ? video : audio;
    const target = bar.value / 1000;
    if (isFinite(el.duration) && el.duration > 0 && target >= el.duration - 0.3) {
      el.currentTime = Math.max(0, el.duration - 0.3);
    } else {
      el.currentTime = target;
    }
  });
  bar.addEventListener("change", () => {
    setTimeout(() => { userSeeking = false; }, 600);
  });
  audio.addEventListener("ended", () => { if (!userSeeking) next(true); });
  video.addEventListener("ended", () => { if (!userSeeking) next(true); });

  function loadSongs() {
    fetch("/api/songs", { headers: authHeaders() }).then(r => {
      if (r.status === 401) { showAuth(); return Promise.reject(new Error("auth")); }
      return r.json();
    }).then(data => {
      songs = data || [];
      current = -1;
      render();
      const hash = location.hash.match(/#\\/song\\/(\\d+)/);
      if (hash) {
        const idx = filtered.findIndex(s => s.id === Number(hash[1]));
        if (idx >= 0) playAt(idx, false);
      }
    }).catch(e => {
      if (e.message !== "auth") { listEl.innerHTML = '<div class="empty">Failed to load library: ' + esc(e.message) + "</div>"; }
    });
  }

  function showAuth() { $("authOverlay").classList.add("show"); setTimeout(() => $("passInput").focus(), 100); }
  function hideAuth() { $("authOverlay").classList.remove("show"); }

  $("passBtn").addEventListener("click", () => {
    const p = $("passInput").value;
    fetch("/api/songs", { headers: { "X-Auth": p } }).then(r => {
      if (r.ok) { authToken = p; sessionStorage.setItem(PASS_KEY, p); needsAuth = true; hideAuth(); loadSongs(); }
      else { $("authErr").textContent = "Wrong password"; }
    }).catch(() => { $("authErr").textContent = "Server unreachable"; });
  });
  $("passInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("passBtn").click(); });

  const dropZone = $("dropZone"), fileInput = $("fileInput"), uplist = $("uplist");
  function openUpload() {
    if (needsAuth && !authToken) { toast("Unlock the player first"); return; }
    $("uploadOverlay").classList.add("show");
  }
  $("addBtn").addEventListener("click", openUpload);
  $("uploadClose").addEventListener("click", () => { $("uploadOverlay").classList.remove("show"); uplist.innerHTML = ""; loadSongs(); });
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag"));
  dropZone.addEventListener("drop", (e) => { e.preventDefault(); dropZone.classList.remove("drag"); uploadFiles(e.dataTransfer.files); });
  fileInput.addEventListener("change", () => { uploadFiles(fileInput.files); fileInput.value = ""; });

  function uploadFiles(files) {
    [...files].forEach(uploadOne);
  }
  function uploadOne(file) {
    if (!file.type.startsWith("audio/") && !file.type.startsWith("video/")) {
      itemRow(file.name, "fail", "not audio/video"); return;
    }
    const fd = new FormData();
    fd.append("file", file);
    const row = itemRow(file.name, "prog", "Uploading…");
    fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd })
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j.error || "Upload failed");
        const url = j.url;
        row.querySelector(".nm").innerHTML = "<a class='uplink' href='" + url + "' target='_blank'>" + esc(j.originalName) + "</a> · <b>" + fmtSize(j.size) + "</b>";
        row.querySelector(".st").className = "st ok";
        row.querySelector(".st").textContent = "✓ in channel";
        navigator.clipboard && navigator.clipboard.writeText(location.origin + url).catch(() => {});
        toast("Uploaded — link copied");
      })
      .catch(e => { row.querySelector(".st").className = "st fail"; row.querySelector(".st").textContent = "✕ " + esc(e.message || "failed"); });
  }
  function itemRow(name, cls, text) {
    const row = document.createElement("div");
    row.className = "upitem";
    row.innerHTML = '<div class="nm">' + esc(name) + '</div><div class="st ' + cls + '">' + esc(text) + "</div>";
    uplist.appendChild(row);
    return row;
  }

  let playlists = [];
  let activePlaylist = null;

  function renderPlTag() {
    const tag = $("plTag");
    if (!activePlaylist) { tag.style.display = "none"; return; }
    tag.style.display = "inline-flex";
    tag.innerHTML = "🎵 " + esc(activePlaylist.name) + " · " + songs.length + " songs <button title='Exit playlist' id='plTagX'>✕</button>";
    $("plTagX").addEventListener("click", () => { activePlaylist = null; loadSongs(); });
  }

  function buildPlList(overlay, onPlay, onDel) {
    overlay.innerHTML = "";
    if (!playlists.length) {
      overlay.innerHTML = '<div class="hint" style="text-align:center;padding:10px 0">No playlists yet — create one above.</div>';
      return;
    }
    playlists.forEach(pl => {
      const it = document.createElement("div");
      it.className = "pl-item";
      it.innerHTML = '<div class="nm">' + esc(pl.name) + '</div>' +
        '<div class="cnt">' + pl.song_count + "</div>" +
        '<button class="act" data-act="play">▶</button>' +
        '<button class="act ' + (onPlay ? "del" : "") + '" data-act="del">' + (onPlay ? "🗑" : "＋") + "</button>";
      const playBtn = it.querySelector(".act[data-act=play]");
      const delBtn = it.querySelector(".act[data-act=del]");
      if (onPlay) playBtn.addEventListener("click", () => onPlay(pl));
      else playBtn.style.display = "none";
      if (onDel) delBtn.addEventListener("click", () => onDel(pl));
      else delBtn.style.display = "none";
      it.addEventListener("click", (e) => {
        if (!e.target.closest(".act") && onPlay) onPlay(pl);
      });
      overlay.appendChild(it);
    });
  }

  function refreshPlaylists(overlay, onPlay, onDel) {
    fetch("/api/playlists", { headers: authHeaders() }).then(r => {
      if (r.status === 401) { showAuth(); throw new Error("auth"); }
      return r.json();
    }).then(data => {
      playlists = data || [];
      if (overlay) buildPlList(overlay, onPlay, onDel);
    }).catch(() => {});
  }

  function openPlaylists() {
    if (needsAuth && !authToken) { toast("Unlock the player first"); return; }
    $("plOverlay").classList.add("show");
    refreshPlaylists($("plList"), playPlaylist, deletePlaylist);
  }
  $("plBtn").addEventListener("click", openPlaylists);
  $("plClose").addEventListener("click", () => { $("plOverlay").classList.remove("show"); });
  $("plCreate").addEventListener("click", () => {
    const name = $("plName").value.trim();
    if (!name) { toast("Enter a playlist name"); return; }
    fetch("/api/playlists", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()), body: JSON.stringify({ name }) })
      .then(r => r.json())
      .then(() => { $("plName").value = ""; refreshPlaylists($("plList"), playPlaylist, deletePlaylist); toast("Playlist created"); })
      .catch(() => toast("Failed to create playlist"));
  });
  $("plName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("plCreate").click(); });

  function playPlaylist(pl) {
    const id = pl.id, name = pl.name;
    fetch("/api/playlist?id=" + id, { headers: authHeaders() }).then(r => {
      if (r.status === 401) { showAuth(); throw new Error("auth"); }
      return r.json();
    }).then(plSongs => {
      songs = Array.isArray(plSongs) ? plSongs : [];
      activePlaylist = { id, name };
      current = -1;
      searchEl.value = "";
      render();
      if (songs.length) playAt(0);
      toast("Playing playlist: " + name);
    }).catch(() => toast("Failed to open playlist"));
  }

  function deletePlaylist(id) {
    if (!confirm("Delete this playlist?")) return;
    fetch("/api/playlist?id=" + id, { method: "DELETE", headers: authHeaders() })
      .then(r => r.json())
      .then(() => { if (activePlaylist && activePlaylist.id === id) { activePlaylist = null; loadSongs(); } refreshPlaylists($("plList"), playPlaylist, deletePlaylist); toast("Playlist deleted"); })
      .catch(() => toast("Failed to delete playlist"));
  }

  function addSongToPl(pl) {
    fetch("/api/playlist/add", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()), body: JSON.stringify({ playlist_id: pl.id, song_id: pickerSong.id }) })
      .then(r => r.json())
      .then(() => toast('Added to "' + pl.name + '"'))
      .catch(() => toast("Failed to add song"));
  }

  function openSongPicker(s) {
    if (needsAuth && !authToken) { toast("Unlock the player first"); return; }
    pickerSong = s;
    $("songPlTitle").textContent = "Add to playlist: " + displayName(s);
    $("songPlOverlay").classList.add("show");
    refreshPlaylists($("spList"), null, addSongToPl);
  }

  $("spClose").addEventListener("click", () => { $("songPlOverlay").classList.remove("show"); });
  $("spCreate").addEventListener("click", () => {
    const name = $("spName").value.trim();
    if (!name) { toast("Enter a playlist name"); return; }
    fetch("/api/playlists", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()), body: JSON.stringify({ name }) })
      .then(r => r.json())
      .then(pl => {
        $("spName").value = "";
        return addSongToPl(pl);
      })
      .then(() => { openSongPicker(pickerSong); refreshPlaylists($("plList"), playPlaylist, deletePlaylist); toast("Playlist created and song added"); });
  });
  $("spName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("spCreate").click(); });

  let pickerSong = null;

  function warmFFmpeg() {
    ensureFFmpeg().then(() => {}).catch(() => {});
  }
  if (needsAuth === false || authToken) warmFFmpeg();

  loadSongs();
})();
</script>
</body>
</html>`;
}
