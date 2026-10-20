/**
 * @fileoverview Movies and series: catalog, sort and genre, favorites and
 * progress, home, grid, details, and browse keys.
 */

// ----- VOD (Movies & Series) -----
// Xtream playlists get a Live / Movies / Series mode switch. Catalogs load per
// category on demand; the full list is fetched once (in the background) for
// Recently Added and "Search all". Playback reuses the single <video>, moved
// into an app-owned full-viewport container so the OSD can draw over it.
const VOD_COLS = 6;
const VOD_PROGRESS_MAX = 300;
const VOD_MIN_RESUME_S = 120;  // nothing counts as "in progress" before 2
                               // minutes (10% for very short items)
function vodMinResume(dur) {
  return dur > 0 ? Math.min(VOD_MIN_RESUME_S, dur * 0.1) : VOD_MIN_RESUME_S;
}
const VOD_NEXT_COUNTDOWN = 10;
let vodGrid = {cols: VOD_COLS, cardW: 0, rowH: 0, total: 0};
const vodGridRows = new Map();  // rowIdx -> element
let _vodSearchTimer = null;

function isAdultName(n) {
  return /adult|xxx|18\+|porn|erotic|\bsex\b/i.test(n || '');
}
function fmtClock(secs) {
  secs = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60),
        s = secs % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' +
      String(s).padStart(2, '0');
}
function fmtRuntime(secs) {
  if (!secs) return '';
  if (secs < 60) return '< 1 min';
  const m = Math.round(secs / 60);
  return m >= 60 ?
      `${Math.floor(m / 60)} hr ${String(m % 60).padStart(2, '0')} min` :
      `${m} min`;
}
function parseDurationSecs(info) {
  if (!info) return 0;
  if (info.duration_secs) return parseInt(info.duration_secs) || 0;
  const d = String(info.duration || '');
  const m = d.match(/^(\d+):(\d+):(\d+)/);
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  const mm = d.match(/^(\d+)\s*min/i);
  return mm ? (+mm[1]) * 60 : 0;
}
function yearOf(s) {
  const m = String(s || '').match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}
function el(tag, cls, html) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
}

function xtApi(action, params) {
  if (!_xt) return Promise.reject(new Error('No Xtream playlist loaded'));
  let url = `${_xt.base}/player_api.php?username=${_xt.u}&password=${
      _xt.pw}&action=${action}`;
  for (const k in params || {})
    if (params[k] !== undefined && params[k] !== null)
      url += `&${k}=${encodeURIComponent(params[k])}`;
  return fetch(url).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}
function normMovie(s) {
  return {
    kind: 'movie',
    id: String(s.stream_id),
    name: s.name || 'Untitled',
    icon: s.stream_icon || '',
    rating: parseFloat(s.rating) || 0,
    added: (parseInt(s.added) || 0) * 1000,
    ext: s.container_extension || 'mp4',
    catId: String(s.category_id),
    genre: s.genre || '',
    releaseDate: s.releasedate || s.release_date || s.releaseDate ||
        (s.year ? String(s.year) : '')
  };
}
// ── sort & genre filter (Green in the grid) ──────────────────
const VOD_SORTS = [
  {v: 'default', label: 'Provider order'}, {v: 'added', label: 'Newest added'},
  {v: 'az', label: 'A – Z'}, {v: 'year', label: 'Year (newest)'},
  {v: 'rating', label: 'Rating'}
];
function vodSortItems(items, sort) {
  if (!sort || sort === 'default') return items;
  const out = items.slice();
  if (sort === 'added')
    out.sort((a, b) => (b.added || 0) - (a.added || 0));
  else if (sort === 'az')
    out.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'year')
    out.sort(
        (a, b) => (yearOf(b.releaseDate) || 0) - (yearOf(a.releaseDate) || 0));
  else if (sort === 'rating')
    out.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return out;
}
function itemGenres(it) {
  return String(it.genre || '')
      .split(/[,/|]/)
      .map(g => g.trim())
      .filter(Boolean);
}
// Genres present in the current base list, most frequent first (capped so the
// menu stays usable)
function vodGenreOptions(items) {
  const count = new Map();
  for (const it of items)
    for (const g of itemGenres(it)) count.set(g, (count.get(g) || 0) + 1);
  return [...count.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 40)
      .map(([g, n]) => ({g, n}));
}
function vodFilterGenre(items, genre) {
  return genre ? items.filter(it => itemGenres(it).includes(genre)) : items;
}
// Items shown in the grid: base list → genre → search → sort (search keeps its
// own relevance order)
function vodDerivedItems() {
  const q = (vodNav.query || '').trim();
  const base = vodFilterGenre(vodNav.baseItems, vodNav.genre);
  return q ? vodSearchItems(base, q) : vodSortItems(base, vodNav.sort);
}
function vodSortLabel() {
  const s = VOD_SORTS.find(x => x.v === vodNav.sort);
  return s && s.v !== 'default' ? s.label : '';
}
let vodSortOpen = false, vodSortFocus = 0, _vodSortRows = [];
function openVodSort() {
  if (vodMode === 'live' || vodNav.screen !== 'grid') return;
  const ov = document.getElementById('vodSortOverlay');
  if (!ov) return;
  vodSortOpen = true;
  const genres = vodGenreOptions(vodNav.baseItems);
  _vodSortRows =
      VOD_SORTS.map(s => ({kind: 'sort', v: s.v, label: s.label}))
          .concat(
              [{kind: 'genre', v: null, label: 'All genres'}],
              genres.map(x => ({kind: 'genre', v: x.g, label: x.g, n: x.n})));
  vodSortFocus = Math.max(
      0,
      _vodSortRows.findIndex(
          r => r.kind === 'sort' && r.v === (vodNav.sort || 'default')));
  ov.classList.remove('hidden');
  renderVodSort();
}
function closeVodSort() {
  if (!vodSortOpen) return;
  vodSortOpen = false;
  const ov = document.getElementById('vodSortOverlay');
  if (ov) ov.classList.add('hidden');
  const list = document.getElementById('vodSortList');
  if (list) list.innerHTML = '';
}
function renderVodSort() {
  const list = document.getElementById('vodSortList');
  if (!list) return;
  list.innerHTML = '';
  let lastKind = null;
  _vodSortRows.forEach((r, i) => {
    if (r.kind !== lastKind) {
      const h = document.createElement('div');
      h.className = 'settings-section';
      h.textContent = r.kind === 'sort' ? 'Sort by' : 'Genre';
      list.appendChild(h);
      lastKind = r.kind;
    }
    const on = r.kind === 'sort' ? (vodNav.sort || 'default') === r.v :
                                   (vodNav.genre || null) === r.v;
    const row = document.createElement('div');
    row.className = 'settings-row cats-row' +
        (i === vodSortFocus ? ' focused' : '') + (on ? ' on' : '');
    row.innerHTML = `<div class="settings-label"><div class="settings-name">${
        escapeHtml(r.label)}${
        r.n ?
            ` <span class="settings-sub">${r.n}</span>` :
            ''}</div></div><div class="settings-value"><span class="settings-val">${
        on ? '●' : ''}</span></div>`;
    row.addEventListener('click', () => {
      vodSortFocus = i;
      vodSortActivate();
    });
    list.appendChild(row);
  });
  const f = list.querySelector('.cats-row.focused');
  if (f) f.scrollIntoView({block: 'nearest'});
}
function vodSortActivate() {
  const r = _vodSortRows[vodSortFocus];
  if (!r) return;
  if (r.kind === 'sort') {
    vodNav.sort = r.v;
    if (_activePlaylistKey) {
      getPlaylistState(_activePlaylistKey).vodSort = r.v;
      savePlaylistState();
    }
  } else
    vodNav.genre = r.v;
  vodNav.items = vodDerivedItems();
  vodNav.focus = 0;
  vodNav.gridScroll = 0;
  renderVodGrid();
  renderVodSort();
}
function handleVodSortKey(e) {
  const k = e.key, kc = e.keyCode;
  if (k === 'ArrowUp' || kc === 38) {
    e.preventDefault();
    vodSortFocus = Math.max(0, vodSortFocus - 1);
    renderVodSort();
  } else if (k === 'ArrowDown' || kc === 40) {
    e.preventDefault();
    vodSortFocus = Math.min(_vodSortRows.length - 1, vodSortFocus + 1);
    renderVodSort();
  } else if (k === 'Enter' || kc === 13) {
    e.preventDefault();
    vodSortActivate();
  } else if (kc === 404 || k === 'ColorF1Green') {
    e.preventDefault();
    closeVodSort();
  }
}
function normSeries(s) {
  return {
    kind: 'series',
    id: String(s.series_id),
    name: s.name || 'Untitled',
    icon: s.cover || '',
    rating: parseFloat(s.rating) || 0,
    added: (parseInt(s.last_modified) || 0) * 1000,
    catId: String(s.category_id),
    plot: s.plot || '',
    genre: s.genre || '',
    releaseDate: s.releaseDate || s.release_date || '',
    cast: s.cast || '',
    director: s.director || '',
    backdrop: Array.isArray(s.backdrop_path) ? s.backdrop_path[0] : ''
  };
}
function vodStreamUrl(id, ext) {
  return `${_xt.base}/movie/${_xt.user}/${_xt.pass}/${id}.${ext || 'mp4'}`;
}
function episodeUrl(ep) {
  return `${_xt.base}/series/${_xt.user}/${_xt.pass}/${ep.id}.${
      ep.ext || 'mp4'}`;
}

