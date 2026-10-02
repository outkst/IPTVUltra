# VOD & Series Design

**Date:** 2026-10-02
**Target version:** 3.0.0 (new navigation model)
**Status:** draft for review — decisions below were confirmed with the owner on 2026-10-02; open questions at the end.

## Context

Provider scale: ~36,000 movies, ~8,800 series, 17,000 live channels. Reference apps the owner likes: Plex (browse feel) and IPTV Player Zero. Playback stays on the native `<video>` element; movies and episodes are plain MP4/MKV files that the native player seeks over HTTP byte ranges, so no Shaka dependency.

## Decisions

| Area | Decision |
|---|---|
| Entry | Mode switch at the top of the groups column: **Live / Movies / Series**. Blue colour key cycles modes from anywhere outside fullscreen. |
| Back | Steps up one level: episode list → seasons → series grid → category list → Live. The Return-to-Home dialog only appears from Live. |
| Browse | Virtualized poster grid, 6 across at text scale 1.375 (2:3 posters, title + year/duration/rating under each). Posters load lazily as rows render, the same way EPG rows do. |
| Mode home | Entering Movies or Series shows a home page of horizontal rows: **Continue Watching**, **Recently Added** (`added` timestamp), **Favorites**. Picking a category shows that category's grid. |
| Catalog loading | Per category on demand (`get_vod_streams&category_id=`, `get_series&category_id=`), cached per session. "Search all" triggers a one-time full fetch in the background (36k rows ≈ 7 MB JSON, parsed in chunks like M3U) and then searches everything. |
| Details | Details page before playing, for both: poster, backdrop, year, duration, rating, genre, plot, cast, Play/Resume, Start over, Favorite. Series details add season tabs and an episode list with thumbnails, durations, progress bars and ✓ watched marks. |
| Progress | Position remembered per movie/episode (`iptv_vod_progress`, keyed by playlist key + stream/episode id). Resume prompt on play: **Resume from mm:ss / Start over / Cancel**. ≥ 90 % watched = watched (✓). |
| Series auto-play | On `ended`, the next episode auto-plays after a 10 s countdown with Play now / Cancel. |
| Adult categories | Hidden by default; a Settings toggle shows them (PIN later). Detection: category name matches `/adult|xxx|18\+|porn/i`. |
| Favorites | Separate from live favorites: `iptv_vod_favorites` (movies) and `iptv_series_favorites`. Star on posters and on the details page. |

## Player for VOD

Live TV keeps the native fullscreen video element. VOD uses an **app-owned fullscreen container** (`#vodPlayer` requests fullscreen, not the `<video>`), so the app can draw an OSD over the picture:

- Bottom gradient OSD: title line (series: `Show · S2 E3 · Episode title`), progress bar with position and time remaining; shows on OK/Left/Right, hides after 3 s.
- OK: pause/play (OSD visible while paused). Left/Right: ±10 s; hold for trick-play with the existing speed ramp and badge. Up/Down: ±60 s? (open question).
- Back: exit fullscreen to the details page (position saved).
- Next-episode card (bottom-right) with countdown; Play now / Cancel. Auto-play keeps fullscreen since the container, not the video, is the fullscreen element.
- Native `controls` attribute is removed in VOD mode and restored for live.

This is the piece that was tried and removed earlier (the `defineProperty` fullscreen redirect in 62e73e7). The difference now: VOD gets its own container and OSD by design, and live is untouched.

## Xtream API surface

| Call | Use |
|---|---|
| `get_vod_categories`, `get_series_categories` | Category lists (counts come from the per-category fetch, so show counts only once loaded, or omit) |
| `get_vod_streams&category_id=` | Movie grid for a category: `stream_id`, `name`, `stream_icon`, `rating`, `added`, `container_extension` |
| `get_vod_info&vod_id=` | Details: `info.plot`, `cast`, `director`, `genre`, `duration`, `releasedate`, `backdrop_path`, `movie_image`; `movie_data.container_extension` |
| `get_series&category_id=` | Series grid: `series_id`, `name`, `cover`, `rating`, `last_modified`, `plot`, `genre`, `releaseDate` |
| `get_series_info&series_id=` | `episodes` keyed by season: `id`, `episode_num`, `title`, `container_extension`, `info.duration/plot/movie_image` |
| Stream URLs | `{base}/movie/{user}/{pass}/{stream_id}.{ext}`, `{base}/series/{user}/{pass}/{episode_id}.{ext}` |

Recently Added for the mode home: sorted by `added` across the categories fetched so far, or from the full fetch once it has happened. First visit shows the Continue Watching and Favorites rows immediately and fills Recently Added when the background fetch completes.

## State & storage

- `vodMode`: `'live' | 'movies' | 'series'`. View isolation extends: `vodMode !== 'live'` renders `#vodView`; the live invariant (`currentPlaylistType` → guide or list) is unchanged inside `'live'`.
- Per-session caches: `vodCats`, `seriesCats`, `vodByCat` (Map category → array), `seriesByCat`, `vodInfo` (Map id → details), `seriesInfo`.
- Persistent: `iptv_vod_progress` { key: { pos, dur, at } }, `iptv_vod_favorites`, `iptv_series_favorites`, `iptv_settings.showAdult`.
- Progress write cadence: every 10 s of playback and on pause/exit/ended; never on live TV.

## Performance constraints

- Grid virtualized by row (row height = poster + caption). Only visible rows + 1 buffer row in the DOM; poster `<img loading="lazy">` with a placeholder gradient and `onerror` fallback.
- Per-category fetch means no screen depends on the full catalog. The "Search all" full fetch is chunk-parsed (yield every 2,000 rows) and stored as a flat array; search is the existing scored search over `name`.
- Details and series info are fetched on demand and cached for the session.
- Posters are provider CDN images; no resizing is possible client-side, so the grid never renders more than ~24 `<img>` at once.

## Open questions

See the review page / chat for the owner's answers.
