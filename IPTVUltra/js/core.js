/**
 * @fileoverview App state, settings constants, diagnostics, stored settings,
 * and the EPG timezone.
 */

// ---------- App State ----------
let channels = [];
let currentChannelIndex = -1;
let lastChannelIndex = -1;
let favoriteIds = new Set();
let currentGroup = 'favorites';
let savedPlaylists = [];
let selectedPlaylistId = null;
let groupsList = [];
let groupsColumnVisible = true;
let isLoading = false;
let currentSearchQuery = '';

let activeTab = 'xtream';  // 'xtream' | 'm3u'
let epgMode = false;
let currentPlaylistType = null;  // 'xtream' | 'm3u'

// EPG state
let epgData = new Map();  // channelId -> [{start, stop, title, desc}]
let epgIdMap =
    new Map();  // lowercase string -> actual channelId key in epgData
let epgLoading = false;
let currentEpgUrl = '';
let epgRefreshTimer = null;
let _epgAbortController = null;
let _m3uAbortController = null;
let epgFocusedRowIdx =
    0;  // remote-cursor row in EPG guide (independent of playing channel)

let channelIndexMap = new Map();  // channel object → its index in channels[]
let _searchCache = {
  query: null,
  result: null
};  // invalidated on every channels reload
let _searchDebounceTimer = null;

// EPG virtual scroll state
// Text scale. All type is in rem, so one root font-size drives it (style.css
// :root). Row/strip heights must agree between CSS and the virtual-scroll
// math, so JS computes rounded px values and publishes them as CSS variables.
// Baked in for now; a future settings screen can change TEXT_SCALE and call
// applyTextScale() followed by refreshCurrentView().
let TEXT_SCALE = 1.375;
let EPG_ROW_INNER, EPG_ROW_H, EPG_TIME_STRIP_H, CH_ITEM_H, CH_ITEM_H_EPG;
function applyTextScale(scale) {
  TEXT_SCALE = scale;
  EPG_ROW_INNER = Math.round(62 * scale);
  EPG_ROW_H = EPG_ROW_INNER + 1;  // + 1px border-bottom
  EPG_TIME_STRIP_H = Math.round(34 * scale);
  CH_ITEM_H = Math.round(52 * scale);      // channel list row (no EPG line)
  CH_ITEM_H_EPG = Math.round(68 * scale);  // channel list row with EPG line
  const st = document.documentElement.style;
  st.setProperty('--text-scale', String(scale));
  st.setProperty('--epg-row-h', EPG_ROW_INNER + 'px');
  st.setProperty('--epg-strip-h', EPG_TIME_STRIP_H + 'px');
}

// Settings (persisted in localStorage) — UI and helpers under "// -----
// Settings -----"
const SETTINGS_KEY = 'iptv_settings';
const PLAYLIST_STATE_KEY = 'iptv_playlist_state';
const LAST_PLAYLIST_KEY = 'iptv_last_playlist';
const TEXT_SCALE_OPTIONS = [1, 1.125, 1.25, 1.375, 1.5];
const AV_SYNC_MIN = 0,
      AV_SYNC_MAX =
          60;  // LG "AV Sync Adjustment" range (settingsservice avSync* keys,
               // verified on the C4); -1 = leave the TV setting alone
