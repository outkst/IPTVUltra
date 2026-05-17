# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

IPTVUltra (v2.3.0, app ID `com.outkst.iptvultra`) is a webOS TV application for LG Smart TVs that streams IPTV channels from M3U playlists. Vanilla HTML/JS/CSS — no build system, no bundler, no test framework.

## Build & Deployment

```powershell
# Package (run from IPTVUltra/ directory)
ares-package .

# Install to TV
ares-install com.outkst.iptvultra_2.3.0_all.ipk --device LivingRoomTV

# Launch
ares-launch com.outkst.iptvultra --device LivingRoomTV

# DevTools inspector
ares-inspect com.outkst.iptvultra --device LivingRoomTV
```

Registered device: `LivingRoomTV` (default). Packages land in `IPTVUltra/`.

## Architecture

All logic lives in three files inside `IPTVUltra/`:

- **`index.html`** — static shell; two top-level states: `#startPage` and `#mainApp`
- **`script.js`** — entire app, no modules; initializes on `DOMContentLoaded`
- **`style.css`** — dark TV theme; Flexbox/Grid; no preprocessor

### State

Global variables in `script.js` are the sole state store:
- `channels[]` — full parsed channel list
- `currentFilteredChannels[]` — channels currently displayed
- `groupsList[]` — unique group names from M3U
- `favoriteIds` (Set) — persisted to `localStorage`
- `savedPlaylists[]` — persisted to `localStorage`

### Key Subsystems

**M3U Parsing** (`parseM3UStreaming`) — non-blocking batch parser; extracts `tvg-id`, `tvg-logo`, `group-title`, name, URL from `#EXTINF` lines.

**Channel Rendering** (`renderChannelList`) — virtual-scrolling DOM rebuild from `currentFilteredChannels[]`.

**Search** (`searchChannels`) — scored: exact (100) > prefix (70) > multi-term (50) > substring (20).

**Video Playback** — native HTML5 `<video>`; `selectChannel(index)` sets `src` directly.

**Remote Navigation** — `keydown` maps webOS remote keycodes to focus management. All elements must be arrow-key reachable.

**Persistence** — `localStorage` keys: `iptv_playlists`, `iptv_favorites`, `last_m3u_url`.

## webOS Notes

- SDK library: `IPTVUltra/webOSTVjs-1.2.13/webOSTV.js` (minified, do not edit)
- Dev-readable version: `webOSTVjs-1.2.13/webOSTV-dev.js`
- Target resolution: 1920×1080
- Version bumps: update `appinfo.json` (`version` field)
- webOS has a single hardware video decoder — only one `<video>` element plays at a time
