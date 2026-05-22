# Shaka Player Integration Design

**Date:** 2026-05-21
**Branch:** `feature/shaka-player`
**Version bump:** `2.9.3` → `3.0.0`

---

## Goals

1. Replace the native HTML5 `<video>` playback management with Shaka Player 5.1.5 for DVR buffering, adaptive bitrate, and richer stream metadata.
2. Add a fullscreen gradient playback panel with seek bar, trick-play OSD, and a two-level settings menu (Audio / Subtitles / Quality / Speed / Stream Info).
3. Implement a trick-play state machine (rewind/FF with speed ramping) driven by the webOS Magic Remote.
4. Register with `com.webos.service.mediacontroller` for system-level media session metadata.
5. Handle Back/Return button context-appropriately (fullscreen exit → home confirm → system quit).
6. Remove the existing `ℹ️ Stream Info` buttons; replace with Shaka-powered Stream Info inside the settings panel.

---

## Stream Type Handling

- **DVR-enabled streams** (HLS/DASH with sliding-window manifest): `player.seekRange()` returns a window > 30s. Seek bar spans the full DVR window. "Go to Live" jumps to `seekRange.end`.
- **Buffer-only live streams** (plain live HLS): `player.seekRange()` window ≤ 30s or equal to buffer. Seek bar spans the buffered range (up to ~120s behind live). Rewind is limited to what Shaka has cached.
- Both types are handled automatically — no user-facing mode switch.

---

## Section 1 — Shaka Player Integration

### Loading

```html
<!-- index.html, in <head> before app scripts -->
<script src="https://cdn.jsdelivr.net/npm/shaka-player@5.1.5/dist/shaka-player.compiled.js"></script>
<script src="playback.js"></script>
```

### Buffer Configuration

```js
player.configure({
  streaming: {
    bufferingGoal: 120,      // buffer 2 minutes ahead
    bufferBehind: 120,       // retain 2 minutes behind current position for rewind
    rebufferingGoal: 2,
    stallEnabled: true,
  },
});
```

### Initialization

`playback.init(videoElement)` is called once on `DOMContentLoaded`. Shaka attaches to the existing `<video id="videoPlayer">` element. All existing event listeners on the element (`loadedmetadata`, `resize`, `textTracks`, `audioTracks`) remain on the element — Shaka does not remove them.

### Channel Loading

`selectChannel()` in `script.js` replaces:
```js
videoPlayer.src = url; videoPlayer.load(); videoPlayer.play();
```
with:
```js
await playback.loadChannel(url);
```

`playback.loadChannel(url)`:
1. Calls `player.load(url)`
2. After load, calls `player.seekRange()` — if `end - start > 30`, sets `isDVR = true`
3. Resets trick-play state to NORMAL
4. Resets seek bar to live edge
5. Calls `videoElement.play()`
6. Updates mediacontroller session metadata

On load error: catches the rejection, logs to console, updates `statusArea` with the error message.

---

## Section 2 — Gradient Panel UI

### HTML Structure

Added inside both `#videoArea` and `#epgVideoWrap` (the panel is hidden unless fullscreen):

```html
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
    <span id="pbTimeOffset"></span>
    <span>Live</span>
  </div>
</div>
```

### Seek Bar Logic

Updated every 500ms while the panel is visible (via `setInterval`):

```js
const range = player.seekRange();          // { start, end }
const current = videoElement.currentTime;
const pct = (current - range.start) / (range.end - range.start) * 100;
pbSeekFill.style.width = pct + '%';
pbSeekThumb.style.left = pct + '%';
const behind = Math.max(0, range.end - current);
pbTimeOffset.textContent = behind < 3 ? 'At live edge' : `-${formatDuration(Math.round(behind))} behind live`;
pbLiveBtn.classList.toggle('at-live', behind < 3);
```

### Panel Visibility

- Shown when user presses any remote key while in fullscreen
- Auto-hides after 3s of inactivity (same `showTopControls` timeout pattern)
- `display:none` when not fullscreen