const DEFAULT_SETTINGS = {
  textScale: 1.375,
  clock: '12',
  autoLoad: false,
  showAdult: false,
  subLang: 'en',
  audioLang: 'default',
  subSize: 'medium',
  subColor: 'white',
  subOpacity: 85,
  subBg: 'translucent',
  subEdge: 'outline',
  subAuto: false,
  liveBuffer: 5,
  autoNext: true,
  ppvEvents: 'hide',
  schema: 4
};
// Subtitle text opacity (%), sent as charOpacity; the C4 honours it (verified
// with the old Grey = white at 85)
const SUB_OPACITY_OPTIONS = [
  {v: 100, label: '100%'}, {v: 85, label: '85%'}, {v: 70, label: '70%'},
  {v: 55, label: '55%'}
];
// Live rewind buffer (minutes) for HLS channels played through hls.js; 0 =
// native player only
const LIVE_BUFFER_OPTIONS = [
  {v: 0, label: 'Off'}, {v: 2, label: '2 minutes'}, {v: 5, label: '5 minutes'},
  {v: 10, label: '10 minutes'}
];
// Groups of event channels (PPV) whose names carry the event time: sort by
// start time, optionally hide finished ones
const PPV_EVENT_OPTIONS = [
  {v: 'hide', label: 'Sort, hide finished'},
  {v: 'sort', label: 'Sort by start time'}, {v: 'off', label: 'As listed'}
];
const SUB_SIZE_OPTIONS = [
  {v: 'small', label: 'Small'}, {v: 'medium', label: 'Medium'},
  {v: 'large', label: 'Large'}, {v: 'extraLarge', label: 'Extra large'}
];
// ----- Diagnostics (error ring buffer, startup marks; Settings → Diagnostics)
// ----- Registered this early so errors thrown while the rest of the script
// loads are caught too The log survives a restart (localStorage, saved 2 s
// after the last entry and on pagehide), so an error that ended in an app
// restart can still be read; entries from earlier runs are flagged `prev`.
const DIAG_MAX = 50;
const DIAG_STORE_KEY = 'iptv_diag_log';
const _diagLog = (() => {
  try {
    const a = JSON.parse(localStorage.getItem(DIAG_STORE_KEY) || '[]');
    return Array.isArray(a) ?
        a.slice(-DIAG_MAX).map(
            e => ({t: +e.t || 0, msg: String(e.msg || ''), prev: true})) :
        [];
  } catch (_) {
    return [];
  }
})();
let _diagSaveTimer = 0;
function diagSave() {
  if (_diagSaveTimer) {
    clearTimeout(_diagSaveTimer);
    _diagSaveTimer = 0;
  }
  try {
    localStorage.setItem(
        DIAG_STORE_KEY,
        JSON.stringify(_diagLog.map(e => ({t: e.t, msg: e.msg}))));
  } catch (_) { /* storage full or unavailable */
  }
}
function diagLog(msg) {
  _diagLog.push({t: Date.now(), msg: String(msg).slice(0, 300)});
  if (_diagLog.length > DIAG_MAX) _diagLog.shift();
  if (!_diagSaveTimer) _diagSaveTimer = setTimeout(diagSave, 2000);
}
window.addEventListener('pagehide', () => {
  if (_diagSaveTimer) diagSave();
});
// The most recent stream failure, with whatever the server answered, for
// Diagnostics
let _lastStreamFail = null;  // { t, name, engine, what, reply }
function noteStreamFail(engine, what, reply) {
  const ch = currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
  _lastStreamFail = {
    t: Date.now(),
    name: ch ? ch.name : '',
    engine,
    what,
    reply: reply || ''
  };
}
window.addEventListener(
    'error',
    e => diagLog(`Error: ${e.message}${
        e.filename ? ` (${String(e.filename).split('/').pop()}:${e.lineno})` :
                     ''}`));
window.addEventListener(
    'unhandledrejection',
    e => diagLog(`Unhandled rejection: ${
        e.reason && e.reason.message ? e.reason.message : String(e.reason)}`));
