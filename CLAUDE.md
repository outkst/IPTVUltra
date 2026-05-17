# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IPTVUltra (v2.1.0, app ID `com.outkst.iptvultra`) is a webOS TV application for LG Smart TVs that streams IPTV channels from M3U playlists. It is vanilla HTML/JS/CSS with no build system — the source is directly deployable.

## Build & Deployment

There is no npm/package.json, no bundler, and no test framework. Deployment is done via WebOS Studio IDE or the `ares` CLI from the webOS SDK.

```powershell
# Package the app into an .ipk (run from IPTVUltra/ directory)
ares-package .

# Install to a connected TV (TV must be in developer mode)
ares-install com.outkst.iptvultra_2.1.0_all.ipk --device <tv-name>

# Launch on TV
ares-launch com.outkst.iptvultra --device <tv-name>

# Open inspector/DevTools for the running app
ares-inspect com.outkst.iptvultra --device <tv-name>
```

The pre-built packages (`*.ipk`) are in `IPTVUltra/`. The app metadata lives in `IPTVUltra/appinfo.json`.

## Architecture

All application logic is in three files inside `IPTVUltra/`:

- **`index.html`** — static shell; defines two top-level UI states: `#start-page` and `#main-app`
- **`script.js`** — the entire app (654 lines, no modules); initializes on `DOMContentLoaded`
- **`style.css`** — dark TV-oriented theme; uses Flexbox/Grid; no preprocessor

### State & Data Flow

The app has two UI states, toggled by showing/hiding `#start-page` vs `#main-app`:

1. **Start Page** — user enters an M3U URL or loads a demo; playlists saved to `localStorage`
2. **Main App** — header, groups sidebar, channels list, video player panel

Global variables in `script.js` are the sole state store:
- `channels[]` — full parsed channel list
- `filteredChannels[]` — channels currently displayed (filtered by group + search)
- `groups[]` — unique group names extracted from M3U
- `favorites[]` — persisted to `localStorage`
- `savedPlaylists[]` — persisted to `localStorage`

### Key Subsystems

**M3U Parsing** (`parseM3UStreaming`) — non-blocking streaming parser that processes the file in batches to avoid freezing the TV UI. Extracts `tvg-id`, `tvg-logo`, `group-title`, name, and stream URL from `#EXTINF` lines.

**Channel Rendering** (`renderChannelList`) — rebuilds the `#channel-list` DOM from `filteredChannels[]`. Called after any filter/search/group change.

**Search** (`searchChannels`) — scoring algorithm: exact match (100pts) > prefix match (70pts) > multi-term match (50pts) > substring (20pts). Highlights matched text in channel names.

**Video Playback** — native HTML5 `<video>` element; `selectChannel(index)` sets `src` directly. PiP mode (`togglePipMode`) creates up to 4 simultaneous `<video>` elements in a CSS Grid layout.

**Remote Navigation** — `keydown` handler maps webOS remote keycodes (arrow keys, Enter, Back) to focus management and selection. All interactive elements must be reachable via arrow keys — mouse/touch is not used.

**Persistence** — `localStorage` keys: `iptvultra_playlists`, `iptvultra_favorites`, `iptvultra_last_url`.

## WebOS-Specific Notes

- The webOS SDK library is at `IPTVUltra/webOSTVjs-1.2.13/webOSTV.js` (minified, do not edit)
- Use `webOSTVjs-1.2.13/webOSTV-dev.js` for development (readable version)
- Target resolution is 1920×1080; all sizing is in px against that baseline
- `appinfo.json` controls app ID, version, icons, permissions (`INTERNET`, `DATABASE_STORAGE`), and trusted domains
- To bump the app version, update both `appinfo.json` (`version` field) and any references in `script.js`
