# EPG INP Reduction & View Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate unnecessary EPG full-rebuilds on user interactions (INP), and enforce strict view isolation so Xtream playlists only ever touch `epgView` and M3U playlists only ever touch `standardView`.

**Architecture:** A `currentPlaylistType` variable ('xtream' | 'm3u') replaces scattered `epgMode` checks at routing decision points. A `refreshCurrentView()` dispatcher routes group/search changes to the right renderer. `renderEPGGuide()` is split into `rebuildEPGSkeleton()` (time strip — cached per hour) and `refreshEPGRows()` (body reset — on demand), so group changes only pay for the body reset, not a full time-strip rebuild.

**Tech Stack:** Vanilla JS, no bundler, no test framework. Verification via `ares-inspect com.outkst.iptvultra --device LivingRoomTV` (webOS DevTools) or browser DevTools if served locally. All changes are in `IPTVUltra/script.js` only.

---

## Files

| File | Role |
|------|------|
| `IPTVUltra/script.js` | All changes. No other files change. |

---

## Part 1 — View Isolation

### Task 1: Add `currentPlaylistType` variable and `refreshCurrentView()` dispatcher

**Files:**
- Modify: `IPTVUltra/script.js:15` (after `let epgMode = false;`)
- Modify: `IPTVUltra/script.js:1187` (after closing `}` of `enterEPGMode`)

- [ ] **Step 1.1: Add the state variable**

Find line 15 (`let epgMode = false;`) and add the new variable immediately after it:

```js
let epgMode = false;
let currentPlaylistType = null; // 'xtream' | 'm3u'
```

- [ ] **Step 1.2: Add `refreshCurrentView()` after `enterEPGMode`**

Find the closing `}` of `enterEPGMode` (currently line 1187) and insert immediately after it:

```js
function refreshCurrentView() {
    renderChannelList();                           // always updates currentFilteredChannels
    if (currentPlaylistType === 'xtream') renderEPGGuide();
}
```

> Why two calls for Xtream: `renderChannelList()` filters `currentFilteredChannels` (which `renderEPGGuide` depends on) but will be guarded to skip standardView DOM work (Task 2). Then `renderEPGGuide()` renders the guide with the fresh filter result.

- [ ] **Step 1.3: Verify the file parses without errors**

Open `IPTVUltra/index.html` in a browser (or run `ares-inspect`). Check the console for syntax errors. Expected: no errors.

---

### Task 2: Replace the `epgMode` guard in `renderChannelList()`

**Files:**
- Modify: `IPTVUltra/script.js:674`

Currently line 674 reads:
```js
if (epgMode) { renderEPGGuide(); return; }
```

- [ ] **Step 2.1: Replace the early-exit**

Change that single line to:
```js
if (currentPlaylistType === 'xtream') return;
```

> Effect: `renderChannelList()` now: (a) updates `currentFilteredChannels`, (b) exits early for Xtream without touching standardView DOM, (c) does full standardView rendering for M3U. `refreshCurrentView()` calls it first, then additionally calls `renderEPGGuide()` for Xtream.

- [ ] **Step 2.2: Verify no console errors in browser**

