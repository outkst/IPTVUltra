# Shaka Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native HTML5 video management with Shaka Player 5.1.5, add a gradient playback panel with seek bar and settings menu (Audio/Subtitles/Quality/Speed/Stream Info), and implement hold-to-rewind/FF with duration-based speed ramping driven by the webOS Magic Remote.

**Architecture:** A new `playback.js` module (IIFE pattern, exposed as `window.playback`) owns the Shaka instance, trick-play state machine, and track management. `script.js` calls `playback.*` instead of manipulating `videoPlayer` directly. The gradient panel and settings menu are new HTML/CSS overlays that only appear in fullscreen.

**Tech Stack:** Shaka Player 5.1.5 (CDN), vanilla JS/CSS, webOS Magic Remote keycodes, `com.webos.service.mediacontroller`. No bundler. No test framework — verification via `ares-inspect` DevTools or browser DevTools.

---

## Files

| File | Action |
|------|--------|
| `IPTVUltra/playback.js` | **Create** — Shaka wrapper, trick play, track management, mediacontroller |
| `IPTVUltra/index.html` | **Modify** — Shaka CDN, playback.js script tag, playback panel HTML, settings panel HTML, remove infoBtn/epgInfoBtn |
| `IPTVUltra/script.js` | **Modify** — update selectChannel, add fullscreen key handlers, add settings nav, remove stream info code |
| `IPTVUltra/style.css` | **Modify** — gradient panel, seek bar, settings panel, remove stream-info-overlay rules |
| `IPTVUltra/appinfo.json` | **Modify** — bump version to 3.0.0 |

---

## Task 1: Create branch and scaffold playback.js

**Files:**
- Create: `IPTVUltra/playback.js`

- [ ] **Step 1.1: Create the feature branch**

```powershell
git checkout -b feature/shaka-player
```

Expected: `Switched to a new branch 'feature/shaka-player'`

- [ ] **Step 1.2: Create `IPTVUltra/playback.js` with the full module scaffold**

Create `IPTVUltra/playback.js` with this complete content:

```js
'use strict';
// Shaka Player wrapper — owns the player instance, trick-play state, and track management.
// Exposed as window.playback for script.js to call.
const playback = (() => {

  // ── Constants ──────────────────────────────────────────────────────────────
  const REWIND_RAMP = [
    { after: 0,    speed: -1 },
    { after: 1500, speed: -2 },
    { after: 4000, speed: -4 },
    { after: 8000, speed: -8 },
  ];
  const FF_RAMP = [
    { after: 0,    speed: 2 },
    { after: 1500, speed: 4 },
    { after: 4000, speed: 8 },
  ];
  const PLAYBACK_RATES = [0.5, 0.75, 1, 1.5, 2];

  // ── State ───────────────────────────────────────────────────────────────────
  let _player   = null;   // shaka.Player
  let _video    = null;   // <video> element
  let _isDVR    = false;
  let _rateIndex = 2;     // index into PLAYBACK_RATES (default 1×)
  let _trickState = 'NORMAL'; // 'NORMAL' | 'REWINDING' | 'FAST_FWD'
  let _holdDir   = null;  // 'left' | 'right' | null
  let _holdStart = 0;
  let _holdInterval = null;

  // ── Internal helpers ────────────────────────────────────────────────────────
  function _getRampSpeed(ramp, heldMs) {
    let speed = ramp[0].speed;
    for (const step of ramp) { if (heldMs >= step.after) speed = step.speed; }
    return speed;
  }

  function _stopTrickPlay() {
    if (_holdInterval) { clearInterval(_holdInterval); _holdInterval = null; }
    if (_video) _video.playbackRate = 1;
    _trickState = 'NORMAL';
    _holdDir = null;
    _holdStart = 0;
    const badge = document.getElementById('pbTrickBadge');
    if (badge) badge.style.display = 'none';
  }

  function _showTrickBadge(text) {
    const el = document.getElementById('pbTrickBadge');
    if (!el) return;
    el.textContent = text;
    el.style.display = '';
  }

  function _showRateBadge(rate) {
    const el = document.getElementById('pbRateBadge');
    if (!el) return;
    if (rate === 1) { el.style.display = 'none'; return; }
    el.textContent = rate + '×';
    el.style.display = '';
  }

  function _updateSeekBar() {
    if (!_player || !_video) return;
    const panel = document.getElementById('playbackPanel');
    if (!panel || panel.style.display === 'none') return;
    const range = _player.seekRange();
    const duration = range.end - range.start;
    if (duration <= 0) return;
    const pct = Math.min(100, Math.max(0, (_video.currentTime - range.start) / duration * 100));
    const fill  = document.getElementById('pbSeekFill');
    const thumb = document.getElementById('pbSeekThumb');
    const offset = document.getElementById('pbTimeOffset');
    const liveBtn = document.getElementById('pbLiveBtn');
    if (fill)  fill.style.width = pct + '%';
    if (thumb) thumb.style.left  = pct + '%';
    const behind = Math.max(0, range.end - _video.currentTime);
    if (offset) offset.textContent = behind < 3 ? 'At live edge' : '-' + _fmtDur(Math.round(behind)) + ' behind live';
    if (liveBtn) liveBtn.classList.toggle('at-live', behind < 3);
  }

  function _fmtDur(secs) {
    const m = Math.floor(secs / 60), s = secs % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function _audioLabel(t) {
    let label = t.language ? t.language.toUpperCase() : 'Unknown';
    if (t.audioCodec) label += ' (' + (t.audioCodec.split('.')[0] || t.audioCodec) + ')';
    if (t.channelsCount > 2) label += ' ' + t.channelsCount + 'ch';
    return label;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async function init(videoElement) {
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      console.warn('playback: Shaka not supported on this browser');
      return;
    }
    _video = videoElement;
    _player = new shaka.Player();
    await _player.attach(_video);
    _player.configure({
      streaming: {
        bufferingGoal: 120,
        bufferBehind: 120,
        rebufferingGoal: 2,
        stallEnabled: true,
      },
    });
    _player.addEventListener('error', e => console.error('Shaka error:', e.detail));
  }

  async function loadChannel(url) {
    if (!_player) return;
    _stopTrickPlay();
    _rateIndex = 2;
    _showRateBadge(1);
    try {
      await _player.load(url);
      const range = _player.seekRange();
      _isDVR = (range.end - range.start) > 30;
      _video.play().catch(() => {});
      _updateSeekBar();
    } catch (err) {
      console.error('playback.loadChannel error:', err);
      throw err;
    }
  }

  function seekBy(seconds) {
    if (!_player || !_video) return;
    const range = _player.seekRange();
    _video.currentTime = Math.max(range.start, Math.min(range.end - 1, _video.currentTime + seconds));
    _video.play().catch(() => {});
    _updateSeekBar();
  }

  function startHold(dir) {
    if (_holdDir) return;
    _holdDir = dir;
    _holdStart = Date.now();
    _trickState = dir === 'left' ? 'REWINDING' : 'FAST_FWD';
    _video.pause();
    const ramp = dir === 'left' ? REWIND_RAMP : FF_RAMP;
    _holdInterval = setInterval(() => {
      if (!_player || !_video) return;
      const heldMs = Date.now() - _holdStart;
      const speed  = _getRampSpeed(ramp, heldMs);
      const range  = _player.seekRange();
      if (dir === 'left') {
        _video.currentTime = Math.max(range.start, _video.currentTime + speed * 0.1);
        _showTrickBadge('◀◀ ' + Math.abs(speed) + '×');
      } else {
        _video.currentTime = Math.min(range.end - 1, _video.currentTime + speed * 0.1);
        _showTrickBadge('▶▶ ' + speed + '×');
        if (_video.currentTime >= range.end - 1) stopHold();
      }
      _updateSeekBar();
    }, 100);
  }

  function stopHold() {
    _stopTrickPlay();
    if (_video) _video.play().catch(() => {});
  }

  function goToLive() {
    if (!_player || !_video) return;
    _stopTrickPlay();
    _video.currentTime = _player.seekRange().end;
    _video.play().catch(() => {});
    _updateSeekBar();
  }

  function setRate(rate) {
    if (!_video) return;
    _video.playbackRate = rate;
    const idx = PLAYBACK_RATES.indexOf(rate);
    _rateIndex = idx >= 0 ? idx : 2;
    _showRateBadge(rate);
  }

  function changeRate(delta) {
    const next = Math.max(0, Math.min(PLAYBACK_RATES.length - 1, _rateIndex + delta));
    if (next !== _rateIndex) setRate(PLAYBACK_RATES[next]);
  }

  function getSeekInfo() {
    if (!_player || !_video) return { pct: 100, behindSeconds: 0, isDVR: _isDVR };
    const range = _player.seekRange();
    const dur = range.end - range.start;
    const pct = dur > 0 ? Math.min(100, Math.max(0, (_video.currentTime - range.start) / dur * 100)) : 100;
    return { pct, behindSeconds: Math.max(0, range.end - _video.currentTime), isDVR: _isDVR };
  }

  function getStats() {
    if (!_player || !_video) return null;
    const stats  = _player.getStats();
    const tracks = _player.getVariantTracks();
    const active = tracks.find(t => t.active) || {};
    const info   = _player.getBufferedInfo();
    let bufferAhead = 0;
    if (info && info.total && info.total.length) {
      const seg = info.total.find(s => s.start <= _video.currentTime && s.end > _video.currentTime);
      if (seg) bufferAhead = Math.round(seg.end - _video.currentTime);
    }
    let liveLatency = '—';
    try { const ll = _player.getLiveLatency(); if (isFinite(ll)) liveLatency = ll.toFixed(1) + ' s'; } catch (_) {}
    return {
      width:  active.width  || 0,
      height: active.height || 0,
      frameRate:  active.frameRate ? active.frameRate.toFixed(2) : '—',
      videoCodec: active.videoCodec || '—',
      audioCodec: active.audioCodec || '—',
      bandwidth:  active.bandwidth ? (active.bandwidth / 1e6).toFixed(1) + ' Mbps' : '—',
      estimatedBandwidth: stats.estimatedBandwidth ? (stats.estimatedBandwidth / 1e6).toFixed(1) + ' Mbps' : '—',
      liveLatency,
      bufferAhead: bufferAhead + ' s',
      droppedFrames:   stats.droppedFrames   || 0,
      corruptedFrames: stats.corruptedFrames || 0,
      loadLatency: stats.loadLatency ? stats.loadLatency.toFixed(2) + ' s' : '—',
    };
  }

  function getTrackLists() {
    if (!_player) return { audio: [], subtitles: [], quality: [] };
    const variantTracks = _player.getVariantTracks();

    // Audio — deduplicate by audioId
    const seenAudio = new Set();
    const audio = [];
    for (const t of variantTracks) {
      if (t.audioId != null && !seenAudio.has(t.audioId)) {
        seenAudio.add(t.audioId);
        audio.push({ id: t.audioId, label: _audioLabel(t), active: t.active });
      }
    }

    // Subtitles — "Off" pinned at index 0
    const textTracks = _player.getTextTracks();
    const anySubActive = textTracks.some(t => t.active) && _player.isTextTrackVisible();
    const subtitles = [{ id: null, label: 'Off', active: !anySubActive }];
    for (const t of textTracks) {
      subtitles.push({ id: t.id, label: t.label || t.language || 'Unknown', active: t.active && anySubActive });
    }

    // Quality — sorted by height desc, Auto at top
    const heights = new Set();
    const qualityItems = [];
    for (const t of variantTracks) {
      if (t.height && !heights.has(t.height)) {
        heights.add(t.height);
        qualityItems.push({ id: t.id, label: t.height + 'p', height: t.height });
      }
    }
    qualityItems.sort((a, b) => b.height - a.height);
    const abrEnabled = _player.getConfiguration().abr.enabled;
    const quality = [{ id: null, label: 'Auto', active: abrEnabled }, ...qualityItems.map(q => ({ ...q, active: false }))];

    return { audio, subtitles, quality };
  }

  function setAudioTrack(audioId) {
    if (!_player) return;
    const match = _player.getVariantTracks().filter(t => t.audioId === audioId);
    if (match.length) _player.selectVariantTrack(match[0], true);
  }

  function setSubtitleTrack(id) {
    if (!_player) return;
    if (id === null) { _player.setTextTrackVisibility(false); return; }
    const track = _player.getTextTracks().find(t => t.id === id);
    if (track) { _player.selectTextTrack(track); _player.setTextTrackVisibility(true); }
  }

  function setQuality(id) {
    if (!_player) return;
    if (id === null) { _player.configure({ abr: { enabled: true } }); return; }
    const track = _player.getVariantTracks().find(t => t.id === id);
    if (track) { _player.configure({ abr: { enabled: false } }); _player.selectVariantTrack(track, true); }
  }

  function updateMediaSession(ch) {
    if (typeof webOS === 'undefined' || !webOS.service) return;
    webOS.service.request('luna://com.webos.service.mediacontroller', {
      method: 'registerMediaSession',
      parameters: {
        mediaId: 'com.outkst.iptvultra',
        title:  ch ? ch.name  || '' : '',
        artist: ch ? ch.group || '' : '',
        mediaType:  'video',
        playStatus: _video && !_video.paused ? 'playing' : 'paused',
      },
      onSuccess: () => {},
      onFailure: e => console.warn('mediacontroller:', e),
    });
  }

  function destroy() {
    _stopTrickPlay();
    if (_player) { _player.destroy(); _player = null; }
    _video = null;
    _isDVR = false;
    _rateIndex = 2;
  }

  // Accessors used by script.js key handlers
  function getTrickState()     { return _trickState; }
  function isHolding()         { return _holdDir !== null; }
  function getRateIndex()      { return _rateIndex; }
  function getPlaybackRates()  { return [...PLAYBACK_RATES]; }
  function updateSeekBar()     { _updateSeekBar(); }

  return {
    init, loadChannel, seekBy,
    startHold, stopHold, goToLive,
    setRate, changeRate,
    getSeekInfo, getStats, getTrackLists,
    setAudioTrack, setSubtitleTrack, setQuality,
    updateMediaSession, destroy,
    getTrickState, isHolding, getRateIndex, getPlaybackRates, updateSeekBar,
  };
})();
```

- [ ] **Step 1.3: Verify syntax**

```powershell
node -c IPTVUltra/playback.js
```

Expected: no output (no errors).

- [ ] **Step 1.4: Commit scaffold**

```
git add IPTVUltra/playback.js
git commit -m "feat: scaffold playback.js module with Shaka wrapper API stubs"
```

---

## Task 2: Load Shaka CDN and wire `playback.init()`

**Files:**
- Modify: `IPTVUltra/index.html:4-9` (head) and `IPTVUltra/index.html:193` (script tag)
- Modify: `IPTVUltra/script.js:50` (after DOM element declarations)

- [ ] **Step 2.1: Add Shaka CDN script and playback.js to index.html**

In `IPTVUltra/index.html`, find the `<head>` block (lines 4–9). Add the Shaka CDN script after the stylesheet link:

```html
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>IPTV Ultra - webOS Player</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.jsdelivr.net/npm/shaka-player@5.1.5/dist/shaka-player.compiled.js"></script>
</head>
```

Then find line 193 (`<script src="script.js"></script>`) and add `playback.js` before it:

```html
  <script src="playback.js"></script>
  <script src="script.js"></script>
```

- [ ] **Step 2.2: Call `playback.init()` at the bottom of script.js**

Find the initialization block at the very bottom of `IPTVUltra/script.js` (the section starting with `// ----- Initialization -----`, around line 2015). Add `playback.init(videoPlayer)` as the first line of that block:

```js
// ----- Initialization -----
playback.init(videoPlayer);
const savedFavs = localStorage.getItem('iptv_favorites');
// ... rest unchanged
```

- [ ] **Step 2.3: Verify Shaka loads**

Open `IPTVUltra/index.html` in Chrome or run `ares-inspect`. Open the console.

Expected: No `shaka is not defined` errors. Type `playback` in the console — should return the module object (not undefined).

- [ ] **Step 2.4: Commit**

```
git add IPTVUltra/index.html IPTVUltra/script.js
git commit -m "feat: load Shaka 5.1.5 CDN, call playback.init() on startup"
```

---

## Task 3: Wire `selectChannel()` to `playback.loadChannel()`

**Files:**
- Modify: `IPTVUltra/script.js:776-804` (`selectChannel` function)

- [ ] **Step 3.1: Replace video manipulation in `selectChannel`**

Find `function selectChannel(index)` (line 776). Replace lines 781–784 (the pause/src/load/play block) with a `playback.loadChannel` call. Also call `playback.updateMediaSession` after the channel info update:

```js
function selectChannel(index) {
    if (!channels[index]) return;
    if (currentChannelIndex >= 0 && currentChannelIndex !== index) lastChannelIndex = currentChannelIndex;
    currentChannelIndex = index;
    const ch = channels[index];
    playback.loadChannel(ch.url).catch(err => {
        statusArea.innerText = `⚠️ Failed to load stream: ${err.message || err}`;
    });
    channelInfoTag.innerText = `📺 ${ch.name}`;
    statusArea.innerText = `▶️ ${ch.name}`;
    playback.updateMediaSession(ch);
    if (epgMode) {
        for (const [, el] of epgRenderedRows) el.classList.remove('active');
        const filteredIdx = currentFilteredChannels.indexOf(ch);
        if (filteredIdx >= 0 && epgRenderedRows.has(filteredIdx)) epgRenderedRows.get(filteredIdx).classList.add('active');
        updateEPGInfoPanel(ch);
    } else {
        renderChannelList();
    }
    updateNowNext();
    showTopControls();
    if (subtitlePanelOpen) { subtitlePanel.classList.add('hidden'); subtitlePanelOpen = false; }
    if (audioPanelOpen) { audioPanel.classList.add('hidden'); audioPanelOpen = false; }
    setTimeout(function () { updateSubtitleButton(); updateAudioButton(); }, 4000);
}
```

- [ ] **Step 3.2: Remove the existing stream reload that also uses `videoPlayer.src` directly**

Find `function reloadStream()` (around line 1040). It currently does:

```js
function reloadStream() {
    const wasPlaying = !videoPlayer.paused;
    videoPlayer.pause();
    videoPlayer.src = url;
    videoPlayer.load();
    if (wasPlaying) videoPlayer.play().catch(e => console.log);
}
```

Replace with:

```js
function reloadStream() {
    if (currentChannelIndex >= 0 && channels[currentChannelIndex]) {
        playback.loadChannel(channels[currentChannelIndex].url).catch(() => {});
    }
}
```

- [ ] **Step 3.3: Verify channels play**

Load the app, add an Xtream or M3U playlist, select a channel.

Expected: Channel plays. Console shows no errors. `videoPlayer.src` is no longer set directly.

- [ ] **Step 3.4: Commit**

```
git add IPTVUltra/script.js
git commit -m "feat: selectChannel and reloadStream use playback.loadChannel()"
```

---

## Task 4: Add playback panel HTML and CSS

**Files:**
- Modify: `IPTVUltra/index.html` — add `#playbackPanel` inside `#videoArea` and `#epgVideoWrap`
- Modify: `IPTVUltra/style.css` — add gradient panel + seek bar styles

- [ ] **Step 4.1: Add the playback panel HTML to `#videoArea`**

In `IPTVUltra/index.html`, find `<div class="video-area" id="videoArea">` (line 114). Add the playback panel inside it, after the existing `#channelInfoTag` div:

```html
<div id="channelInfoTag" class="channel-info-tag"></div>
<div id="playbackPanel" class="playback-panel" style="display:none;">
  <div class="pb-toprow">
    <div id="pbTrickBadge" class="pb-trick-badge" style="display:none;"></div>
    <div id="pbRateBadge" class="pb-rate-badge" style="display:none;"></div>
    <div style="flex:1;"></div>
    <button id="pbLiveBtn" class="pb-live-btn">● LIVE</button>
    <button id="pbGearBtn" class="pb-gear-btn">⚙</button>
  </div>
  <div class="pb-seek-row">
    <div id="pbSeekTrack" class="pb-seek-track">
      <div id="pbSeekFill" class="pb-seek-fill"></div>
      <div id="pbSeekThumb" class="pb-seek-thumb"></div>
    </div>
  </div>
  <div class="pb-timerow">
    <span id="pbTimeOffset">At live edge</span>
    <span>Live</span>
  </div>
</div>
```