// ── catalog ──────────────────────────────────────────────────
async function loadVodCats(mode) {
  if (mode === 'movies' ? vodCats : seriesCats) return;
  const raw = await xtApi(
      mode === 'movies' ? 'get_vod_categories' : 'get_series_categories');
  const cats = Array.isArray(raw) ?
      raw.map(c => ({
                id: String(c.category_id),
                name: c.category_name || '',
                adult: isAdultName(c.category_name)
              })) :
      [];
  if (mode === 'movies')
    vodCats = cats;
  else
    seriesCats = cats;
}
async function loadVodCategory(mode, catId) {
  const cache = mode === 'movies' ? vodByCat : seriesByCat;
  if (cache.has(catId)) return cache.get(catId);
  const raw = await xtApi(
      mode === 'movies' ? 'get_vod_streams' : 'get_series',
      {category_id: catId});
  const items = Array.isArray(raw) ?
      raw.map(mode === 'movies' ? normMovie : normSeries) :
      [];
  items.sort((a, b) => b.added - a.added);
  cache.set(catId, items);
  return items;
}
// Full catalog, fetched once per mode per session; chunk-parsed so the UI stays
// responsive
function loadVodAll(mode) {
  const have = mode === 'movies' ? vodAll : seriesAll;
  if (have) return Promise.resolve(have);
  if (_vodAllLoading && _vodAllLoading.mode === mode) return _vodAllLoading.p;
  const xt = _xt;
  const p = (async () => {
    const resp = await fetch(
        `${xt.base}/player_api.php?username=${xt.u}&password=${xt.pw}&action=${
            mode === 'movies' ? 'get_vod_streams' : 'get_series'}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    await new Promise(r => setTimeout(r, 0));
    const raw = JSON.parse(text);
    const norm = mode === 'movies' ? normMovie : normSeries;
    const out = [];
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2000) {
        const end = Math.min(i + 2000, raw.length);
        for (let j = i; j < end; j++) out.push(norm(raw[j]));
        await new Promise(r => setTimeout(r, 0));
      }
    }
    if (_xt !== xt) throw new Error('playlist changed');
    const recent = out.slice().sort((a, b) => b.added - a.added).slice(0, 60);
    if (mode === 'movies') {
      vodAll = out;
      vodRecent = recent;
    } else {
      seriesAll = out;
      seriesRecent = recent;
    }
    return out;
  })();
  _vodAllLoading = {mode, p};
  p.then(
      () => {
        if (_vodAllLoading && _vodAllLoading.p === p) _vodAllLoading = null;
      },
      () => {
        _vodAllLoading = null;
      });
  return p;
}
function adultCatIds(mode) {
  const cats = (mode === 'movies' ? vodCats : seriesCats) || [];
  return new Set(cats.filter(c => c.adult).map(c => c.id));
}
function vodVisible(items, mode) {
  if (settings.showAdult) return items;
  const adult = adultCatIds(mode);
  return adult.size ? items.filter(i => !adult.has(i.catId)) : items;
}
function vodSearchItems(items, query) {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const terms = q.split(/\s+/);
  const scored = [];
  for (let i = 0; i < items.length; i++) {
    const n = items[i].name.toLowerCase();
    let score = 0;
    if (n === q)
      score = 100;
    else if (n.startsWith(q))
      score = 90;
    else {
      let m = 0;
      for (const t of terms)
        if (n.includes(t)) m++;
      score = m === terms.length ? 60 : 0;
    }
    if (score) scored.push({i, score});
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => items[s.i]);
}

// ── favorites & progress ─────────────────────────────────────
function vodFavBucket() {
  const k = _activePlaylistKey || '_';
  if (!vodFavs[k]) vodFavs[k] = {movies: {}, series: {}};
  return vodFavs[k][vodMode === 'series' ? 'series' : 'movies'];
}
function isVodFav(item) {
  const k = _activePlaylistKey || '_';
  const b = vodFavs[k];
  return !!(b && b[item.kind === 'series' ? 'series' : 'movies'][item.id]);
}
function toggleVodFav(item) {
  const k = _activePlaylistKey || '_';
  if (!vodFavs[k]) vodFavs[k] = {movies: {}, series: {}};
  const bucket = vodFavs[k][item.kind === 'series' ? 'series' : 'movies'];
  if (bucket[item.id])
    delete bucket[item.id];
  else {
    const c = Object.assign({}, item);
    delete c._resume;
    bucket[item.id] = c;
  }
  saveJson('iptv_vod_favorites', vodFavs);
}
function vodFavItems() {
  return Object.values(vodFavBucket())
      .sort((a, b) => a.name.localeCompare(b.name));
}

function progressKeyFor(kind, id, seriesId) {
  return `${_activePlaylistKey || '_'}|` +
      (kind === 'movie' ? `m:${id}` : `e:${seriesId}:${id}`);
}
function movieProgress(item) {
  const e = vodProgress[progressKeyFor('movie', item.id)];
  return e && !e.watched && e.dur && e.pos >= vodMinResume(e.dur) ? e : null;
}
function removeVodProgress(item) {
  const prefix = `${_activePlaylistKey || '_'}|`;
  if (item.kind === 'movie')
    delete vodProgress[prefix + 'm:' + item.id];
  else
    for (const k of Object.keys(vodProgress))
      if (k.startsWith(prefix + 'e:' + item.id + ':')) delete vodProgress[k];
  saveJson('iptv_vod_progress', vodProgress);
}
function episodeProgress(seriesId, epId) {
  return vodProgress[progressKeyFor('episode', epId, seriesId)] || null;
}
// Manual watched state (details page button for movies, Red on an episode row
// for series)
function isMovieWatched(item) {
  const e = vodProgress[progressKeyFor('movie', item.id)];
  return !!(e && e.watched);
}
function setMovieWatched(item, info, on) {
  const key = progressKeyFor('movie', item.id);
  if (!on)
    delete vodProgress[key];
  else {
    const dur = (info && info.duration) ||
        (vodProgress[key] && vodProgress[key].dur) || 1;
    vodProgress[key] = {
      kind: 'movie',
      id: item.id,
      name: item.name,
      icon: item.icon,
      ext: item.ext,
      catId: item.catId,
      rating: item.rating || 0,
      pos: dur,
      dur,
      at: Date.now(),
      watched: true
    };
  }
  pruneVodProgress();
  saveJson('iptv_vod_progress', vodProgress);
}
function episodeIsLast(seasons, ep) {
  for (let i = seasons.length - 1; i >= 0; i--) {
    const eps = seasons[i].episodes;
    if (!eps.length) continue;
    return eps[eps.length - 1].id === ep.id;
  }
  return true;
}
function setEpisodeWatched(item, ep, seasons, on, noSave) {
  const key = progressKeyFor('episode', ep.id, item.id);
  if (!on)
    delete vodProgress[key];
  else {
    const dur = ep.duration || (vodProgress[key] && vodProgress[key].dur) || 1;
    vodProgress[key] = {
      kind: 'episode',
      id: ep.id,
      name: item.name,
      icon: item.icon,
      catId: item.catId,
      rating: item.rating || 0,
      pos: dur,
      dur,
      at: Date.now(),
      watched: true,
      seriesId: item.id,
      season: ep.season,
      epNum: ep.num,
      epTitle: ep.title,
      epId: ep.id,
      lastOfSeries: episodeIsLast(seasons, ep)
    };
  }
  if (noSave) return;
  pruneVodProgress();
  saveJson('iptv_vod_progress', vodProgress);
}
function setSeasonWatched(item, season, seasons, on) {
  if (!season) return;
  // Entries get ascending 'at' in series order, so the newest entry is the last
  // episode marked and Continue Watching / "Play" resume after it (or drop the
  // series when that was the final episode)
  const flat = [];
  for (const s of seasons)
    for (const ep of s.episodes) flat.push(ep.id);
  const base = Date.now() - flat.length;
  for (const ep of season.episodes) {
    setEpisodeWatched(item, ep, seasons, on, true);
    if (on)
      vodProgress[progressKeyFor('episode', ep.id, item.id)].at =
          base + flat.indexOf(ep.id);
  }
  pruneVodProgress();
  saveJson('iptv_vod_progress', vodProgress);
}
function lastEpisodeEntry(seriesId) {
  const prefix = `${_activePlaylistKey || '_'}|e:${seriesId}:`;
  let best = null;
  for (const k in vodProgress)
    if (k.startsWith(prefix)) {
      const e = vodProgress[k];
      if (!best || e.at > best.at) best = e;
    }
  return best;
}
// Continue Watching: in-progress movies, or per series the latest unfinished
// episode
function continueWatchingItems(mode) {
  const prefix = `${_activePlaylistKey || '_'}|`;
  const out = [];
  if (mode === 'movies') {
    for (const k in vodProgress) {
      const e = vodProgress[k];
      if (k.startsWith(prefix + 'm:') && !e.watched && e.dur &&
          e.pos >= vodMinResume(e.dur))
        out.push(e);
    }
    out.sort((a, b) => b.at - a.at);
    return out.map(e => ({
                     kind: 'movie',
                     id: e.id,
                     name: e.name,
                     icon: e.icon,
                     rating: e.rating || 0,
                     added: 0,
                     ext: e.ext,
                     catId: e.catId,
                     _resume: e
                   }));
  }
  const bySeries = new Map();
  for (const k in vodProgress) {
    const e = vodProgress[k];
    if (!k.startsWith(prefix + 'e:')) continue;
    const cur = bySeries.get(e.seriesId);
    if (!cur || e.at > cur.at) bySeries.set(e.seriesId, e);
  }
  for (const e of bySeries.values()) {
    if (e.watched && e.lastOfSeries) continue;  // finished the series
    if (!e.watched && !(e.dur && e.pos >= vodMinResume(e.dur)))
      continue;  // barely started
    out.push({
      kind: 'series',
      id: e.seriesId,
      name: e.name,
      icon: e.icon,
      rating: e.rating || 0,
      added: 0,
      catId: e.catId,
      _resume: e
    });
  }
  out.sort((a, b) => b._resume.at - a._resume.at);
  return out;
}
function pruneVodProgress() {
  const keys = Object.keys(vodProgress);
  if (keys.length <= VOD_PROGRESS_MAX) return;
  keys.sort((a, b) => (vodProgress[a].at || 0) - (vodProgress[b].at || 0));
  for (let i = 0; i < keys.length - VOD_PROGRESS_MAX; i++)
    delete vodProgress[keys[i]];
}

// ── mode switch & layout ─────────────────────────────────────
function resetVodState(showSwitch) {
  vodMode = 'live';
  vodCats = null;
  seriesCats = null;
  vodByCat.clear();
  seriesByCat.clear();
  vodAll = null;
  seriesAll = null;
  vodRecent = null;
  seriesRecent = null;
  _vodAllLoading = null;
  vodInfoCache.clear();
  seriesInfoCache.clear();
  vodNav.screen = 'home';
  vodNav.list = 'home';
  vodNav.catId = null;
  vodNav.items = [];
  vodNav.baseItems = [];
  vodNav.focus = 0;
  vodNav.zone = 'content';
  vodNav.homeRow = 0;
  vodNav.homeCol = {};
  vodNav.detail = null;
  vodNav.query = '';
  vodGridRows.clear();
  const ms = document.getElementById('modeSwitch');
  if (ms) {
    ms.style.display = showSwitch ? '' : 'none';
    ms.querySelectorAll('.mode-btn')
        .forEach(b => b.classList.toggle('active', b.dataset.mode === 'live'));
  }
  const vv = document.getElementById('vodView');
  if (vv) vv.style.display = 'none';
  const vd = document.getElementById('vodDetails');
  if (vd) {
    vd.style.display = 'none';
    vd.innerHTML = '';
  }
  const vh = document.getElementById('vodHome');
  if (vh) vh.innerHTML = '';
  const vg = document.getElementById('vodGridInner');
  if (vg) vg.innerHTML = '';
}
function cycleVodMode() {
  const order = ['live', 'movies', 'series'];
  setVodMode(order[(order.indexOf(vodMode) + 1) % order.length]);
}
function setVodMode(mode) {
  if (mode === vodMode) return;
  if (mode !== 'live' && currentPlaylistType !== 'xtream') return;
  if (vodPlay.active) stopVodPlayback(false);
  if (livePlayer.active) exitLivePlayer();
  const prev = vodMode;
  vodMode = mode;
  document.querySelectorAll('#modeSwitch .mode-btn')
      .forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const sv = document.getElementById('standardView'),
        ev = document.getElementById('epgView'),
        vv = document.getElementById('vodView');
  if (mode === 'live') {
    vv.style.display = 'none';
    if (currentPlaylistType === 'xtream')
      ev.style.display = 'flex';
    else
      sv.style.display = 'flex';
    renderGroupsList();
    refreshCurrentView();
    if (prev !== 'live' && currentChannelIndex >= 0)
      selectChannel(currentChannelIndex);  // live streams cannot resume; reload
                                           // the channel
    return;
  }
  if (prev === 'live') {
    stopStallWatchdog();
    if (_errRetryTimer) {
      clearTimeout(_errRetryTimer);
      _errRetryTimer = null;
    }
    videoPlayer.pause();
    liveEngineDestroy();
  }
  sv.style.display = 'none';
  ev.style.display = 'none';
  vv.style.display = 'flex';
  vodNav.detail = null;
  document.getElementById('vodDetails').style.display = 'none';
  loadVodCats(mode)
      .then(() => {
        if (vodMode === mode) openVodList('home');
      })
      .catch(err => {
        if (vodMode === mode) {
          renderVodCats();
          showVodEmpty(`Could not load categories: ${err.message}`);
        }
      });
  renderVodCats();
  showVodEmpty('Loading …');
}
function setVodHeader(title, count) {
  document.getElementById('vodTitle').textContent = title;
  document.getElementById('vodCount').textContent = count || '';
  const si = document.getElementById('vodSearchInput');
  si.placeholder = vodNav.list === 'all' ?
      (vodMode === 'movies' ? 'Search all movies…' : 'Search all series…') :
      (vodNav.list === 'cat' ? `Search in ${title.replace(/^\S+\s/, '')}…` :
                               'Search…');
}
function showVodEmpty(msg) {
  document.getElementById('vodHome').style.display = 'none';
  document.getElementById('vodGrid').style.display = 'none';
  const e = document.getElementById('vodEmpty');
  e.style.display = '';
  e.textContent = msg;
}

// Categories in the groups column while in a VOD mode
function renderVodCats() {
  const pinnedDiv = document.getElementById('groupsPinned');
  groupsListDiv.innerHTML = '';
  if (pinnedDiv) pinnedDiv.innerHTML = '';
  const cats = (vodMode === 'movies' ? vodCats : seriesCats) || [];
  const hdr = document.querySelector('.groups-header span');
  if (hdr) hdr.textContent = '📁 Categories';
  const mk = (icon, label, list, catId) => {
    const d =
        el('div',
           'group-item' +
               (vodNav.list === list &&
                        (list !== 'cat' || vodNav.catId === catId) ?
                    ' active' :
                    ''));
    d.dataset.list = list;
    if (catId) d.dataset.catId = catId;
    d.innerHTML = `<span class="group-folder">${icon}</span><span>${
        escapeHtml(label)}</span>`;
    d.onclick = () => {
      vodNav.zone = 'cats';
      openVodList(list, catId);
    };
    return d;
  };
  if (pinnedDiv) {
    pinnedDiv.appendChild(mk('🏠', 'Home', 'home'));
    pinnedDiv.appendChild(mk('⭐', 'Favorites', 'favs'));
    pinnedDiv.appendChild(mk(
        '🔍', vodMode === 'movies' ? 'Search all movies' : 'Search all series',
        'all'));
  }
  for (const c of cats) {
    if (c.adult && !settings.showAdult) continue;
    groupsListDiv.appendChild(mk('📁', c.name, 'cat', c.id));
  }
  updateVodCatFocus(false);
}
function vodActiveCatIdx() {
  const els = _groupItemEls();
  for (let i = 0; i < els.length; i++)
    if (els[i].classList.contains('active')) return i;
  return 0;
}
function updateVodCatFocus(scroll) {
  const els = _groupItemEls();
  for (let i = 0; i < els.length; i++)
    els[i].classList.toggle(
        'focused', vodNav.zone === 'cats' && i === vodNav.catIdx);
  if (scroll && els[vodNav.catIdx])
    els[vodNav.catIdx].scrollIntoView({block: 'nearest'});
}

async function openVodList(list, catId) {
  vodNav.list = list;
  vodNav.catId = catId || null;
  vodNav.focus = 0;
  vodNav.gridScroll = 0;
  vodNav.query = '';
  vodNav.detail = null;
  document.getElementById('vodDetails').style.display = 'none';
  const si = document.getElementById('vodSearchInput');
  si.value = '';
  if (vodNav.zone !== 'cats') vodNav.zone = 'content';
  renderVodCats();
  if (list === 'home') {
    vodNav.screen = 'home';
    renderVodHome();
    return;
  }
  vodNav.screen = 'grid';
  let items = null;
  if (list === 'favs')
    items = vodFavItems();
  else {
    showVodEmpty('Loading …');
    const mode = vodMode;
    try {
      items = list === 'all' ? vodVisible(await loadVodAll(mode), mode) :
                               await loadVodCategory(mode, catId);
    } catch (err) {
      if (vodMode === mode) showVodEmpty(`Could not load: ${err.message}`);
      return;
    }
    if (vodMode !== mode || vodNav.list !== list ||
        vodNav.catId !== (catId || null))
      return;  // user moved on
  }
  vodNav.baseItems = items;
  vodNav.genre = null;  // a genre filter belongs to the list it was chosen in
  vodNav.sort =
      (_activePlaylistKey && getPlaylistState(_activePlaylistKey).vodSort) ||
      'default';
  vodNav.items = vodDerivedItems();
  renderVodGrid();
  if (list === 'all') focusVodSearch();
}
function applyVodSearch() {
  const q = vodNav.query || '';
  if (vodNav.screen === 'home') {
    if (q.trim()) {
      openVodList('all').then(() => {
        vodNav.query = q;
        document.getElementById('vodSearchInput').value = q;
        applyVodSearch();
      });
    }
    return;
  }
  vodNav.items = vodDerivedItems();
  vodNav.focus = 0;
  vodNav.gridScroll = 0;
  renderVodGrid();
}
function focusVodSearch() {
  vodNav.zone = 'search';
  refreshVodFocus();
  const si = document.getElementById('vodSearchInput');
  si.focus();
}

// ── home rows ────────────────────────────────────────────────
function vodHomeRows() {
  const rows = [];
  const cw = continueWatchingItems(vodMode);
  if (cw.length)
    rows.push({
      key: 'cw',
      title: '▶ Continue Watching',
      sub: `${cw.length} in progress · Red removes`,
      items: cw.slice(0, 30)
    });
  const recent = vodMode === 'movies' ? vodRecent : seriesRecent;
  if (recent)
    rows.push({
      key: 'recent',
      title: '🆕 Recently Added',
      sub: '',
      items: vodVisible(recent, vodMode).slice(0, 18)
    });
  else
    rows.push({
      key: 'recent',
      title: '🆕 Recently Added',
      sub: 'loading …',
      items: []
    });
  const favs = vodFavItems();
  if (favs.length)
    rows.push({
      key: 'favs',
      title: '⭐ Favorites',
      sub: `${favs.length}`,
      items: favs.slice(0, 30)
    });
  return rows;
}
function renderVodHome() {
  const home = document.getElementById('vodHome');
  document.getElementById('vodGrid').style.display = 'none';
  document.getElementById('vodEmpty').style.display = 'none';
  home.style.display = '';
  const cats = ((vodMode === 'movies' ? vodCats : seriesCats) ||
                []).filter(c => settings.showAdult || !c.adult);
  const all = vodMode === 'movies' ? vodAll : seriesAll;
  const visibleAll = all ? vodVisible(all, vodMode) : null;
  setVodHeader(
      vodMode === 'movies' ? '🎬 Movies' : '📺 Series',
      `${visibleAll ? visibleAll.length.toLocaleString() + ' titles · ' : ''}${
          cats.length} categories`);
  const rows = vodHomeRows();
  vodNav.homeRows = rows;
  home.innerHTML = '';
  const focusRows = rows.filter(r => r.items.length);
  if (vodNav.homeRow >= focusRows.length)
    vodNav.homeRow = Math.max(0, focusRows.length - 1);
  rows.forEach(r => {
    const sec = el('div', 'vod-row');
    sec.appendChild(el(
        'h2', 'vod-row-title', `${r.title} <span>${escapeHtml(r.sub)}</span>`));
    const strip = el('div', 'vod-strip');
    if (!r.items.length)
      strip.appendChild(
          el('div', 'vod-strip-empty',
             r.key === 'recent' ? 'Loading the catalog …' : 'Nothing yet'));
    r.items.forEach(
        (it, ci) =>
            strip.appendChild(buildVodCard(it, false, `${r.key}:${ci}`)));
    sec.appendChild(strip);
    home.appendChild(sec);
  });
  if (!all && !(_vodAllLoading && _vodAllLoading.mode === vodMode)) {
    const mode = vodMode;
    loadVodAll(mode)
        .then(() => {
          if (vodMode === mode && vodNav.screen === 'home') renderVodHome();
        })
        .catch(() => {
          if (vodMode === mode && vodNav.screen === 'home') {
            const r = home.querySelector('.vod-strip-empty');
            if (r) r.textContent = 'Recently Added unavailable';
          }
        });
  }
  updateVodHomeFocus();
}
function vodHomeFocusRows() {
  return (vodNav.homeRows || []).filter(r => r.items.length);
}
function updateVodHomeFocus() {
  const home = document.getElementById('vodHome');
  home.querySelectorAll('.vod-card.focused')
      .forEach(c => c.classList.remove('focused'));
  if (vodNav.zone !== 'content') return;
  const rows = vodHomeFocusRows();
  const r = rows[vodNav.homeRow];
  if (!r) return;
  const col = Math.min(vodNav.homeCol[r.key] || 0, r.items.length - 1);
  vodNav.homeCol[r.key] = col;
  const card = home.querySelector(`.vod-card[data-pos="${r.key}:${col}"]`);
  if (card) {
    card.classList.add('focused');
    card.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }
}

// ── cards & grid ─────────────────────────────────────────────
function buildVodCard(item, focused, pos) {
  const card = el('div', 'vod-card' + (focused ? ' focused' : ''));
  if (pos !== undefined) card.dataset.pos = pos;
  const fav = isVodFav(item);
  let pct = 0, meta = '';
  const r = item._resume;
  if (r && r.dur) {
    pct = Math.min(100, Math.round(r.pos / r.dur * 100));
    const left = Math.max(0, r.dur - r.pos);
    meta = item.kind === 'series' ?
        `S${r.season} E${r.epNum} · ${fmtRuntime(left)} left` :
        `${fmtRuntime(left)} left`;
  } else if (item.kind === 'movie') {
    const p = movieProgress(item);
    if (p) pct = Math.min(100, Math.round(p.pos / p.dur * 100));
    meta = item.rating ? `★ ${item.rating.toFixed(1)}` : '';
  } else {
    meta =
        [
          yearOf(item.releaseDate),
          item.rating ? `★ ${item.rating.toFixed(1)}` : ''
        ].filter(Boolean)
            .join(' · ');
  }
  card.innerHTML = `<div class="vod-poster"><span class="vod-poster-name">${
                       escapeHtml(item.name)}</span>` +
      (item.icon ?
           `<img loading="lazy" src="${
               escapeHtml(item.icon)}" alt="" onerror="this.remove()">` :
           '') +
      (fav ? '<span class="vod-star">★</span>' : '') +
      (item.kind === 'movie' && isMovieWatched(item) ?
           '<span class="vod-card-chk">✓</span>' :
           '') +
      (pct ? `<div class="vod-prog"><i style="width:${pct}%"></i></div>` : '') +
      `</div><div class="vod-card-t">${
                       escapeHtml(item.name)}</div><div class="vod-card-m">${
                       escapeHtml(meta)}</div>`;
  // A pointer click opens the title like OK does, and also moves the cursor to
  // this card, so Back from the details page returns to this card (and this
  // scroll position) instead of the top of the list
  card.addEventListener('click', () => {
    if (card.dataset.idx !== undefined) {
      vodNav.focus = +card.dataset.idx;
      vodNav.zone = 'content';
    } else if (card.dataset.pos) {
      const [key, ci] = card.dataset.pos.split(':');
      const ri = vodHomeFocusRows().findIndex(r => r.key === key);
      if (ri >= 0) {
        vodNav.homeRow = ri;
        vodNav.homeCol[key] = +ci || 0;
        vodNav.zone = 'content';
      }
    }
    openVodItem(item);
  });
  return card;
}
function renderVodGrid() {
  const home = document.getElementById('vodHome'),
        grid = document.getElementById('vodGrid'),
        empty = document.getElementById('vodEmpty');
  home.style.display = 'none';
  empty.style.display = 'none';
  grid.style.display = '';
  const items = vodNav.items;
  const cats = (vodMode === 'movies' ? vodCats : seriesCats) || [];
  const cat = cats.find(c => c.id === vodNav.catId);
  const title = vodNav.list === 'favs' ?
      '⭐ Favorites' :
      vodNav.list === 'all' ?
      (vodMode === 'movies' ? '🔍 All movies' : '🔍 All series') :
      '📁 ' + (cat ? cat.name : '');
  const viewBits = [
    vodNav.genre ? `🎭 ${vodNav.genre}` : '',
    vodSortLabel() ? `⇅ ${vodSortLabel()}` : ''
  ].filter(Boolean);
  setVodHeader(
      title,
      `${items.length.toLocaleString()} titles${
          vodNav.query ? ` · "${vodNav.query}"` : ''}${
          viewBits.length ? ' · ' + viewBits.join(' · ') :
                            ''} · Green: sort & genre`);
  const inner = document.getElementById('vodGridInner');
  inner.innerHTML = '';
  vodGridRows.clear();
  const cols = VOD_COLS, pad = 24, gap = 16;
  const W =
      grid.clientWidth || (mainApp.clientWidth - groupsColumn.clientWidth);
  const cardW =
      Math.max(100, Math.floor((W - pad * 2 - gap * (cols - 1)) / cols));
  const posterH = Math.round(cardW * 1.5);
  const capH = Math.round(3.2 * 16 * TEXT_SCALE);
  const rowH = posterH + capH + 18;
  vodGrid = {cols, cardW, rowH, total: Math.ceil(items.length / cols)};
  inner.style.height = `${vodGrid.total * rowH}px`;
  if (!items.length) {
    inner.innerHTML = `<div class="vod-empty-inline">${
        vodNav.query ? 'No matches' : 'Nothing here yet'}</div>`;
    return;
  }
  grid.scrollTop = vodNav.gridScroll || 0;
  renderVodGridRows();
  grid.onscroll = () => {
    vodNav.gridScroll = grid.scrollTop;
    requestAnimationFrame(renderVodGridRows);
  };
}
function renderVodGridRows() {
  const {cols, cardW, rowH, total} = vodGrid;
  const grid = document.getElementById('vodGrid'),
        inner = document.getElementById('vodGridInner');
  if (!total) return;
  const start = Math.max(0, Math.floor(grid.scrollTop / rowH) - 1);
  const end = Math.min(
      total - 1, Math.ceil((grid.scrollTop + grid.clientHeight) / rowH) + 1);
  for (const [r, rowEl] of vodGridRows)
    if (r < start || r > end) {
      rowEl.remove();
      vodGridRows.delete(r);
    }
  for (let r = start; r <= end; r++) {
    if (vodGridRows.has(r)) continue;
    const row = el('div', 'vod-grid-row');
    row.style.cssText = `top:${r * rowH}px;height:${
        rowH}px;grid-template-columns:repeat(${cols}, ${cardW}px)`;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= vodNav.items.length) break;
      const card = buildVodCard(
          vodNav.items[i], vodNav.zone === 'content' && i === vodNav.focus);
      card.dataset.idx = i;
      row.appendChild(card);
    }
    inner.appendChild(row);
    vodGridRows.set(r, row);
  }
}
function updateVodGridFocus() {
  const grid = document.getElementById('vodGrid'),
        inner = document.getElementById('vodGridInner');
  const {cols, rowH} = vodGrid;
  if (!vodNav.items.length) return;
  vodNav.focus = Math.max(0, Math.min(vodNav.items.length - 1, vodNav.focus));
  const r = Math.floor(vodNav.focus / cols);
  const top = r * rowH, bottom = top + rowH;
  if (top < grid.scrollTop)
    grid.scrollTop = top;
  else if (bottom > grid.scrollTop + grid.clientHeight)
    grid.scrollTop = bottom - grid.clientHeight;
  vodNav.gridScroll = grid.scrollTop;
  renderVodGridRows();
  inner.querySelectorAll('.vod-card.focused')
      .forEach(c => c.classList.remove('focused'));
  if (vodNav.zone !== 'content') return;
  const card = inner.querySelector(`.vod-card[data-idx="${vodNav.focus}"]`);
  if (card) card.classList.add('focused');
}
function refreshVodFocus() {
  updateVodCatFocus(false);
  if (vodNav.screen === 'home')
    updateVodHomeFocus();
  else if (vodNav.screen === 'grid')
    updateVodGridFocus();
}