### Existing Stream Info Buttons Removed

`#infoBtn`, `#epgInfoBtn`, `.stream-info-overlay`, and all related JS (`showStreamInfo`, `infoBtn` event listener) are deleted. Stream info lives exclusively in the settings panel.

---

## Section 3 — Two-Level Settings Panel

### HTML Structure

```html
<div id="settingsPanel" class="settings-panel" style="display:none;">
  <div class="sp-categories" id="spCategories">
    <div class="sp-cat" data-cat="audio">🔊 Audio <span class="sp-arrow">›</span></div>
    <div class="sp-cat" data-cat="subtitles">💬 Subtitles <span class="sp-arrow">›</span></div>
    <div class="sp-cat" data-cat="quality">📺 Quality <span class="sp-arrow">›</span></div>
    <div class="sp-cat" data-cat="speed">▶ Speed <span class="sp-arrow">›</span></div>
    <div class="sp-cat" data-cat="info">ℹ️ Stream Info <span class="sp-arrow">›</span></div>
  </div>
  <div class="sp-subopts" id="spSubopts">
    <span style="color:#333;font-size:0.75rem;">Select a category</span>
  </div>
</div>
```

### Navigation State

```js
let settingsOpen = false;
let settingsFocus = 'categories'; // 'categories' | 'subopts'
let settingsCatIndex = 0;         // 0-4
let settingsOptIndex = 0;         // index within sub-list
```

Remote nav while settings panel is open (overrides all other fullscreen key handling):

| Key | Focus = categories | Focus = subopts |
|---|---|---|
| ▲ / ▼ | Move `settingsCatIndex` | Scroll sub-list, update `settingsOptIndex` |
| ▶ / Enter | Enter sub-list (`focus = subopts`), populate sub-list | Select item (apply setting) |
| ◀ / Back | — | Return to categories (`focus = categories`) |
| Back (panel level) | Close settings panel | Move to categories first |

### Sub-list Content

**Audio / Subtitles / Quality:** populated from `playback.getTrackLists()` which calls:
- `player.getVariantTracks()` for video quality
- `player.getAudioLanguages()` + `player.getAudioLanguagesAndRoles()` for audio
- `player.getTextTracks()` for subtitles

"Off" is always pinned at index 0 in the Subtitles sub-list. Active track shown with `✓`.

**Speed:** pill chips `[0.5, 0.75, 1, 1.5, 2]` — Left/Right arrows move between chips, Enter selects. Active chip highlighted. Note shown: "▲/▼ also changes speed".

**Stream Info:** read-only display, refreshed every 1s while open via `setInterval`. Sourced from:

| Field | Shaka API |
|---|---|
| Resolution | Active variant track `width × height` |
| Frame rate | Active variant track `frameRate` |
| Video codec | Active variant track `videoCodec` |
| Bitrate | Active variant track `bandwidth` (bits/s → Mbps) |
| Audio codec | Active variant track `audioCodec` |
| Audio channels | Active text track `channelsCount` |
| Audio language | Active audio language |
| Est. Bandwidth | `player.getStats().estimatedBandwidth` |
| Live Latency | `player.getLiveLatency()` (live streams only) |
| Buffer Ahead | `player.getBufferedInfo().total[0].end - currentTime` |
| Dropped Frames | `player.getStats().droppedFrames` |
| Corrupted Frames | `player.getStats().corruptedFrames` |
| Load Time | `player.getStats().loadLatency` |

Values color-coded: green if healthy (dropped frames = 0, buffer > 10s, latency < 15s), amber if degraded.

---

## Section 4 — Trick-Play State Machine

### States

| State | Video | Interval |
|---|---|---|
| `NORMAL` | Playing at 1× rate | None |
| `SEEK_SINGLE` | Seeks ±3s then resumes | None (transient) |
| `REWINDING` | Paused | Fires every 250ms, seeks backward |
| `FAST_FWD` | 2×/4×: `playbackRate`; 8×: paused | 8× only |
| `TRICK_PAUSED` | Paused | None |

