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

## Screenshots
Login

<img src="https://i.imgur.com/HLriZGy.png" width="500" />

M3U Playlist Viewer

<img src="https://i.imgur.com/8OUuXP3.jpeg" width="900" />

Xtream Code Viewer

<img src="https://i.imgur.com/eBib3Bz.png" width="900" />

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

When EPG data is available the guide opens automatically (Xtream) or can be accessed from the channel list (M3U). It shows a scrollable 7-hour timeline for every channel.

### Guide layout

- **Time strip** — hour labels with tick marks at every 15 minutes (:15, :30, :45)
- **NOW marker** — a red line tracks the current time across all rows
- **Focused row** — the remote-cursor row and its programme blocks are highlighted in blue
- **Playing channel** — the currently playing channel is highlighted in amber/gold, distinct from the focused row
- **Prev/Next buttons** — snap the timeline backwards or forwards 30 minutes; hide automatically at the guide boundaries
- **EPG search** — filter channels by name directly from the guide's corner search box

### Info panel

The info panel (top-right of the EPG view) shows details for the focused channel:

- Channel logo and name
- Current programme title, time range, and duration
- Programme description
- **Up Next** — the next scheduled airing's title, description, and start/end time
- **Favorite button** (top-right of the panel) — toggle the channel as a favorite; syncs instantly with the channel list and guide rows

### Groups

- The groups column can be shown or hidden while in the EPG view
- When hidden, a **floating Groups button** appears in the top-left corner to restore it

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