// ── details ──────────────────────────────────────────────────
async function getVodInfo(item) {
  if (vodInfoCache.has(item.id)) return vodInfoCache.get(item.id);
  const raw = await xtApi('get_vod_info', {vod_id: item.id});
  const i = (raw && raw.info) || {}, md = (raw && raw.movie_data) || {};
  const info = {
    plot: i.plot || i.description || '',
    cast: i.cast || i.actors || '',
    director: i.director || '',
    genre: i.genre || item.genre || '',
    releaseDate: i.releasedate || i.release_date || item.releaseDate || '',
    duration: parseDurationSecs(i),
    rating: parseFloat(i.rating) || item.rating || 0,
    backdrop: Array.isArray(i.backdrop_path) ? i.backdrop_path[0] :
                                               (i.backdrop_path || ''),
    image: i.movie_image || i.cover_big || item.icon,
    ext: md.container_extension || item.ext,
    added: (parseInt(md.added) || 0) * 1000 || item.added || 0
  };
  Object.assign(info, providerExtras(i));
  vodInfoCache.set(item.id, info);
  return info;
}
// Extra fields many Xtream panels return with get_vod_info / get_series_info
// (all optional)
function providerExtras(i) {
  const out = {};
  const age = i.age || i.mpaa || i.mpaa_rating || i.certification || '';
  if (age && age !== 'N/A') out.age = String(age);
  if (i.country) out.country = String(i.country);
  const tmdb = i.tmdb_id || i.tmdb || '';
  if (tmdb && tmdb !== '0') out.tmdb = String(tmdb);
  if (i.youtube_trailer) out.trailer = String(i.youtube_trailer);
  const ert = parseInt(i.episode_run_time);
  if (ert > 0) out.episodeRunTime = ert;
  const v = i.video && typeof i.video === 'object' ? i.video : null,
        a = i.audio && typeof i.audio === 'object' ? i.audio : null;
  const bits = [];
  if (v && v.width && v.height) bits.push(`${v.width}×${v.height}`);
  if (v && v.codec_name) bits.push(String(v.codec_name).toUpperCase());
  if (v && v.r_frame_rate) {
    const m = String(v.r_frame_rate).match(/^(\d+)\/(\d+)$/);
    const fps = m ? +m[1] / +m[2] : parseFloat(v.r_frame_rate);
    if (fps > 0) bits.push(`${Math.round(fps * 100) / 100} fps`);
  }
  if (a && a.codec_name)
    bits.push(
        String(a.codec_name).toUpperCase() +
        (a.channels ? ` ${
                          a.channels === 6     ? '5.1' :
                              a.channels === 8 ? '7.1' :
                                                 a.channels + 'ch'}` :
                      ''));
  const br = parseInt(i.bitrate) || (v && parseInt(v.bit_rate)) || 0;
  if (br > 0)
    bits.push(`${
        br >= 1e6 ? (br / 1e6).toFixed(1) + ' Mbps' :
                    Math.round(br / 1000) + ' kbps'}`);
  if (bits.length) out.fileTech = bits.join(' · ');
  return out;
}
async function getSeriesInfo(item) {
  if (seriesInfoCache.has(item.id)) return seriesInfoCache.get(item.id);
  const raw = await xtApi('get_series_info', {series_id: item.id});
  const i = (raw && raw.info) || {};
  const eps = (raw && raw.episodes) || {};
  const seasons = [];
  const keys =
      Array.isArray(eps) ? eps.map((_, k) => String(k)) : Object.keys(eps);
  for (const k of keys) {
    const list = Array.isArray(eps) ? eps[k] : eps[k];
    if (!Array.isArray(list) || !list.length) continue;
    const num = parseInt(k) || parseInt(list[0].season) || 0;
    const episodes =
        list.map(e => ({
                   id: String(e.id),
                   num: parseInt(e.episode_num) || 0,
                   title: e.title || '',
                   ext: e.container_extension || 'mp4',
                   duration: parseDurationSecs(e.info),
                   plot: (e.info && (e.info.plot || e.info.overview)) || '',
                   image: (e.info && e.info.movie_image) || '',
                   season: num
                 }))
            .sort((a, b) => a.num - b.num);
    seasons.push({num, episodes});
  }
  seasons.sort((a, b) => a.num - b.num);
  const info = {
    plot: i.plot || item.plot || '',
    cast: i.cast || item.cast || '',
    director: i.director || item.director || '',
    genre: i.genre || item.genre || '',
    releaseDate: i.releaseDate || i.release_date || item.releaseDate || '',
    rating: parseFloat(i.rating) || item.rating || 0,
    backdrop: Array.isArray(i.backdrop_path) ?
        i.backdrop_path[0] :
        (i.backdrop_path || item.backdrop || ''),
    image: i.cover || item.icon,
    seasons,
    episodeCount: seasons.reduce((n, s) => n + s.episodes.length, 0)
  };
  Object.assign(info, providerExtras(i));
  seriesInfoCache.set(item.id, info);
  return info;
}
async function openVodItem(item) {
  vodNav.screen = 'details';
  vodNav.detail = {item, info: null, loading: true, error: null};
  vodNav.detailZone = 'buttons';
  vodNav.detailBtn = 0;
  vodNav.season = 0;
  vodNav.epIdx = 0;
  renderVodDetails();
  try {
    const info = item.kind === 'movie' ? await getVodInfo(item) :
                                         await getSeriesInfo(item);
    if (!vodNav.detail || vodNav.detail.item !== item) return;
    vodNav.detail.info = info;
    vodNav.detail.loading = false;
    if (item.kind === 'series') {
      const last = lastEpisodeEntry(item.id);
      if (last) {
        const si = info.seasons.findIndex(s => s.num === last.season);
        if (si >= 0) {
          vodNav.season = si;
          const ei =
              info.seasons[si].episodes.findIndex(e => e.id === last.epId);
          if (ei >= 0) vodNav.epIdx = ei;
        }
      }
    }
    renderVodDetails();
  } catch (err) {
    if (!vodNav.detail || vodNav.detail.item !== item) return;
    vodNav.detail.loading = false;
    vodNav.detail.error = err.message;
    renderVodDetails();
  }
}
function closeVodDetails() {
  vodNav.detail = null;
  document.getElementById('vodDetails').style.display = 'none';
  vodNav.screen = vodNav.list === 'home' ? 'home' : 'grid';
  vodNav.zone = 'content';
  if (vodNav.screen === 'home')
    renderVodHome();
  else {
    if (vodNav.list === 'favs') {
      vodNav.baseItems = vodFavItems();
      vodNav.items = vodNav.query ?
          vodSearchItems(vodNav.baseItems, vodNav.query) :
          vodNav.baseItems;
    }
    renderVodGrid();
    updateVodGridFocus();
  }
}
// Which episode "Play" should start for a series: resume the last one if
// unfinished, else the episode after the last one watched, else the first
// unwatched, else S1 E1
function seriesPlayTarget(item, info) {
  const last = lastEpisodeEntry(item.id);
  if (last) {
    for (let si = 0; si < info.seasons.length; si++) {
      const ei = info.seasons[si].episodes.findIndex(e => e.id === last.epId);
      if (ei < 0) continue;
      if (!last.watched) return {si, ei, resume: true};
      if (ei + 1 < info.seasons[si].episodes.length)
        return {si, ei: ei + 1, resume: false};
      for (let sj = si + 1; sj < info.seasons.length; sj++)
        if (info.seasons[sj].episodes.length)
          return {si: sj, ei: 0, resume: false};
      break;  // finished the last episode: fall through to first unwatched
    }
  }
  for (let si = 0; si < info.seasons.length; si++)
    for (let ei = 0; ei < info.seasons[si].episodes.length; ei++) {
      const p = episodeProgress(item.id, info.seasons[si].episodes[ei].id);
      if (!p || !p.watched) return {si, ei, resume: false};
    }
  return info.seasons.length ? {si: 0, ei: 0, resume: false} : null;
}
function vodDetailButtons() {
  const d = vodNav.detail;
  if (!d) return [];
  const {item, info} = d;
  const btns = [];
  if (item.kind === 'movie') {
    const p = movieProgress(item);
    btns.push({
      id: 'play',
      label: p ? `▶ Resume from ${fmtClock(p.pos)}` : '▶ Play',
      primary: true,
      disabled: d.loading && !info,
      act: () => startVodPlayback({kind: 'movie', item, info})
    });
    if (p)
      btns.push({
        id: 'restart',
        label: '↺ Start over',
        act: () => startVodPlayback({kind: 'movie', item, info, restart: true})
      });
  } else if (info && info.seasons.length) {
    const t = seriesPlayTarget(item, info);
    const ep = t ? info.seasons[t.si].episodes[t.ei] : null;
    btns.push({
      id: 'play',
      label: ep ? `▶ ${t.resume ? 'Resume' : 'Play'} S${ep.season} E${ep.num}` :
                  '▶ Play',
      primary: true,
      disabled: !ep,
      act: () => {
        if (ep)
          startVodPlayback({
            kind: 'episode',
            item,
            ep,
            season: ep.season,
            epIdx: t.ei,
            seasons: info.seasons
          });
      }
    });
  } else {
    btns.push({
      id: 'play',
      label: '▶ Play',
      primary: true,
      disabled: true,
      act: () => {}
    });
  }
  btns.push({
    id: 'fav',
    label: isVodFav(item) ? '★ Favorite' : '☆ Favorite',
    act: () => {
      toggleVodFav(item);
      renderVodDetails();
    }
  });
  const hasProgress = item.kind === 'movie' ? !!movieProgress(item) :
                                              !!lastEpisodeEntry(item.id);
  if (hasProgress)
    btns.push({
      id: 'remove',
      label: '✕ Remove from Continue Watching',
      act: () => {
        removeVodProgress(item);
        if (vodNav.detailBtn >= vodDetailButtons().length) vodNav.detailBtn = 0;
        renderVodDetails();
        showEPGToast(
            `${item.name} removed from Continue Watching`, 'success',
            'Continue Watching');
        hideEPGToast(2500);
      }
    });
  if (item.kind === 'movie') {
    const w = isMovieWatched(item);
    btns.push({
      id: 'watched',
      label: w ? '✓ Watched · mark unwatched' : '✓ Mark as watched',
      act: () => {
        setMovieWatched(item, info, !w);
        if (vodNav.detailBtn >= vodDetailButtons().length) vodNav.detailBtn = 0;
        renderVodDetails();
        showEPGToast(
            `${item.name} marked as ${w ? 'unwatched' : 'watched'}`, 'success',
            'Watched');
        hideEPGToast(2000);
      }
    });
  } else if (info && info.seasons.length) {
    // Season / series watched state: the button flips to "unwatched" once
    // everything is already watched
    const season =
        info.seasons[Math.min(vodNav.season, info.seasons.length - 1)];
    const seasonDone =
        season && season.episodes.length && season.episodes.every(ep => {
          const p = episodeProgress(item.id, ep.id);
          return p && p.watched;
        });
    btns.push({
      id: 'season',
      label: seasonDone ? `↺ Season ${season.num}: mark unwatched` :
                          `✓ Mark season ${season ? season.num : ''} watched`,
      act: () => {
        setSeasonWatched(item, season, info.seasons, !seasonDone);
        renderVodDetails();
        showEPGToast(
            `Season ${season.num} marked as ${
                seasonDone ? 'unwatched' : 'watched'}`,
            'success', 'Watched');
        hideEPGToast(2000);
      }
    });
    const allDone = info.seasons.every(s => s.episodes.every(ep => {
      const p = episodeProgress(item.id, ep.id);
      return p && p.watched;
    }));
    btns.push({
      id: 'all',
      label: allDone ? '↺ Mark all unwatched' : '✓ Mark all watched',
      act: () => {
        showConfirmDialog(
            allDone ? '↺ Mark all unwatched' : '✓ Mark all watched',
            `${allDone ? 'Clear the watched state of' : 'Mark'} all ${
                info.episodeCount} episodes of ${item.name}${
                allDone ? '' : ' as watched'}?`,
            () => {
              for (const s of info.seasons)
                setSeasonWatched(item, s, info.seasons, !allDone);
              if (vodNav.detailBtn >= vodDetailButtons().length)
                vodNav.detailBtn = 0;
              renderVodDetails();
              showEPGToast(
                  `${item.name}: all episodes marked ${
                      allDone ? 'unwatched' : 'watched'}`,
                  'success', 'Watched');
              hideEPGToast(2000);
            });
      }
    });
  }
  return btns;
}
function renderVodDetails() {
  const d = vodNav.detail;
  const box = document.getElementById('vodDetails');
  if (!d) {
    box.style.display = 'none';
    return;
  }
  const {item, info} = d;
  box.style.display = '';
  const backdrop = (info && info.backdrop) || item.backdrop || '';
  const poster = (info && info.image) || item.icon || '';
  const metaBits = [];
  if (item.kind === 'movie') {
    if (info) {
      const y = yearOf(info.releaseDate);
      if (y) metaBits.push(y);
      if (info.duration) metaBits.push(fmtRuntime(info.duration));
      if (info.rating) metaBits.push(`★ ${info.rating.toFixed(1)}`);
      if (info.genre) metaBits.push(info.genre);
    } else if (item.rating)
      metaBits.push(`★ ${item.rating.toFixed(1)}`);
  } else {
    const y = yearOf((info && info.releaseDate) || item.releaseDate);
    if (y) metaBits.push(y);
    if (info)
      metaBits.push(`${info.seasons.length} season${
          info.seasons.length === 1 ? '' : 's'} · ${info.episodeCount} episode${
          info.episodeCount === 1 ? '' : 's'}`);
    const rt = (info && info.rating) || item.rating;
    if (rt) metaBits.push(`★ ${rt.toFixed(1)}`);
    const g = (info && info.genre) || item.genre;
    if (g) metaBits.push(g);
  }
  if (info) {
    if (info.age) metaBits.push(info.age);
    if (info.country) metaBits.push(info.country);
    if (item.kind === 'series' && info.episodeRunTime)
      metaBits.push(`${info.episodeRunTime} min/ep`);
  }
  const techKey = item.kind === 'movie' ?
      progressKeyFor('movie', item.id) :
      (lastEpisodeEntry(item.id) ?
           progressKeyFor('episode', lastEpisodeEntry(item.id).epId, item.id) :
           null);
  const tech = (techKey && vodTech[techKey]) || (info && info.fileTech) ||
      '';  // what the TV decoded beats what the provider claims
  if (tech) metaBits.push(tech);
  const extraBits = [];
  if (info && info.releaseDate && /^\d{4}-\d{2}-\d{2}/.test(info.releaseDate))
    extraBits.push(`Released ${info.releaseDate.slice(0, 10)}`);
  if (item.kind === 'movie' && info && info.added)
    extraBits.push(`Added ${new Date(info.added).toLocaleDateString()}`);
  if (info && info.tmdb) extraBits.push(`TMDB ${info.tmdb}`);
  const plot =
      (info && info.plot) || item.plot || (d.loading ? 'Loading …' : '');
  const people = info ?
      [
        info.director ? `Director: ${info.director}` : '',
        info.cast ? `Cast: ${info.cast}` : ''
      ].filter(Boolean)
          .join(' · ') :
      '';
  const btns = vodDetailButtons();
  let html =
      `<div class="vod-backdrop"${
          backdrop ? ` style="background-image:url('${
                         escapeHtml(backdrop).replace(/'/g, '%27')}')"` :
                     ''}></div>` +
      `<div class="vod-dwrap${item.kind === 'series' ? ' series' : ''}">` +
      `<div class="vod-dposter"><span class="vod-poster-name">${
          escapeHtml(item.name)}</span>${
          poster ? `<img src="${
                       escapeHtml(poster)}" alt="" onerror="this.remove()">` :
                   ''}</div>` +
      `<div class="vod-dinfo">` +
      `<div class="vod-dtitle">${escapeHtml(item.name)}</div>` +
      `<div class="vod-dmeta">${
          metaBits.map(escapeHtml).join(' <i>·</i> ')}</div>` +
      `<div class="vod-dplot">${escapeHtml(plot)}</div>` +
      (people ? `<div class="vod-dcast">${escapeHtml(people)}</div>` : '') +
      (extraBits.length ?
           `<div class="vod-dcast vod-dextra">${
               extraBits.map(escapeHtml).join(' <i>·</i> ')}</div>` :
           '') +
      (d.error ? `<div class="vod-derror">⚠️ ${escapeHtml(d.error)}</div>` :
                 '') +
      `<div class="vod-dbtns">${
          btns.map(
                  (b, i) => `<button class="vod-btn${b.primary ? ' pri' : ''}${
                      b.disabled ? ' disabled' : ''}${
                      vodNav.detailZone === 'buttons' &&
                              i === vodNav.detailBtn ?
                          ' focused' :
                          ''}" data-i="${i}">${escapeHtml(b.label)}</button>`)
              .join('')}</div>`;
  if (item.kind === 'series' && info && info.seasons.length) {
    if (vodNav.season >= info.seasons.length) vodNav.season = 0;
    const season = info.seasons[vodNav.season];
    if (vodNav.epIdx >= season.episodes.length) vodNav.epIdx = 0;
    html += `<div class="vod-seasons">${
        info.seasons
            .map(
                (s, i) => `<button class="vod-season${
                    i === vodNav.season ? ' on' : ''}${
                    vodNav.detailZone === 'seasons' && i === vodNav.season ?
                        ' focused' :
                        ''}" data-i="${i}">Season ${s.num}</button>`)
            .join('')}</div>`;
    html += `<div class="vod-eps">` +
        season.episodes
            .map((ep, i) => {
              const p = episodeProgress(item.id, ep.id);
              const watched = !!(p && p.watched);
              const pct =
                  p && p.dur && (watched || p.pos >= vodMinResume(p.dur)) ?
                  Math.min(100, Math.round(p.pos / p.dur * 100)) :
                  0;
              const thumb = ep.image || poster;
              return `<div class="vod-ep${
                         vodNav.detailZone === 'episodes' &&
                                 i === vodNav.epIdx ?
                             ' focused' :
                             ''}${watched ? ' watched' : ''}" data-i="${i}">` +
                  `<div class="vod-thumb">${
                         thumb ?
                             `<img loading="lazy" src="${
                                 escapeHtml(
                                     thumb)}" alt="" onerror="this.remove()">` :
                             ''}${
                         pct ? `<div class="vod-prog"><i style="width:${
                                   watched ? 100 : pct}%"></i></div>` :
                               ''}</div>` +
                  `<div class="vod-epi"><div class="vod-ept">${
                         watched ? '<span class="vod-chk">✓</span>' :
                                   ''}E${ep.num}${
                         ep.title ? ' · ' + escapeHtml(ep.title) : ''}</div>` +
                  `<div class="vod-epp">${escapeHtml(ep.plot || '')}${
                         p && !watched && pct ?
                             `${ep.plot ? ' ' : ''}Resume from ${
                                 fmtClock(p.pos)}.` :
                             ''}</div></div>` +
                  `<div class="vod-epd">${
                         ep.duration ? fmtRuntime(ep.duration) :
                                       ''}</div></div>`;
            })
            .join('') +
        `</div>`;
  } else if (item.kind === 'series' && info && !info.seasons.length) {
    html += `<div class="vod-dcast">No episodes listed for this series.</div>`;
  }
  html += `<div class="vod-dhint">◀ ▶ move · OK select${
      item.kind === 'series' && info && info.seasons.length ?
          ' · Red mark episode watched' :
          ''} · Back to ${
      vodNav.list === 'home' ? 'Home' : 'list'}</div></div></div>`;
  box.innerHTML = html;
  box.querySelectorAll('.vod-btn')
      .forEach(b => b.addEventListener('click', () => {
        vodNav.detailZone = 'buttons';
        vodNav.detailBtn = +b.dataset.i;
        const btn = vodDetailButtons()[vodNav.detailBtn];
        if (btn && !btn.disabled) btn.act();
      }));
  box.querySelectorAll('.vod-season')
      .forEach(b => b.addEventListener('click', () => {
        vodNav.detailZone = 'seasons';
        vodNav.season = +b.dataset.i;
        vodNav.epIdx = 0;
        renderVodDetails();
      }));
  box.querySelectorAll('.vod-ep').forEach(
      b => b.addEventListener('click', () => {
        vodNav.detailZone = 'episodes';
        vodNav.epIdx = +b.dataset.i;
        playFocusedEpisode();
      }));
  const f = box.querySelector('.vod-ep.focused');
  if (f) f.scrollIntoView({block: 'nearest'});
}
function playFocusedEpisode() {
  const d = vodNav.detail;
  if (!d || !d.info || !d.info.seasons.length) return;
  const season = d.info.seasons[vodNav.season];
  const ep = season.episodes[vodNav.epIdx];
  if (!ep) return;
  const p = episodeProgress(d.item.id, ep.id);
  startVodPlayback({
    kind: 'episode',
    item: d.item,
    ep,
    season: ep.season,
    epIdx: vodNav.epIdx,
    seasons: d.info.seasons,
    restart: !!(p && p.watched)
  });
}
function handleVodDetailsKey(e, up, down, left, right, enter) {
  const d = vodNav.detail;
  if (!d) return;
  const btns = vodDetailButtons();
  const hasSeasons =
      d.item.kind === 'series' && d.info && d.info.seasons.length > 1;
  const hasEps =
      d.item.kind === 'series' && d.info && d.info.seasons.length > 0;
  const z = vodNav.detailZone;
  const red = e.keyCode === 403 || e.key === 'ColorF0Red';
  if (red && z === 'episodes' && hasEps) {
    // Red on an episode row toggles its watched state
    e.preventDefault();
    const ep = d.info.seasons[vodNav.season].episodes[vodNav.epIdx];
    if (ep) {
      const p = episodeProgress(d.item.id, ep.id);
      const on = !(p && p.watched);
      setEpisodeWatched(d.item, ep, d.info.seasons, on);
      renderVodDetails();
      showEPGToast(
          `S${ep.season} E${ep.num} marked as ${on ? 'watched' : 'unwatched'}`,
          'success', 'Watched');
      hideEPGToast(2000);
    }
    return;
  }
  if (!(up || down || left || right || enter)) return;
  e.preventDefault();
  if (z === 'buttons') {
    if (left)
      vodNav.detailBtn = Math.max(0, vodNav.detailBtn - 1);
    else if (right)
      vodNav.detailBtn = Math.min(btns.length - 1, vodNav.detailBtn + 1);
    else if (down) {
      if (hasSeasons)
        vodNav.detailZone = 'seasons';
      else if (hasEps)
        vodNav.detailZone = 'episodes';
    } else if (enter) {
      const b = btns[vodNav.detailBtn];
      if (b && !b.disabled) {
        b.act();
        return;
      }
    }
  } else if (z === 'seasons') {
    if (left) {
      if (vodNav.season > 0) {
        vodNav.season--;
        vodNav.epIdx = 0;
      }
    } else if (right) {
      if (vodNav.season < d.info.seasons.length - 1) {
        vodNav.season++;
        vodNav.epIdx = 0;
      }
    } else if (up)
      vodNav.detailZone = 'buttons';
    else if (down || enter)
      vodNav.detailZone = 'episodes';
  } else if (z === 'episodes') {
    const n = d.info.seasons[vodNav.season].episodes.length;
    if (up) {
      if (vodNav.epIdx > 0)
        vodNav.epIdx--;
      else
        vodNav.detailZone = hasSeasons ? 'seasons' : 'buttons';
    } else if (down)
      vodNav.epIdx = Math.min(n - 1, vodNav.epIdx + 1);
    else if (enter) {
      playFocusedEpisode();
      return;
    } else if (left || right) {
      if (hasSeasons) {
        vodNav.detailZone = 'seasons';
      }
    }
  }
  renderVodDetails();
}

// ── browse keys ──────────────────────────────────────────────
function handleVodBrowseKey(e, up, down, left, right, enter) {
  if (vodNav.screen === 'details')
    return handleVodDetailsKey(e, up, down, left, right, enter);
  const red = e.keyCode === 403 || e.key === 'ColorF0Red';
  if (!(up || down || left || right || enter || red)) return;
  e.preventDefault();
  if (vodNav.zone === 'cats') {
    const els = _groupItemEls();
    if (vodNav.catIdx === undefined || vodNav.catIdx >= els.length)
      vodNav.catIdx = vodActiveCatIdx();
    if (up)
      vodNav.catIdx = Math.max(0, vodNav.catIdx - 1);
    else if (down)
      vodNav.catIdx = Math.min(els.length - 1, vodNav.catIdx + 1);
    else if (right) {
      vodNav.zone = 'content';
      refreshVodFocus();
      return;
    } else if (enter) {
      if (els[vodNav.catIdx]) {
        const t = els[vodNav.catIdx];
        openVodList(t.dataset.list, t.dataset.catId);
      }
      return;
    }
    updateVodCatFocus(true);
    return;
  }
  if (vodNav.screen === 'home') {
    const rows = vodHomeFocusRows();
    if (!rows.length) {
      if (left) {
        vodNav.zone = 'cats';
        vodNav.catIdx = vodActiveCatIdx();
        refreshVodFocus();
        updateVodCatFocus(true);
      } else if (up)
        focusVodSearch();
      return;
    }
    const r = rows[vodNav.homeRow];
    const col = vodNav.homeCol[r.key] || 0;
    if ((e.keyCode === 403 || e.key === 'ColorF0Red') && r.key === 'cw') {
      const it = r.items[col];
      if (it) {
        removeVodProgress(it);
        showEPGToast(
            `${it.name} removed from Continue Watching`, 'success',
            'Continue Watching');
        hideEPGToast(2500);
        renderVodHome();
      }
      return;
    }
    if (up) {
      if (vodNav.homeRow === 0) {
        focusVodSearch();
        return;
      }
      vodNav.homeRow--;
    } else if (down)
      vodNav.homeRow = Math.min(rows.length - 1, vodNav.homeRow + 1);
    else if (left) {
      if (col === 0) {
        vodNav.zone = 'cats';
        vodNav.catIdx = vodActiveCatIdx();
        refreshVodFocus();
        updateVodCatFocus(true);
        return;
      }
      vodNav.homeCol[r.key] = col - 1;
    } else if (right)
      vodNav.homeCol[r.key] = Math.min(r.items.length - 1, col + 1);
    else if (enter) {
      openVodItem(r.items[col]);
      return;
    }
    updateVodHomeFocus();
    return;
  }
  // grid
  const n = vodNav.items.length, cols = vodGrid.cols;
  if (!n) {
    if (left) {
      vodNav.zone = 'cats';
      vodNav.catIdx = vodActiveCatIdx();
      refreshVodFocus();
      updateVodCatFocus(true);
    } else if (up)
      focusVodSearch();
    return;
  }
  if (up) {
    if (vodNav.focus < cols) {
      focusVodSearch();
      return;
    }
    vodNav.focus -= cols;
  } else if (down) {
    if (vodNav.focus + cols < n)
      vodNav.focus += cols;
    else if (Math.floor(vodNav.focus / cols) < Math.floor((n - 1) / cols))
      vodNav.focus = n - 1;
  } else if (left) {
    if (vodNav.focus % cols === 0) {
      vodNav.zone = 'cats';
      vodNav.catIdx = vodActiveCatIdx();
      refreshVodFocus();
      updateVodCatFocus(true);
      return;
    }
    vodNav.focus--;
  } else if (right) {
    if (vodNav.focus % cols !== cols - 1 && vodNav.focus + 1 < n)
      vodNav.focus++;
  } else if (enter) {
    openVodItem(vodNav.items[vodNav.focus]);
    return;
  }
  updateVodGridFocus();
}
