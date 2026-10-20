# IPTV Ultra

IPTV Ultra is an app for LG TVs with webOS. It plays live TV, movies, and
series from IPTV providers. It uses Xtream Codes accounts and M3U playlists,
and it shows a program guide (EPG).

## Functions

### Live TV

- **Xtream Codes and M3U.** Connect the app to a provider with a server URL,
  a username, and a password. Or, use the URL of an `.m3u` or `.m3u8`
  playlist. You can keep many playlists and change from 1 playlist to a
  different playlist.
- **Program guide.** Xtream playlists open in a guide. The guide shows a
  timeline, a line at the time of day, and a panel with information about the
  program that has the focus. The app gets program data only for the rows on
  the screen, the channel that plays, and your favorites. Thus, a provider
  with 17,000 channels opens quickly.
- **Channel list.** M3U playlists open in a channel list. If you give an
  XMLTV URL, each row shows the current program. If the `tvg-id` of a channel
  does not agree with the guide data, the app uses the name of the channel to
  find its data.
- **Catch-up.** On channels with an archive, the guide shows the programs of
  the last 72 h. Select a program from the archive to see it from the start.
- **Live rewind.** On HLS channels, the app keeps a buffer of the stream. You
  can pause live TV, rewind it, and then go to live TV again.
- **Player.** The banner of the player shows the channel number, the current
  program, the next program, and the video format (codec, resolution, and
  frame rate). In the player, you can also select the subtitle track and the
  audio track.
- **Channel numbers.** Type a channel number on the remote to go to that
  channel.
- **Previous channel.** Push **Red**, or hold **OK** in the player.
- **Channel preview.** In the player, push **Up** or **Down** to see the
  programs of other channels. The channel does not change. Push **OK** to go
  to the channel that the banner shows.
- **Versions.** Some channels have more than 1 version, for example 4K, FHD,
  and HD. To see all versions, hold **OK** on a channel, or select
  **Versions** in the player. The list shows the quality that the app
  measured when it played each version.
- **Alternative sources.** If a stream stops and does not start again, the
  app tries the next version of the same channel.
- **Event channels (PPV).** On PPV channels, the app reads the start time from
  the name of the channel. The app shows the PPV program in the guide, and it
  sorts the group by start time. It can also hide the PPV programs that
  stopped more than 1 h before.
- **Favorites, Recent, and categories.** Select the star of a channel to add
  the channel to Favorites. You can put your favorites in a sequence. The
  **Recent** group shows the last 20 channels that you selected. You can hide
  categories, and you can change their sequence.
- **Search.** Search for a channel name, a group, or the title of the current
  program.
- **Local cache.** The app keeps the channel list and the guide data on the
  TV. When you start the app, it shows this data immediately. Then it gets new
  data from the provider.

### Movies and series (Xtream)

- Push **Blue** to change between **Live**, **Movies**, and **Series**.
- Each category shows a grid of posters. The home screen shows **Continue
  Watching**, **Recently Added**, and **Favorites**.
- In a grid, push **Green** to sort the items (newest, A to Z, year, or
  rating), or to show only 1 genre.
- The details page shows the age rating, the country, the release date, and
  the file format.
- The app keeps your position in each movie and each episode. On a series,
  **Play** starts the first episode that you did not see. The next episode can
  start automatically.
- You can set a movie, an episode, or a full season to **Watched**.
- The app selects subtitle tracks and audio tracks in your languages
  automatically. In Settings, you can change **Subtitle size**, **Subtitle
  color**, **Subtitle opacity**, **Subtitle background**, and **Subtitle
  edge**. The **Audio & Subtitles** menu also has a **Sync offset** row.

### Settings

Push **Yellow** to open Settings. Settings has these items:

- **Text size**, **Clock** (**12-hour** or **24-hour**), and **Auto-load last
  playlist**.
- For each playlist: **Starting group**, **Resume last channel**, **EPG
  timezone**, and **EPG extra adjustment**.
- **Live rewind buffer**, the subtitle languages, the subtitle style, and
  **Auto-play next episode**.
- **Manage favorites**, **Manage categories**, and **Refresh playlist now**.
- **Diagnostics**: the app version, the memory, the condition of the stream,
  the last stream failure, and a list of errors.

## Remote control

This table shows the keys of the remote:

| Key | Result |
|---|---|
| **OK** | Play the selected channel. On the channel that plays, open the player. |
| Hold **OK** | On a channel row: open **Versions**. In the player: go to the previous channel. |
| **Back** | Close the player, the menu, or the screen. |
| **Red** | Go to the previous channel. |
| **Green** | In the player: open the audio and subtitle menu. In a grid of movies or series: open the menu where you sort the items or select a genre. |
| **Yellow** | Open Settings. |
| **Blue** | Change between **Live**, **Movies**, and **Series**. |
| **0** to **9** | Go to a channel number. |
| **CH+** and **CH-** | Go to the next channel or the previous channel. |
| **Left** and **Right** in the player | Go back or forward in the stream. Hold the key to increase the speed. |

## Screenshots

These screenshots are from a previous version of the app.

Start page:

<img src="https://i.imgur.com/HLriZGy.png" width="500" />

M3U channel list:

<img src="https://i.imgur.com/8OUuXP3.jpeg" width="900" />

Xtream guide:

<img src="https://i.imgur.com/eBib3Bz.png" width="900" />

## Add a playlist

### Xtream Codes

1. On the start page, select the **Xtream API** tab.
2. Type the server URL, the username, and the password from your provider.
   This table shows an example:

   | Field | Example |
   |---|---|
   | Server URL | `http://provider.example.com:8080` |
   | Username | `myuser` |
   | Password | `mypassword` |

3. Select **Save Playlist**.

The app gets the program data from the provider. Thus, an EPG URL is not
necessary.

### M3U playlist

1. On the start page, select the **Direct URL** tab.
2. Type the URL of the `.m3u` or `.m3u8` playlist.
3. Optional: to get program data, type the URL of an XMLTV file.
4. Select **Save Playlist**.

## Before you start

You must have these items:

- An LG TV with webOS.
- 1 of these 2 items:
  - The TV in Developer Mode.
  - A TV with root access and the Homebrew Channel.
- The `ares` tools of the
  [webOS SDK](https://webostv.developer.lge.com/develop/tools/cli-installation),
  to install the app from a computer.

## Install the app

1. Download the newest `.ipk` file from [Releases](../../releases).
2. Install the app and start it with these commands:

   ```bash
   ares-install --device <your-tv> com.outkst.iptvultra_<version>_all.ipk
   ares-launch --device <your-tv> com.outkst.iptvultra
   ```

On a TV with root access, `ares-install` can stop with the error
`Unable to exec`. The cause is that the SSH server of the Homebrew Channel has
no SFTP. If this error occurs, do these steps:

1. Copy the `.ipk` file to `/tmp` on the TV.
2. Install the file with this command:

   ```bash
   luna-send -i luna://com.webos.appInstallService/dev/install \
     '{"id":"com.ares.defaultName","ipkUrl":"/tmp/<file>.ipk","subscribe":true}'
   ```

## Build the app from the source code

The app has no build step. Make a package of the `IPTVUltra/` directory, and
install the package with these commands:

```bash
ares-package IPTVUltra --outdir build
ares-install --device <your-tv> build/com.outkst.iptvultra_<version>_all.ipk
```

The version in the file name comes from `IPTVUltra/appinfo.json`.

## Tests

The `test/` directory has end-to-end tests. The tests operate the app in
Chrome without a window, with a mock Xtream server. Thus, a TV is not
necessary. You must have Node.js, Python 3, and Google Chrome.

Use these commands:

```bash
cd test
npm install
python mock_server.py 3000   # Terminal 1: the mock provider and the app
node e2e.js                  # Terminal 2: the end-to-end tests
node load_order.js           # The sequence of the app scripts (no server)
```

For more information, see [`test/README.md`](test/README.md).

## Project structure

This list shows the files of the project:

```
IPTVUltra/
├── index.html         # App shell
├── js/                # App code, in load order (see index.html)
├── style.css          # Dark TV theme
├── appinfo.json       # webOS app metadata
├── hls.min.js         # hls.js, for the live rewind buffer
└── webOSTVjs-1.2.13/  # webOS SDK library
test/                  # End-to-end tests and a mock provider
```

The code obeys the Google style guides. The settings of the formatters are in
`.clang-format`, `.prettierrc.json`, and `.style.yapf`.

## License

IPTV Ultra uses the GNU General Public License, version 3.0. For the full
text, see [`LICENSE`](LICENSE).