Open the app. Expected: no JS errors. (Channels won't load yet since `currentPlaylistType` is still `null` everywhere.)

---

### Task 3: Guard `enterEPGMode()` and set `currentPlaylistType` in load paths

**Files:**
- Modify: `IPTVUltra/script.js:1158` (`enterEPGMode`)
- Modify: `IPTVUltra/script.js:1602–1613` (`loadXtreamPlaylist` completion block)
- Modify: `IPTVUltra/script.js:487–497` (`loadM3UFromUrl` completion block)
- Modify: `IPTVUltra/script.js:530–540` (`loadDemoM3U` completion block)

- [ ] **Step 3.1: Guard `enterEPGMode()`**

Find `function enterEPGMode()` (line 1158). Add one line at the very top of the function body, before `epgMode = true;`:

```js
function enterEPGMode() {
    if (currentPlaylistType !== 'xtream') return;
    epgMode = true;
    // ... rest unchanged
```

- [ ] **Step 3.2: Set type and remove redundant `renderChannelList()` in Xtream load**

In `loadXtreamPlaylist`, find the block that currently reads (around lines 1602–1613):
```js
        channels = parsed;
        buildChannelIndexMap();
        localStorage.setItem('last_m3u_url', ''); // clear M3U cache; Xtream uses its own auth
        updateStartStatus(`Loaded ${channels.length.toLocaleString()} channels!`, false, true, false, 100);
        currentSearchQuery = '';
        searchInput.value = '';
        currentGroup = 'favorites';
        extractGroups();
        startPage.classList.add('hidden');
        mainApp.style.display = 'flex';
        renderChannelList();
        enterEPGMode(); // switch to guide layout immediately; programme blocks fill in as EPG loads
```

Change to:
```js
        channels = parsed;
        buildChannelIndexMap();
        localStorage.setItem('last_m3u_url', ''); // clear M3U cache; Xtream uses its own auth
        updateStartStatus(`Loaded ${channels.length.toLocaleString()} channels!`, false, true, false, 100);
        currentSearchQuery = '';
        searchInput.value = '';
        currentGroup = 'favorites';
        currentPlaylistType = 'xtream';
        extractGroups();
        startPage.classList.add('hidden');
        mainApp.style.display = 'flex';
        enterEPGMode(); // switch to guide layout immediately; programme blocks fill in as EPG loads
```

> Two changes: add `currentPlaylistType = 'xtream';` and remove the `renderChannelList()` call. `enterEPGMode()` calls `renderEPGGuide()` which now owns the filtering for Xtream. The old `renderChannelList()` call was wasted standardView DOM work.

- [ ] **Step 3.3: Set type in `loadM3UFromUrl`**

Find the M3U load completion block (around lines 487–497):
```js
        channels = parsed;
        buildChannelIndexMap();
        localStorage.setItem('last_m3u_url', url);
        updateStartStatus(`Loaded ${channels.length.toLocaleString()} channels!`, false, true, false, 100);
        currentSearchQuery = '';
        searchInput.value = '';
        currentGroup = 'favorites';
        extractGroups();
```

Add `currentPlaylistType = 'm3u';` after `currentGroup = 'favorites';`:
```js
        currentGroup = 'favorites';
        currentPlaylistType = 'm3u';
        extractGroups();
```

- [ ] **Step 3.4: Set type in `loadDemoM3U`**

Find the demo load completion block (around lines 536–540). It mirrors `loadM3UFromUrl`. Add the same line after `currentGroup = 'favorites';`:
```js
        currentGroup = 'favorites';
        currentPlaylistType = 'm3u';
        extractGroups();
```

- [ ] **Step 3.5: Verify Xtream load**

Load an Xtream playlist. Expected: EPG guide view appears, standardView (`#standardView`) has `display:none`. In DevTools console run `document.getElementById('standardView').style.display` — should be `"none"`. Also confirm `currentPlaylistType` is `"xtream"` by running it in the console.

- [ ] **Step 3.6: Verify M3U load**

Load an M3U playlist. Expected: standardView appears with channel list, EPG guide view (`#epgView`) has `display:none`. Confirm `currentPlaylistType === "m3u"` in console.

---

### Task 4: Replace interaction callsites with `refreshCurrentView()`

**Files:**
- Modify: `IPTVUltra/script.js:591–595` (group click handler)
- Modify: `IPTVUltra/script.js:1899–1923` (search event handlers)
- Modify: `IPTVUltra/script.js:1989` (init)

- [ ] **Step 4.1: Group click handler**

Find the group click handler (around line 591):
```js
        div.onclick = () => {
            currentGroup = group;
            if (currentSearchQuery) { currentSearchQuery = ''; searchInput.value = ''; }
            renderGroupsList();
            renderChannelList();
        };
```

Change the last line:
```js
        div.onclick = () => {
            currentGroup = group;
            if (currentSearchQuery) { currentSearchQuery = ''; searchInput.value = ''; }
            renderGroupsList();
            refreshCurrentView();
        };
```

- [ ] **Step 4.2: Standard search input debounce (line ~1904)**

Find:
```js
    _searchDebounceTimer = setTimeout(renderChannelList, 150);
```
This is inside the `searchInput` `'input'` event listener. Change to:
```js
    _searchDebounceTimer = setTimeout(refreshCurrentView, 150);
```

- [ ] **Step 4.3: Standard search clear button (line ~1906)**

Find:
```js
clearSearchBtn.addEventListener('click', () => { currentSearchQuery = ''; searchInput.value = ''; searchInput.focus(); renderGroupsList(); renderChannelList(); });
```
Change the last call:
```js
clearSearchBtn.addEventListener('click', () => { currentSearchQuery = ''; searchInput.value = ''; searchInput.focus(); renderGroupsList(); refreshCurrentView(); });
```

- [ ] **Step 4.4: EPG search input debounce (line ~1914)**

Find the `epgSearchInput` `'input'` listener:
```js
        _searchDebounceTimer = setTimeout(renderChannelList, 150);
```
Change to:
```js
        _searchDebounceTimer = setTimeout(refreshCurrentView, 150);
```

- [ ] **Step 4.5: EPG search clear button (line ~1922)**

Find:
```js
        renderChannelList();
```
inside the `epgClearSearchBtn` click handler. Change to:
```js
        refreshCurrentView();
```

- [ ] **Step 4.6: Initialization (line ~1989)**

Find:
```js
if (currentGroup === 'favorites') renderChannelList();
```
Change to:
```js
if (currentGroup === 'favorites') refreshCurrentView();
```

> At init time `currentPlaylistType` is `null`, so `refreshCurrentView()` calls `renderChannelList()` (the `else` branch), which is correct — no channels are loaded yet anyway.

- [ ] **Step 4.7: Verify group switching works in both modes**

Load Xtream: switch groups in the EPG guide — guide should update with the new group's channels. Load M3U: switch groups in standardView — channel list should update. No cross-contamination.

---

### Task 5: Fix `toggleGroupsColumn()` and 60-second timer

**Files:**
- Modify: `IPTVUltra/script.js:1064–1072` (`toggleGroupsColumn`)
- Modify: `IPTVUltra/script.js:1519` (`loadXtreamEPG` refresh timer)

- [ ] **Step 5.1: Fix `toggleGroupsColumn()`**

Find the current function:
```js
function toggleGroupsColumn() {
    groupsColumnVisible = !groupsColumnVisible;
    groupsColumn.classList.toggle('collapsed', !groupsColumnVisible);
    toggleGroupsBtn.innerHTML = groupsColumnVisible ? '◀ Hide' : '▶ Show';
    showGroupsBtn.style.display = groupsColumnVisible ? 'none' : 'block';
    const floatingBtn = document.getElementById('epgFloatingGroupsBtn');
    if (floatingBtn) floatingBtn.style.display = (epgMode && !groupsColumnVisible) ? '' : 'none';
    if (epgMode) renderEPGGuide();
}
```

Replace entirely with:
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

> `updateEPGNowMarker` is defined in Task 8. For now leave this as-is; it won't crash because `requestAnimationFrame` only queues the call — and by the time Part 2 tasks run the function will exist.
>
> **Important:** If you are implementing tasks sequentially and stop after Part 1, add a temporary stub: `function updateEPGNowMarker() {}` after Task 5, then remove the stub in Task 8.

- [ ] **Step 5.2: Fix the 60-second refresh timer in `loadXtreamEPG`**

Find line 1519:
```js
        epgRefreshTimer = setInterval(() => { if (epgMode) renderEPGGuide(); else updateNowNext(); }, 60000);
```

Replace with:
```js
        epgRefreshTimer = setInterval(() => { if (currentPlaylistType === 'xtream') renderEPGVisibleRows(); else updateNowNext(); }, 60000);
```

> `renderEPGVisibleRows()` refreshes visible programme block styles without rebuilding the skeleton or resetting the scroll position. For the minute tick, that's all we need.

- [ ] **Step 5.3: Commit Part 1**

```
git add IPTVUltra/script.js
git commit -m "feat: view isolation — currentPlaylistType, refreshCurrentView dispatcher, Xtream/M3U view guards"
```

---

## Part 2 — INP: Split EPG Rebuilds

### Task 6: Add `_epgSkeletonWinStart` and extract `rebuildEPGSkeleton()`

**Files:**
- Modify: `IPTVUltra/script.js:35` (EPG state variables block)
- Modify: `IPTVUltra/script.js:1271` (`renderEPGGuide` — extract skeleton code into new function above it)

- [ ] **Step 6.1: Add the cache variable**

Find the EPG state block (around lines 33–35):
```js
let _epgWinStart = 0;
let _epgWinEnd = 0;
let _epgTotalGuideW = 0;
```

Add one line:
```js
let _epgWinStart = 0;
let _epgWinEnd = 0;
let _epgTotalGuideW = 0;
let _epgSkeletonWinStart = 0;  // tracks which hour window the time strip was built for
```

- [ ] **Step 6.2: Add `rebuildEPGSkeleton()` immediately before `renderEPGGuide()`**

Insert this new function at line ~1271, before `function renderEPGGuide()`:

```js
function rebuildEPGSkeleton(winStart, winEnd) {
    const timeMarks = document.getElementById('epgTimeMarks');
    if (!timeMarks) return;
    const totalGuideW = EPG_WIN_HOURS * 60 * EPG_PX_PER_MIN;
    _epgWinStart = winStart;
    _epgWinEnd = winEnd;
    _epgTotalGuideW = totalGuideW;
    _epgSkeletonWinStart = winStart;

    timeMarks.style.width = totalGuideW + 'px';
    const QUARTER_HOUR_MS = 15 * 60000;
    const firstMark = Math.ceil(winStart / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
    let tmHtml = '';
    for (let t = firstMark; t <= winEnd; t += QUARTER_HOUR_MS) {
        const x = ((t - winStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
        const minOfHour = new Date(t).getMinutes();
        if (minOfHour === 0) {
            const d = new Date(t);
            const h = d.getHours();
            const h12 = h % 12 || 12;
            const label = `${h12}:00${h >= 12 ? 'PM' : 'AM'}`;
            tmHtml += `<span class="epg-time-marker" style="left:${x}px">${label}</span>`;
        } else if (minOfHour === 30) {
            tmHtml += `<span class="epg-time-tick epg-time-tick-half" style="left:${x}px"></span>`;
        } else {
            tmHtml += `<span class="epg-time-tick" style="left:${x}px"></span>`;
        }
    }
    const nowOffsetPx = ((Date.now() - winStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
    tmHtml += `<div class="epg-now-line" style="left:${nowOffsetPx}px"><span class="epg-now-label">NOW</span></div>`;
    timeMarks.innerHTML = tmHtml;
}
```

- [ ] **Step 6.3: Verify no syntax errors**

Open the app in a browser / ares-inspect. Check console. Expected: no errors. `rebuildEPGSkeleton` is not called yet so nothing visible changes.

---

### Task 7: Extract `refreshEPGRows()` and add `updateEPGNowMarker()`

**Files:**
- Modify: `IPTVUltra/script.js` — add two new functions immediately before `renderEPGGuide()`

- [ ] **Step 7.1: Add `updateEPGNowMarker()`**

Insert immediately before `function rebuildEPGSkeleton` (i.e., at the top of the new functions block):

```js
function updateEPGNowMarker() {
    const body = document.getElementById('epgBody');
    const timeMarks = document.getElementById('epgTimeMarks');
    if (!body || !timeMarks || !_epgWinStart) return;
    const fullMarker = body.querySelector('.epg-now-fullmarker');
    if (!fullMarker) return;
    const nowOffsetPx = ((Date.now() - _epgWinStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
    fullMarker.style.left = `${timeMarks.offsetLeft + parseFloat(nowOffsetPx)}px`;
}
```

- [ ] **Step 7.2: Add `refreshEPGRows()`**

Insert immediately after `rebuildEPGSkeleton` (and before `renderEPGGuide`):

```js
function refreshEPGRows() {
    const scrollOuter = document.getElementById('epgScrollOuter');
    const body = document.getElementById('epgBody');
    if (!body) return;

    const prevScrollLeft = scrollOuter ? scrollOuter.scrollLeft : 0;
    const prevScrollTop = scrollOuter ? scrollOuter.scrollTop : 0;

    body.innerHTML = '';
    body.style.height = '';
    epgRenderedRows.clear();
    if (epgVirtualScrollListener && scrollOuter) {
        scrollOuter.removeEventListener('scroll', epgVirtualScrollListener);
        epgVirtualScrollListener = null;
    }

    if (!currentFilteredChannels.length) {
        body.innerHTML = `<div class="epg-empty-group">📭 No channels exist for this group …</div>`;
        updateEPGNavVisibility();
        return;
    }

    body.style.height = `${currentFilteredChannels.length * EPG_ROW_H}px`;
    renderEPGVisibleRows();
    epgVirtualScrollListener = () => requestAnimationFrame(renderEPGVisibleRows);
    if (scrollOuter) scrollOuter.addEventListener('scroll', epgVirtualScrollListener);

    // Full-height "now" line — positioned after layout via rAF so offsetLeft is accurate
    if (scrollOuter) {
        let fullMarker = body.querySelector('.epg-now-fullmarker');
        if (!fullMarker) {
            fullMarker = document.createElement('div');
            fullMarker.className = 'epg-now-fullmarker';
            body.appendChild(fullMarker);
        }
        requestAnimationFrame(updateEPGNowMarker);
    }

    // Restore or initialise scroll position
    if (scrollOuter) {
        if (prevScrollTop > 0) scrollOuter.scrollTop = prevScrollTop;
        if (prevScrollLeft > 0) {
            scrollOuter.scrollLeft = prevScrollLeft;
            updateEPGNavVisibility();
        } else {
            requestAnimationFrame(() => {
                const nowOffsetPx = ((_epgWinStart ? (Date.now() - _epgWinStart) : 0) / 60000 * EPG_PX_PER_MIN).toFixed(1);
                const visibleW = Math.max(1, scrollOuter.clientWidth - EPG_CH_W);
                scrollOuter.scrollLeft = Math.max(0, parseFloat(nowOffsetPx) - Math.floor(visibleW / 3));
                updateEPGNavVisibility();
            });
        }
    }

    // Clamp focused row and apply highlight
    epgFocusedRowIdx = Math.min(epgFocusedRowIdx, Math.max(0, currentFilteredChannels.length - 1));
    updateEPGRowFocus();
}
```

- [ ] **Step 7.3: Verify no syntax errors**

Reload in browser/inspector. Expected: no console errors.

---

### Task 8: Rewrite `renderEPGGuide()` as orchestrator and remove stub

**Files:**
- Modify: `IPTVUltra/script.js` — replace the body of `renderEPGGuide()`

- [ ] **Step 8.1: Replace `renderEPGGuide()` body**

Find the existing `renderEPGGuide()` function. Replace its **entire body** (everything between the opening `{` and closing `}`) with:

```js
function renderEPGGuide() {
    const guideWrap = document.getElementById('epgGuideWrap');
    if (!guideWrap) return;
    if (guideWrap.clientWidth <= 0) { requestAnimationFrame(renderEPGGuide); return; }

    const now = Date.now();
    const HOUR_MS = 3600000;
    const winStart = Math.floor((now - HOUR_MS) / HOUR_MS) * HOUR_MS;
    const winEnd = winStart + EPG_WIN_HOURS * HOUR_MS;

    if (winStart !== _epgSkeletonWinStart) rebuildEPGSkeleton(winStart, winEnd);
    refreshEPGRows();
}
```

> The skeleton is rebuilt only when the hour window advances (at most once per hour). Group changes, search changes, and all other interactions only pay for `refreshEPGRows()`.

- [ ] **Step 8.2: Remove the temporary stub if one was added**

If you added `function updateEPGNowMarker() {}` as a stub in Task 5, delete it now — the real implementation was added in Task 7.

- [ ] **Step 8.3: Verify EPG guide renders correctly on Xtream load**

Load an Xtream playlist. Expected:
- EPG guide appears with time strip (hour labels, 15-min ticks, NOW label)
- Channels rows are visible and scroll correctly
- The full-height NOW line is visible and correctly positioned

Open DevTools → Performance tab → record a group switch. Expected: the interaction response should be faster (no `timeMarks.innerHTML` write in the hot path).

---

### Task 9: Wrap group-click in `requestAnimationFrame` and verify `toggleGroupsColumn`

**Files:**
- Modify: `IPTVUltra/script.js:591–595` (group click handler)

- [ ] **Step 9.1: Wrap group click in rAF**

Find the group click handler updated in Task 4.1:
```js
        div.onclick = () => {
            currentGroup = group;
            if (currentSearchQuery) { currentSearchQuery = ''; searchInput.value = ''; }
            renderGroupsList();
            refreshCurrentView();
        };
```

Wrap the view refresh:
```js
        div.onclick = () => {
            currentGroup = group;
            if (currentSearchQuery) { currentSearchQuery = ''; searchInput.value = ''; }
            renderGroupsList();
            requestAnimationFrame(refreshCurrentView);
        };
```

> `renderGroupsList()` runs synchronously (it's cheap — just updates the groups sidebar highlight). The channel/guide refresh is deferred one frame so the remote button press is visually acknowledged before DOM work starts.

- [ ] **Step 9.2: Verify `toggleGroupsColumn` in Xtream mode**

Load Xtream. Toggle the groups column (Hide/Show button). Expected:
- Groups column collapses/expands via CSS
- The full-height NOW line repositions correctly (shifts left when column collapses, right when it expands)
- No full guide rebuild — time strip does NOT flicker/rebuild
- DevTools console: no errors

- [ ] **Step 9.3: Commit Part 2**

```
git add IPTVUltra/script.js
git commit -m "feat: EPG INP — skeleton/rows split, rAF group-click, now-marker-only on column toggle"
```

---

### Task 10: Package and verify

- [ ] **Step 10.1: Update version in `appinfo.json`**

Open `IPTVUltra/appinfo.json`. Change `"version"` from `"2.9.0"` to `"2.9.2"`.

```json
  "version": "2.9.2",
```

- [ ] **Step 10.2: Package**

```powershell
cd IPTVUltra
ares-package .
```

Expected output ends with: `Create com.outkst.iptvultra_2.9.2_all.ipk to ...\IPTVUltra`  and `Success`

- [ ] **Step 10.3: Install and smoke-test on TV**

```powershell
ares-install com.outkst.iptvultra_2.9.2_all.ipk --device LivingRoomTV
ares-launch com.outkst.iptvultra --device LivingRoomTV
```

Smoke-test checklist:
- [ ] Load Xtream playlist → EPG guide appears, standardView hidden
- [ ] Load M3U playlist → standardView appears, EPG guide hidden
- [ ] Xtream: switch groups → guide rows update, time strip unchanged
- [ ] Xtream: search → guide rows filter, time strip unchanged
- [ ] Xtream: toggle groups column → column collapses, NOW line repositions, no flicker
- [ ] M3U: switch groups → channel list updates normally
- [ ] M3U: `enterEPGMode` is not triggered (confirmed by `epgMode === false` in DevTools console)

- [ ] **Step 10.4: Commit version bump and package**

```
git add IPTVUltra/appinfo.json IPTVUltra/com.outkst.iptvultra_2.9.2_all.ipk
git commit -m "v2.9.2 — EPG INP reduction and Xtream/M3U view isolation"
git tag v2.9.2
```

---

## Self-Review Notes

- **`currentFilteredChannels` is always fresh before `renderEPGGuide()`:** `refreshCurrentView()` calls `renderChannelList()` first (which updates `currentFilteredChannels` and returns early for Xtream), then calls `renderEPGGuide()`. No stale data.
- **`_epgSkeletonWinStart = 0` is safe:** `winStart` is always a large epoch millisecond value, never `0`, so the cache miss fires correctly on first render.
- **`updateEPGNowMarker()` guards `_epgWinStart`:** Returns early if `_epgWinStart` is `0` (before first skeleton build), preventing a divide-by-zero / bad left value.
- **The stub warning in Task 5.1:** If implementing sequentially and pausing between Part 1 and Part 2, a `function updateEPGNowMarker() {}` stub prevents a ReferenceError when `toggleGroupsColumn` tries to call it. Remove the stub in Task 8.2.
- **Version numbers:** Intermediate commits use `feat:` prefix without a version number. `appinfo.json` is bumped once in Task 10.1 to `2.9.2`. The final commit in Task 10.4 carries the `v2.9.2` tag and release message.
