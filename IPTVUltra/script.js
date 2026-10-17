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

let activeTab = 'xtream'; // 'xtream' | 'm3u'
let epgMode = false;
let currentPlaylistType = null; // 'xtream' | 'm3u'

// EPG state
let epgData = new Map();      // channelId -> [{start, stop, title, desc}]
let epgIdMap = new Map();     // lowercase string -> actual channelId key in epgData
let epgLoading = false;
let currentEpgUrl = '';
let epgRefreshTimer = null;
let _epgAbortController = null;
let _m3uAbortController = null;
let epgFocusedRowIdx = 0;     // remote-cursor row in EPG guide (independent of playing channel)

let channelIndexMap = new Map(); // channel object → its index in channels[]
let _searchCache = { query: null, result: null }; // invalidated on every channels reload
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
    EPG_ROW_H = EPG_ROW_INNER + 1;                 // + 1px border-bottom
    EPG_TIME_STRIP_H = Math.round(34 * scale);
    CH_ITEM_H = Math.round(52 * scale);            // channel list row (no EPG line)
    CH_ITEM_H_EPG = Math.round(68 * scale);        // channel list row with EPG line
    const st = document.documentElement.style;
    st.setProperty('--text-scale', String(scale));
    st.setProperty('--epg-row-h', EPG_ROW_INNER + 'px');
    st.setProperty('--epg-strip-h', EPG_TIME_STRIP_H + 'px');
}

// Settings (persisted in localStorage) — UI and helpers under "// ----- Settings -----"
const SETTINGS_KEY = 'iptv_settings';
const PLAYLIST_STATE_KEY = 'iptv_playlist_state';
const LAST_PLAYLIST_KEY = 'iptv_last_playlist';
const TEXT_SCALE_OPTIONS = [1, 1.125, 1.25, 1.375, 1.5];
const AV_SYNC_MIN = 0, AV_SYNC_MAX = 60; // LG "AV Sync Adjustment" range (settingsservice avSync* keys, verified on the C4); -1 = leave the TV setting alone
const DEFAULT_SETTINGS = { textScale: 1.375, clock: '12', autoLoad: false, showAdult: false, subLang: 'en', audioLang: 'default', subSize: 'medium', subColor: 'white', subOpacity: 85, subBg: 'translucent', subEdge: 'outline', subAuto: false, liveBuffer: 5, autoNext: true, ppvEvents: 'hide', schema: 4 };
// Subtitle text opacity (%), sent as charOpacity; the C4 honours it (verified with the old Grey = white at 85)
const SUB_OPACITY_OPTIONS = [{ v: 100, label: '100%' }, { v: 85, label: '85%' }, { v: 70, label: '70%' }, { v: 55, label: '55%' }];
// Live rewind buffer (minutes) for HLS channels played through hls.js; 0 = native player only
const LIVE_BUFFER_OPTIONS = [{ v: 0, label: 'Off' }, { v: 2, label: '2 minutes' }, { v: 5, label: '5 minutes' }, { v: 10, label: '10 minutes' }];
// Groups of event channels (PPV) whose names carry the event time: sort by start time, optionally hide finished ones
const PPV_EVENT_OPTIONS = [{ v: 'hide', label: 'Sort, hide finished' }, { v: 'sort', label: 'Sort by start time' }, { v: 'off', label: 'As listed' }];
const SUB_SIZE_OPTIONS = [{ v: 'small', label: 'Small' }, { v: 'medium', label: 'Medium' }, { v: 'large', label: 'Large' }, { v: 'extraLarge', label: 'Extra large' }];
// ----- Diagnostics (error ring buffer, startup marks; Settings → Diagnostics) -----
// Registered this early so errors thrown while the rest of the script loads are caught too
// The log survives a restart (localStorage, saved 2 s after the last entry and on pagehide), so an error that
// ended in an app restart can still be read; entries from earlier runs are flagged `prev`.
const DIAG_MAX = 50;
const DIAG_STORE_KEY = 'iptv_diag_log';
const _diagLog = (() => {
    try {
        const a = JSON.parse(localStorage.getItem(DIAG_STORE_KEY) || '[]');
        return Array.isArray(a) ? a.slice(-DIAG_MAX).map(e => ({ t: +e.t || 0, msg: String(e.msg || ''), prev: true })) : [];
    } catch (_) { return []; }
})();
let _diagSaveTimer = 0;
function diagSave() {
    if (_diagSaveTimer) { clearTimeout(_diagSaveTimer); _diagSaveTimer = 0; }
    try { localStorage.setItem(DIAG_STORE_KEY, JSON.stringify(_diagLog.map(e => ({ t: e.t, msg: e.msg })))); } catch (_) { /* storage full or unavailable */ }
}
function diagLog(msg) {
    _diagLog.push({ t: Date.now(), msg: String(msg).slice(0, 300) });
    if (_diagLog.length > DIAG_MAX) _diagLog.shift();
    if (!_diagSaveTimer) _diagSaveTimer = setTimeout(diagSave, 2000);
}
window.addEventListener('pagehide', () => { if (_diagSaveTimer) diagSave(); });
// The most recent stream failure, with whatever the server answered, for Diagnostics
let _lastStreamFail = null; // { t, name, engine, what, reply }
function noteStreamFail(engine, what, reply) {
    const ch = currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
    _lastStreamFail = { t: Date.now(), name: ch ? ch.name : '', engine, what, reply: reply || '' };
}
window.addEventListener('error', e => diagLog(`Error: ${e.message}${e.filename ? ` (${String(e.filename).split('/').pop()}:${e.lineno})` : ''}`));
window.addEventListener('unhandledrejection', e => diagLog(`Unhandled rejection: ${e.reason && e.reason.message ? e.reason.message : String(e.reason)}`));
const _consoleError = console.error.bind(console);
console.error = function () { try { diagLog('console.error: ' + Array.from(arguments).map(a => (a && a.message) || String(a)).join(' ')); } catch (_) { /* ignore */ } _consoleError.apply(console, arguments); };
const _perfMarks = [];
function perfMark(label) { _perfMarks.push({ label, t: Math.round(performance.now()) }); }
perfMark('script-start');
// No Grey: the TV's caption pipeline has no grey colour (a 'gray' request renders as white); dimmer text is Subtitle opacity
const SUB_COLOR_OPTIONS = [{ v: 'white', label: 'White' }, { v: 'yellow', label: 'Yellow' }, { v: 'cyan', label: 'Cyan' }, { v: 'green', label: 'Green' }];
const SUB_BG_OPTIONS = [{ v: 'none', label: 'None' }, { v: 'translucent', label: 'Translucent' }, { v: 'solid', label: 'Solid black' }];
// Edge types the TV's subtitle renderer (libstarfish-subtitle-task) understands: none, uniform, raised, left_/right_drop_shadow
const SUB_EDGE_OPTIONS = [{ v: 'none', label: 'None' }, { v: 'outline', label: 'Outline' }, { v: 'shadow', label: 'Shadow' }, { v: 'raised', label: 'Raised' }];
const SUB_EDGE_UMS = { none: 'none', outline: 'uniform', shadow: 'right_drop_shadow', raised: 'raised' };
const SUB_LANG_OPTIONS = [{ v: 'en', label: 'English' }, { v: 'es', label: 'Spanish' }, { v: 'fr', label: 'French' }, { v: 'de', label: 'German' }, { v: 'pt', label: 'Portuguese' }, { v: 'it', label: 'Italian' }, { v: 'ar', label: 'Arabic' }, { v: 'any', label: 'First available' }];
const AUDIO_LANG_OPTIONS = [{ v: 'default', label: 'Default' }, { v: 'en', label: 'English' }, { v: 'es', label: 'Spanish' }, { v: 'fr', label: 'French' }, { v: 'de', label: 'German' }, { v: 'pt', label: 'Portuguese' }, { v: 'it', label: 'Italian' }, { v: 'ar', label: 'Arabic' }];
let settings = loadSettings();          // global: textScale, clock, autoLoad
let playlistState = loadPlaylistState(); // per playlist key: startGroup, resume, lastChannel, lastGroup
let _activePlaylistKey = null;          // key of the playlist currently loaded ('m:demo' for the demo)
let settingsOpen = false;
let settingsFocusIdx = 0;
let _settingsRowsCache = null;

// ----- EPG timezone (per playlist) -----
// Some providers write their guide in a local wall-clock but label it UTC (Xtream start_timestamp, XMLTV "+0000").
// The user names that zone in Settings; every programme time is corrected as it enters epgData (XMLTV parser,
// Xtream short/full EPG, cache restore): true UTC = listed time − the zone's UTC offset at that instant (so DST is
// right per programme date; the Daylight saving row can pin standard or daylight time instead), plus an extra
// ±3 h nudge. The IndexedDB EPG cache keeps provider time (so the setting can change later) and catch-up URLs
// convert back (the archive is indexed by the provider's own clock).
let _epgTz = '', _epgDst = 'auto', _epgExtraMs = 0, _epgShiftOn = false;
const EPG_TZ_ZONES = [
    ['Pacific/Honolulu', 'Hawaii (Honolulu)'], ['America/Anchorage', 'Alaska (Anchorage)'], ['America/Los_Angeles', 'Pacific (Los Angeles)'],
    ['America/Denver', 'Mountain (Denver)'], ['America/Phoenix', 'Arizona (Phoenix)'], ['America/Chicago', 'Central (Chicago)'],
    ['America/Mexico_City', 'Mexico City'], ['America/New_York', 'Eastern (New York)'], ['America/Bogota', 'Bogotá / Lima'],
    ['America/Halifax', 'Atlantic (Halifax)'], ['America/Caracas', 'Caracas'], ['America/St_Johns', 'Newfoundland (St. John\'s)'],
    ['America/Sao_Paulo', 'São Paulo'], ['America/Argentina/Buenos_Aires', 'Buenos Aires'], ['Atlantic/Azores', 'Azores'],
    ['Europe/London', 'London / Dublin / Lisbon'], ['Africa/Lagos', 'West Africa (Lagos)'], ['Europe/Paris', 'Central Europe (Paris, Berlin, Amsterdam)'],
    ['Europe/Athens', 'Eastern Europe (Athens, Helsinki, Kyiv)'], ['Africa/Cairo', 'Cairo'], ['Africa/Johannesburg', 'South Africa (Johannesburg)'],
    ['Europe/Istanbul', 'Istanbul'], ['Europe/Moscow', 'Moscow'], ['Asia/Riyadh', 'Riyadh / Baghdad'], ['Asia/Tehran', 'Tehran'],
    ['Asia/Dubai', 'Dubai'], ['Asia/Kabul', 'Kabul'], ['Asia/Karachi', 'Karachi'], ['Asia/Kolkata', 'India (Kolkata, Mumbai)'],
    ['Asia/Kathmandu', 'Kathmandu'], ['Asia/Dhaka', 'Dhaka'], ['Asia/Bangkok', 'Bangkok / Jakarta'], ['Asia/Shanghai', 'China (Shanghai, Beijing)'],
    ['Asia/Singapore', 'Singapore / Manila / Perth'], ['Asia/Tokyo', 'Japan / Korea (Tokyo, Seoul)'], ['Australia/Adelaide', 'Adelaide'],
    ['Australia/Brisbane', 'Brisbane'], ['Australia/Sydney', 'Sydney / Melbourne'], ['Pacific/Auckland', 'New Zealand (Auckland)'],
];
const EPG_DST_OPTIONS = [{ v: 'auto', label: 'Automatic' }, { v: 'std', label: 'Always standard time' }, { v: 'dst', label: 'Always daylight time' }];
const EPG_EXTRA_OPTIONS = (() => { // ±3 h in half hours
    const out = [];
    for (let m = -180; m <= 180; m += 30) out.push({ v: m, label: m === 0 ? 'None' : `${m < 0 ? '\u2212' : '+'}${Math.floor(Math.abs(m) / 60)} h${Math.abs(m) % 60 ? ' 30 min' : ''}` });
    return out;
})();
const _tzFmtCache = new Map();  // zone -> Intl.DateTimeFormat
let _tzOffCache = new Map();    // "zone|hourBucket" -> minutes (DST changes on hour boundaries; a few buckets cover a whole guide)
const _tzStdCache = new Map();  // "zone|year" -> { std, dst } minutes
function tzOffsetMin(zone, t) {
    const k = zone + '|' + Math.floor(t / 3600000);
    let v = _tzOffCache.get(k);
    if (v !== undefined) return v;
    try {
        let f = _tzFmtCache.get(zone);
        if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); _tzFmtCache.set(zone, f); }
        const p = {}; for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
        const wall = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
        v = Math.round((wall - Math.floor(t / 1000) * 1000) / 60000);
    } catch (_) { v = 0; } // zone unknown to this TV's ICU: no correction rather than a wrong one
    if (_tzOffCache.size > 4096) _tzOffCache = new Map();
    _tzOffCache.set(k, v);
    return v;
}
// Offset in the chosen mode: 'auto' follows the zone's rules at t; 'std'/'dst' pin the year's smaller/larger offset
function tzZoneOffsetMin(zone, mode, t) {
    if (mode !== 'std' && mode !== 'dst') return tzOffsetMin(zone, t);
    const y = new Date(t).getUTCFullYear(), k = zone + '|' + y;
    let r = _tzStdCache.get(k);
    if (!r) { const a = tzOffsetMin(zone, Date.UTC(y, 0, 1)), b = tzOffsetMin(zone, Date.UTC(y, 6, 1)); r = { std: Math.min(a, b), dst: Math.max(a, b) }; _tzStdCache.set(k, r); }
    return mode === 'std' ? r.std : r.dst;
}
function fmtUtcOffset(min) { if (!min) return 'UTC'; const a = Math.abs(min); return `UTC${min < 0 ? '\u2212' : '+'}${Math.floor(a / 60)}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`; }
function epgTzOptions() { return [{ v: '', label: 'UTC (as published)' }].concat(EPG_TZ_ZONES.map(([z, name]) => ({ v: z, label: `${name} \u00b7 ${fmtUtcOffset(tzOffsetMin(z, Date.now()))}` }))); }
function epgTzSettingsFor(key) {
    const ps = key ? getPlaylistState(key) : null;
    const tz = ps && typeof ps.epgTz === 'string' && EPG_TZ_ZONES.some(z => z[0] === ps.epgTz) ? ps.epgTz : '';
    const dst = ps && EPG_DST_OPTIONS.some(o => o.v === ps.epgDst) ? ps.epgDst : 'auto';
    const extra = ps && Number.isInteger(ps.epgOffset) && EPG_EXTRA_OPTIONS.some(o => o.v === ps.epgOffset) ? ps.epgOffset : 0;
    return { tz, dst, extra };
}
// Called when a playlist is applied: the correction belongs to the playlist, not the app
function epgOffsetLoad() {
    const c = epgTzSettingsFor(_activePlaylistKey);
    _epgTz = c.tz; _epgDst = c.dst; _epgExtraMs = c.extra * 60000;
    _epgShiftOn = !!(_epgTz || _epgExtraMs);
}
// Milliseconds to add to a provider time t
function epgShiftAt(t) {
    if (!_epgShiftOn || isNaN(t)) return 0;
    return _epgExtraMs - (_epgTz ? tzZoneOffsetMin(_epgTz, _epgDst, t) * 60000 : 0);
}
function epgShiftTime(t) { return t + epgShiftAt(t); }
// Provider time from a corrected time (exact except inside a DST transition hour, where the provider's clock is ambiguous anyway)
function epgUnshiftTime(t) { if (!_epgShiftOn || isNaN(t)) return t; return t - epgShiftAt(t - epgShiftAt(t)); }
// Shift a programme list: dir +1 provider → corrected, −1 corrected → provider (new objects; a cached list must stay as it is)
function epgShiftProgs(progs, dir) {
    if (!_epgShiftOn || !progs) return progs;
    const f = dir < 0 ? epgUnshiftTime : epgShiftTime;
    const out = new Array(progs.length);
    for (let i = 0; i < progs.length; i++) { const p = progs[i]; out[i] = Object.assign({}, p, { start: f(p.start), stop: p.stop ? f(p.stop) : p.stop }); }
    return out;
}
// Settings change: re-map everything already in epgData through provider time and redraw
function epgOffsetChange() {
    const lists = [...epgData.values()];
    const raw = lists.map(progs => progs.map(p => [epgUnshiftTime(p.start), p.stop ? epgUnshiftTime(p.stop) : p.stop]));
    epgOffsetLoad();
    for (let i = 0; i < lists.length; i++) { const progs = lists[i], r = raw[i]; for (let j = 0; j < progs.length; j++) { progs[j].start = epgShiftTime(r[j][0]); if (progs[j].stop) progs[j].stop = epgShiftTime(r[j][1]); } }
    _epgSkeletonWinStart = 0;
    if (!currentPlaylistType) return;
    refreshCurrentView(); updateNowNext();
    if (epgMode && currentChannelIndex >= 0) updateEPGInfoPanel(channels[currentChannelIndex]);
    if (livePlayer.active) updateLiveOsd();
}

applyTextScale(settings.textScale);

// VOD (Movies & Series) state — see "// ----- VOD (Movies & Series) -----"
let vodMode = 'live';                   // 'live' | 'movies' | 'series'
let vodCats = null, seriesCats = null;  // [{ id, name, adult }]
const vodByCat = new Map(), seriesByCat = new Map(); // category id -> items (session cache)
let vodAll = null, seriesAll = null;    // full catalogs once fetched
let vodRecent = null, seriesRecent = null; // newest 60 of the full catalog
let _vodAllLoading = null;              // { mode, p } while a full fetch is in flight
const vodInfoCache = new Map(), seriesInfoCache = new Map();
let vodFavs = loadJson('iptv_vod_favorites', {});    // { [playlistKey]: { movies: {id: item}, series: {id: item} } }
let vodProgress = loadJson('iptv_vod_progress', {}); // { [playlistKey|m:id | playlistKey|e:seriesId:epId]: entry }
const vodNav = { screen: 'home', list: 'home', catId: null, items: [], baseItems: [], focus: 0, zone: 'content', catIdx: 0,
                 homeRow: 0, homeCol: {}, homeRows: [], gridScroll: 0, query: '', detail: null, detailZone: 'buttons', detailBtn: 0, season: 0, epIdx: 0 };
const vodPlay = { active: false, kind: null, key: null, item: null, ep: null, season: null, epIdx: 0, seasons: null, dur: 0, resumeAt: 0,
                  title: '', sub: '', osdTimer: null, saveAt: 0, nextTimer: null, nextCountdown: 0, nextEp: null, nextFocus: 'play', ended: false,
                  subManual: false, audioManual: false, tracksFocus: 0, tracksItems: [],
                  ums: null,    // webOS media-service pipeline info: { mediaId, sub, subTracks, audioTracks, video, selectedSub, selectedAudio, keys }
                  syncMs: 0 };
let vodSubSync = loadJson('iptv_vod_subsync', {}); // progress key -> subtitle sync offset in ms (remembered per title)
let vodTech = loadJson('iptv_vod_tech', {});       // progress key -> codec/HDR summary string, filled once a title has played
let liveUms = null;                                 // media-service state for the live pipeline (Stream Info codec line)
let _umsRateBroken = false;                         // set when native setPlayRate does not move the position on this session
let _nativeRate = 0;                                // signed rate currently applied via setPlayRate, 0 = normal
const player = { focus: 'bar', btn: 0, btns: [] };  // OSD focus: 'bar' (default) or 'buttons'; btn = index into btns
const livePlayer = { active: false };               // live TV shown in the app-owned full-viewport player (same OSD as VOD)
function playerActive() { return vodPlay.active || livePlayer.active; }
function activeUms() { return vodPlay.active ? vodPlay.ums : (livePlayer.active || vodMode === 'live') ? liveUms : null; }
let epgRenderedRows = new Map(); // rowIdx → DOM element currently in the DOM
let epgVirtualScrollListener = null;
let _epgWinStart = 0;
let _epgWinEnd = 0;
let _epgTotalGuideW = 0;
let _epgSkeletonWinStart = 0;  // tracks which hour window the time strip was built for
let _epgLoadedAt = 0;          // when the XMLTV feed (M3U) was last parsed
const EPG_M3U_REFRESH_MS = 4 * 3600000; // re-download XMLTV every 4h so the 6h window never runs dry

// Xtream lazy EPG state — EPG is fetched per channel on demand (see "Xtream lazy EPG")
let _xt = null;                       // { base, u, pw } while an Xtream playlist is loaded
let _xtStreamIdByTvgId = new Map();   // tvgId -> stream_id for get_short_epg
const EPG_CACHE_TTL_MS = 2 * 3600000; // re-fetch a channel's EPG after 2h
const EPG_CACHE_MAX = 800;            // max channels kept in epgData (LRU eviction)
const EPG_FETCH_CONCURRENCY = 2;      // parallel get_short_epg requests (bursts make the provider answer with empty listings)
const EPG_FETCH_SPACING_MS = 100;     // minimum gap between request starts
const EPG_EMPTY_RETRY_MS = 10 * 60000; // an empty answer is asked again after 10 min, not after the full TTL
const EPG_QUEUE_MAX = 400;            // max queued channel fetches
const EPG_XT_LIMIT = 48;              // listings per channel requested from the provider
let _epgFetchMeta = new Map();        // tvgId -> { at, status: 'pending'|'done'|'error' }
let _epgQueue = [];                   // tvgIds waiting to fetch (front = highest priority)
let _epgQueued = new Set();           // membership mirror of _epgQueue
let _epgInFlight = 0;
let _epgVisibleFetchTimer = null;
let _epgPrefetchActive = false;

// Standard (M3U) view D-pad focus
let stdFocusZone = 'channels';  // 'groups' | 'channels'
let stdFocusIdx = 0;            // index into currentFilteredChannels
let stdGroupFocusIdx = 0;       // index into groupsList
let _stdItemH = 0;              // row height of the virtual channel list (set by renderChannelList)
let _stdRenderVisible = null;   // renderVisible closure of the current channel list

// Precompiled regexes reused across many XMLTV parse iterations
const _RE_CHAN_ID = /id="([^"]*)"/;
const _RE_DISP_NAME = /<display-name[^>]*>([^<]+)<\/display-name>/;
const _RE_CHAN_ATTR = /channel="([^"]*)"/;
const _RE_START_ATTR = /start="([^"]*)"/;
const _RE_STOP_ATTR = /stop="([^"]*)"/;
const _RE_TITLE_TAG = /<title[^>]*>([^<]*)<\/title>/;
const _RE_B64 = /^[A-Za-z0-9+/]+=*$/;
const _RE_B64_ALPHA = /[a-zA-Z]/;
const _RE_TS_INJECT = /\s+start:\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}.*stop:\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}.*/i;

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
const STALL_THRESHOLD_CHECKS = 5; // ~10 s of no progress
const MAX_AUTO_RELOADS = 3;       // auto-reload budget per channel before giving up
let _reloadAttempts = 0;
let _stallGoodChecks = 0;
let _errRetryTimer = null;

// ----- Live engine: native <video> or hls.js with a rewind buffer -----
// HLS channels (.m3u8; Xtream live URLs are built that way) can be played through hls.js, which feeds
// the <video> via Media Source Extensions so the app owns the buffer: `settings.liveBuffer` minutes
// behind the playhead are kept for rewind, and the same amount is fetched ahead while paused so
// playback resumes where it stopped. Raw MPEG-TS streams stay on the native pipeline, which decodes
// everything but exposes no rewind buffer. Anything hls.js cannot play (HEVC or AC-3 inside TS
// segments, a bad manifest) raises a fatal hls.js error and the channel goes back to the native
// player for the rest of the session (`_hlsBroken`). The webOS media service (liveUms) is not used
// on the hls.js path; the codec line comes from the HLS level instead.
const liveEngine = { hls: null, url: '', tech: '', recovered: false, resumeUrl: '', fps: 0, fpsSamples: [] };
const _hlsBroken = new Set();
// Measured on the C4 (2026-10-06): a SourceBuffer refuses appends ("full, cannot free space") at ~86 MB,
// i.e. 120 s of 1080p at 6.2 Mbps. Fetching ahead is capped below that so the limit is never hit; the
// minutes setting is therefore an upper bound and the real reach depends on the channel's bitrate.
const HLS_BUFFER_BYTES = 70 * 1000 * 1000;
function hlsReachMinutes(bitrate) {
    if (!(bitrate > 0)) return settings.liveBuffer;
    return Math.max(1, Math.min(settings.liveBuffer, Math.floor(HLS_BUFFER_BYTES * 8 / bitrate / 60)));
}
function isHlsUrl(url) { return /\.m3u8(\?|#|$)/i.test(url || '') || /[?&](type|output)=m3u8/i.test(url || ''); }
function hlsAvailable() { return settings.liveBuffer > 0 && typeof Hls !== 'undefined' && Hls.isSupported(); }
function liveEngineActive() { return !!liveEngine.hls; }
function liveEngineDestroy() {
    if (liveEngine.hls) { try { liveEngine.hls.destroy(); } catch (_) { /* already gone */ } liveEngine.hls = null; }
    liveEngine.url = ''; liveEngine.tech = '';
}
// Point the live <video> at a channel URL through whichever engine fits. Returns true when hls.js took it.
function loadLiveSource(url) {
    liveEngineDestroy();
    if (!(hlsAvailable() && isHlsUrl(url) && !_hlsBroken.has(url))) {
        videoPlayer.src = url;
        videoPlayer.load();
        return false;
    }
    const secs = settings.liveBuffer * 60;
    const hls = new Hls({
        backBufferLength: secs,            // keep this much behind the playhead for rewind
        maxBufferLength: secs,             // and fetch this far ahead, so a pause can be resumed from the buffer
        maxMaxBufferLength: secs * 2,
        maxBufferSize: HLS_BUFFER_BYTES,   // bytes ahead of the playhead; below the TV's ~86 MB SourceBuffer quota
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: Infinity, // never force the playhead back to the live edge
        lowLatencyMode: false,
        enableWorker: true,
        capLevelToPlayerSize: false,
        manifestLoadingMaxRetry: 2,
        fragLoadingMaxRetry: 4,
    });
    liveEngine.hls = hls; liveEngine.url = url; liveEngine.tech = ''; liveEngine.recovered = false; liveEngine.resumeUrl = '';
    liveEngine.fps = 0; liveEngine.fpsSamples = [];
    liveEngine.subManual = false; liveEngine.audioManual = false;
    videoPlayer.removeAttribute('src'); // hls.js attaches its own MediaSource URL
    hls.on(Hls.Events.ERROR, (_, data) => onHlsError(url, data));
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, applyHlsTrackPrefs);
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, applyHlsTrackPrefs);
    hls.on(Hls.Events.MANIFEST_PARSED, liveTechFromHls);
    hls.on(Hls.Events.LEVEL_SWITCHED, liveTechFromHls);
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, liveTechFromHls);
    hls.on(Hls.Events.BUFFER_APPENDING, (_, d) => hlsFpsFromAppend(hls, d));
    hls.loadSource(url);
    hls.attachMedia(videoPlayer);
    return true;
}
// Body of the manifest response hls.js could not parse ('' when there was none)
function hlsReplyBody(data) { return data && data.response && typeof data.response.data === 'string' ? data.response.data : ''; }
function onHlsError(url, data) {
    if (!data || !data.fatal || liveEngine.url !== url) return;
    console.log('hls.js fatal error', data.type, data.details);
    // A provider that refuses the stream (one-connection account in use, expired, rate limited) answers the
    // playlist request with an HTML or text page, which hls.js reports as a manifest parsing error. Only a real
    // playlist (#EXTM3U) that still fails to parse says the channel is unplayable through hls.js.
    const isParse = data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;
    const body = isParse ? hlsReplyBody(data) : '';
    const notPlaylist = isParse && !/^\s*#EXTM3U/.test(body);
    const nd = data.networkDetails, status = nd && nd.status ? nd.status : (data.response && data.response.code) || 0;
    const reply = isParse ? (body.replace(/\s+/g, ' ').trim().slice(0, 160) || '(empty)') : '';
    diagLog(`hls.js fatal ${data.type}/${data.details}${status ? ` HTTP ${status}` : ''}${reply ? ` reply: ${reply}` : ''}` +
        `${notPlaylist ? ' → not a playlist, treated as a network failure' : ''}${document.hidden ? ' (app hidden)' : ''}`);
    noteStreamFail('hls.js', `${data.type}/${data.details}${status ? ` · HTTP ${status}` : ''}`, reply);
    const hls = liveEngine.hls;
    // Hidden app: webOS freezes the page's timers and network, which hls.js reports as failed requests.
    // Nothing is wrong with the channel; retry on the hls path when the app is visible again.
    if (document.hidden) { liveEngine.resumeUrl = url; liveEngineDestroy(); return; }
    // A media error gets one in-place recovery (hls.js re-creates its SourceBuffers) before we give up on it
    if (hls && data.type === Hls.ErrorTypes.MEDIA_ERROR && !liveEngine.recovered && data.details !== Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR) {
        liveEngine.recovered = true;
        try { hls.recoverMediaError(); videoPlayer.play().catch(() => {}); return; } catch (_) { /* fall through to native */ }
    }
    // Content hls.js cannot handle (codecs it cannot demux, unparsable manifest) is remembered so the native
    // pipeline takes the channel for the rest of the session; plain network failures are not held against it
    const incompatible = data.type === Hls.ErrorTypes.MEDIA_ERROR || data.type === Hls.ErrorTypes.MUX_ERROR ||
        (isParse && !notPlaylist) || data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR;
    if (incompatible) _hlsBroken.add(url);
    liveEngineDestroy();
    // Hand the channel to the native pipeline; its own error handler and reload budget take over from here
    if (vodMode === 'live' && !vodPlay.active && currentChannelIndex >= 0 && channels[currentChannelIndex].url === url) {
        umsNoteCurrentId();
        videoPlayer.src = url;
        videoPlayer.load();
        liveUmsRefresh();
        videoPlayer.play().catch(() => {});
    }
}
// Codec / resolution / bitrate line from the HLS level (the media service does not describe MSE playback)
function liveTechFromHls() {
    const hls = liveEngine.hls; if (!hls || !hls.levels || !hls.levels.length) return;
    const lvl = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : 0];
    const bits = [];
    const vc = String(lvl.videoCodec || '').toLowerCase();
    if (vc) bits.push(/^(avc|h264)/.test(vc) ? 'H.264' : /^(hvc|hev|h265)/.test(vc) ? 'HEVC' : vc.split('.')[0].toUpperCase());
    if (lvl.width && lvl.height) bits.push(`${lvl.width}×${lvl.height}`);
    else if (videoPlayer.videoWidth) bits.push(`${videoPlayer.videoWidth}×${videoPlayer.videoHeight}`);
    const fps = lvl.frameRate || liveEngine.fps;
    if (fps) bits.push(fmtFps(fps));
    if (lvl.bitrate) bits.push(`${Math.round(lvl.bitrate / 1000)} kbps`);
    const ac = String(lvl.audioCodec || '').toLowerCase();
    if (ac) bits.push(/^mp4a\.40/.test(ac) ? 'AAC' : /^ac-3/.test(ac) ? 'AC-3' : /^ec-3/.test(ac) ? 'E-AC-3' : ac.toUpperCase());
    const reach = hlsReachMinutes(lvl.bitrate);
    bits.push(`⏪ ${reach < settings.liveBuffer ? '~' : ''}${reach} min`);
    liveEngine.tech = bits.join(' · ');
    if (livePlayer.active) { const el = document.getElementById('vodOsdTech'); if (el) el.textContent = liveEngine.tech; }
    else showFeedStats(liveEngine.tech);
}
// Frame rate as shown on the codec line; measured rates snap to the broadcast ones (23.976 … 120) within 2 %
const FPS_STD = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];
function fpsSnap(f) {
    let best = 0;
    for (const c of FPS_STD) if (Math.abs(f - c) / c < 0.02 && (!best || Math.abs(f - c) < Math.abs(f - best))) best = c;
    return best || Math.round(f);
}
function fmtFps(f) { return `${(+f).toFixed(3).replace(/\.?0+$/, '')} fps`; }
// HLS playlists rarely state FRAME-RATE (the provider's never do), so the hls.js path counts it: hls.js remuxes each
// segment to fMP4 before appending, and the moof's trun carries the number of video samples in it. Samples over
// the segment's PTS span is the frame rate. One segment of 6 s or more is enough (a frame more or less moves the
// rate by under 0.2 fps; some channels are a single 600 s segment); shorter ones take the median of three.
function hlsFpsFromAppend(hls, d) {
    if (liveEngine.hls !== hls || liveEngine.fps || !d || d.type !== 'video' || !(d.data instanceof Uint8Array)) return;
    const b = d.data, f = d.frag;
    const es = f && f.elementaryStreams && f.elementaryStreams.video;
    const span = es && es.endPTS > es.startPTS ? es.endPTS - es.startPTS : (f && f.duration) || 0;
    if (!(span > 1)) return;
    let n = 0;
    for (let i = 4, end = Math.min(b.length - 12, 8192); i < end; i++) {
        if (b[i] === 0x74 && b[i + 1] === 0x72 && b[i + 2] === 0x75 && b[i + 3] === 0x6e) { // 'trun': version/flags, then sample_count
            n = ((b[i + 8] << 24) | (b[i + 9] << 16) | (b[i + 10] << 8) | b[i + 11]) >>> 0;
            break;
        }
    }
    if (!(n > 0)) return;
    const fs = liveEngine.fpsSamples;
    fs.push(n / span);
    if (span >= 6) liveEngine.fps = fpsSnap(n / span);
    else if (fs.length >= 3) liveEngine.fps = fpsSnap(fs.slice().sort((a, b2) => a - b2)[1]);
    else return;
    liveTechFromHls();
}
// Where the live playhead may go on the hls.js path: the buffered range around it, up to the live edge
function liveBufferRange() {
    const hls = liveEngine.hls;
    const t = videoPlayer.currentTime || 0;
    const b = videoPlayer.buffered;
    let start = t, end = t;
    for (let i = 0; i < b.length; i++) if (b.start(i) - 1 <= t && t <= b.end(i) + 1) { start = b.start(i); end = b.end(i); break; }
    if (b.length && start === t && end === t) { start = b.start(0); end = b.end(b.length - 1); }
    const live = hls && typeof hls.liveSyncPosition === 'number' && hls.liveSyncPosition > 0 ? hls.liveSyncPosition : end;
    return { start, end: Math.max(end, live), live };
}
function liveBehindSecs() {
    if (!liveEngine.hls) return 0;
    const r = liveBufferRange();
    return Math.max(0, r.live - (videoPlayer.currentTime || 0));
}
function liveGoLive() {
    if (!liveEngine.hls) return;
    try { videoPlayer.currentTime = liveBufferRange().live; } catch (_) { /* not seekable yet */ }
    videoPlayer.play().catch(() => {});
    if (livePlayer.active) showVodOsd();
}
// ----- Provider connection limit (Xtream) -----
// A second device on a one-connection account makes every channel fail with a plain network error. On a
// stream failure the auth call is repeated (cheap, never a stream) and active_cons / max_connections tell.
let _consInfo = null;   // { active, max, status, exp, at }
let _consCheckAt = 0;
async function xtreamCheckConnections() {
    if (!_xt || Date.now() - _consCheckAt < 15000) return _consInfo;
    _consCheckAt = Date.now();
    try {
        const r = await fetch(`${_xt.base}/player_api.php?username=${_xt.u}&password=${_xt.pw}`);
        if (!r.ok) return _consInfo;
        const j = await r.json();
        const ui = j && j.user_info;
        if (!ui) return _consInfo;
        const active = parseInt(ui.active_cons), max = parseInt(ui.max_connections);
        _consInfo = { active: isNaN(active) ? -1 : active, max: isNaN(max) ? -1 : max, status: String(ui.status || ''), exp: parseInt(ui.exp_date) > 0 ? parseInt(ui.exp_date) * 1000 : 0, at: Date.now() };
    } catch (_) { /* provider unreachable: nothing to say */ }
    return _consInfo;
}
// Human explanation of a failing stream when the account, not the channel, is the cause; '' otherwise
function accountProblemText(ci) {
    if (!ci || Date.now() - ci.at > 60000) return '';
    if (/expired|disabled|banned/i.test(ci.status)) return `Account ${ci.status.toLowerCase()}`;
    if (ci.max > 0 && ci.active >= ci.max) return ci.max === 1 ? 'Another device is streaming with this account (1 connection allowed)' : `All ${ci.max} connections of this account are in use`;
    return '';
}
function noteStreamFailureForAccount(idx) {
    if (!_xt || currentPlaylistType !== 'xtream') return;
    xtreamCheckConnections().then(ci => {
        const t = accountProblemText(ci);
        if (!t || currentChannelIndex !== idx) return;
        statusArea.innerText = `⚠️ ${t}`;
        showEPGToast(`${t}. Stop playback on the other device, then press Reload.`, 'error', 'Connection limit');
        hideEPGToast(8000);
        diagLog(`Account: ${t} (active ${ci.active} / max ${ci.max})`);
    });
}

// ----- AV sync through Homebrew root exec (rooted TVs only) -----
// The app cannot reach LG's AV Sync Adjustment itself (settingsservice is denied by the ACG); on a rooted TV the
// Homebrew Channel service runs commands as root, so the TV's own setting is driven through luna-send and put
// back when the app goes to the background or exits.
let _hbAvailable = null; // null = not probed yet
function hbExec(command, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, timeoutMs);
        try {
            if (typeof webOS === 'undefined' || !webOS.service || !webOS.service.request) throw new Error('no webOS service bridge');
            webOS.service.request('luna://org.webosbrew.hbchannel.service', { method: 'exec', parameters: { command },
                onSuccess: r => { if (done) return; done = true; clearTimeout(t); resolve((r && (r.stdoutString !== undefined ? r.stdoutString : r.stdout)) || ''); },
                onFailure: e => { if (done) return; done = true; clearTimeout(t); reject(new Error((e && e.errorText) || 'exec failed')); } });
        } catch (e) { if (!done) { done = true; clearTimeout(t); reject(e); } }
    });
}
function hbProbe() {
    if (_hbAvailable !== null) return Promise.resolve(_hbAvailable);
    return hbExec('echo hb-ok', 3000).then(out => { _hbAvailable = /hb-ok/.test(out); return _hbAvailable; }).catch(() => { _hbAvailable = false; return false; });
}
const AV_SYNC_OPTIONS = (() => { const o = [{ v: -1, label: 'TV setting' }]; for (let v = AV_SYNC_MIN; v <= AV_SYNC_MAX; v++) o.push({ v, label: String(v) }); return o; })();
const AV_SYNC_KEYS = ['avSyncSpeaker', 'avSyncSpdif', 'avSyncBtSurround', 'avSyncWisa']; // one per sound output family, all 0-60
// Which settingsservice key the TV's AV Sync Adjustment uses for the current sound output
function avSyncKeyFor(soundOutput) {
    const o = String(soundOutput || '');
    if (/optical/.test(o) && !/arc/.test(o)) return 'avSyncSpdif';
    if (/^bt_|bluetooth|bt_surround|bt_tv_atmos/.test(o)) return 'avSyncBtSurround';
    if (/wisa/.test(o)) return 'avSyncWisa';
    return 'avSyncSpeaker'; // TV speaker, HDMI ARC/eARC and the rest
}
let _avSyncOrig = null; // { avSync, <key>: value } as found before the app changed anything
let _avSyncKey = 'avSyncSpeaker';
function lunaSettingsCmd(method, payload) { return `luna-send -n 1 luna://com.webos.settingsservice/${method} '${JSON.stringify(payload)}'`; }
async function avSyncRead() {
    const out = await hbExec(lunaSettingsCmd('getSystemSettings', { category: 'sound', keys: ['avSync', 'soundOutput'].concat(AV_SYNC_KEYS) }));
    const j = JSON.parse(out);
    if (!j || !j.settings) throw new Error('no settings');
    return j.settings;
}
async function avSyncApply(v) {
    if (!_hbAvailable || !(v >= 0)) return false;
    if (_avSyncOrig === null) {
        try { const s = await avSyncRead(); _avSyncKey = avSyncKeyFor(s.soundOutput); _avSyncOrig = { avSync: s.avSync, [_avSyncKey]: s[_avSyncKey] }; } catch (e) { diagLog('AV sync: cannot read TV setting: ' + e.message); return false; }
    }
    try { await hbExec(lunaSettingsCmd('setSystemSettings', { category: 'sound', settings: { avSync: 'on', [_avSyncKey]: String(v) } })); return true; }
    catch (e) { diagLog('AV sync: cannot set TV setting: ' + e.message); return false; }
}
async function avSyncRestore() {
    if (!_avSyncOrig) return;
    const o = _avSyncOrig; _avSyncOrig = null;
    try { await hbExec(lunaSettingsCmd('setSystemSettings', { category: 'sound', settings: o })); } catch (e) { diagLog('AV sync: restore failed: ' + e.message); }
}
function avSyncOnVisibility() {
    if (!_hbAvailable || !(settings.avSync >= 0)) return;
    if (document.hidden) avSyncRestore(); else avSyncApply(settings.avSync);
}
window.addEventListener('pagehide', () => { if (_avSyncOrig && _hbAvailable) avSyncRestore(); });

// Hidden (another app in front, Home, screensaver): stop fetching segments so nothing times out while the
// page is frozen; visible again: resume, or re-open the channel if the engine was torn down meanwhile.
document.addEventListener('visibilitychange', () => {
    avSyncOnVisibility();
    if (liveEngine.hls) {
        try { if (document.hidden) liveEngine.hls.stopLoad(); else liveEngine.hls.startLoad(-1); } catch (_) { /* engine gone */ }
        return;
    }
    if (!document.hidden && liveEngine.resumeUrl && vodMode === 'live' && !vodPlay.active && currentChannelIndex >= 0 && channels[currentChannelIndex].url === liveEngine.resumeUrl) {
        liveEngine.resumeUrl = '';
        reloadStream(false);
    }
});


let _holdKeyDir   = null;  // 'left' | 'right' | null — tracks which key is physically held
let _holdKeyStart = 0;
const HOLD_THRESHOLD_MS = 500;

// Trick-play (hold-to-rewind / hold-to-FF)
const _REWIND_RAMP = [
    { after: 0,    speed: -1 },
    { after: 1500, speed: -2 },
    { after: 4000, speed: -4 },
    { after: 8000, speed: -8 },
];
const _FF_RAMP = [
    { after: 0,    speed: 2 },
    { after: 1500, speed: 4 },
    { after: 4000, speed: 8 },
];
let _trickInterval  = null;
let _trickHoldStart = 0;
let _trickHoldDir   = null;  // 'left' | 'right' | null — null means not in trick play
// VOD scrubbing: while Left/Right is held the OSD position moves at these
// speeds (seconds of content per second) and the video seeks once on release.
// Seeking a large file on every tick stalls the decoder and the bar never moves.
const _VOD_SCRUB_RAMP = [
    { after: 0,    speed: 10 },
    { after: 1500, speed: 30 },
    { after: 4000, speed: 60 },
    { after: 8000, speed: 120 },
];
let _scrubPos = null;        // virtual position during a VOD scrub, null otherwise

function _seekRange() {
    if (liveEngineActive() && !vodPlay.active) { const r = liveBufferRange(); return { start: r.start, end: r.end }; }
    if (videoPlayer.seekable && videoPlayer.seekable.length > 0)
        return { start: videoPlayer.seekable.start(0), end: videoPlayer.seekable.end(0) };
    return { start: 0, end: videoPlayer.duration || 0 };
}

function _seekBy(seconds) {
    const range = _seekRange();
    videoPlayer.currentTime = Math.max(range.start, Math.min(range.end - 1, videoPlayer.currentTime + seconds));
    videoPlayer.play().catch(() => {});
}

function _getRampSpeed(ramp, heldMs) {
    let speed = ramp[0].speed;
    for (const step of ramp) { if (heldMs >= step.after) speed = step.speed; }
    return speed;
}

function _showTrickBadge(text) {
    const el = document.getElementById('pbTrickBadge');
    if (!el) return;
    el.textContent = text;
    el.style.display = '';
}

function _hideTrickBadge() {
    const el = document.getElementById('pbTrickBadge');
    if (el) el.style.display = 'none';
}

function _startHold(dir) {
    if (_trickHoldDir) return;
    _trickHoldDir   = dir;
    _trickHoldStart = Date.now();
    videoPlayer.pause();
    // Native speed playback only once the pipeline is attached and has described the file
    if (vodPlay.active && vodPlay.ums && vodPlay.ums.mediaId && vodPlay.ums.video && !_umsRateBroken) { startNativeRate(dir); return; }
    if (vodPlay.active) {
        _scrubPos = videoPlayer.currentTime || 0;
        if (vodPlay.osdTimer) { clearTimeout(vodPlay.osdTimer); vodPlay.osdTimer = null; }
        document.getElementById('vodOsd').classList.add('visible');
        _trickInterval = setInterval(() => {
            const heldMs = Date.now() - _trickHoldStart;
            const speed  = _getRampSpeed(_VOD_SCRUB_RAMP, heldMs);
            const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) || vodPlay.dur || 0;
            const max = dur ? Math.max(0, dur - 1) : Number.MAX_VALUE;
            _scrubPos = Math.max(0, Math.min(max, _scrubPos + (dir === 'left' ? -1 : 1) * speed * 0.1));
            _showTrickBadge((dir === 'left' ? '◀◀ ' : '▶▶ ') + speed + '×');
            updateVodOsd(_scrubPos);
            if ((dir === 'right' && dur && _scrubPos >= max) || (dir === 'left' && _scrubPos <= 0)) _stopHold();
        }, 100);
        return;
    }
    const ramp = dir === 'left' ? _REWIND_RAMP : _FF_RAMP;
    _trickInterval = setInterval(() => {
        const heldMs = Date.now() - _trickHoldStart;
        const speed  = _getRampSpeed(ramp, heldMs);
        const range  = _seekRange();
        if (dir === 'left') {
            videoPlayer.currentTime = Math.max(range.start, videoPlayer.currentTime + speed * 0.1);
            _showTrickBadge('◀◀ ' + Math.abs(speed) + '×');
        } else {
            videoPlayer.currentTime = Math.min(range.end - 1, videoPlayer.currentTime + speed * 0.1);
            _showTrickBadge('▶▶ ' + speed + '×');
            if (videoPlayer.currentTime >= range.end - 1) _stopHold();
        }
    }, 100);
}

function _stopHold() {
    if (_trickInterval) { clearInterval(_trickInterval); _trickInterval = null; }
    videoPlayer.playbackRate = 1;
    _trickHoldDir   = null;
    _trickHoldStart = 0;
    _hideTrickBadge();
    if (_nativeRate !== 0) {
        // VOD native speed playback: back to 1× with audio
        _nativeRate = 0;
        if (vodPlay.ums) umsCall('setPlayRate', { mediaId: vodPlay.ums.mediaId, playRate: 1, audioOutput: true });
        videoPlayer.play().catch(() => {});
        if (vodPlay.active) showVodOsd();
        return;
    }
    if (_scrubPos !== null) {
        // VOD: one seek to the scrubbed position, then resume
        const target = _scrubPos;
        _scrubPos = null;
        try { videoPlayer.currentTime = target; } catch (_) { /* not seekable yet */ }
        videoPlayer.play().catch(() => {});
        if (vodPlay.active) showVodOsd();
        return;
    }
    videoPlayer.play().catch(() => {});
}

function _isHolding() { return _trickHoldDir !== null; }

const LANG_NAMES = {
    // Western Europe
    en: 'English', fr: 'French', de: 'German', it: 'Italian', es: 'Spanish', pt: 'Portuguese',
    nl: 'Dutch', sv: 'Swedish', da: 'Danish', fi: 'Finnish', nb: 'Norwegian', no: 'Norwegian',
    is: 'Icelandic', lb: 'Luxembourgish', ca: 'Catalan', gl: 'Galician', eu: 'Basque',
    mt: 'Maltese', cy: 'Welsh', ga: 'Irish', af: 'Afrikaans',
    // Eastern Europe
    ru: 'Russian', pl: 'Polish', cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian',
    uk: 'Ukrainian', bg: 'Bulgarian', hr: 'Croatian', sr: 'Serbian', sl: 'Slovenian',
    bs: 'Bosnian', mk: 'Macedonian', sq: 'Albanian', el: 'Greek',
    // Baltic
    lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian',
    // Middle East / Central Asia
    ar: 'Arabic', he: 'Hebrew', fa: 'Persian', ur: 'Urdu', tr: 'Turkish',
    az: 'Azerbaijani', ka: 'Georgian', hy: 'Armenian', kk: 'Kazakh', uz: 'Uzbek',
    // South Asia
    hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam',
    mr: 'Marathi', gu: 'Gujarati', pa: 'Punjabi', si: 'Sinhala', ne: 'Nepali',
    // East / Southeast Asia
    zh: 'Chinese', ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese', th: 'Thai',
    id: 'Indonesian', ms: 'Malay', tl: 'Filipino', my: 'Burmese', km: 'Khmer',
    // Africa
    sw: 'Swahili', am: 'Amharic', yo: 'Yoruba', ig: 'Igbo', ha: 'Hausa', so: 'Somali',
    // Americas
    ht: 'Haitian Creole', qu: 'Quechua',
    // Mongolian / misc
    mn: 'Mongolian'
};

// ----- EPG (XMLTV) -----
let _chanByNum = new Map(); // provider channel number → index in channels[] (direct entry with the digit keys)
let _chanByUrl = new Map(); // stream URL → index (Recent list, alternate sources)
let _chansByFavId = new Map(); // favorite id → [channels], so Favorites can follow the user's order
// A favorite is one exact channel: the Xtream stream id, else the stream URL. (Until 3.12 it was the tvg-id, which
// quality variants share, so starring the 1080p entry also listed its 720p and 480p copies.)
function favIdOf(ch, idx) { return ch.streamId != null && ch.streamId !== '' ? `s:${ch.streamId}` : ch.url ? `u:${ch.url}` : `idx_${idx}`; }
function buildChannelIndexMap() {
    channelIndexMap = new Map();
    _chanByNum = new Map();
    _chanByUrl = new Map();
    _chansByFavId = new Map();
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        channelIndexMap.set(ch, i);
        const n = ch.num;
        if (n > 0 && !_chanByNum.has(n)) _chanByNum.set(n, i);
        if (ch.url && !_chanByUrl.has(ch.url)) _chanByUrl.set(ch.url, i);
        const fid = favIdOf(ch, i);
        if (_chansByFavId.has(fid)) _chansByFavId.get(fid).push(ch); else _chansByFavId.set(fid, [ch]);
    }
    _searchCache = { query: null, result: null };
    _altSources.clear();
    buildEventProgs();
}
function chDisplayNum(ch, idx) { return ch && ch.num > 0 ? ch.num : idx + 1; }

// ----- Event (PPV) channels -----
// Event channels carry their schedule in the name instead of the EPG, in many provider formats. Only formats
// whose time zone is known are read; the zones were checked on the real provider 2026-10-15 against the same
// event listed in two formats (ESPN+ "Oct 15 7:00AM ET (2026-10-15 07:00:00)"; MAX "@ Oct 15 02:30 AM" =
// "Thu 15 Oct 02:30 EDT"; Sportsnet+ "@ Oct 15 9:00 AM" = "Thu 15 Oct 10:30 NDT"; PDC "start:… 11:00" = a Basel
// 13:00 session, i.e. UTC). Read formats:
//   "LIVE | SEATTLE @ TAMPA BAY | Thu 15 Oct 20:30 NDT (CA) | 8K EXCLUSIVE | …"   (also "// UK Sat 10 Oct 12:30pm")
//   "End | Leo Victor vs. Notch | … | 2026-10-15 | 00:15 (GMT) | …"               (also 15-10-2026)
//   "UFC 02 : UFC FIGHT NIGHT … start:2026-10-11 01:55:00 stop:2026-10-11 06:00:00"  (UTC)
//   "US (ESPN+ 001) | Football: … (2026-10-15 08:00:00)"                          (US Eastern; "AU (" names Sydney)
//   "Toronto FC vs Orlando City @ Oct 14 7:30 PM :MLS 04"                         (US Eastern; US| and CA| groups only)
// Times without a zone ("7pm Sabres at Maple Leafs", "Fri 18 Apr 22:05") and the 2098 placeholder slots are skipped.
// A parsed event fills the guide for a channel that has no EPG of its own (epgProgsOf) and orders its group.
const EV_MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const EV_ABBR = { UTC: 0, GMT: 0, BST: 60, CET: 60, CEST: 120, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360,
    PST: -480, PDT: -420, AST: -240, ADT: -180, NST: -210, NDT: -150, AEST: 600, AEDT: 660 };
const EV_ZONE = { ET: 'America/New_York', CT: 'America/Chicago', PT: 'America/Los_Angeles', UK: 'Europe/London' };
const EVENT_DEFAULT_MS = 3 * 3600000;   // assumed length when the name gives only a start
const EVENT_HIDE_AFTER_MS = 3600000;    // finished events stay listed this long
const _RE_EV_PRE = /\d:\d\d|\d{4}-\d\d-\d\d|\d\d-\d\d-\d{4}/;
const _RE_EV_TAG = /^\s*(LIVE|NEXT|ENDED|End)\s*\|\s*/i;
const _RE_EV_STARTSTOP = /\bstart:(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)(?::\d\d)?\s+stop:(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/;
const _RE_EV_PIPEDATE = /(?:(\d{4})-(\d\d)-(\d\d)|(\d\d)-(\d\d)-(\d{4}))\s*\|\s*(\d{1,2}):(\d\d)\s*\((?:GMT|UTC)\)/;
const _RE_EV_PAREN = /\((\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):\d\d\)\s*$/;
const _RE_EV_DAY = /(?:\b(UK|ET)\s+)?\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}):(\d\d)(?::\d\d)?\s*([ap]m)?\s*([A-Z]{2,4})?\b/i;
const _RE_EV_AT = /@\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\s+(\d{1,2}):(\d\d)\s*([ap]m)?/i;
const _RE_EV_JUNKSEG = /^(?:\d+K EXCLUSIVE|all|[A-Z]{2}: .+ \d+|(?:[A-Z]{2}\s*)?(?:\([^)]*\)\s*)+\d*)$/i;
const _RE_EV_LABEL = /^(?:(?:\S+\s+){0,2}\d{1,3}\S?\s*:|[a-z]+:\s*\d+\s+name:)\s*/i; // "UFC 02 :", "PDC Board 01 :", "wnba: 1 name:"
const EV_WDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
// Wall-clock time in a zone (IANA id or fixed offset in minutes) → UTC ms
function evWallToUtc(y, mo, d, h, mi, zone) {
    const wall = Date.UTC(y, mo, d, h, mi);
    if (typeof zone === 'number') return wall - zone * 60000;
    const t = wall - tzOffsetMin(zone, wall) * 60000;
    return wall - tzOffsetMin(zone, t) * 60000; // second pass lands on the right side of a DST change
}
// Names without a year: the year that puts the event nearest to now. With a weekday ("Sat 3 Feb") only years where
// the date falls on that day count, so a stale name from an older season ("2024 round 5 … Sat 3 Feb") reads as nothing.
function evNearestYear(mo, d, h, mi, zone, wday) {
    const now = Date.now(), y = new Date(now).getUTCFullYear();
    let best = NaN;
    for (const yy of [y - 1, y, y + 1]) {
        if (wday !== undefined && new Date(Date.UTC(yy, mo, d)).getUTCDay() !== wday) continue;
        const t = evWallToUtc(yy, mo, d, h, mi, zone);
        if (isNaN(best) || Math.abs(t - now) < Math.abs(best - now)) best = t;
    }
    return best;
}
function ev12h(h, ampm) {
    if (!ampm || h > 12) return h;
    return /p/i.test(ampm) ? (h % 12) + 12 : h % 12;
}
// { start, stop, title, desc, tag: 'live' | 'next' | 'ended' | '' } or null
function parseEventName(ch) {
    const name = ch.name || '';
    if (!_RE_EV_PRE.test(name)) return null;
    const tm = _RE_EV_TAG.exec(name);
    const tag = tm ? (/^l/i.test(tm[1]) ? 'live' : /^n/i.test(tm[1]) ? 'next' : 'ended') : '';
    let start = NaN, stop = NaN, m;
    if ((m = _RE_EV_STARTSTOP.exec(name))) {
        start = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
        stop = Date.UTC(+m[6], m[7] - 1, +m[8], +m[9], +m[10]);
    } else if ((m = _RE_EV_PIPEDATE.exec(name))) {
        start = m[1] ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[7], +m[8]) : Date.UTC(+m[6], m[5] - 1, +m[4], +m[7], +m[8]);
    } else if ((m = _RE_EV_PAREN.exec(name))) {
        start = evWallToUtc(+m[1], m[2] - 1, +m[3], +m[4], +m[5], /^\s*AU\b/.test(name) ? 'Australia/Sydney' : 'America/New_York');
    } else if ((m = _RE_EV_DAY.exec(name))) {
        const after = (m[8] || '').toUpperCase(), before = (m[1] || '').toUpperCase();
        const zone = after in EV_ABBR ? EV_ABBR[after] : EV_ZONE[after] || EV_ZONE[before];
        if (zone === undefined) return null;
        start = evNearestYear(EV_MON[m[4].toLowerCase()], +m[3], ev12h(+m[5], m[7]), +m[6], zone, EV_WDAY[m[2].toLowerCase()]);
    } else if ((m = _RE_EV_AT.exec(name)) && /^(US|CA)\s*\|/i.test(ch.group || '')) {
        start = evNearestYear(EV_MON[m[1].toLowerCase()], +m[2], ev12h(+m[3], m[5]), +m[4], 'America/New_York');
    }
    if (!(start > 0) || Math.abs(start - Date.now()) > 400 * 86400000) return null;
    if (!(stop > start)) stop = start + EVENT_DEFAULT_MS;
    // Title: the name without the status word, the date part (and what follows it in that segment) and filler segments
    let rest = tm ? name.slice(tm[0].length) : name;
    const at = rest.indexOf(m[0]);
    const segs = [];
    let pos = 0;
    for (const seg of rest.split('|')) {
        const segStart = pos; pos += seg.length + 1;
        let t = seg;
        if (at >= segStart && at < pos) t = seg.slice(0, at - segStart).replace(/[\s/:@-]+$/, '');
        else if (at >= 0 && segStart > at) continue; // everything after the date is channel labelling
        t = t.trim();
        if (t && !_RE_EV_JUNKSEG.test(t)) segs.push(t);
    }
    if (segs.length > 1 && /^(?:[A-Z]{2}|[^:]{1,30}\s\d{1,3})$/.test(segs[0])) segs.shift(); // slot label: "CA", "National League 1"
    if (segs.length) segs[0] = segs[0].replace(_RE_EV_LABEL, '') || segs[0];
    const title = segs.length ? segs[0] : name;
    return { start, stop, title, desc: segs.slice(1).join(' · '), tag };
}
// Parsed once per channel object (names do not change; a playlist refresh brings new objects)
const _evCache = new WeakMap();
let _eventProgs = new Map(); // tvgId -> [programme] built from event names, the guide's fallback
function eventOf(ch) {
    let ev = _evCache.get(ch);
    if (ev === undefined) { ev = parseEventName(ch); _evCache.set(ch, ev); }
    return ev;
}
function buildEventProgs() {
    _eventProgs = new Map();
    for (const ch of channels) {
        const ev = eventOf(ch);
        if (ev && ch.tvgId && !_eventProgs.has(ch.tvgId)) _eventProgs.set(ch.tvgId, [{ start: ev.start, stop: ev.stop, title: ev.title, desc: ev.desc, fromName: true }]);
    }
}
// Programmes for a channel: its EPG when there is any, else the event read from its name
function epgProgsOf(tvgId) {
    const id = resolveEpgId(tvgId);
    const p = id ? epgData.get(id) : null;
    if (p && p.length) return p;
    return (tvgId && _eventProgs.get(tvgId)) || null;
}
function evFinished(ev, now) { return ev.tag === 'ended' || now >= ev.stop; }
// Order a group of event channels by start time (finished ones last, unparsed ones after them), optionally
// leaving out events finished over an hour ago. The playing channel always stays. Groups where fewer than half
// the names carry a time are left as listed.
function arrangeEventGroup(list) {
    const mode = settings.ppvEvents;
    if (mode === 'off' || list.length < 2) return list;
    let n = 0;
    for (const ch of list) if (eventOf(ch)) n++;
    if (n < list.length / 2) return list;
    const now = Date.now();
    const playing = currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
    const items = [];
    for (let i = 0; i < list.length; i++) {
        const ch = list[i], ev = eventOf(ch);
        const done = ev ? evFinished(ev, now) : false;
        if (mode === 'hide' && done && ch !== playing && now > (ev.tag === 'ended' ? Math.min(ev.start, ev.stop) : ev.stop) + EVENT_HIDE_AFTER_MS) continue;
        items.push({ ch, ev, i, rank: !ev ? 2 : done ? 1 : 0 });
    }
    items.sort((a, b) => a.rank - b.rank || (a.ev && b.ev ? a.ev.start - b.ev.start : 0) || a.i - b.i);
    return items.map(x => x.ch);
}

// ----- Previous channel, channel surfing, alternate sources, recent channels -----
// Red (or a long press on OK) flips between the two most recent channels
function swapToPreviousChannel() {
    if (lastChannelIndex < 0 || !channels[lastChannelIndex] || lastChannelIndex === currentChannelIndex) return false;
    const idx = lastChannelIndex;
    selectChannel(idx);
    moveCursorToChannel(channels[idx]);
    return true;
}
// Put the guide / list cursor on a channel after a selection that did not come from the cursor
function moveCursorToChannel(ch) {
    const fi = currentFilteredChannels.indexOf(ch);
    if (fi < 0) return;
    if (epgMode) { epgFocusedRowIdx = fi; epgFocusT = 0; updateEPGRowFocus(); }
    else { stdFocusIdx = fi; stdFocusZone = 'channels'; updateStdChannelFocus(); }
}
// Channel surfing in the live player: with the banner hidden, Up/Down step through the current list in the
// banner without tuning; OK tunes the previewed channel, Back (or the banner timing out) cancels. CH± still zap.
const surf = { active: false, idx: -1 }; // idx into currentFilteredChannels
function surfChannel() { return surf.active ? currentFilteredChannels[surf.idx] || null : null; }
function surfStep(dir) {
    const list = currentFilteredChannels;
    if (!list.length) return;
    if (!surf.active) {
        const cur = currentChannelIndex >= 0 ? list.indexOf(channels[currentChannelIndex]) : -1;
        surf.idx = cur < 0 ? 0 : cur;
        surf.active = true;
        document.getElementById('vodOsd').classList.add('surf');
    }
    surf.idx = (surf.idx + dir + list.length) % list.length;
    const ch = list[surf.idx];
    if (ch && ch.tvgId && !getCurrentProgramme(ch.tvgId)) queueEpgFetch([ch.tvgId], true);
    player.focus = 'bar';
    showVodOsd();
}
function surfCancel() {
    if (!surf.active) return;
    surf.active = false; surf.idx = -1;
    const osd = document.getElementById('vodOsd'); if (osd) osd.classList.remove('surf');
    const techEl = document.getElementById('vodOsdTech'); if (techEl) techEl.textContent = liveUms ? umsTechString(liveUms) : (liveEngine.tech || ''); // the hint line goes back to the codec line
}
function surfTune() {
    const ch = surfChannel();
    surfCancel();
    if (!ch) return;
    const idx = getChannelIndex(ch);
    if (idx < 0) return;
    if (idx === currentChannelIndex) { showVodOsd(); return; }
    selectChannel(idx);
    moveCursorToChannel(ch);
}
// Alternate sources: other entries of the same channel in the playlist (same tvg-id, or the same name once
// quality tags and punctuation are ignored). When a stream exhausts its reload budget the next source is tried.
const _RE_NAME_TAGS = /\b(u?hd|fhd|4k|sd|hevc|h\.?26[45]|raw|backup|vip|\d{3,4}p)\b/g;
const _RE_NAME_BRACKETS = /\([^)]*\)|\[[^\]]*\]/g;
const _RE_NON_ALNUM = /[^a-z0-9]+/g;
function normChannelName(name) {
    return String(name || '').toLowerCase().replace(_RE_NAME_BRACKETS, ' ').replace(_RE_NAME_TAGS, ' ').replace(_RE_NON_ALNUM, '');
}
const _altSources = new Map(); // channel index → [indices] (built on first need, reset with the channel list)
function alternateSources(idx) {
    if (_altSources.has(idx)) return _altSources.get(idx);
    const ch = channels[idx];
    const out = [];
    if (ch) {
        const id = (ch.tvgId || '').toLowerCase(), nm = normChannelName(ch.name);
        for (let i = 0; i < channels.length; i++) {
            if (i === idx) continue;
            const c = channels[i];
            if (c.url === ch.url) continue;
            if ((id && (c.tvgId || '').toLowerCase() === id) || (nm && normChannelName(c.name) === nm)) out.push(i);
        }
    }
    _altSources.set(idx, out);
    return out;
}
let _altOrigin = -1;          // the channel the user actually chose
let _altTried = new Set();    // indices already tried for it this time
let _selectingAlt = false;    // selectChannel() called by the fallback (not a user choice)
function tryAlternateSource(msg) {
    if (_altOrigin < 0 || vodMode !== 'live' || vodPlay.active) return false;
    const alts = alternateSources(_altOrigin);
    const next = alts.find(i => !_altTried.has(i) && channels[i]);
    if (next === undefined) return false;
    _altTried.add(next);
    const n = _altTried.size - 1, total = alts.length;
    showEPGToast(`${msg}. Trying alternate source ${n} of ${total}: ${channels[next].name}`, 'loading', 'Stream');
    hideEPGToast(4000);
    diagLog(`${channels[_altOrigin].name}: ${msg}; trying source ${n}/${total} (${channels[next].name})`);
    _selectingAlt = true;
    try { selectChannel(next); } finally { _selectingAlt = false; }
    return true;
}
// Recent channels (per playlist, most recent first)
const RECENT_MAX = 20;
function noteRecentChannel(ch) {
    if (!_activePlaylistKey || !ch || !ch.url) return;
    const ps = getPlaylistState(_activePlaylistKey);
    const list = (ps.recent || []).filter(r => r.url !== ch.url);
    list.unshift({ url: ch.url, tvgId: ch.tvgId || '' });
    ps.recent = list.slice(0, RECENT_MAX);
}
function recentChannels() {
    const ps = _activePlaylistKey ? getPlaylistState(_activePlaylistKey) : null;
    const out = [];
    for (const r of (ps && ps.recent) || []) {
        let i = _chanByUrl.get(r.url);
        if (i === undefined && r.tvgId) i = channels.findIndex(c => c.tvgId === r.tvgId);
        if (i !== undefined && i >= 0 && channels[i] && !out.includes(channels[i])) out.push(channels[i]);
    }
    return out;
}
// Favorites in the user's order (the Set keeps insertion order; Manage favorites rebuilds it)
function favoriteChannels() {
    const out = [];
    for (const id of favoriteIds) { const l = _chansByFavId.get(id); if (l) out.push(l[0]); } // a URL listed twice is still one favorite
    return out;
}

// ----- Direct channel number entry -----
// Digits on the remote (in Live, guide or channel list, and in the live player) type a provider channel
// number into an overlay; after 2 s without another digit (or at 5 digits) the channel is selected.
let _digitBuf = '';
let _digitTimer = null;
function digitOverlay() {
    let el = document.getElementById('chNumOverlay');
    if (!el) { el = document.createElement('div'); el.id = 'chNumOverlay'; el.className = 'ch-num-overlay hidden'; document.body.appendChild(el); }
    return el;
}
function showDigitOverlay(text, cls) {
    const el = digitOverlay();
    el.textContent = text;
    el.className = 'ch-num-overlay' + (cls ? ' ' + cls : '');
}
function hideDigitOverlay() { const el = document.getElementById('chNumOverlay'); if (el) el.className = 'ch-num-overlay hidden'; }
function digitKeyValue(e) {
    const kc = e.keyCode;
    if (kc >= 48 && kc <= 57) return kc - 48;
    if (kc >= 96 && kc <= 105) return kc - 96;
    if (/^\d$/.test(e.key || '')) return +e.key;
    return -1;
}
function digitEntryAllowed() {
    if (!mainApp || mainApp.style.display === 'none' || !channels.length) return false;
    if (confirmDialog && !confirmDialog.classList.contains('hidden')) return false;
    if (settingsOpen || catsOpen || diagOpen || vodPlay.active || vodMode !== 'live') return false;
    if (_isTextInput(document.activeElement)) return false;
    return !_chanByNum.size ? false : true;
}
function onDigitKey(d) {
    if (_digitTimer) clearTimeout(_digitTimer);
    _digitBuf = (_digitBuf + d).slice(0, 5);
    showDigitOverlay(_digitBuf, 'typing');
    if (_digitBuf.length >= 5) { commitDigits(); return; }
    _digitTimer = setTimeout(commitDigits, 2000);
}
function commitDigits() {
    if (_digitTimer) { clearTimeout(_digitTimer); _digitTimer = null; }
    const n = parseInt(_digitBuf, 10);
    _digitBuf = '';
    if (!(n > 0)) { hideDigitOverlay(); return; }
    const idx = _chanByNum.get(n);
    if (idx === undefined) {
        showDigitOverlay(`${n} · no such channel`, 'missing');
        setTimeout(() => { if (!_digitBuf) hideDigitOverlay(); }, 1500);
        return;
    }
    const ch = channels[idx];
    showDigitOverlay(`${n}  ${ch.name}`, 'found');
    setTimeout(() => { if (!_digitBuf) hideDigitOverlay(); }, 1500);
    selectChannel(idx);
    // Put the cursor on the channel where it is listed
    const fi = currentFilteredChannels.indexOf(ch);
    if (fi >= 0) {
        if (epgMode) { epgFocusedRowIdx = fi; epgFocusT = 0; updateEPGRowFocus(); }
        else { stdFocusIdx = fi; stdFocusZone = 'channels'; updateStdChannelFocus(); }
    }
    if (livePlayer.active) showVodOsd();
}
function getChannelIndex(ch) {
    const i = channelIndexMap.get(ch);
    return i !== undefined ? i : -1;
}

// Binary search: index of rightmost programme with start <= target, or -1
function _epgBinarySearch(progs, target) {
    let lo = 0, hi = progs.length - 1, result = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (progs[mid].start <= target) { result = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return result;
}

function parseXMLTVDate(str) {
    if (!str) return null;
    const m = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})/);
    if (!m) return null;
    const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const sign = m[7] === '+' ? 1 : -1;
    return utc - sign * ((+m[8]) * 60 + (+m[9])) * 60000;
}

function formatTimeHHMM(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function formatTime12(ts) {
    const d = new Date(ts);
    const h = d.getHours(), min = d.getMinutes();
    const h12 = h % 12 || 12;
    return `${h12}:${min.toString().padStart(2, '0')}${h >= 12 ? 'PM' : 'AM'}`;
}

// Clock format follows the user setting (12-hour default)
function formatClock(ts) {
    return settings.clock === '24' ? formatTimeHHMM(ts) : formatTime12(ts);
}

function formatDuration(totalMins) {
    if (totalMins < 60) return `${totalMins} min`;
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    return mins > 0 ? `${hrs}hr ${mins}min` : `${hrs}hr`;
}

function resolveEpgId(tvgId) {
    if (!tvgId) return null;
    if (epgData.has(tvgId)) return tvgId;
    return epgIdMap.get(tvgId.toLowerCase()) || null;
}
// XMLTV channels whose tvg-id matches nothing get their guide data by name: "BBC One HD" ↔ <display-name>BBC One</display-name>.
// A channel with a tvg-id is aliased in epgIdMap; one without gets the XMLTV id as its tvgId (its favorite key moves with it).
function applyEpgNameFallback(nameMap) {
    if (!nameMap || !nameMap.size || currentPlaylistType !== 'm3u') return 0;
    let n = 0;
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        if (resolveEpgId(ch.tvgId)) continue;
        const cid = nameMap.get(normChannelName(ch.name));
        if (!cid || !epgData.has(cid)) continue;
        if (ch.tvgId) epgIdMap.set(ch.tvgId.toLowerCase(), cid);
        else ch.tvgId = cid;
        n++;
    }
    if (n) buildChannelIndexMap(); // search cache and EPG lookups follow the new tvgIds
    return n;
}

function getCurrentProgramme(tvgId) {
    const progs = epgProgsOf(tvgId);
    if (!progs || !progs.length) return null;
    const now = Date.now();
    const idx = _epgBinarySearch(progs, now);
    if (idx === -1) return null;
    const p = progs[idx];
    return p.stop > now ? p : null;
}

function getNextProgramme(tvgId) {
    const progs = epgProgsOf(tvgId);
    if (!progs || !progs.length) return null;
    const now = Date.now();
    const idx = _epgBinarySearch(progs, now);
    const nextIdx = idx + 1;
    return nextIdx < progs.length ? progs[nextIdx] : null;
}

async function loadEPG(url) {
    if (epgLoading) return;
    epgLoading = true;
    if (_epgAbortController) _epgAbortController.abort();
    _epgAbortController = new AbortController();
    // Parse into fresh maps and swap them in on success, so a background
    // refresh never blanks the existing guide while it downloads.
    const newData = new Map();
    const newIdMap = new Map();
    const newNameMap = new Map(); // normalised <display-name> → channel id, for channels whose tvg-id matches nothing
    currentEpgUrl = url;

    const decoder = new TextDecoder('utf-8');
    // cursor tracks how far into `buffer` we've processed; we only slice the
    // string once per 64 KB consumed rather than once per element, which avoids
    // the O(n²) string-copy behaviour that exhausts memory on large feeds.
    let buffer = '';
    let cursor = 0;
    let programmeCount = 0;
    let bytesRead = 0;
    const now = Date.now();
    const windowStart = now - 120000;
    const windowEnd = now + 6 * 3600000; // 6h

    showEPGToast('Downloading EPG data …', 'loading');
    try {
        const response = await fetch(url, { signal: _epgAbortController.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytesRead += value.byteLength;
            // Hard abort: avoid OOM on feeds > 20 MB
            if (bytesRead > 20 * 1024 * 1024) { reader.cancel(); break; }

            // Drop already-processed portion before appending — one slice per chunk
            // instead of one slice per element.
            if (cursor > 65536) {
                buffer = buffer.slice(cursor);
                cursor = 0;
            }
            buffer += decoder.decode(value, { stream: true });

            // Extract complete <channel> elements (always before <programme> in XMLTV)
            let idx;
            while ((idx = buffer.indexOf('</channel>', cursor)) !== -1) {
                const s = buffer.lastIndexOf('<channel', idx);
                if (s !== -1 && s >= cursor) {
                    const xml = buffer.substring(s, idx + 10);
                    const idM = _RE_CHAN_ID.exec(xml);
                    const nmM = _RE_DISP_NAME.exec(xml);
                    if (idM) {
                        const cid = idM[1];
                        newIdMap.set(cid.toLowerCase(), cid);
                        if (nmM) {
                            newIdMap.set(nmM[1].toLowerCase().trim(), cid);
                            const nn = normChannelName(unescapeXml(nmM[1]));
                            if (nn && !newNameMap.has(nn)) newNameMap.set(nn, cid);
                        }
                    }
                }
                cursor = idx + 10;
            }

            // Extract complete <programme> elements
            while ((idx = buffer.indexOf('</programme>', cursor)) !== -1) {
                const s = buffer.lastIndexOf('<programme', idx);
                if (s !== -1 && s >= cursor) {
                    const xml = buffer.substring(s, idx + 12);
                    const chM = _RE_CHAN_ATTR.exec(xml);
                    const stM = _RE_START_ATTR.exec(xml);
                    const spM = _RE_STOP_ATTR.exec(xml);
                    const tiM = _RE_TITLE_TAG.exec(xml);
                    if (chM && stM) {
                        let pStart = parseXMLTVDate(stM[1]);
                        let pStop = spM ? parseXMLTVDate(spM[1]) : null;
                        if (pStart !== null && _epgShiftOn) { pStart = epgShiftTime(pStart); if (pStop !== null) pStop = epgShiftTime(pStop); }
                        if (pStart !== null && pStart <= windowEnd && (pStop === null || pStop >= windowStart)) {
                            const cid = chM[1];
                            if (!newData.has(cid)) {
                                newData.set(cid, []);
                                newIdMap.set(cid.toLowerCase(), cid);
                            }
                            newData.get(cid).push({ start: pStart, stop: pStop || 0, title: tiM ? unescapeXml(tiM[1].trim()) : '' });
                            programmeCount++;
                        }
                    }
                }
                cursor = idx + 12;

                // Yield inside the loop so GC can run between elements
                if (programmeCount > 0 && programmeCount % 128 === 0) {
                    const _progMsg = `${(bytesRead / 1048576).toFixed(1)} MB — ${programmeCount.toLocaleString()} programmes …`;
                    statusArea.innerText = `📅 EPG: ${_progMsg}`;
                    showEPGToast(_progMsg, 'loading');
                    await new Promise(r => setTimeout(r, 0));
                    // Re-trim after yield so resumed work starts on a small buffer
                    if (cursor > 65536) { buffer = buffer.slice(cursor); cursor = 0; }
                }
            }

            // Safety: if a single element is pathologically large, discard to cursor
            if (buffer.length - cursor > 1048576) {
                const trim = Math.max(buffer.lastIndexOf('<programme', buffer.length), buffer.lastIndexOf('<channel', buffer.length));
                if (trim > cursor) { buffer = buffer.slice(trim); cursor = 0; }
                else { buffer = buffer.slice(cursor); cursor = 0; }
            }
        }

        // Sort each channel's programme list chronologically for fast lookup
        for (const progs of newData.values()) {
            progs.sort((a, b) => a.start - b.start);
        }
        epgData = newData;
        epgIdMap = newIdMap;
        _epgLoadedAt = Date.now();
        const byName = applyEpgNameFallback(newNameMap);

        renderChannelList();
        updateNowNext();
        startEpgTick();
        perfMark('xmltv-ready');

        const mb = (bytesRead / 1048576).toFixed(1);
        const readyMsg = `${epgData.size.toLocaleString()} channels, ${programmeCount.toLocaleString()} programmes (${mb} MB)${byName ? `, ${byName.toLocaleString()} matched by name` : ''}`;
        statusArea.innerText = `📅 EPG ready — ${readyMsg}`;
        showEPGToast(readyMsg, 'success');
        hideEPGToast(3500);
        setTimeout(() => {
            if (currentChannelIndex >= 0) statusArea.innerText = `▶️ ${channels[currentChannelIndex].name}`;
        }, 4000);

    } catch (err) {
        statusArea.innerText = `⚠️ EPG failed: ${err.message}`;
        showEPGToast(err.message, 'error');
        hideEPGToast(7000);
        setTimeout(() => {
            if (currentChannelIndex >= 0) statusArea.innerText = `▶️ ${channels[currentChannelIndex].name}`;
        }, 3000);
    } finally {
        epgLoading = false;
        _epgAbortController = null;
        buffer = null;
    }
}

function updateNowNext() {
    const panel = document.getElementById('epgNowNext');
    if (!panel) return;
    if (currentChannelIndex < 0 || !channels[currentChannelIndex]) { panel.style.display = 'none'; return; }
    const ch = channels[currentChannelIndex];
    const nowProg = getCurrentProgramme(ch.tvgId);
    const nextProg = getNextProgramme(ch.tvgId);
    if (!nowProg && !nextProg) { panel.style.display = 'none'; return; }

    let html = '';
    if (nowProg) {
        const pct = (nowProg.stop && nowProg.stop > nowProg.start)
            ? Math.min(100, Math.max(0, (Date.now() - nowProg.start) / (nowProg.stop - nowProg.start) * 100))
            : 0;
        const timeStr = nowProg.stop
            ? formatClock(nowProg.start) + '–' + formatClock(nowProg.stop)
            : formatClock(nowProg.start);
        html += `<div class="epg-row epg-now"><span class="epg-badge">NOW</span><span class="epg-title">${escapeHtml(nowProg.title)}</span><span class="epg-time">${timeStr}</span></div>`;
        html += `<div class="epg-progress-bar"><div class="epg-progress-fill" style="width:${pct.toFixed(1)}%"></div></div>`;
    }
    if (nextProg) {
        html += `<div class="epg-row epg-next"><span class="epg-badge epg-badge-next">NEXT</span><span class="epg-title epg-title-next">${escapeHtml(nextProg.title)}</span><span class="epg-time">${formatClock(nextProg.start)}</span></div>`;
    }
    panel.innerHTML = html;
    panel.style.display = 'block';
}

// Virtual scrolling globals
let renderedItems = new Map();
let currentFilteredChannels = [];
let currentScrollListener = null;

// ----- Helper Functions -----
function updateStartStatus(message, isError = false, isSuccess = false, showProgress = false, progressPercent = 0) {
    startStatusMessage.innerHTML = '';
    if (isLoading && !isError && !isSuccess) {
        const spinner = document.createElement('div');
        spinner.className = 'start-status-spinner';
        startStatusMessage.appendChild(spinner);
        startStatusMessage.appendChild(document.createTextNode(` ${message}`));
        startStatusBar.classList.remove('start-status-error', 'start-status-success');
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
        startStatusBar.classList.remove('start-status-error', 'start-status-success');
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

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function (m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// ----- Streaming Parser (never hangs) -----
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
                const nameMatch = line.match(/#EXTINF:.*?,(.*)$/);
                const tvgIdMatch = line.match(/tvg-id=["']([^"']*)["']/i);
                const tvgLogoMatch = line.match(/tvg-logo=["']([^"']*)["']/i);
                const groupMatch = line.match(/group-title=["']([^"']*)["']/i);
                current = {
                    name: nameMatch ? nameMatch[1].trim() : "Unknown",
                    tvgId: tvgIdMatch ? tvgIdMatch[1] : '',
                    tvgLogo: tvgLogoMatch ? tvgLogoMatch[1] : '',
                    group: groupMatch ? groupMatch[1] : '',
                    url: ''
                };
            } else if (!line.startsWith('#') && current && (line.startsWith('http') || line.startsWith('https') || line.startsWith('//'))) {
                current.url = line.startsWith('//') ? 'https:' + line : line;
                channelsList.push(current);
                current = null;
            }
        }
        i = end;
        const percent = Math.min(100, Math.round((i / total) * 100));
        updateStartStatus(`Parsing: ${i.toLocaleString()} / ${total.toLocaleString()} lines (${channelsList.length.toLocaleString()} found)`, false, false, true, percent);
        await new Promise(r => setTimeout(r, 5));
    }
    return channelsList;
}

// ----- Local cache (IndexedDB) -----
// The parsed channel list and the lazily fetched EPG survive relaunches so the guide appears at once.
// A cached list is applied immediately and re-downloaded in the background when it is older than
// PLAYLIST_CACHE_MAX_AGE_MS (or on "Refresh playlist now" in Settings); a changed list is swapped in
// place (same channel keeps playing, same group stays). Cached EPG entries show straight away and are
// re-fetched as usual once their TTL has passed. Storage failures are silent: everything still works
// without the cache, only slower.
const CACHE_DB_NAME = 'iptvultra-cache';
const PLAYLIST_CACHE_MAX_AGE_MS = 6 * 3600000;
const EPG_PERSIST_MAX_AGE_MS = 24 * 3600000; // older entries are dropped instead of restored
let _cacheDbPromise = null;
let _playlistCacheAt = 0;     // when the applied channel list was fetched from the provider
let _playlistRefreshing = false;
let _m3uSource = null;        // { url, epgUrl } of the loaded M3U, for background refresh
function cacheDb() {
    if (_cacheDbPromise) return _cacheDbPromise;
    _cacheDbPromise = new Promise(res => {
        if (typeof indexedDB === 'undefined') return res(null);
        try {
            const req = indexedDB.open(CACHE_DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists');
                if (!db.objectStoreNames.contains('epg')) db.createObjectStore('epg');
            };
            req.onsuccess = () => res(req.result);
            req.onerror = () => res(null);
            req.onblocked = () => res(null);
        } catch (_) { res(null); }
    });
    return _cacheDbPromise;
}
function cacheGet(store, key) {
    return cacheDb().then(db => new Promise(res => {
        if (!db) return res(undefined);
        try { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }
        catch (_) { res(undefined); }
    }));
}
function cachePut(store, key, value) {
    return cacheDb().then(db => new Promise(res => {
        if (!db) return res(false);
        try { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key); tx.oncomplete = () => res(true); tx.onerror = () => res(false); tx.onabort = () => res(false); }
        catch (_) { res(false); }
    }));
}
// All entries whose key starts with prefix, as [{ k, v }]
function cacheGetPrefix(store, prefix) {
    return cacheDb().then(db => new Promise(res => {
        if (!db) return res([]);
        try {
            const out = [];
            const range = IDBKeyRange.bound(prefix, prefix + '￿');
            const cur = db.transaction(store).objectStore(store).openCursor(range);
            cur.onsuccess = () => { const c = cur.result; if (c) { out.push({ k: c.key, v: c.value }); c.continue(); } else res(out); };
            cur.onerror = () => res(out);
        } catch (_) { res([]); }
    }));
}
// EPG results are written in small batches (fetches complete in bursts) under "<playlistKey>|<tvgId>"
let _epgPersistBatch = new Map();
let _epgPersistTimer = null;
function epgPersist(tvgId, at, progs) {
    if (!_activePlaylistKey || _activePlaylistKey === 'm:demo') return;
    _epgPersistBatch.set(_activePlaylistKey + '|' + tvgId, { at, progs }); // full key now: the playlist may change before the flush
    if (!_epgPersistTimer) _epgPersistTimer = setTimeout(flushEpgPersist, 1500);
}
function flushEpgPersist() {
    _epgPersistTimer = null;
    const batch = _epgPersistBatch; _epgPersistBatch = new Map();
    if (!batch.size) return;
    cacheDb().then(db => {
        if (!db) return;
        try {
            const st = db.transaction('epg', 'readwrite').objectStore('epg');
            for (const [k, v] of batch) { if (v.progs && v.progs.length) st.put(v, k); else st.delete(k); }
        } catch (_) { /* cache unavailable */ }
    });
}
// Put cached EPG into the live maps for the playlist just applied and refresh whatever is on screen
async function epgRestoreFromCache(key) {
    const rows = await cacheGetPrefix('epg', key + '|');
    if (_activePlaylistKey !== key || !rows.length) return 0;
    const now = Date.now();
    let n = 0;
    for (const { k, v } of rows) {
        const tvgId = String(k).slice(key.length + 1);
        if (!tvgId || !v || !Array.isArray(v.progs) || !v.progs.length || now - v.at > EPG_PERSIST_MAX_AGE_MS) continue;
        if (_epgFetchMeta.has(tvgId) && _epgFetchMeta.get(tvgId).status === 'pending') continue; // a live fetch is already ahead of us
        epgData.set(tvgId, epgShiftProgs(v.progs, 1)); // cache holds provider time
        epgIdMap.set(tvgId.toLowerCase(), tvgId);
        _epgFetchMeta.set(tvgId, { at: v.at, status: 'done' }); // past its TTL it is simply re-fetched when visible
        _epgDirtyIds.add(tvgId);
        n++;
    }
    for (const k0 of epgData.keys()) { if (epgData.size <= EPG_CACHE_MAX) break; epgData.delete(k0); _epgFetchMeta.delete(k0); }
    if (n) flushEpgRowUpdates();
    return n;
}
// Cheap fingerprint of a channel list, to tell whether a refresh changed anything
function channelListSignature(list) {
    let h = 0;
    for (const c of list) {
        const s = c.url + '|' + c.name + '|' + c.group;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return list.length + ':' + h;
}
// Swap in a refreshed list without disturbing the user: same channel keeps playing, same group stays
function replaceChannelList(parsed) {
    const playingUrl = currentChannelIndex >= 0 && channels[currentChannelIndex] ? channels[currentChannelIndex].url : null;
    channels = parsed;
    buildChannelIndexMap();
    if (currentPlaylistType === 'xtream') {
        _xtStreamIdByTvgId = new Map();
        for (const ch of parsed) if (!_xtStreamIdByTvgId.has(ch.tvgId)) _xtStreamIdByTvgId.set(ch.tvgId, ch.streamId);
    }
    currentChannelIndex = playingUrl ? channels.findIndex(c => c.url === playingUrl) : -1;
    if (lastChannelIndex >= channels.length) lastChannelIndex = -1;
    extractGroups();
    validateCurrentGroup();
    refreshCurrentView();
    if (currentChannelIndex >= 0 && epgMode) updateEPGInfoPanel(channels[currentChannelIndex]);
}
// Re-download the loaded playlist and apply it in place if it changed. force=false respects the 6 h age.
async function refreshPlaylistInBackground(force) {
    if (_playlistRefreshing || isLoading || !_activePlaylistKey || _activePlaylistKey === 'm:demo') return false;
    if (!force && _playlistCacheAt && Date.now() - _playlistCacheAt < PLAYLIST_CACHE_MAX_AGE_MS) return false;
    _playlistRefreshing = true;
    const key = _activePlaylistKey;
    try {
        let parsed;
        if (currentPlaylistType === 'xtream' && _xt) parsed = await xtreamFetchChannels(_xt.base, _xt.user, _xt.pass, null);
        else if (_m3uSource) { const resp = await fetch(_m3uSource.url); if (!resp.ok) throw new Error(`HTTP ${resp.status}`); parsed = await parseM3UStreaming(await resp.text()); }
        if (_activePlaylistKey !== key || !parsed || !parsed.length) return false;
        const changed = channelListSignature(parsed) !== channelListSignature(channels);
        _playlistCacheAt = Date.now();
        cachePut('playlists', key, { at: _playlistCacheAt, type: currentPlaylistType, channels: parsed, tz: _xt ? _xt.tz : undefined, epgOffsetMin: _xt ? _xt.epgOffsetMin : undefined });
        if (changed) {
            const delta = parsed.length - channels.length;
            replaceChannelList(parsed);
            showEPGToast(`Playlist updated: ${channels.length.toLocaleString()} channels (${delta >= 0 ? '+' : ''}${delta})`, 'success', 'Playlist');
            hideEPGToast(4000);
        } else if (force) { showEPGToast('Playlist is up to date', 'success', 'Playlist'); hideEPGToast(2500); }
        return changed;
    } catch (e) {
        if (force) { showEPGToast(`Playlist refresh failed: ${e.message}`, 'error', 'Playlist'); hideEPGToast(5000); }
        return false;
    } finally { _playlistRefreshing = false; }
}
function fmtAge(ts) {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// ----- Loading playlists -----
// Everything after a channel list is available (parsed fresh or read from the cache)
function applyM3UChannels(parsed, url, epgUrl, fromCache) {
    channels = parsed;
    buildChannelIndexMap();
    localStorage.setItem('last_m3u_url', url);
    updateStartStatus(`Loaded ${channels.length.toLocaleString()} channels${fromCache ? ' (cached)' : ''}!`, false, true, false, 100);
    currentSearchQuery = '';
    searchInput.value = '';
    _activePlaylistKey = 'm:' + url;
    epgOffsetLoad();
    favoritesLoad();
    _m3uSource = { url, epgUrl };
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
    if (channels.length) setTimeout(selectInitialChannel, 500);
    // Start EPG load in background after playlist is ready
    if (epgUrl) setTimeout(() => loadEPG(epgUrl), 1500);
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
        const response = await fetch(url, { signal: _m3uAbortController.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let content = await response.text();
        updateStartStatus(`Downloaded ${(content.length / 1024 / 1024).toFixed(1)} MB, parsing...`, false, false, true, 20);
        const parsed = await parseM3UStreaming(content);
        content = null; // free memory
        if (!parsed.length) throw new Error('No channels found');
        applyM3UChannels(parsed, url, epgUrl, false);
        _playlistCacheAt = Date.now();
        cachePut('playlists', key, { at: _playlistCacheAt, type: 'm3u', channels: parsed });
    } catch (err) {
        if (err.name !== 'AbortError') {
            updateStartStatus(`Error: ${err.message}`, true, false, false, 0);
            setLoadSelectedButtonEnabled(true);
        }
    } finally {
        isLoading = false;
        _m3uAbortController = null;
        showLoading(false);
        setTimeout(() => { if (!startPage.classList.contains('hidden')) updateStartStatus('Ready', false, false, false, 0); }, 3000);
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
        updateStartStatus(`Demo loaded: ${channels.length} channels`, false, true, false, 100);
        currentSearchQuery = '';
        searchInput.value = '';
        _activePlaylistKey = 'm:demo'; // not remembered for auto-load
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

// ----- Groups & Channels -----
// Categories hidden by the user for this playlist (also dropped from All Channels and search)
let _hiddenGroups = new Set();
let _groupOrder = [];   // user order for this playlist; groups not listed follow alphabetically
function allGroupNames() {
    const groups = new Set();
    for (const ch of channels) if (ch.group && ch.group.trim()) groups.add(ch.group.trim());
    return Array.from(groups);
}
function sortGroupNames(names) {
    const pos = new Map(_groupOrder.map((g, i) => [g, i]));
    return names.sort((a, b) => {
        const pa = pos.has(a) ? pos.get(a) : Infinity, pb = pos.has(b) ? pos.get(b) : Infinity;
        if (pa !== pb) return pa - pb;
        return a.localeCompare(b);
    });
}
function extractGroups() {
    const ps = _activePlaylistKey ? getPlaylistState(_activePlaylistKey) : null;
    _hiddenGroups = new Set((ps && ps.hiddenGroups) || []);
    _groupOrder = (ps && ps.groupOrder) || [];
    groupsList = ['favorites', 'all', 'recent'].concat(sortGroupNames(allGroupNames().filter(g => !_hiddenGroups.has(g))));
    renderGroupsList();
}
const PINNED_GROUPS = ['favorites', 'all', 'recent'];

// ----- Categories manager (hide / reorder, per playlist) and Favorites manager (reorder / remove) -----
// The same overlay serves both: `catsMode` is 'cats' (group names) or 'favs' (favorite ids in the user's order)
let catsOpen = false, catsFocus = 0, _catsNames = [], catsMode = 'cats';
function openCatsManager(mode) {
    catsMode = mode === 'favs' ? 'favs' : 'cats';
    if (!_activePlaylistKey || (catsMode === 'cats' && _activePlaylistKey === 'm:demo')) return;
    const ov = document.getElementById('catsOverlay'); if (!ov) return;
    if (catsMode === 'favs') {
        _catsNames = [...favoriteIds].filter(id => _chansByFavId.has(id)); // favorites present in this playlist
        if (!_catsNames.length) return;
        catsFocus = 0;
    } else {
        _catsNames = sortGroupNames(allGroupNames());
        catsFocus = Math.max(0, _catsNames.indexOf(currentGroup));
    }
    const title = ov.querySelector('.settings-title'); if (title) title.textContent = catsMode === 'favs' ? '⭐ Manage favorites' : '📁 Manage categories';
    const hint = ov.querySelector('.settings-hint'); if (hint) hint.textContent = catsMode === 'favs' ? 'OK remove / restore · ◀ ▶ or Red / Green move · Back close' : 'OK hide / show · ◀ ▶ or Red / Green move · Back close';
    catsOpen = true;
    if (settingsOpen) closeSettings();
    ov.classList.remove('hidden');
    renderCats();
}
function closeCatsManager() {
    if (!catsOpen) return;
    catsOpen = false;
    const ov = document.getElementById('catsOverlay'); if (ov) ov.classList.add('hidden');
    const list = document.getElementById('catsList'); if (list) list.innerHTML = ''; // rows share .settings-row; leave none behind
    if (catsMode === 'favs') { refreshCurrentView(); return; } // favorites were saved as they changed
    // Apply once on close: group list, All Channels and search all follow the new state
    extractGroups();
    validateCurrentGroup();
    refreshCurrentView();
}
function catsFavLabel(id) {
    const l = _chansByFavId.get(id) || [];
    return l.length ? (l.length > 1 ? `${l[0].name} (+${l.length - 1})` : l[0].name) : id;
}
function saveCatsState() {
    if (!_activePlaylistKey) return;
    const ps = getPlaylistState(_activePlaylistKey);
    ps.hiddenGroups = [..._hiddenGroups];
    ps.groupOrder = _groupOrder.slice();
    savePlaylistState();
}
function renderCats() {
    const list = document.getElementById('catsList'); if (!list) return;
    list.innerHTML = '';
    const favs = catsMode === 'favs';
    _catsNames.forEach((g, i) => {
        const row = document.createElement('div');
        const off = favs ? !favoriteIds.has(g) : _hiddenGroups.has(g);
        row.className = 'settings-row cats-row' + (off ? ' cats-hidden' : '') + (i === catsFocus ? ' focused' : '');
        row.dataset.idx = i;
        const label = favs ? catsFavLabel(g) : g;
        const state = favs ? (off ? '✕ Removed' : '★ Favorite') : (off ? '🚫 Hidden' : '👁 Shown');
        row.innerHTML = `<div class="settings-label"><div class="settings-name">${escapeHtml(label)}</div></div><div class="settings-value"><span class="settings-val">${state}</span></div>`;
        row.addEventListener('click', () => { catsFocus = i; catsToggleHidden(); });
        list.appendChild(row);
    });
    const f = list.querySelector('.cats-row.focused'); if (f) f.scrollIntoView({ block: 'nearest' });
}
// Favorites belong to the playlist they were starred in (playlist state `favs`, in the user's order)
function saveFavorites() {
    if (!_activePlaylistKey) return;
    getPlaylistState(_activePlaylistKey).favs = [...favoriteIds];
    savePlaylistState();
}
// Providers write quality tags in superscript ("ᵁᴴᴰ ³⁸⁴⁰ᴾ", "⁴ᵏ", "⁸ᴷ", "ᶠᴴᴰ"). Each run of superscript characters
// becomes its own plain word ("uhd 3840p"), split where letters meet digits so word boundaries still find the tag.
const SUPER_MAP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁽': '(', '⁾': ')',
    'ᴬ': 'a', 'ᴮ': 'b', 'ᴰ': 'd', 'ᴱ': 'e', 'ᴳ': 'g', 'ᴴ': 'h', 'ᴵ': 'i', 'ᴶ': 'j', 'ᴷ': 'k', 'ᴸ': 'l', 'ᴹ': 'm', 'ᴺ': 'n', 'ᴼ': 'o', 'ᴾ': 'p',
    'ᴿ': 'r', 'ᵀ': 't', 'ᵁ': 'u', 'ⱽ': 'v', 'ᵂ': 'w', 'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ⁱ': 'i',
    'ʲ': 'j', 'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm', 'ⁿ': 'n', 'ᵒ': 'o', 'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's', 'ᵗ': 't', 'ᵘ': 'u', 'ᵛ': 'v', 'ʷ': 'w', 'ˣ': 'x',
    'ʸ': 'y', 'ᶻ': 'z' };
const _RE_SUPER_RUN = new RegExp('[' + Object.keys(SUPER_MAP).join('') + ']+', 'g');
function unsuperscript(s) {
    return String(s || '').replace(_RE_SUPER_RUN, run => ' ' + Array.from(run, c => SUPER_MAP[c]).join('').replace(/([a-z])(\d)/g, '$1 $2') + ' ');
}
// Quality from the channel name, for choosing among variants: 8K > 4K/UHD > FHD/1080 > HD/720 > untagged > SD/576/480/360
function nameQualityRank(name) {
    const n = unsuperscript(name).toLowerCase();
    if (/\b(8k|4320p?)\b/.test(n)) return 6;
    if (/\b(4k|uhd|2160p?|3840p?)\b/.test(n)) return 5;
    if (/\b(fhd|1080[pi]?)\b/.test(n)) return 4;
    if (/\b(hd|720p?)\b/.test(n)) return 3;
    if (/\b(sd|576[pi]?|480[pi]?|360p?)\b/.test(n)) return 1;
    return 2;
}
// Applied playlist: load its favorites. The first time, favorites saved globally by tvg-id (before 3.12) are
// converted: each becomes the best-quality channel among those sharing that tvg-id (first listed on a tie).
function favoritesLoad() {
    const ps = _activePlaylistKey ? getPlaylistState(_activePlaylistKey) : null;
    if (!ps) { favoriteIds = new Set(); return; }
    if (Array.isArray(ps.favs)) { favoriteIds = new Set(ps.favs); return; }
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem('iptv_favorites') || '[]') || []; } catch (_) { legacy = []; }
    const byTvg = new Map();
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        if (!ch.tvgId) continue;
        const best = byTvg.get(ch.tvgId);
        if (best === undefined || nameQualityRank(ch.name) > nameQualityRank(channels[best].name)) byTvg.set(ch.tvgId, i);
    }
    const out = [];
    for (const id of legacy) {
        const m = /^idx_(\d+)$/.exec(String(id));
        const i = m ? +m[1] : byTvg.get(id);
        if (i !== undefined && channels[i]) out.push(favIdOf(channels[i], i));
    }
    favoriteIds = new Set(out);
    saveFavorites();
    if (out.length) diagLog(`Favorites: ${out.length} of ${legacy.length} saved favorites matched this playlist (best-quality variant kept)`);
}
function catsToggleHidden() {
    const g = _catsNames[catsFocus]; if (!g) return;
    if (catsMode === 'favs') {
        // Removed favorites stay listed (struck through) until the manager closes, so OK again restores them in place
        if (favoriteIds.has(g)) favoriteIds.delete(g); else catsRebuildFavOrder();
        saveFavorites();
        renderCats();
        return;
    }
    if (_hiddenGroups.has(g)) _hiddenGroups.delete(g); else _hiddenGroups.add(g);
    saveCatsState();
    renderCats();
}
// favoriteIds in the manager's order (kept ones only), followed by favorites that belong to other playlists
function catsRebuildFavOrder() {
    const shown = new Set(_catsNames);
    const removed = new Set(_catsNames.filter(id => !favoriteIds.has(id)));
    const rest = [...favoriteIds].filter(id => !shown.has(id));
    favoriteIds = new Set(_catsNames.filter(id => !removed.has(id) || id === _catsNames[catsFocus]).concat(rest));
}
function catsMove(dir) {
    const i = catsFocus, j = i + dir;
    if (j < 0 || j >= _catsNames.length) return;
    [_catsNames[i], _catsNames[j]] = [_catsNames[j], _catsNames[i]];
    catsFocus = j;
    if (catsMode === 'favs') {
        const removed = new Set(_catsNames.filter(id => !favoriteIds.has(id)));
        const rest = [...favoriteIds].filter(id => !_catsNames.includes(id));
        favoriteIds = new Set(_catsNames.filter(id => !removed.has(id)).concat(rest));
        saveFavorites();
    } else {
        _groupOrder = _catsNames.slice(); // the full explicit order from now on
        saveCatsState();
    }
    renderCats();
}
function handleCatsKey(e) {
    const k = e.key, kc = e.keyCode;
    if (k === 'ArrowUp' || kc === 38) { e.preventDefault(); catsFocus = Math.max(0, catsFocus - 1); renderCats(); }
    else if (k === 'ArrowDown' || kc === 40) { e.preventDefault(); catsFocus = Math.min(_catsNames.length - 1, catsFocus + 1); renderCats(); }
    else if (k === 'Enter' || kc === 13) { e.preventDefault(); catsToggleHidden(); }
    else if (kc === 403 || k === 'ColorF0Red' || k === 'ArrowLeft' || kc === 37) { e.preventDefault(); catsMove(-1); }
    else if (kc === 404 || k === 'ColorF1Green' || k === 'ArrowRight' || kc === 39) { e.preventDefault(); catsMove(1); }
}

function renderGroupsList() {
    if (vodMode !== 'live') { renderVodCats(); return; }
    const hdrSpan = document.querySelector('.groups-header span');
    if (hdrSpan && hdrSpan.textContent !== '📁 Groups') hdrSpan.textContent = '📁 Groups';
    const pinnedDiv = document.getElementById('groupsPinned');
    groupsListDiv.innerHTML = '';
    if (pinnedDiv) pinnedDiv.innerHTML = '';
    for (const group of groupsList) {
        const div = document.createElement('div');
        div.className = 'group-item' + (currentGroup === group ? ' active' : '');
        let folderIcon = '📁';
        let displayName = group;
        if (group === 'favorites') {
            folderIcon = '⭐';
            displayName = 'Favorites';
        } else if (group === 'all') {
            folderIcon = '📺';
            displayName = 'All Channels';
        } else if (group === 'recent') {
            folderIcon = '🕒';
            displayName = 'Recent';
        } else {
            folderIcon = '📁';
            displayName = escapeHtml(group);
        }
        if (currentSearchQuery && !PINNED_GROUPS.includes(group) && group.toLowerCase().includes(currentSearchQuery.toLowerCase())) {
            displayName = highlightText(displayName, currentSearchQuery);
        }
        div.innerHTML = `<span class="group-folder">${folderIcon}</span><span>${displayName}</span>`;
        div.onclick = () => {
            currentGroup = group;
            stdGroupFocusIdx = Math.max(0, groupsList.indexOf(group));
            if (_activePlaylistKey) { getPlaylistState(_activePlaylistKey).lastGroup = group; savePlaylistState(); }
            if (currentSearchQuery) { currentSearchQuery = ''; searchInput.value = ''; }
            renderGroupsList();
            requestAnimationFrame(refreshCurrentView);
        };
        if (PINNED_GROUPS.includes(group) && pinnedDiv) {
            pinnedDiv.appendChild(div);
        } else {
            groupsListDiv.appendChild(div);
        }
    }
    if (currentPlaylistType === 'm3u') updateStdGroupFocus(false);
}

function highlightText(text, query) {
    if (!query) return text;
    const terms = query.toLowerCase().split(/\s+/);
    let result = text;
    for (const term of terms) {
        if (term.length < 2) continue;
        const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        result = result.replace(regex, '<span class="search-match-highlight">$1</span>');
    }
    return result;
}

function searchChannels(query) {
    if (!query.trim()) return [...channels];
    if (_searchCache.query === query) return _searchCache.result;
    const terms = query.toLowerCase().split(/\s+/);
    // Matches channel names and groups, and also what is on now: a programme title match (from the EPG
    // already loaded, lazily per channel) ranks just below a name match. Hidden categories are excluded.
    const q = query.toLowerCase();
    const scored = channels.map((ch, idx) => {
        if (_hiddenGroups.size && _hiddenGroups.has(ch.group)) return { idx, score: 0 };
        let score = 0;
        const nameLower = ch.name.toLowerCase();
        const groupLower = (ch.group || '').toLowerCase();
        if (nameLower === q) score = 100;
        else if (nameLower.startsWith(q)) score = 90;
        else {
            let matched = 0;
            for (const t of terms) {
                if (nameLower.includes(t)) matched++;
                if (groupLower.includes(t)) matched += 0.5;
            }
            score = Math.min(80, (matched / terms.length) * 60);
        }
        if (score < 85) {
            const p = getCurrentProgramme(ch.tvgId);
            if (p) {
                const tl = p.title.toLowerCase();
                let m = 0;
                for (const t of terms) if (tl.includes(t)) m++;
                if (m === terms.length) score = Math.max(score, tl === q ? 88 : 85);
                else if (m) score = Math.max(score, 40 * m / terms.length);
            }
        }
        return { idx, score };
    });
    const result = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => channels[s.idx]);
    _searchCache = { query, result };
    return result;
}

// ----- Virtual Scrolling Channel List -----
function renderChannelList() {
    // Update channels header title
    const headerTitle = document.getElementById('channelsHeaderTitle');
    if (headerTitle) {
        let title;
        if (!channels.length || !groupsList.length) {
            title = '📡 Channels';
        } else if (currentSearchQuery && currentSearchQuery.trim()) {
            title = '🔍 Search Results';
        } else if (currentGroup === 'favorites') {
            title = '⭐ Favorites';
        } else if (currentGroup === 'recent') {
            title = '🕒 Recent';
        } else if (currentGroup === 'all') {
            title = '📺 All Channels';
        } else {
            title = '📁 ' + currentGroup;
        }
        headerTitle.textContent = title;
    }

    // Determine filtered channels
    let filtered = [];
    if (currentSearchQuery && currentSearchQuery.trim()) {
        filtered = searchChannels(currentSearchQuery);
    } else if (currentGroup === 'favorites') {
        filtered = favoriteChannels();
    } else if (currentGroup === 'recent') {
        filtered = recentChannels();
    } else if (currentGroup === 'all') {
        filtered = _hiddenGroups.size ? channels.filter(ch => !_hiddenGroups.has(ch.group)) : [...channels];
    } else {
        filtered = arrangeEventGroup(channels.filter(ch => ch.group === currentGroup));
    }
    currentFilteredChannels = filtered;
    if (stdFocusIdx >= filtered.length) stdFocusIdx = Math.max(0, filtered.length - 1);
    if (currentPlaylistType === 'xtream') return;
    const total = filtered.length;
    const info = currentSearchQuery ? ` (search: "${currentSearchQuery}")` : '';
    channelCountSpan.innerText = `${total} channels${info}`;

    // Remove old scroll listener and drop the row cache before any early return,
    // so an empty group never leaves stale (detached) rows behind
    if (currentScrollListener) {
        channelListDiv.removeEventListener('scroll', currentScrollListener);
        currentScrollListener = null;
    }
    renderedItems.clear();
    _stdRenderVisible = null;
    if (!total) {
        channelListDiv.innerHTML = `<div style="padding:24px;text-align:center;">📭 No channels found</div>`;
        return;
    }

    // Row height depends on whether EPG data is available
    const ITEM_H = epgData.size > 0 ? CH_ITEM_H_EPG : CH_ITEM_H;
    const ITEM_INNER = ITEM_H - 2;
    _stdItemH = ITEM_H;

    // Setup virtual container (preserve scroll position across re-renders)
    const savedScrollTop = channelListDiv.scrollTop;
    channelListDiv.innerHTML = '';
    channelListDiv.style.position = 'relative';
    const virtualContainer = document.createElement('div');
    virtualContainer.className = 'channel-list-virtual';
    virtualContainer.style.height = `${total * ITEM_H}px`;
    channelListDiv.appendChild(virtualContainer);

    // Function to render visible items
    const renderVisible = () => {
        const scrollTop = channelListDiv.scrollTop;
        const containerHeight = channelListDiv.clientHeight;
        const startIdx = Math.floor(scrollTop / ITEM_H);
        const endIdx = Math.min(total - 1, startIdx + Math.ceil(containerHeight / ITEM_H) + 2);
        // Remove items outside viewport
        for (let [idx, el] of renderedItems) {
            if (idx < startIdx || idx > endIdx) {
                el.remove();
                renderedItems.delete(idx);
            }
        }
        // Add missing items
        for (let i = startIdx; i <= endIdx; i++) {
            if (renderedItems.has(i)) continue;
            const ch = filtered[i];
            const originalIndex = getChannelIndex(ch);
            const fav = favoriteIds.has(favIdOf(ch, originalIndex));
            const div = document.createElement('div');
            div.className = 'virtual-item' + (currentChannelIndex === originalIndex ? ' active' : '') +
                (stdFocusZone === 'channels' && i === stdFocusIdx ? ' focused' : '');
            div.style.top = `${i * ITEM_H}px`;
            div.style.height = `${ITEM_INNER}px`;
            // Build logo HTML
            let logoHtml = '';
            if (ch.tvgLogo && ch.tvgLogo.trim()) {
                logoHtml = `
                    <img class="logo-img" src="${escapeHtml(ch.tvgLogo)}" loading="lazy" onerror="this.style.display='none'" onload="this.nextElementSibling.style.display='none'">
                    <div class="logo-placeholder">📺</div>
                `;
            } else {
                logoHtml = `<div class="logo-placeholder">📺</div>`;
            }
            // EPG "now playing" line
            const nowProg = getCurrentProgramme(ch.tvgId);
            const epgLine = nowProg
                ? `<span class="channel-epg">${escapeHtml(nowProg.title.length > 36 ? nowProg.title.substring(0, 34) + '…' : nowProg.title)}</span>`
                : (epgData.size > 0 ? '<span class="channel-epg"></span>' : '');
            div.innerHTML = `
                <div class="channel-logo">
                    <span class="channel-num">${originalIndex + 1}</span>
                    <div class="channel-logo-img">${logoHtml}</div>
                </div>
                <div class="channel-info"><span class="channel-name">${escapeHtml(ch.name.length > 40 ? ch.name.substring(0, 37) + '...' : ch.name)}</span>${epgLine}</div>
                <span class="favorite-star">${fav ? '★' : '☆'}</span>
            `;
            const starSpan = div.querySelector('.favorite-star');
            starSpan.onclick = (e) => {
                e.stopPropagation();
                const id = favIdOf(ch, originalIndex);
                if (favoriteIds.has(id)) favoriteIds.delete(id);
                else favoriteIds.add(id);
                saveFavorites();
                if (currentGroup === 'favorites' && !currentSearchQuery) renderChannelList(); // list membership changed
                else starSpan.textContent = favoriteIds.has(id) ? '★' : '☆';          // otherwise update in place
            };
            div.onclick = () => selectChannel(originalIndex);
            virtualContainer.appendChild(div);
            renderedItems.set(i, div);
        }
    };

    const onScroll = () => { requestAnimationFrame(renderVisible); };
    channelListDiv.addEventListener('scroll', onScroll);
    currentScrollListener = onScroll;
    _stdRenderVisible = renderVisible;
    channelListDiv.scrollTop = savedScrollTop;
    renderVisible();
}

// ----- Stall Watchdog -----
function startStallWatchdog() {
    stopStallWatchdog();
    stallLastTime = -1;
    stallCount = 0;
    _stallGoodChecks = 0;
    stallWatchdogTimer = setInterval(function () {
        if (videoPlayer.paused || currentChannelIndex < 0) { stallCount = 0; return; }
        const t = videoPlayer.currentTime;
        if (t === stallLastTime && videoPlayer.readyState < 3) {
            stallCount++;
            _stallGoodChecks = 0;
            if (stallCount >= STALL_THRESHOLD_CHECKS) {
                stallCount = 0;
                stallLastTime = -1;
                noteStreamFail(liveEngineActive() ? 'hls.js' : 'native', `No progress for ${STALL_THRESHOLD_CHECKS * 2} s (readyState ${videoPlayer.readyState}, t=${t.toFixed(1)} s)`, '');
                if (_reloadAttempts >= MAX_AUTO_RELOADS) {
                    // Budget exhausted: try another source of the same channel, else stop hammering it and tell the user
                    stopStallWatchdog();
                    if (!tryAlternateSource('Stream not responding')) showStreamError('Stream not responding');
                    return;
                }
                _reloadAttempts++;
                reloadStream(true);
            }
        } else {
            stallCount = 0;
            stallLastTime = t;
            // ~30 s of steady playback restores the auto-reload budget
            if (++_stallGoodChecks >= 15) _reloadAttempts = 0;
        }
    }, STALL_CHECK_INTERVAL_MS);
}

function stopStallWatchdog() {
    if (stallWatchdogTimer) { clearInterval(stallWatchdogTimer); stallWatchdogTimer = null; }
}

function showStreamError(msg) {
    const name = (currentChannelIndex >= 0 && channels[currentChannelIndex]) ? channels[currentChannelIndex].name : '';
    const tried = _altTried.size > 1 ? ` (${_altTried.size} sources tried)` : '';
    const acct = accountProblemText(_consInfo);
    statusArea.innerText = `⚠️ ${acct || msg}`;
    channelInfoTag.innerText = `⚠️ ${name ? name + ' — ' : ''}${acct || msg}`;
    if (acct) showEPGToast(`${acct}. Stop playback on the other device, then press Reload.`, 'error', 'Connection limit');
    else showEPGToast(`${name ? name + ': ' : ''}${msg}${tried}. Press Reload to retry.`, 'error', 'Stream Error');
    hideEPGToast(7000);
    diagLog(`Stream error: ${name}: ${msg}${tried}${acct ? ' · ' + acct : ''}`);
}

// Enter on the already-playing row (or a click on the live picture): open the app-owned player
function toggleVideoFullscreen() {
    if (livePlayer.active) { exitLivePlayer(); return; }
    if (currentChannelIndex < 0 || vodPlay.active) return;
    enterLivePlayer();
}
function enterLivePlayer() {
    if (livePlayer.active || vodPlay.active || currentChannelIndex < 0) return;
    livePlayer.active = true;
    // Do NOT move the <video>: re-parenting destroys the webOS media pipeline (verified on the C4:
    // currentTime resets to 0, mediaId empties, picture never returns). The element stays where it
    // is and body.live-player stretches it to the viewport underneath the transparent player overlay.
    const playerEl = document.getElementById('vodPlayer');
    document.body.classList.add('live-player');
    playerEl.classList.add('live');
    const badge = document.getElementById('pbTrickBadge'); if (badge && badge.parentNode !== playerEl) playerEl.appendChild(badge);
    playerEl.classList.remove('hidden');
    document.getElementById('vodPaused').classList.toggle('hidden', !videoPlayer.paused);
    document.getElementById('vodLoading').classList.add('hidden');
    document.getElementById('vodNext').classList.add('hidden');
    player.focus = 'bar'; player.btn = 0; player.btns = [];
    const techEl = document.getElementById('vodOsdTech'); if (techEl) techEl.textContent = liveUms ? umsTechString(liveUms) : liveEngine.tech;
    updateVodTracksHint();
    showVodOsd();
}
function exitLivePlayer() {
    if (!livePlayer.active) return;
    closeVodTracks();
    hideVodOsd();
    if (_isHolding()) _stopHold();
    _holdKeyDir = null;
    livePlayer.active = false;
    document.getElementById('vodPlayer').classList.add('hidden');
    document.getElementById('vodPlayer').classList.remove('live');
    document.body.classList.remove('live-player');
    restoreLiveVideoSlot();
    // Put the cursor on the playing channel so the next key press continues from it
    if (currentChannelIndex >= 0) {
        if (epgMode) { const fi = currentFilteredChannels.indexOf(channels[currentChannelIndex]); if (fi >= 0) { epgFocusedRowIdx = fi; updateEPGRowFocus(); } }
        else { const fi = currentFilteredChannels.indexOf(channels[currentChannelIndex]); if (fi >= 0) { stdFocusIdx = fi; stdFocusZone = 'channels'; updateStdChannelFocus(); } }
    }
}
function toggleLivePause() {
    if (videoPlayer.paused) videoPlayer.play().catch(() => {}); else videoPlayer.pause();
    document.getElementById('vodPaused').classList.toggle('hidden', !videoPlayer.paused);
    showVodOsd();
}

// ----- Video Control -----
function selectChannel(index) {
    if (!channels[index]) return;
    if (vodPlay.active) stopVodPlayback(false);
    stopStallWatchdog();
    catchup = null; // any channel selection returns to live
    surfCancel();
    if (_selectingAlt) {
        // fallback to another source of the same channel: not a channel change for history purposes
    } else {
        if (currentChannelIndex >= 0 && currentChannelIndex !== index) lastChannelIndex = _altOrigin >= 0 && channels[_altOrigin] ? _altOrigin : currentChannelIndex;
        _altOrigin = index; _altTried = new Set([index]);
        noteRecentChannel(channels[index]);
    }
    currentChannelIndex = index;
    _reloadAttempts = 0;
    if (_errRetryTimer) { clearTimeout(_errRetryTimer); _errRetryTimer = null; }
    const ch = channels[index];
    videoPlayer.pause();
    umsNoteCurrentId();
    if (loadLiveSource(ch.url)) { umsRelease(liveUms); liveUms = null; } else liveUmsRefresh();
    videoPlayer.play().catch(e => console.log);
    startStallWatchdog();
    channelInfoTag.innerText = `📺 ${ch.name}`;
    channelInfoTag.style.visibility = '';
    statusArea.innerText = `▶️ ${ch.name}`;
    if (_activePlaylistKey) {
        getPlaylistState(_activePlaylistKey).lastChannel = { url: ch.url, tvgId: ch.tvgId || '' };
        savePlaylistState();
    }
    if (epgMode) {
        // Don't rebuild the EPG grid — just update active row highlighting in-place
        for (const [, el] of epgRenderedRows) el.classList.remove('active');
        const filteredIdx = currentFilteredChannels.indexOf(ch);
        if (filteredIdx >= 0 && epgRenderedRows.has(filteredIdx)) epgRenderedRows.get(filteredIdx).classList.add('active');
        updateEPGInfoPanel(ch);
    } else {
        // Update the active row in place — no list rebuild
        for (const [, el] of renderedItems) el.classList.remove('active');
        const fi = currentFilteredChannels.indexOf(ch);
        if (fi >= 0) {
            stdFocusIdx = fi;
            stdFocusZone = 'channels';
            if (renderedItems.has(fi)) renderedItems.get(fi).classList.add('active');
        }
        updateStdChannelFocus();
        updateStdGroupFocus(false);
    }
    if (ch.tvgId) queueEpgFetch([ch.tvgId], true);
    updateNowNext();
    if (livePlayer.active) { document.getElementById('vodPaused').classList.add('hidden'); const techEl = document.getElementById('vodOsdTech'); if (techEl) techEl.textContent = ''; updateVodTracksHint(); showVodOsd(); }
    else showTopControls();

    // Reset per-stream state
    if (subtitlePanelOpen) { subtitlePanel.classList.add('hidden'); subtitlePanelOpen = false; }
    if (audioPanelOpen) { audioPanel.classList.add('hidden'); audioPanelOpen = false; }

    // Some streams add tracks well after loadedmetadata — check again after a delay
    setTimeout(function () { updateSubtitleButton(); updateAudioButton(); }, 4000);
}

function showTopControls() {
    const c = document.getElementById('topControls');
    c.classList.add('visible');
    if (controlsTimeout) clearTimeout(controlsTimeout);
    controlsTimeout = setTimeout(() => { c.classList.remove('visible'); }, 3000);
}

function resolveLanguage(code) {
    if (!code) return null;
    const short = code.toLowerCase().substring(0, 2);
    return LANG_NAMES[short] || code;
}

function getSubtitleTracks() {
    if (!videoPlayer.textTracks) return [];
    return Array.from(videoPlayer.textTracks).filter(function (t) {
        return t.kind !== 'metadata' && t.kind !== 'chapters';
    });
}

function updateSubtitleButton() {
    const subs = getSubtitleTracks();
    if (subs.length > 0) {
        subtitleBtn.style.display = '';
        subtitleBtn.innerHTML = '💬 Subtitles (' + subs.length + ')';
    } else {
        subtitleBtn.style.display = 'none';
        if (subtitlePanelOpen) { subtitlePanel.classList.add('hidden'); subtitlePanelOpen = false; }
    }
}

function buildSubtitlePanel() {
    const subs = getSubtitleTracks();
    const listEl = document.getElementById('subtitleTrackList');
    listEl.innerHTML = '';

    const allOff = subs.every(function (t) { return t.mode !== 'showing'; });
    const offItem = document.createElement('div');
    offItem.className = 'subtitle-track-item' + (allOff ? ' active' : '');
    offItem.textContent = 'Off';
    offItem.onclick = function () {
        subs.forEach(function (t) { t.mode = 'disabled'; });
        buildSubtitlePanel();
        showTopControls();
    };
    listEl.appendChild(offItem);

    subs.forEach(function (track, i) {
        const item = document.createElement('div');
        const isActive = track.mode === 'showing';
        item.className = 'subtitle-track-item' + (isActive ? ' active' : '');

        const lang = track.language ? resolveLanguage(track.language) : null;
        const label = track.label || lang || ('Track ' + (i + 1));
        const kindLabel = track.kind === 'captions' ? ' [CC]' : '';
        item.textContent = label + kindLabel;

        item.onclick = function () {
            subs.forEach(function (t) { t.mode = 'disabled'; });
            track.mode = 'showing';
            buildSubtitlePanel();
            showTopControls();
        };
        listEl.appendChild(item);
    });
}

function toggleSubtitlePanel() {
    subtitlePanelOpen = !subtitlePanelOpen;
    if (subtitlePanelOpen) {
        if (audioPanelOpen) { audioPanel.classList.add('hidden'); audioPanelOpen = false; }
        buildSubtitlePanel();
        subtitlePanel.classList.remove('hidden');
    } else {
        subtitlePanel.classList.add('hidden');
    }
}

function getAudioTracks() {
    if (!videoPlayer.audioTracks) return [];
    return Array.from(videoPlayer.audioTracks);
}

function updateAudioButton() {
    const tracks = getAudioTracks();
    if (tracks.length > 1) {
        audioBtn.style.display = '';
        audioBtn.innerHTML = '🔊 Audio (' + tracks.length + ')';
    } else {
        audioBtn.style.display = 'none';
        if (audioPanelOpen) { audioPanel.classList.add('hidden'); audioPanelOpen = false; }
    }
}

function buildAudioPanel() {
    const tracks = getAudioTracks();
    const listEl = document.getElementById('audioTrackList');
    listEl.innerHTML = '';

    // Count how many times each language appears so we can disambiguate duplicates
    const langCount = {};
    tracks.forEach(function (t) {
        const k = t.language || '';
        langCount[k] = (langCount[k] || 0) + 1;
    });
    const langSeen = {};

    tracks.forEach(function (track, i) {
        const item = document.createElement('div');
        item.className = 'subtitle-track-item' + (track.enabled ? ' active' : '');

        const resolvedLang = track.language ? resolveLanguage(track.language) : null;
        const langKey = track.language || '';
        langSeen[langKey] = (langSeen[langKey] || 0) + 1;

        let name;
        if (track.label && track.label.trim()) {
            // Label is the most descriptive source ("English 5.1", "Deutsch Director's Cut", etc.)
            name = track.label.trim();
        } else {
            name = resolvedLang || ('Track ' + (i + 1));
            // When the same language appears more than once and there's no label to distinguish,
            // append an ordinal so the user can tell them apart
            if (langCount[langKey] > 1) {
                name += ' ' + langSeen[langKey];
            }
        }

        // Kind badge for anything other than 'main'
        if (track.kind && track.kind !== 'main' && track.kind !== '') {
            name += ' [' + track.kind + ']';
        }

        item.textContent = name;
        item.onclick = function () {
            tracks.forEach(function (t) { t.enabled = false; });
            track.enabled = true;
            buildAudioPanel();
            showTopControls();
        };
        listEl.appendChild(item);
    });
}

function toggleAudioPanel() {
    audioPanelOpen = !audioPanelOpen;
    if (audioPanelOpen) {
        if (subtitlePanelOpen) { subtitlePanel.classList.add('hidden'); subtitlePanelOpen = false; }
        buildAudioPanel();
        audioPanel.classList.remove('hidden');
    } else {
        audioPanel.classList.add('hidden');
    }
}

function reloadStream(auto) {
    if (currentChannelIndex < 0) return;
    if (vodPlay.active || vodMode !== 'live') return; // live reloads pause while in Movies/Series
    const isAuto = auto === true;
    if (!isAuto) _reloadAttempts = 0; // a manual reload restores the auto-reload budget
    stopStallWatchdog();
    const url = catchup && catchup.chIdx === currentChannelIndex ? catchup.url : channels[currentChannelIndex].url;
    const wasPlaying = !videoPlayer.paused;
    videoPlayer.pause();
    umsNoteCurrentId();
    if (loadLiveSource(url)) { umsRelease(liveUms); liveUms = null; } else liveUmsRefresh();
    if (wasPlaying || isAuto) videoPlayer.play().catch(e => console.log);
    startStallWatchdog();
    statusArea.innerText = isAuto ? `🔄 Reloading (${_reloadAttempts}/${MAX_AUTO_RELOADS}) …` : '🔄 Reloading ...';
    setTimeout(() => statusArea.innerText = `▶️ ${channels[currentChannelIndex].name}`, 2000);
    showTopControls();
}

function showConfirmDialog(title, message, onYes) {
    if (!confirmDialog.classList.contains('hidden')) return;
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmYes.textContent = 'Yes';
    confirmNo.textContent = 'Cancel';
    confirmDialog.classList.remove('hidden');
    setTimeout(() => confirmNo.focus(), 50);
    const yesHandler = () => { onYes(); confirmDialog.classList.add('hidden'); confirmYes.removeEventListener('click', yesHandler); confirmNo.removeEventListener('click', noHandler); };
    const noHandler = () => { confirmDialog.classList.add('hidden'); confirmYes.removeEventListener('click', yesHandler); confirmNo.removeEventListener('click', noHandler); };
    confirmYes.addEventListener('click', yesHandler);
    confirmNo.addEventListener('click', noHandler);
}

function goToHomeScreen() {
    // Abort any in-flight fetches
    if (_epgAbortController) { _epgAbortController.abort(); _epgAbortController = null; }
    if (_m3uAbortController) { _m3uAbortController.abort(); _m3uAbortController = null; }

    // Stop all timers
    if (epgRefreshTimer) { clearInterval(epgRefreshTimer); epgRefreshTimer = null; }
    if (controlsTimeout) { clearTimeout(controlsTimeout); controlsTimeout = null; }
    if (_epgToastTimer) { clearTimeout(_epgToastTimer); _epgToastTimer = null; }

    // Dismiss EPG toast immediately
    const _toast = document.getElementById('epgToast');
    if (_toast) _toast.classList.remove('epg-toast--visible');

    // Clear EPG guide virtual scroll
    epgRenderedRows.clear();
    const _scrollOuter = document.getElementById('epgScrollOuter');
    if (epgVirtualScrollListener && _scrollOuter) {
        _scrollOuter.removeEventListener('scroll', epgVirtualScrollListener);
        epgVirtualScrollListener = null;
    }
    _epgWinStart = 0; _epgWinEnd = 0; _epgTotalGuideW = 0; _epgSkeletonWinStart = 0; _epgX = 0; _epgPrevFocusIdx = -1;
    if (_epgPersistTimer) flushEpgPersist(); // write what the last session fetched before the key changes
    _playlistCacheAt = 0; _m3uSource = null;
    catchup = null; epgFocusT = 0; _epgFullFetched.clear(); _epgFullPending.clear(); EPG_WIN_HOURS = EPG_PAST_HOURS_MIN + EPG_AHEAD_HOURS;

    // Clear all data
    resetLazyEpg();
    epgData.clear();
    epgIdMap.clear();
    epgLoading = false;
    _epgLoadedAt = 0;
    currentEpgUrl = '';
    renderedItems.clear();
    _stdRenderVisible = null;
    _stdItemH = 0;
    stdFocusZone = 'channels'; stdFocusIdx = 0; stdGroupFocusIdx = 0;
    _reloadAttempts = 0;
    channels = [];
    currentFilteredChannels = [];
    groupsList = [];
    channelIndexMap.clear();
    _searchCache = { query: null, result: null };
    currentChannelIndex = -1;
    lastChannelIndex = -1;
    currentSearchQuery = '';
    selectedPlaylistId = null;

    // Reset app state (also restores the standard layout if the guide was showing)
    if (vodPlay.active) stopVodPlayback(false);
    if (livePlayer.active) exitLivePlayer();
    umsRelease(liveUms); liveUms = null;
    resetVodState(false);
    exitEPGMode();
    _activePlaylistKey = null; _epgShiftOn = false; _epgTz = ''; _epgExtraMs = 0;
    favoriteIds = new Set(); // favorites belong to a playlist; the next one applied loads its own
    if (settingsOpen) closeSettings();
    currentPlaylistType = null;
    isLoading = false;

    // Stop and clear video
    videoPlayer.pause();
    liveEngineDestroy();
    videoPlayer.removeAttribute('src');
    videoPlayer.load();

    // Clear DOM lists so stale content isn't briefly visible on next load
    const _chanList = document.getElementById('channelList');
    if (_chanList) _chanList.innerHTML = '';
    const _grpList = document.getElementById('groupsList');
    if (_grpList) _grpList.innerHTML = '';
    const _grpPinned = document.getElementById('groupsPinned');
    if (_grpPinned) _grpPinned.innerHTML = '';
    const _epgBody = document.getElementById('epgBody');
    if (_epgBody) _epgBody.innerHTML = '';

    startPage.classList.remove('hidden');
    mainApp.style.display = 'none';
    showLoading(false);
    renderSavedPlaylists();
    setLoadSelectedButtonEnabled(true);
    updateStartStatus('Ready', false, false, false, 0);
    setTimeout(() => { updateFocusableElements(); focusElement(0); }, 100);
}

function toggleGroupsColumn() {
    groupsColumnVisible = !groupsColumnVisible;
    groupsColumn.classList.toggle('collapsed', !groupsColumnVisible);
    toggleGroupsBtn.innerHTML = groupsColumnVisible ? '◀ Hide' : '▶ Show';
    showGroupsBtn.style.display = groupsColumnVisible ? 'none' : 'block';
    const floatingBtn = document.getElementById('epgFloatingGroupsBtn');
    if (floatingBtn) floatingBtn.style.display = (currentPlaylistType === 'xtream' && !groupsColumnVisible) ? '' : 'none';
    if (currentPlaylistType === 'xtream') requestAnimationFrame(updateEPGNowMarker);
}



// ----- Tab switching -----
function switchTab(tab) {
    activeTab = tab;
    const isM3u = tab === 'm3u';
    tabM3u.classList.toggle('active', isM3u);
    tabXtream.classList.toggle('active', !isM3u);
    panelM3u.style.display = isM3u ? '' : 'none';
    panelXtream.style.display = isM3u ? 'none' : '';
    updateFocusableElements();
    focusElement(focusableElements.indexOf(isM3u ? tabM3u : tabXtream));
}

function editPlaylist(idx) {
    const p = savedPlaylists[idx];
    if (!p) return;
    if (p.type === 'xtream') {
        switchTab('xtream');
        xtreamServer.value = p.url;
        xtreamUsername.value = p.username || '';
        xtreamPassword.value = p.password || '';
        xtreamName.value = p.name || '';
    } else {
        switchTab('m3u');
        newM3uUrl.value = p.url;
        newM3uName.value = p.name;
        newEpgUrl.value = p.epgUrl || '';
    }
}

// ----- Xtream API -----
function addXtreamPlaylist(serverUrl, username, password, name) {
    const existing = savedPlaylists.find(p => p.type === 'xtream' && p.url === serverUrl && p.username === username);
    if (existing) {
        existing.name = name || existing.name;
        existing.password = password;
        savePlaylistsToStorage();
        updateStartStatus(`Playlist "${existing.name}" updated!`, false, true, false, 0);
    } else {
        let displayName = name;
        if (!displayName) {
            try { displayName = `${username}@${new URL(serverUrl).host}`; } catch { displayName = username; }
        }
        savedPlaylists.push({ type: 'xtream', name: displayName, url: serverUrl, username, password });
        savePlaylistsToStorage();
        updateStartStatus('Xtream playlist saved!', false, true, false, 0);
    }
    setTimeout(() => updateStartStatus('Ready', false, false, false, 0), 2000);
    xtreamServer.value = '';
    xtreamUsername.value = '';
    xtreamPassword.value = '';
    xtreamName.value = '';
    updateFocusableElements();
    focusElement(0);
}

// ── EPG Toast Notifications ───────────────────────────────────
let _epgToastTimer = null;
function showEPGToast(msg, type = 'loading', title) {
    const toast = document.getElementById('epgToast');
    const titleEl = document.getElementById('epgToastTitle');
    const msgEl = document.getElementById('epgToastMsg');
    const spinner = document.getElementById('epgToastSpinner');
    if (!toast) return;
    if (_epgToastTimer) { clearTimeout(_epgToastTimer); _epgToastTimer = null; }
    const titles = { loading: 'EPG Loading', error: 'EPG Error', success: 'EPG Ready' };
    toast.className = `epg-toast epg-toast--${type} epg-toast--visible`;
    if (titleEl) titleEl.textContent = title || titles[type] || 'EPG';
    if (msgEl) msgEl.textContent = msg;
    if (spinner) spinner.style.display = type === 'loading' ? '' : 'none';
}
function hideEPGToast(delayMs = 0) {
    const dismiss = () => {
        const toast = document.getElementById('epgToast');
        if (toast) toast.classList.remove('epg-toast--visible');
    };
    if (delayMs > 0) { _epgToastTimer = setTimeout(dismiss, delayMs); } else { dismiss(); }
}

// ── EPG Guide Layout ──────────────────────────────────────────
const EPG_CH_W = 300;      // channel label column px (must match .epg-ch-label width in style.css)
const EPG_PX_PER_MIN = 8;  // pixels per minute — ~3.6h visible on 1920px screen
const EPG_AHEAD_HOURS = 6; // guide window ahead of now
const EPG_PAST_HOURS_MIN = 1;   // behind now when no channel offers catch-up
const EPG_PAST_HOURS_MAX = 72;  // behind now with catch-up (provider archives are 1–7 days; the guide shows up to 3)
let EPG_WIN_HOURS = EPG_PAST_HOURS_MIN + EPG_AHEAD_HOURS; // total window; recomputed per playlist by epgPastHours()
// Hours of history the guide shows: 1 h, or the longest catch-up archive in the playlist (capped)
function epgPastHours() {
    let days = 0;
    for (const ch of channels) if (ch.archive > days) days = ch.archive;
    return days ? Math.min(EPG_PAST_HOURS_MAX, days * 24) : EPG_PAST_HOURS_MIN;
}

// ── Catch-up (provider timeshift archive) ─────────────────────
// Xtream channels flagged tv_archive carry `archive` (days). Past programmes on those rows within the
// archive are playable: the guide extends into the past (epgPastHours), Left/Right move a programme
// cursor (epgFocusT) along the focused row, and OK on a past programme plays the provider's timeshift
// stream: /timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<streamId>.ts, start time expressed in
// the server's timezone (server_info.timezone from the auth call). Past programmes come from
// get_simple_data_table (full table incl. history, with has_archive); the short EPG only lists what is
// coming up. While a timeshift stream plays, `catchup` holds the programme and the live slot plays
// it through the native pipeline; any channel change returns to live.
let catchup = null;          // { chIdx, prog, url, dur } while a timeshift stream plays
let epgFocusT = 0;           // programme cursor time in the guide (ms); 0 = "now"
const _epgFullFetched = new Set(); // tvgIds whose full table (history) has been requested this session
const _epgFullPending = new Set();
function channelHasCatchup(ch) { return !!(_xt && ch && ch.archive > 0 && ch.streamId !== undefined); }
function progIsCatchup(ch, p, now) {
    if (!channelHasCatchup(ch) || p.stop > (now || Date.now())) return false;
    if (p.hasArchive === false) return false;
    return p.start >= (now || Date.now()) - ch.archive * 86400000;
}
// The panel expects the timeshift start in the same clock it prints its EPG `start` strings in. That is
// not reliably server_info.timezone (one panel reports Europe/Amsterdam yet prints UTC strings), so the
// offset is learnt from the EPG itself: `start` string vs `start_timestamp` (xtreamNoteEpgOffset).
function fmtTimeshiftStart(ms, tz) {
    const d = new Date(ms + (typeof _xt === 'object' && _xt && typeof _xt.epgOffsetMin === 'number' ? _xt.epgOffsetMin * 60000 : 0));
    const p = n => String(n).padStart(2, '0');
    if (typeof _xt === 'object' && _xt && typeof _xt.epgOffsetMin === 'number') {
        return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}:${p(d.getUTCHours())}-${p(d.getUTCMinutes())}`;
    }
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
        const g = t => (parts.find(x => x.type === t) || {}).value || '00';
        return `${g('year')}-${g('month')}-${g('day')}:${g('hour') === '24' ? '00' : g('hour')}-${g('minute')}`;
    } catch (_) {
        const u = new Date(ms);
        return `${u.getUTCFullYear()}-${p(u.getUTCMonth() + 1)}-${p(u.getUTCDate())}:${p(u.getUTCHours())}-${p(u.getUTCMinutes())}`;
    }
}
// Learn the panel's clock from one EPG listing: minutes between its `start` string (read as UTC) and start_timestamp
function xtreamNoteEpgOffset(ep) {
    if (!_xt || typeof _xt.epgOffsetMin === 'number' || !ep || !ep.start) return;
    const m = String(ep.start).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    const ts = parseInt(ep.start_timestamp) * 1000;
    if (!m || isNaN(ts)) return;
    const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const off = Math.round((asUtc - ts) / 60000);
    if (Math.abs(off) > 14 * 60) return;
    _xt.epgOffsetMin = off;
    // Remember it with the cached playlist so a cached launch can build catch-up URLs before any EPG fetch
    const key = _activePlaylistKey, xt = _xt;
    if (key) cacheGet('playlists', key).then(rec => { if (rec && _xt === xt && _activePlaylistKey === key && rec.epgOffsetMin !== off) { rec.epgOffsetMin = off; cachePut('playlists', key, rec); } });
}
function catchupUrl(ch, prog) {
    const mins = Math.max(1, Math.ceil((prog.stop - prog.start) / 60000));
    return `${_xt.base}/timeshift/${_xt.user}/${_xt.pass}/${mins}/${fmtTimeshiftStart(epgUnshiftTime(prog.start), _xt.tz)}/${ch.streamId}.ts`; // archive is indexed by provider time
}
// Server timezone is needed for timeshift start times; cached loads skip the auth call, so fetch it lazily
function xtreamEnsureServerInfo() {
    if (!_xt || _xt.tz || _xt.tzPending) return;
    const xt = _xt; xt.tzPending = true;
    fetch(`${xt.base}/player_api.php?username=${xt.u}&password=${xt.pw}`).then(r => r.json()).then(d => {
        if (_xt !== xt) return;
        xt.tz = (d && d.server_info && d.server_info.timezone) || 'UTC';
        if (_activePlaylistKey) cacheGet('playlists', _activePlaylistKey).then(rec => { if (rec && _activePlaylistKey && rec.tz !== xt.tz) { rec.tz = xt.tz; cachePut('playlists', _activePlaylistKey, rec); } });
    }).catch(() => { if (_xt === xt) xt.tzPending = false; });
}
// Full EPG table (history + future) for one channel, merged into epgData
async function fetchXtreamEpgFull(tvgId) {
    const xt = _xt;
    const streamId = xt ? _xtStreamIdByTvgId.get(tvgId) : undefined;
    if (!xt || streamId === undefined || _epgFullFetched.has(tvgId)) return;
    _epgFullFetched.add(tvgId); _epgFullPending.add(tvgId);
    try {
        const resp = await fetch(`${xt.base}/player_api.php?username=${xt.u}&password=${xt.pw}&action=get_simple_data_table&stream_id=${streamId}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (_xt !== xt) return;
        const listings = data && data.epg_listings;
        if (!Array.isArray(listings)) return;
        const byStart = new Map();
        for (const p of epgData.get(tvgId) || []) byStart.set(p.start, p);
        if (listings.length) xtreamNoteEpgOffset(listings[0]);
        for (const ep of listings) {
            const pStart = epgShiftTime(parseInt(ep.start_timestamp) * 1000), pStop = epgShiftTime(parseInt(ep.stop_timestamp) * 1000);
            if (isNaN(pStart) || isNaN(pStop) || pStop <= pStart) continue;
            const title = unescapeXml(decodeBase64Field(ep.title || '').trim());
            const rawDesc = unescapeXml(decodeBase64Field(ep.description || '').trim());
            const prog = { start: pStart, stop: pStop, title, desc: rawDesc.replace(_RE_TS_INJECT, '').trim() };
            if (ep.has_archive !== undefined) prog.hasArchive = String(ep.has_archive) === '1';
            byStart.set(pStart, prog);
        }
        const progs = [...byStart.values()].sort((a, b) => a.start - b.start);
        if (!progs.length) return;
        epgData.delete(tvgId); epgData.set(tvgId, progs);
        epgIdMap.set(tvgId.toLowerCase(), tvgId);
        const m = _epgFetchMeta.get(tvgId); if (!m || m.status !== 'pending') _epgFetchMeta.set(tvgId, { at: Date.now(), status: 'done' });
        epgPersist(tvgId, Date.now(), epgShiftProgs(progs, -1)); // cache keeps provider time
        onEpgChannelUpdated(tvgId);
    } catch (_) { _epgFullFetched.delete(tvgId); /* retried next time the cursor moves there */ }
    finally { _epgFullPending.delete(tvgId); if (epgMode) { for (const [idx, el] of epgRenderedRows) { const ch = currentFilteredChannels[idx]; if (ch && ch.tvgId === tvgId) el.classList.remove('epg-row-loading-past'); } } }
}
// Play a past programme from the provider archive in the live slot (native pipeline)
function startCatchup(chIdx, prog) {
    const ch = channels[chIdx];
    if (!ch || !channelHasCatchup(ch)) return;
    if (vodPlay.active) stopVodPlayback(false);
    stopStallWatchdog();
    if (_errRetryTimer) { clearTimeout(_errRetryTimer); _errRetryTimer = null; }
    if (currentChannelIndex >= 0 && currentChannelIndex !== chIdx) lastChannelIndex = currentChannelIndex;
    currentChannelIndex = chIdx;
    _reloadAttempts = 0;
    catchup = { chIdx, prog, url: catchupUrl(ch, prog), dur: (prog.stop - prog.start) / 1000 };
    videoPlayer.pause();
    umsNoteCurrentId();
    if (loadLiveSource(catchup.url)) { umsRelease(liveUms); liveUms = null; } else liveUmsRefresh();
    videoPlayer.play().catch(() => {});
    startStallWatchdog();
    channelInfoTag.innerText = `⏪ ${ch.name} · ${prog.title}`;
    channelInfoTag.style.visibility = '';
    statusArea.innerText = `⏪ ${prog.title}`;
    if (epgMode) {
        for (const [, el] of epgRenderedRows) el.classList.remove('active');
        const fi = currentFilteredChannels.indexOf(ch);
        if (fi >= 0 && epgRenderedRows.has(fi)) epgRenderedRows.get(fi).classList.add('active');
        updateEPGInfoPanel(ch);
    }
    if (!livePlayer.active) enterLivePlayer(); else showVodOsd();
}
function catchupBackToLive() {
    if (!catchup) return;
    const idx = catchup.chIdx;
    catchup = null;
    if (channels[idx]) selectChannel(idx);
}

function enterEPGMode() {
    if (currentPlaylistType !== 'xtream') return;
    epgMode = true;
    const sv = document.getElementById('standardView');
    const ev = document.getElementById('epgView');
    if (!sv || !ev) return;
    sv.style.display = 'none';
    ev.style.display = 'flex';
    // Sync EPG search input with current query
    const epgSI = document.getElementById('epgSearchInput');
    if (epgSI) epgSI.value = currentSearchQuery;
    // Move <video> and stream-info overlay into the EPG video container
    const wrap = document.getElementById('epgVideoWrap');
    if (wrap) {
        if (videoPlayer.parentNode !== wrap) wrap.appendChild(videoPlayer);
    }
    // Start focus cursor at the currently playing channel
    if (currentChannelIndex >= 0) {
        const idx = currentFilteredChannels.indexOf(channels[currentChannelIndex]);
        epgFocusedRowIdx = idx >= 0 ? idx : 0;
    } else {
        epgFocusedRowIdx = 0;
    }
    const floatingBtn = document.getElementById('epgFloatingGroupsBtn');
    if (floatingBtn) floatingBtn.style.display = !groupsColumnVisible ? '' : 'none';
    renderEPGGuide();
    if (currentChannelIndex >= 0 && channels[currentChannelIndex]) {
        updateEPGInfoPanel(channels[currentChannelIndex]);
    }
}

// Restore the standard layout after the EPG guide was shown: swap the view
// containers back and return the <video> + stream-info overlay to videoArea.
function exitEPGMode() {
    epgMode = false;
    const sv = document.getElementById('standardView');
    const ev = document.getElementById('epgView');
    if (sv) sv.style.display = 'flex';
    if (ev) ev.style.display = 'none';
    if (videoPlayer.parentNode !== videoArea) videoArea.insertBefore(videoPlayer, videoArea.firstChild);
}

function refreshCurrentView() {
    if (vodMode !== 'live') {
        if (vodNav.screen === 'home') renderVodHome(); else if (vodNav.screen === 'grid') renderVodGrid(); else if (vodNav.screen === 'details') renderVodDetails();
        return;
    }
    if (currentPlaylistType === 'xtream') renderEPGGuide();
    else renderChannelList();
}

// Logos that failed to load this session: never re-requested (the provider's CDN answers slowly for them)
const _epgLogoFailed = new Set();
function epgLogoFailed(img) {
    img.style.display = 'none';
    img.classList.add('failed');
    if (img.dataset.src) _epgLogoFailed.add(img.dataset.src);
    if (img.parentNode) img.parentNode.classList.remove('has-logo');
}
// Logos are not requested while the guide is being scrolled: rows carry data-src and the src is set
// once scrolling has settled (epgOnScrollSettled). Otherwise every key repeat fetched and decoded
// an image the user never saw, which is paint and network work the TV cannot afford.
function epgLoadVisibleLogos() {
    for (const [, el] of epgRenderedRows) {
        const img = el.querySelector('.epg-ch-logo[data-src]:not([src])');
        if (img) img.src = img.dataset.src;
    }
}
// Descriptions are a single clipped line; the widest block shows ~1.5 lines of text at most, so the
// rest of a long description is only layout work for the TV.
const EPG_DESC_MAX = 160;
// Programme blocks (or the placeholder) for one channel over the current window
function epgProgsHtml(ch) {
    const now = Date.now();
    const progs = epgProgsOf(ch.tvgId) || [];
    const parts = [`<div class="epg-progs-clip"><div class="epg-progs" style="width:${_epgTotalGuideW}px">`];
    let hadBlock = false;
    for (const p of progs) {
        if (p.stop <= _epgWinStart || p.start >= _epgWinEnd) continue;
        const sx = Math.max(0, (p.start - _epgWinStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
        const ex = Math.min(_epgTotalGuideW, (p.stop - _epgWinStart) / 60000 * EPG_PX_PER_MIN);
        const w = (ex - parseFloat(sx) - 2).toFixed(1);
        if (parseFloat(w) < 4) continue;
        const isNow = p.start <= now && p.stop > now;
        const isPast = p.stop <= now;
        const wNum = parseFloat(w);
        const descHtml = p.desc && wNum > 120 * TEXT_SCALE
            ? `<span class="epg-prog-desc">${escapeHtml(p.desc.length > EPG_DESC_MAX ? p.desc.slice(0, EPG_DESC_MAX) : p.desc)}</span>`
            : '';
        const cls = (isNow ? ' now-playing' : '') + (isPast ? (progIsCatchup(ch, p, now) ? ' past catchup' : ' past') : '');
        parts.push(`<div class="epg-prog-block${cls}" data-start="${p.start}" data-stop="${p.stop}" style="left:${sx}px;width:${w}px">` +
            `<span class="epg-prog-title">${escapeHtml(p.title)}</span>${descHtml}</div>`);
        hadBlock = true;
    }
    if (!hadBlock) {
        // An event outside the window (next week's race) names its date instead of "No data"
        const ev = progs.length === 1 && progs[0].fromName ? progs[0] : null;
        const label = ev ? escapeHtml(`${ev.title} · ${new Date(ev.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${formatClock(ev.start)}`)
            : epgPlaceholderText(ch.tvgId);
        const cls = label === 'Loading ...' ? 'epg-prog-placeholder loading' : 'epg-prog-placeholder';
        parts.push(`<div class="${cls}" style="left:2px;width:${(_epgTotalGuideW - 4).toFixed(1)}px">` +
            `<span class="epg-prog-title">${label}</span></div>`);
    }
    parts.push('</div></div>');
    return parts.join('');
}

function buildEPGRow(i) {
    const ch = currentFilteredChannels[i];
    const origIdx = getChannelIndex(ch);
    const isActive = origIdx === currentChannelIndex;

    const row = document.createElement('div');
    row.className = 'epg-row' +
        (isActive ? ' active' : '') +
        (i === epgFocusedRowIdx ? ' epg-focused' : '');
    row.style.cssText = `position:absolute;top:${i * EPG_ROW_H}px;left:0;right:0`;

    const logoSrc = ch.tvgLogo && !_epgLogoFailed.has(ch.tvgLogo) ? escapeHtml(ch.tvgLogo) : '';
    const favId = favIdOf(ch, origIdx);
    const isFav = favoriteIds.has(favId);
    const labelHtml = `<div class="epg-ch-label"><div class="epg-ch-logo-wrap${logoSrc ? ' has-logo' : ''}"><span class="epg-ch-no-logo">📺</span>${logoSrc ? `<img class="epg-ch-logo" data-src="${logoSrc}" decoding="async" onerror="epgLogoFailed(this)">` : ''}</div><span class="epg-ch-name">${escapeHtml(ch.name.length > 22 ? ch.name.slice(0, 20) + '…' : ch.name)}</span><button class="epg-fav-btn${isFav ? ' fav-active' : ''}" data-fav-id="${escapeHtml(favId)}">${isFav ? '★' : '☆'}</button></div>`;

    row.innerHTML = labelHtml + epgProgsHtml(ch);
    row.querySelector('.epg-fav-btn').addEventListener('click', e => {
        e.stopPropagation();
        toggleEPGFav(favId);
    });
    row.addEventListener('click', () => {
        for (const [, el] of epgRenderedRows) el.classList.remove('active');
        row.classList.add('active');
        selectChannel(origIdx);
        updateEPGInfoPanel(ch);
    });
    return row;
}

// Viewport size of the guide scroller, read once per layout change instead of on every key
// (each read forces a synchronous layout, which is what made key repeats stutter on the TV).
let _epgViewH = 0, _epgViewW = 0;
let _epgRenderQueued = false;
let _epgLastStartIdx = -1;
function epgMeasureViewport() {
    const so = document.getElementById('epgScrollOuter');
    if (!so) return;
    _epgViewH = so.clientHeight;
    _epgViewW = so.clientWidth;
}
// One render per animation frame, however many scroll events or key repeats arrived in between
function queueEPGRender() {
    if (_epgRenderQueued) return;
    _epgRenderQueued = true;
    requestAnimationFrame(() => { _epgRenderQueued = false; renderEPGVisibleRows(); });
}

function renderEPGVisibleRows() {
    const body = document.getElementById('epgBody');
    const scrollOuter = document.getElementById('epgScrollOuter');
    if (!body || !scrollOuter || !currentFilteredChannels.length || !_epgTotalGuideW) return;
    const BUFFER = 3;
    // Row i occupies content offset [strip + i*rowH, strip + (i+1)*rowH)
    const scrollTop = scrollOuter.scrollTop;
    if (!_epgViewH) epgMeasureViewport();
    const viewH = _epgViewH;
    const startIdx = Math.max(0, Math.floor(scrollTop / EPG_ROW_H) - BUFFER);
    const endIdx = Math.min(currentFilteredChannels.length - 1,
        Math.ceil((scrollTop + viewH - EPG_TIME_STRIP_H) / EPG_ROW_H) + BUFFER);
    let changed = false;
    for (const [idx, el] of epgRenderedRows) {
        if (idx < startIdx || idx > endIdx) { el.remove(); epgRenderedRows.delete(idx); changed = true; }
    }
    if (epgRenderedRows.size < endIdx - startIdx + 1) {
        const frag = document.createDocumentFragment();
        for (let i = startIdx; i <= endIdx; i++) {
            if (epgRenderedRows.has(i)) continue;
            const row = buildEPGRow(i);
            frag.appendChild(row);
            epgRenderedRows.set(i, row);
            changed = true;
        }
        body.appendChild(frag);
    }
    if (changed || startIdx !== _epgLastStartIdx) {
        _epgScrollDir = startIdx >= _epgLastStartIdx ? 1 : -1;
        _epgLastStartIdx = startIdx;
        scheduleEpgFetchForVisible();
    }
    if (changed) updateEPGBlockFocus();
}
let _epgScrollDir = 1;

// Horizontal position of the guide in px (0 = window start). Applied as a CSS variable on the scroller
// that the time strip and every row's programme area translate by; see .epg-progs in style.css.
let _epgX = 0;
function epgMaxPan() {
    if (!_epgViewW) epgMeasureViewport();
    return Math.max(0, EPG_WIN_HOURS * 60 * EPG_PX_PER_MIN - Math.max(1, _epgViewW - EPG_CH_W));
}
function epgApplyPan() {
    const so = document.getElementById('epgScrollOuter');
    if (!so) return;
    so.style.setProperty('--epg-x', `${-_epgX}px`);
    updateEPGNowMarker();
    updateEPGNavVisibility();
}

function updateEPGNowMarker() {
    const body = document.getElementById('epgBody');
    const timeMarks = document.getElementById('epgTimeMarks');
    if (!body || !timeMarks || !_epgWinStart) return;
    const fullMarker = body.querySelector('.epg-now-fullmarker');
    if (!fullMarker) return;
    const nowOffsetPx = (Date.now() - _epgWinStart) / 60000 * EPG_PX_PER_MIN;
    const x = EPG_CH_W + nowOffsetPx - _epgX;
    fullMarker.style.display = x < EPG_CH_W ? 'none' : '';
    fullMarker.style.left = `${x.toFixed(1)}px`;
    const stripLine = timeMarks.querySelector('.epg-now-line'); // the labelled NOW line in the time strip (pans with it)
    if (stripLine) stripLine.style.left = `${nowOffsetPx.toFixed(1)}px`;
}

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
            tmHtml += `<span class="epg-time-marker" style="left:${x}px">${formatClock(t)}</span>`;
        } else if (minOfHour === 30) {
            tmHtml += `<span class="epg-time-tick epg-time-tick-half" style="left:${x}px"></span>`;
        } else {
            tmHtml += `<span class="epg-time-tick" style="left:${x}px"></span>`;
        }
    }
    // Day labels at each midnight when the window spans more than one day (catch-up history)
    if (winEnd - winStart > 26 * 3600000) {
        const d0 = new Date(winStart); d0.setHours(0, 0, 0, 0);
        for (let t = d0.getTime(); t <= winEnd; t += 86400000) {
            if (t < winStart) continue;
            const x = ((t - winStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
            const d = new Date(t);
            tmHtml += `<span class="epg-day-label" style="left:${x}px">${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>`;
        }
    }
    const nowOffsetPx = ((Date.now() - winStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
    tmHtml += `<div class="epg-now-line" style="left:${nowOffsetPx}px"><span class="epg-now-label">NOW</span></div>`;
    timeMarks.innerHTML = tmHtml;
}

function refreshEPGRows() {
    const scrollOuter = document.getElementById('epgScrollOuter');
    const body = document.getElementById('epgBody');
    if (!body) return;

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
    epgMeasureViewport();
    _epgLastStartIdx = -1;
    renderEPGVisibleRows();
    epgVirtualScrollListener = queueEPGRender;
    if (scrollOuter) scrollOuter.addEventListener('scroll', epgVirtualScrollListener, { passive: true });

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

    // Restore the vertical position; keep the time pan, or centre it on "now" the first time
    if (scrollOuter) {
        if (prevScrollTop > 0) scrollOuter.scrollTop = prevScrollTop;
        if (_epgX > 0) {
            epgApplyPan();
        } else {
            requestAnimationFrame(() => {
                const nowOffsetPx = (_epgWinStart ? (Date.now() - _epgWinStart) : 0) / 60000 * EPG_PX_PER_MIN;
                epgMeasureViewport();
                const visibleW = Math.max(1, _epgViewW - EPG_CH_W);
                _epgX = Math.max(0, Math.min(epgMaxPan(), Math.floor(nowOffsetPx - visibleW / 3)));
                epgApplyPan();
            });
        }
    }

    // Clamp focused row and apply highlight
    epgFocusedRowIdx = Math.min(epgFocusedRowIdx, Math.max(0, currentFilteredChannels.length - 1));
    updateEPGRowFocus();
}

function renderEPGGuide() {
    const guideWrap = document.getElementById('epgGuideWrap');
    if (!guideWrap) return;
    if (guideWrap.clientWidth <= 0) { requestAnimationFrame(renderEPGGuide); return; }

    renderChannelList(); // always updates currentFilteredChannels (exits early for Xtream after filtering)

    const now = Date.now();
    const HOUR_MS = 3600000;
    const pastH = epgPastHours();
    const winHours = pastH + EPG_AHEAD_HOURS;
    const winStart = Math.floor((now - pastH * HOUR_MS) / HOUR_MS) * HOUR_MS;
    const winEnd = winStart + winHours * HOUR_MS;

    if (winStart !== _epgSkeletonWinStart || winHours !== EPG_WIN_HOURS) {
        const keepX = EPG_WIN_HOURS === winHours ? 0 : -1; // a different window width invalidates the pan
        EPG_WIN_HOURS = winHours;
        rebuildEPGSkeleton(winStart, winEnd);
        if (keepX < 0) _epgX = 0;
    }
    refreshEPGRows();
}

function updateEPGInfoPanel(ch) {
    const logo = document.getElementById('epgInfoLogo');
    const name = document.getElementById('epgInfoName');
    const time = document.getElementById('epgInfoTime');
    const title = document.getElementById('epgInfoTitle');
    const desc = document.getElementById('epgInfoDesc');
    const favBtn = document.getElementById('epgInfoFavBtn');
    if (!name) return;

    if (ch.tvgLogo) { logo.src = ch.tvgLogo; logo.style.display = ''; }
    else logo.style.display = 'none';

    name.textContent = ch.name;
    const groupEl = document.getElementById('epgInfoGroup');
    if (groupEl) groupEl.textContent = ch.group || '';

    if (favBtn) {
        const favId = favIdOf(ch, getChannelIndex(ch));
        favBtn.dataset.favId = favId;
        const isFav = favoriteIds.has(favId);
        favBtn.textContent = isFav ? '★' : '☆';
        favBtn.classList.toggle('fav-active', isFav);
    }

    const nowPlayingLabel = document.getElementById('epgInfoNowPlayingLabel');
    const curr = getCurrentProgramme(ch.tvgId);
    if (curr) {
        const minsLeft = Math.max(0, Math.ceil((curr.stop - Date.now()) / 60000));
        time.textContent = `${formatClock(curr.start)} – ${formatClock(curr.stop)}  (${formatDuration(minsLeft)})`;
        title.textContent = curr.title;
        desc.textContent = curr.desc || '';
        if (nowPlayingLabel) nowPlayingLabel.style.display = '';
    } else {
        const placeholder = epgPlaceholderText(ch.tvgId);
        time.textContent = '';
        title.textContent = placeholder;
        desc.textContent = '';
        if (nowPlayingLabel) nowPlayingLabel.style.display = 'none';
    }

    const upNextEl = document.getElementById('epgInfoUpNext');
    const nextTimeEl = document.getElementById('epgInfoNextTime');
    const nextTitleEl = document.getElementById('epgInfoNextTitle');
    const nextDescEl = document.getElementById('epgInfoNextDesc');
    const next = getNextProgramme(ch.tvgId);
    if (upNextEl && next) {
        nextTimeEl.textContent = `${formatClock(next.start)} – ${formatClock(next.stop)}`;
        nextTitleEl.textContent = next.title;
        nextDescEl.textContent = next.desc || '';
        upNextEl.style.display = '';
    } else if (upNextEl) {
        upNextEl.style.display = 'none';
    }
}

function unescapeXml(s) {
    if (!s || s.indexOf('&') === -1) return s;
    return s
        .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

function decodeBase64Field(s) {
    if (!s || s.length % 4 !== 0 || !_RE_B64.test(s)) return s || '';
    try {
        const bytes = Uint8Array.from(atob(s), c => c.charCodeAt(0));
        // Try UTF-8 first — atob() gives raw bytes as Latin-1 chars, which
        // produces mojibake when the actual content is multi-byte UTF-8.
        try {
            const r = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (r.length > 0 && _RE_B64_ALPHA.test(r)) return r;
        } catch (_) { /* not valid UTF-8 */ }
        // Fallback: treat as Latin-1
        const r = String.fromCharCode(...bytes);
        let ok = r.length > 0;
        for (let ci = 0; ok && ci < r.length; ci++) {
            const c = r.charCodeAt(ci);
            if (c < 0x20 && c !== 0x09 && c !== 0x0A) ok = false;
        }
        if (ok && _RE_B64_ALPHA.test(r)) return r;
    } catch (e) { }
    return s;
}

// ── Xtream lazy EPG (per channel, on demand) ─────────────────
// Fetching get_short_epg for every channel up front took minutes on large
// providers (17k channels ≈ 17k requests). Instead EPG is fetched only for
// rows that are on screen, for the playing channel, and in the background
// for favorites. Results live in epgData with a TTL and LRU eviction.
function resetLazyEpg() {
    _xt = null;
    _xtStreamIdByTvgId = new Map();
    _epgFetchMeta.clear();
    _epgQueue = [];
    _epgQueued.clear();
    _epgPrefetchActive = false;
    if (_epgVisibleFetchTimer) { clearTimeout(_epgVisibleFetchTimer); _epgVisibleFetchTimer = null; }
}

function epgNeedsFetch(tvgId) {
    if (!_xt || !tvgId) return false;
    const m = _epgFetchMeta.get(tvgId);
    if (!m) return true;
    if (m.status === 'pending') return false;
    return (Date.now() - m.at) > EPG_CACHE_TTL_MS;
}

// Placeholder text for a guide row / info panel that has no programme blocks
function epgPlaceholderText(tvgId) {
    if (_xt) {
        if (!tvgId || !_xtStreamIdByTvgId.has(tvgId)) return 'No data available ...';
        const m = _epgFetchMeta.get(tvgId);
        if (!m || m.status === 'pending') return 'Loading ...';
        return 'No data available ...';
    }
    return epgLoading ? 'Loading ...' : 'No data available ...';
}

// Queue channels for EPG fetch. front=true puts them ahead of everything queued
// (visible rows / playing channel); front=false appends (favorites prefetch).
function queueEpgFetch(tvgIds, front) {
    if (!_xt) return;
    const add = [];
    for (const id of tvgIds) {
        if (!id) continue;
        if (_epgQueued.has(id)) { if (front) add.push(id); continue; }
        if (!epgNeedsFetch(id)) continue;
        _epgQueued.add(id);
        _epgFetchMeta.set(id, { at: 0, status: 'pending' });
        add.push(id);
    }
    if (add.length) {
        if (front) {
            const addSet = new Set(add);
            _epgQueue = add.concat(_epgQueue.filter(x => !addSet.has(x)));
        } else {
            _epgQueue = _epgQueue.concat(add);
        }
        // Bound the backlog: drop the lowest-priority tail; it is re-queued if it scrolls into view
        while (_epgQueue.length > EPG_QUEUE_MAX) {
            const dropped = _epgQueue.pop();
            _epgQueued.delete(dropped);
            _epgFetchMeta.delete(dropped);
        }
    }
    pumpEpgQueue();
}

// Request starts are spaced out: the provider answers bursts of get_short_epg with empty listings
// (measured on the C4 2026-10-07: 60 parallel requests → 15 with data; the same ids one at a time → all with data)
let _epgLastStart = 0, _epgPumpTimer = null;
function pumpEpgQueue() {
    while (_epgInFlight < EPG_FETCH_CONCURRENCY && _epgQueue.length) {
        const wait = _epgLastStart + EPG_FETCH_SPACING_MS - Date.now();
        if (wait > 0) { if (!_epgPumpTimer) _epgPumpTimer = setTimeout(() => { _epgPumpTimer = null; pumpEpgQueue(); }, wait); return; }
        _epgLastStart = Date.now();
        const id = _epgQueue.shift();
        _epgQueued.delete(id);
        _epgInFlight++;
        fetchXtreamEpgFor(id).then(null, () => {}).then(() => { _epgInFlight--; pumpEpgQueue(); });
    }
    if (_epgPrefetchActive && !_epgQueue.length && !_epgInFlight) {
        _epgPrefetchActive = false;
        showEPGToast('Favorites guide ready', 'success');
        hideEPGToast(2500);
        if (currentChannelIndex >= 0 && channels[currentChannelIndex]) statusArea.innerText = `▶️ ${channels[currentChannelIndex].name}`;
    }
}

async function fetchXtreamEpgFor(tvgId) {
    const xt = _xt;
    const streamId = xt ? _xtStreamIdByTvgId.get(tvgId) : undefined;
    if (!xt || streamId === undefined) { _epgFetchMeta.set(tvgId, { at: Date.now(), status: 'done' }); return; }
    const progs = [];
    let ok = false;
    try {
        const resp = await fetch(`${xt.base}/player_api.php?username=${xt.u}&password=${xt.pw}&action=get_short_epg&stream_id=${streamId}&limit=${EPG_XT_LIMIT}`);
        if (resp.ok) {
            const data = await resp.json();
            ok = true;
            const listings = data && data.epg_listings;
            if (Array.isArray(listings)) {
                const cutoff = Date.now() - 2 * 3600000; // keep a little history for the 1h-back guide window
                if (listings.length) xtreamNoteEpgOffset(listings[0]);
                for (const ep of listings) {
                    const pStart = epgShiftTime(parseInt(ep.start_timestamp) * 1000);
                    const pStop = epgShiftTime(parseInt(ep.stop_timestamp) * 1000);
                    if (isNaN(pStart) || isNaN(pStop) || pStop < cutoff) continue;
                    const title = unescapeXml(decodeBase64Field(ep.title || '').trim());
                    const rawDesc = unescapeXml(decodeBase64Field(ep.description || '').trim());
                    progs.push({ start: pStart, stop: pStop, title, desc: rawDesc.replace(_RE_TS_INJECT, '').trim() });
                }
                progs.sort((a, b) => a.start - b.start);
            }
        }
    } catch (_) { /* network error — becomes eligible for retry below */ }
    if (_xt !== xt) return; // playlist changed while this request was in flight
    // A failed fetch is retried after 60 s instead of waiting out the full TTL. An empty answer is retried after
    // EPG_EMPTY_RETRY_MS (providers return empty lists under load) and never replaces data already held.
    const empty = ok && !progs.length;
    _epgFetchMeta.set(tvgId, { at: ok ? (empty ? Date.now() - EPG_CACHE_TTL_MS + EPG_EMPTY_RETRY_MS : Date.now()) : Date.now() - EPG_CACHE_TTL_MS + 60000, status: ok ? 'done' : 'error' });
    if (ok && progs.length) epgPersist(tvgId, Date.now(), epgShiftProgs(progs, -1)); // cache keeps provider time
    if (empty && epgData.has(tvgId)) { onEpgChannelUpdated(tvgId); return; } // keep what we have (stale beats blank)
    if (progs.length) {
        epgData.delete(tvgId); // re-insert so Map insertion order doubles as LRU order
        epgData.set(tvgId, progs);
        epgIdMap.set(tvgId.toLowerCase(), tvgId);
        if (epgData.size > EPG_CACHE_MAX) {
            for (const k of epgData.keys()) {
                if (epgData.size <= EPG_CACHE_MAX) break;
                epgData.delete(k);
                _epgFetchMeta.delete(k);
            }
        }
    } else {
        epgData.delete(tvgId);
    }
    onEpgChannelUpdated(tvgId);
}

// Refresh whatever is on screen for this channel, in place. Completed fetches arrive in bursts after a
// scroll stops, so they are batched: one animation frame swaps the programme area of every affected
// row, and only that area (the label and its logo stay; rebuilding whole rows re-decoded every logo).
const _epgDirtyIds = new Set();
let _epgDirtyRaf = 0;
function onEpgChannelUpdated(tvgId) {
    if (currentPlaylistType !== 'xtream') return;
    _epgDirtyIds.add(tvgId);
    if (!_epgDirtyRaf) _epgDirtyRaf = requestAnimationFrame(flushEpgRowUpdates);
}
function flushEpgRowUpdates() {
    _epgDirtyRaf = 0;
    const ids = new Set(_epgDirtyIds);
    _epgDirtyIds.clear();
    if (!ids.size) return;
    const sc = surfChannel(); if (sc && sc.tvgId && ids.has(sc.tvgId) && livePlayer.active) updateLiveOsd(); // previewed channel's programme arrived
    if (epgMode) {
        for (const [idx, el] of epgRenderedRows) {
            const ch = currentFilteredChannels[idx];
            if (!ch || !ids.has(ch.tvgId)) continue;
            const progs = el.querySelector('.epg-progs-clip');
            if (progs) progs.outerHTML = epgProgsHtml(ch);
        }
        updateEPGBlockFocus(); // the focused row's blocks may have been replaced
    }
    const cur = currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
    if (cur && ids.has(cur.tvgId)) {
        if (epgMode) updateEPGInfoPanel(cur);
        updateNowNext();
    }
}

// Debounced: once scrolling settles, load the logos of the rendered rows and fetch EPG for them
// (front of the queue), then prefetch the next rows in the direction of travel so they are already
// filled in when they scroll into view (back of the queue; dropped first when the backlog is full).
const EPG_LOOKAHEAD_ROWS = 12;
function scheduleEpgFetchForVisible() {
    if (_epgVisibleFetchTimer) clearTimeout(_epgVisibleFetchTimer);
    _epgVisibleFetchTimer = setTimeout(epgOnScrollSettled, 150);
}
function epgOnScrollSettled() {
    _epgVisibleFetchTimer = null;
    if (!epgMode) return;
    epgLoadVisibleLogos();
    if (!_xt) return;
    const ids = [];
    let lo = Infinity, hi = -1;
    for (const idx of epgRenderedRows.keys()) {
        if (idx < lo) lo = idx;
        if (idx > hi) hi = idx;
        const ch = currentFilteredChannels[idx];
        if (ch && ch.tvgId) ids.push(ch.tvgId);
    }
    if (ids.length) queueEpgFetch(ids, true);
    if (hi < 0) return;
    const ahead = [];
    const from = _epgScrollDir >= 0 ? hi + 1 : Math.max(0, lo - EPG_LOOKAHEAD_ROWS);
    const to = _epgScrollDir >= 0 ? Math.min(currentFilteredChannels.length - 1, hi + EPG_LOOKAHEAD_ROWS) : lo - 1;
    for (let i = from; i <= to; i++) { const ch = currentFilteredChannels[i]; if (ch && ch.tvgId) ahead.push(ch.tvgId); }
    if (ahead.length) queueEpgFetch(ahead, false);
}

// Background prefetch so the Favorites group is populated without scrolling
function prefetchFavoritesEpg() {
    if (!_xt) return;
    const ids = new Set();
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        if (ch.tvgId && favoriteIds.has(favIdOf(ch, i)) && epgNeedsFetch(ch.tvgId)) ids.add(ch.tvgId);
    }
    if (!ids.size) return;
    _epgPrefetchActive = true;
    showEPGToast(`Loading guide for ${ids.size.toLocaleString()} favorites …`, 'loading');
    queueEpgFetch([...ids], false);
}

// ── Minute tick ───────────────────────────────────────────────
function startEpgTick() {
    if (epgRefreshTimer) clearInterval(epgRefreshTimer);
    epgRefreshTimer = setInterval(epgMinuteTick, 60000);
}

// Runs once a minute. Updates only what is on screen, in place; the full guide
// is rebuilt only when the hour window rolls over.
function epgMinuteTick() {
    const now = Date.now();
    if (currentPlaylistType === 'xtream' && epgMode && vodMode === 'live') {
        const HOUR_MS = 3600000;
        // Same window origin as renderEPGGuide (catch-up playlists start days back, not 1 h): with a 1 h
        // lookback here every tick looked like a rollover and panned the guide an hour into the past per minute
        const winStart = Math.floor((now - epgPastHours() * HOUR_MS) / HOUR_MS) * HOUR_MS;
        if (_epgSkeletonWinStart && winStart !== _epgSkeletonWinStart) {
            // Hour rolled over: shift the horizontal scroll so the same wall-clock
            // time stays in view, then rebuild the time strip and rows once.
            _epgX = Math.max(0, _epgX - 60 * EPG_PX_PER_MIN);
            renderEPGGuide();
        } else {
            updateEPGNowMarker();
            for (const [, el] of epgRenderedRows) {
                const blocks = el.getElementsByClassName('epg-prog-block');
                for (let i = 0; i < blocks.length; i++) {
                    const b = blocks[i];
                    b.classList.toggle('now-playing', +b.dataset.start <= now && +b.dataset.stop > now);
                }
            }
            scheduleEpgFetchForVisible(); // re-queues rows whose cached EPG passed its TTL
        }
        if (currentChannelIndex >= 0 && channels[currentChannelIndex]) updateEPGInfoPanel(channels[currentChannelIndex]);
    } else if (currentPlaylistType === 'm3u') {
        // Refresh the "now" line of visible channel rows in place
        for (const [idx, el] of renderedItems) {
            const ch = currentFilteredChannels[idx];
            const span = el.querySelector('.channel-epg');
            if (!ch || !span) continue;
            const p = getCurrentProgramme(ch.tvgId);
            span.textContent = p ? (p.title.length > 36 ? p.title.substring(0, 34) + '…' : p.title) : '';
        }
        // Re-download the XMLTV feed periodically so the 6h window never runs dry
        if (currentEpgUrl && !epgLoading && _epgLoadedAt && now - _epgLoadedAt > EPG_M3U_REFRESH_MS) loadEPG(currentEpgUrl);
    }
    updateNowNext();
    if (livePlayer.active && document.getElementById('vodOsd').classList.contains('visible')) updateLiveOsd();
}

async function loadXtreamPlaylist(serverUrl, username, password) {
    if (isLoading) return;
    isLoading = true;
    resetLazyEpg();
    resetVodState(false);
    epgData.clear();
    epgIdMap.clear();
    setLoadSelectedButtonEnabled(false);
    updateStartStatus('Connecting to Xtream API …', false, false, true, 0);
    showLoading(true, 'Connecting to Xtream API …');

    const base = serverUrl.replace(/\/$/, '');
    const u = encodeURIComponent(username);
    const pw = encodeURIComponent(password);

    try {
        const key = 'x:' + base + '|' + username;
        const cached = await cacheGet('playlists', key);
        if (cached && Array.isArray(cached.channels) && cached.channels.length) {
            applyXtreamChannels(cached.channels, base, username, password, true, cached.tz || '', cached.epgOffsetMin);
            _playlistCacheAt = cached.at || 0;
            setTimeout(() => refreshPlaylistInBackground(false), 2500);
            return;
        }

        // 1. Authenticate (only on a fresh load; a cached list is trusted until the background refresh)
        const authResp = await fetch(`${base}/player_api.php?username=${u}&password=${pw}`);
        if (!authResp.ok) throw new Error(`Auth HTTP ${authResp.status}`);
        const authData = await authResp.json();
        if (authData.user_info && authData.user_info.auth === 0) throw new Error('Invalid username or password');
        updateStartStatus('Authenticated! Loading categories …', false, false, true, 15);
        const tz = (authData.server_info && authData.server_info.timezone) || 'UTC';

        const parsed = await xtreamFetchChannels(base, username, password, (msg, pct) => updateStartStatus(msg, false, false, true, pct));
        applyXtreamChannels(parsed, base, username, password, false, tz);
        _playlistCacheAt = Date.now();
        cachePut('playlists', key, { at: _playlistCacheAt, type: 'xtream', channels: parsed, tz });
    } catch (err) {
        updateStartStatus(`Error: ${err.message}`, true, false, false, 0);
        setLoadSelectedButtonEnabled(true);
    } finally {
        isLoading = false;
        showLoading(false);
        setTimeout(() => { if (!startPage.classList.contains('hidden')) updateStartStatus('Ready', false, false, false, 0); }, 3000);
    }
}
// Categories + live streams from the provider, mapped to the internal channel shape in batches.
// progress(msg, pct) is optional (the start page shows it; the background refresh passes null).
async function xtreamFetchChannels(base, username, password, progress) {
    const u = encodeURIComponent(username), pw = encodeURIComponent(password);
    const note = (msg, pct) => { if (progress) progress(msg, pct); };
    let catMap = {};
    try {
        const catResp = await fetch(`${base}/player_api.php?username=${u}&password=${pw}&action=get_live_categories`);
        if (catResp.ok) {
            const cats = await catResp.json();
            if (Array.isArray(cats)) cats.forEach(c => { catMap[String(c.category_id)] = c.category_name; });
        }
    } catch { /* categories are optional */ }
    note('Loading channel list …', 30);
    const streamsResp = await fetch(`${base}/player_api.php?username=${u}&password=${pw}&action=get_live_streams`);
    if (!streamsResp.ok) throw new Error(`Streams HTTP ${streamsResp.status}`);
    const streamsText = await streamsResp.text();
    note('Parsing channels …', 55);
    await new Promise(r => setTimeout(r, 0)); // yield before heavy JSON parse
    const streams = JSON.parse(streamsText);
    if (!Array.isArray(streams) || !streams.length) throw new Error('No live channels found');
    const parsed = [];
    const BATCH = 5000;
    for (let i = 0; i < streams.length; i += BATCH) {
        const slice = streams.slice(i, i + BATCH);
        for (const s of slice) {
            const num = parseInt(s.num);
            const archiveDays = String(s.tv_archive) === '1' ? (parseInt(s.tv_archive_duration) || 0) : 0;
            parsed.push({
                name: s.name || 'Unknown',
                tvgId: s.epg_channel_id || String(s.stream_id),
                tvgLogo: s.stream_icon || '',
                group: catMap[String(s.category_id)] || '',
                url: `${base}/live/${username}/${password}/${s.stream_id}.m3u8`,
                streamId: s.stream_id,
                num: isNaN(num) ? 0 : num,          // provider channel number (direct entry with the digit keys)
                archive: archiveDays,               // catch-up days offered by the provider, 0 = none
            });
        }
        note(`Parsed ${parsed.length.toLocaleString()} channels …`, Math.min(90, 55 + Math.round((i / streams.length) * 35)));
        await new Promise(r => setTimeout(r, 5));
    }
    return parsed;
}
// Everything after an Xtream channel list is available (parsed fresh or read from the cache)
function applyXtreamChannels(parsed, base, username, password, fromCache, tz, epgOffsetMin) {
    channels = parsed;
    buildChannelIndexMap();
    _xt = { base, u: encodeURIComponent(username), pw: encodeURIComponent(password), user: username, pass: password, tz: tz || '' };
    if (typeof epgOffsetMin === 'number') _xt.epgOffsetMin = epgOffsetMin;
    if (!_xt.tz) xtreamEnsureServerInfo(); // timeshift start times need the server timezone
    catchup = null; epgFocusT = 0; _epgFullFetched.clear(); _epgFullPending.clear();
    resetVodState(true); // show the Live / Movies / Series switch
    _xtStreamIdByTvgId = new Map();
    for (const ch of parsed) if (!_xtStreamIdByTvgId.has(ch.tvgId)) _xtStreamIdByTvgId.set(ch.tvgId, ch.streamId);
    localStorage.setItem('last_m3u_url', ''); // clear M3U cache; Xtream uses its own auth
    updateStartStatus(`Loaded ${channels.length.toLocaleString()} channels${fromCache ? ' (cached)' : ''}!`, false, true, false, 100);
    currentSearchQuery = '';
    searchInput.value = '';
    _activePlaylistKey = 'x:' + base + '|' + username;
    epgOffsetLoad();
    favoritesLoad();
    _m3uSource = null;
    rememberLastPlaylist(_activePlaylistKey);
    currentGroup = initialGroupFor(_activePlaylistKey);
    currentPlaylistType = 'xtream';
    extractGroups();
    validateCurrentGroup();
    startPage.classList.add('hidden');
    mainApp.style.display = 'flex';
    perfMark(`channels-applied(${channels.length}${fromCache ? ',cache' : ''})`);
    enterEPGMode(); // switch to guide layout immediately; programme blocks fill in as EPG loads
    perfMark('guide-rendered');
    statusArea.innerText = `✅ ${channels.length.toLocaleString()} channels`;
    if (channels.length) setTimeout(selectInitialChannel, 500);
    // EPG is fetched lazily per visible row (see "Xtream lazy EPG"): cached entries first, then favorites in the background
    startEpgTick();
    const key = _activePlaylistKey;
    epgRestoreFromCache(key).then(n => { perfMark(`epg-cache-restored(${n})`); if (_activePlaylistKey === key) setTimeout(prefetchFavoritesEpg, 800); });
}

// ----- Saved Playlists Management -----
function loadSavedPlaylists() {
    const saved = localStorage.getItem('iptv_playlists');
    if (saved) try { savedPlaylists = JSON.parse(saved); } catch (e) { }
    renderSavedPlaylists();
}
function savePlaylistsToStorage() { localStorage.setItem('iptv_playlists', JSON.stringify(savedPlaylists)); renderSavedPlaylists(); }
function addPlaylist(url, name, epgUrl) {
    if (!url) return;
    const existing = savedPlaylists.find(p => p.url === url);
    if (existing) {
        existing.name = name || existing.name;
        existing.epgUrl = epgUrl !== undefined ? epgUrl : (existing.epgUrl || '');
        savePlaylistsToStorage();
        updateStartStatus(`Playlist "${existing.name}" updated!`, false, true, false, 0);
    } else {
        savedPlaylists.push({ name: name || url.substring(0, 40), url, epgUrl: epgUrl || '' });
        savePlaylistsToStorage();
        updateStartStatus(`Playlist saved!`, false, true, false, 0);
    }
    setTimeout(() => updateStartStatus('Ready', false, false, false, 0), 2000);
    newM3uUrl.value = '';
    newM3uName.value = '';
    updateFocusableElements();
    focusElement(0);
}
function removePlaylist(idx) { savedPlaylists.splice(idx, 1); savePlaylistsToStorage(); if (selectedPlaylistId === idx) { selectedPlaylistId = null; setLoadSelectedButtonEnabled(false); } updateFocusableElements(); focusElement(0); }
function clearAllPlaylists() { savedPlaylists = []; selectedPlaylistId = null; savePlaylistsToStorage(); setLoadSelectedButtonEnabled(false); updateFocusableElements(); focusElement(0); updateStartStatus('All playlists cleared', false, true, false, 0); setTimeout(() => updateStartStatus('Ready', false, false, false, 0), 2000); }
function renderSavedPlaylists() {
    const container = document.getElementById('savedSourcesList');
    if (!container) return;
    if (!savedPlaylists.length) {
        container.innerHTML = '<div class="empty-saved">No saved playlists yet. Add one below!</div>';
        updateFocusableElements();
        return;
    }
    container.innerHTML = '';
    savedPlaylists.forEach((p, idx) => {
        const div = document.createElement('div');
        div.className = 'saved-item';
        div.onclick = () => {
            document.querySelectorAll('.saved-item').forEach(i => i.style.background = '#1e2028');
            div.style.background = '#2a3a70';
            selectedPlaylistId = idx;
            setLoadSelectedButtonEnabled(true);
            if (p.type === 'xtream') {
                switchTab('xtream');
                xtreamServer.value = p.url;
                xtreamUsername.value = p.username || '';
                xtreamPassword.value = p.password || '';
                xtreamName.value = p.name || '';
            } else {
                switchTab('m3u');
                newM3uUrl.value = p.url;
                newM3uName.value = p.name;
                newEpgUrl.value = p.epgUrl || '';
            }
        };
        let displayUrl, subLine = '';
        if (p.type === 'xtream') {
            try { displayUrl = `🔑 ${p.username}@${new URL(p.url).host}`; } catch { displayUrl = `🔑 ${p.username}@${p.url}`; }
        } else {
            displayUrl = p.url.substring(0, 54) + (p.url.length > 54 ? '…' : '');
            if (p.epgUrl) subLine = `<div class="saved-epg">📅 ${p.epgUrl.substring(0, 50)}${p.epgUrl.length > 50 ? '…' : ''}</div>`;
        }
        div.innerHTML = `<div class="saved-info"><div class="saved-name">${escapeHtml(p.name)}</div><div class="saved-url">${escapeHtml(displayUrl)}</div>${subLine}</div>
            <div class="saved-actions"><button class="edit-saved" onclick="event.stopPropagation(); editPlaylist(${idx});">✏️</button>
            <button class="delete-saved" onclick="event.stopPropagation(); removePlaylist(${idx});">✕</button></div>`;
        container.appendChild(div);
    });
    updateFocusableElements();
}

// ----- Remote Navigation for Start Page -----
let focusableElements = [];
let currentFocusIndex = 0;
function updateFocusableElements() {
    if (!startPage.classList.contains('hidden')) {
        focusableElements = [];
        if (clearAllBtn) focusableElements.push(clearAllBtn);
        document.querySelectorAll('.saved-item').forEach(el => focusableElements.push(el));
        if (tabXtream) focusableElements.push(tabXtream);
        if (tabM3u) focusableElements.push(tabM3u);
        if (activeTab === 'm3u') {
            if (newM3uUrl) focusableElements.push(newM3uUrl);
            if (newEpgUrl) focusableElements.push(newEpgUrl);
            if (newM3uName) focusableElements.push(newM3uName);
            if (saveNewBtn) focusableElements.push(saveNewBtn);
            if (startDemoBtn) focusableElements.push(startDemoBtn);
        } else {
            if (xtreamServer) focusableElements.push(xtreamServer);
            if (xtreamUsername) focusableElements.push(xtreamUsername);
            if (xtreamPassword) focusableElements.push(xtreamPassword);
            if (xtreamName) focusableElements.push(xtreamName);
            if (saveXtreamBtn) focusableElements.push(saveXtreamBtn);
        }
        if (loadSelectedBtn && !loadSelectedBtn.disabled) focusableElements.push(loadSelectedBtn);
        const sb = document.getElementById('settingsBtn');
        if (sb) focusableElements.push(sb);
    }
}
function focusElement(idx) {
    if (!focusableElements.length) return;
    if (idx < 0) idx = 0;
    if (idx >= focusableElements.length) idx = focusableElements.length - 1;
    currentFocusIndex = idx;
    const el = focusableElements[currentFocusIndex];
    if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
}
// ----- VOD (Movies & Series) -----
// Xtream playlists get a Live / Movies / Series mode switch. Catalogs load per
// category on demand; the full list is fetched once (in the background) for
// Recently Added and "Search all". Playback reuses the single <video>, moved
// into an app-owned full-viewport container so the OSD can draw over it.
const VOD_COLS = 6;
const VOD_PROGRESS_MAX = 300;
const VOD_MIN_RESUME_S = 120;   // nothing counts as "in progress" before 2 minutes (10% for very short items)
function vodMinResume(dur) { return dur > 0 ? Math.min(VOD_MIN_RESUME_S, dur * 0.1) : VOD_MIN_RESUME_S; }
const VOD_NEXT_COUNTDOWN = 10;
let vodGrid = { cols: VOD_COLS, cardW: 0, rowH: 0, total: 0 };
const vodGridRows = new Map(); // rowIdx -> element
let _vodSearchTimer = null;

function loadJson(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v === null || v === undefined ? fallback : v; } catch (_) { return fallback; }
}
function saveJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* storage unavailable */ } }
function isAdultName(n) { return /adult|xxx|18\+|porn|erotic|\bsex\b/i.test(n || ''); }
function fmtClock(secs) {
    secs = Math.max(0, Math.floor(secs || 0));
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}
function fmtRuntime(secs) {
    if (!secs) return '';
    if (secs < 60) return '< 1 min';
    const m = Math.round(secs / 60);
    return m >= 60 ? `${Math.floor(m / 60)} hr ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
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
function yearOf(s) { const m = String(s || '').match(/(19|20)\d{2}/); return m ? m[0] : ''; }
function el(tag, cls, html) { const d = document.createElement(tag); if (cls) d.className = cls; if (html !== undefined) d.innerHTML = html; return d; }

function xtApi(action, params) {
    if (!_xt) return Promise.reject(new Error('No Xtream playlist loaded'));
    let url = `${_xt.base}/player_api.php?username=${_xt.u}&password=${_xt.pw}&action=${action}`;
    for (const k in params || {}) if (params[k] !== undefined && params[k] !== null) url += `&${k}=${encodeURIComponent(params[k])}`;
    return fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}
function normMovie(s) {
    return { kind: 'movie', id: String(s.stream_id), name: s.name || 'Untitled', icon: s.stream_icon || '', rating: parseFloat(s.rating) || 0,
             added: (parseInt(s.added) || 0) * 1000, ext: s.container_extension || 'mp4', catId: String(s.category_id),
             genre: s.genre || '', releaseDate: s.releasedate || s.release_date || s.releaseDate || (s.year ? String(s.year) : '') };
}
// ── sort & genre filter (Green in the grid) ──────────────────
const VOD_SORTS = [{ v: 'default', label: 'Provider order' }, { v: 'added', label: 'Newest added' }, { v: 'az', label: 'A – Z' }, { v: 'year', label: 'Year (newest)' }, { v: 'rating', label: 'Rating' }];
function vodSortItems(items, sort) {
    if (!sort || sort === 'default') return items;
    const out = items.slice();
    if (sort === 'added') out.sort((a, b) => (b.added || 0) - (a.added || 0));
    else if (sort === 'az') out.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'year') out.sort((a, b) => (yearOf(b.releaseDate) || 0) - (yearOf(a.releaseDate) || 0));
    else if (sort === 'rating') out.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    return out;
}
function itemGenres(it) { return String(it.genre || '').split(/[,/|]/).map(g => g.trim()).filter(Boolean); }
// Genres present in the current base list, most frequent first (capped so the menu stays usable)
function vodGenreOptions(items) {
    const count = new Map();
    for (const it of items) for (const g of itemGenres(it)) count.set(g, (count.get(g) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).map(([g, n]) => ({ g, n }));
}
function vodFilterGenre(items, genre) { return genre ? items.filter(it => itemGenres(it).includes(genre)) : items; }
// Items shown in the grid: base list → genre → search → sort (search keeps its own relevance order)
function vodDerivedItems() {
    const q = (vodNav.query || '').trim();
    const base = vodFilterGenre(vodNav.baseItems, vodNav.genre);
    return q ? vodSearchItems(base, q) : vodSortItems(base, vodNav.sort);
}
function vodSortLabel() { const s = VOD_SORTS.find(x => x.v === vodNav.sort); return s && s.v !== 'default' ? s.label : ''; }
let vodSortOpen = false, vodSortFocus = 0, _vodSortRows = [];
function openVodSort() {
    if (vodMode === 'live' || vodNav.screen !== 'grid') return;
    const ov = document.getElementById('vodSortOverlay'); if (!ov) return;
    vodSortOpen = true;
    const genres = vodGenreOptions(vodNav.baseItems);
    _vodSortRows = VOD_SORTS.map(s => ({ kind: 'sort', v: s.v, label: s.label }))
        .concat([{ kind: 'genre', v: null, label: 'All genres' }], genres.map(x => ({ kind: 'genre', v: x.g, label: x.g, n: x.n })));
    vodSortFocus = Math.max(0, _vodSortRows.findIndex(r => r.kind === 'sort' && r.v === (vodNav.sort || 'default')));
    ov.classList.remove('hidden');
    renderVodSort();
}
function closeVodSort() {
    if (!vodSortOpen) return;
    vodSortOpen = false;
    const ov = document.getElementById('vodSortOverlay'); if (ov) ov.classList.add('hidden');
    const list = document.getElementById('vodSortList'); if (list) list.innerHTML = '';
}
function renderVodSort() {
    const list = document.getElementById('vodSortList'); if (!list) return;
    list.innerHTML = '';
    let lastKind = null;
    _vodSortRows.forEach((r, i) => {
        if (r.kind !== lastKind) { const h = document.createElement('div'); h.className = 'settings-section'; h.textContent = r.kind === 'sort' ? 'Sort by' : 'Genre'; list.appendChild(h); lastKind = r.kind; }
        const on = r.kind === 'sort' ? (vodNav.sort || 'default') === r.v : (vodNav.genre || null) === r.v;
        const row = document.createElement('div');
        row.className = 'settings-row cats-row' + (i === vodSortFocus ? ' focused' : '') + (on ? ' on' : '');
        row.innerHTML = `<div class="settings-label"><div class="settings-name">${escapeHtml(r.label)}${r.n ? ` <span class="settings-sub">${r.n}</span>` : ''}</div></div><div class="settings-value"><span class="settings-val">${on ? '●' : ''}</span></div>`;
        row.addEventListener('click', () => { vodSortFocus = i; vodSortActivate(); });
        list.appendChild(row);
    });
    const f = list.querySelector('.cats-row.focused'); if (f) f.scrollIntoView({ block: 'nearest' });
}
function vodSortActivate() {
    const r = _vodSortRows[vodSortFocus]; if (!r) return;
    if (r.kind === 'sort') { vodNav.sort = r.v; if (_activePlaylistKey) { getPlaylistState(_activePlaylistKey).vodSort = r.v; savePlaylistState(); } }
    else vodNav.genre = r.v;
    vodNav.items = vodDerivedItems();
    vodNav.focus = 0; vodNav.gridScroll = 0;
    renderVodGrid();
    renderVodSort();
}
function handleVodSortKey(e) {
    const k = e.key, kc = e.keyCode;
    if (k === 'ArrowUp' || kc === 38) { e.preventDefault(); vodSortFocus = Math.max(0, vodSortFocus - 1); renderVodSort(); }
    else if (k === 'ArrowDown' || kc === 40) { e.preventDefault(); vodSortFocus = Math.min(_vodSortRows.length - 1, vodSortFocus + 1); renderVodSort(); }
    else if (k === 'Enter' || kc === 13) { e.preventDefault(); vodSortActivate(); }
    else if (kc === 404 || k === 'ColorF1Green') { e.preventDefault(); closeVodSort(); }
}
function normSeries(s) {
    return { kind: 'series', id: String(s.series_id), name: s.name || 'Untitled', icon: s.cover || '', rating: parseFloat(s.rating) || 0,
             added: (parseInt(s.last_modified) || 0) * 1000, catId: String(s.category_id), plot: s.plot || '', genre: s.genre || '',
             releaseDate: s.releaseDate || s.release_date || '', cast: s.cast || '', director: s.director || '', backdrop: Array.isArray(s.backdrop_path) ? s.backdrop_path[0] : '' };
}
function vodStreamUrl(id, ext) { return `${_xt.base}/movie/${_xt.user}/${_xt.pass}/${id}.${ext || 'mp4'}`; }
function episodeUrl(ep) { return `${_xt.base}/series/${_xt.user}/${_xt.pass}/${ep.id}.${ep.ext || 'mp4'}`; }

// ── catalog ──────────────────────────────────────────────────
async function loadVodCats(mode) {
    if (mode === 'movies' ? vodCats : seriesCats) return;
    const raw = await xtApi(mode === 'movies' ? 'get_vod_categories' : 'get_series_categories');
    const cats = Array.isArray(raw) ? raw.map(c => ({ id: String(c.category_id), name: c.category_name || '', adult: isAdultName(c.category_name) })) : [];
    if (mode === 'movies') vodCats = cats; else seriesCats = cats;
}
async function loadVodCategory(mode, catId) {
    const cache = mode === 'movies' ? vodByCat : seriesByCat;
    if (cache.has(catId)) return cache.get(catId);
    const raw = await xtApi(mode === 'movies' ? 'get_vod_streams' : 'get_series', { category_id: catId });
    const items = Array.isArray(raw) ? raw.map(mode === 'movies' ? normMovie : normSeries) : [];
    items.sort((a, b) => b.added - a.added);
    cache.set(catId, items);
    return items;
}
// Full catalog, fetched once per mode per session; chunk-parsed so the UI stays responsive
function loadVodAll(mode) {
    const have = mode === 'movies' ? vodAll : seriesAll;
    if (have) return Promise.resolve(have);
    if (_vodAllLoading && _vodAllLoading.mode === mode) return _vodAllLoading.p;
    const xt = _xt;
    const p = (async () => {
        const resp = await fetch(`${xt.base}/player_api.php?username=${xt.u}&password=${xt.pw}&action=${mode === 'movies' ? 'get_vod_streams' : 'get_series'}`);
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
        if (mode === 'movies') { vodAll = out; vodRecent = recent; } else { seriesAll = out; seriesRecent = recent; }
        return out;
    })();
    _vodAllLoading = { mode, p };
    p.then(() => { if (_vodAllLoading && _vodAllLoading.p === p) _vodAllLoading = null; }, () => { _vodAllLoading = null; });
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
        if (n === q) score = 100; else if (n.startsWith(q)) score = 90;
        else { let m = 0; for (const t of terms) if (n.includes(t)) m++; score = m === terms.length ? 60 : 0; }
        if (score) scored.push({ i, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => items[s.i]);
}

// ── favorites & progress ─────────────────────────────────────
function vodFavBucket() {
    const k = _activePlaylistKey || '_';
    if (!vodFavs[k]) vodFavs[k] = { movies: {}, series: {} };
    return vodFavs[k][vodMode === 'series' ? 'series' : 'movies'];
}
function isVodFav(item) { const k = _activePlaylistKey || '_'; const b = vodFavs[k]; return !!(b && b[item.kind === 'series' ? 'series' : 'movies'][item.id]); }
function toggleVodFav(item) {
    const k = _activePlaylistKey || '_';
    if (!vodFavs[k]) vodFavs[k] = { movies: {}, series: {} };
    const bucket = vodFavs[k][item.kind === 'series' ? 'series' : 'movies'];
    if (bucket[item.id]) delete bucket[item.id];
    else { const c = Object.assign({}, item); delete c._resume; bucket[item.id] = c; }
    saveJson('iptv_vod_favorites', vodFavs);
}
function vodFavItems() { return Object.values(vodFavBucket()).sort((a, b) => a.name.localeCompare(b.name)); }

function progressKeyFor(kind, id, seriesId) { return `${_activePlaylistKey || '_'}|` + (kind === 'movie' ? `m:${id}` : `e:${seriesId}:${id}`); }
function movieProgress(item) { const e = vodProgress[progressKeyFor('movie', item.id)]; return e && !e.watched && e.dur && e.pos >= vodMinResume(e.dur) ? e : null; }
function removeVodProgress(item) {
    const prefix = `${_activePlaylistKey || '_'}|`;
    if (item.kind === 'movie') delete vodProgress[prefix + 'm:' + item.id];
    else for (const k of Object.keys(vodProgress)) if (k.startsWith(prefix + 'e:' + item.id + ':')) delete vodProgress[k];
    saveJson('iptv_vod_progress', vodProgress);
}
function episodeProgress(seriesId, epId) { return vodProgress[progressKeyFor('episode', epId, seriesId)] || null; }
// Manual watched state (details page button for movies, Red on an episode row for series)
function isMovieWatched(item) { const e = vodProgress[progressKeyFor('movie', item.id)]; return !!(e && e.watched); }
function setMovieWatched(item, info, on) {
    const key = progressKeyFor('movie', item.id);
    if (!on) delete vodProgress[key];
    else {
        const dur = (info && info.duration) || (vodProgress[key] && vodProgress[key].dur) || 1;
        vodProgress[key] = { kind: 'movie', id: item.id, name: item.name, icon: item.icon, ext: item.ext, catId: item.catId, rating: item.rating || 0, pos: dur, dur, at: Date.now(), watched: true };
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
    if (!on) delete vodProgress[key];
    else {
        const dur = ep.duration || (vodProgress[key] && vodProgress[key].dur) || 1;
        vodProgress[key] = { kind: 'episode', id: ep.id, name: item.name, icon: item.icon, catId: item.catId, rating: item.rating || 0, pos: dur, dur, at: Date.now(), watched: true,
                             seriesId: item.id, season: ep.season, epNum: ep.num, epTitle: ep.title, epId: ep.id, lastOfSeries: episodeIsLast(seasons, ep) };
    }
    if (noSave) return;
    pruneVodProgress();
    saveJson('iptv_vod_progress', vodProgress);
}
function setSeasonWatched(item, season, seasons, on) {
    if (!season) return;
    // Entries get ascending 'at' in series order, so the newest entry is the last episode marked and
    // Continue Watching / "Play" resume after it (or drop the series when that was the final episode)
    const flat = []; for (const s of seasons) for (const ep of s.episodes) flat.push(ep.id);
    const base = Date.now() - flat.length;
    for (const ep of season.episodes) { setEpisodeWatched(item, ep, seasons, on, true); if (on) vodProgress[progressKeyFor('episode', ep.id, item.id)].at = base + flat.indexOf(ep.id); }
    pruneVodProgress();
    saveJson('iptv_vod_progress', vodProgress);
}
function lastEpisodeEntry(seriesId) {
    const prefix = `${_activePlaylistKey || '_'}|e:${seriesId}:`;
    let best = null;
    for (const k in vodProgress) if (k.startsWith(prefix)) { const e = vodProgress[k]; if (!best || e.at > best.at) best = e; }
    return best;
}
// Continue Watching: in-progress movies, or per series the latest unfinished episode
function continueWatchingItems(mode) {
    const prefix = `${_activePlaylistKey || '_'}|`;
    const out = [];
    if (mode === 'movies') {
        for (const k in vodProgress) { const e = vodProgress[k]; if (k.startsWith(prefix + 'm:') && !e.watched && e.dur && e.pos >= vodMinResume(e.dur)) out.push(e); }
        out.sort((a, b) => b.at - a.at);
        return out.map(e => ({ kind: 'movie', id: e.id, name: e.name, icon: e.icon, rating: e.rating || 0, added: 0, ext: e.ext, catId: e.catId, _resume: e }));
    }
    const bySeries = new Map();
    for (const k in vodProgress) {
        const e = vodProgress[k];
        if (!k.startsWith(prefix + 'e:')) continue;
        const cur = bySeries.get(e.seriesId);
        if (!cur || e.at > cur.at) bySeries.set(e.seriesId, e);
    }
    for (const e of bySeries.values()) {
        if (e.watched && e.lastOfSeries) continue; // finished the series
        if (!e.watched && !(e.dur && e.pos >= vodMinResume(e.dur))) continue; // barely started
        out.push({ kind: 'series', id: e.seriesId, name: e.name, icon: e.icon, rating: e.rating || 0, added: 0, catId: e.catId, _resume: e });
    }
    out.sort((a, b) => b._resume.at - a._resume.at);
    return out;
}
function pruneVodProgress() {
    const keys = Object.keys(vodProgress);
    if (keys.length <= VOD_PROGRESS_MAX) return;
    keys.sort((a, b) => (vodProgress[a].at || 0) - (vodProgress[b].at || 0));
    for (let i = 0; i < keys.length - VOD_PROGRESS_MAX; i++) delete vodProgress[keys[i]];
}

// ── mode switch & layout ─────────────────────────────────────
function resetVodState(showSwitch) {
    vodMode = 'live';
    vodCats = null; seriesCats = null; vodByCat.clear(); seriesByCat.clear();
    vodAll = null; seriesAll = null; vodRecent = null; seriesRecent = null; _vodAllLoading = null;
    vodInfoCache.clear(); seriesInfoCache.clear();
    vodNav.screen = 'home'; vodNav.list = 'home'; vodNav.catId = null; vodNav.items = []; vodNav.baseItems = []; vodNav.focus = 0; vodNav.zone = 'content';
    vodNav.homeRow = 0; vodNav.homeCol = {}; vodNav.detail = null; vodNav.query = '';
    vodGridRows.clear();
    const ms = document.getElementById('modeSwitch');
    if (ms) { ms.style.display = showSwitch ? '' : 'none'; ms.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'live')); }
    const vv = document.getElementById('vodView'); if (vv) vv.style.display = 'none';
    const vd = document.getElementById('vodDetails'); if (vd) { vd.style.display = 'none'; vd.innerHTML = ''; }
    const vh = document.getElementById('vodHome'); if (vh) vh.innerHTML = '';
    const vg = document.getElementById('vodGridInner'); if (vg) vg.innerHTML = '';
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
    document.querySelectorAll('#modeSwitch .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    const sv = document.getElementById('standardView'), ev = document.getElementById('epgView'), vv = document.getElementById('vodView');
    if (mode === 'live') {
        vv.style.display = 'none';
        if (currentPlaylistType === 'xtream') ev.style.display = 'flex'; else sv.style.display = 'flex';
        renderGroupsList();
        refreshCurrentView();
        if (prev !== 'live' && currentChannelIndex >= 0) selectChannel(currentChannelIndex); // live streams cannot resume; reload the channel
        return;
    }
    if (prev === 'live') { stopStallWatchdog(); if (_errRetryTimer) { clearTimeout(_errRetryTimer); _errRetryTimer = null; } videoPlayer.pause(); liveEngineDestroy(); }
    sv.style.display = 'none'; ev.style.display = 'none'; vv.style.display = 'flex';
    vodNav.detail = null; document.getElementById('vodDetails').style.display = 'none';
    loadVodCats(mode).then(() => { if (vodMode === mode) openVodList('home'); })
        .catch(err => { if (vodMode === mode) { renderVodCats(); showVodEmpty(`Could not load categories: ${err.message}`); } });
    renderVodCats();
    showVodEmpty('Loading …');
}
function setVodHeader(title, count) {
    document.getElementById('vodTitle').textContent = title;
    document.getElementById('vodCount').textContent = count || '';
    const si = document.getElementById('vodSearchInput');
    si.placeholder = vodNav.list === 'all' ? (vodMode === 'movies' ? 'Search all movies…' : 'Search all series…') : (vodNav.list === 'cat' ? `Search in ${title.replace(/^\S+\s/, '')}…` : 'Search…');
}
function showVodEmpty(msg) {
    document.getElementById('vodHome').style.display = 'none';
    document.getElementById('vodGrid').style.display = 'none';
    const e = document.getElementById('vodEmpty'); e.style.display = ''; e.textContent = msg;
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
        const d = el('div', 'group-item' + (vodNav.list === list && (list !== 'cat' || vodNav.catId === catId) ? ' active' : ''));
        d.dataset.list = list; if (catId) d.dataset.catId = catId;
        d.innerHTML = `<span class="group-folder">${icon}</span><span>${escapeHtml(label)}</span>`;
        d.onclick = () => { vodNav.zone = 'cats'; openVodList(list, catId); };
        return d;
    };
    if (pinnedDiv) {
        pinnedDiv.appendChild(mk('🏠', 'Home', 'home'));
        pinnedDiv.appendChild(mk('⭐', 'Favorites', 'favs'));
        pinnedDiv.appendChild(mk('🔍', vodMode === 'movies' ? 'Search all movies' : 'Search all series', 'all'));
    }
    for (const c of cats) { if (c.adult && !settings.showAdult) continue; groupsListDiv.appendChild(mk('📁', c.name, 'cat', c.id)); }
    updateVodCatFocus(false);
}
function vodActiveCatIdx() {
    const els = _groupItemEls();
    for (let i = 0; i < els.length; i++) if (els[i].classList.contains('active')) return i;
    return 0;
}
function updateVodCatFocus(scroll) {
    const els = _groupItemEls();
    for (let i = 0; i < els.length; i++) els[i].classList.toggle('focused', vodNav.zone === 'cats' && i === vodNav.catIdx);
    if (scroll && els[vodNav.catIdx]) els[vodNav.catIdx].scrollIntoView({ block: 'nearest' });
}

async function openVodList(list, catId) {
    vodNav.list = list; vodNav.catId = catId || null; vodNav.focus = 0; vodNav.gridScroll = 0; vodNav.query = '';
    vodNav.detail = null; document.getElementById('vodDetails').style.display = 'none';
    const si = document.getElementById('vodSearchInput'); si.value = '';
    if (vodNav.zone !== 'cats') vodNav.zone = 'content';
    renderVodCats();
    if (list === 'home') { vodNav.screen = 'home'; renderVodHome(); return; }
    vodNav.screen = 'grid';
    let items = null;
    if (list === 'favs') items = vodFavItems();
    else {
        showVodEmpty('Loading …');
        const mode = vodMode;
        try {
            items = list === 'all' ? vodVisible(await loadVodAll(mode), mode) : await loadVodCategory(mode, catId);
        } catch (err) { if (vodMode === mode) showVodEmpty(`Could not load: ${err.message}`); return; }
        if (vodMode !== mode || vodNav.list !== list || vodNav.catId !== (catId || null)) return; // user moved on
    }
    vodNav.baseItems = items;
    vodNav.genre = null; // a genre filter belongs to the list it was chosen in
    vodNav.sort = (_activePlaylistKey && getPlaylistState(_activePlaylistKey).vodSort) || 'default';
    vodNav.items = vodDerivedItems();
    renderVodGrid();
    if (list === 'all') focusVodSearch();
}
function applyVodSearch() {
    const q = vodNav.query || '';
    if (vodNav.screen === 'home') { if (q.trim()) { openVodList('all').then(() => { vodNav.query = q; document.getElementById('vodSearchInput').value = q; applyVodSearch(); }); } return; }
    vodNav.items = vodDerivedItems();
    vodNav.focus = 0; vodNav.gridScroll = 0;
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
    if (cw.length) rows.push({ key: 'cw', title: '▶ Continue Watching', sub: `${cw.length} in progress · Red removes`, items: cw.slice(0, 30) });
    const recent = vodMode === 'movies' ? vodRecent : seriesRecent;
    if (recent) rows.push({ key: 'recent', title: '🆕 Recently Added', sub: '', items: vodVisible(recent, vodMode).slice(0, 18) });
    else rows.push({ key: 'recent', title: '🆕 Recently Added', sub: 'loading …', items: [] });
    const favs = vodFavItems();
    if (favs.length) rows.push({ key: 'favs', title: '⭐ Favorites', sub: `${favs.length}`, items: favs.slice(0, 30) });
    return rows;
}
function renderVodHome() {
    const home = document.getElementById('vodHome');
    document.getElementById('vodGrid').style.display = 'none';
    document.getElementById('vodEmpty').style.display = 'none';
    home.style.display = '';
    const cats = ((vodMode === 'movies' ? vodCats : seriesCats) || []).filter(c => settings.showAdult || !c.adult);
    const all = vodMode === 'movies' ? vodAll : seriesAll;
    const visibleAll = all ? vodVisible(all, vodMode) : null;
    setVodHeader(vodMode === 'movies' ? '🎬 Movies' : '📺 Series', `${visibleAll ? visibleAll.length.toLocaleString() + ' titles · ' : ''}${cats.length} categories`);
    const rows = vodHomeRows();
    vodNav.homeRows = rows;
    home.innerHTML = '';
    const focusRows = rows.filter(r => r.items.length);
    if (vodNav.homeRow >= focusRows.length) vodNav.homeRow = Math.max(0, focusRows.length - 1);
    rows.forEach(r => {
        const sec = el('div', 'vod-row');
        sec.appendChild(el('h2', 'vod-row-title', `${r.title} <span>${escapeHtml(r.sub)}</span>`));
        const strip = el('div', 'vod-strip');
        if (!r.items.length) strip.appendChild(el('div', 'vod-strip-empty', r.key === 'recent' ? 'Loading the catalog …' : 'Nothing yet'));
        r.items.forEach((it, ci) => strip.appendChild(buildVodCard(it, false, `${r.key}:${ci}`)));
        sec.appendChild(strip);
        home.appendChild(sec);
    });
    if (!all && !(_vodAllLoading && _vodAllLoading.mode === vodMode)) {
        const mode = vodMode;
        loadVodAll(mode).then(() => { if (vodMode === mode && vodNav.screen === 'home') renderVodHome(); }).catch(() => {
            if (vodMode === mode && vodNav.screen === 'home') { const r = home.querySelector('.vod-strip-empty'); if (r) r.textContent = 'Recently Added unavailable'; }
        });
    }
    updateVodHomeFocus();
}
function vodHomeFocusRows() { return (vodNav.homeRows || []).filter(r => r.items.length); }
function updateVodHomeFocus() {
    const home = document.getElementById('vodHome');
    home.querySelectorAll('.vod-card.focused').forEach(c => c.classList.remove('focused'));
    if (vodNav.zone !== 'content') return;
    const rows = vodHomeFocusRows();
    const r = rows[vodNav.homeRow];
    if (!r) return;
    const col = Math.min(vodNav.homeCol[r.key] || 0, r.items.length - 1);
    vodNav.homeCol[r.key] = col;
    const card = home.querySelector(`.vod-card[data-pos="${r.key}:${col}"]`);
    if (card) { card.classList.add('focused'); card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
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
        meta = item.kind === 'series' ? `S${r.season} E${r.epNum} · ${fmtRuntime(left)} left` : `${fmtRuntime(left)} left`;
    } else if (item.kind === 'movie') {
        const p = movieProgress(item); if (p) pct = Math.min(100, Math.round(p.pos / p.dur * 100));
        meta = item.rating ? `★ ${item.rating.toFixed(1)}` : '';
    } else {
        meta = [yearOf(item.releaseDate), item.rating ? `★ ${item.rating.toFixed(1)}` : ''].filter(Boolean).join(' · ');
    }
    card.innerHTML =
        `<div class="vod-poster"><span class="vod-poster-name">${escapeHtml(item.name)}</span>` +
        (item.icon ? `<img loading="lazy" src="${escapeHtml(item.icon)}" alt="" onerror="this.remove()">` : '') +
        (fav ? '<span class="vod-star">★</span>' : '') +
        (item.kind === 'movie' && isMovieWatched(item) ? '<span class="vod-card-chk">✓</span>' : '') +
        (pct ? `<div class="vod-prog"><i style="width:${pct}%"></i></div>` : '') +
        `</div><div class="vod-card-t">${escapeHtml(item.name)}</div><div class="vod-card-m">${escapeHtml(meta)}</div>`;
    // A pointer click opens the title like OK does, and also moves the cursor to this card, so Back from
    // the details page returns to this card (and this scroll position) instead of the top of the list
    card.addEventListener('click', () => {
        if (card.dataset.idx !== undefined) { vodNav.focus = +card.dataset.idx; vodNav.zone = 'content'; }
        else if (card.dataset.pos) {
            const [key, ci] = card.dataset.pos.split(':');
            const ri = vodHomeFocusRows().findIndex(r => r.key === key);
            if (ri >= 0) { vodNav.homeRow = ri; vodNav.homeCol[key] = +ci || 0; vodNav.zone = 'content'; }
        }
        openVodItem(item);
    });
    return card;
}
function renderVodGrid() {
    const home = document.getElementById('vodHome'), grid = document.getElementById('vodGrid'), empty = document.getElementById('vodEmpty');
    home.style.display = 'none'; empty.style.display = 'none'; grid.style.display = '';
    const items = vodNav.items;
    const cats = (vodMode === 'movies' ? vodCats : seriesCats) || [];
    const cat = cats.find(c => c.id === vodNav.catId);
    const title = vodNav.list === 'favs' ? '⭐ Favorites' : vodNav.list === 'all' ? (vodMode === 'movies' ? '🔍 All movies' : '🔍 All series') : '📁 ' + (cat ? cat.name : '');
    const viewBits = [vodNav.genre ? `🎭 ${vodNav.genre}` : '', vodSortLabel() ? `⇅ ${vodSortLabel()}` : ''].filter(Boolean);
    setVodHeader(title, `${items.length.toLocaleString()} titles${vodNav.query ? ` · "${vodNav.query}"` : ''}${viewBits.length ? ' · ' + viewBits.join(' · ') : ''} · Green: sort & genre`);
    const inner = document.getElementById('vodGridInner');
    inner.innerHTML = '';
    vodGridRows.clear();
    const cols = VOD_COLS, pad = 24, gap = 16;
    const W = grid.clientWidth || (mainApp.clientWidth - groupsColumn.clientWidth);
    const cardW = Math.max(100, Math.floor((W - pad * 2 - gap * (cols - 1)) / cols));
    const posterH = Math.round(cardW * 1.5);
    const capH = Math.round(3.2 * 16 * TEXT_SCALE);
    const rowH = posterH + capH + 18;
    vodGrid = { cols, cardW, rowH, total: Math.ceil(items.length / cols) };
    inner.style.height = `${vodGrid.total * rowH}px`;
    if (!items.length) { inner.innerHTML = `<div class="vod-empty-inline">${vodNav.query ? 'No matches' : 'Nothing here yet'}</div>`; return; }
    grid.scrollTop = vodNav.gridScroll || 0;
    renderVodGridRows();
    grid.onscroll = () => { vodNav.gridScroll = grid.scrollTop; requestAnimationFrame(renderVodGridRows); };
}
function renderVodGridRows() {
    const { cols, cardW, rowH, total } = vodGrid;
    const grid = document.getElementById('vodGrid'), inner = document.getElementById('vodGridInner');
    if (!total) return;
    const start = Math.max(0, Math.floor(grid.scrollTop / rowH) - 1);
    const end = Math.min(total - 1, Math.ceil((grid.scrollTop + grid.clientHeight) / rowH) + 1);
    for (const [r, rowEl] of vodGridRows) if (r < start || r > end) { rowEl.remove(); vodGridRows.delete(r); }
    for (let r = start; r <= end; r++) {
        if (vodGridRows.has(r)) continue;
        const row = el('div', 'vod-grid-row');
        row.style.cssText = `top:${r * rowH}px;height:${rowH}px;grid-template-columns:repeat(${cols}, ${cardW}px)`;
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            if (i >= vodNav.items.length) break;
            const card = buildVodCard(vodNav.items[i], vodNav.zone === 'content' && i === vodNav.focus);
            card.dataset.idx = i;
            row.appendChild(card);
        }
        inner.appendChild(row);
        vodGridRows.set(r, row);
    }
}
function updateVodGridFocus() {
    const grid = document.getElementById('vodGrid'), inner = document.getElementById('vodGridInner');
    const { cols, rowH } = vodGrid;
    if (!vodNav.items.length) return;
    vodNav.focus = Math.max(0, Math.min(vodNav.items.length - 1, vodNav.focus));
    const r = Math.floor(vodNav.focus / cols);
    const top = r * rowH, bottom = top + rowH;
    if (top < grid.scrollTop) grid.scrollTop = top;
    else if (bottom > grid.scrollTop + grid.clientHeight) grid.scrollTop = bottom - grid.clientHeight;
    vodNav.gridScroll = grid.scrollTop;
    renderVodGridRows();
    inner.querySelectorAll('.vod-card.focused').forEach(c => c.classList.remove('focused'));
    if (vodNav.zone !== 'content') return;
    const card = inner.querySelector(`.vod-card[data-idx="${vodNav.focus}"]`);
    if (card) card.classList.add('focused');
}
function refreshVodFocus() {
    updateVodCatFocus(false);
    if (vodNav.screen === 'home') updateVodHomeFocus();
    else if (vodNav.screen === 'grid') updateVodGridFocus();
}

// ── details ──────────────────────────────────────────────────
async function getVodInfo(item) {
    if (vodInfoCache.has(item.id)) return vodInfoCache.get(item.id);
    const raw = await xtApi('get_vod_info', { vod_id: item.id });
    const i = (raw && raw.info) || {}, md = (raw && raw.movie_data) || {};
    const info = { plot: i.plot || i.description || '', cast: i.cast || i.actors || '', director: i.director || '', genre: i.genre || item.genre || '',
                   releaseDate: i.releasedate || i.release_date || item.releaseDate || '', duration: parseDurationSecs(i), rating: parseFloat(i.rating) || item.rating || 0,
                   backdrop: Array.isArray(i.backdrop_path) ? i.backdrop_path[0] : (i.backdrop_path || ''), image: i.movie_image || i.cover_big || item.icon,
                   ext: md.container_extension || item.ext, added: (parseInt(md.added) || 0) * 1000 || item.added || 0 };
    Object.assign(info, providerExtras(i));
    vodInfoCache.set(item.id, info);
    return info;
}
// Extra fields many Xtream panels return with get_vod_info / get_series_info (all optional)
function providerExtras(i) {
    const out = {};
    const age = i.age || i.mpaa || i.mpaa_rating || i.certification || ''; if (age && age !== 'N/A') out.age = String(age);
    if (i.country) out.country = String(i.country);
    const tmdb = i.tmdb_id || i.tmdb || ''; if (tmdb && tmdb !== '0') out.tmdb = String(tmdb);
    if (i.youtube_trailer) out.trailer = String(i.youtube_trailer);
    const ert = parseInt(i.episode_run_time); if (ert > 0) out.episodeRunTime = ert;
    const v = i.video && typeof i.video === 'object' ? i.video : null, a = i.audio && typeof i.audio === 'object' ? i.audio : null;
    const bits = [];
    if (v && v.width && v.height) bits.push(`${v.width}×${v.height}`);
    if (v && v.codec_name) bits.push(String(v.codec_name).toUpperCase());
    if (v && v.r_frame_rate) { const m = String(v.r_frame_rate).match(/^(\d+)\/(\d+)$/); const fps = m ? +m[1] / +m[2] : parseFloat(v.r_frame_rate); if (fps > 0) bits.push(`${Math.round(fps * 100) / 100} fps`); }
    if (a && a.codec_name) bits.push(String(a.codec_name).toUpperCase() + (a.channels ? ` ${a.channels === 6 ? '5.1' : a.channels === 8 ? '7.1' : a.channels + 'ch'}` : ''));
    const br = parseInt(i.bitrate) || (v && parseInt(v.bit_rate)) || 0; if (br > 0) bits.push(`${br >= 1e6 ? (br / 1e6).toFixed(1) + ' Mbps' : Math.round(br / 1000) + ' kbps'}`);
    if (bits.length) out.fileTech = bits.join(' · ');
    return out;
}
async function getSeriesInfo(item) {
    if (seriesInfoCache.has(item.id)) return seriesInfoCache.get(item.id);
    const raw = await xtApi('get_series_info', { series_id: item.id });
    const i = (raw && raw.info) || {};
    const eps = (raw && raw.episodes) || {};
    const seasons = [];
    const keys = Array.isArray(eps) ? eps.map((_, k) => String(k)) : Object.keys(eps);
    for (const k of keys) {
        const list = Array.isArray(eps) ? eps[k] : eps[k];
        if (!Array.isArray(list) || !list.length) continue;
        const num = parseInt(k) || parseInt(list[0].season) || 0;
        const episodes = list.map(e => ({ id: String(e.id), num: parseInt(e.episode_num) || 0, title: e.title || '', ext: e.container_extension || 'mp4',
            duration: parseDurationSecs(e.info), plot: (e.info && (e.info.plot || e.info.overview)) || '', image: (e.info && e.info.movie_image) || '', season: num }))
            .sort((a, b) => a.num - b.num);
        seasons.push({ num, episodes });
    }
    seasons.sort((a, b) => a.num - b.num);
    const info = { plot: i.plot || item.plot || '', cast: i.cast || item.cast || '', director: i.director || item.director || '', genre: i.genre || item.genre || '',
                   releaseDate: i.releaseDate || i.release_date || item.releaseDate || '', rating: parseFloat(i.rating) || item.rating || 0,
                   backdrop: Array.isArray(i.backdrop_path) ? i.backdrop_path[0] : (i.backdrop_path || item.backdrop || ''), image: i.cover || item.icon,
                   seasons, episodeCount: seasons.reduce((n, s) => n + s.episodes.length, 0) };
    Object.assign(info, providerExtras(i));
    seriesInfoCache.set(item.id, info);
    return info;
}
async function openVodItem(item) {
    vodNav.screen = 'details';
    vodNav.detail = { item, info: null, loading: true, error: null };
    vodNav.detailZone = 'buttons'; vodNav.detailBtn = 0; vodNav.season = 0; vodNav.epIdx = 0;
    renderVodDetails();
    try {
        const info = item.kind === 'movie' ? await getVodInfo(item) : await getSeriesInfo(item);
        if (!vodNav.detail || vodNav.detail.item !== item) return;
        vodNav.detail.info = info; vodNav.detail.loading = false;
        if (item.kind === 'series') {
            const last = lastEpisodeEntry(item.id);
            if (last) {
                const si = info.seasons.findIndex(s => s.num === last.season);
                if (si >= 0) { vodNav.season = si; const ei = info.seasons[si].episodes.findIndex(e => e.id === last.epId); if (ei >= 0) vodNav.epIdx = ei; }
            }
        }
        renderVodDetails();
    } catch (err) {
        if (!vodNav.detail || vodNav.detail.item !== item) return;
        vodNav.detail.loading = false; vodNav.detail.error = err.message;
        renderVodDetails();
    }
}
function closeVodDetails() {
    vodNav.detail = null;
    document.getElementById('vodDetails').style.display = 'none';
    vodNav.screen = vodNav.list === 'home' ? 'home' : 'grid';
    vodNav.zone = 'content';
    if (vodNav.screen === 'home') renderVodHome(); else { if (vodNav.list === 'favs') { vodNav.baseItems = vodFavItems(); vodNav.items = vodNav.query ? vodSearchItems(vodNav.baseItems, vodNav.query) : vodNav.baseItems; } renderVodGrid(); updateVodGridFocus(); }
}
// Which episode "Play" should start for a series: resume the last one if unfinished,
// else the episode after the last one watched, else the first unwatched, else S1 E1
function seriesPlayTarget(item, info) {
    const last = lastEpisodeEntry(item.id);
    if (last) {
        for (let si = 0; si < info.seasons.length; si++) {
            const ei = info.seasons[si].episodes.findIndex(e => e.id === last.epId);
            if (ei < 0) continue;
            if (!last.watched) return { si, ei, resume: true };
            if (ei + 1 < info.seasons[si].episodes.length) return { si, ei: ei + 1, resume: false };
            for (let sj = si + 1; sj < info.seasons.length; sj++) if (info.seasons[sj].episodes.length) return { si: sj, ei: 0, resume: false };
            break; // finished the last episode: fall through to first unwatched
        }
    }
    for (let si = 0; si < info.seasons.length; si++) for (let ei = 0; ei < info.seasons[si].episodes.length; ei++) {
        const p = episodeProgress(item.id, info.seasons[si].episodes[ei].id);
        if (!p || !p.watched) return { si, ei, resume: false };
    }
    return info.seasons.length ? { si: 0, ei: 0, resume: false } : null;
}
function vodDetailButtons() {
    const d = vodNav.detail; if (!d) return [];
    const { item, info } = d;
    const btns = [];
    if (item.kind === 'movie') {
        const p = movieProgress(item);
        btns.push({ id: 'play', label: p ? `▶ Resume from ${fmtClock(p.pos)}` : '▶ Play', primary: true, disabled: d.loading && !info, act: () => startVodPlayback({ kind: 'movie', item, info }) });
        if (p) btns.push({ id: 'restart', label: '↺ Start over', act: () => startVodPlayback({ kind: 'movie', item, info, restart: true }) });
    } else if (info && info.seasons.length) {
        const t = seriesPlayTarget(item, info);
        const ep = t ? info.seasons[t.si].episodes[t.ei] : null;
        btns.push({ id: 'play', label: ep ? `▶ ${t.resume ? 'Resume' : 'Play'} S${ep.season} E${ep.num}` : '▶ Play', primary: true, disabled: !ep,
                    act: () => { if (ep) startVodPlayback({ kind: 'episode', item, ep, season: ep.season, epIdx: t.ei, seasons: info.seasons }); } });
    } else {
        btns.push({ id: 'play', label: '▶ Play', primary: true, disabled: true, act: () => {} });
    }
    btns.push({ id: 'fav', label: isVodFav(item) ? '★ Favorite' : '☆ Favorite', act: () => { toggleVodFav(item); renderVodDetails(); } });
    const hasProgress = item.kind === 'movie' ? !!movieProgress(item) : !!lastEpisodeEntry(item.id);
    if (hasProgress) btns.push({ id: 'remove', label: '✕ Remove from Continue Watching', act: () => {
        removeVodProgress(item);
        if (vodNav.detailBtn >= vodDetailButtons().length) vodNav.detailBtn = 0;
        renderVodDetails();
        showEPGToast(`${item.name} removed from Continue Watching`, 'success', 'Continue Watching'); hideEPGToast(2500);
    } });
    if (item.kind === 'movie') {
        const w = isMovieWatched(item);
        btns.push({ id: 'watched', label: w ? '✓ Watched · mark unwatched' : '✓ Mark as watched', act: () => {
            setMovieWatched(item, info, !w);
            if (vodNav.detailBtn >= vodDetailButtons().length) vodNav.detailBtn = 0;
            renderVodDetails();
            showEPGToast(`${item.name} marked as ${w ? 'unwatched' : 'watched'}`, 'success', 'Watched'); hideEPGToast(2000);
        } });
    } else if (info && info.seasons.length) {
        // Season / series watched state: the button flips to "unwatched" once everything is already watched
        const season = info.seasons[Math.min(vodNav.season, info.seasons.length - 1)];
        const seasonDone = season && season.episodes.length && season.episodes.every(ep => { const p = episodeProgress(item.id, ep.id); return p && p.watched; });
        btns.push({ id: 'season', label: seasonDone ? `↺ Season ${season.num}: mark unwatched` : `✓ Mark season ${season ? season.num : ''} watched`, act: () => {
            setSeasonWatched(item, season, info.seasons, !seasonDone);
            renderVodDetails();
            showEPGToast(`Season ${season.num} marked as ${seasonDone ? 'unwatched' : 'watched'}`, 'success', 'Watched'); hideEPGToast(2000);
        } });
        const allDone = info.seasons.every(s => s.episodes.every(ep => { const p = episodeProgress(item.id, ep.id); return p && p.watched; }));
        btns.push({ id: 'all', label: allDone ? '↺ Mark all unwatched' : '✓ Mark all watched', act: () => {
            showConfirmDialog(allDone ? '↺ Mark all unwatched' : '✓ Mark all watched', `${allDone ? 'Clear the watched state of' : 'Mark'} all ${info.episodeCount} episodes of ${item.name}${allDone ? '' : ' as watched'}?`, () => {
                for (const s of info.seasons) setSeasonWatched(item, s, info.seasons, !allDone);
                if (vodNav.detailBtn >= vodDetailButtons().length) vodNav.detailBtn = 0;
                renderVodDetails();
                showEPGToast(`${item.name}: all episodes marked ${allDone ? 'unwatched' : 'watched'}`, 'success', 'Watched'); hideEPGToast(2000);
            });
        } });
    }
    return btns;
}
function renderVodDetails() {
    const d = vodNav.detail; const box = document.getElementById('vodDetails');
    if (!d) { box.style.display = 'none'; return; }
    const { item, info } = d;
    box.style.display = '';
    const backdrop = (info && info.backdrop) || item.backdrop || '';
    const poster = (info && info.image) || item.icon || '';
    const metaBits = [];
    if (item.kind === 'movie') {
        if (info) { const y = yearOf(info.releaseDate); if (y) metaBits.push(y); if (info.duration) metaBits.push(fmtRuntime(info.duration)); if (info.rating) metaBits.push(`★ ${info.rating.toFixed(1)}`); if (info.genre) metaBits.push(info.genre); }
        else if (item.rating) metaBits.push(`★ ${item.rating.toFixed(1)}`);
    } else {
        const y = yearOf((info && info.releaseDate) || item.releaseDate); if (y) metaBits.push(y);
        if (info) metaBits.push(`${info.seasons.length} season${info.seasons.length === 1 ? '' : 's'} · ${info.episodeCount} episode${info.episodeCount === 1 ? '' : 's'}`);
        const rt = (info && info.rating) || item.rating; if (rt) metaBits.push(`★ ${rt.toFixed(1)}`);
        const g = (info && info.genre) || item.genre; if (g) metaBits.push(g);
    }
    if (info) {
        if (info.age) metaBits.push(info.age);
        if (info.country) metaBits.push(info.country);
        if (item.kind === 'series' && info.episodeRunTime) metaBits.push(`${info.episodeRunTime} min/ep`);
    }
    const techKey = item.kind === 'movie' ? progressKeyFor('movie', item.id) : (lastEpisodeEntry(item.id) ? progressKeyFor('episode', lastEpisodeEntry(item.id).epId, item.id) : null);
    const tech = (techKey && vodTech[techKey]) || (info && info.fileTech) || ''; // what the TV decoded beats what the provider claims
    if (tech) metaBits.push(tech);
    const extraBits = [];
    if (info && info.releaseDate && /^\d{4}-\d{2}-\d{2}/.test(info.releaseDate)) extraBits.push(`Released ${info.releaseDate.slice(0, 10)}`);
    if (item.kind === 'movie' && info && info.added) extraBits.push(`Added ${new Date(info.added).toLocaleDateString()}`);
    if (info && info.tmdb) extraBits.push(`TMDB ${info.tmdb}`);
    const plot = (info && info.plot) || item.plot || (d.loading ? 'Loading …' : '');
    const people = info ? [info.director ? `Director: ${info.director}` : '', info.cast ? `Cast: ${info.cast}` : ''].filter(Boolean).join(' · ') : '';
    const btns = vodDetailButtons();
    let html = `<div class="vod-backdrop"${backdrop ? ` style="background-image:url('${escapeHtml(backdrop).replace(/'/g, '%27')}')"` : ''}></div>` +
        `<div class="vod-dwrap${item.kind === 'series' ? ' series' : ''}">` +
        `<div class="vod-dposter"><span class="vod-poster-name">${escapeHtml(item.name)}</span>${poster ? `<img src="${escapeHtml(poster)}" alt="" onerror="this.remove()">` : ''}</div>` +
        `<div class="vod-dinfo">` +
        `<div class="vod-dtitle">${escapeHtml(item.name)}</div>` +
        `<div class="vod-dmeta">${metaBits.map(escapeHtml).join(' <i>·</i> ')}</div>` +
        `<div class="vod-dplot">${escapeHtml(plot)}</div>` +
        (people ? `<div class="vod-dcast">${escapeHtml(people)}</div>` : '') +
        (extraBits.length ? `<div class="vod-dcast vod-dextra">${extraBits.map(escapeHtml).join(' <i>·</i> ')}</div>` : '') +
        (d.error ? `<div class="vod-derror">⚠️ ${escapeHtml(d.error)}</div>` : '') +
        `<div class="vod-dbtns">${btns.map((b, i) => `<button class="vod-btn${b.primary ? ' pri' : ''}${b.disabled ? ' disabled' : ''}${vodNav.detailZone === 'buttons' && i === vodNav.detailBtn ? ' focused' : ''}" data-i="${i}">${escapeHtml(b.label)}</button>`).join('')}</div>`;
    if (item.kind === 'series' && info && info.seasons.length) {
        if (vodNav.season >= info.seasons.length) vodNav.season = 0;
        const season = info.seasons[vodNav.season];
        if (vodNav.epIdx >= season.episodes.length) vodNav.epIdx = 0;
        html += `<div class="vod-seasons">${info.seasons.map((s, i) => `<button class="vod-season${i === vodNav.season ? ' on' : ''}${vodNav.detailZone === 'seasons' && i === vodNav.season ? ' focused' : ''}" data-i="${i}">Season ${s.num}</button>`).join('')}</div>`;
        html += `<div class="vod-eps">` + season.episodes.map((ep, i) => {
            const p = episodeProgress(item.id, ep.id);
            const watched = !!(p && p.watched);
            const pct = p && p.dur && (watched || p.pos >= vodMinResume(p.dur)) ? Math.min(100, Math.round(p.pos / p.dur * 100)) : 0;
            const thumb = ep.image || poster;
            return `<div class="vod-ep${vodNav.detailZone === 'episodes' && i === vodNav.epIdx ? ' focused' : ''}${watched ? ' watched' : ''}" data-i="${i}">` +
                `<div class="vod-thumb">${thumb ? `<img loading="lazy" src="${escapeHtml(thumb)}" alt="" onerror="this.remove()">` : ''}${pct ? `<div class="vod-prog"><i style="width:${watched ? 100 : pct}%"></i></div>` : ''}</div>` +
                `<div class="vod-epi"><div class="vod-ept">${watched ? '<span class="vod-chk">✓</span>' : ''}E${ep.num}${ep.title ? ' · ' + escapeHtml(ep.title) : ''}</div>` +
                `<div class="vod-epp">${escapeHtml(ep.plot || '')}${p && !watched && pct ? `${ep.plot ? ' ' : ''}Resume from ${fmtClock(p.pos)}.` : ''}</div></div>` +
                `<div class="vod-epd">${ep.duration ? fmtRuntime(ep.duration) : ''}</div></div>`;
        }).join('') + `</div>`;
    } else if (item.kind === 'series' && info && !info.seasons.length) {
        html += `<div class="vod-dcast">No episodes listed for this series.</div>`;
    }
    html += `<div class="vod-dhint">◀ ▶ move · OK select${item.kind === 'series' && info && info.seasons.length ? ' · Red mark episode watched' : ''} · Back to ${vodNav.list === 'home' ? 'Home' : 'list'}</div></div></div>`;
    box.innerHTML = html;
    box.querySelectorAll('.vod-btn').forEach(b => b.addEventListener('click', () => { vodNav.detailZone = 'buttons'; vodNav.detailBtn = +b.dataset.i; const btn = vodDetailButtons()[vodNav.detailBtn]; if (btn && !btn.disabled) btn.act(); }));
    box.querySelectorAll('.vod-season').forEach(b => b.addEventListener('click', () => { vodNav.detailZone = 'seasons'; vodNav.season = +b.dataset.i; vodNav.epIdx = 0; renderVodDetails(); }));
    box.querySelectorAll('.vod-ep').forEach(b => b.addEventListener('click', () => { vodNav.detailZone = 'episodes'; vodNav.epIdx = +b.dataset.i; playFocusedEpisode(); }));
    const f = box.querySelector('.vod-ep.focused'); if (f) f.scrollIntoView({ block: 'nearest' });
}
function playFocusedEpisode() {
    const d = vodNav.detail; if (!d || !d.info || !d.info.seasons.length) return;
    const season = d.info.seasons[vodNav.season]; const ep = season.episodes[vodNav.epIdx]; if (!ep) return;
    const p = episodeProgress(d.item.id, ep.id);
    startVodPlayback({ kind: 'episode', item: d.item, ep, season: ep.season, epIdx: vodNav.epIdx, seasons: d.info.seasons, restart: !!(p && p.watched) });
}
function handleVodDetailsKey(e, up, down, left, right, enter) {
    const d = vodNav.detail; if (!d) return;
    const btns = vodDetailButtons();
    const hasSeasons = d.item.kind === 'series' && d.info && d.info.seasons.length > 1;
    const hasEps = d.item.kind === 'series' && d.info && d.info.seasons.length > 0;
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
            showEPGToast(`S${ep.season} E${ep.num} marked as ${on ? 'watched' : 'unwatched'}`, 'success', 'Watched'); hideEPGToast(2000);
        }
        return;
    }
    if (!(up || down || left || right || enter)) return;
    e.preventDefault();
    if (z === 'buttons') {
        if (left) vodNav.detailBtn = Math.max(0, vodNav.detailBtn - 1);
        else if (right) vodNav.detailBtn = Math.min(btns.length - 1, vodNav.detailBtn + 1);
        else if (down) { if (hasSeasons) vodNav.detailZone = 'seasons'; else if (hasEps) vodNav.detailZone = 'episodes'; }
        else if (enter) { const b = btns[vodNav.detailBtn]; if (b && !b.disabled) { b.act(); return; } }
    } else if (z === 'seasons') {
        if (left) { if (vodNav.season > 0) { vodNav.season--; vodNav.epIdx = 0; } }
        else if (right) { if (vodNav.season < d.info.seasons.length - 1) { vodNav.season++; vodNav.epIdx = 0; } }
        else if (up) vodNav.detailZone = 'buttons';
        else if (down || enter) vodNav.detailZone = 'episodes';
    } else if (z === 'episodes') {
        const n = d.info.seasons[vodNav.season].episodes.length;
        if (up) { if (vodNav.epIdx > 0) vodNav.epIdx--; else vodNav.detailZone = hasSeasons ? 'seasons' : 'buttons'; }
        else if (down) vodNav.epIdx = Math.min(n - 1, vodNav.epIdx + 1);
        else if (enter) { playFocusedEpisode(); return; }
        else if (left || right) { if (hasSeasons) { vodNav.detailZone = 'seasons'; } }
    }
    renderVodDetails();
}

// ── browse keys ──────────────────────────────────────────────
function handleVodBrowseKey(e, up, down, left, right, enter) {
    if (vodNav.screen === 'details') return handleVodDetailsKey(e, up, down, left, right, enter);
    const red = e.keyCode === 403 || e.key === 'ColorF0Red';
    if (!(up || down || left || right || enter || red)) return;
    e.preventDefault();
    if (vodNav.zone === 'cats') {
        const els = _groupItemEls();
        if (vodNav.catIdx === undefined || vodNav.catIdx >= els.length) vodNav.catIdx = vodActiveCatIdx();
        if (up) vodNav.catIdx = Math.max(0, vodNav.catIdx - 1);
        else if (down) vodNav.catIdx = Math.min(els.length - 1, vodNav.catIdx + 1);
        else if (right) { vodNav.zone = 'content'; refreshVodFocus(); return; }
        else if (enter) { if (els[vodNav.catIdx]) { const t = els[vodNav.catIdx]; openVodList(t.dataset.list, t.dataset.catId); } return; }
        updateVodCatFocus(true);
        return;
    }
    if (vodNav.screen === 'home') {
        const rows = vodHomeFocusRows();
        if (!rows.length) { if (left) { vodNav.zone = 'cats'; vodNav.catIdx = vodActiveCatIdx(); refreshVodFocus(); updateVodCatFocus(true); } else if (up) focusVodSearch(); return; }
        const r = rows[vodNav.homeRow]; const col = vodNav.homeCol[r.key] || 0;
        if ((e.keyCode === 403 || e.key === 'ColorF0Red') && r.key === 'cw') {
            const it = r.items[col];
            if (it) { removeVodProgress(it); showEPGToast(`${it.name} removed from Continue Watching`, 'success', 'Continue Watching'); hideEPGToast(2500); renderVodHome(); }
            return;
        }
        if (up) { if (vodNav.homeRow === 0) { focusVodSearch(); return; } vodNav.homeRow--; }
        else if (down) vodNav.homeRow = Math.min(rows.length - 1, vodNav.homeRow + 1);
        else if (left) { if (col === 0) { vodNav.zone = 'cats'; vodNav.catIdx = vodActiveCatIdx(); refreshVodFocus(); updateVodCatFocus(true); return; } vodNav.homeCol[r.key] = col - 1; }
        else if (right) vodNav.homeCol[r.key] = Math.min(r.items.length - 1, col + 1);
        else if (enter) { openVodItem(r.items[col]); return; }
        updateVodHomeFocus();
        return;
    }
    // grid
    const n = vodNav.items.length, cols = vodGrid.cols;
    if (!n) { if (left) { vodNav.zone = 'cats'; vodNav.catIdx = vodActiveCatIdx(); refreshVodFocus(); updateVodCatFocus(true); } else if (up) focusVodSearch(); return; }
    if (up) { if (vodNav.focus < cols) { focusVodSearch(); return; } vodNav.focus -= cols; }
    else if (down) { if (vodNav.focus + cols < n) vodNav.focus += cols; else if (Math.floor(vodNav.focus / cols) < Math.floor((n - 1) / cols)) vodNav.focus = n - 1; }
    else if (left) { if (vodNav.focus % cols === 0) { vodNav.zone = 'cats'; vodNav.catIdx = vodActiveCatIdx(); refreshVodFocus(); updateVodCatFocus(true); return; } vodNav.focus--; }
    else if (right) { if (vodNav.focus % cols !== cols - 1 && vodNav.focus + 1 < n) vodNav.focus++; }
    else if (enter) { openVodItem(vodNav.items[vodNav.focus]); return; }
    updateVodGridFocus();
}

// ── playback ─────────────────────────────────────────────────
function _inPlayerMode() { return (!!document.fullscreenElement || playerActive()) && !settingsOpen && !diagOpen && !(confirmDialog && !confirmDialog.classList.contains('hidden')); }
function showPlayerControls() { if (playerActive()) showVodOsd(); else showTopControls(); }
function vodNextVisible() { return !document.getElementById('vodNext').classList.contains('hidden'); }
function restoreLiveVideoSlot() {
    const wrap = (currentPlaylistType === 'xtream' && epgMode) ? document.getElementById('epgVideoWrap') : videoArea;
    if (videoPlayer.parentNode !== wrap) { if (wrap === videoArea) videoArea.insertBefore(videoPlayer, videoArea.firstChild); else wrap.appendChild(videoPlayer); }
    const badge = document.getElementById('pbTrickBadge');
    if (badge && badge.parentNode !== videoArea) videoArea.appendChild(badge);
}
function startVodPlayback(p) {
    if (!_xt) return;
    const key = p.kind === 'movie' ? progressKeyFor('movie', p.item.id) : progressKeyFor('episode', p.ep.id, p.item.id);
    const saved = vodProgress[key];
    const resumeAt = (!p.restart && saved && !saved.watched && saved.dur && saved.pos >= vodMinResume(saved.dur) && saved.pos < saved.dur * 0.9) ? saved.pos : 0;
    if (p.restart && saved) { delete vodProgress[key]; saveJson('iptv_vod_progress', vodProgress); }
    if (vodPlay.active) { saveVodProgress(true); clearVodNext(); }
    stopStallWatchdog();
    if (_errRetryTimer) { clearTimeout(_errRetryTimer); _errRetryTimer = null; }
    vodPlay.active = true; vodPlay.kind = p.kind; vodPlay.key = key; vodPlay.item = p.item; vodPlay.ep = p.ep || null;
    vodPlay.season = p.season || null; vodPlay.epIdx = p.epIdx; vodPlay.seasons = p.seasons || null; vodPlay.resumeAt = resumeAt;
    vodPlay.dur = (p.ep ? p.ep.duration : (p.info && p.info.duration)) || (saved && saved.dur) || 0;
    vodPlay.saveAt = 0; vodPlay.ended = false; vodPlay.subManual = false; vodPlay.audioManual = false;
    closeVodTracks();
    vodPlay.title = p.kind === 'movie' ? p.item.name : `${p.item.name} · S${p.season} E${p.ep.num}${p.ep.title ? ' · ' + p.ep.title : ''}`;
    vodPlay.sub = p.kind === 'movie' ? [yearOf(p.info && p.info.releaseDate), fmtRuntime(vodPlay.dur)].filter(Boolean).join(' · ') : [`Season ${p.season}`, fmtRuntime(vodPlay.dur)].filter(Boolean).join(' · ');
    if (resumeAt) vodPlay.sub += ` · Resumed from ${fmtClock(resumeAt)}`;
    const player = document.getElementById('vodPlayer'), slot = document.getElementById('vodVideoSlot');
    if (videoPlayer.parentNode !== slot) slot.appendChild(videoPlayer);
    const badge = document.getElementById('pbTrickBadge'); if (badge && badge.parentNode !== player) player.appendChild(badge);
    videoPlayer.removeAttribute('controls');
    player.classList.remove('hidden');
    document.getElementById('vodPaused').classList.add('hidden');
    document.getElementById('vodLoading').classList.remove('hidden');
    document.getElementById('vodNext').classList.add('hidden');
    vodNav.screen = 'player';
    const url = p.kind === 'movie' ? vodStreamUrl(p.item.id, (p.info && p.info.ext) || p.item.ext) : episodeUrl(p.ep);
    vodPlay.syncMs = vodSubSync[key] || 0;
    player.focus = 'bar'; player.btn = 0; player.btns = [];
    _nativeRate = 0;
    umsRelease(liveUms); liveUms = null;
    liveEngineDestroy();
    umsNoteCurrentId();
    const techEl = document.getElementById('vodOsdTech'); if (techEl) techEl.textContent = vodTech[key] || '';
    videoPlayer.pause();
    videoPlayer.src = url;
    videoPlayer.load();
    umsAttach();
    if (resumeAt > 0) videoPlayer.addEventListener('loadedmetadata', function seekOnce() { try { videoPlayer.currentTime = resumeAt; } catch (_) { /* not seekable yet */ } }, { once: true });
    videoPlayer.addEventListener('loadedmetadata', function tracksOnce() { applyVodTrackPrefs(); }, { once: true });
    setTimeout(() => { if (vodPlay.active) applyVodTrackPrefs(); }, 4000); // some files announce tracks late
    videoPlayer.play().catch(() => {});
    statusArea.innerText = `▶️ ${vodPlay.title}`;
    updateVodOsd(); showVodOsd();
}
function stopVodPlayback(backToDetails) {
    if (!vodPlay.active) return;
    saveVodProgress(true);
    clearVodNext();
    _scrubPos = null; // abandon any scrub in progress; no seek/play on the way out
    _nativeRate = 0;  // the pipeline is being unloaded; nothing to restore
    if (_isHolding()) _stopHold();
    _holdKeyDir = null;
    closeVodTracks();
    umsDetach();
    videoPlayer.querySelectorAll('track').forEach(t => t.remove());
    if (vodPlay.osdTimer) { clearTimeout(vodPlay.osdTimer); vodPlay.osdTimer = null; }
    videoPlayer.pause();
    videoPlayer.removeAttribute('src');
    videoPlayer.load();
    vodPlay.active = false;
    document.getElementById('vodPlayer').classList.add('hidden');
    hideVodOsd();
    restoreLiveVideoSlot();
    if (backToDetails !== false && vodMode !== 'live') {
        vodNav.screen = 'details';
        const d = vodNav.detail;
        if (d && d.item.kind === 'series' && d.info && d.info.seasons.length) {
            // Put the cursor on the episode to watch next
            const t = seriesPlayTarget(d.item, d.info);
            if (t) { vodNav.season = t.si; vodNav.epIdx = t.ei; vodNav.detailZone = 'episodes'; }
        }
        renderVodDetails();
    }
}
function saveVodProgress(force) {
    if (!vodPlay.active || !vodPlay.key) return;
    const now = Date.now();
    if (!force && now - vodPlay.saveAt < 10000) return;
    const pos = videoPlayer.currentTime || 0;
    const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) || vodPlay.dur || 0;
    vodPlay.saveAt = now;
    if (!vodPlay.ended && pos < vodMinResume(dur)) return; // not "in progress" yet
    const it = vodPlay.item;
    const watched = vodPlay.ended || (dur > 0 && pos / dur >= 0.9);
    const e = { kind: vodPlay.kind, id: vodPlay.kind === 'movie' ? it.id : vodPlay.ep.id, name: it.name, icon: it.icon, ext: it.ext, catId: it.catId,
                rating: it.rating || 0, pos: watched ? dur : pos, dur, at: now, watched };
    if (vodPlay.kind === 'episode') {
        e.seriesId = it.id; e.season = vodPlay.season; e.epNum = vodPlay.ep.num; e.epTitle = vodPlay.ep.title; e.epId = vodPlay.ep.id;
        e.lastOfSeries = !nextEpisode();
    }
    vodProgress[vodPlay.key] = e;
    pruneVodProgress();
    saveJson('iptv_vod_progress', vodProgress);
}
function updateVodOsd(posOverride) {
    if (livePlayer.active && !vodPlay.active) { updateLiveOsd(); return; }
    const pos = posOverride !== undefined ? posOverride : (videoPlayer.currentTime || 0);
    const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) || vodPlay.dur || 0;
    document.getElementById('vodOsdTitle').textContent = vodPlay.title || '';
    document.getElementById('vodOsdSub').textContent = vodPlay.sub || '';
    const pct = dur ? Math.min(100, pos / dur * 100) : 0;
    document.getElementById('vodBarFill').style.width = pct + '%';
    document.getElementById('vodBarKnob').style.left = pct + '%';
    document.getElementById('vodTimePos').textContent = fmtClock(pos);
    document.getElementById('vodTimeRem').textContent = dur ? '−' + fmtClock(Math.max(0, dur - pos)) : '';
}
// Live banner: channel number + name, group and current programme, programme progress as the bar
function updateLiveOsd() {
    const ch = currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
    if (!ch) return;
    if (catchup && catchup.chIdx === currentChannelIndex) {
        // Catch-up: the programme being replayed, its position as the bar
        const p = catchup.prog;
        document.getElementById('vodOsdTitle').textContent = `${chDisplayNum(ch, currentChannelIndex)}  ${ch.name} · ⏪ Catch-up`;
        document.getElementById('vodOsdSub').textContent = `${p.title} · ${formatClock(p.start)} – ${formatClock(p.stop)}`;
        const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) || catchup.dur || 0;
        const pos = videoPlayer.currentTime || 0;
        const pct = dur ? Math.min(100, pos / dur * 100) : 0;
        document.getElementById('vodBarFill').style.width = pct + '%';
        document.getElementById('vodBarKnob').style.left = pct + '%';
        document.getElementById('vodTimePos').textContent = fmtClock(pos);
        document.getElementById('vodTimeRem').textContent = dur ? '−' + fmtClock(Math.max(0, dur - pos)) : '';
        if (!document.getElementById('vodOsd').dataset.catchup) { document.getElementById('vodOsd').dataset.catchup = '1'; renderPlayerButtons(); }
        return;
    }
    if (document.getElementById('vodOsd').dataset.catchup) { document.getElementById('vodOsd').dataset.catchup = ''; renderPlayerButtons(); }
    const sc = surfChannel();
    if (sc) {
        // Channel surfing: the banner describes the previewed channel, not the one playing
        const now = getCurrentProgramme(sc.tvgId), next = getNextProgramme(sc.tvgId);
        document.getElementById('vodOsdTitle').textContent = `${chDisplayNum(sc, getChannelIndex(sc))}  ${sc.name}`;
        document.getElementById('vodOsdSub').textContent = [sc.group || '', now ? now.title : (sc.tvgId ? 'Loading programme …' : '')].filter(Boolean).join(' · ');
        let pct = 0;
        if (now && now.stop > now.start) pct = Math.min(100, Math.max(0, (Date.now() - now.start) / (now.stop - now.start) * 100));
        document.getElementById('vodBarFill').style.width = pct + '%';
        document.getElementById('vodBarKnob').style.left = pct + '%';
        document.getElementById('vodTimePos').textContent = now ? `${formatClock(now.start)} – ${formatClock(now.stop)}` : '';
        document.getElementById('vodTimeRem').textContent = next ? `Next: ${next.title} · ${formatClock(next.start)}` : '';
        document.getElementById('vodOsdTech').textContent = `▲ ▼ browse · OK watch · Back cancel · ${surf.idx + 1} / ${currentFilteredChannels.length}`;
        return;
    }
    const now = getCurrentProgramme(ch.tvgId), next = getNextProgramme(ch.tvgId);
    document.getElementById('vodOsdTitle').textContent = `${chDisplayNum(ch, currentChannelIndex)}  ${ch.name}`;
    const subBits = [ch.group || '', now ? now.title : ''].filter(Boolean);
    document.getElementById('vodOsdSub').textContent = subBits.join(' · ');
    let pct = 0;
    if (now && now.stop > now.start) pct = Math.min(100, Math.max(0, (Date.now() - now.start) / (now.stop - now.start) * 100));
    document.getElementById('vodBarFill').style.width = pct + '%';
    document.getElementById('vodBarKnob').style.left = pct + '%';
    const behind = liveBehindSecs();
    document.getElementById('vodTimePos').textContent = behind > 5 ? `⏪ −${fmtClock(behind)} behind live` : (now ? `${formatClock(now.start)} – ${formatClock(now.stop)}` : 'LIVE');
    document.getElementById('vodTimeRem').textContent = next ? `Next: ${next.title} · ${formatClock(next.start)}` : (now ? `${Math.max(0, Math.ceil((now.stop - Date.now()) / 60000))} min left` : '');
    const wasBehind = !!document.getElementById('vodOsd').dataset.behind;
    if ((behind > 5) !== wasBehind) { document.getElementById('vodOsd').dataset.behind = behind > 5 ? '1' : ''; renderPlayerButtons(); } // Go live button appears/disappears
}
function showVodOsd() {
    const osd = document.getElementById('vodOsd');
    updateVodOsd();
    renderPlayerButtons();
    osd.classList.add('visible');
    if (vodPlay.osdTimer) clearTimeout(vodPlay.osdTimer);
    vodPlay.osdTimer = setTimeout(() => {
        if (videoPlayer.paused && !surf.active) return; // keep it up while paused
        osd.classList.remove('visible');
        surfCancel(); // a preview that was not tuned is dropped with the banner
        player.focus = 'bar'; // next Up always starts from the bar
        updatePlayerFocus();
    }, surf.active ? 5000 : 3000);
}
function hideVodOsd() {
    const osd = document.getElementById('vodOsd');
    osd.classList.remove('visible');
    surfCancel();
    if (vodPlay.osdTimer) { clearTimeout(vodPlay.osdTimer); vodPlay.osdTimer = null; }
    player.focus = 'bar';
    updatePlayerFocus();
}
function toggleVodPause() {
    if (videoPlayer.paused) videoPlayer.play().catch(() => {}); else videoPlayer.pause();
    document.getElementById('vodPaused').classList.toggle('hidden', !videoPlayer.paused);
    showVodOsd();
}
// OSD button row. Up from the bar focuses it (CC first), Left/Right move, OK activates; Down returns to the bar.
function playerButtonsFor() {
    const btns = [];
    if (vodPlay.active) {
        if (vodPlay.kind === 'episode' && nextEpisode()) btns.push({ id: 'next', label: '⏭ Next episode', act: () => { vodPlay.nextEp = nextEpisode(); clearVodNext(); playNextEpisode(); } });
        btns.push({ id: 'cc', label: 'CC Audio & Subtitles', act: () => { if (vodTracksOpen()) closeVodTracks(); else openVodTracks(); } });
        btns.push({ id: 'settings', label: '⚙️ Settings', act: () => { closeVodTracks(); openSettings(); } });
    } else if (livePlayer.active) {
        if (catchup) btns.push({ id: 'live', label: '⏩ Back to live', act: catchupBackToLive });
        else if (liveBehindSecs() > 5) btns.push({ id: 'live', label: '⏩ Go live', act: liveGoLive });
        btns.push({ id: 'cc', label: 'CC Audio & Subtitles', act: () => { if (vodTracksOpen()) closeVodTracks(); else openVodTracks(); } });
        btns.push({ id: 'guide', label: currentPlaylistType === 'xtream' ? '📺 Guide' : '📡 Channels', act: exitLivePlayer });
        btns.push({ id: 'settings', label: '⚙️ Settings', act: () => { closeVodTracks(); openSettings(); } });
    }
    return btns;
}
function renderPlayerButtons() {
    const box = document.getElementById('vodOsdBtns'); if (!box) return;
    const btns = playerButtonsFor();
    const keep = player.btns[player.btn] && player.btns[player.btn].id;
    player.btns = btns;
    let idx = btns.findIndex(b => b.id === keep);
    if (idx < 0) idx = btns.findIndex(b => b.id === 'cc');
    player.btn = Math.max(0, idx);
    // Rebuild only when the set of buttons changes. The pointer's mousemove calls this constantly;
    // replacing the elements under the Magic Remote cursor made clicks land on nothing.
    const sig = btns.map(b => b.id).join(',');
    if (box.dataset.sig !== sig || box.children.length !== btns.length) {
        box.innerHTML = '';
        btns.forEach(b => {
            const el = document.createElement('button');
            el.className = 'vod-osd-btn' + (b.id === 'cc' ? ' vod-cc-btn' : '');
            el.dataset.id = b.id;
            if (b.id === 'cc') el.id = 'vodCcBtn';
            box.appendChild(el);
        });
        box.dataset.sig = sig;
    }
    Array.from(box.children).forEach((el, i) => {
        const b = btns[i];
        if (el.textContent !== b.label) el.textContent = b.label;
        el.onclick = e => { e.stopPropagation(); player.btn = i; b.act(); };
    });
    updatePlayerFocus();
}
function updatePlayerFocus() {
    const osd = document.getElementById('vodOsd'); if (!osd) return;
    osd.classList.toggle('bar-focused', player.focus === 'bar');
    const els = osd.querySelectorAll('.vod-osd-btn');
    els.forEach((el, i) => el.classList.toggle('focused', player.focus === 'buttons' && i === player.btn));
    const u = activeUms(); const on = u ? u.selectedSub >= 0 : getSubtitleTracks().some(t => t.mode === 'showing');
    const cc = document.getElementById('vodCcBtn'); if (cc) cc.classList.toggle('on', on);
}
function activatePlayerButton() {
    const b = player.btns[player.btn];
    if (b) b.act();
}
function handleVodPlayerKey(e, up, down, left, right, enter) {
    if (e.keyCode === 404 || e.key === 'ColorF1Green') { e.preventDefault(); if (vodTracksOpen()) closeVodTracks(); else openVodTracks(); return; }
    if (e.keyCode === 405 || e.key === 'ColorF2Yellow') { e.preventDefault(); closeVodTracks(); openSettings(); return; } // subtitle style etc., applied live
    if (vodTracksOpen()) {
        const it = vodPlay.tracksItems[vodPlay.tracksFocus];
        if (up || down) { e.preventDefault(); moveVodTracksFocus(up ? -1 : 1); }
        else if ((left || right) && it && it.kind === 'sync') { e.preventDefault(); umsSetSync(vodPlay.syncMs + (right ? 250 : -250)); renderVodTracks(); }
        else if (left || right || enter) e.preventDefault(); // Enter handled on keyup
        return;
    }
    if (vodNextVisible()) {
        if (left || right) { e.preventDefault(); vodPlay.nextFocus = left ? 'play' : 'cancel'; updateVodNextFocus(); }
        else if (up || down) e.preventDefault();
        return; // Enter is handled by the shared keyup listener
    }
    if (livePlayer.active && !vodPlay.active) {
        // Red: previous channel. Up/Down with the banner hidden (or while already surfing): channel surfing
        if (e.keyCode === 403 || e.key === 'ColorF0Red') { e.preventDefault(); surfCancel(); if (swapToPreviousChannel()) showVodOsd(); return; }
        const osdVisible = document.getElementById('vodOsd').classList.contains('visible');
        if ((up || down) && (surf.active || !osdVisible)) { e.preventDefault(); surfStep(down ? 1 : -1); return; }
    }
    if (up) { e.preventDefault(); if (player.focus === 'bar') player.focus = 'buttons'; showVodOsd(); }
    else if (down) { e.preventDefault(); player.focus = 'bar'; showVodOsd(); }
    else if ((left || right) && player.focus === 'buttons') {
        e.preventDefault();
        if (player.btns.length) player.btn = (player.btn + (right ? 1 : -1) + player.btns.length) % player.btns.length;
        showVodOsd();
    }
    else if (enter) e.preventDefault(); // handled on keyup: button activation or play/pause on the bar
}
function nextEpisode() {
    if (vodPlay.kind !== 'episode' || !vodPlay.seasons) return null;
    const si = vodPlay.seasons.findIndex(s => s.num === vodPlay.season);
    if (si < 0) return null;
    const eps = vodPlay.seasons[si].episodes;
    if (vodPlay.epIdx + 1 < eps.length) return { season: vodPlay.season, epIdx: vodPlay.epIdx + 1, ep: eps[vodPlay.epIdx + 1] };
    for (let j = si + 1; j < vodPlay.seasons.length; j++) if (vodPlay.seasons[j].episodes.length) return { season: vodPlay.seasons[j].num, epIdx: 0, ep: vodPlay.seasons[j].episodes[0] };
    return null;
}
function onVodEnded() {
    if (!vodPlay.active) { if (catchup && vodMode === 'live') catchupBackToLive(); return; } // a catch-up programme ended: back to live

    vodPlay.ended = true;
    saveVodProgress(true);
    const nxt = nextEpisode();
    if (nxt) { showVodNext(nxt); return; }
    stopVodPlayback(true);
}
function showVodNext(nxt) {
    vodPlay.nextEp = nxt; vodPlay.nextCountdown = VOD_NEXT_COUNTDOWN; vodPlay.nextFocus = 'play';
    document.getElementById('vodNextName').textContent = `${vodPlay.item.name} · S${nxt.season} E${nxt.ep.num}${nxt.ep.title ? ' · ' + nxt.ep.title : ''}`;
    document.getElementById('vodNext').classList.remove('hidden');
    updateVodNextFocus();
    if (settings.autoNext === false) { document.getElementById('vodNextLabel').textContent = 'Up next'; return; } // card only; OK plays, Back leaves
    const tick = () => {
        document.getElementById('vodNextLabel').textContent = `Up next · plays in ${vodPlay.nextCountdown} s`;
        if (vodPlay.nextCountdown <= 0) { playNextEpisode(); return; }
        vodPlay.nextCountdown--;
        vodPlay.nextTimer = setTimeout(tick, 1000);
    };
    tick();
}
function updateVodNextFocus() {
    document.getElementById('vodNextPlay').classList.toggle('focused', vodPlay.nextFocus !== 'cancel');
    document.getElementById('vodNextCancel').classList.toggle('focused', vodPlay.nextFocus === 'cancel');
}
function clearVodNext() {
    if (vodPlay.nextTimer) { clearTimeout(vodPlay.nextTimer); vodPlay.nextTimer = null; }
    vodPlay.nextEp = null;
    document.getElementById('vodNext').classList.add('hidden');
}
function playNextEpisode() {
    const nxt = vodPlay.nextEp; if (!nxt) return;
    const item = vodPlay.item, seasons = vodPlay.seasons;
    clearVodNext();
    startVodPlayback({ kind: 'episode', item, ep: nxt.ep, season: nxt.season, epIdx: nxt.epIdx, seasons });
}
function activateVodNext() {
    if (vodPlay.nextFocus === 'cancel') { clearVodNext(); stopVodPlayback(true); }
    else playNextEpisode();
}
// ── audio & subtitle tracks (VOD) ────────────────────────────
function trackMatchesLang(track, lang) {
    const l = (track.language || '').toLowerCase();
    const lb = (track.label || '').toLowerCase();
    const name = (LANG_NAMES[lang] || '').toLowerCase();
    return l === lang || l.slice(0, 2) === lang || l.startsWith(lang + '-') || (!!name && lb.includes(name));
}
function trackDisplayName(track, i) {
    const lang = track.language ? resolveLanguage(track.language) : null;
    let name = (track.label && track.label.trim()) || lang || ('Track ' + (i + 1));
    if (track.kind === 'captions') name += ' [CC]';
    else if (track.kind && track.kind !== 'main' && track.kind !== 'subtitles' && track.kind !== '') name += ' [' + track.kind + ']';
    return name;
}
// Apply the Settings preferences to whatever tracks the file exposes (unless the user picked manually)
function applyVodTrackPrefs() {
    if (!vodPlay.active) return;
    const u = vodPlay.ums;
    if (u && u.subTracks.length) {
        if (!vodPlay.subManual) {
            const pref = settings.subLang;
            let chosen = null;
            if (settings.subAuto) {
                if (pref === 'any') chosen = u.subTracks[0];
                else chosen = u.subTracks.find(t => trackMatchesLang({ language: t.language, label: t.languageName }, pref)) || null;
            }
            umsSelectSubtitle(chosen ? chosen.trackNum : -1);
        }
        if (u.audioTracks.length > 1 && !vodPlay.audioManual && settings.audioLang !== 'default') {
            const i = u.audioTracks.findIndex(t => trackMatchesLang({ language: t.language, label: '' }, settings.audioLang));
            if (i >= 0 && i !== u.selectedAudio) umsSelectAudio(i);
        }
        updateVodTracksHint();
        return;
    }
    const subs = getSubtitleTracks();
    if (subs.length && !vodPlay.subManual) {
        const pref = settings.subLang;
        let chosen = null;
        if (settings.subAuto) {
            if (pref === 'any') chosen = subs[0];
            else chosen = subs.find(t => trackMatchesLang(t, pref)) || null;
        }
        subs.forEach(t => { const want = t === chosen ? 'showing' : 'disabled'; if (t.mode !== want) t.mode = want; });
    }
    const auds = getAudioTracks();
    if (auds.length > 1 && !vodPlay.audioManual && settings.audioLang !== 'default') {
        const t = auds.find(a => trackMatchesLang(a, settings.audioLang));
        if (t && !t.enabled) auds.forEach(a => { a.enabled = a === t; });
    }
    updateVodTracksHint();
}
function updateVodTracksHint() {
    const el = document.getElementById('vodOsdTracks');
    if (!el) return;
    const u = activeUms();
    if (u && u.subTracks.length) {
        const on = u.subTracks.find(t => t.trackNum === u.selectedSub);
        const bits = ['Subtitles: ' + (on ? umsTrackLabel(on, u.subTracks) : 'Off')];
        if (u.audioTracks.length > 1) { const a = u.audioTracks[u.selectedAudio]; if (a) bits.push('Audio: ' + umsAudioLabel(a, u.selectedAudio)); }
        bits.push('Green: audio & subtitles');
        el.textContent = bits.join(' · ');
        updatePlayerFocus();
        return;
    }
    const subs = getSubtitleTracks(), auds = getAudioTracks();
    const on = subs.find(t => t.mode === 'showing');
    const bits = [];
    if (subs.length) bits.push('Subtitles: ' + (on ? trackDisplayName(on, subs.indexOf(on)) : 'Off'));
    if (auds.length > 1) { const a = auds.find(t => t.enabled); if (a) bits.push('Audio: ' + trackDisplayName(a, auds.indexOf(a))); }
    if (!subs.length) bits.push('No subtitle tracks in this file');
    bits.push('Green: audio & subtitles');
    el.textContent = bits.join(' · ');
    updatePlayerFocus();
}
function vodTracksOpen() { const p = document.getElementById('vodTracks'); return !!p && !p.classList.contains('hidden'); }
function vodTracksItems() {
    const items = [];
    // Live through hls.js: its own alternate audio and subtitle renditions (the media service does not see MSE playback)
    if (!vodPlay.active && liveEngineActive()) {
        const h = liveEngine.hls;
        const auds = h.audioTracks || [], subs = h.subtitleTracks || [];
        if (auds.length > 1) { items.push({ header: 'Audio' }); auds.forEach((t, i) => items.push({ kind: 'audio', hls: i, label: hlsTrackLabel(t, i), on: i === h.audioTrack })); }
        items.push({ header: 'Subtitles' });
        items.push({ kind: 'sub', hls: -1, label: 'Off', on: h.subtitleTrack < 0 || !h.subtitleDisplay });
        subs.forEach((t, i) => items.push({ kind: 'sub', hls: i, label: hlsTrackLabel(t, i), on: i === h.subtitleTrack && h.subtitleDisplay }));
        if (!subs.length) items.push({ note: 'This channel has no subtitle tracks.' });
        return items;
    }
    const u = activeUms();
    if (u && (u.subTracks.length || u.audioTracks.length > 1)) {
        if (u.audioTracks.length > 1) { items.push({ header: 'Audio' }); u.audioTracks.forEach((t, i) => items.push({ kind: 'audio', ums: i, label: umsAudioLabel(t, i), on: i === u.selectedAudio })); }
        items.push({ header: 'Subtitles' });
        items.push({ kind: 'sub', ums: -1, label: 'Off', on: u.selectedSub < 0 });
        u.subTracks.forEach(t => items.push({ kind: 'sub', ums: t.trackNum, label: umsTrackLabel(t, u.subTracks), on: t.trackNum === u.selectedSub }));
        if (!u.subTracks.length) items.push({ note: vodPlay.active ? 'This file has no subtitle tracks.' : 'This channel has no subtitle tracks.' });
        else if (vodPlay.active) { items.push({ header: 'Timing' }); items.push({ kind: 'sync', label: `Sync offset  ◀ ${vodPlay.syncMs > 0 ? '+' : ''}${(vodPlay.syncMs / 1000).toFixed(2)} s ▶`, on: vodPlay.syncMs !== 0 }); }
        return items;
    }
    const auds = getAudioTracks();
    if (auds.length > 1) { items.push({ header: 'Audio' }); auds.forEach((t, i) => items.push({ kind: 'audio', track: t, label: trackDisplayName(t, i), on: !!t.enabled })); }
    const subs = getSubtitleTracks();
    items.push({ header: 'Subtitles' });
    items.push({ kind: 'sub', track: null, label: 'Off', on: !subs.some(t => t.mode === 'showing') });
    subs.forEach((t, i) => items.push({ kind: 'sub', track: t, label: trackDisplayName(t, i), on: t.mode === 'showing' }));
    if (!subs.length) items.push({ note: 'This file has no subtitle tracks. Only subtitles embedded in the provider\'s file can be shown.' });
    return items;
}
function openVodTracks() {
    if (!playerActive()) return;
    const items = vodTracksItems();
    vodPlay.tracksItems = items;
    // Open on the active subtitle row (the menu's main purpose); fall back to the first selectable row
    let first = items.findIndex(it => it.kind === 'sub' && it.on);
    if (first < 0) first = items.findIndex(it => it.kind && it.on);
    vodPlay.tracksFocus = first >= 0 ? first : items.findIndex(it => it.kind);
    document.getElementById('vodTracks').classList.remove('hidden');
    renderVodTracks();
    showVodOsd();
}
function closeVodTracks() { const p = document.getElementById('vodTracks'); if (p) p.classList.add('hidden'); }
function renderVodTracks() {
    const list = document.getElementById('vodTracksList'); if (!list) return;
    const items = vodTracksItems();
    vodPlay.tracksItems = items;
    if (vodPlay.tracksFocus >= items.length || !items[vodPlay.tracksFocus] || !items[vodPlay.tracksFocus].kind) vodPlay.tracksFocus = items.findIndex(it => it.kind);
    list.innerHTML = '';
    items.forEach((it, i) => {
        if (it.header) { list.appendChild(el('div', 'vod-tracks-h', escapeHtml(it.header))); return; }
        if (it.note) { list.appendChild(el('div', 'vod-tracks-note', escapeHtml(it.note))); return; }
        const row = el('div', 'vod-track' + (it.on ? ' on' : '') + (i === vodPlay.tracksFocus ? ' focused' : ''), `<span class="vod-track-dot">${it.on ? '●' : '○'}</span>${escapeHtml(it.label)}`);
        // stopPropagation: activateVodTrack re-renders this list, so by the time the click bubbled to the
        // player the row was detached and looked like a click on the video (which toggled pause)
        row.addEventListener('click', e => { e.stopPropagation(); vodPlay.tracksFocus = i; activateVodTrack(); });
        list.appendChild(row);
    });
    const f = list.querySelector('.vod-track.focused'); if (f) f.scrollIntoView({ block: 'nearest' });
}
function moveVodTracksFocus(dir) {
    const items = vodPlay.tracksItems;
    let i = vodPlay.tracksFocus;
    do { i += dir; } while (i >= 0 && i < items.length && !items[i].kind);
    if (i >= 0 && i < items.length) { vodPlay.tracksFocus = i; renderVodTracks(); }
}
function hlsTrackLabel(t, i) {
    const lang = t.lang ? resolveLanguage(t.lang) : '';
    const name = (t.name || '').trim();
    if (name && lang && name.toLowerCase() !== lang.toLowerCase()) return `${lang} · ${name}`;
    return name || lang || ('Track ' + (i + 1));
}
// Settings language preferences applied to hls.js renditions when a channel announces them
function applyHlsTrackPrefs() {
    const h = liveEngine.hls; if (!h) return;
    const subs = h.subtitleTracks || [], auds = h.audioTracks || [];
    if (subs.length && !liveEngine.subManual) {
        let pick = -1;
        if (settings.subAuto) pick = settings.subLang === 'any' ? 0 : subs.findIndex(t => trackMatchesLang({ language: t.lang || '', label: t.name || '' }, settings.subLang));
        h.subtitleTrack = pick; h.subtitleDisplay = pick >= 0;
    }
    if (auds.length > 1 && !liveEngine.audioManual && settings.audioLang !== 'default') {
        const i = auds.findIndex(t => trackMatchesLang({ language: t.lang || '', label: t.name || '' }, settings.audioLang));
        if (i >= 0 && i !== h.audioTrack) h.audioTrack = i;
    }
    updateVodTracksHint();
}
function activateVodTrack() {
    const it = vodPlay.tracksItems[vodPlay.tracksFocus];
    if (!it || !it.kind) return;
    if (it.kind === 'sync') { umsSetSync(0); renderVodTracks(); showVodOsd(); return; } // OK resets the offset
    if (it.hls !== undefined && liveEngine.hls) {
        const h = liveEngine.hls;
        if (it.kind === 'sub') { h.subtitleTrack = it.hls; h.subtitleDisplay = it.hls >= 0; liveEngine.subManual = true; }
        else { h.audioTrack = it.hls; liveEngine.audioManual = true; }
        updateVodTracksHint(); renderVodTracks(); showVodOsd();
        return;
    }
    if (it.ums !== undefined) {
        const u = activeUms();
        if (it.kind === 'sub') { umsSelectSubtitle(it.ums, u); if (u) u.subManual = true; vodPlay.subManual = true; }
        else { umsSelectAudio(it.ums, u); if (u) u.audioManual = true; vodPlay.audioManual = true; }
        updateVodTracksHint(); renderVodTracks(); showVodOsd();
        return;
    }
    if (it.kind === 'sub') {
        getSubtitleTracks().forEach(t => { t.mode = t === it.track ? 'showing' : 'disabled'; });
        vodPlay.subManual = true;
    } else {
        getAudioTracks().forEach(t => { t.enabled = t === it.track; });
        vodPlay.audioManual = true;
    }
    updateVodTracksHint();
    renderVodTracks();
    showVodOsd();
}

// ── webOS media service (luna://com.webos.media) ─────────────
// The HTML <video> on webOS never exposes subtitle tracks embedded in MKV
// files, but the app may subscribe to its own pipeline (video.mediaId) and
// call selectTrack / setSubtitleEnable on it. sourceInfo arrives on load with
// the full subtitle/audio/video track lists. getActivePipelines and
// getPipelineState are denied to third-party apps, so subscribe early.
function umsAvailable() { return typeof webOS !== 'undefined' && webOS.service && typeof webOS.service.request === 'function'; }
function umsCall(method, parameters) {
    return new Promise(res => {
        if (!umsAvailable()) return res({ ok: false, e: 'no webOS' });
        try { webOS.service.request('luna://com.webos.media', { method, parameters, onSuccess: r => res({ ok: !!r.returnValue, r }), onFailure: e => res({ ok: false, e }) }); }
        catch (ex) { res({ ok: false, e: String(ex) }); }
        setTimeout(() => res({ ok: false, e: 'timeout' }), 5000);
    });
}
let _umsPrevId = '';   // pipeline id seen before the last src change; the new pipeline must differ
function umsValidId(id) { return !!id && typeof id === 'string' && id.charAt(0) !== '<'; }
function umsNoteCurrentId() { const id = videoPlayer.mediaId; _umsPrevId = umsValidId(id) ? id : ''; }
// Subscribe to the pipeline that the <video> is about to create. kind: 'vod' | 'live'
function umsAttachFor(kind) {
    if (!umsAvailable()) return null;
    const u = { kind, mediaId: '', sub: null, subTracks: [], audioTracks: [], video: null, videoInfo: null, selectedSub: -1, selectedAudio: 0, keys: {}, dead: false };
    const t0 = Date.now();
    const prev = _umsPrevId;
    const poll = () => {
        if (u.dead) return;
        const id = videoPlayer.mediaId;
        // Wait for a new pipeline id; after 1.5 s accept an unchanged one (the old pipeline is gone by then)
        if (!umsValidId(id) || (id === prev && Date.now() - t0 < 1500)) { if (Date.now() - t0 < 10000) setTimeout(poll, 25); return; }
        u.mediaId = id;
        try {
            u.sub = webOS.service.request('luna://com.webos.media', { method: 'subscribe', parameters: { mediaId: id }, subscribe: true,
                onSuccess: m => { if (!u.dead) umsOnMessage(u, m); },
                onFailure: () => { /* subscription refused: HTML track fallback stays in place */ } });
        } catch (_) { u.dead = true; }
    };
    poll();
    return u;
}
function umsRelease(u) {
    if (!u) return;
    u.dead = true;
    if (u.sub && typeof u.sub.cancel === 'function') { try { u.sub.cancel(); } catch (_) { /* already gone */ } }
}
function umsAttach() { umsDetach(); vodPlay.ums = umsAttachFor('vod'); }
function umsDetach() { umsRelease(vodPlay.ums); vodPlay.ums = null; }
function liveUmsRefresh() { umsRelease(liveUms); liveUms = (vodMode === 'live' && !vodPlay.active) ? umsAttachFor('live') : null; }
function umsOnMessage(u, m) {
    for (const k of Object.keys(m)) if (k !== 'returnValue') u.keys[k] = (u.keys[k] || 0) + 1;
    let techChanged = false;
    if (m.sourceInfo && Array.isArray(m.sourceInfo.programInfo) && m.sourceInfo.programInfo.length) {
        const p = m.sourceInfo.programInfo[0];
        u.container = m.sourceInfo.container || '';
        u.subTracks = (p.subtitleTrackInfo || []).map((t, i) => ({ trackNum: typeof t.trackNum === 'number' ? t.trackNum : i, language: t.language || '', languageName: t.languageName || '', type: t.type || 'text' }));
        u.audioTracks = (p.audioTrackInfo || []).map(t => ({ language: t.language || '', codec: t.codec || '', channels: t.channels || 0, sampleRate: t.sampleRate || 0 }));
        u.video = (p.videoTrackInfo || [])[0] || null;
        techChanged = true;
        if (u.kind === 'vod' && vodPlay.ums === u) { applyVodTrackPrefs(); if (vodTracksOpen()) renderVodTracks(); }
        else if (u.kind === 'live' && liveUms === u) { applyLiveTrackPrefs(u); if (vodTracksOpen()) renderVodTracks(); if (livePlayer.active) updateVodTracksHint(); }
    }
    if (m.videoInfo) { u.videoInfo = Object.assign(u.videoInfo || {}, m.videoInfo); techChanged = true; }
    if (m.audioInfo) { u.audioInfo = Object.assign(u.audioInfo || {}, m.audioInfo); techChanged = true; }
    if (techChanged) umsTechUpdated(u);
    if (m.error) { /* keep playing; the HTML error handler reports real failures */ }
}
// Re-apply the subtitle preferences to whatever is playing (Settings changed)
function reapplySubtitlePrefs() {
    if (vodPlay.active) { vodPlay.subManual = false; applyVodTrackPrefs(); }
    else if (liveUms) { liveUms.subManual = false; applyLiveTrackPrefs(liveUms); }
}
// Live: same subtitle/audio language preferences as VOD, applied to the live pipeline unless chosen manually
function applyLiveTrackPrefs(u) {
    if (!u || u.subManual) { if (u && u.audioTracks.length > 1 && !u.audioManual && settings.audioLang !== 'default') { const i = u.audioTracks.findIndex(t => trackMatchesLang({ language: t.language, label: '' }, settings.audioLang)); if (i >= 0 && i !== u.selectedAudio) umsSelectAudio(i, u); } return; }
    if (u.subTracks.length) {
        const pref = settings.subLang;
        let chosen = null;
        if (settings.subAuto) {
            if (pref === 'any') chosen = u.subTracks[0];
            else chosen = u.subTracks.find(t => trackMatchesLang({ language: t.language, label: t.languageName }, pref)) || null;
        }
        umsSelectSubtitle(chosen ? chosen.trackNum : -1, u);
    }
    if (u.audioTracks.length > 1 && !u.audioManual && settings.audioLang !== 'default') {
        const i = u.audioTracks.findIndex(t => trackMatchesLang({ language: t.language, label: '' }, settings.audioLang));
        if (i >= 0 && i !== u.selectedAudio) umsSelectAudio(i, u);
    }
}
// Codec / resolution / HDR summary from the pipeline, e.g. "HEVC · 10-bit · 3840×1600 · 23.98 fps · HDR10 · E-AC-3 5.1"
function umsTechString(u) {
    if (!u || !u.video) return '';
    const v = u.video, vi = u.videoInfo || {};
    const bits = [];
    if (v.codec) bits.push(String(v.codec).toUpperCase().replace(/^H264$/, 'H.264').replace(/^H265$/, 'HEVC'));
    if (/10/.test(String(v.profile || '')) || vi.bitDepth === 10) bits.push('10-bit');
    const w = vi.width || v.width, h = vi.height || v.height;
    if (w && h) bits.push(`${w}×${h}`);
    const fps = vi.frameRate || v.frameRate || (u.measuredFps || 0);
    if (fps) bits.push(fmtFps(fps));
    const hdr = vi.hdrType || vi.hdr || vi.transferCharacteristics || '';
    if (hdr && !/^(none|sdr|0)$/i.test(String(hdr))) bits.push(String(hdr).replace(/dolby\s*vision|dolbyvision|dv/i, 'Dolby Vision').replace(/hdr10plus|hdr10\+/i, 'HDR10+').replace(/^hlg$/i, 'HLG').replace(/^hdr10$/i, 'HDR10'));
    const a = u.audioTracks[u.selectedAudio] || u.audioTracks[0];
    if (a) {
        const codec = String(a.codec || '').toUpperCase().replace(/^EAC3$/, 'E-AC-3').replace(/^AC3$/, 'AC-3').replace(/^TRUEHD$/, 'TrueHD');
        const ch = a.channels >= 8 ? '7.1' : a.channels >= 6 ? '5.1' : a.channels === 2 ? 'Stereo' : a.channels === 1 ? 'Mono' : '';
        const s = [codec, ch].filter(Boolean).join(' ');
        if (s) bits.push(s);
    }
    return bits.join(' · ');
}
// When the media service names no frame rate, count decoded frames over 3 s (getVideoPlaybackQuality); a counter
// that does not move (frames rendered on the TV's video plane bypass the browser) leaves the line without fps
function umsMeasureFps(u) {
    if (u.fpsTried || !u.video || u.video.frameRate || (u.videoInfo && u.videoInfo.frameRate) || !videoPlayer.getVideoPlaybackQuality) return;
    u.fpsTried = true;
    const q0 = videoPlayer.getVideoPlaybackQuality().totalVideoFrames, t0 = performance.now();
    setTimeout(() => {
        const live = u.kind === 'live' ? liveUms === u : vodPlay.ums === u;
        if (!live || videoPlayer.paused) return;
        const n = videoPlayer.getVideoPlaybackQuality().totalVideoFrames - q0, dt = (performance.now() - t0) / 1000;
        if (n > 0 && dt > 1) { u.measuredFps = fpsSnap(n / dt); umsTechUpdated(u); }
    }, 3000);
}
function umsTechUpdated(u) {
    const s = umsTechString(u);
    umsMeasureFps(u);
    if (u.kind === 'vod' && vodPlay.ums === u) {
        const el = document.getElementById('vodOsdTech'); if (el) el.textContent = s;
        if (s && vodPlay.key) { vodTech[vodPlay.key] = s; const ks = Object.keys(vodTech); if (ks.length > 300) delete vodTech[ks[0]]; saveJson('iptv_vod_tech', vodTech); }
    } else if (u.kind === 'live' && liveUms === u) {
        if (livePlayer.active) { const el = document.getElementById('vodOsdTech'); if (el) el.textContent = s; if (s) showVodOsd(); }
        else if (s) showFeedStats(s);
    }
}
// Brief chip over the live picture (panel view) with the feed's codec/resolution/audio
let _feedStatsTimer = null;
function showFeedStats(text) {
    if (vodMode !== 'live' || vodPlay.active || livePlayer.active || !text) return;
    const wrap = (currentPlaylistType === 'xtream' && epgMode) ? document.getElementById('epgVideoWrap') : videoArea;
    let chip = document.getElementById('feedStats');
    if (!chip) { chip = document.createElement('div'); chip.id = 'feedStats'; chip.className = 'feed-stats'; }
    if (chip.parentNode !== wrap) wrap.appendChild(chip);
    chip.textContent = text;
    chip.classList.add('visible');
    if (_feedStatsTimer) clearTimeout(_feedStatsTimer);
    _feedStatsTimer = setTimeout(() => chip.classList.remove('visible'), 4000);
}
// Subtitle appearance (Settings) and the per-title sync offset, applied to the pipeline
async function umsApplySubtitleStyle(u) {
    u = u || activeUms(); if (!u || !u.mediaId) return;
    const id = u.mediaId;
    const sizeIdx = Math.max(0, SUB_SIZE_OPTIONS.findIndex(o => o.v === settings.subSize));
    await umsCall('setSubtitleCharacterFontSize', { mediaId: id, charFontSize: settings.subSize });
    await umsCall('setSubtitleFontSize', { mediaId: id, fontSize: sizeIdx });
    await umsCall('setSubtitleCharacterColor', { mediaId: id, charColor: settings.subColor });
    // charOpacity is on a 0–255 scale on the C4 (100 rendered visibly translucent, and 85 vs 100 looked the same);
    // send the 0–255 value and fall back to the percentage if a firmware rejects values above 100
    const op255 = Math.round(settings.subOpacity * 2.55);
    const opRes = await umsCall('setSubtitleCharacterOpacity', { mediaId: id, charOpacity: op255 });
    if (!opRes.ok && op255 > 100) await umsCall('setSubtitleCharacterOpacity', { mediaId: id, charOpacity: settings.subOpacity });
    await umsCall('setSubtitleBackgroundColor', { mediaId: id, bgColor: 'black' });
    const bgOpacity = settings.subBg === 'none' ? 0 : settings.subBg === 'solid' ? 100 : 50;
    await umsCall('setSubtitleBackgroundOpacity', { mediaId: id, bgOpacity });
    if (settings.subBg === 'solid') await umsCall('setSubtitleBackgroundOpacity', { mediaId: id, bgOpacity: 255 }); // 0-255 scale on some firmware; ignored otherwise
    // Edge colour is never set by the pipeline on its own; without it the edge is invisible
    await umsCall('setSubtitleCharacterEdgeColor', { mediaId: id, charEdgeColor: 'black' });
    await umsCall('setSubtitleCharacterEdge', { mediaId: id, charEdgeType: SUB_EDGE_UMS[settings.subEdge] || 'none' });
    await umsCall('setSubtitleSync', { mediaId: id, sync: u.kind === 'vod' ? (vodPlay.syncMs || 0) : 0 });
}
function umsSetSync(ms) {
    ms = Math.max(-10000, Math.min(10000, Math.round(ms / 50) * 50));
    vodPlay.syncMs = ms;
    if (vodPlay.key) { if (ms) vodSubSync[vodPlay.key] = ms; else delete vodSubSync[vodPlay.key]; saveJson('iptv_vod_subsync', vodSubSync); }
    const u = vodPlay.ums; if (u && u.mediaId) umsCall('setSubtitleSync', { mediaId: u.mediaId, sync: ms });
    updateVodTracksHint();
}
// Native speed playback through the pipeline (picture at 2×…32×); falls back to the scrub bar if the position does not move
const _UMS_RATE_RAMP = [{ after: 0, speed: 2 }, { after: 1500, speed: 4 }, { after: 4000, speed: 8 }, { after: 8000, speed: 16 }, { after: 12000, speed: 32 }];
function startNativeRate(dir) {
    const u = vodPlay.ums;
    const startT = videoPlayer.currentTime || 0, startAt = Date.now();
    let checked = false;
    if (vodPlay.osdTimer) { clearTimeout(vodPlay.osdTimer); vodPlay.osdTimer = null; }
    document.getElementById('vodOsd').classList.add('visible');
    videoPlayer.play().catch(() => {});
    _trickInterval = setInterval(() => {
        const rate = _getRampSpeed(_UMS_RATE_RAMP, Date.now() - _trickHoldStart) * (dir === 'left' ? -1 : 1);
        if (rate !== _nativeRate) { _nativeRate = rate; umsCall('setPlayRate', { mediaId: u.mediaId, playRate: rate, audioOutput: false }); }
        _showTrickBadge((dir === 'left' ? '◀◀ ' : '▶▶ ') + Math.abs(rate) + '×');
        updateVodOsd();
        const t = videoPlayer.currentTime || 0;
        if (!checked && Date.now() - startAt > 1500) {
            checked = true;
            const d = t - startT;
            if ((dir === 'right' && d < 0.5) || (dir === 'left' && d > -0.5)) {
                // The pipeline did not honour the rate on this file: switch to scrubbing for the rest of the session
                _umsRateBroken = true;
                _nativeRate = 0;
                umsCall('setPlayRate', { mediaId: u.mediaId, playRate: 1, audioOutput: true });
                clearInterval(_trickInterval); _trickInterval = null;
                videoPlayer.pause();
                startScrub(dir);
                return;
            }
        }
        const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) || vodPlay.dur || 0;
        if ((dir === 'right' && dur && t >= dur - 1) || (dir === 'left' && t <= 0.5)) _stopHold();
    }, 100);
}
function startScrub(dir) {
    _scrubPos = videoPlayer.currentTime || 0;
    if (vodPlay.osdTimer) { clearTimeout(vodPlay.osdTimer); vodPlay.osdTimer = null; }
    document.getElementById('vodOsd').classList.add('visible');
    _trickInterval = setInterval(() => {
        const heldMs = Date.now() - _trickHoldStart;
        const speed  = _getRampSpeed(_VOD_SCRUB_RAMP, heldMs);
        const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) || vodPlay.dur || 0;
        const max = dur ? Math.max(0, dur - 1) : Number.MAX_VALUE;
        _scrubPos = Math.max(0, Math.min(max, _scrubPos + (dir === 'left' ? -1 : 1) * speed * 0.1));
        _showTrickBadge((dir === 'left' ? '◀◀ ' : '▶▶ ') + speed + '×');
        updateVodOsd(_scrubPos);
        if ((dir === 'right' && dur && _scrubPos >= max) || (dir === 'left' && _scrubPos <= 0)) _stopHold();
    }, 100);
}
function umsTrackLabel(t, all) {
    const base = t.languageName ? t.languageName.split(/[;,]/)[0].trim() : (t.language ? resolveLanguage(t.language) : ('Track ' + (t.trackNum + 1)));
    const same = all.filter(x => (x.languageName || x.language) === (t.languageName || t.language));
    if (same.length > 1) return `${base} ${same.indexOf(t) + 1}`;
    return base;
}
function umsAudioLabel(t, i) {
    const lang = t.language ? resolveLanguage(t.language) : ('Track ' + (i + 1));
    const ch = t.channels >= 6 ? '5.1' : t.channels === 2 ? 'Stereo' : t.channels === 1 ? 'Mono' : '';
    return [lang, (t.codec || '').toUpperCase(), ch].filter(Boolean).join(' · ');
}
async function umsSelectSubtitle(trackNum, u) {
    u = u || activeUms(); if (!u || !u.mediaId) return;
    u.selectedSub = trackNum;
    if (trackNum < 0) { await umsCall('setSubtitleEnable', { mediaId: u.mediaId, enable: false }); }
    else {
        await umsCall('selectTrack', { mediaId: u.mediaId, type: 'text', index: trackNum });
        await umsCall('setSubtitleEnable', { mediaId: u.mediaId, enable: true });
        umsApplySubtitleStyle(u);
    }
    updateVodTracksHint();
}
async function umsSelectAudio(index, u) {
    u = u || activeUms(); if (!u || !u.mediaId) return;
    u.selectedAudio = index;
    await umsCall('selectTrack', { mediaId: u.mediaId, type: 'audio', index });
    updateVodTracksHint();
}

function onVodError() {
    const code = videoPlayer.error ? videoPlayer.error.code : 0;
    const msg = code === 2 ? 'Network error' : code === 3 ? 'Decode error' : code === 4 ? 'File unavailable or unsupported' : 'Playback error';
    const title = vodPlay.title;
    stopVodPlayback(true);
    showEPGToast(`${title}: ${msg}`, 'error', 'Playback Error');
    hideEPGToast(7000);
}

// ----- Settings -----
function loadSettings() {
    let st = {};
    try { st = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (_) { st = {}; }
    const out = Object.assign({}, DEFAULT_SETTINGS, st);
    if (TEXT_SCALE_OPTIONS.indexOf(out.textScale) === -1) out.textScale = DEFAULT_SETTINGS.textScale;
    if (out.clock !== '12' && out.clock !== '24') out.clock = DEFAULT_SETTINGS.clock;
    out.autoLoad = !!out.autoLoad;
    out.showAdult = !!out.showAdult;
    if (!SUB_LANG_OPTIONS.some(o => o.v === out.subLang)) out.subLang = DEFAULT_SETTINGS.subLang;
    if (!AUDIO_LANG_OPTIONS.some(o => o.v === out.audioLang)) out.audioLang = DEFAULT_SETTINGS.audioLang;
    for (const [k, opts] of [['subSize', SUB_SIZE_OPTIONS], ['subColor', SUB_COLOR_OPTIONS], ['subBg', SUB_BG_OPTIONS], ['subEdge', SUB_EDGE_OPTIONS]]) if (!opts.some(o => o.v === out[k])) out[k] = DEFAULT_SETTINGS[k];
    if (!(st.schema >= 3)) { out.subAuto = false; out.schema = 3; }  // v3.8.0: subtitles no longer turn on by themselves unless asked
    // v3.9.0: Grey (white at 85 % opacity) became the separate Subtitle opacity setting
    if (!(st.schema >= 4)) { if (st.subColor === 'gray' || st.subColor === undefined) { out.subColor = 'white'; out.subOpacity = 85; } else out.subOpacity = 100; out.schema = 4; }
    if (out.subColor === 'gray') out.subColor = 'white';
    if (!SUB_OPACITY_OPTIONS.some(o => o.v === out.subOpacity)) out.subOpacity = DEFAULT_SETTINGS.subOpacity;
    if (!PPV_EVENT_OPTIONS.some(o => o.v === out.ppvEvents)) out.ppvEvents = DEFAULT_SETTINGS.ppvEvents;
    out.subAuto = !!out.subAuto;
    if (out.subLang === 'off') out.subLang = 'en';
    if (!LIVE_BUFFER_OPTIONS.some(o => o.v === out.liveBuffer)) out.liveBuffer = DEFAULT_SETTINGS.liveBuffer;
    out.autoNext = st.autoNext === undefined ? true : !!st.autoNext;
    out.avSync = Number.isInteger(st.avSync) && st.avSync >= AV_SYNC_MIN && st.avSync <= AV_SYNC_MAX ? st.avSync : -1;
    return out;
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* storage unavailable */ } }
function loadPlaylistState() { try { return JSON.parse(localStorage.getItem(PLAYLIST_STATE_KEY) || '{}') || {}; } catch (_) { return {}; } }
function savePlaylistState() { try { localStorage.setItem(PLAYLIST_STATE_KEY, JSON.stringify(playlistState)); } catch (_) { /* storage unavailable */ } }
function getPlaylistState(key) { if (!playlistState[key]) playlistState[key] = {}; return playlistState[key]; }
function playlistKeyOf(p) { return p.type === 'xtream' ? 'x:' + String(p.url).replace(/\/$/, '') + '|' + p.username : 'm:' + p.url; }
function rememberLastPlaylist(key) { try { localStorage.setItem(LAST_PLAYLIST_KEY, key); } catch (_) { /* storage unavailable */ } }
function refreshViewIfLoaded() { if (currentPlaylistType) refreshCurrentView(); }

// Starting group for a playlist: Favorites (default), All Channels, or the last group used
function initialGroupFor(key) {
    const ps = getPlaylistState(key);
    if (ps.startGroup === 'all' || ps.startGroup === 'recent') return ps.startGroup;
    if (ps.startGroup === 'last' && ps.lastGroup) return ps.lastGroup;
    return 'favorites';
}
// Called after extractGroups(): a remembered group may no longer exist in the playlist
function validateCurrentGroup() {
    if (groupsList.indexOf(currentGroup) === -1) { currentGroup = 'favorites'; renderGroupsList(); }
}
// First channel after a playlist loads: the last one watched (if enabled and still present), else the first row
function selectInitialChannel() {
    if (!channels.length) return;
    const ps = _activePlaylistKey ? getPlaylistState(_activePlaylistKey) : null;
    if (ps && ps.resume !== false && ps.lastChannel) {
        let idx = channels.findIndex(c => c.url === ps.lastChannel.url);
        if (idx < 0 && ps.lastChannel.tvgId) idx = channels.findIndex(c => c.tvgId === ps.lastChannel.tvgId);
        if (idx >= 0) {
            selectChannel(idx);
            if (epgMode) {
                const fi = currentFilteredChannels.indexOf(channels[idx]);
                if (fi >= 0) { epgFocusedRowIdx = fi; updateEPGRowFocus(); }
            }
            return;
        }
    }
    selectChannel(currentFilteredChannels.length ? getChannelIndex(currentFilteredChannels[0]) : 0);
}

// Which playlist the per-playlist rows apply to: the loaded one, else the one selected on the start page
function settingsTargetKey() {
    if (_activePlaylistKey && _activePlaylistKey !== 'm:demo') {
        const p = savedPlaylists.find(pl => playlistKeyOf(pl) === _activePlaylistKey);
        return { key: _activePlaylistKey, name: p ? p.name : 'current playlist' };
    }
    if (!startPage.classList.contains('hidden') && selectedPlaylistId !== null && savedPlaylists[selectedPlaylistId]) {
        const p = savedPlaylists[selectedPlaylistId];
        return { key: playlistKeyOf(p), name: p.name };
    }
    return null;
}

function settingsRows() {
    const t = settingsTargetKey();
    const ps = t ? getPlaylistState(t.key) : null;
    const forName = t ? `For ${t.name}` : 'Select or load a playlist first';
    const cur = () => (currentChannelIndex >= 0 ? channels[currentChannelIndex] : null);
    return [
        { id: 'textScale', type: 'choice', label: 'Text size', sub: 'Applies to every screen',
          options: TEXT_SCALE_OPTIONS.map(v => ({ v, label: Math.round(v * 100) + '%' })),
          get: () => settings.textScale,
          set: v => { settings.textScale = v; saveSettings(); applyTextScale(v); _epgSkeletonWinStart = 0; refreshViewIfLoaded(); } },
        { id: 'clock', type: 'choice', label: 'Clock', sub: 'Guide, Now/Next and programme times',
          options: [{ v: '12', label: '12-hour' }, { v: '24', label: '24-hour' }],
          get: () => settings.clock,
          set: v => { settings.clock = v; saveSettings(); _epgSkeletonWinStart = 0; refreshViewIfLoaded(); updateNowNext(); if (epgMode && cur()) updateEPGInfoPanel(cur()); } },
        { id: 'epgTz', type: 'choice', label: 'EPG timezone', disabled: !t,
          sub: t ? `${forName} · pick the zone whose clock the provider used if guide times are hours off; times are converted to your TV clock` : forName,
          options: epgTzOptions(), get: () => epgTzSettingsFor(t && t.key).tz,
          set: v => { ps.epgTz = v; savePlaylistState(); if (t.key === _activePlaylistKey) epgOffsetChange(); } },
        { id: 'epgDst', type: 'choice', label: 'Daylight saving', disabled: !t || !epgTzSettingsFor(t.key).tz,
          sub: t && epgTzSettingsFor(t.key).tz ? 'Automatic follows that zone\'s rules on each programme\'s date; pin standard or daylight time if the provider never switches' : 'Choose an EPG timezone first',
          options: EPG_DST_OPTIONS, get: () => epgTzSettingsFor(t && t.key).dst,
          set: v => { ps.epgDst = v; savePlaylistState(); if (t.key === _activePlaylistKey) epgOffsetChange(); } },
        { id: 'epgExtra', type: 'choice', label: 'EPG extra adjustment', disabled: !t,
          sub: t ? 'Added on top of the timezone for providers that are off by an odd amount' : forName,
          options: EPG_EXTRA_OPTIONS, get: () => epgTzSettingsFor(t && t.key).extra,
          set: v => { ps.epgOffset = v; savePlaylistState(); if (t.key === _activePlaylistKey) epgOffsetChange(); } },
        { id: 'autoLoad', type: 'toggle', label: 'Auto-load last playlist', sub: 'Skip the start page on launch',
          get: () => settings.autoLoad, set: v => { settings.autoLoad = v; saveSettings(); } },
        { id: 'startGroup', type: 'choice', label: 'Starting group', sub: forName, disabled: !t,
          options: [{ v: 'favorites', label: 'Favorites' }, { v: 'all', label: 'All Channels' }, { v: 'recent', label: 'Recent' }, { v: 'last', label: 'Last used' }],
          get: () => (ps && ps.startGroup) || 'favorites', set: v => { ps.startGroup = v; savePlaylistState(); } },
        { id: 'resume', type: 'toggle', label: 'Resume last channel', sub: forName, disabled: !t,
          get: () => !ps || ps.resume !== false, set: v => { ps.resume = v; savePlaylistState(); } },
        { id: 'manageCats', type: 'action', label: 'Manage categories', sub: t ? `Hide or reorder categories for ${t.name}${_hiddenGroups.size ? ` · ${_hiddenGroups.size} hidden` : ''}` : 'Load a playlist first', button: 'Open',
          disabled: !t || !_activePlaylistKey || _activePlaylistKey === 'm:demo' || _activePlaylistKey !== t.key, run: () => openCatsManager('cats') },
        { id: 'manageFavs', type: 'action', label: 'Manage favorites', sub: favoriteIds.size ? `Reorder or remove · ${favoriteIds.size.toLocaleString()} saved` : 'No favorites yet', button: 'Open',
          disabled: !favoriteIds.size || !_activePlaylistKey || vodMode !== 'live', run: () => openCatsManager('favs') },
        { id: 'refreshPlaylist', type: 'action', label: 'Refresh playlist now', button: 'Refresh',
          sub: _activePlaylistKey && _activePlaylistKey !== 'm:demo' ? (_playlistRefreshing ? 'Refreshing …' : `Channel list fetched ${_playlistCacheAt ? fmtAge(_playlistCacheAt) : 'this session'}; refreshes itself after 6 h`) : 'Load a playlist first',
          disabled: !_activePlaylistKey || _activePlaylistKey === 'm:demo' || _playlistRefreshing,
          run: () => { showEPGToast('Refreshing playlist …', 'loading', 'Playlist'); refreshPlaylistInBackground(true).then(() => renderSettings()); renderSettings(); } },
        { id: 'liveBuffer', type: 'choice', label: 'Live rewind buffer', sub: 'HLS channels: pause and rewind live TV up to this far back. Limited by TV memory (about 70 MB): HD channels reach 1–3 min, SD channels more',
          options: LIVE_BUFFER_OPTIONS, get: () => settings.liveBuffer,
          set: v => { settings.liveBuffer = v; saveSettings(); if (vodMode === 'live' && !vodPlay.active && currentChannelIndex >= 0 && (liveEngineActive() || v > 0)) reloadStream(false); } },
        { id: 'ppvEvents', type: 'choice', label: 'Event channels (PPV)', sub: 'Groups of event channels whose names give the start time: list them by start time, optionally without events that ended over an hour ago',
          options: PPV_EVENT_OPTIONS, get: () => settings.ppvEvents, set: v => { settings.ppvEvents = v; saveSettings(); refreshViewIfLoaded(); } },
        { id: 'subAuto', type: 'toggle', label: 'Subtitles on automatically', sub: 'Turn on the subtitle language below whenever a file or channel has it',
          get: () => !!settings.subAuto, set: v => { settings.subAuto = v; saveSettings(); reapplySubtitlePrefs(); } },
        { id: 'subLang', type: 'choice', label: 'Subtitle language', sub: 'Used when subtitles turn on automatically',
          options: SUB_LANG_OPTIONS, get: () => settings.subLang, set: v => { settings.subLang = v; saveSettings(); reapplySubtitlePrefs(); } },
        { id: 'audioLang', type: 'choice', label: 'Audio language', sub: 'Movies and Series: picked when the file offers it',
          options: AUDIO_LANG_OPTIONS, get: () => settings.audioLang, set: v => { settings.audioLang = v; saveSettings(); if (vodPlay.active) { vodPlay.audioManual = false; applyVodTrackPrefs(); } } },
        { id: 'subSize', type: 'choice', label: 'Subtitle size', sub: 'Movies and Series', options: SUB_SIZE_OPTIONS, get: () => settings.subSize, set: v => { settings.subSize = v; saveSettings(); umsApplySubtitleStyle(); } },
        { id: 'subColor', type: 'choice', label: 'Subtitle colour', sub: 'Movies and Series', options: SUB_COLOR_OPTIONS, get: () => settings.subColor, set: v => { settings.subColor = v; saveSettings(); umsApplySubtitleStyle(); } },
        { id: 'subOpacity', type: 'choice', label: 'Subtitle opacity', sub: 'Text transparency; lower is dimmer', options: SUB_OPACITY_OPTIONS, get: () => settings.subOpacity, set: v => { settings.subOpacity = v; saveSettings(); umsApplySubtitleStyle(); } },
        { id: 'subBg', type: 'choice', label: 'Subtitle background', sub: 'Movies and Series', options: SUB_BG_OPTIONS, get: () => settings.subBg, set: v => { settings.subBg = v; saveSettings(); umsApplySubtitleStyle(); } },
        { id: 'subEdge', type: 'choice', label: 'Subtitle edge', sub: 'Movies and Series', options: SUB_EDGE_OPTIONS, get: () => settings.subEdge, set: v => { settings.subEdge = v; saveSettings(); umsApplySubtitleStyle(); } },
        { id: 'autoNext', type: 'toggle', label: 'Auto-play next episode', sub: 'Series: when an episode ends, the next one starts after a short countdown',
          get: () => settings.autoNext !== false, set: v => { settings.autoNext = v; saveSettings(); } },
        ...(_hbAvailable ? [{ id: 'avSync', type: 'choice', label: 'AV sync (rooted TV)', sub: `LG AV Sync Adjustment (0-60), applied while this app is in front and restored when you leave it${_avSyncOrig ? ` · TV was ${_avSyncOrig[_avSyncKey]} (${_avSyncKey})` : ''}`,
          options: AV_SYNC_OPTIONS, get: () => (settings.avSync >= 0 ? settings.avSync : -1),
          set: v => { settings.avSync = v; saveSettings(); if (v >= 0) avSyncApply(v).then(() => { if (settingsOpen) renderSettings(); }); else avSyncRestore(); } }] : []),
        { id: 'showAdult', type: 'toggle', label: 'Show adult categories', sub: 'Movies and Series',
          get: () => !!settings.showAdult,
          set: v => { settings.showAdult = v; saveSettings(); if (vodMode !== 'live') { renderGroupsList(); if (vodNav.screen === 'home') renderVodHome(); else if (vodNav.screen === 'grid' && vodNav.list === 'all') openVodList('all'); } } },
        { id: 'clearFavs', type: 'action', label: 'Clear favorites', sub: `${favoriteIds.size.toLocaleString()} saved`, button: 'Clear', disabled: !favoriteIds.size,
          run: () => showConfirmDialog('⭐ Clear Favorites', `Remove all ${favoriteIds.size.toLocaleString()} favorites?`, clearFavorites) },
        { id: 'diag', type: 'action', label: 'Diagnostics', sub: `Startup timings, memory, stream engine and the last ${_diagLog.length ? _diagLog.length + ' ' : ''}errors`, button: 'Open', run: openDiag },
    ];
}
function settingsFocusables(rows) { return rows.filter(r => !r.disabled).map(r => r.id).concat(['close']); }

function renderSettings() {
    const list = document.getElementById('settingsList');
    if (!list) return;
    const rows = settingsRows();
    _settingsRowsCache = rows;
    const foc = settingsFocusables(rows);
    settingsFocusIdx = Math.max(0, Math.min(settingsFocusIdx, foc.length - 1));
    const focusedId = foc[settingsFocusIdx];
    list.innerHTML = '';
    for (const r of rows) {
        const row = document.createElement('div');
        row.className = 'settings-row' + (r.disabled ? ' disabled' : '') + (r.id === focusedId ? ' focused' : '');
        row.dataset.id = r.id;
        let valueHtml;
        if (r.type === 'choice') {
            const o = r.options.find(x => x.v === r.get()) || r.options[0];
            valueHtml = `<button class="settings-arrow" data-dir="-1" aria-label="Previous">◀</button><span class="settings-val">${escapeHtml(o.label)}</span><button class="settings-arrow" data-dir="1" aria-label="Next">▶</button>`;
        } else if (r.type === 'toggle') {
            const on = !!r.get();
            valueHtml = `<span class="settings-switch${on ? ' on' : ''}"><span class="settings-knob"></span></span><span class="settings-val">${on ? 'On' : 'Off'}</span>`;
        } else {
            valueHtml = `<button class="settings-action">${escapeHtml(r.button || 'Go')}</button>`;
        }
        row.innerHTML = `<div class="settings-label"><div class="settings-name">${escapeHtml(r.label)}</div>${r.sub ? `<div class="settings-sub">${escapeHtml(r.sub)}</div>` : ''}</div><div class="settings-value">${valueHtml}</div>`;
        if (!r.disabled) {
            row.querySelectorAll('.settings-arrow').forEach(b => b.addEventListener('click', e => {
                e.stopPropagation(); settingsFocusIdx = foc.indexOf(r.id); settingsChange(r, +b.dataset.dir);
            }));
            row.addEventListener('click', () => { settingsFocusIdx = foc.indexOf(r.id); settingsActivate(r); });
        }
        list.appendChild(row);
    }
    const closeBtn = document.getElementById('settingsCloseBtn');
    if (closeBtn) closeBtn.classList.toggle('focused', focusedId === 'close');
    const f = list.querySelector('.settings-row.focused');
    if (f) f.scrollIntoView({ block: 'nearest' });
}
function settingsChange(r, dir) {
    if (r.type === 'choice') {
        const i = r.options.findIndex(x => x.v === r.get());
        r.set(r.options[(i + dir + r.options.length) % r.options.length].v);
    } else if (r.type === 'toggle') {
        r.set(dir > 0 ? true : dir < 0 ? false : !r.get());
    }
    renderSettings();
}
function settingsActivate(r) {
    if (r.type === 'action') { r.run(); return; }
    settingsChange(r, r.type === 'toggle' ? 0 : 1);
}
function handleSettingsKey(e) {
    const k = e.key, kc = e.keyCode;
    const rows = _settingsRowsCache || settingsRows();
    const foc = settingsFocusables(rows);
    const id = foc[settingsFocusIdx];
    const row = rows.find(r => r.id === id);
    if (k === 'ArrowUp' || kc === 38) { e.preventDefault(); settingsFocusIdx = Math.max(0, settingsFocusIdx - 1); renderSettings(); }
    else if (k === 'ArrowDown' || kc === 40) { e.preventDefault(); settingsFocusIdx = Math.min(foc.length - 1, settingsFocusIdx + 1); renderSettings(); }
    else if (k === 'ArrowLeft' || kc === 37) { e.preventDefault(); if (row && row.type !== 'action') settingsChange(row, -1); }
    else if (k === 'ArrowRight' || kc === 39) { e.preventDefault(); if (row && row.type !== 'action') settingsChange(row, 1); }
    else if (k === 'Enter' || kc === 13) { e.preventDefault(); if (id === 'close') closeSettings(); else if (row) settingsActivate(row); }
}
function openSettings() {
    if (document.fullscreenElement) return;
    if (confirmDialog && !confirmDialog.classList.contains('hidden')) return;
    const ov = document.getElementById('settingsOverlay');
    if (!ov) return;
    settingsOpen = true;
    settingsFocusIdx = 0;
    renderSettings();
    ov.classList.remove('hidden');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function closeSettings() {
    const ov = document.getElementById('settingsOverlay');
    if (ov) ov.classList.add('hidden');
    settingsOpen = false;
    if (!startPage.classList.contains('hidden')) { updateFocusableElements(); focusElement(currentFocusIndex); }
}
// ── Diagnostics overlay ──────────────────────────────────────
let diagOpen = false;
let _appVersion = '';
function diagLines() {
    const L = [];
    const mem = performance.memory ? `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB used of ${Math.round(performance.memory.jsHeapSizeLimit / 1048576)} MB JS heap` : 'n/a';
    L.push(`IPTV Ultra ${_appVersion || ''}`.trim());
    L.push(`Up ${fmtClock(Math.round(performance.now() / 1000))} · ${new Date().toLocaleString()}`);
    L.push(`Memory: ${mem}`);
    L.push(`Agent: ${navigator.userAgent.slice(0, 120)}`);
    L.push('');
    L.push(`Playlist: ${_activePlaylistKey || 'none'} (${currentPlaylistType || '-'}) · ${channels.length.toLocaleString()} channels · ${groupsList.length} groups · ${favoriteIds.size} favorites`);
    L.push(`EPG: ${epgData.size.toLocaleString()} channels cached · queue ${typeof _epgQueue !== 'undefined' ? _epgQueue.length : 0} · window ${EPG_WIN_HOURS} h · past ${epgPastHours()} h`);
    const ch = currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
    const verr = videoPlayer.error ? ` · error ${videoPlayer.error.code}` : '';
    L.push(`Stream: ${ch ? ch.name : 'none'} · ${liveEngineActive() ? 'hls.js' : 'native'} · ${liveEngine.tech || '-'} · t=${(videoPlayer.currentTime || 0).toFixed(1)} s · readyState ${videoPlayer.readyState}${verr} · reloads ${_reloadAttempts}/${MAX_AUTO_RELOADS}${_altTried.size > 1 ? ` · ${_altTried.size} sources tried` : ''}`);
    L.push(`hls.js incompatible this session: ${_hlsBroken.size ? [..._hlsBroken].length + ' channel(s)' : 'none'} · live buffer ${settings.liveBuffer ? settings.liveBuffer + ' min' : 'Off'}`);
    if (catchup) L.push(`Catch-up: ${catchup.prog && catchup.prog.title}`);
    const ago = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`; };
    const f = _lastStreamFail;
    if (f) {
        L.push(`Last stream failure: ${new Date(f.t).toLocaleTimeString()} (${ago(f.t)}) · ${f.engine} · ${f.what}`);
        if (f.name) L.push(`  Channel: ${f.name}`);
        if (f.reply) L.push(`  Server reply: ${f.reply}`);
    } else L.push('Last stream failure: none this session');
    if (currentPlaylistType === 'xtream') {
        const ci = _consInfo;
        L.push(ci ? `Account check: ${ci.active} of ${ci.max} connection${ci.max === 1 ? '' : 's'} in use · status ${ci.status || '?'}${ci.exp ? ` · expires ${new Date(ci.exp).toLocaleDateString()}` : ''} · checked ${ago(ci.at)}${accountProblemText(ci) ? ' · ⚠️ ' + accountProblemText(ci) : ''}`
            : 'Account check: not run yet (runs on the first failure of a stream)');
    }
    L.push('');
    const pt = performance.timing;
    if (pt && pt.navigationStart) L.push(`Page: DOM ready ${pt.domContentLoadedEventEnd - pt.navigationStart} ms · load ${pt.loadEventEnd > 0 ? pt.loadEventEnd - pt.navigationStart : '?'} ms`);
    L.push('Startup marks (ms since script start): ' + _perfMarks.map(m => `${m.label} ${m.t}`).join(' · '));
    L.push('');
    L.push(`Errors (last ${_diagLog.length}):`);
    if (!_diagLog.length) L.push('  none');
    let prevHeader = false;
    for (let i = _diagLog.length - 1; i >= 0; i--) {
        const e = _diagLog[i];
        if (e.prev && !prevHeader) { prevHeader = true; L.push('  ── earlier runs ──'); }
        L.push(`  ${e.prev ? new Date(e.t).toLocaleString() : new Date(e.t).toLocaleTimeString()}  ${e.msg}`);
    }
    return L;
}
function renderDiag() {
    const pre = document.getElementById('diagText'); if (!pre) return;
    pre.textContent = diagLines().join('\n');
}
function openDiag() {
    const ov = document.getElementById('diagOverlay'); if (!ov) return;
    if (settingsOpen) closeSettings();
    diagOpen = true;
    ov.classList.remove('hidden');
    renderDiag();
    if (!_appVersion) fetch('appinfo.json').then(r => r.json()).then(j => { _appVersion = j.version || ''; if (diagOpen) renderDiag(); }).catch(() => {});
    const pre = document.getElementById('diagText'); if (pre) pre.scrollTop = 0;
}
function closeDiag() {
    if (!diagOpen) return;
    diagOpen = false;
    const ov = document.getElementById('diagOverlay'); if (ov) ov.classList.add('hidden');
}
function handleDiagKey(e) {
    const k = e.key, kc = e.keyCode;
    const pre = document.getElementById('diagText');
    if (k === 'ArrowUp' || kc === 38) { e.preventDefault(); if (pre) pre.scrollTop -= 160; }
    else if (k === 'ArrowDown' || kc === 40) { e.preventDefault(); if (pre) pre.scrollTop += 160; }
    else if (k === 'Enter' || kc === 13) { e.preventDefault(); renderDiag(); }
    else if (kc === 403 || k === 'ColorF0Red') { e.preventDefault(); _diagLog.length = 0; diagSave(); renderDiag(); }
}

function clearFavorites() {
    favoriteIds.clear();
    saveFavorites();
    document.querySelectorAll('.epg-fav-btn, .epg-info-fav-btn').forEach(el => { el.textContent = '☆'; el.classList.remove('fav-active'); });
    refreshViewIfLoaded();
    if (settingsOpen) renderSettings();
}

// ── Standard (M3U) View Remote Navigation ─────────────────────
function resetStdFocus() {
    stdFocusZone = 'channels';
    stdFocusIdx = 0;
    stdGroupFocusIdx = Math.max(0, groupsList.indexOf(currentGroup));
}

function _groupItemEls() {
    // Document order matches groupsList order: pinned (favorites, all) first, then the rest
    return document.querySelectorAll('#groupsPinned .group-item, #groupsList .group-item');
}

function updateStdGroupFocus(scroll) {
    const els = _groupItemEls();
    for (let i = 0; i < els.length; i++) els[i].classList.toggle('focused', stdFocusZone === 'groups' && i === stdGroupFocusIdx);
    if (scroll && els[stdGroupFocusIdx]) els[stdGroupFocusIdx].scrollIntoView({ block: 'nearest' });
}

function updateStdChannelFocus() {
    if (stdFocusZone === 'channels' && _stdItemH && currentFilteredChannels.length) {
        const top = stdFocusIdx * _stdItemH, bottom = top + _stdItemH;
        if (top < channelListDiv.scrollTop) channelListDiv.scrollTop = top;
        else if (bottom > channelListDiv.scrollTop + channelListDiv.clientHeight) channelListDiv.scrollTop = bottom - channelListDiv.clientHeight;
        if (_stdRenderVisible) _stdRenderVisible();
    }
    for (const [idx, el] of renderedItems) el.classList.toggle('focused', stdFocusZone === 'channels' && idx === stdFocusIdx);
}

function _isTextInput(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

// ── EPG Remote Navigation ─────────────────────────────────────
let _epgPrevFocusIdx = -1;
function updateEPGRowFocus() {
    // Only the row losing focus and the row gaining it change class; the others are untouched
    if (_epgPrevFocusIdx !== epgFocusedRowIdx) {
        const prev = epgRenderedRows.get(_epgPrevFocusIdx);
        if (prev) { prev.classList.remove('epg-focused'); const b = prev.querySelector('.epg-block-focused'); if (b) b.classList.remove('epg-block-focused'); }
        _epgPrevFocusIdx = epgFocusedRowIdx;
    }
    const cur = epgRenderedRows.get(epgFocusedRowIdx);
    if (cur) cur.classList.add('epg-focused');
    scrollEPGRowIntoView(epgFocusedRowIdx);
    updateEPGBlockFocus();
}

// ── Programme cursor ─────────────────────────────────────────
// The focused row highlights the programme at epgFocusT (0 = now). Left/Right move it to the previous/
// next programme and pan the guide to keep it in view; Up/Down keep the time. OK on a past programme of
// a catch-up channel plays it from the archive; anywhere else OK plays the channel live, as before.
function epgCursorTime() { return epgFocusT || Date.now(); }
function epgFocusedProgs() {
    const ch = currentFilteredChannels[epgFocusedRowIdx];
    if (!ch) return { ch: null, progs: [] };
    return { ch, progs: epgProgsOf(ch.tvgId) || [] };
}
function epgFocusedProg() {
    const { progs } = epgFocusedProgs();
    const t = epgCursorTime();
    const i = _epgBinarySearch(progs, t);
    return i >= 0 && progs[i].stop > t ? progs[i] : null;
}
function updateEPGBlockFocus() {
    const row = epgRenderedRows.get(epgFocusedRowIdx);
    if (!row) return;
    const prev = row.querySelector('.epg-block-focused');
    const p = epgFocusedProg();
    const next = p ? row.querySelector(`.epg-prog-block[data-start="${p.start}"]`) : null;
    if (prev === next) return;
    if (prev) prev.classList.remove('epg-block-focused');
    if (next) next.classList.add('epg-block-focused');
}
// Pan so the time range [a, b] (ms) is inside the visible programme area
function epgEnsureTimeVisible(a, b) {
    if (!_epgWinStart) return;
    if (!_epgViewW) epgMeasureViewport();
    const visW = Math.max(1, _epgViewW - EPG_CH_W);
    const ax = (a - _epgWinStart) / 60000 * EPG_PX_PER_MIN, bx = (b - _epgWinStart) / 60000 * EPG_PX_PER_MIN;
    let x = _epgX;
    if (ax < x + 40) x = ax - 40;
    else if (bx > x + visW - 40) x = Math.min(ax - 40, bx - visW + 40);
    x = Math.max(0, Math.min(epgMaxPan(), Math.round(x)));
    if (x !== _epgX) { _epgX = x; epgApplyPan(); }
}
// Left/Right in the guide: previous/next programme on the focused row; without data, pan half an hour
function epgMoveCursor(dir) {
    const { ch, progs } = epgFocusedProgs();
    const t = epgCursorTime();
    if (!progs.length) { scrollEPGTimeBy(dir * 30); epgFocusT = t + dir * 1800000; if (ch && dir < 0) epgMaybeFetchHistory(ch); return; }
    let i = _epgBinarySearch(progs, t);
    if (i >= 0 && progs[i].stop <= t) i = Math.min(progs.length - 1, i + (dir > 0 ? 0 : 1)); // cursor in a gap: nearest side
    let j = i + dir;
    if (j < 0) {
        // Earlier than anything loaded: the archive may hold more; fetch the full table and nudge the view back
        if (ch && channelHasCatchup(ch) && progs[0].start > Date.now() - ch.archive * 86400000) epgMaybeFetchHistory(ch);
        epgFocusT = Math.max(_epgWinStart || 0, progs[0].start - 1800000);
        epgEnsureTimeVisible(epgFocusT, epgFocusT + 1800000);
        updateEPGBlockFocus();
        return;
    }
    if (j >= progs.length) { epgFocusT = Math.min(_epgWinEnd || Infinity, progs[progs.length - 1].stop + 1); epgEnsureTimeVisible(epgFocusT, epgFocusT + 1800000); updateEPGBlockFocus(); return; }
    const p = progs[j];
    epgFocusT = p.start + Math.min(60000, Math.max(1, (p.stop - p.start) / 2));
    if (dir < 0 && ch && channelHasCatchup(ch) && j <= 2) epgMaybeFetchHistory(ch);
    epgEnsureTimeVisible(p.start, p.stop);
    updateEPGBlockFocus();
}
function epgMaybeFetchHistory(ch) {
    if (!channelHasCatchup(ch) || !ch.tvgId || _epgFullFetched.has(ch.tvgId)) return;
    const row = epgRenderedRows.get(epgFocusedRowIdx); if (row) row.classList.add('epg-row-loading-past');
    fetchXtreamEpgFull(ch.tvgId);
}

function scrollEPGRowIntoView(idx) {
    const scrollOuter = document.getElementById('epgScrollOuter');
    if (!scrollOuter) return;
    // Rows start after the in-flow sticky time strip, so a row's content
    // offset is strip + idx*rowH; the strip also covers the top of the viewport.
    if (!_epgViewH) epgMeasureViewport();
    const timeStripH = EPG_TIME_STRIP_H;
    const rowTop = idx * EPG_ROW_H;
    const rowBottom = rowTop + EPG_ROW_H;
    const viewTop = scrollOuter.scrollTop;
    const viewBottom = viewTop + _epgViewH - timeStripH;
    // Setting scrollTop raises a scroll event; the rows are rendered from there, once per frame
    if (rowTop < viewTop) scrollOuter.scrollTop = rowTop;
    else if (rowBottom > viewBottom) scrollOuter.scrollTop = rowBottom + timeStripH - _epgViewH;
    else return;
    queueEPGRender();
}

function scrollEPGTimeBy(mins) {
    _epgX = Math.max(0, Math.min(epgMaxPan(), _epgX + mins * EPG_PX_PER_MIN));
    epgApplyPan();
}

function updateEPGNavVisibility() {
    const prevBtn = document.getElementById('epgTimePrevBtn');
    const nextBtn = document.getElementById('epgTimeNextBtn');
    if (!prevBtn || !nextBtn) return;
    const maxScroll = epgMaxPan();
    prevBtn.classList.toggle('epg-nav-hidden', _epgX <= 1);
    nextBtn.classList.toggle('epg-nav-hidden', _epgX >= maxScroll - 1);
}

function toggleEPGFav(id) {
    if (favoriteIds.has(id)) favoriteIds.delete(id);
    else favoriteIds.add(id);
    saveFavorites();
    const isFav = favoriteIds.has(id);
    document.querySelectorAll('.epg-fav-btn, .epg-info-fav-btn').forEach(el => {
        if (el.dataset.favId === id) {
            el.textContent = isFav ? '★' : '☆';
            el.classList.toggle('fav-active', isFav);
        }
    });
    if (!epgMode) renderChannelList();
}

function selectEPGFocusedChannel() {
    const ch = currentFilteredChannels[epgFocusedRowIdx];
    if (!ch) return;
    const idx = getChannelIndex(ch);
    // Programme cursor on a past programme of a catch-up channel: play it from the archive
    const p = epgFocusedProg();
    if (p && progIsCatchup(ch, p, Date.now())) { startCatchup(idx, p); return; }
    if (idx === currentChannelIndex) { toggleVideoFullscreen(); return; }
    const row = epgRenderedRows.get(epgFocusedRowIdx);
    if (row) row.click();
    else selectChannel(idx);
}

function handleRemoteNav(e) {
    const k = e.key, kc = e.keyCode;
    const up = k === 'ArrowUp' || kc === 38, down = k === 'ArrowDown' || kc === 40;
    const left = k === 'ArrowLeft' || kc === 37, right = k === 'ArrowRight' || kc === 39;
    const enter = k === 'Enter' || kc === 13;

    // The confirm dialog owns the remote while it is open
    if (confirmDialog && !confirmDialog.classList.contains('hidden')) {
        if (left || up) { e.preventDefault(); confirmYes.focus(); }
        else if (right || down) { e.preventDefault(); confirmNo.focus(); }
        else if (enter) { e.preventDefault(); (document.activeElement === confirmYes ? confirmYes : confirmNo).click(); }
        return;
    }

    // Diagnostics / Sort menu / Categories manager / Settings overlay own the remote while open
    if (diagOpen) { handleDiagKey(e); return; }
    if (vodSortOpen) { handleVodSortKey(e); return; }
    if (catsOpen) { handleCatsKey(e); return; }
    if (settingsOpen) { handleSettingsKey(e); return; }

    // Fullscreen playback keys (seek, trick-play, play/pause) have dedicated listeners
    if (document.fullscreenElement) return;
    if (playerActive()) { handleVodPlayerKey(e, up, down, left, right, enter); return; }

    // Yellow colour key opens Settings from any screen
    if (kc === 405 || k === 'ColorF2Yellow') { e.preventDefault(); openSettings(); return; }

    const inMain = mainApp && mainApp.style.display !== 'none';

    // Blue colour key cycles Live / Movies / Series (Xtream playlists only)
    if (kc === 406 || k === 'ColorF3Blue') { if (inMain && currentPlaylistType === 'xtream') { e.preventDefault(); cycleVodMode(); } return; }
    // Red in Live: back to the previous channel (Movies/Series use Red for their own actions below)
    if ((kc === 403 || k === 'ColorF0Red') && inMain && vodMode === 'live' && !_isTextInput(document.activeElement)) { e.preventDefault(); swapToPreviousChannel(); return; }
    // Green in a Movies/Series grid: sort & genre menu
    if ((kc === 404 || k === 'ColorF1Green') && inMain && vodMode !== 'live' && vodNav.screen === 'grid') { e.preventDefault(); if (_isTextInput(document.activeElement)) document.activeElement.blur(); openVodSort(); return; }

    // Typing in a search box: Down/Enter hand focus back to the list; other keys pass through
    if (inMain && _isTextInput(document.activeElement)) {
        if (down || enter) {
            e.preventDefault();
            document.activeElement.blur();
            if (vodMode !== 'live') { vodNav.zone = 'content'; refreshVodFocus(); }
            else if (!epgMode) { stdFocusZone = 'channels'; updateStdChannelFocus(); }
        }
        return;
    }

    if (inMain && vodMode !== 'live') { handleVodBrowseKey(e, up, down, left, right, enter); return; }

    if (epgMode) {
        if (up) { e.preventDefault(); epgFocusedRowIdx = Math.max(0, epgFocusedRowIdx - 1); updateEPGRowFocus(); }
        else if (down) { e.preventDefault(); epgFocusedRowIdx = Math.min(currentFilteredChannels.length - 1, epgFocusedRowIdx + 1); updateEPGRowFocus(); }
        else if (left) { e.preventDefault(); epgMoveCursor(-1); }
        else if (right) { e.preventDefault(); epgMoveCursor(1); }
        else if (enter) { e.preventDefault(); selectEPGFocusedChannel(); }
        return;
    }

    if (inMain) {
        // Standard (M3U) view: groups column ◀▶ channel list
        if (stdFocusZone === 'groups') {
            if (up) { e.preventDefault(); stdGroupFocusIdx = Math.max(0, stdGroupFocusIdx - 1); updateStdGroupFocus(true); }
            else if (down) { e.preventDefault(); stdGroupFocusIdx = Math.min(groupsList.length - 1, stdGroupFocusIdx + 1); updateStdGroupFocus(true); }
            else if (right) { e.preventDefault(); stdFocusZone = 'channels'; updateStdGroupFocus(false); updateStdChannelFocus(); }
            else if (enter) { e.preventDefault(); const els = _groupItemEls(); if (els[stdGroupFocusIdx]) els[stdGroupFocusIdx].click(); }
        } else {
            if (up) { e.preventDefault(); stdFocusIdx = Math.max(0, stdFocusIdx - 1); updateStdChannelFocus(); }
            else if (down) { e.preventDefault(); stdFocusIdx = Math.min(Math.max(0, currentFilteredChannels.length - 1), stdFocusIdx + 1); updateStdChannelFocus(); }
            else if (left) {
                if (groupsColumnVisible) { e.preventDefault(); stdFocusZone = 'groups'; updateStdChannelFocus(); updateStdGroupFocus(true); }
            } else if (enter) {
                e.preventDefault();
                const ch = currentFilteredChannels[stdFocusIdx];
                if (!ch) return;
                const idx = getChannelIndex(ch);
                if (idx === currentChannelIndex) toggleVideoFullscreen(); // Enter on the playing row toggles fullscreen
                else selectChannel(idx);
            }
        }
        return;
    }

    if (!startPage.classList.contains('hidden')) {
        if (k === 'Tab') { e.preventDefault(); switchTab(activeTab === 'm3u' ? 'xtream' : 'm3u'); }
        else if (up) { e.preventDefault(); currentFocusIndex--; focusElement(currentFocusIndex); }
        else if (down) { e.preventDefault(); currentFocusIndex++; focusElement(currentFocusIndex); }
        else if (enter) { e.preventDefault(); if (document.activeElement && document.activeElement.click) document.activeElement.click(); }
    }
}

// ----- Event Listeners -----
saveNewBtn.addEventListener('click', () => {
    const url = newM3uUrl.value.trim();
    const name = newM3uName.value.trim();
    const epgUrl = newEpgUrl.value.trim();
    if (url) addPlaylist(url, name, epgUrl);
    else updateStartStatus('Please enter a valid URL', true, false, false, 0);
});
loadSelectedBtn.addEventListener('click', () => {
    if (!isLoading && selectedPlaylistId !== null && savedPlaylists[selectedPlaylistId]) {
        const p = savedPlaylists[selectedPlaylistId];
        if (p.type === 'xtream') loadXtreamPlaylist(p.url, p.username, p.password);
        else loadM3UFromUrl(p.url, p.epgUrl || '');
    }
});
saveXtreamBtn.addEventListener('click', () => {
    // Save only — the server is contacted when the user presses "Load Selected"
    const server = xtreamServer.value.trim();
    const uname = xtreamUsername.value.trim();
    const pass = xtreamPassword.value.trim();
    const name = xtreamName.value.trim();
    if (!server || !uname || !pass) {
        updateStartStatus('Please enter server URL, username, and password', true, false, false, 0);
        return;
    }
    if (!/^https?:\/\//i.test(server)) {
        updateStartStatus('Server URL must start with http:// or https://', true, false, false, 0);
        return;
    }
    addXtreamPlaylist(server, uname, pass, name);
});
tabM3u.addEventListener('click', () => switchTab('m3u'));
tabXtream.addEventListener('click', () => switchTab('xtream'));
startDemoBtn.addEventListener('click', loadDemoM3U);
clearAllBtn.addEventListener('click', () => {
    showConfirmDialog('⚠️ Clear All Playlists', 'Are you sure you want to clear all saved playlists?', clearAllPlaylists);
});

const epgTimePrevBtn = document.getElementById('epgTimePrevBtn');
const epgTimeNextBtn = document.getElementById('epgTimeNextBtn');
if (epgTimePrevBtn) epgTimePrevBtn.addEventListener('click', () => scrollEPGTimeBy(-30));
if (epgTimeNextBtn) epgTimeNextBtn.addEventListener('click', () => scrollEPGTimeBy(30));
const epgScrollOuterEl = document.getElementById('epgScrollOuter');
if (epgScrollOuterEl) epgScrollOuterEl.addEventListener('scroll', updateEPGNavVisibility);
const epgInfoFavBtn = document.getElementById('epgInfoFavBtn');
if (epgInfoFavBtn) epgInfoFavBtn.addEventListener('click', () => {
    if (epgInfoFavBtn.dataset.favId) toggleEPGFav(epgInfoFavBtn.dataset.favId);
});
reloadBtn.addEventListener('click', reloadStream);
homePageBtn.addEventListener('click', goToHomeScreen);
document.querySelectorAll('#modeSwitch .mode-btn').forEach(b => b.addEventListener('click', () => setVodMode(b.dataset.mode)));
const vodSearchInputEl = document.getElementById('vodSearchInput');
if (vodSearchInputEl) vodSearchInputEl.addEventListener('input', () => {
    vodNav.query = vodSearchInputEl.value;
    clearTimeout(_vodSearchTimer);
    _vodSearchTimer = setTimeout(applyVodSearch, 150);
});
const vodNextPlayEl = document.getElementById('vodNextPlay'), vodNextCancelEl = document.getElementById('vodNextCancel');
if (vodNextPlayEl) vodNextPlayEl.addEventListener('click', () => { vodPlay.nextFocus = 'play'; activateVodNext(); });
if (vodNextCancelEl) vodNextCancelEl.addEventListener('click', () => { vodPlay.nextFocus = 'cancel'; activateVodNext(); });
const vodPlayerEl = document.getElementById('vodPlayer');
if (vodPlayerEl) {
    // The Magic Remote pointer does not show, hide or extend the OSD: moving the cursor (or the TV
    // re-showing it) kept popping the banner up over full-screen video. Keys and clicks do.
    vodPlayerEl.addEventListener('click', e => {
        if (!playerActive()) return;
        // Tracks menu open: a row click re-renders the list before this bubbles, so e.target is already
        // detached and closest('.vod-tracks') fails — which used to toggle pause on every OK in the menu.
        // While the menu is open a click inside it is the menu's; a click outside just closes it.
        if (vodTracksOpen()) { if (!e.target.closest('.vod-tracks')) closeVodTracks(); return; }
        if (e.target.closest('.vod-next') || e.target.closest('.vod-osd-btn') || e.target.closest('.vod-bar')) return;
        if (vodPlay.active) toggleVodPause(); else toggleLivePause();
    });
    // Click on the timeline (VOD) jumps there and plays
    const barEl = vodPlayerEl.querySelector('#vodOsd .vod-bar');
    if (barEl) barEl.addEventListener('click', e => {
        e.stopPropagation();
        if (!vodPlay.active) return;
        const r = barEl.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
        const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) || vodPlay.dur || 0;
        if (!dur) return;
        try { videoPlayer.currentTime = f * dur; } catch (_) { /* not seekable yet */ }
        videoPlayer.play().catch(() => {});
        document.getElementById('vodPaused').classList.add('hidden');
        showVodOsd();
    });

}
videoPlayer.addEventListener('timeupdate', function () {
    if (!vodPlay.active) {
        // Live on hls.js (behind-live readout) and catch-up (position bar): keep the banner current while it is up
        if (livePlayer.active && (liveEngineActive() || catchup) && document.getElementById('vodOsd').classList.contains('visible')) updateLiveOsd();
        return;
    }
    if (document.getElementById('vodOsd').classList.contains('visible')) updateVodOsd();
    saveVodProgress(false);
});
videoPlayer.addEventListener('ended', onVodEnded);
videoPlayer.addEventListener('waiting', function () { if (vodPlay.active) document.getElementById('vodLoading').classList.remove('hidden'); });
let _perfFirstPlay = false;
videoPlayer.addEventListener('playing', function () { if (!_perfFirstPlay) { _perfFirstPlay = true; perfMark('first-playing'); } if (vodPlay.active) { document.getElementById('vodLoading').classList.add('hidden'); document.getElementById('vodPaused').classList.add('hidden'); } });
videoPlayer.addEventListener('pause', function () { if (playerActive() && !vodPlay.ended && !videoPlayer.ended) { document.getElementById('vodPaused').classList.remove('hidden'); renderPlayerButtons(); } });
videoPlayer.addEventListener('play', function () { if (playerActive()) { document.getElementById('vodPaused').classList.add('hidden'); renderPlayerButtons(); } });
['settingsBtn', 'settingsFooterBtn', 'epgSettingsBtn', 'vodSettingsBtn'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', openSettings);
});
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettings);
const settingsOverlayEl = document.getElementById('settingsOverlay');
if (settingsOverlayEl) settingsOverlayEl.addEventListener('click', e => { if (e.target === settingsOverlayEl) closeSettings(); });
toggleGroupsBtn.addEventListener('click', toggleGroupsColumn);
showGroupsBtn.addEventListener('click', toggleGroupsColumn);
const epgVideoWrap = document.getElementById('epgVideoWrap');
if (epgVideoWrap) epgVideoWrap.addEventListener('mousemove', showTopControls);
searchInput.addEventListener('input', () => {
    currentSearchQuery = searchInput.value;
    if (currentSearchQuery.trim()) currentGroup = 'all';
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => { renderGroupsList(); refreshCurrentView(); }, 150);
});
clearSearchBtn.addEventListener('click', () => { currentSearchQuery = ''; searchInput.value = ''; searchInput.focus(); renderGroupsList(); refreshCurrentView(); });
const epgSearchInput = document.getElementById('epgSearchInput');
const epgClearSearchBtn = document.getElementById('epgClearSearchBtn');
if (epgSearchInput) {
    epgSearchInput.addEventListener('input', () => {
        currentSearchQuery = epgSearchInput.value;
        searchInput.value = epgSearchInput.value;
        clearTimeout(_searchDebounceTimer);
        _searchDebounceTimer = setTimeout(refreshCurrentView, 150);
    });
}
if (epgClearSearchBtn) {
    epgClearSearchBtn.addEventListener('click', () => {
        currentSearchQuery = '';
        epgSearchInput.value = '';
        searchInput.value = '';
        refreshCurrentView();
    });
}
subtitleBtn.addEventListener('click', () => { toggleSubtitlePanel(); showTopControls(); });
audioBtn.addEventListener('click', () => { toggleAudioPanel(); showTopControls(); });
videoPlayer.addEventListener('loadedmetadata', function () {
    updateSubtitleButton(); updateAudioButton();
    if (vodMode === 'live' && !vodPlay.active && !livePlayer.active && !liveEngineActive()) {
        setTimeout(() => { if (!(liveUms && liveUms.video) && videoPlayer.videoWidth) showFeedStats(`${videoPlayer.videoWidth}×${videoPlayer.videoHeight}`); }, 1500);
    }
});
videoPlayer.addEventListener('error', function () {
    if (vodPlay.active) { if (videoPlayer.getAttribute('src')) onVodError(); return; }
    if (vodMode !== 'live') return; // live video is parked while browsing Movies/Series
    if (currentChannelIndex < 0 || !videoPlayer.getAttribute('src')) return; // src cleared on purpose
    if (!videoPlayer.error) return; // stale event from a source that has already been replaced (hls.js → native hand-over)
    const code = videoPlayer.error ? videoPlayer.error.code : 0;
    const msg = code === 2 ? 'Network error' : code === 3 ? 'Decode error' : code === 4 ? 'Stream unavailable or unsupported' : 'Playback error';
    noteStreamFail('native', `${msg} (MediaError ${code}${videoPlayer.error && videoPlayer.error.message ? `: ${videoPlayer.error.message}` : ''})`, '');
    stopStallWatchdog();
    if (_reloadAttempts === 0) noteStreamFailureForAccount(currentChannelIndex); // first failure: is it the account rather than the channel?
    if (_reloadAttempts >= MAX_AUTO_RELOADS) { if (!tryAlternateSource(msg)) showStreamError(msg); return; }
    _reloadAttempts++;
    statusArea.innerText = `⚠️ ${msg} — retrying (${_reloadAttempts}/${MAX_AUTO_RELOADS}) …`;
    const idx = currentChannelIndex;
    if (_errRetryTimer) clearTimeout(_errRetryTimer);
    _errRetryTimer = setTimeout(function () { _errRetryTimer = null; if (currentChannelIndex === idx) reloadStream(true); }, 2500);
});
videoArea.addEventListener('mousemove', showTopControls);
videoArea.addEventListener('click', function (e) {
    if (subtitlePanelOpen && !subtitlePanel.contains(e.target) && e.target !== subtitleBtn) toggleSubtitlePanel();
    if (audioPanelOpen && !audioPanel.contains(e.target) && e.target !== audioBtn) toggleAudioPanel();
});
videoArea.addEventListener('dblclick', function (e) { if (e.target === videoPlayer && currentChannelIndex >= 0 && !livePlayer.active) enterLivePlayer(); });
if (epgVideoWrap) epgVideoWrap.addEventListener('dblclick', function (e) { if (e.target === videoPlayer && currentChannelIndex >= 0 && !livePlayer.active) enterLivePlayer(); });
videoPlayer.textTracks.addEventListener('addtrack', function () {
    updateSubtitleButton();
    if (subtitlePanelOpen) buildSubtitlePanel();
    if (vodPlay.active) { applyVodTrackPrefs(); if (vodTracksOpen()) renderVodTracks(); }
});
videoPlayer.textTracks.addEventListener('removetrack', function () { updateSubtitleButton(); });
if (videoPlayer.audioTracks) {
    videoPlayer.audioTracks.addEventListener('addtrack', function () {
        updateAudioButton();
        if (audioPanelOpen) buildAudioPanel();
        if (vodPlay.active) { applyVodTrackPrefs(); if (vodTracksOpen()) renderVodTracks(); }
    });
    videoPlayer.audioTracks.addEventListener('removetrack', function () { updateAudioButton(); });
}
document.addEventListener('keydown', handleRemoteNav);

// Long-press Enter in fullscreen: switch to last-viewed channel
// Short-press Enter in fullscreen: play/pause
let _enterPressTime = 0;
let _enterDown = false;
const LONG_PRESS_MS = 600;
document.addEventListener('keydown', (e) => {
    if (!_inPlayerMode()) return;
    if (e.key !== 'Enter' && e.keyCode !== 13) return;
    if (_enterDown) return; // ignore key-repeat
    _enterDown = true;
    _enterPressTime = Date.now();
});
document.addEventListener('keyup', (e) => {
    if (!_enterDown) return;
    if (e.key !== 'Enter' && e.keyCode !== 13) return;
    const held = Date.now() - _enterPressTime;
    _enterDown = false;
    _enterPressTime = 0;
    if (!_inPlayerMode()) return;
    e.preventDefault();
    if (playerActive()) {
        if (vodTracksOpen()) activateVodTrack();
        else if (vodNextVisible()) activateVodNext();
        else if (livePlayer.active && surf.active) surfTune();
        else if (player.focus === 'buttons' && document.getElementById('vodOsd').classList.contains('visible')) activatePlayerButton();
        else if (livePlayer.active && held >= LONG_PRESS_MS) { if (lastChannelIndex >= 0 && channels[lastChannelIndex]) selectChannel(lastChannelIndex); }
        else if (livePlayer.active) toggleLivePause();
        else toggleVodPause(); // OK on the bar: play/pause (no long-press action in VOD)
        return;
    }
    if (held >= LONG_PRESS_MS) {
        if (lastChannelIndex >= 0 && channels[lastChannelIndex]) selectChannel(lastChannelIndex);
    } else {
        if (videoPlayer.paused) videoPlayer.play().catch(e => console.log);
        else videoPlayer.pause();
        showTopControls();
    }
});

document.addEventListener('fullscreenchange', () => {
    showTopControls();
    if (!document.fullscreenElement) {
        _holdKeyDir = null;
        if (_isHolding()) _stopHold();
    }
});

// Hold Left/Right in fullscreen: short-press = ±3s seek; hold = trick play
document.addEventListener('keydown', (e) => {
    if (!_inPlayerMode()) return;
    if (playerActive() && (vodNextVisible() || vodTracksOpen())) return; // Left/Right belong to the card / menu
    if (playerActive() && player.focus === 'buttons' && document.getElementById('vodOsd').classList.contains('visible')) return; // moving between buttons
    if (e.repeat) return;
    const isLeft  = e.key === 'ArrowLeft'  || e.keyCode === 37;
    const isRight = e.key === 'ArrowRight' || e.keyCode === 39;
    if (!isLeft && !isRight) return;
    e.preventDefault();
    if (_holdKeyDir) return;
    _holdKeyDir   = isLeft ? 'left' : 'right';
    _holdKeyStart = Date.now();
    showPlayerControls();
    const capturedDir = _holdKeyDir;
    setTimeout(() => {
        if (_holdKeyDir === capturedDir) _startHold(capturedDir);
    }, HOLD_THRESHOLD_MS);
}, true);

document.addEventListener('keyup', (e) => {
    const isLeft  = e.key === 'ArrowLeft'  || e.keyCode === 37;
    const isRight = e.key === 'ArrowRight' || e.keyCode === 39;
    if (!isLeft && !isRight) return;
    if (!_inPlayerMode()) { _holdKeyDir = null; return; }
    if (playerActive() && (vodNextVisible() || vodTracksOpen())) { _holdKeyDir = null; return; }
    if (playerActive() && player.focus === 'buttons' && !_holdKeyDir) return;
    e.preventDefault();
    const held = Date.now() - _holdKeyStart;
    const dir  = _holdKeyDir;
    _holdKeyDir = null;
    if (_isHolding()) {
        _stopHold();
    } else if (dir && held < HOLD_THRESHOLD_MS) {
        _seekBy((dir === 'left' ? -1 : 1) * (vodPlay.active || catchup ? 10 : 3)); // VOD and catch-up skip 10 s, live 3 s
    }
    showPlayerControls();
});

// Step to the previous/next channel within the list currently on screen
// (group, favorites or search result), wrapping at the ends.
function zapChannel(dir) {
    const list = currentFilteredChannels;
    if (!list.length) return;
    const cur = currentChannelIndex >= 0 ? list.indexOf(channels[currentChannelIndex]) : -1;
    const next = cur < 0 ? 0 : (cur + dir + list.length) % list.length;
    if (epgMode) { epgFocusedRowIdx = next; updateEPGRowFocus(); }
    selectChannel(getChannelIndex(list[next]));
}

// Digit keys: direct channel number entry (see "Direct channel number entry")
document.addEventListener('keydown', (e) => {
    const d = digitKeyValue(e);
    if (d < 0 || !digitEntryAllowed()) return;
    e.preventDefault(); e.stopPropagation();
    onDigitKey(d);
}, true);

// Dedicated remote keys: Play (415), Pause (19), CH+ (427), CH- (428).
// These work in fullscreen and in both main views; nothing else in fullscreen
// reacts apart from OK, Back and the Left/Right seek handlers above.
document.addEventListener('keydown', (e) => {
    const kc = e.keyCode;
    if (kc !== 415 && kc !== 19 && kc !== 427 && kc !== 428) return;
    if (!mainApp || mainApp.style.display === 'none' || currentChannelIndex < 0) return;
    if (confirmDialog && !confirmDialog.classList.contains('hidden')) return;
    if (settingsOpen || catsOpen || diagOpen) return;
    if (vodMode !== 'live' && !vodPlay.active) return;
    if (vodPlay.active && (kc === 427 || kc === 428)) return;
    e.preventDefault();
    if (kc === 415) { videoPlayer.play().catch(() => {}); showPlayerControls(); if (playerActive()) document.getElementById('vodPaused').classList.add('hidden'); }
    else if (kc === 19) { videoPlayer.pause(); showPlayerControls(); if (playerActive()) document.getElementById('vodPaused').classList.remove('hidden'); }
    else zapChannel(kc === 427 ? 1 : -1);
}, true);

// Back/Return button (webOS keyCode 461) — capture phase so system default is suppressed
document.addEventListener('keydown', (e) => {
    if (e.keyCode !== 461 && e.key !== 'GoBack') return;

    // Back while the confirm dialog is open cancels it
    if (confirmDialog && !confirmDialog.classList.contains('hidden')) {
        e.preventDefault();
        confirmNo.click();
        return;
    }
    if (diagOpen) { e.preventDefault(); closeDiag(); return; }
    if (vodSortOpen) { e.preventDefault(); closeVodSort(); return; }
    if (catsOpen) { e.preventDefault(); closeCatsManager(); return; }
    if (settingsOpen) { e.preventDefault(); closeSettings(); return; }

    // Player: tracks menu → OSD → leave the player (→ details for VOD, → guide/channels for live)
    if (playerActive() && vodTracksOpen()) { e.preventDefault(); closeVodTracks(); return; }
    if (playerActive() && !vodNextVisible() && document.getElementById('vodOsd').classList.contains('visible')) { e.preventDefault(); hideVodOsd(); return; }
    if (vodPlay.active) { e.preventDefault(); stopVodPlayback(true); return; }
    if (livePlayer.active) { e.preventDefault(); exitLivePlayer(); return; }
    if (vodMode !== 'live' && mainApp && mainApp.style.display !== 'none') {
        e.preventDefault();
        if (vodNav.screen === 'details') closeVodDetails();
        else if (vodNav.list !== 'home') { vodNav.zone = 'content'; openVodList('home'); }
        else setVodMode('live');
        return;
    }

    if (document.fullscreenElement) {
        e.preventDefault();
        document.exitFullscreen();
        return;
    }

    if (mainApp && mainApp.style.display !== 'none') {
        e.preventDefault();
        showConfirmDialog('🏠 Return to Home', 'Return to the home screen?', goToHomeScreen);
        return;
    }

    // Start page: show platform exit prompt (disableBackHistoryAPI=true so we must call explicitly)
    if (typeof webOS !== 'undefined' && webOS.platformBack) webOS.platformBack();
}, true);


// ----- Initialization -----

// Favorites are loaded per playlist when one is applied (favoritesLoad); 'iptv_favorites' is only read to convert old ones
loadSavedPlaylists();
const lastUrl = localStorage.getItem('last_m3u_url');
if (lastUrl) newM3uUrl.value = lastUrl;
// Force a channel list refresh to show favorites
if (currentGroup === 'favorites') refreshCurrentView();

// Auto-load the last playlist (setting). On failure the loader leaves the
// start page showing the error, so nothing else is needed here.
if (settings.autoLoad) {
    let lastKey = null;
    try { lastKey = localStorage.getItem(LAST_PLAYLIST_KEY); } catch (_) { /* storage unavailable */ }
    const idx = lastKey ? savedPlaylists.findIndex(pl => playlistKeyOf(pl) === lastKey) : -1;
    if (idx >= 0) {
        const p = savedPlaylists[idx];
        selectedPlaylistId = idx;
        updateStartStatus(`Auto-loading "${p.name}" …`, false, false, true, 0);
        setTimeout(() => {
            if (p.type === 'xtream') loadXtreamPlaylist(p.url, p.username, p.password);
            else loadM3UFromUrl(p.url, p.epgUrl || '');
        }, 100);
    }
}
perfMark('init-done');
setTimeout(() => { updateFocusableElements(); focusElement(0); }, 500);
// Rooted TV? Then the AV sync row appears in Settings and a saved offset is applied
setTimeout(() => { hbProbe().then(ok => { if (ok && settings.avSync >= 0 && !document.hidden) avSyncApply(settings.avSync); if (settingsOpen) renderSettings(); }); }, 1500);