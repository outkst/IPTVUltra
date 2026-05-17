# IPTV Ultra

A webOS TV application for LG Smart TVs that streams IPTV channels from M3U playlists.

## Features

- Load IPTV playlists from any M3U URL
- Browse channels by group
- Search channels with scored ranking
- Favorites
- Save multiple playlists
- Native fullscreen video playback
- Full LG remote control navigation

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