### Speed Indices

- Rewind: `[-1, -2, -4, -8]` — index 0–3
- Fast-forward: `[2, 4, 8]` — index 0–2

### Hold Detection

Hold threshold: 500ms. Uses the same `keydown`/`keyup` pattern already in the codebase for Enter long-press:

```js
let _leftDown = false, _leftDownTime = 0;
let _rightDown = false, _rightDownTime = 0;

document.addEventListener('keydown', e => {
  if (!document.fullscreenElement || settingsOpen) return;
  if (e.key === 'ArrowLeft' && !_leftDown) { _leftDown = true; _leftDownTime = Date.now(); }
  if (e.key === 'ArrowRight' && !_rightDown) { _rightDown = true; _rightDownTime = Date.now(); }
});

document.addEventListener('keyup', e => {
  if (e.key === 'ArrowLeft' && _leftDown) {
    const held = Date.now() - _leftDownTime;
    _leftDown = false;
    if (held < 500) handleShortLeft(); else handleHoldLeft();
  }
  // mirror for Right
});
```

### Rewind Interval

```js
function startRewind(speedIndex) {
  stopTrickPlay();
  _trickState = 'REWINDING';
  _trickSpeedIndex = speedIndex;
  videoElement.pause();
  _trickInterval = setInterval(() => {
    const speed = REWIND_SPEEDS[_trickSpeedIndex]; // -1, -2, -4, -8
    const range = player.seekRange();
    videoElement.currentTime = Math.max(range.start, videoElement.currentTime + speed * 0.25);
    updateSeekBar();
  }, 250);
  showTrickBadge(`◀◀ ${REWIND_SPEEDS[_trickSpeedIndex]}×`);
}
```

### Fast-Forward

```js
function startFF(speedIndex) {
  stopTrickPlay();
  _trickState = 'FAST_FWD';
  _trickSpeedIndex = speedIndex;
  const speed = FF_SPEEDS[speedIndex]; // 2, 4, 8
  if (speed <= 4) {
    videoElement.playbackRate = speed;
    videoElement.play();
  } else {
    videoElement.pause();
    _trickInterval = setInterval(() => {
      const range = player.seekRange();
      videoElement.currentTime = Math.min(range.end - 2, videoElement.currentTime + speed * 0.25);
      updateSeekBar();
      if (videoElement.currentTime >= range.end - 2) stopTrickPlay();
    }, 250);
  }
  showTrickBadge(`▶▶ ${speed}×`);
}
```

### Key Transitions (fullscreen, settings closed)

| Current state | Key | Action |
|---|---|---|
| NORMAL | Short ◀ | seekBy(−3), resume |
| NORMAL | Short ▶ | seekBy(+3), resume |
| NORMAL | Hold ◀ | startRewind(0) → −1× |
| NORMAL | Hold ▶ | startFF(0) → 2× |
| NORMAL | ▲ | increment rate index (max 2×), setRate() |
| NORMAL | ▼ | decrement rate index (min 0.5×), setRate() |
| REWINDING | ◀ | speedIndex = min(3, index+1) → increase rewind |
| REWINDING | ▶ | speedIndex > 0 → decrease; speedIndex = 0 → stopTrickPlay(), resume |
| REWINDING | Enter | pause, enter TRICK_PAUSED |
| FAST_FWD | ▶ | speedIndex = min(2, index+1) → increase FF |
| FAST_FWD | ◀ | speedIndex > 0 → decrease; speedIndex = 0 → stopTrickPlay(), resume |
| FAST_FWD | Enter | pause, enter TRICK_PAUSED |
| TRICK_PAUSED | Enter | stopTrickPlay(), setRate(1), resume |

---

## Section 5 — webOS Remote Service + Back/Return

### Key Codes