Also add the same `#playbackPanel` clone inside `<div class="epg-video-wrap" id="epgVideoWrap">`. The EPG panel needs a distinct ID to avoid duplicate IDs — use class-based targeting, or since the panel moves with the `<video>` element between the two containers (via `enterEPGMode`'s `wrap.appendChild(videoPlayer)`), add the panel as a sibling of `videoPlayer` and let it move with the video. The cleanest approach: make `#playbackPanel` a direct sibling of `#videoPlayer` in the DOM. When `enterEPGMode` moves `videoPlayer` into `epgVideoWrap`, also move `playbackPanel`:

Find in `script.js` the `enterEPGMode` function around line 1165. Inside it, find the block that moves `videoPlayer`:

```js
const wrap = document.getElementById('epgVideoWrap');
if (wrap) {
    if (videoPlayer.parentNode !== wrap) wrap.appendChild(videoPlayer);
    if (streamInfoOverlay.parentNode !== wrap) wrap.appendChild(streamInfoOverlay);
}
```

Update to also move the playback panel:

```js
const wrap = document.getElementById('epgVideoWrap');
const panel = document.getElementById('playbackPanel');
const settPanel = document.getElementById('settingsPanel');
if (wrap) {
    if (videoPlayer.parentNode !== wrap) wrap.appendChild(videoPlayer);
    if (panel && panel.parentNode !== wrap) wrap.appendChild(panel);
    if (settPanel && settPanel.parentNode !== wrap) wrap.appendChild(settPanel);
}
```

Remove the `streamInfoOverlay` line from `enterEPGMode` since that overlay is being deleted.

- [ ] **Step 4.2: Add CSS for the gradient panel**

Add to the end of `IPTVUltra/style.css`:

```css
/* ── Playback Panel ──────────────────────────────── */
.playback-panel {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.92) 28%);
    padding: 32px 22px 16px;
    z-index: 50;
    pointer-events: auto;
}

.pb-toprow {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
}

.pb-trick-badge {
    background: rgba(42, 74, 204, 0.65);
    border: 1.5px solid #4a6aff;
    color: #a3c0ff;
    font-size: 0.82rem;
    font-weight: 700;
    padding: 4px 12px;
    border-radius: 6px;
    white-space: nowrap;
    backdrop-filter: blur(6px);
}

.pb-rate-badge {
    color: rgba(255, 255, 255, 0.55);
    font-size: 0.75rem;
    white-space: nowrap;
}

.pb-live-btn {
    background: #e74c3c;
    color: #fff;
    font-size: 0.7rem;
    font-weight: 700;
    padding: 4px 10px;
    border-radius: 5px;
    border: none;
    cursor: pointer;
    white-space: nowrap;
}

.pb-live-btn.at-live {
    background: #555;
    color: #aaa;
}

.pb-gear-btn {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(42, 74, 204, 0.5);
    border: 1.5px solid #6c8eff;
    color: #fff;
    font-size: 1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.pb-gear-btn:focus,
.pb-gear-btn.focused {
    outline: 2px solid #6c8eff;
    outline-offset: 2px;
}

.pb-seek-row {
    margin-bottom: 5px;
}

.pb-seek-track {
    height: 5px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    position: relative;
    cursor: pointer;
}

.pb-seek-fill {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    background: #6c8eff;
    border-radius: 3px;
    width: 100%;
}

.pb-seek-thumb {
    position: absolute;
    top: 50%;
    width: 15px;
    height: 15px;
    background: #fff;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 6px rgba(0, 0, 0, 0.6);
    left: 100%;
}

.pb-timerow {
    display: flex;
    justify-content: space-between;
    font-size: 0.68rem;
    color: rgba(255, 255, 255, 0.4);
}
```

- [ ] **Step 4.3: Verify panel HTML is present**

Open `IPTVUltra/index.html` in a browser. Open DevTools → Elements. Confirm `#playbackPanel` exists inside `#videoArea`. It should have `display:none`.

- [ ] **Step 4.4: Commit**

```
git add IPTVUltra/index.html IPTVUltra/script.js IPTVUltra/style.css
git commit -m "feat: add gradient playback panel HTML and CSS"
```

---

## Task 5: Show/hide panel in fullscreen + seek bar update loop

**Files:**
- Modify: `IPTVUltra/script.js` — add fullscreen panel show/hide and seek bar interval

- [ ] **Step 5.1: Add panel show/hide to `showTopControls` and fullscreen change**

Find `function showTopControls()` (line 807). At the end of the function, add:

```js
function showTopControls() {
    const c = document.getElementById('topControls');
    c.classList.add('visible');
    const cr = document.getElementById('topControlsRight');
    if (cr) cr.classList.add('visible');
    if (_topControlsTimer) clearTimeout(_topControlsTimer);
    _topControlsTimer = setTimeout(() => {
        c.classList.remove('visible');
        if (cr) cr.classList.remove('visible');
    }, 3000);

    // Show playback panel only when fullscreen
    if (document.fullscreenElement) {
        const panel = document.getElementById('playbackPanel');
        if (panel) {
            panel.style.display = '';
            if (_pbPanelTimer) clearTimeout(_pbPanelTimer);
            _pbPanelTimer = setTimeout(() => {
                const sp = document.getElementById('settingsPanel');
                if (!sp || sp.style.display === 'none') {
                    if (panel) panel.style.display = 'none';
                }
            }, 3000);
        }
    }
}
```

Declare `_pbPanelTimer` near the other timer variables at the top of `script.js` (find `let _topControlsTimer`):

```js
let _topControlsTimer = null;
let _pbPanelTimer = null;
```

- [ ] **Step 5.2: Hide panel when exiting fullscreen**

Find `document.addEventListener('fullscreenchange', ...)` near the bottom of `script.js` (around line 2010). Update it:

```js
document.addEventListener('fullscreenchange', () => {
    showTopControls();
    if (!document.fullscreenElement) {
        const panel = document.getElementById('playbackPanel');
        if (panel) panel.style.display = 'none';
        const sp = document.getElementById('settingsPanel');
        if (sp) sp.style.display = 'none';
    }
});
```

- [ ] **Step 5.3: Add seek bar update interval**

At the bottom of `script.js`, just before the `// ----- Initialization -----` block, add:

```js
// Seek bar update — fires every 500ms while panel is visible
setInterval(() => {
    if (document.fullscreenElement) playback.updateSeekBar();
}, 500);
```

- [ ] **Step 5.4: Wire the LIVE button**

After `playback.init(videoPlayer)` in the initialization block, add:

```js
const pbLiveBtn = document.getElementById('pbLiveBtn');
if (pbLiveBtn) pbLiveBtn.addEventListener('click', () => { playback.goToLive(); showTopControls(); });
```

- [ ] **Step 5.5: Verify seek bar in fullscreen**

Load a channel. Enter fullscreen (click the video area or use the remote). The gradient panel should appear. The seek bar thumb should be at the right edge (live). Press a remote key — panel should appear and auto-hide after 3 seconds. Exit fullscreen — panel should disappear.

- [ ] **Step 5.6: Commit**

```
git add IPTVUltra/script.js
git commit -m "feat: seek bar update loop, playback panel show/hide in fullscreen"
```

---

## Task 6: Add settings panel HTML and CSS

**Files:**
- Modify: `IPTVUltra/index.html` — add `#settingsPanel` after `#playbackPanel`
- Modify: `IPTVUltra/style.css` — add settings panel styles

- [ ] **Step 6.1: Add `#settingsPanel` HTML**

In `IPTVUltra/index.html`, add `#settingsPanel` immediately after `#playbackPanel`:

```html
<div id="settingsPanel" class="settings-panel" style="display:none;">
  <div class="sp-categories" id="spCategories">
    <div class="sp-cat" data-cat="audio">🔊 Audio <span class="sp-arrow">›</span></div>
    <div class="sp-cat" data-cat="subtitles">💬 Subtitles <span class="sp-arrow">›</span></div>
    <div class="sp-cat" data-cat="quality">📺 Quality <span class="sp-arrow">›</span></div>
    <div class="sp-cat" data-cat="speed">▶ Speed <span class="sp-arrow">›</span></div>
    <div class="sp-cat" data-cat="info">ℹ️ Stream Info <span class="sp-arrow">›</span></div>
  </div>
  <div class="sp-subopts" id="spSubopts"></div>
</div>
```

- [ ] **Step 6.2: Add settings panel CSS**

Append to `IPTVUltra/style.css`:

```css
/* ── Settings Panel ──────────────────────────────── */
.settings-panel {
    position: absolute;
    right: 18px;
    bottom: 82px;
    background: rgba(10, 12, 22, 0.97);
    border: 1px solid #2a3050;
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    backdrop-filter: blur(14px);
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.8);
    z-index: 60;
}

.sp-categories {
    width: 145px;
    border-right: 1px solid rgba(108, 142, 255, 0.15);
    padding: 8px 0;
    flex-shrink: 0;
}

.sp-cat {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px 14px;
    font-size: 0.77rem;
    color: #888;
    cursor: pointer;
    white-space: nowrap;
}

.sp-cat .sp-arrow {
    font-size: 0.6rem;
    color: #444;
}

.sp-cat.active {
    color: #fff;
    background: rgba(42, 74, 204, 0.3);
}

.sp-cat.active .sp-arrow {
    color: #6c8eff;
}

.sp-cat.focused {
    background: rgba(42, 74, 204, 0.2);
    color: #fff;
}

.sp-subopts {
    width: 210px;
    padding: 8px 0;
    max-height: 280px;
    overflow-y: auto;
}

.sp-subopts::-webkit-scrollbar { width: 3px; }
.sp-subopts::-webkit-scrollbar-thumb { background: #2a3050; border-radius: 2px; }

.sp-subheader {
    font-size: 0.58rem;
    color: #6c8eff;
    text-transform: uppercase;
    letter-spacing: 1px;
    padding: 4px 14px 6px;
    border-bottom: 1px solid rgba(108, 142, 255, 0.12);
    margin-bottom: 4px;
    display: block;
}

.sp-opt {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 14px;
    font-size: 0.75rem;
    color: #999;
    cursor: pointer;
}

.sp-opt.active { color: #fff; font-weight: 600; }
.sp-opt.active .sp-check { color: #6c8eff; }
.sp-opt.focused { background: rgba(42, 74, 204, 0.35); color: #fff; }
.sp-check { font-size: 0.7rem; color: transparent; flex-shrink: 0; }

/* Speed chips */
.sp-speeds { display: flex; gap: 6px; padding: 8px 14px; flex-wrap: wrap; }
.sp-chip {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: #aaa;
    font-size: 0.72rem;
    padding: 4px 10px;
    border-radius: 20px;
    cursor: pointer;
}
.sp-chip.active { background: rgba(42, 74, 204, 0.6); border-color: #4a6aff; color: #fff; font-weight: 700; }
.sp-chip.focused { border-color: #6c8eff; color: #fff; }

/* Stream info rows */
.si-section-sp { padding: 6px 14px 2px; }
.si-label-sp {
    font-size: 0.57rem;
    color: #6c8eff;
    text-transform: uppercase;
    letter-spacing: 1px;
    border-bottom: 1px solid rgba(108, 142, 255, 0.15);
    padding-bottom: 4px;
    margin-bottom: 4px;
    display: block;
}
.si-row-sp {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 3px 0;
    font-size: 0.72rem;
}
.si-key-sp { color: #666; }
.si-val-sp { color: #ccc; font-family: monospace; font-size: 0.7rem; }
.si-val-sp.good { color: #2ecc71; }
.si-val-sp.warn { color: #f39c12; }
.si-divider-sp { height: 1px; background: rgba(255,255,255,0.05); margin: 5px 14px; }
```

- [ ] **Step 6.3: Wire the gear button to open settings**

In `script.js`, add settings state variables near the top (after `let _pbPanelTimer = null;`):

```js
let _settingsOpen = false;
let _settingsFocus = 'categories'; // 'categories' | 'subopts'
let _settingsCatIdx = 0;           // 0–4
let _settingsOptIdx = 0;           // index in current sub-list
let _settingsStatsInterval = null;
```

Then wire the gear button in the initialization block (after `pbLiveBtn` wiring):

```js
const pbGearBtn = document.getElementById('pbGearBtn');
if (pbGearBtn) pbGearBtn.addEventListener('click', () => { _openSettings(); });
```

Add the `_openSettings()` and `_closeSettings()` functions near the bottom of `script.js` (before the initialization block):

```js
function _openSettings() {
    _settingsOpen = true;
    _settingsFocus = 'categories';
    _settingsCatIdx = 0;
    _settingsOptIdx = 0;
    const sp = document.getElementById('settingsPanel');
    if (sp) sp.style.display = '';
    _renderSettingsCategories();
    _clearSettingsSubopts();
    // Keep playback panel visible while settings open
    if (_pbPanelTimer) { clearTimeout(_pbPanelTimer); _pbPanelTimer = null; }
}

function _closeSettings() {
    _settingsOpen = false;
    const sp = document.getElementById('settingsPanel');
    if (sp) sp.style.display = 'none';
    if (_settingsStatsInterval) { clearInterval(_settingsStatsInterval); _settingsStatsInterval = null; }
}

function _renderSettingsCategories() {
    const cats = document.querySelectorAll('#spCategories .sp-cat');
    cats.forEach((el, i) => {
        el.classList.toggle('active', false);
        el.classList.toggle('focused', i === _settingsCatIdx);
    });
}

function _clearSettingsSubopts() {
    const sub = document.getElementById('spSubopts');
    if (sub) sub.innerHTML = '<span style="color:#333;font-size:0.75rem;padding:14px;display:block;">Select a category</span>';
}
```

- [ ] **Step 6.4: Verify settings panel opens**

Enter fullscreen. Press the gear button (via mouse in DevTools or remote). The panel should appear. Pressing gear again should close it. The sub-panel shows "Select a category".

- [ ] **Step 6.5: Commit**

```
git add IPTVUltra/index.html IPTVUltra/style.css IPTVUltra/script.js
git commit -m "feat: settings panel HTML, CSS, open/close logic"
```

---

## Task 7: Settings — Audio, Subtitles, Quality sub-lists

**Files:**
- Modify: `IPTVUltra/script.js` — implement sub-list population and track selection

- [ ] **Step 7.1: Add `_enterSettingsSubopts()` and sub-list builders**

Add these functions to `script.js` (in the settings functions area from Task 6):

```js
const SETTINGS_CATS = ['audio', 'subtitles', 'quality', 'speed', 'info'];

function _enterSettingsSubopts() {
    _settingsFocus = 'subopts';
    _settingsOptIdx = 0;
    const cat = SETTINGS_CATS[_settingsCatIdx];
    if (cat === 'audio')     _buildAudioSublist();
    if (cat === 'subtitles') _buildSubtitleSublist();
    if (cat === 'quality')   _buildQualitySublist();
    if (cat === 'speed')     _buildSpeedSublist();
    if (cat === 'info')      _buildStreamInfoSublist();
    // Mark active category
    document.querySelectorAll('#spCategories .sp-cat').forEach((el, i) => {
        el.classList.toggle('active', i === _settingsCatIdx);
        el.classList.toggle('focused', false);
    });
}

function _buildTrackSublist(header, items, onSelect) {
    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    sub.innerHTML = '';
    const h = document.createElement('span');
    h.className = 'sp-subheader';
    h.textContent = header;
    sub.appendChild(h);
    items.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'sp-opt' + (item.active ? ' active' : '') + (i === _settingsOptIdx ? ' focused' : '');
        div.innerHTML = `<span>${escapeHtml(item.label)}</span><span class="sp-check">${item.active ? '✓' : ''}</span>`;
        div.addEventListener('click', () => { onSelect(item); _enterSettingsSubopts(); });
        sub.appendChild(div);
    });
}

function _buildAudioSublist() {
    const { audio } = playback.getTrackLists();
    _buildTrackSublist('Audio Track', audio, item => playback.setAudioTrack(item.id));
}

function _buildSubtitleSublist() {
    const { subtitles } = playback.getTrackLists();
    _buildTrackSublist('Subtitle Track', subtitles, item => playback.setSubtitleTrack(item.id));
}

function _buildQualitySublist() {
    const { quality } = playback.getTrackLists();
    _buildTrackSublist('Video Quality', quality, item => playback.setQuality(item.id));
}

function _updateSettingsOptFocus() {
    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    const cat = SETTINGS_CATS[_settingsCatIdx];
    if (cat === 'speed') {
        sub.querySelectorAll('.sp-chip').forEach((el, i) => el.classList.toggle('focused', i === _settingsOptIdx));
    } else if (cat === 'info') {
        // info is read-only, no focus update needed
    } else {
        sub.querySelectorAll('.sp-opt').forEach((el, i) => el.classList.toggle('focused', i === _settingsOptIdx));
    }
}

function _selectCurrentSettingsOpt() {
    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    const cat = SETTINGS_CATS[_settingsCatIdx];
    if (cat === 'speed') {
        const chips = sub.querySelectorAll('.sp-chip');
        if (chips[_settingsOptIdx]) chips[_settingsOptIdx].click();
        return;
    }
    const opts = sub.querySelectorAll('.sp-opt');
    if (opts[_settingsOptIdx]) opts[_settingsOptIdx].click();
}
```

- [ ] **Step 7.2: Verify Audio and Subtitles sub-lists**

Enter fullscreen. Open settings. Navigate to Audio category (Up/Down not wired yet — use mouse in DevTools to click). Click Audio. The sub-list should show available audio tracks from the loaded stream.

- [ ] **Step 7.3: Commit**

```
git add IPTVUltra/script.js
git commit -m "feat: settings Audio/Subtitles/Quality sub-lists using Shaka track APIs"
```

---

## Task 8: Settings — Speed sub-panel

**Files:**
- Modify: `IPTVUltra/script.js`

- [ ] **Step 8.1: Add `_buildSpeedSublist()`**

Add in the settings functions area:

```js
function _buildSpeedSublist() {
    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    sub.innerHTML = '';
    const h = document.createElement('span');
    h.className = 'sp-subheader';
    h.textContent = 'Playback Speed';
    sub.appendChild(h);
    const wrap = document.createElement('div');
    wrap.className = 'sp-speeds';
    const rates = playback.getPlaybackRates();
    const currentIdx = playback.getRateIndex();
    rates.forEach((rate, i) => {
        const chip = document.createElement('div');
        chip.className = 'sp-chip' + (i === currentIdx ? ' active' : '') + (i === _settingsOptIdx ? ' focused' : '');
        chip.textContent = rate + '×';
        chip.addEventListener('click', () => {
            playback.setRate(rate);
            _buildSpeedSublist(); // refresh to show new active chip
        });
        wrap.appendChild(chip);
    });
    sub.appendChild(wrap);
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:4px 14px;font-size:0.68rem;color:#444;';
    hint.textContent = '▲/▼ also changes speed when not in settings';
    sub.appendChild(hint);
}
```

- [ ] **Step 8.2: Verify Speed sub-panel**

Open settings → Speed. Five chips should appear (0.5×, 0.75×, 1×, 1.5×, 2×). Click 0.75×. The chip becomes active. The video playback rate changes. The rate badge appears in the panel.

- [ ] **Step 8.3: Commit**

```
git add IPTVUltra/script.js
git commit -m "feat: settings Speed sub-panel with playback rate chips"
```

---

## Task 9: Settings — Stream Info sub-panel

**Files:**
- Modify: `IPTVUltra/script.js`

- [ ] **Step 9.1: Add `_buildStreamInfoSublist()` and auto-refresh**

```js
function _buildStreamInfoSublist() {
    if (_settingsStatsInterval) clearInterval(_settingsStatsInterval);
    _renderStreamInfo();
    _settingsStatsInterval = setInterval(_renderStreamInfo, 1000);
}

function _renderStreamInfo() {
    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    const s = playback.getStats();
    if (!s) { sub.innerHTML = '<span style="color:#555;padding:14px;display:block;font-size:0.75rem;">No stream loaded</span>'; return; }

    function row(key, val, cls) {
        return `<div class="si-row-sp"><span class="si-key-sp">${key}</span><span class="si-val-sp ${cls || ''}">${escapeHtml(String(val))}</span></div>`;
    }
    function section(title, rows) {
        return `<div class="si-section-sp"><span class="si-label-sp">${title}</span>${rows}</div>`;
    }
    function divider() { return '<div class="si-divider-sp"></div>'; }
    function valCls(dropped) { return dropped === 0 ? 'good' : 'warn'; }

    const res = s.width && s.height ? `${s.width} × ${s.height}` : '—';
    sub.innerHTML =
        section('Video',
            row('Resolution', res) +
            row('Frame Rate', s.frameRate) +
            row('Codec', s.videoCodec) +
            row('Bitrate', s.bandwidth)
        ) +
        divider() +
        section('Audio',
            row('Codec', s.audioCodec)
        ) +
        divider() +
        section('Network',
            row('Est. Bandwidth', s.estimatedBandwidth, 'good') +
            row('Live Latency', s.liveLatency) +
            row('Buffer Ahead', s.bufferAhead)
        ) +
        divider() +
        section('Playback',
            row('Dropped Frames', s.droppedFrames, valCls(s.droppedFrames)) +
            row('Corrupted', s.corruptedFrames, valCls(s.corruptedFrames)) +
            row('Load Time', s.loadLatency)
        );
}
```

Also stop the stats interval when closing settings (already done in `_closeSettings()` from Task 6 — confirm `_settingsStatsInterval` is cleared there).

- [ ] **Step 9.2: Verify Stream Info**

Open settings → Stream Info. Stats should appear and update every second. Dropped frames should be green (0). If no stream is loaded, shows "No stream loaded".

- [ ] **Step 9.3: Commit**

```
git add IPTVUltra/script.js
git commit -m "feat: settings Stream Info sub-panel with live Shaka stats"
```

---

## Task 10: Remove old stream info code and buttons

**Files:**
- Modify: `IPTVUltra/index.html` — remove `#infoBtn`, `#epgInfoBtn`, `#streamInfoOverlay`
- Modify: `IPTVUltra/script.js` — remove `showStreamInfo`, related event listeners and DOM refs
- Modify: `IPTVUltra/style.css` — remove `.stream-info-overlay` rules

- [ ] **Step 10.1: Remove buttons and overlay from `index.html`**

Remove these three elements:

```html
<!-- Remove this line: -->
<button id="infoBtn" class="top-control-btn">ℹ️ Stream Info</button>

<!-- Remove this line: -->
<button id="epgInfoBtn" class="top-control-btn">ℹ️ Stream Info</button>

<!-- Remove this line: -->
<div id="streamInfoOverlay" class="stream-info-overlay" style="opacity:0;"></div>
```

- [ ] **Step 10.2: Remove from `script.js`**

Remove these lines/blocks:

1. Line 55: `const streamInfoOverlay = document.getElementById('streamInfoOverlay');`
2. Line 57: `const infoBtn = document.getElementById('infoBtn');`
3. Line 87: `const epgInfoBtn = document.getElementById('epgInfoBtn');`
4. The entire `function showStreamInfo()` block (lines 828–896)
5. Line ~1023: any `if (parseFloat(streamInfoOverlay...` reference inside `showTopControls`
6. Line 1180: `if (streamInfoOverlay.parentNode !== wrap) wrap.appendChild(streamInfoOverlay);` inside `enterEPGMode`
7. Line 1914: `infoBtn.addEventListener('click', ...)`
8. Line 1915: `if (epgInfoBtn) epgInfoBtn.addEventListener('click', ...)`
9. Lines 1960–1961: `videoPlayer.addEventListener('loadedmetadata', function () { showStreamInfo(); ...` — keep the `updateSubtitleButton(); updateAudioButton()` part, just remove `showStreamInfo()` calls
10. `videoPlayer.addEventListener('resize', showStreamInfo);`

Also remove `let infoHideTimeout` declaration if present.

The updated `loadedmetadata` listener becomes:
```js
videoPlayer.addEventListener('loadedmetadata', function () { updateSubtitleButton(); updateAudioButton(); });
```

- [ ] **Step 10.3: Remove `.stream-info-overlay` CSS**

In `IPTVUltra/style.css`, find and delete the entire `.stream-info-overlay` block and all `.si-section`, `.si-label`, `.si-row`, `.si-key`, `.si-val`, `.si-sub` rules. These are replaced by the new `.si-section-sp` etc. rules added in Task 6.

- [ ] **Step 10.4: Verify no broken references**

```powershell
node -c IPTVUltra/script.js
```

Open in browser — confirm no `Cannot read properties of null` errors in the console related to `infoBtn`, `streamInfoOverlay`, or `epgInfoBtn`.

- [ ] **Step 10.5: Commit**

```
git add IPTVUltra/index.html IPTVUltra/script.js IPTVUltra/style.css
git commit -m "feat: remove old stream info buttons and overlay, replaced by settings panel"
```

---

## Task 11: Settings panel remote navigation

**Files:**
- Modify: `IPTVUltra/script.js` — wire Up/Down/Left/Right/Enter/Back to settings nav when open

- [ ] **Step 11.1: Add settings key handling inside `handleRemoteNav`**

Find `function handleRemoteNav(e)` (around line 1804). At the very top of the function, add a settings-open guard that intercepts all keys when the panel is open:

```js
function handleRemoteNav(e) {
    // Settings panel takes over all remote nav when open
    if (_settingsOpen && document.fullscreenElement) {
        _handleSettingsKey(e);
        return;
    }
    // ... existing EPG and standard nav below unchanged
```

Add the `_handleSettingsKey` function in the settings functions area:

```js
function _handleSettingsKey(e) {
    const key = e.key;
    const isUp    = key === 'ArrowUp'    || e.keyCode === 38;
    const isDown  = key === 'ArrowDown'  || e.keyCode === 40;
    const isLeft  = key === 'ArrowLeft'  || e.keyCode === 37;
    const isRight = key === 'ArrowRight' || e.keyCode === 39;
    const isEnter = key === 'Enter'      || e.keyCode === 13;
    const isBack  = e.keyCode === 461;

    e.preventDefault();

    if (_settingsFocus === 'categories') {
        const catCount = SETTINGS_CATS.length;
        if (isUp)    { _settingsCatIdx = Math.max(0, _settingsCatIdx - 1); _renderSettingsCategories(); }
        if (isDown)  { _settingsCatIdx = Math.min(catCount - 1, _settingsCatIdx + 1); _renderSettingsCategories(); }
        if (isRight || isEnter) { _enterSettingsSubopts(); }
        if (isLeft || isBack)   { _closeSettings(); }
        return;
    }

    // focus === 'subopts'
    const cat = SETTINGS_CATS[_settingsCatIdx];
    if (isLeft || isBack) {
        _settingsFocus = 'categories';
        _settingsOptIdx = 0;
        _renderSettingsCategories();
        if (_settingsStatsInterval) { clearInterval(_settingsStatsInterval); _settingsStatsInterval = null; }
        return;
    }
    if (cat === 'info') return; // read-only, no selection

    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    const isSpeed = cat === 'speed';
    const items = isSpeed ? sub.querySelectorAll('.sp-chip') : sub.querySelectorAll('.sp-opt');
    const count = items.length;
    if (count === 0) return;

    if (isUp || (isSpeed && isLeft)) {
        _settingsOptIdx = Math.max(0, _settingsOptIdx - 1);
        _updateSettingsOptFocus();
    }
    if (isDown || (isSpeed && isRight)) {
        _settingsOptIdx = Math.min(count - 1, _settingsOptIdx + 1);
        _updateSettingsOptFocus();
    }
    if (isEnter) { _selectCurrentSettingsOpt(); }
}
```

- [ ] **Step 11.2: Verify full settings navigation with remote**

Enter fullscreen. Press gear button. Use ▲/▼ to navigate categories. Press ▶ or Enter to enter sub-list. Use ▲/▼ to move through tracks. Press Enter to select. Press ◀ or Back to return to categories. Press ◀ again to close panel.

- [ ] **Step 11.3: Commit**

```
git add IPTVUltra/script.js
git commit -m "feat: settings panel fully navigable by webOS remote"
```

---

## Task 12: Hold-to-rewind / hold-to-FF trick play

**Files:**
- Modify: `IPTVUltra/script.js` — add `keydown`/`keyup` handlers for ◀/▶ in fullscreen

- [ ] **Step 12.1: Add hold detection state variables**

Near the top of `script.js` (after the `_pbPanelTimer` declaration), add:

```js
let _holdKeyDir  = null;  // 'left' | 'right' | null
let _holdKeyStart = 0;
const HOLD_THRESHOLD_MS = 500;
```

- [ ] **Step 12.2: Add `keydown` and `keyup` handlers for hold-to-trick-play**

Add these two event listeners near the bottom of `script.js`, after the existing Enter long-press handlers:

```js
// Hold ◀/▶ in fullscreen: hold-to-rewind / hold-to-FF
document.addEventListener('keydown', (e) => {
    if (!document.fullscreenElement) return;
    if (_settingsOpen) return;
    if (e.repeat) return; // ignore key-repeat; we drive timing ourselves
    const isLeft  = e.key === 'ArrowLeft'  || e.keyCode === 37;
    const isRight = e.key === 'ArrowRight' || e.keyCode === 39;
    if (!isLeft && !isRight) return;
    e.preventDefault();
    _holdKeyDir   = isLeft ? 'left' : 'right';
    _holdKeyStart = Date.now();
    // Show panel so user can see the seek bar / trick badge
    showTopControls();
});

document.addEventListener('keyup', (e) => {
    const isLeft  = e.key === 'ArrowLeft'  || e.keyCode === 37;
    const isRight = e.key === 'ArrowRight' || e.keyCode === 39;
    if (!isLeft && !isRight) return;
    if (!document.fullscreenElement || _settingsOpen) { _holdKeyDir = null; return; }

    e.preventDefault();
    const held = Date.now() - _holdKeyStart;
    const dir  = _holdKeyDir;
    _holdKeyDir = null;

    if (playback.isHolding()) {
        // Was in trick play — stop and resume
        playback.stopHold();
    } else if (held >= HOLD_THRESHOLD_MS) {
        // Held but startHold wasn't called yet (short hold, just at threshold)
        playback.stopHold(); // no-op if not holding
    } else {
        // Short press — single ±3s seek
        playback.seekBy(dir === 'left' ? -3 : 3);
    }
    showTopControls();
});
```

- [ ] **Step 12.3: Wire hold threshold to `startHold`**

The `keydown` handler records `_holdKeyStart` but doesn't call `playback.startHold` immediately (we call it from the seek interval when threshold is met). Instead, use a `setTimeout` approach: after `HOLD_THRESHOLD_MS`, if the key is still down, call `startHold`:

Replace the `keydown` handler with:

```js
document.addEventListener('keydown', (e) => {
    if (!document.fullscreenElement) return;
    if (_settingsOpen) return;
    if (e.repeat) return;
    const isLeft  = e.key === 'ArrowLeft'  || e.keyCode === 37;
    const isRight = e.key === 'ArrowRight' || e.keyCode === 39;
    if (!isLeft && !isRight) return;
    e.preventDefault();
    if (_holdKeyDir) return; // already tracking
    _holdKeyDir   = isLeft ? 'left' : 'right';
    _holdKeyStart = Date.now();
    showTopControls();
    // After hold threshold, start trick play
    setTimeout(() => {
        if (_holdKeyDir === (isLeft ? 'left' : 'right')) {
            playback.startHold(_holdKeyDir);
        }
    }, HOLD_THRESHOLD_MS);
});
```

- [ ] **Step 12.4: Verify hold-to-rewind**

Load a live stream. Enter fullscreen. Short-press ◀ — video seeks back 3 seconds and resumes. Hold ◀ for 2 seconds — rewind starts at −1×, badge shows `◀◀ 1×`, seek bar thumb moves left. Hold for 6 seconds — badge shows `◀◀ 4×`. Release ◀ — video resumes. Repeat for ▶.

- [ ] **Step 12.5: Commit**

```
git add IPTVUltra/script.js
git commit -m "feat: hold-to-rewind and hold-to-FF with duration-based speed ramp"
```

---

## Task 13: Up/Down playback rate + Back/Return + Enter play/pause

**Files:**
- Modify: `IPTVUltra/script.js`

- [ ] **Step 13.1: Add Up/Down rate change in fullscreen (NORMAL state only)**

In `handleRemoteNav`, the existing EPG Up/Down handling already routes to EPG navigation when `epgMode`. Add a fullscreen-not-EPG-mode block for Up/Down before the EPG block:

At the top of `handleRemoteNav` (after the `_settingsOpen` guard), add:

```js
    // Up/Down in fullscreen (non-EPG): adjust playback rate
    if (document.fullscreenElement && !epgMode && !_settingsOpen) {
        const isUp   = e.key === 'ArrowUp'   || e.keyCode === 38;
        const isDown = e.key === 'ArrowDown'  || e.keyCode === 40;
        if (isUp || isDown) {
            e.preventDefault();
            playback.changeRate(isUp ? 1 : -1);
            showTopControls();
            return;
        }
    }
```

- [ ] **Step 13.2: Update the Enter key handler to not conflict**

The existing Enter long-press handler (lines 1983–2008) handles long-press (switch to last channel) and short-press (play/pause). This is correct and unchanged — Shaka's `_video.paused` / `_video.play()` still works the same way. No changes needed here.

- [ ] **Step 13.3: Add Back/Return (keyCode 461) handler**

Add a new `keydown` listener for Back/Return. Add after the Enter long-press handlers:

```js
// Back/Return button — context-dependent behavior
document.addEventListener('keydown', (e) => {
    if (e.keyCode !== 461 && e.key !== 'GoBack') return;

    // Settings panel: close sub-list first, then panel
    if (_settingsOpen) {
        e.preventDefault();
        if (_settingsFocus === 'subopts') {
            _settingsFocus = 'categories';
            _settingsOptIdx = 0;
            _renderSettingsCategories();
            if (_settingsStatsInterval) { clearInterval(_settingsStatsInterval); _settingsStatsInterval = null; }
        } else {
            _closeSettings();
        }
        return;
    }

    // Fullscreen: exit fullscreen, keep playing
    if (document.fullscreenElement) {
        e.preventDefault();
        document.exitFullscreen();
        return;
    }

    // Main app visible (not start page): confirm return to home
    if (mainApp && mainApp.style.display !== 'none') {
        e.preventDefault();
        // Show confirm dialog if one exists, otherwise go home directly
        if (typeof showConfirmDialog === 'function') {
            showConfirmDialog('Return to home screen?', goToHomeScreen);
        } else {
            goToHomeScreen();
        }
        return;
    }

    // Start page: let webOS handle natively (shows system "Exit app?" prompt)
});
```

- [ ] **Step 13.4: Update `goToHomeScreen` to call `playback.destroy()`**

Find `function goToHomeScreen()` (around line 1053). Add `playback.destroy();` as the first line of the function body after the existing `epgMode = false; currentPlaylistType = null;`:

```js
function goToHomeScreen() {
    if (epgRefreshTimer) { clearInterval(epgRefreshTimer); epgRefreshTimer = null; }
    epgMode = false;
    currentPlaylistType = null;
    playback.destroy();
    playback.init(videoPlayer); // re-initialize for next load
    // ... rest unchanged
```

- [ ] **Step 13.5: Verify Back button behavior**

Enter fullscreen → press Back → exits fullscreen, video keeps playing. From main app (not fullscreen) → press Back → confirm dialog appears. From start page → press Back → webOS shows "Exit app?" (or does nothing if not on TV).

Verify Up/Down in fullscreen changes rate: panel shows rate badge when ≠ 1×.

- [ ] **Step 13.6: Commit**

```
git add IPTVUltra/script.js
git commit -m "feat: Up/Down playback rate, Back/Return context handling, goToHomeScreen resets Shaka"
```

---

## Task 14: webOS mediacontroller + existing audio/subtitle panels cleanup

**Files:**
- Modify: `IPTVUltra/script.js`

- [ ] **Step 14.1: Verify `updateMediaSession` is called on channel load**

`selectChannel` already calls `playback.updateMediaSession(ch)` (added in Task 3). Confirm the call is present.

- [ ] **Step 14.2: Update media session on play/pause**

Find the existing Enter short-press handler that does `videoPlayer.play()` / `videoPlayer.pause()` (around line 2004). After each call, add a media session update:

```js
    if (held >= LONG_PRESS_MS) {
        if (lastChannelIndex >= 0 && channels[lastChannelIndex]) selectChannel(lastChannelIndex);
    } else {
        if (videoPlayer.paused) {
            videoPlayer.play().catch(e => console.log);
        } else {
            videoPlayer.pause();
        }
        if (channels[currentChannelIndex]) playback.updateMediaSession(channels[currentChannelIndex]);
        showTopControls();
    }
```

- [ ] **Step 14.3: Hide `#audioBtn` and `#subtitleBtn` — settings panel replaces them**

The existing Audio and Subtitle buttons in `topControls` are now redundant — the settings panel handles track selection. Hide them permanently in the initialization block:

```js
// Audio/Subtitle buttons replaced by settings panel
if (audioBtn)    audioBtn.style.display    = 'none';
if (subtitleBtn) subtitleBtn.style.display = 'none';
```

> The `updateAudioButton()` and `updateSubtitleButton()` functions can remain but will set display to '' — add a guard at the start of each: `if (!audioBtn || !subtitleBtn) return;`. This prevents null errors but keeps the functions present for future use.

- [ ] **Step 14.4: Verify on TV (if available)**

Install to TV:
```powershell
cd IPTVUltra
ares-package .
ares-install com.outkst.iptvultra_3.0.0_all.ipk --device LivingRoomTV
ares-launch com.outkst.iptvultra --device LivingRoomTV
```

Using the remote:
- Load a channel and confirm it plays
- Hold Back → exits fullscreen
- Hold ◀ → rewinds (badge appears)
- Release → resumes
- Hold ▶ for 6s → FF badge shows `▶▶ 8×`
- Press ⚙ gear → settings panel opens
- Navigate with remote

- [ ] **Step 14.5: Commit**

```
git add IPTVUltra/script.js
git commit -m "feat: mediacontroller play/pause updates, hide redundant audio/subtitle buttons"
```

---

## Task 15: Version bump, package, and final smoke test

**Files:**
- Modify: `IPTVUltra/appinfo.json`

- [ ] **Step 15.1: Bump version to 3.0.0**

In `IPTVUltra/appinfo.json`, change:
```json
  "version": "2.9.3",
```
to:
```json
  "version": "3.0.0",
```

- [ ] **Step 15.2: Package**

```powershell
cd IPTVUltra
ares-package .
```

Expected: `Create com.outkst.iptvultra_3.0.0_all.ipk ... Success`

- [ ] **Step 15.3: Install and launch**

```powershell
ares-install com.outkst.iptvultra_3.0.0_all.ipk --device LivingRoomTV
ares-launch com.outkst.iptvultra --device LivingRoomTV
```

- [ ] **Step 15.4: Smoke test checklist**

- [ ] M3U playlist loads and plays a channel
- [ ] Xtream playlist loads and plays a channel
- [ ] EPG guide shows when Xtream is loaded
- [ ] Entering fullscreen shows gradient panel after key press
- [ ] Seek bar updates position in real time
- [ ] Short ◀ press → seeks back 3s
- [ ] Hold ◀ 2s → rewind at −2×; 6s → −4×; release → resumes
- [ ] Hold ▶ 2s → FF at 4×; release → resumes
- [ ] ▲/▼ in fullscreen changes playback rate; badge shows non-1× rate
- [ ] Gear opens settings panel
- [ ] Settings Audio → shows track list, selection changes audio
- [ ] Settings Subtitles → "Off" at top; selection changes subtitles
- [ ] Settings Quality → Auto + quality levels
- [ ] Settings Speed → chips; selecting one changes playback rate
- [ ] Settings Stream Info → shows resolution, codec, latency, dropped frames
- [ ] Back from sub-list → returns to categories
- [ ] Back from categories → closes panel
- [ ] Back in fullscreen → exits fullscreen, video keeps playing
- [ ] Back on main app → confirm dialog
- [ ] Home → `goToHomeScreen()` runs, Shaka destroyed and re-initialized
- [ ] Old ℹ️ Stream Info buttons are gone

- [ ] **Step 15.5: Commit and tag**

```
git add IPTVUltra/appinfo.json
git commit -m "v3.0.0 — Shaka Player, gradient panel, trick play, settings menu"
git tag v3.0.0
```

---

## Self-Review Notes

- **`playback.init()` called before channels load:** Init is at the top of the initialization block. `playback.loadChannel()` is only called from `selectChannel()`, which requires a playlist to be loaded first. Safe ordering.
- **`playback.destroy()` + `playback.init()` in `goToHomeScreen`:** Destroy clears intervals and the Shaka instance. Re-init immediately after so the next playlist load works. The `videoPlayer` element reference is stable (it's a const from DOM).
- **Hold detection timing:** `setTimeout(HOLD_THRESHOLD_MS)` fires and checks `_holdKeyDir` matches. If `keyup` fires before the timeout (short press), `_holdKeyDir` is cleared and `startHold` is never called. Correct.
- **Settings `_closeSettings()` clears `_settingsStatsInterval`:** Confirmed — the stats loop for Stream Info stops when the panel closes.
- **Old `streamInfoOverlay` reference in `enterEPGMode`:** Removed in Task 10 step 2 (item 6 in the list).
- **`showConfirmDialog` reference in Back handler:** May not exist in the current codebase. The handler falls back to `goToHomeScreen()` directly if not defined. Safe.
- **Shaka `getLiveLatency()` wrapped in try/catch:** Not all stream types expose live latency. The try/catch in `getStats()` prevents crashes on VOD streams.