const _consoleError = console.error.bind(console);
console.error = function() {
  try {
    diagLog(
        'console.error: ' +
        Array.from(arguments)
            .map(a => (a && a.message) || String(a))
            .join(' '));
  } catch (_) { /* ignore */
  }
  _consoleError.apply(console, arguments);
};
const _perfMarks = [];
function perfMark(label) {
  _perfMarks.push({label, t: Math.round(performance.now())});
}
perfMark('script-start');
// No Grey: the TV's caption pipeline has no grey colour (a 'gray' request
// renders as white); dimmer text is Subtitle opacity
const SUB_COLOR_OPTIONS = [
  {v: 'white', label: 'White'}, {v: 'yellow', label: 'Yellow'},
  {v: 'cyan', label: 'Cyan'}, {v: 'green', label: 'Green'}
];
const SUB_BG_OPTIONS = [
  {v: 'none', label: 'None'}, {v: 'translucent', label: 'Translucent'},
  {v: 'solid', label: 'Solid black'}
];
// Edge types the TV's subtitle renderer (libstarfish-subtitle-task)
// understands: none, uniform, raised, left_/right_drop_shadow
const SUB_EDGE_OPTIONS = [
  {v: 'none', label: 'None'}, {v: 'outline', label: 'Outline'},
  {v: 'shadow', label: 'Shadow'}, {v: 'raised', label: 'Raised'}
];
const SUB_EDGE_UMS = {
  none: 'none',
  outline: 'uniform',
  shadow: 'right_drop_shadow',
  raised: 'raised'
};
const SUB_LANG_OPTIONS = [
  {v: 'en', label: 'English'}, {v: 'es', label: 'Spanish'},
  {v: 'fr', label: 'French'}, {v: 'de', label: 'German'},
  {v: 'pt', label: 'Portuguese'}, {v: 'it', label: 'Italian'},
  {v: 'ar', label: 'Arabic'}, {v: 'any', label: 'First available'}
];
const AUDIO_LANG_OPTIONS = [
  {v: 'default', label: 'Default'}, {v: 'en', label: 'English'},
  {v: 'es', label: 'Spanish'}, {v: 'fr', label: 'French'},
  {v: 'de', label: 'German'}, {v: 'pt', label: 'Portuguese'},
  {v: 'it', label: 'Italian'}, {v: 'ar', label: 'Arabic'}
];
// ----- Stored settings and JSON (localStorage) -----
// Declared here, before the globals that they initialize at load time.
function loadJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v === null || v === undefined ? fallback : v;
  } catch (_) {
    return fallback;
  }
}
function saveJson(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch (_) { /* storage unavailable */
  }
}
function loadSettings() {
  let st = {};
  try {
    st = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
  } catch (_) {
    st = {};
  }
  const out = Object.assign({}, DEFAULT_SETTINGS, st);
  if (TEXT_SCALE_OPTIONS.indexOf(out.textScale) === -1)
    out.textScale = DEFAULT_SETTINGS.textScale;
  if (out.clock !== '12' && out.clock !== '24')
    out.clock = DEFAULT_SETTINGS.clock;
  out.autoLoad = !!out.autoLoad;
  out.showAdult = !!out.showAdult;
  if (!SUB_LANG_OPTIONS.some(o => o.v === out.subLang))
    out.subLang = DEFAULT_SETTINGS.subLang;
  if (!AUDIO_LANG_OPTIONS.some(o => o.v === out.audioLang))
    out.audioLang = DEFAULT_SETTINGS.audioLang;
  for (const [k, opts] of [
           ['subSize', SUB_SIZE_OPTIONS], ['subColor', SUB_COLOR_OPTIONS],
           ['subBg', SUB_BG_OPTIONS], ['subEdge', SUB_EDGE_OPTIONS]])
    if (!opts.some(o => o.v === out[k])) out[k] = DEFAULT_SETTINGS[k];
  if (!(st.schema >= 3)) {
    out.subAuto = false;
    out.schema = 3;
  }  // v3.8.0: subtitles no longer turn on by themselves unless asked
  // v3.9.0: Grey (white at 85 % opacity) became the separate Subtitle opacity
  // setting
  if (!(st.schema >= 4)) {
    if (st.subColor === 'gray' || st.subColor === undefined) {
      out.subColor = 'white';
      out.subOpacity = 85;
    } else
      out.subOpacity = 100;
    out.schema = 4;
  }
  if (out.subColor === 'gray') out.subColor = 'white';
  if (!SUB_OPACITY_OPTIONS.some(o => o.v === out.subOpacity))
    out.subOpacity = DEFAULT_SETTINGS.subOpacity;
  if (!PPV_EVENT_OPTIONS.some(o => o.v === out.ppvEvents))
    out.ppvEvents = DEFAULT_SETTINGS.ppvEvents;
  out.subAuto = !!out.subAuto;
  if (out.subLang === 'off') out.subLang = 'en';
  if (!LIVE_BUFFER_OPTIONS.some(o => o.v === out.liveBuffer))
    out.liveBuffer = DEFAULT_SETTINGS.liveBuffer;
  out.autoNext = st.autoNext === undefined ? true : !!st.autoNext;
  out.avSync = Number.isInteger(st.avSync) && st.avSync >= AV_SYNC_MIN &&
          st.avSync <= AV_SYNC_MAX ?
      st.avSync :
      -1;
  return out;
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) { /* storage unavailable */
  }
}
function loadPlaylistState() {
  try {
    return JSON.parse(localStorage.getItem(PLAYLIST_STATE_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}
function savePlaylistState() {
  try {
    localStorage.setItem(PLAYLIST_STATE_KEY, JSON.stringify(playlistState));
  } catch (_) { /* storage unavailable */
  }
}

let settings = loadSettings();            // global: textScale, clock, autoLoad
let playlistState = loadPlaylistState();  // per playlist key: startGroup,
                                          // resume, lastChannel, lastGroup
let _activePlaylistKey =
    null;  // key of the playlist currently loaded ('m:demo' for the demo)
let settingsOpen = false;
let settingsFocusIdx = 0;
let _settingsRowsCache = null;

// ----- EPG timezone (per playlist) -----
// Some providers write their guide in a local wall-clock but label it UTC
// (Xtream start_timestamp, XMLTV "+0000"). The user names that zone in
// Settings; every programme time is corrected as it enters epgData (XMLTV
// parser, Xtream short/full EPG, cache restore): true UTC = listed time − the
// zone's UTC offset at that instant (so DST is right per programme date; the
// Daylight saving row can pin standard or daylight time instead), plus an extra
// ±3 h nudge. The IndexedDB EPG cache keeps provider time (so the setting can
// change later) and catch-up URLs convert back (the archive is indexed by the
// provider's own clock).
let _epgTz = '', _epgDst = 'auto', _epgExtraMs = 0, _epgShiftOn = false;
const EPG_TZ_ZONES = [
  ['Pacific/Honolulu', 'Hawaii (Honolulu)'],
  ['America/Anchorage', 'Alaska (Anchorage)'],
  ['America/Los_Angeles', 'Pacific (Los Angeles)'],
  ['America/Denver', 'Mountain (Denver)'],
  ['America/Phoenix', 'Arizona (Phoenix)'],
  ['America/Chicago', 'Central (Chicago)'],
  ['America/Mexico_City', 'Mexico City'],
  ['America/New_York', 'Eastern (New York)'],
  ['America/Bogota', 'Bogotá / Lima'],
  ['America/Halifax', 'Atlantic (Halifax)'],
  ['America/Caracas', 'Caracas'],
  ['America/St_Johns', 'Newfoundland (St. John\'s)'],
  ['America/Sao_Paulo', 'São Paulo'],
  ['America/Argentina/Buenos_Aires', 'Buenos Aires'],
  ['Atlantic/Azores', 'Azores'],
  ['Europe/London', 'London / Dublin / Lisbon'],
  ['Africa/Lagos', 'West Africa (Lagos)'],
  ['Europe/Paris', 'Central Europe (Paris, Berlin, Amsterdam)'],
  ['Europe/Athens', 'Eastern Europe (Athens, Helsinki, Kyiv)'],
  ['Africa/Cairo', 'Cairo'],
  ['Africa/Johannesburg', 'South Africa (Johannesburg)'],
  ['Europe/Istanbul', 'Istanbul'],
  ['Europe/Moscow', 'Moscow'],
  ['Asia/Riyadh', 'Riyadh / Baghdad'],
  ['Asia/Tehran', 'Tehran'],
  ['Asia/Dubai', 'Dubai'],
  ['Asia/Kabul', 'Kabul'],
  ['Asia/Karachi', 'Karachi'],
  ['Asia/Kolkata', 'India (Kolkata, Mumbai)'],
  ['Asia/Kathmandu', 'Kathmandu'],
  ['Asia/Dhaka', 'Dhaka'],
  ['Asia/Bangkok', 'Bangkok / Jakarta'],
  ['Asia/Shanghai', 'China (Shanghai, Beijing)'],
  ['Asia/Singapore', 'Singapore / Manila / Perth'],
  ['Asia/Tokyo', 'Japan / Korea (Tokyo, Seoul)'],
  ['Australia/Adelaide', 'Adelaide'],
  ['Australia/Brisbane', 'Brisbane'],
  ['Australia/Sydney', 'Sydney / Melbourne'],
  ['Pacific/Auckland', 'New Zealand (Auckland)'],
];
const EPG_DST_OPTIONS = [
  {v: 'auto', label: 'Automatic'}, {v: 'std', label: 'Always standard time'},
  {v: 'dst', label: 'Always daylight time'}
];
const EPG_EXTRA_OPTIONS = (() => {  // ±3 h in half hours
  const out = [];
  for (let m = -180; m <= 180; m += 30)
    out.push({
      v: m,
      label: m === 0 ?
          'None' :
          `${m < 0 ? '\u2212' : '+'}${Math.floor(Math.abs(m) / 60)} h${
              Math.abs(m) % 60 ? ' 30 min' : ''}`
    });
  return out;
})();
const _tzFmtCache = new Map();  // zone -> Intl.DateTimeFormat
let _tzOffCache =
    new Map();  // "zone|hourBucket" -> minutes (DST changes on hour boundaries;
                // a few buckets cover a whole guide)
const _tzStdCache = new Map();  // "zone|year" -> { std, dst } minutes
function tzOffsetMin(zone, t) {
  const k = zone + '|' + Math.floor(t / 3600000);
  let v = _tzOffCache.get(k);
  if (v !== undefined) return v;
  try {
    let f = _tzFmtCache.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric'
      });
      _tzFmtCache.set(zone, f);
    }
    const p = {};
    for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
    const wall = Date.UTC(
        +p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    v = Math.round((wall - Math.floor(t / 1000) * 1000) / 60000);
  } catch (_) {
    v = 0;
  }  // zone unknown to this TV's ICU: no correction rather than a wrong one
  if (_tzOffCache.size > 4096) _tzOffCache = new Map();
  _tzOffCache.set(k, v);
  return v;
}
// Offset in the chosen mode: 'auto' follows the zone's rules at t; 'std'/'dst'
// pin the year's smaller/larger offset
function tzZoneOffsetMin(zone, mode, t) {
  if (mode !== 'std' && mode !== 'dst') return tzOffsetMin(zone, t);
  const y = new Date(t).getUTCFullYear(), k = zone + '|' + y;
  let r = _tzStdCache.get(k);
  if (!r) {
    const a = tzOffsetMin(zone, Date.UTC(y, 0, 1)),
          b = tzOffsetMin(zone, Date.UTC(y, 6, 1));
    r = {std: Math.min(a, b), dst: Math.max(a, b)};
    _tzStdCache.set(k, r);
  }
  return mode === 'std' ? r.std : r.dst;
}
function fmtUtcOffset(min) {
  if (!min) return 'UTC';
  const a = Math.abs(min);
  return `UTC${min < 0 ? '\u2212' : '+'}${Math.floor(a / 60)}${
      a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`;
}
function epgTzOptions() {
  return [{v: '', label: 'UTC (as published)'}].concat(EPG_TZ_ZONES.map(
      ([z, name]) => ({
        v: z,
        label: `${name} \u00b7 ${fmtUtcOffset(tzOffsetMin(z, Date.now()))}`
      })));
}
function epgTzSettingsFor(key) {
  const ps = key ? getPlaylistState(key) : null;
  const tz = ps && typeof ps.epgTz === 'string' &&
          EPG_TZ_ZONES.some(z => z[0] === ps.epgTz) ?
      ps.epgTz :
      '';
  const dst =
      ps && EPG_DST_OPTIONS.some(o => o.v === ps.epgDst) ? ps.epgDst : 'auto';
  const extra = ps && Number.isInteger(ps.epgOffset) &&
          EPG_EXTRA_OPTIONS.some(o => o.v === ps.epgOffset) ?
      ps.epgOffset :
      0;
  return {tz, dst, extra};
}
// Called when a playlist is applied: the correction belongs to the playlist,
// not the app
function epgOffsetLoad() {
  const c = epgTzSettingsFor(_activePlaylistKey);
  _epgTz = c.tz;
  _epgDst = c.dst;
  _epgExtraMs = c.extra * 60000;
  _epgShiftOn = !!(_epgTz || _epgExtraMs);
}
// Milliseconds to add to a provider time t
function epgShiftAt(t) {
  if (!_epgShiftOn || isNaN(t)) return 0;
  return _epgExtraMs -
      (_epgTz ? tzZoneOffsetMin(_epgTz, _epgDst, t) * 60000 : 0);
}
function epgShiftTime(t) {
  return t + epgShiftAt(t);
}
// Provider time from a corrected time (exact except inside a DST transition
// hour, where the provider's clock is ambiguous anyway)
function epgUnshiftTime(t) {
  if (!_epgShiftOn || isNaN(t)) return t;
  return t - epgShiftAt(t - epgShiftAt(t));
}
// Shift a programme list: dir +1 provider → corrected, −1 corrected → provider
// (new objects; a cached list must stay as it is)
function epgShiftProgs(progs, dir) {
  if (!_epgShiftOn || !progs) return progs;
  const f = dir < 0 ? epgUnshiftTime : epgShiftTime;
  const out = new Array(progs.length);
  for (let i = 0; i < progs.length; i++) {
    const p = progs[i];
    out[i] = Object.assign(
        {}, p, {start: f(p.start), stop: p.stop ? f(p.stop) : p.stop});
  }
  return out;
}
// Settings change: re-map everything already in epgData through provider time
// and redraw
function epgOffsetChange() {
  const lists = [...epgData.values()];
  const raw = lists.map(
      progs => progs.map(
          p =>
              [epgUnshiftTime(p.start),
               p.stop ? epgUnshiftTime(p.stop) : p.stop]));
  epgOffsetLoad();
  for (let i = 0; i < lists.length; i++) {
    const progs = lists[i], r = raw[i];
    for (let j = 0; j < progs.length; j++) {
      progs[j].start = epgShiftTime(r[j][0]);
      if (progs[j].stop) progs[j].stop = epgShiftTime(r[j][1]);
    }
  }
  _epgSkeletonWinStart = 0;
  if (!currentPlaylistType) return;
  refreshCurrentView();
  updateNowNext();
  if (epgMode && currentChannelIndex >= 0)
    updateEPGInfoPanel(channels[currentChannelIndex]);
  if (livePlayer.active) updateLiveOsd();
}

applyTextScale(settings.textScale);

// VOD (Movies & Series) state — see "// ----- VOD (Movies & Series) -----"
let vodMode = 'live';                   // 'live' | 'movies' | 'series'
let vodCats = null, seriesCats = null;  // [{ id, name, adult }]
const vodByCat = new Map(),
      seriesByCat = new Map();        // category id -> items (session cache)
let vodAll = null, seriesAll = null;  // full catalogs once fetched
let vodRecent = null, seriesRecent = null;  // newest 60 of the full catalog
let _vodAllLoading = null;  // { mode, p } while a full fetch is in flight
const vodInfoCache = new Map(), seriesInfoCache = new Map();
let vodFavs = loadJson(
    'iptv_vod_favorites',
    {});  // { [playlistKey]: { movies: {id: item}, series: {id: item} } }
let vodProgress = loadJson(
    'iptv_vod_progress',
    {});  // { [playlistKey|m:id | playlistKey|e:seriesId:epId]: entry }
const vodNav = {
  screen: 'home',
  list: 'home',
  catId: null,
  items: [],
  baseItems: [],
  focus: 0,
  zone: 'content',
  catIdx: 0,
  homeRow: 0,
  homeCol: {},
  homeRows: [],
  gridScroll: 0,
  query: '',
  detail: null,
  detailZone: 'buttons',
  detailBtn: 0,
  season: 0,
  epIdx: 0
};
const vodPlay = {
  active: false,
  kind: null,
  key: null,
  item: null,
  ep: null,
  season: null,
  epIdx: 0,
  seasons: null,
  dur: 0,
  resumeAt: 0,
  title: '',
  sub: '',
  osdTimer: null,
  saveAt: 0,
  nextTimer: null,
  nextCountdown: 0,
  nextEp: null,
  nextFocus: 'play',
  ended: false,
  subManual: false,
  audioManual: false,
  tracksFocus: 0,
  tracksItems: [],
  ums: null,  // webOS media-service pipeline info: { mediaId, sub, subTracks,
              // audioTracks, video, selectedSub, selectedAudio, keys }
  syncMs: 0
};
let vodSubSync = loadJson(
    'iptv_vod_subsync',
    {});  // progress key -> subtitle sync offset in ms (remembered per title)
let vodTech =
    loadJson('iptv_vod_tech', {});  // progress key -> codec/HDR summary string,
                                    // filled once a title has played
let liveUms =
    null;  // media-service state for the live pipeline (Stream Info codec line)
let _umsRateBroken = false;  // set when native setPlayRate does not move the
                             // position on this session
let _nativeRate =
    0;  // signed rate currently applied via setPlayRate, 0 = normal
const player = {
  focus: 'bar',
  btn: 0,
  btns: [],
  wakeKey: 0  // key code of the Up/Down press that showed the hidden OSD
};            // OSD focus: 'bar' (default) or 'buttons'; btn = index into btns
const livePlayer = {
  active: false
};  // live TV shown in the app-owned full-viewport player (same OSD as VOD)
function playerActive() {
  return vodPlay.active || livePlayer.active;
}
function activeUms() {
  return vodPlay.active                         ? vodPlay.ums :
      (livePlayer.active || vodMode === 'live') ? liveUms :
                                                  null;
}
let epgRenderedRows = new Map();  // rowIdx → DOM element currently in the DOM
let epgVirtualScrollListener = null;
let _epgWinStart = 0;
let _epgWinEnd = 0;
let _epgTotalGuideW = 0;
let _epgSkeletonWinStart =
    0;                 // tracks which hour window the time strip was built for
let _epgLoadedAt = 0;  // when the XMLTV feed (M3U) was last parsed
const EPG_M3U_REFRESH_MS =
    4 * 3600000;  // re-download XMLTV every 4h so the 6h window never runs dry

// Xtream lazy EPG state — EPG is fetched per channel on demand (see "Xtream
// lazy EPG")
let _xt = null;  // { base, u, pw } while an Xtream playlist is loaded
let _xtStreamIdByTvgId = new Map();    // tvgId -> stream_id for get_short_epg
const EPG_CACHE_TTL_MS = 2 * 3600000;  // re-fetch a channel's EPG after 2h
const EPG_CACHE_MAX = 800;  // max channels kept in epgData (LRU eviction)
const EPG_FETCH_CONCURRENCY =
    2;  // parallel get_short_epg requests (bursts make the provider answer with
        // empty listings)
const EPG_FETCH_SPACING_MS = 100;       // minimum gap between request starts
const EPG_EMPTY_RETRY_MS = 10 * 60000;  // an empty answer is asked again after
                                        // 10 min, not after the full TTL
const EPG_QUEUE_MAX = 400;              // max queued channel fetches
const EPG_XT_LIMIT = 48;  // listings per channel requested from the provider
let _epgFetchMeta =
    new Map();       // tvgId -> { at, status: 'pending'|'done'|'error' }
let _epgQueue = [];  // tvgIds waiting to fetch (front = highest priority)
let _epgQueued = new Set();  // membership mirror of _epgQueue
let _epgInFlight = 0;
let _epgVisibleFetchTimer = null;
let _epgPrefetchActive = false;

// Standard (M3U) view D-pad focus
let stdFocusZone = 'channels';  // 'groups' | 'channels'
let stdFocusIdx = 0;            // index into currentFilteredChannels
let stdGroupFocusIdx = 0;       // index into groupsList
let _stdItemH =
    0;  // row height of the virtual channel list (set by renderChannelList)
let _stdRenderVisible =
    null;  // renderVisible closure of the current channel list

// Precompiled regexes reused across many XMLTV parse iterations
const _RE_CHAN_ID = /id="([^"]*)"/;
const _RE_DISP_NAME = /<display-name[^>]*>([^<]+)<\/display-name>/;
const _RE_CHAN_ATTR = /channel="([^"]*)"/;
const _RE_START_ATTR = /start="([^"]*)"/;
const _RE_STOP_ATTR = /stop="([^"]*)"/;
const _RE_TITLE_TAG = /<title[^>]*>([^<]*)<\/title>/;
const _RE_B64 = /^[A-Za-z0-9+/]+=*$/;
const _RE_B64_ALPHA = /[a-zA-Z]/;
const _RE_TS_INJECT =
    /\s+start:\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}.*stop:\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}.*/i;

