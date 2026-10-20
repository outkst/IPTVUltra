# IPTV Ultra

IPTV Ultra is a webOS app for LG Smart TVs. It plays live TV, movies, and
series from IPTV providers. It accepts Xtream Codes accounts and M3U playlists,
and it shows a programme guide (EPG).

## Features

### Live TV

- **Xtream Codes and M3U.** Connect with a server URL, a username, and a
  password, or with the URL of an `.m3u` or `.m3u8` playlist. You can save
  many playlists and change between them.
- **Programme guide.** Xtream playlists open in a guide with a timeline, a
  "now" line, and an information panel for the focused programme. The guide
  loads programme data only for the rows that you see, the channel that
  plays, and your favorites. Thus, a provider with 17,000 channels opens in a
  few seconds.
- **Channel list.** M3U playlists open in a channel list. If you give an
  XMLTV URL, each row shows the current programme. A channel without a
  matching `tvg-id` is matched to the guide data by its name.
- **Catch-up.** On channels that the provider archives, the guide goes back
  up to 72 hours. Select a past programme to watch it from the start.
- **Live rewind.** On HLS channels, the app keeps a buffer of the stream.
  You can pause live TV, go back, and return to live.
- **Player.** The player banner shows the channel number, the current and
  next programme, and the video format (codec, resolution, frame rate). It
  also gives subtitle and audio track selection.
- **Channel numbers.** Type a number on the remote to go to that channel.
- **Previous channel.** Push the red key, or hold OK in the player.
- **Channel surfing.** In the player, push Up or Down to see what is on
  other channels without a change of channel. Push OK to watch.
- **Versions.** A channel can have more than one version, for example 4K,
  FHD, and HD. Hold OK on a channel, or select **Versions** in the player, to
  see all versions with the quality that the app measured during play.
- **Alternate sources.** If a stream stops and does not start again, the app
  tries the next version of the same channel.
- **Event channels (PPV).** The app reads the event time from the channel
  name, shows the event in the guide, sorts the group by start time, and can
  hide finished events.
- **Favorites, Recent, and categories.** Star a channel to add it to
  Favorites, and put your favorites in your own order. The Recent group shows
  the last 20 channels that you watched. You can hide categories and change
  their order.
- **Search.** Search by channel name, group, or the title of the current
  programme.
- **Local cache.** The channel list and the guide data are kept on the TV.
  The app opens with them immediately and gets new data in the background.

### Movies and series (Xtream)

- Push the blue key to change between Live, Movies, and Series.
- Each category shows a grid of posters. The home screen shows Continue
  Watching, Recently Added, and Favorites.
- Push the green key in a grid to sort (newest, A to Z, year, rating) or to
  show one genre.
- The details page shows the age rating, country, release date, and file
  format.
- The app remembers your position in each movie and episode. A series starts
  at the next episode that you did not watch, and the next episode can start
  automatically.
- You can mark a movie, an episode, or a full season as watched.
- Subtitle and audio tracks are selected automatically in your languages.
  You can set the subtitle size, colour, opacity, background, edge, and
  timing.

### Settings

Push the yellow key to open Settings. Settings include these items:

- Text size, 12-hour or 24-hour clock, and automatic load of the last
  playlist.
- For each playlist: the starting group, resume of the last channel, the EPG
  timezone, and an EPG time adjustment.
- The live rewind buffer, subtitle languages and style, and automatic play of
  the next episode.
- **Manage favorites**, **Manage categories**, and **Refresh playlist now**.
- **Diagnostics**: the app version, memory, stream state, the last stream
  failure, and a log of errors.

## Remote control

| Key | Action |
|---|---|
| OK | Watch the selected channel. On the channel that plays, open the player. |
| Hold OK | On a channel row: open **Versions**. In the player: previous channel. |
| Back | Close the player, the menu, or the screen. |
| Red | Previous channel. |
| Green | In the player: audio and subtitles. In a movie or series grid: sort and genre. |
| Yellow | Settings. |
| Blue | Change between Live, Movies, and Series. |
| 0–9 | Go to a channel number. |
| CH+ and CH- | Next or previous channel. |
| Left and Right in the player | Go back or forward. Hold the key to go faster. |

## Screenshots

These screenshots are from an earlier version of the app.

Start page:

<img src="https://i.imgur.com/HLriZGy.png" width="500" />

M3U channel list:

<img src="https://i.imgur.com/8OUuXP3.jpeg" width="900" />

Xtream guide:

<img src="https://i.imgur.com/eBib3Bz.png" width="900" />

## Add a playlist

### Xtream Codes

1. On the start page, select the **Xtream API** tab.
2. Enter the server URL, the username, and the password from your provider.
   For example:

   | Field | Example |
   |---|---|
   | Server URL | `http://provider.example.com:8080` |
   | Username | `myuser` |
   | Password | `mypassword` |

3. Select **Save Playlist**.

You do not need an EPG URL. The app gets the programme data from the
provider.

### M3U playlist

1. On the start page, select the **Direct URL** tab.
2. Enter the URL of the `.m3u` or `.m3u8` playlist.
3. Optional: enter the URL of an XMLTV file to get programme data.
4. Select **Save Playlist**.

## Requirements

- An LG Smart TV with webOS.
- One of these:
  - The TV in Developer Mode.
  - A rooted TV with the Homebrew Channel.
- The [webOS SDK](https://webostv.developer.lge.com/develop/tools/cli-installation)
  `ares` command-line tools, to install the app from a computer.

## Install

1. Download the latest `.ipk` file from [Releases](../../releases).
2. Install the app and start it:

   ```bash
   ares-install --device <your-tv> com.outkst.iptvultra_<version>_all.ipk
   ares-launch --device <your-tv> com.outkst.iptvultra
   ```

On a rooted TV, `ares-install` can fail with the error "Unable to exec",
because the SSH server of the Homebrew Channel has no SFTP. In this case, copy
the `.ipk` file to `/tmp` on the TV and install it with this command:

```bash
luna-send -i luna://com.webos.appInstallService/dev/install \
  '{"id":"com.ares.defaultName","ipkUrl":"/tmp/<file>.ipk","subscribe":true}'
```

## Build from source

The app has no build step. Package the `IPTVUltra/` directory and install the
package:

```bash
ares-package IPTVUltra --outdir build
ares-install --device <your-tv> build/com.outkst.iptvultra_<version>_all.ipk
```

The version in the file name comes from `IPTVUltra/appinfo.json`.

## Tests

The `test/` directory has end-to-end checks. The checks run the app in
headless Chrome with a mock Xtream server, so you do not need a TV. You need
Node.js, Python 3, and Google Chrome.

```bash
cd test
npm install
python mock_server.py 3000   # Terminal 1: the mock provider and the app
node e2e.js                  # Terminal 2: the checks
```

For more information, see [`test/README.md`](test/README.md).

## Project structure

```
IPTVUltra/
├── index.html         # App shell
├── js/                # Application logic, in load order (see index.html)
├── style.css          # Dark TV theme
├── appinfo.json       # webOS app metadata
├── hls.min.js         # hls.js, for the live rewind buffer
└── webOSTVjs-1.2.13/  # webOS SDK library
test/                  # Headless end-to-end checks and a mock provider
```

The code follows the Google style guides. The format settings are in
`.clang-format`, `.prettierrc.json`, and `.style.yapf`.

## License

IPTV Ultra is licensed under the GNU General Public License v3.0. See
[`LICENSE`](LICENSE).
