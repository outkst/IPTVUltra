# EPG INP Reduction & View Isolation Design

**Date:** 2026-05-21
**Scope:** `IPTVUltra/script.js`, `IPTVUltra/index.html`, `IPTVUltra/style.css`

---

## Goals

1. Reduce Interaction to Next Paint (INP) in the EPG guide view by eliminating unnecessary full rebuilds on user interactions.
2. Enforce strict view isolation: Xtream playlists always use `epgView`; M3U playlists always use `standardView`. Neither playlist type touches the other view.

---

## Part 1 — View Isolation

### New State Variable

```js
let currentPlaylistType = null; // 'xtream' | 'm3u'
```

Set at the point channels are committed to state:
- `loadXtreamPlaylist` → `currentPlaylistType = 'xtream'`
- `loadM3UFromUrl` → `currentPlaylistType = 'm3u'`
- `loadDemoM3U` → `currentPlaylistType = 'm3u'`

### New Dispatcher — `refreshCurrentView()`

```js
function refreshCurrentView() {
    if (currentPlaylistType === 'xtream') renderEPGGuide();
    else renderChannelList();
}
```

Replaces every callsite that currently calls `renderChannelList()` from a context that could be either mode (group clicks, search debounce, etc.).

### Changes to Existing Functions

**`renderChannelList()`**
- Remove the early-exit `if (epgMode) { renderEPGGuide(); return; }` — this function is standardView-only going forward.

**`enterEPGMode()`**
- Add guard at top: `if (currentPlaylistType !== 'xtream') return;`

**`loadXtreamPlaylist`** (line ~1612)
- Remove the `renderChannelList()` call that precedes `enterEPGMode()`. Xtream never touches standardView DOM.

**`loadEPG()`** completion (M3U EPG path, line ~316)
- Keeps `renderChannelList()` — M3U is always standardView, this is correct.

**60-second refresh timer** (line ~1519)
- Change from: `if (epgMode) renderEPGGuide(); else updateNowNext();`
- Change to: `if (currentPlaylistType === 'xtream') renderEPGVisibleRows(); else updateNowNext();`
- This avoids a full skeleton rebuild on the minute tick.

**Callsites to replace with `refreshCurrentView()`**
- Group click handler (line ~595)
- Search debounce timer (line ~1904)
- Search clear button handler (line ~1906)
- `renderChannelList()` call at bottom of init (line ~1989)

**Callsites that stay as `renderChannelList()`** (already correctly gated)
- `selectChannel()` else-branch (`!epgMode` guard, line ~790)
- `toggleEPGFav()` (`!epgMode` guard, line ~1794)
- `loadEPG()` completion (M3U-only path, line ~316)

### Invariant After This Change

- `renderChannelList()` never runs when `currentPlaylistType === 'xtream'`
- `renderEPGGuide()` / `enterEPGMode()` never run when `currentPlaylistType === 'm3u'`
- The EPG guide grid is strictly Xtream-only

---

## Part 2 — INP Reduction (Split EPG Rebuilds)

### Root Cause

`renderEPGGuide()` is called synchronously on user interactions (group change, groups-column toggle) and performs two expensive operations every time:
1. **Skeleton rebuild** — reconstructs the time strip via `timeMarks.innerHTML` (many span/div elements). This only needs to happen when the time window advances (hourly).
2. **Row reset** — clears `epgBody.innerHTML`, resets `epgRenderedRows`, re-registers the scroll listener, restores scroll positions, re-renders visible rows. This is needed on group/search/channel-list changes.

Both operations are currently bundled and run synchronously before the browser can paint, causing visible INP delays.

### Split into Two Functions

**`rebuildEPGSkeleton(winStart, winEnd)`**
- Builds `timeMarks.innerHTML` (hour labels, 15-min ticks, NOW label)
- Sets `_epgWinStart`, `_epgWinEnd`, `_epgTotalGuideW`, `_epgSkeletonWinStart`
- Positions the full-height NOW line marker
- Called only when `winStart !== _epgSkeletonWinStart`

New module-level variable:
```js
let _epgSkeletonWinStart = 0; // tracks which time window the skeleton was built for
```

