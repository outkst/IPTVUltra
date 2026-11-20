/**
 * @fileoverview Helpers, the streaming XMLTV parser, the IndexedDB cache, and
 * playlist loading.
 */

// ----- Helper Functions -----
function updateStartStatus(
    message, isError = false, isSuccess = false, showProgress = false,
    progressPercent = 0) {
  startStatusMessage.innerHTML = '';
  if (isLoading && !isError && !isSuccess) {
    const spinner = document.createElement('div');
    spinner.className = 'start-status-spinner';
    startStatusMessage.appendChild(spinner);
    startStatusMessage.appendChild(document.createTextNode(` ${message}`));
    startStatusBar.classList.remove(
        'start-status-error', 'start-status-success');
  } else if (isError) {
    startStatusMessage.innerHTML = `❌ ${message}`;
    startStatusBar.classList.add('start-status-error');
    startStatusBar.classList.remove('start-status-success');
  } else if (isSuccess) {
    startStatusMessage.innerHTML = `✅ ${message}`;
    startStatusBar.classList.add('start-status-success');
    startStatusBar.classList.remove('start-status-error');
  } else {
    startStatusMessage.innerHTML = `✨ ${message}`;
    startStatusBar.classList.remove(
        'start-status-error', 'start-status-success');
  }
  if (showProgress) {
    progressBarContainer.style.display = 'block';
    progressBar.style.width = `${progressPercent}%`;
  } else {
    progressBarContainer.style.display = 'none';
    progressBar.style.width = '0%';
  }
}

function showLoading(show, message = 'Loading playlist...') {
  if (show) {
    loadingOverlay.querySelector('.loading-text').innerText = message;
    loadingOverlay.classList.remove('hidden');
  } else {
    loadingOverlay.classList.add('hidden');
  }
}

function setLoadSelectedButtonEnabled(enabled) {
  if (loadSelectedBtn) loadSelectedBtn.disabled = !enabled;
}

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;'
};

/**
 * Escapes text for HTML content and for an attribute value in quotes.
 * @param {*} str The text.
 * @return {string} The escaped text.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => HTML_ESCAPES[m]);
}

// ----- Streaming Parser (never hangs) -----
// An attribute of an #EXTINF line: a name, then a value in double quotes, in
// single quotes, or with no quotes.
const _RE_EXTINF_ATTR = /([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s,"']*))/g;

/**
 * Reads an #EXTINF line. A value in quotes can contain a comma, and a value in
 * double quotes can contain an apostrophe. The name is the text after the
 * first comma outside quotes.
 * @param {string} line The #EXTINF line.
 * @return {{name: ?string, attrs: !Object<string, string>}} The name (null
 *     when the line has no comma) and the attributes, with names in lower case.
 */
function parseExtinf(line) {
  let quote = '';
  let comma = -1;
  for (let k = 8; k < line.length; k++) {
    const c = line[k];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || (c === '\'' && line[k - 1] === '=')) {
      quote = c;
    } else if (c === ',') {
      comma = k;
      break;
    }
  }
  // A quote that does not close: the name is after the last comma
  const lastComma = comma < 0 ? line.lastIndexOf(',') : -1;
  const cut = comma >= 0 ? comma : lastComma >= 8 ? lastComma : -1;
  const head = cut >= 0 ? line.slice(0, cut) : line;
  const attrs = {};
  _RE_EXTINF_ATTR.lastIndex = 0;
  let m;
  while ((m = _RE_EXTINF_ATTR.exec(head))) {
    const key = m[1].toLowerCase();
    if (!(key in attrs))
      attrs[key] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
  }
  return {name: cut >= 0 ? line.slice(cut + 1).trim() : null, attrs};
}

