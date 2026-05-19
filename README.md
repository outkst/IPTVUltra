# IPTV Ultra

A webOS TV application for LG Smart TVs that streams IPTV channels from M3U playlists or Xtream Codes providers, with full EPG (Electronic Programme Guide) support.

## Features

- **M3U playlist support** — load channels from any M3U/M3U8 URL
- **Xtream Codes support** — connect directly with a server URL, username, and password
- **EPG guide** — full scrollable programme guide with current/next show info, progress bar, and per-channel now-playing display
- Browse and filter channels by group
- Search channels with scored ranking (exact → prefix → multi-term → substring)
- Favorites — star any channel; persisted across sessions
- Save multiple playlists and switch between them
- Native fullscreen video playback
- Full LG remote control navigation

## Adding a Playlist

### M3U URL

On the start screen enter any HTTP/HTTPS URL pointing to an `.m3u` or `.m3u8` playlist file. Optionally provide an XMLTV EPG URL in the EPG field to load programme data alongside the channels.

### Xtream Codes

On the start screen switch to the **Xtream Codes** tab and enter:

| Field | Example |
|---|---|
| Server URL | `http://provider.example.com:8080` |
| Username | `myuser` |
| Password | `mypassword` |

The app fetches your full channel list via the Xtream API and automatically loads EPG data for each channel — no separate EPG URL needed.

## EPG (Electronic Programme Guide)

When EPG data is available the guide can be opened from the channel list. It shows a scrollable 7-hour timeline for every channel:

- **NOW marker** — a red line tracks the current time across all rows
- **Now/Next panel** — current programme title and progress bar beneath the video
- **Focused row** — the remote-cursor row and its programme blocks are highlighted in blue
- **Playing channel** — the currently playing channel is highlighted in amber/gold, distinct from the focused row
- **Favorites** — star buttons appear in both the channel label and the info panel; changes sync instantly across the guide and the standard channel list
- **Prev/Next buttons** — snap to the time strip and hide automatically at the guide boundaries

EPG data is trimmed to a 6-hour lookahead window to keep memory usage low on webOS hardware.

## Requirements

- LG Smart TV running webOS
- TV must be in Developer Mode to sideload
- [webOS SDK](https://webostv.developer.lge.com/sdk/installation/) (`ares` CLI) for packaging and installation

## Installation

Download the latest `.ipk` from [Releases](../../releases) and install via the webOS CLI:

```bash
ares-install com.outkst.iptvultra_<version>_all.ipk --device <your-tv>
ares-launch com.outkst.iptvultra --device <your-tv>
```

## Building from Source

No build system required — the source is directly deployable.

```bash
# From the IPTVUltra/ directory
ares-package .
ares-install com.outkst.iptvultra_<version>_all.ipk --device <your-tv>
```

## Project Structure

```
IPTVUltra/
├── index.html        # App shell
├── script.js         # All application logic
├── style.css         # Dark TV-oriented theme
├── appinfo.json      # webOS app metadata
└── webOSTVjs-1.2.13/ # webOS SDK library
```