| Button | keyCode | Notes |
|---|---|---|
| Back/Return | `461` | To be verified via `ares-inspect` during implementation |
| OK/Enter | `13` | Play/pause toggle; also trick-play pause/resume |
| Arrow keys | `37/38/39/40` | Navigation and trick play |

### Back/Return Handler (priority order)

```js
document.addEventListener('keydown', e => {
  if (e.keyCode !== 461) return;
  e.preventDefault();
  if (settingsOpen) {
    if (settingsFocus === 'subopts') { settingsFocus = 'categories'; renderSettings(); }
    else { closeSettings(); }
    return;
  }
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  if (!mainApp.style.display === 'none') return; // on start page: let webOS handle
  showConfirmDialog('Return to home screen?', goToHomeScreen);
});
```

### mediacontroller Registration

Called once on init and on every `selectChannel`:

```js
webOS.service.request('luna://com.webos.service.mediacontroller', {
  method: 'registerMediaSession',
  parameters: {
    mediaId: 'com.outkst.iptvultra',
    title: ch.name,
    artist: ch.group || '',
    mediaType: 'video',
    playStatus: 'playing',
  },
  onSuccess: () => {},
  onFailure: e => console.warn('mediacontroller:', e),
});
```

Playback state (`playing` / `paused`) is updated on every state transition.

---

## Section 6 — File Structure

| File | Action | Notes |
|---|---|---|
| `IPTVUltra/playback.js` | **Create** | Shaka instance, trick-play state machine, settings data, mediacontroller |
| `IPTVUltra/index.html` | **Modify** | Add CDN + playback.js scripts, add `#playbackPanel` + `#settingsPanel` HTML, remove `#infoBtn` / `#epgInfoBtn` |
| `IPTVUltra/script.js` | **Modify** | Update `selectChannel`, extend `handleRemoteNav`, add Back handler, remove stream info overlay |
| `IPTVUltra/style.css` | **Modify** | Add gradient panel + seek bar + settings panel styles, remove `.stream-info-overlay` rules |
| `IPTVUltra/appinfo.json` | **Modify** | Bump version to `3.0.0` |

### `playback.js` Public API

```js
playback.init(videoElement)        // attach Shaka, configure buffers
playback.loadChannel(url)          // load stream, detect DVR, reset state
playback.seekBy(seconds)           // ±3s single-press seek
playback.startRewind(speedIndex)   // 0→-1x … 3→-8x
playback.startFF(speedIndex)       // 0→2x … 2→8x
playback.stopTrickPlay()           // clear interval, reset playbackRate
playback.setRate(rate)             // 0.5 / 0.75 / 1 / 1.5 / 2
playback.getTrickState()           // returns current state string
playback.getSeekInfo()             // { pct, behindSeconds, isDVR }
playback.getStats()                // Shaka stats object
playback.getTrackLists()           // { audio[], subtitles[], quality[] }
playback.setAudioTrack(id)
playback.setSubtitleTrack(id)      // null = off
playback.setQuality(id)            // null = auto
playback.updateMediaSession(ch)    // call mediacontroller with channel info
playback.destroy()                 // unload Shaka, clear intervals
```

---

## What Does NOT Change

- M3U parsing, EPG parsing, groups, search, channel list rendering
- EPG guide view layout, virtual scroll, row highlighting
- Favorites, saved playlists, localStorage keys
- `goToHomeScreen()` state reset logic
- Subtitle and audio panel HTML elements (repurposed by settings panel data)

---

## Success Criteria

- Xtream and M3U streams load and play via Shaka with no regression
- Rewind works within the buffer/DVR window; "LIVE" button jumps to live edge
- Trick-play speed ramps correctly; Enter pauses/resumes cleanly
- Settings panel navigable by remote alone; Audio/Subtitle/Quality/Speed/Info all functional
- Stream Info shows live Shaka data (resolution, codec, bitrate, latency, dropped frames)
- Back button exits fullscreen → prompts home → lets webOS handle quit
- mediacontroller registers channel name/playback state
- `#infoBtn` and `#epgInfoBtn` are gone with no broken references