async function parseM3UStreaming(content) {
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const channelsList = [];
  let current = null;
  let i = 0;
  const BATCH = 5000;
  while (i < total) {
    const end = Math.min(i + BATCH, total);
    for (let j = i; j < end; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF:')) {
        const inf = parseExtinf(line);
        current = {
          name: inf.name === null ? 'Unknown' : copyStr(inf.name),
          tvgId: copyStr(inf.attrs['tvg-id'] || ''),
          tvgLogo: copyStr(inf.attrs['tvg-logo'] || ''),
          group: copyStr((inf.attrs['group-title'] || '').trim()),
          url: ''
        };
      } else if (line.startsWith('#EXTGRP:')) {
        // The group of the next channel, when its #EXTINF has no group-title
        if (current && !current.group)
          current.group = copyStr(line.slice(8).trim());
      } else if (
          !line.startsWith('#') && current &&
          (line.startsWith('http') || line.startsWith('https') ||
           line.startsWith('//'))) {
        current.url = copyStr(line.startsWith('//') ? 'https:' + line : line);
        channelsList.push(current);
        current = null;
      }
    }
    i = end;
    const percent = Math.min(100, Math.round((i / total) * 100));
    updateStartStatus(
        `Parsing: ${i.toLocaleString()} / ${total.toLocaleString()} lines (${
            channelsList.length.toLocaleString()} found)`,
        false, false, true, percent);
    await new Promise(r => setTimeout(r, 5));
  }
  return channelsList;
}

// ----- Local cache (IndexedDB) -----
// The parsed channel list and the lazily fetched EPG survive relaunches so the
// guide appears at once. A cached list is applied immediately and re-downloaded
// in the background when it is older than PLAYLIST_CACHE_MAX_AGE_MS (or on
// "Refresh playlist now" in Settings); a changed list is swapped in place (same
// channel keeps playing, same group stays). Cached EPG entries show straight
// away and are re-fetched as usual once their TTL has passed. Storage failures
// are silent: everything still works without the cache, only slower.
const CACHE_DB_NAME = 'iptvultra-cache';
const PLAYLIST_CACHE_MAX_AGE_MS = 6 * 3600000;
const EPG_PERSIST_MAX_AGE_MS =
    24 * 3600000;  // older entries are dropped instead of restored
let _cacheDbPromise = null;
let _playlistCacheAt =
    0;  // when the applied channel list was fetched from the provider
let _playlistRefreshing = false;
let _m3uSource =
    null;  // { url, epgUrl } of the loaded M3U, for background refresh