// DOM elements
const videoPlayer = document.getElementById('videoPlayer');
const channelListDiv = document.getElementById('channelList');
const channelCountSpan = document.getElementById('channelCount');
const statusArea = document.getElementById('statusArea');
const channelInfoTag = document.getElementById('channelInfoTag');
const reloadBtn = document.getElementById('reloadBtn');
const videoArea = document.getElementById('videoArea');
const groupsListDiv = document.getElementById('groupsList');
const groupsColumn = document.getElementById('groupsColumn');
const toggleGroupsBtn = document.getElementById('toggleGroupsBtn');
const showGroupsBtn = document.getElementById('showGroupsBtn');
const homePageBtn = document.getElementById('homePageBtn');
const startPage = document.getElementById('startPage');
const mainApp = document.getElementById('mainApp');
const loadingOverlay = document.getElementById('loadingOverlay');
const confirmDialog = document.getElementById('confirmDialog');
const loadSelectedBtn = document.getElementById('loadSelectedBtn');
const startStatusMessage = document.getElementById('startStatusMessage');
const startStatusBar = document.getElementById('startStatusBar');
const progressBarContainer = document.getElementById('progressBarContainer');
const progressBar = document.getElementById('progressBar');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const saveNewBtn = document.getElementById('saveNewBtn');
const newM3uUrl = document.getElementById('newM3uUrl');
const newM3uName = document.getElementById('newM3uName');
const clearAllBtn = document.getElementById('clearAllBtn');
const startDemoBtn = document.getElementById('startDemoBtn');
const confirmYes = document.getElementById('confirmYes');
const confirmNo = document.getElementById('confirmNo');
const confirmTitle = document.getElementById('confirmTitle');
const confirmMessage = document.getElementById('confirmMessage');
const subtitleBtn = document.getElementById('subtitleBtn');
const subtitlePanel = document.getElementById('subtitlePanel');
const audioBtn = document.getElementById('audioBtn');
const audioPanel = document.getElementById('audioPanel');
const newEpgUrl = document.getElementById('newEpgUrl');
const tabM3u = document.getElementById('tabM3u');
const tabXtream = document.getElementById('tabXtream');
const panelM3u = document.getElementById('panelM3u');
const panelXtream = document.getElementById('panelXtream');
const xtreamServer = document.getElementById('xtreamServer');
const xtreamUsername = document.getElementById('xtreamUsername');
const xtreamPassword = document.getElementById('xtreamPassword');
const xtreamName = document.getElementById('xtreamName');
const saveXtreamBtn = document.getElementById('saveXtreamBtn');

let infoHideTimeout = null;
let controlsTimeout = null;
let subtitlePanelOpen = false;
let audioPanelOpen = false;

// Stall watchdog — detects frozen streams and auto-reloads
let stallWatchdogTimer = null;
let stallLastTime = -1;
let stallCount = 0;
const STALL_CHECK_INTERVAL_MS = 2000;
const STALL_THRESHOLD_CHECKS = 5;  // ~10 s of no progress
const MAX_AUTO_RELOADS = 3;  // auto-reload budget per channel before giving up
let _reloadAttempts = 0;
let _stallGoodChecks = 0;
let _errRetryTimer = null;