**`refreshEPGRows()`**
- Removes old scroll listener
- Clears `epgBody.innerHTML`, resets `epgRenderedRows`
- Sets `epgBody.style.height`
- Calls `renderEPGVisibleRows()`
- Re-registers `epgVirtualScrollListener`
- Restores `scrollOuter.scrollTop` and `scrollOuter.scrollLeft`
- Clamps `epgFocusedRowIdx` and calls `updateEPGRowFocus()`

**`renderEPGGuide()` — becomes orchestrator**
```js
function renderEPGGuide() {
    const now = Date.now();
    const winStart = Math.floor((now - 60 * 60000) / (15 * 60000)) * (15 * 60000);
    const winEnd = winStart + EPG_WIN_HOURS * 3600000;
    if (winStart !== _epgSkeletonWinStart) rebuildEPGSkeleton(winStart, winEnd);
    refreshEPGRows();
}
```

### `toggleGroupsColumn()` — No Full Rebuild

Currently calls `renderEPGGuide()` after toggling the column. The skeleton doesn't need to change — only the full-height NOW marker's `left` position needs updating (it references `timeMarks.offsetLeft` which shifts when the groups column width changes).

New function:
```js
function updateEPGNowMarker() {
    const body = document.getElementById('epgBody');
    const timeMarks = document.getElementById('epgTimeMarks');
    if (!body || !timeMarks) return;
    const fullMarker = body.querySelector('.epg-now-fullmarker');
    if (!fullMarker) return;
    const now = Date.now();
    const nowOffsetPx = ((_epgWinStart ? (now - _epgWinStart) : 0) / 60000 * EPG_PX_PER_MIN).toFixed(1);
    fullMarker.style.left = `${timeMarks.offsetLeft + parseFloat(nowOffsetPx)}px`;
}
```

`toggleGroupsColumn()` becomes:
```js
function toggleGroupsColumn() {
    groupsColumnVisible = !groupsColumnVisible;
    groupsColumn.classList.toggle('collapsed', !groupsColumnVisible);
    toggleGroupsBtn.innerHTML = groupsColumnVisible ? '◀ Hide' : '▶ Show';
    showGroupsBtn.style.display = groupsColumnVisible ? 'none' : 'block';
    const floatingBtn = document.getElementById('epgFloatingGroupsBtn');
    if (floatingBtn) floatingBtn.style.display = (currentPlaylistType === 'xtream' && !groupsColumnVisible) ? '' : 'none';
    if (currentPlaylistType === 'xtream') requestAnimationFrame(updateEPGNowMarker);
}
```

### rAF Wrapping for Interaction-Triggered Rebuilds

Group change (group click handler, ~line 595) and the search-driven `refreshCurrentView()` calls should be wrapped in `requestAnimationFrame` so the remote key press is acknowledged before DOM work begins:

```js
// group click:
currentGroup = group;
requestAnimationFrame(refreshCurrentView);

// search debounce already has 150ms — no extra rAF needed there
```

### 60-Second Timer

As noted in Part 1: change to `renderEPGVisibleRows()` for Xtream (refreshes programme block styles without rebuilding skeleton or rows) rather than full `renderEPGGuide()`.

---

## What Does NOT Change

- `renderEPGVisibleRows()` — unchanged, already efficient virtual scroller
- `updateEPGRowFocus()` — unchanged, already minimal (classList toggles on visible rows only)
- `selectChannel()` EPG branch — already fixed in v2.9.0 (updates active row in-place)
- `buildEPGRow()` — unchanged
- All EPG remote navigation — unchanged

---

## Files Changed

| File | Changes |
|------|---------|
| `IPTVUltra/script.js` | All changes above; no new files |
| `IPTVUltra/index.html` | None |
| `IPTVUltra/style.css` | None |

---

## Success Criteria

- Group change in EPG view: browser paints the key press feedback before guide rows update
- `toggleGroupsColumn()` in EPG view: no full guide rebuild; only NOW marker repositions
- 60-second tick: does not rebuild skeleton or rows; only refreshes visible programme blocks
- Loading an M3U playlist: `enterEPGMode()` is never called; `epgBody` is never written to
- Loading an Xtream playlist: `renderChannelList()` (standardView) is never called
- `currentPlaylistType` is set before any rendering starts in both load paths