function cacheDb() {
  if (_cacheDbPromise) return _cacheDbPromise;
  _cacheDbPromise = new Promise(res => {
    if (typeof indexedDB === 'undefined') return res(null);
    try {
      const req = indexedDB.open(CACHE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('playlists'))
          db.createObjectStore('playlists');
        if (!db.objectStoreNames.contains('epg')) db.createObjectStore('epg');
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
      req.onblocked = () => res(null);
    } catch (_) {
      res(null);
    }
  });
  return _cacheDbPromise;
}
function cacheGet(store, key) {
  return cacheDb().then(
      db => new Promise(res => {
        if (!db) return res(undefined);
        try {
          const r = db.transaction(store).objectStore(store).get(key);
          r.onsuccess = () => res(r.result);
          r.onerror = () => res(undefined);
        } catch (_) {
          res(undefined);
        }
      }));
}
function cachePut(store, key, value) {
  return cacheDb().then(db => new Promise(res => {
                          if (!db) return res(false);
                          try {
                            const tx = db.transaction(store, 'readwrite');
                            tx.objectStore(store).put(value, key);
                            tx.oncomplete = () => res(true);
                            tx.onerror = () => res(false);
                            tx.onabort = () => res(false);
                          } catch (_) {
                            res(false);
                          }
                        }));
}
// All entries whose key starts with prefix, as [{ k, v }]
function cacheGetPrefix(store, prefix) {
  return cacheDb().then(
      db => new Promise(res => {
        if (!db) return res([]);
        try {
          const out = [];
          const range = IDBKeyRange.bound(prefix, prefix + '￿');
          const cur =
              db.transaction(store).objectStore(store).openCursor(range);
          cur.onsuccess = () => {
            const c = cur.result;
            if (c) {
              out.push({k: c.key, v: c.value});
              c.continue();
            } else
              res(out);
          };
          cur.onerror = () => res(out);
        } catch (_) {
          res([]);
        }
      }));
}
// EPG results are written in small batches (fetches complete in bursts) under
// "<playlistKey>|<tvgId>"
let _epgPersistBatch = new Map();
let _epgPersistTimer = null;
function epgPersist(tvgId, at, progs) {
  if (!_activePlaylistKey || _activePlaylistKey === 'm:demo') return;
  _epgPersistBatch.set(
      _activePlaylistKey + '|' + tvgId,
      {at, progs});  // full key now: the playlist may change before the flush
  if (!_epgPersistTimer) _epgPersistTimer = setTimeout(flushEpgPersist, 1500);
}
function flushEpgPersist() {
  _epgPersistTimer = null;
  const batch = _epgPersistBatch;
  _epgPersistBatch = new Map();
  if (!batch.size) return;
  cacheDb().then(db => {
    if (!db) return;
    try {
      const st = db.transaction('epg', 'readwrite').objectStore('epg');
      for (const [k, v] of batch) {
        if (v.progs && v.progs.length)
          st.put(v, k);
        else
          st.delete(k);
      }
    } catch (_) { /* cache unavailable */
    }
  });
}
// Put cached EPG into the live maps for the playlist just applied and refresh
// whatever is on screen
async function epgRestoreFromCache(key) {
  if (!_epgSweepDone) setTimeout(epgSweepCache, 60000);
  const rows = await cacheGetPrefix('epg', key + '|');
  if (_activePlaylistKey !== key || !rows.length) return 0;
  const now = Date.now();
  const drop = [];  // keys to delete from the store
  const keep = [];
  for (const {k, v} of rows) {
    const tvgId = String(k).slice(key.length + 1);
    if (!tvgId || !v || !Array.isArray(v.progs) || !v.progs.length ||
        !(now - v.at <= EPG_PERSIST_MAX_AGE_MS)) {
      drop.push(k);
      continue;
    }
    keep.push({k, tvgId, v});
  }
  // The newest entries first. The store keeps only the entries that fit in
  // epgData.
  keep.sort((a, b) => b.v.at - a.v.at);
  for (const r of keep.splice(EPG_CACHE_MAX)) drop.push(r.k);
  if (drop.length) cacheDeleteKeys('epg', drop);
  // The restored entries go to the start of the LRU sequence. Thus, the LRU
  // removes them before the entries that a live fetch gave.
  const room = Math.max(0, EPG_CACHE_MAX - epgData.size);
  const restored = [];
  for (const {tvgId, v} of keep) {
    if (restored.length >= room) break;
    const meta = _epgFetchMeta.get(tvgId);
    if (meta && meta.status === 'pending')
      continue;  // a live fetch is already ahead of us
    if (meta && meta.status === 'done' && epgData.has(tvgId) && meta.at >= v.at)
      continue;  // the data in memory is newer
    restored.push({tvgId, v});
  }
  if (!restored.length) return 0;
  const live = [...epgData];
  epgData.clear();
  for (let i = restored.length - 1; i >= 0; i--) {
    const {tvgId, v} = restored[i];
    epgData.set(tvgId, epgShiftProgs(v.progs, 1));  // cache holds provider time
    epgIdMap.set(tvgId.toLowerCase(), tvgId);
    _epgFetchMeta.set(tvgId, {
      at: v.at,
      status: 'done'
    });  // past its TTL it is simply re-fetched when visible
    _epgDirtyIds.add(tvgId);
  }
  for (const [k0, v0] of live)
    if (!epgData.has(k0)) epgData.set(k0, v0);
  flushEpgRowUpdates();
  return restored.length;
}
// Deletes the entries of the EPG store that are older than
// EPG_PERSIST_MAX_AGE_MS, for all playlists. The app does this 1 time in a
// session, after the restore.
let _epgSweepDone = false;
// The sweep reads all of the EPG store. Thus, it runs 1 time in 24 h.
const EPG_SWEEP_KEY = 'iptv_epg_sweep_at';
function epgSweepCache() {
  if (_epgSweepDone) return;
  _epgSweepDone = true;
  let last = 0;
  try {
    last = +localStorage.getItem(EPG_SWEEP_KEY) || 0;
  } catch (_) { /* storage unavailable */
  }
  if (Date.now() - last < 86400000) return;
  storageSet(EPG_SWEEP_KEY, String(Date.now()));
  cacheDb().then(db => {
    if (!db) return;
    try {
      const now = Date.now();
      const cur =
          db.transaction('epg', 'readwrite').objectStore('epg').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const v = c.value;
        if (!v || !(now - v.at <= EPG_PERSIST_MAX_AGE_MS)) c.delete();
        c.continue();
      };
    } catch (_) { /* cache unavailable */
    }
  });
}
function cacheDeleteKeys(store, keys) {
  return cacheDb().then(db => {
    if (!db) return;
    try {
      const st = db.transaction(store, 'readwrite').objectStore(store);
      for (const k of keys) st.delete(k);
    } catch (_) { /* cache unavailable */
    }
  });
}
// Cheap fingerprint of a channel list, to tell whether a refresh changed
// anything
function channelListSignature(list) {
  let h = 0;
  for (const c of list) {
    // A tvgId from applyEpgNameFallback is not from the provider.
    const s = c.url + '|' + c.name + '|' + normGroupName(c.group) + '|' +
        (c.tvgIdFromName ? '' : c.tvgId || '') + '|' + (c.num || '') + '|' +
        (c.archive || '') + '|' + (c.tvgLogo || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return list.length + ':' + h;
}
// Swap in a refreshed list without disturbing the user: same channel keeps
// playing, same group stays
function replaceChannelList(parsed) {
  const old = channels;
  const focusList = currentFilteredChannels;
  const focusCh = focusList[epgMode ? epgFocusedRowIdx : stdFocusIdx] || null;
  channels = parsed;
  // Keep the tvgIds that applyEpgNameFallback found by name (M3U).
  if (currentPlaylistType === 'm3u') {
    const byUrl = new Map();
    for (const c of old)
      if (c.tvgIdFromName && c.url) byUrl.set(c.url, c.tvgId);
    if (byUrl.size)
      for (const c of parsed)
        if (!c.tvgId && byUrl.has(c.url)) {
          c.tvgId = byUrl.get(c.url);
          c.tvgIdFromName = true;
        }
  }
  buildChannelIndexMap();
  if (currentPlaylistType === 'xtream') {
    _xtStreamIdByTvgId = new Map();
    for (const ch of parsed)
      if (!_xtStreamIdByTvgId.has(ch.tvgId))
        _xtStreamIdByTvgId.set(ch.tvgId, ch.streamId);
  }
  // The indexes of the old list go to the same channel in the new list: by
  // the URL, else by the favorite id.
  const mapCh = (ch) => {
    if (!ch) return -1;
    if (ch.url && _chanByUrl.has(ch.url)) return _chanByUrl.get(ch.url);
    const l = _chansByFavId.get(favIdOf(ch, -1));
    return l && l.length ? channelIndexMap.get(l[0]) : -1;
  };
  const mapIdx = (i) => (i >= 0 ? mapCh(old[i]) : -1);
  currentChannelIndex = mapIdx(currentChannelIndex);
  lastChannelIndex = mapIdx(lastChannelIndex);
  _altOrigin = mapIdx(_altOrigin);
  _bestFrom = currentChannelIndex >= 0 ? mapIdx(_bestFrom) : -1;
  const failed = [..._bestFailed].map(mapIdx).filter(i => i >= 0);
  _bestFailed.clear();
  for (const i of failed) _bestFailed.add(i);
  _altTried = new Set([..._altTried].map(mapIdx).filter(i => i >= 0));
  let catchupGone = false;
  if (catchup) {
    catchup.chIdx = mapIdx(catchup.chIdx);
    catchupGone = catchup.chIdx < 0;
  }
  // Open UI keeps indexes of the previous list: close it
  if (versionsOpen) closeVersions();
  surfCancel();
  if (_rowOk) {
    clearTimeout(_rowOk.timer);
    _rowOk = null;
  }
  if (catchupGone) {
    // The archive channel is not in the new list: stop the archive
    catchup = null;
    // In Movies or Series, no live stream starts (setVodMode reloads it)
    if (currentChannelIndex >= 0 && vodMode === 'live' && !vodPlay.active)
      selectChannel(currentChannelIndex);
  }
  extractGroups();
  validateCurrentGroup();
  refreshCurrentView();
  const fi =
      focusCh ? currentFilteredChannels.indexOf(channels[mapCh(focusCh)]) : -1;
  if (fi >= 0 && vodMode === 'live') {
    if (epgMode) {
      epgFocusedRowIdx = fi;
      updateEPGRowFocus();
    } else {
      stdFocusIdx = fi;
      updateStdChannelFocus();
    }
  }
  if (currentChannelIndex >= 0 && epgMode)
    updateEPGInfoPanel(channels[currentChannelIndex]);
}
// Re-download the loaded playlist and apply it in place if it changed.
// force=false respects the 6 h age.
async function refreshPlaylistInBackground(force) {
  if (_playlistRefreshing || isLoading || !_activePlaylistKey ||
      _activePlaylistKey === 'm:demo')
    return false;
  if (!force && _playlistCacheAt &&
      Date.now() - _playlistCacheAt < PLAYLIST_CACHE_MAX_AGE_MS)
    return false;
  _playlistRefreshing = true;
  const key = _activePlaylistKey;
  try {
    let parsed;
    if (currentPlaylistType === 'xtream' && _xt)
      parsed = await xtreamFetchChannels(_xt.base, _xt.user, _xt.pass, null);
    else if (_m3uSource) {
      const resp = await fetch(_m3uSource.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      parsed = await parseM3UStreaming(await resp.text());
    }
    if (_activePlaylistKey !== key || !parsed || !parsed.length) return false;
    const changed =
        channelListSignature(parsed) !== channelListSignature(channels);
    _playlistCacheAt = Date.now();
    cachePut('playlists', key, {
      at: _playlistCacheAt,
      type: currentPlaylistType,
      channels: parsed,
      tz: _xt ? _xt.tz : undefined,
      epgOffsetMin: _xt ? _xt.epgOffsetMin : undefined
    });
    if (changed) {
      const delta = parsed.length - channels.length;
      replaceChannelList(parsed);
      showEPGToast(
          `Playlist updated: ${channels.length.toLocaleString()} channels (${
              delta >= 0 ? '+' : ''}${delta})`,
          'success', 'Playlist');
      hideEPGToast(4000);
    } else if (force) {
      showEPGToast('Playlist is up to date', 'success', 'Playlist');
      hideEPGToast(2500);
    }
    return changed;
  } catch (e) {
    if (force) {
      showEPGToast(
          `Playlist refresh failed: ${e.message}`, 'error', 'Playlist');
      hideEPGToast(5000);
    }
    return false;
  } finally {
    _playlistRefreshing = false;
  }
}
function fmtAge(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * Gives the HLS URL of an Xtream live channel, with the user name and the
 * password in URL encoding.
 * @param {string} base The server address, with no slash at the end.
 * @param {string} username The user name.
 * @param {string} password The password.
 * @param {*} streamId The stream ID.
 * @return {string} The URL.
 */
function xtreamLiveUrl(base, username, password, streamId) {
  return `${base}/live/${encodeURIComponent(username)}/${
      encodeURIComponent(password)}/${streamId}.m3u8`;
}

// ----- Loading playlists -----
// Everything after a channel list is available (parsed fresh or read from the
// cache)
function applyM3UChannels(parsed, url, epgUrl, fromCache) {
  channels = parsed;
  buildChannelIndexMap();
  storageSet('last_m3u_url', url);
  updateStartStatus(
      `Loaded ${channels.length.toLocaleString()} channels${
          fromCache ? ' (cached)' : ''}!`,
      false, true, false, 100);
  currentSearchQuery = '';
  searchInput.value = '';
  _activePlaylistKey = 'm:' + url;
  epgOffsetLoad();
  favoritesLoad();
  _m3uSource = {url, epgUrl};
  rememberLastPlaylist(_activePlaylistKey);
  currentGroup = initialGroupFor(_activePlaylistKey);
  currentPlaylistType = 'm3u';
  extractGroups();
  validateCurrentGroup();
  resetStdFocus();
  startPage.classList.add('hidden');
  mainApp.style.display = 'flex';
  perfMark(`channels-applied(${channels.length}${fromCache ? ',cache' : ''})`);
  renderChannelList();
  perfMark('list-rendered');
  statusArea.innerText = `✅ ${channels.length.toLocaleString()} channels`;
  // The timers do nothing when a different playlist opened meanwhile
  const key = _activePlaylistKey;
  if (channels.length)
    setTimeout(() => {
      if (_activePlaylistKey === key) selectInitialChannel();
    }, 500);
  // Start EPG load in background after playlist is ready
  if (epgUrl)
    setTimeout(() => {
      if (_activePlaylistKey === key) loadEPG(epgUrl);
    }, 1500);
}
async function loadM3UFromUrl(url, epgUrl = '') {
  if (isLoading) return;
  isLoading = true;
  if (_m3uAbortController) _m3uAbortController.abort();
  _m3uAbortController = new AbortController();
  resetLazyEpg();
  resetVodState(false);
  epgData.clear();
  epgIdMap.clear();
  _epgLoadedAt = 0;
  currentEpgUrl = epgUrl;
  setLoadSelectedButtonEnabled(false);
  updateStartStatus(`Fetching playlist...`, false, false, true, 0);
  showLoading(true, 'Fetching playlist...');
  try {
    const key = 'm:' + url;
    const cached = await cacheGet('playlists', key);
    if (cached && Array.isArray(cached.channels) && cached.channels.length) {
      applyM3UChannels(cached.channels, url, epgUrl, true);
      _playlistCacheAt = cached.at || 0;
      setTimeout(() => refreshPlaylistInBackground(false), 2500);
      return;
    }
    const response = await fetch(url, {signal: _m3uAbortController.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let content = await response.text();
    updateStartStatus(
        `Downloaded ${
            (content.length / 1024 / 1024).toFixed(1)} MB, parsing...`,
        false, false, true, 20);
    const parsed = await parseM3UStreaming(content);
    content = null;  // free memory
    if (!parsed.length) throw new Error('No channels found');
    applyM3UChannels(parsed, url, epgUrl, false);
    _playlistCacheAt = Date.now();
    cachePut(
        'playlists', key,
        {at: _playlistCacheAt, type: 'm3u', channels: parsed});
  } catch (err) {
    if (err.name !== 'AbortError') {
      updateStartStatus(`Error: ${err.message}`, true, false, false, 0);
      setLoadSelectedButtonEnabled(true);
    }
  } finally {
    isLoading = false;
    _m3uAbortController = null;
    showLoading(false);
    setTimeout(() => {
      if (!startPage.classList.contains('hidden'))
        updateStartStatus('Ready', false, false, false, 0);
    }, 3000);
  }
}

function loadDemoM3U() {
  if (isLoading) return;
  isLoading = true;
  resetLazyEpg();
  resetVodState(false);
  epgData.clear();
  epgIdMap.clear();
  currentEpgUrl = '';
  setLoadSelectedButtonEnabled(false);
  updateStartStatus(`Loading demo playlist...`, false, false, true, 30);
  const demoContent = `#EXTM3U
#EXTINF:-1 tvg-id="demo1" tvg-logo="https://cdn-icons-png.flaticon.com/512/1048/1048998.png" group-title="Nature",🌿 Nature 4K
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 tvg-id="demo2" tvg-logo="https://cdn-icons-png.flaticon.com/512/2153/2153788.png" group-title="Movies",🐰 Big Buck Bunny
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 tvg-id="demo3" tvg-logo="https://cdn-icons-png.flaticon.com/512/3096/3096127.png" group-title="Sports",⚽ Live Sports
https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8
#EXTINF:-1 tvg-id="demo4" tvg-logo="" group-title="News",📰 News Channel
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`;
  setTimeout(async () => {
    const parsed = await parseM3UStreaming(demoContent);
    channels = parsed;
    buildChannelIndexMap();
    updateStartStatus(
        `Demo loaded: ${channels.length} channels`, false, true, false, 100);
    currentSearchQuery = '';
    searchInput.value = '';
    _activePlaylistKey = 'm:demo';  // not remembered for auto-load
    epgOffsetLoad();
    favoritesLoad();
    currentGroup = initialGroupFor(_activePlaylistKey);
    currentPlaylistType = 'm3u';
    extractGroups();
    validateCurrentGroup();
    resetStdFocus();
    startPage.classList.add('hidden');
    mainApp.style.display = 'flex';
    renderChannelList();
    statusArea.innerText = `🎬 Demo: ${channels.length} channels`;
    if (channels.length) setTimeout(selectInitialChannel, 500);
    isLoading = false;
    setLoadSelectedButtonEnabled(true);
    showLoading(false);
  }, 100);
}
