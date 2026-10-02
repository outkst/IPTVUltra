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
const DEFAULT_SETTINGS = { textScale: 1.375, clock: '12', autoLoad: false, showAdult: false, subLang: 'en', audioLang: 'default' };
const SUB_LANG_OPTIONS = [{ v: 'off', label: 'Off' }, { v: 'en', label: 'English' }, { v: 'es', label: 'Spanish' }, { v: 'fr', label: 'French' }, { v: 'de', label: 'German' }, { v: 'pt', label: 'Portuguese' }, { v: 'it', label: 'Italian' }, { v: 'ar', label: 'Arabic' }, { v: 'any', label: 'First available' }];
const AUDIO_LANG_OPTIONS = [{ v: 'default', label: 'Default' }, { v: 'en', label: 'English' }, { v: 'es', label: 'Spanish' }, { v: 'fr', label: 'French' }, { v: 'de', label: 'German' }, { v: 'pt', label: 'Portuguese' }, { v: 'it', label: 'Italian' }, { v: 'ar', label: 'Arabic' }];
let settings = loadSettings();          // global: textScale, clock, autoLoad
let playlistState = loadPlaylistState(); // per playlist key: startGroup, resume, lastChannel, lastGroup
let _activePlaylistKey = null;          // key of the playlist currently loaded ('m:demo' for the demo)
let settingsOpen = false;
let settingsFocusIdx = 0;
let _settingsRowsCache = null;
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
                  subManual: false, audioManual: false, tracksFocus: 0, tracksItems: [] };
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
const EPG_FETCH_CONCURRENCY = 6;      // parallel get_short_epg requests
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
const streamInfoOverlay = document.getElementById('streamInfoOverlay');
const channelInfoTag = document.getElementById('channelInfoTag');
const infoBtn = document.getElementById('infoBtn');
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
const epgInfoBtn = document.getElementById('epgInfoBtn');
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
function buildChannelIndexMap() {
    channelIndexMap = new Map();
    for (let i = 0; i < channels.length; i++) channelIndexMap.set(channels[i], i);
    _searchCache = { query: null, result: null };
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

function getCurrentProgramme(tvgId) {
    const id = resolveEpgId(tvgId);
    if (!id) return null;
    const progs = epgData.get(id);
    if (!progs || !progs.length) return null;
    const now = Date.now();
    const idx = _epgBinarySearch(progs, now);
    if (idx === -1) return null;
    const p = progs[idx];
    return p.stop > now ? p : null;
}

function getNextProgramme(tvgId) {
    const id = resolveEpgId(tvgId);
    if (!id) return null;
    const progs = epgData.get(id);
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
                        if (nmM) newIdMap.set(nmM[1].toLowerCase().trim(), cid);
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
                        const pStart = parseXMLTVDate(stM[1]);
                        const pStop = spM ? parseXMLTVDate(spM[1]) : null;
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

        renderChannelList();
        updateNowNext();
        startEpgTick();

        const mb = (bytesRead / 1048576).toFixed(1);
        const readyMsg = `${epgData.size.toLocaleString()} channels, ${programmeCount.toLocaleString()} programmes (${mb} MB)`;
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

// ----- Loading playlists -----
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
        const response = await fetch(url, { signal: _m3uAbortController.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let content = await response.text();
        updateStartStatus(`Downloaded ${(content.length / 1024 / 1024).toFixed(1)} MB, parsing...`, false, false, true, 20);
        const parsed = await parseM3UStreaming(content);
        content = null; // free memory
        if (!parsed.length) throw new Error('No channels found');
        channels = parsed;
        buildChannelIndexMap();
        localStorage.setItem('last_m3u_url', url);
        updateStartStatus(`Loaded ${channels.length.toLocaleString()} channels!`, false, true, false, 100);
        currentSearchQuery = '';
        searchInput.value = '';
        _activePlaylistKey = 'm:' + url;
        rememberLastPlaylist(_activePlaylistKey);
        currentGroup = initialGroupFor(_activePlaylistKey);
        currentPlaylistType = 'm3u';
        extractGroups();
        validateCurrentGroup();
        resetStdFocus();
        startPage.classList.add('hidden');
        mainApp.style.display = 'flex';
        renderChannelList();
        statusArea.innerText = `✅ ${channels.length.toLocaleString()} channels`;
        if (channels.length) setTimeout(selectInitialChannel, 500);
        // Start EPG load in background after playlist is ready
        if (epgUrl) setTimeout(() => loadEPG(epgUrl), 1500);
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
function extractGroups() {
    const groups = new Set(['favorites', 'all']);
    for (const ch of channels) {
        if (ch.group && ch.group.trim()) groups.add(ch.group.trim());
    }
    groupsList = Array.from(groups).sort((a, b) => {
        if (a === 'favorites') return -1;
        if (b === 'favorites') return 1;
        if (a === 'all') return -1;
        if (b === 'all') return 1;
        return a.localeCompare(b);
    });
    renderGroupsList();
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
        } else {
            folderIcon = '📁';
            displayName = escapeHtml(group);
        }
        if (currentSearchQuery && group !== 'favorites' && group !== 'all' && group.toLowerCase().includes(currentSearchQuery.toLowerCase())) {
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
        if ((group === 'favorites' || group === 'all') && pinnedDiv) {
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
    const scored = channels.map((ch, idx) => {
        let score = 0;
        const nameLower = ch.name.toLowerCase();
        const groupLower = (ch.group || '').toLowerCase();
        if (nameLower === query.toLowerCase()) score = 100;
        else if (nameLower.startsWith(query.toLowerCase())) score = 90;
        else {
            let matched = 0;
            for (const t of terms) {
                if (nameLower.includes(t)) matched++;
                if (groupLower.includes(t)) matched += 0.5;
            }
            score = Math.min(80, (matched / terms.length) * 60);
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
        filtered = channels.filter((ch, idx) => favoriteIds.has(ch.tvgId || `idx_${idx}`));
    } else if (currentGroup === 'all') {
        filtered = [...channels];
    } else {
        filtered = channels.filter(ch => ch.group === currentGroup);
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
            const fav = favoriteIds.has(ch.tvgId || `idx_${originalIndex}`);
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
                const id = ch.tvgId || `idx_${originalIndex}`;
                if (favoriteIds.has(id)) favoriteIds.delete(id);
                else favoriteIds.add(id);
                localStorage.setItem('iptv_favorites', JSON.stringify([...favoriteIds]));
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
                if (_reloadAttempts >= MAX_AUTO_RELOADS) {
                    // Budget exhausted: stop hammering the stream and tell the user
                    stopStallWatchdog();
                    showStreamError('Stream not responding');
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
    statusArea.innerText = `⚠️ ${msg}`;
    channelInfoTag.innerText = `⚠️ ${name ? name + ' — ' : ''}${msg}`;
    showEPGToast(`${name ? name + ': ' : ''}${msg}. Press Reload to retry.`, 'error', 'Stream Error');
    hideEPGToast(7000);
}

function toggleVideoFullscreen() {
    if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        return;
    }
    if (currentChannelIndex < 0) return;
    try {
        const p = videoPlayer.requestFullscreen ? videoPlayer.requestFullscreen()
            : (videoPlayer.webkitRequestFullscreen ? videoPlayer.webkitRequestFullscreen() : null);
        if (p && p.catch) p.catch(() => {});
    } catch (_) { /* fullscreen unavailable */ }
}

// ----- Video Control -----
function selectChannel(index) {
    if (!channels[index]) return;
    if (vodPlay.active) stopVodPlayback(false);
    stopStallWatchdog();
    if (currentChannelIndex >= 0 && currentChannelIndex !== index) lastChannelIndex = currentChannelIndex;
    currentChannelIndex = index;
    _reloadAttempts = 0;
    if (_errRetryTimer) { clearTimeout(_errRetryTimer); _errRetryTimer = null; }
    const ch = channels[index];
    videoPlayer.pause();
    videoPlayer.src = ch.url;
    videoPlayer.load();
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
    showTopControls();

    // Reset per-stream state
    if (subtitlePanelOpen) { subtitlePanel.classList.add('hidden'); subtitlePanelOpen = false; }
    if (audioPanelOpen) { audioPanel.classList.add('hidden'); audioPanelOpen = false; }

    // Some streams add tracks well after loadedmetadata — check again after a delay
    setTimeout(function () { updateSubtitleButton(); updateAudioButton(); }, 4000);
}

function showTopControls() {
    const c = document.getElementById('topControls');
    c.classList.add('visible');
    const cr = document.getElementById('topControlsRight');
    if (cr) cr.classList.add('visible');
    const ec = document.getElementById('epgTopControls');
    if (ec) ec.classList.add('visible');
    if (controlsTimeout) clearTimeout(controlsTimeout);
    controlsTimeout = setTimeout(() => {
        c.classList.remove('visible');
        if (cr) cr.classList.remove('visible');
        if (ec) ec.classList.remove('visible');
    }, 3000);
}

function resolveLanguage(code) {
    if (!code) return null;
    const short = code.toLowerCase().substring(0, 2);
    return LANG_NAMES[short] || code;
}

function showStreamInfo() {
    const w = videoPlayer.videoWidth, h = videoPlayer.videoHeight;

    // Video resolution
    let resText = (w && h) ? (w + '×' + h) : 'Loading ...';
    if (w >= 3840) resText += ' (4K/UHD)';
    else if (w >= 1920) resText += ' (FHD 1080p)';
    else if (w >= 1280) resText += ' (HD 720p)';
    else if (w >= 720) resText += ' (SD+)';
    else if (w > 0) resText += ' (SD)';

    // Active audio track
    let audioLang = '—';
    if (videoPlayer.audioTracks && videoPlayer.audioTracks.length) {
        const tracks = Array.from(videoPlayer.audioTracks);
        const active = tracks.find(function (t) { return t.enabled; }) || tracks[0];
        if (active) {
            const resolvedLang = active.language ? resolveLanguage(active.language) : null;
            if (active.label && active.label.trim()) {
                audioLang = active.label.trim();
            } else {
                audioLang = resolvedLang || 'Unknown';
            }
            if (active.kind && active.kind !== 'main' && active.kind !== '') {
                audioLang += ' [' + active.kind + ']';
            }
        }
    }

    // Subtitle tracks
    const subTracks = getSubtitleTracks();
    const subInfo = subTracks.length
        ? subTracks.length + ' track' + (subTracks.length > 1 ? 's' : '') + ' available'
        : 'None detected';

    // Audio track count subtitle
    const audioTracks = getAudioTracks();
    let audioCountSub = '';
    if (audioTracks.length > 1) {
        const uniqueLangs = new Set(audioTracks.map(function (t) { return t.language || ''; }).filter(Boolean));
        let countText;
        if (uniqueLangs.size >= audioTracks.length) {
            countText = audioTracks.length + ' languages available';
        } else if (uniqueLangs.size <= 1) {
            countText = audioTracks.length + ' tracks available';
        } else {
            countText = audioTracks.length + ' tracks, ' + uniqueLangs.size + ' languages';
        }
        audioCountSub = '<span class="si-sub">' + countText + '</span>';
    }

    streamInfoOverlay.innerHTML =
        '<div class="si-section">' +
        '<div class="si-label">Video</div>' +
        '<div class="si-row"><span class="si-key">Resolution</span><span class="si-val">' + escapeHtml(resText) + '</span></div>' +
        '</div>' +
        '<div class="si-section">' +
        '<div class="si-label">Audio</div>' +
        '<div class="si-row"><span class="si-key">Language</span><span class="si-val">' + escapeHtml(audioLang) + audioCountSub + '</span></div>' +
        '</div>' +
        '<div class="si-section">' +
        '<div class="si-label">Subtitles</div>' +
        '<div class="si-row"><span class="si-key">Tracks</span><span class="si-val">' + escapeHtml(subInfo) + '</span></div>' +
        '</div>';

    streamInfoOverlay.style.opacity = '1';
    channelInfoTag.style.visibility = 'hidden'; // the tag sits under the overlay's corner
    if (infoHideTimeout) clearTimeout(infoHideTimeout);
    infoHideTimeout = setTimeout(function () { streamInfoOverlay.style.opacity = '0'; channelInfoTag.style.visibility = ''; }, 3000);
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
            if (parseFloat(streamInfoOverlay.style.opacity) > 0) showStreamInfo();
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
    const url = channels[currentChannelIndex].url;
    const wasPlaying = !videoPlayer.paused;
    videoPlayer.pause();
    videoPlayer.src = url;
    videoPlayer.load();
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
    if (infoHideTimeout) { clearTimeout(infoHideTimeout); infoHideTimeout = null; }
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
    _epgWinStart = 0; _epgWinEnd = 0; _epgTotalGuideW = 0; _epgSkeletonWinStart = 0;

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
    resetVodState(false);
    exitEPGMode();
    _activePlaylistKey = null;
    if (settingsOpen) closeSettings();
    currentPlaylistType = null;
    isLoading = false;

    // Stop and clear video
    videoPlayer.pause();
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
const EPG_WIN_HOURS = 7;   // ~1h past + 6h ahead

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
        if (streamInfoOverlay.parentNode !== wrap) wrap.appendChild(streamInfoOverlay);
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
    if (streamInfoOverlay.parentNode !== videoArea) videoArea.insertBefore(streamInfoOverlay, document.getElementById('epgNowNext'));
}

function refreshCurrentView() {
    if (vodMode !== 'live') {
        if (vodNav.screen === 'home') renderVodHome(); else if (vodNav.screen === 'grid') renderVodGrid(); else if (vodNav.screen === 'details') renderVodDetails();
        return;
    }
    if (currentPlaylistType === 'xtream') renderEPGGuide();
    else renderChannelList();
}

function buildEPGRow(i) {
    const ch = currentFilteredChannels[i];
    const origIdx = getChannelIndex(ch);
    const isActive = origIdx === currentChannelIndex;
    const now = Date.now();

    const row = document.createElement('div');
    row.className = 'epg-row' +
        (isActive ? ' active' : '') +
        (i === epgFocusedRowIdx ? ' epg-focused' : '');
    row.style.cssText = `position:absolute;top:${i * EPG_ROW_H}px;width:${EPG_CH_W + _epgTotalGuideW}px`;

    const logoSrc = ch.tvgLogo ? escapeHtml(ch.tvgLogo) : '';
    const favId = ch.tvgId || `idx_${origIdx}`;
    const isFav = favoriteIds.has(favId);
    const labelHtml = `<div class="epg-ch-label"><div class="epg-ch-logo-wrap"><span class="epg-ch-no-logo">📺</span>${logoSrc ? `<img class="epg-ch-logo" src="${logoSrc}" onerror="this.style.display='none';this.classList.add('failed')">` : ''}</div><span class="epg-ch-name">${escapeHtml(ch.name.length > 22 ? ch.name.slice(0, 20) + '…' : ch.name)}</span><button class="epg-fav-btn${isFav ? ' fav-active' : ''}" data-fav-id="${escapeHtml(favId)}">${isFav ? '★' : '☆'}</button></div>`;

    const resolvedId = resolveEpgId(ch.tvgId);
    const progs = resolvedId ? (epgData.get(resolvedId) || []) : [];
    const progsParts = [`<div class="epg-progs" style="width:${_epgTotalGuideW}px">`];
    let hadBlock = false;
    for (const p of progs) {
        if (p.stop <= _epgWinStart || p.start >= _epgWinEnd) continue;
        const sx = Math.max(0, (p.start - _epgWinStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
        const ex = Math.min(_epgTotalGuideW, (p.stop - _epgWinStart) / 60000 * EPG_PX_PER_MIN);
        const w = (ex - parseFloat(sx) - 2).toFixed(1);
        if (parseFloat(w) < 4) continue;
        const isNow = p.start <= now && p.stop > now;
        const wNum = parseFloat(w);
        const descHtml = p.desc && wNum > 120 * TEXT_SCALE
            ? `<span class="epg-prog-desc">${escapeHtml(p.desc)}</span>`
            : '';
        progsParts.push(`<div class="epg-prog-block${isNow ? ' now-playing' : ''}" data-start="${p.start}" data-stop="${p.stop}" style="left:${sx}px;width:${w}px">` +
            `<span class="epg-prog-title">${escapeHtml(p.title)}</span>${descHtml}</div>`);
        hadBlock = true;
    }
    if (!hadBlock) {
        const label = epgPlaceholderText(ch.tvgId);
        const cls = label === 'Loading ...' ? 'epg-prog-placeholder loading' : 'epg-prog-placeholder';
        progsParts.push(`<div class="${cls}" style="left:2px;width:${(_epgTotalGuideW - 4).toFixed(1)}px">` +
            `<span class="epg-prog-title">${label}</span></div>`);
    }
    progsParts.push('</div>');
    row.innerHTML = labelHtml + progsParts.join('');
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

function renderEPGVisibleRows() {
    const body = document.getElementById('epgBody');
    const scrollOuter = document.getElementById('epgScrollOuter');
    if (!body || !scrollOuter || !currentFilteredChannels.length || !_epgTotalGuideW) return;
    const BUFFER = 3;
    // Row i occupies content offset [strip + i*rowH, strip + (i+1)*rowH)
    const scrollTop = scrollOuter.scrollTop;
    const viewH = scrollOuter.clientHeight;
    const startIdx = Math.max(0, Math.floor(scrollTop / EPG_ROW_H) - BUFFER);
    const endIdx = Math.min(currentFilteredChannels.length - 1,
        Math.ceil((scrollTop + viewH - EPG_TIME_STRIP_H) / EPG_ROW_H) + BUFFER);
    for (const [idx, el] of epgRenderedRows) {
        if (idx < startIdx || idx > endIdx) { el.remove(); epgRenderedRows.delete(idx); }
    }
    for (let i = startIdx; i <= endIdx; i++) {
        if (epgRenderedRows.has(i)) continue;
        const row = buildEPGRow(i);
        body.appendChild(row);
        epgRenderedRows.set(i, row);
    }
    scheduleEpgFetchForVisible();
}

function updateEPGNowMarker() {
    const body = document.getElementById('epgBody');
    const timeMarks = document.getElementById('epgTimeMarks');
    if (!body || !timeMarks || !_epgWinStart) return;
    const fullMarker = body.querySelector('.epg-now-fullmarker');
    if (!fullMarker) return;
    const nowOffsetPx = ((Date.now() - _epgWinStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
    fullMarker.style.left = `${timeMarks.offsetLeft + parseFloat(nowOffsetPx)}px`;
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
    const nowOffsetPx = ((Date.now() - winStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
    tmHtml += `<div class="epg-now-line" style="left:${nowOffsetPx}px"><span class="epg-now-label">NOW</span></div>`;
    timeMarks.innerHTML = tmHtml;
}

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

function renderEPGGuide() {
    const guideWrap = document.getElementById('epgGuideWrap');
    if (!guideWrap) return;
    if (guideWrap.clientWidth <= 0) { requestAnimationFrame(renderEPGGuide); return; }

    renderChannelList(); // always updates currentFilteredChannels (exits early for Xtream after filtering)

    const now = Date.now();
    const HOUR_MS = 3600000;
    const winStart = Math.floor((now - HOUR_MS) / HOUR_MS) * HOUR_MS;
    const winEnd = winStart + EPG_WIN_HOURS * HOUR_MS;

    if (winStart !== _epgSkeletonWinStart) rebuildEPGSkeleton(winStart, winEnd);
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
        const favId = ch.tvgId || `idx_${getChannelIndex(ch)}`;
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

function pumpEpgQueue() {
    while (_epgInFlight < EPG_FETCH_CONCURRENCY && _epgQueue.length) {
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
                for (const ep of listings) {
                    const pStart = parseInt(ep.start_timestamp) * 1000;
                    const pStop = parseInt(ep.stop_timestamp) * 1000;
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
    // A failed fetch is retried after 60 s instead of waiting out the full TTL
    _epgFetchMeta.set(tvgId, { at: ok ? Date.now() : Date.now() - EPG_CACHE_TTL_MS + 60000, status: ok ? 'done' : 'error' });
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

// Refresh whatever is on screen for this channel, in place
function onEpgChannelUpdated(tvgId) {
    if (currentPlaylistType !== 'xtream') return;
    if (epgMode) {
        for (const [idx, el] of epgRenderedRows) {
            const ch = currentFilteredChannels[idx];
            if (ch && ch.tvgId === tvgId) {
                const fresh = buildEPGRow(idx);
                el.replaceWith(fresh);
                epgRenderedRows.set(idx, fresh);
            }
        }
    }
    const cur = currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
    if (cur && cur.tvgId === tvgId) {
        if (epgMode) updateEPGInfoPanel(cur);
        updateNowNext();
    }
}

// Debounced: once scrolling settles, fetch EPG for the rows that are rendered
function scheduleEpgFetchForVisible() {
    if (!_xt) return;
    if (_epgVisibleFetchTimer) clearTimeout(_epgVisibleFetchTimer);
    _epgVisibleFetchTimer = setTimeout(() => {
        _epgVisibleFetchTimer = null;
        const ids = [];
        for (const idx of epgRenderedRows.keys()) {
            const ch = currentFilteredChannels[idx];
            if (ch && ch.tvgId) ids.push(ch.tvgId);
        }
        if (ids.length) queueEpgFetch(ids, true);
    }, 150);
}

// Background prefetch so the Favorites group is populated without scrolling
function prefetchFavoritesEpg() {
    if (!_xt) return;
    const ids = new Set();
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        if (ch.tvgId && favoriteIds.has(ch.tvgId) && epgNeedsFetch(ch.tvgId)) ids.add(ch.tvgId);
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
        const winStart = Math.floor((now - HOUR_MS) / HOUR_MS) * HOUR_MS;
        if (_epgSkeletonWinStart && winStart !== _epgSkeletonWinStart) {
            // Hour rolled over: shift the horizontal scroll so the same wall-clock
            // time stays in view, then rebuild the time strip and rows once.
            const so = document.getElementById('epgScrollOuter');
            if (so) so.scrollLeft = Math.max(0, so.scrollLeft - 60 * EPG_PX_PER_MIN);
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
        // 1. Authenticate
        const authResp = await fetch(`${base}/player_api.php?username=${u}&password=${pw}`);
        if (!authResp.ok) throw new Error(`Auth HTTP ${authResp.status}`);
        const authData = await authResp.json();
        if (authData.user_info && authData.user_info.auth === 0) throw new Error('Invalid username or password');
        updateStartStatus('Authenticated! Loading categories …', false, false, true, 15);

        // 2. Categories (for group names)
        let catMap = {};
        try {
            const catResp = await fetch(`${base}/player_api.php?username=${u}&password=${pw}&action=get_live_categories`);
            if (catResp.ok) {
                const cats = await catResp.json();
                if (Array.isArray(cats)) cats.forEach(c => { catMap[String(c.category_id)] = c.category_name; });
            }
        } catch { /* categories are optional */ }
        updateStartStatus('Loading channel list …', false, false, true, 30);

        // 3. Live streams
        const streamsResp = await fetch(`${base}/player_api.php?username=${u}&password=${pw}&action=get_live_streams`);
        if (!streamsResp.ok) throw new Error(`Streams HTTP ${streamsResp.status}`);
        const streamsText = await streamsResp.text();
        updateStartStatus('Parsing channels …', false, false, true, 55);
        await new Promise(r => setTimeout(r, 0)); // yield before heavy JSON parse

        const streams = JSON.parse(streamsText);
        if (!Array.isArray(streams) || !streams.length) throw new Error('No live channels found');

        // 4. Map to internal channel format in batches
        const parsed = [];
        const BATCH = 5000;
        for (let i = 0; i < streams.length; i += BATCH) {
            const slice = streams.slice(i, i + BATCH);
            for (const s of slice) {
                parsed.push({
                    name: s.name || 'Unknown',
                    tvgId: s.epg_channel_id || String(s.stream_id),
                    tvgLogo: s.stream_icon || '',
                    group: catMap[String(s.category_id)] || '',
                    url: `${base}/live/${username}/${password}/${s.stream_id}.m3u8`,
                    streamId: s.stream_id
                });
            }
            const pct = Math.min(90, 55 + Math.round((i / streams.length) * 35));
            updateStartStatus(`Parsed ${parsed.length.toLocaleString()} channels …`, false, false, true, pct);
            await new Promise(r => setTimeout(r, 5));
        }

        channels = parsed;
        buildChannelIndexMap();
        _xt = { base, u, pw, user: username, pass: password };
        resetVodState(true); // show the Live / Movies / Series switch
        _xtStreamIdByTvgId = new Map();
        for (const ch of parsed) if (!_xtStreamIdByTvgId.has(ch.tvgId)) _xtStreamIdByTvgId.set(ch.tvgId, ch.streamId);
        localStorage.setItem('last_m3u_url', ''); // clear M3U cache; Xtream uses its own auth
        updateStartStatus(`Loaded ${channels.length.toLocaleString()} channels!`, false, true, false, 100);
        currentSearchQuery = '';
        searchInput.value = '';
        _activePlaylistKey = 'x:' + base + '|' + username;
        rememberLastPlaylist(_activePlaylistKey);
        currentGroup = initialGroupFor(_activePlaylistKey);
        currentPlaylistType = 'xtream';
        extractGroups();
        validateCurrentGroup();
        startPage.classList.add('hidden');
        mainApp.style.display = 'flex';
        enterEPGMode(); // switch to guide layout immediately; programme blocks fill in as EPG loads
        statusArea.innerText = `✅ ${channels.length.toLocaleString()} channels`;
        if (channels.length) setTimeout(selectInitialChannel, 500);

        // 5. EPG is fetched lazily per visible row (see "Xtream lazy EPG"); warm favorites in the background
        startEpgTick();
        setTimeout(prefetchFavoritesEpg, 1200);

    } catch (err) {
        updateStartStatus(`Error: ${err.message}`, true, false, false, 0);
        setLoadSelectedButtonEnabled(true);
    } finally {
        isLoading = false;
        showLoading(false);
        setTimeout(() => { if (!startPage.classList.contains('hidden')) updateStartStatus('Ready', false, false, false, 0); }, 3000);
    }
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
             added: (parseInt(s.added) || 0) * 1000, ext: s.container_extension || 'mp4', catId: String(s.category_id) };
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
    if (prev === 'live') { stopStallWatchdog(); if (_errRetryTimer) { clearTimeout(_errRetryTimer); _errRetryTimer = null; } videoPlayer.pause(); }
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
    vodNav.items = items;
    renderVodGrid();
    if (list === 'all') focusVodSearch();
}
function applyVodSearch() {
    const q = vodNav.query || '';
    if (vodNav.screen === 'home') { if (q.trim()) { openVodList('all').then(() => { vodNav.query = q; document.getElementById('vodSearchInput').value = q; applyVodSearch(); }); } return; }
    vodNav.items = q.trim() ? vodSearchItems(vodNav.baseItems, q) : vodNav.baseItems;
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
        (pct ? `<div class="vod-prog"><i style="width:${pct}%"></i></div>` : '') +
        `</div><div class="vod-card-t">${escapeHtml(item.name)}</div><div class="vod-card-m">${escapeHtml(meta)}</div>`;
    card.addEventListener('click', () => openVodItem(item));
    return card;
}
function renderVodGrid() {
    const home = document.getElementById('vodHome'), grid = document.getElementById('vodGrid'), empty = document.getElementById('vodEmpty');
    home.style.display = 'none'; empty.style.display = 'none'; grid.style.display = '';
    const items = vodNav.items;
    const cats = (vodMode === 'movies' ? vodCats : seriesCats) || [];
    const cat = cats.find(c => c.id === vodNav.catId);
    const title = vodNav.list === 'favs' ? '⭐ Favorites' : vodNav.list === 'all' ? (vodMode === 'movies' ? '🔍 All movies' : '🔍 All series') : '📁 ' + (cat ? cat.name : '');
    setVodHeader(title, `${items.length.toLocaleString()} titles${vodNav.query ? ` · "${vodNav.query}"` : ''}`);
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
    const info = { plot: i.plot || i.description || '', cast: i.cast || i.actors || '', director: i.director || '', genre: i.genre || '',
                   releaseDate: i.releasedate || i.release_date || '', duration: parseDurationSecs(i), rating: parseFloat(i.rating) || item.rating || 0,
                   backdrop: Array.isArray(i.backdrop_path) ? i.backdrop_path[0] : (i.backdrop_path || ''), image: i.movie_image || i.cover_big || item.icon,
                   ext: md.container_extension || item.ext };
    vodInfoCache.set(item.id, info);
    return info;
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
    html += `<div class="vod-dhint">◀ ▶ move · OK select · Back to ${vodNav.list === 'home' ? 'Home' : 'list'}</div></div></div>`;
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
function _inPlayerMode() { return !!document.fullscreenElement || vodPlay.active; }
function showPlayerControls() { if (vodPlay.active) showVodOsd(); else showTopControls(); }
function vodNextVisible() { return !document.getElementById('vodNext').classList.contains('hidden'); }
function restoreLiveVideoSlot() {
    const wrap = (currentPlaylistType === 'xtream' && epgMode) ? document.getElementById('epgVideoWrap') : videoArea;
    if (videoPlayer.parentNode !== wrap) { if (wrap === videoArea) videoArea.insertBefore(videoPlayer, videoArea.firstChild); else wrap.appendChild(videoPlayer); }
    videoPlayer.setAttribute('controls', '');
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
    videoPlayer.pause();
    videoPlayer.src = url;
    videoPlayer.load();
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
    if (_isHolding()) _stopHold();
    _holdKeyDir = null;
    closeVodTracks();
    videoPlayer.querySelectorAll('track').forEach(t => t.remove());
    if (vodPlay.osdTimer) { clearTimeout(vodPlay.osdTimer); vodPlay.osdTimer = null; }
    videoPlayer.pause();
    videoPlayer.removeAttribute('src');
    videoPlayer.load();
    vodPlay.active = false;
    document.getElementById('vodPlayer').classList.add('hidden');
    document.getElementById('vodOsd').classList.remove('visible');
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
function showVodOsd() {
    const osd = document.getElementById('vodOsd');
    updateVodOsd();
    osd.classList.add('visible');
    if (vodPlay.osdTimer) clearTimeout(vodPlay.osdTimer);
    vodPlay.osdTimer = setTimeout(() => { if (!videoPlayer.paused) osd.classList.remove('visible'); }, 3000);
}
function toggleVodPause() {
    if (videoPlayer.paused) videoPlayer.play().catch(() => {}); else videoPlayer.pause();
    document.getElementById('vodPaused').classList.toggle('hidden', !videoPlayer.paused);
    showVodOsd();
}
function handleVodPlayerKey(e, up, down, left, right, enter) {
    if (e.keyCode === 404 || e.key === 'ColorF1Green') { e.preventDefault(); if (vodTracksOpen()) closeVodTracks(); else openVodTracks(); return; }
    if (vodTracksOpen()) {
        if (up || down) { e.preventDefault(); moveVodTracksFocus(up ? -1 : 1); }
        else if (left || right || enter) e.preventDefault(); // Enter handled on keyup
        return;
    }
    if (vodNextVisible()) {
        if (left || right) { e.preventDefault(); vodPlay.nextFocus = left ? 'play' : 'cancel'; updateVodNextFocus(); }
        else if (up || down) e.preventDefault();
        return; // Enter is handled by the shared keyup listener
    }
    if (up || down) { e.preventDefault(); _seekBy(up ? 60 : -60); showVodOsd(); }
    else if (enter) e.preventDefault(); // play/pause on keyup (shared with live fullscreen)
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
    if (!vodPlay.active) return;
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
    const subs = getSubtitleTracks();
    if (subs.length && !vodPlay.subManual) {
        const pref = settings.subLang;
        let chosen = null;
        if (pref === 'any') chosen = subs[0];
        else if (pref !== 'off') chosen = subs.find(t => trackMatchesLang(t, pref)) || null;
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
    const subs = getSubtitleTracks(), auds = getAudioTracks();
    const on = subs.find(t => t.mode === 'showing');
    const bits = [];
    if (subs.length) bits.push('Subtitles: ' + (on ? trackDisplayName(on, subs.indexOf(on)) : 'Off'));
    if (auds.length > 1) { const a = auds.find(t => t.enabled); if (a) bits.push('Audio: ' + trackDisplayName(a, auds.indexOf(a))); }
    if (subs.length || auds.length > 1) bits.push('Green: audio & subtitles');
    el.textContent = bits.join(' · ');
}
function vodTracksOpen() { const p = document.getElementById('vodTracks'); return !!p && !p.classList.contains('hidden'); }
function vodTracksItems() {
    const items = [];
    const auds = getAudioTracks();
    if (auds.length > 1) { items.push({ header: 'Audio' }); auds.forEach((t, i) => items.push({ kind: 'audio', track: t, label: trackDisplayName(t, i), on: !!t.enabled })); }
    const subs = getSubtitleTracks();
    items.push({ header: 'Subtitles' });
    items.push({ kind: 'sub', track: null, label: 'Off', on: !subs.some(t => t.mode === 'showing') });
    subs.forEach((t, i) => items.push({ kind: 'sub', track: t, label: trackDisplayName(t, i), on: t.mode === 'showing' }));
    if (!subs.length) items.push({ note: 'This file has no subtitle tracks' });
    return items;
}
function openVodTracks() {
    if (!vodPlay.active) return;
    const items = vodTracksItems();
    vodPlay.tracksItems = items;
    const first = items.findIndex(it => it.kind && it.on);
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
        row.addEventListener('click', () => { vodPlay.tracksFocus = i; activateVodTrack(); });
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
function activateVodTrack() {
    const it = vodPlay.tracksItems[vodPlay.tracksFocus];
    if (!it || !it.kind) return;
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
    if (ps.startGroup === 'all') return 'all';
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
        { id: 'autoLoad', type: 'toggle', label: 'Auto-load last playlist', sub: 'Skip the start page on launch',
          get: () => settings.autoLoad, set: v => { settings.autoLoad = v; saveSettings(); } },
        { id: 'startGroup', type: 'choice', label: 'Starting group', sub: forName, disabled: !t,
          options: [{ v: 'favorites', label: 'Favorites' }, { v: 'all', label: 'All Channels' }, { v: 'last', label: 'Last used' }],
          get: () => (ps && ps.startGroup) || 'favorites', set: v => { ps.startGroup = v; savePlaylistState(); } },
        { id: 'resume', type: 'toggle', label: 'Resume last channel', sub: forName, disabled: !t,
          get: () => !ps || ps.resume !== false, set: v => { ps.resume = v; savePlaylistState(); } },
        { id: 'subLang', type: 'choice', label: 'Subtitles', sub: 'Movies and Series: turned on automatically when the file has them',
          options: SUB_LANG_OPTIONS, get: () => settings.subLang, set: v => { settings.subLang = v; saveSettings(); if (vodPlay.active) { vodPlay.subManual = false; applyVodTrackPrefs(); } } },
        { id: 'audioLang', type: 'choice', label: 'Audio language', sub: 'Movies and Series: picked when the file offers it',
          options: AUDIO_LANG_OPTIONS, get: () => settings.audioLang, set: v => { settings.audioLang = v; saveSettings(); if (vodPlay.active) { vodPlay.audioManual = false; applyVodTrackPrefs(); } } },
        { id: 'showAdult', type: 'toggle', label: 'Show adult categories', sub: 'Movies and Series',
          get: () => !!settings.showAdult,
          set: v => { settings.showAdult = v; saveSettings(); if (vodMode !== 'live') { renderGroupsList(); if (vodNav.screen === 'home') renderVodHome(); else if (vodNav.screen === 'grid' && vodNav.list === 'all') openVodList('all'); } } },
        { id: 'clearFavs', type: 'action', label: 'Clear favorites', sub: `${favoriteIds.size.toLocaleString()} saved`, button: 'Clear', disabled: !favoriteIds.size,
          run: () => showConfirmDialog('⭐ Clear Favorites', `Remove all ${favoriteIds.size.toLocaleString()} favorites?`, clearFavorites) },
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
function clearFavorites() {
    favoriteIds.clear();
    localStorage.setItem('iptv_favorites', '[]');
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
function updateEPGRowFocus() {
    for (const [idx, el] of epgRenderedRows) {
        el.classList.toggle('epg-focused', idx === epgFocusedRowIdx);
    }
    scrollEPGRowIntoView(epgFocusedRowIdx);
}

function scrollEPGRowIntoView(idx) {
    const scrollOuter = document.getElementById('epgScrollOuter');
    if (!scrollOuter) return;
    // Rows start after the in-flow sticky time strip, so a row's content
    // offset is strip + idx*rowH; the strip also covers the top of the viewport.
    const timeStripH = EPG_TIME_STRIP_H;
    const rowTop = idx * EPG_ROW_H;
    const rowBottom = rowTop + EPG_ROW_H;
    const viewTop = scrollOuter.scrollTop;
    const viewBottom = scrollOuter.scrollTop + scrollOuter.clientHeight - timeStripH;
    if (rowTop < viewTop) {
        scrollOuter.scrollTop = rowTop;
        renderEPGVisibleRows();
    } else if (rowBottom > viewBottom) {
        scrollOuter.scrollTop = rowBottom + timeStripH - scrollOuter.clientHeight;
        renderEPGVisibleRows();
    }
}

function scrollEPGTimeBy(mins) {
    const scrollOuter = document.getElementById('epgScrollOuter');
    if (!scrollOuter) return;
    const maxScroll = EPG_WIN_HOURS * 60 * EPG_PX_PER_MIN - Math.max(1, scrollOuter.clientWidth - EPG_CH_W);
    scrollOuter.scrollLeft = Math.max(0, Math.min(maxScroll, scrollOuter.scrollLeft + mins * EPG_PX_PER_MIN));
    updateEPGNavVisibility();
}

function updateEPGNavVisibility() {
    const so = document.getElementById('epgScrollOuter');
    const prevBtn = document.getElementById('epgTimePrevBtn');
    const nextBtn = document.getElementById('epgTimeNextBtn');
    if (!so || !prevBtn || !nextBtn) return;
    const maxScroll = EPG_WIN_HOURS * 60 * EPG_PX_PER_MIN - Math.max(1, so.clientWidth - EPG_CH_W);
    prevBtn.classList.toggle('epg-nav-hidden', so.scrollLeft <= 1);
    nextBtn.classList.toggle('epg-nav-hidden', so.scrollLeft >= maxScroll - 1);
}

function toggleEPGFav(id) {
    if (favoriteIds.has(id)) favoriteIds.delete(id);
    else favoriteIds.add(id);
    localStorage.setItem('iptv_favorites', JSON.stringify([...favoriteIds]));
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

    // Settings overlay owns the remote while open
    if (settingsOpen) { handleSettingsKey(e); return; }

    // Fullscreen playback keys (seek, trick-play, play/pause) have dedicated listeners
    if (document.fullscreenElement) return;
    if (vodPlay.active) { handleVodPlayerKey(e, up, down, left, right, enter); return; }

    // Yellow colour key opens Settings from any screen
    if (kc === 405 || k === 'ColorF2Yellow') { e.preventDefault(); openSettings(); return; }

    const inMain = mainApp && mainApp.style.display !== 'none';

    // Blue colour key cycles Live / Movies / Series (Xtream playlists only)
    if (kc === 406 || k === 'ColorF3Blue') { if (inMain && currentPlaylistType === 'xtream') { e.preventDefault(); cycleVodMode(); } return; }

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
        else if (left) { e.preventDefault(); scrollEPGTimeBy(-30); }
        else if (right) { e.preventDefault(); scrollEPGTimeBy(30); }
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
infoBtn.addEventListener('click', () => { showStreamInfo(); showTopControls(); });
if (epgInfoBtn) epgInfoBtn.addEventListener('click', () => { showStreamInfo(); showTopControls(); });

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
    vodPlayerEl.addEventListener('mousemove', () => { if (vodPlay.active) showVodOsd(); });
    vodPlayerEl.addEventListener('click', e => { if (vodPlay.active && !e.target.closest('.vod-next')) toggleVodPause(); });
}
videoPlayer.addEventListener('timeupdate', function () {
    if (!vodPlay.active) return;
    if (document.getElementById('vodOsd').classList.contains('visible')) updateVodOsd();
    saveVodProgress(false);
});
videoPlayer.addEventListener('ended', onVodEnded);
videoPlayer.addEventListener('waiting', function () { if (vodPlay.active) document.getElementById('vodLoading').classList.remove('hidden'); });
videoPlayer.addEventListener('playing', function () { if (vodPlay.active) { document.getElementById('vodLoading').classList.add('hidden'); document.getElementById('vodPaused').classList.add('hidden'); } });
videoPlayer.addEventListener('pause', function () { if (vodPlay.active && !vodPlay.ended && !videoPlayer.ended) document.getElementById('vodPaused').classList.remove('hidden'); });
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
videoPlayer.addEventListener('loadedmetadata', function () { showStreamInfo(); updateSubtitleButton(); updateAudioButton(); });
videoPlayer.addEventListener('error', function () {
    if (vodPlay.active) { if (videoPlayer.getAttribute('src')) onVodError(); return; }
    if (vodMode !== 'live') return; // live video is parked while browsing Movies/Series
    if (currentChannelIndex < 0 || !videoPlayer.getAttribute('src')) return; // src cleared on purpose
    const code = videoPlayer.error ? videoPlayer.error.code : 0;
    const msg = code === 2 ? 'Network error' : code === 3 ? 'Decode error' : code === 4 ? 'Stream unavailable or unsupported' : 'Playback error';
    stopStallWatchdog();
    if (_reloadAttempts >= MAX_AUTO_RELOADS) { showStreamError(msg); return; }
    _reloadAttempts++;
    statusArea.innerText = `⚠️ ${msg} — retrying (${_reloadAttempts}/${MAX_AUTO_RELOADS}) …`;
    const idx = currentChannelIndex;
    if (_errRetryTimer) clearTimeout(_errRetryTimer);
    _errRetryTimer = setTimeout(function () { _errRetryTimer = null; if (currentChannelIndex === idx) reloadStream(true); }, 2500);
});
videoPlayer.addEventListener('resize', showStreamInfo);
videoArea.addEventListener('mousemove', showTopControls);
videoArea.addEventListener('click', function (e) {
    if (subtitlePanelOpen && !subtitlePanel.contains(e.target) && e.target !== subtitleBtn) toggleSubtitlePanel();
    if (audioPanelOpen && !audioPanel.contains(e.target) && e.target !== audioBtn) toggleAudioPanel();
});
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
    if (vodPlay.active) {
        if (vodTracksOpen()) activateVodTrack();
        else if (vodNextVisible()) activateVodNext();
        else toggleVodPause(); // no long-press action in VOD
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
    if (vodPlay.active && (vodNextVisible() || vodTracksOpen())) return; // Left/Right belong to the card / menu
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
    if (vodPlay.active && (vodNextVisible() || vodTracksOpen())) { _holdKeyDir = null; return; }
    e.preventDefault();
    const held = Date.now() - _holdKeyStart;
    const dir  = _holdKeyDir;
    _holdKeyDir = null;
    if (_isHolding()) {
        _stopHold();
    } else if (dir && held < HOLD_THRESHOLD_MS) {
        _seekBy((dir === 'left' ? -1 : 1) * (vodPlay.active ? 10 : 3)); // VOD skips 10 s, live 3 s
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

// Dedicated remote keys: Play (415), Pause (19), CH+ (427), CH- (428).
// These work in fullscreen and in both main views; nothing else in fullscreen
// reacts apart from OK, Back and the Left/Right seek handlers above.
document.addEventListener('keydown', (e) => {
    const kc = e.keyCode;
    if (kc !== 415 && kc !== 19 && kc !== 427 && kc !== 428) return;
    if (!mainApp || mainApp.style.display === 'none' || currentChannelIndex < 0) return;
    if (confirmDialog && !confirmDialog.classList.contains('hidden')) return;
    if (settingsOpen) return;
    if (vodMode !== 'live' && !vodPlay.active) return;
    if (vodPlay.active && (kc === 427 || kc === 428)) return;
    e.preventDefault();
    if (kc === 415) { videoPlayer.play().catch(() => {}); showPlayerControls(); if (vodPlay.active) document.getElementById('vodPaused').classList.add('hidden'); }
    else if (kc === 19) { videoPlayer.pause(); showPlayerControls(); if (vodPlay.active) document.getElementById('vodPaused').classList.remove('hidden'); }
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
    if (settingsOpen) { e.preventDefault(); closeSettings(); return; }

    // VOD: player → details → list → Home → Live
    if (vodPlay.active && vodTracksOpen()) { e.preventDefault(); closeVodTracks(); return; }
    if (vodPlay.active) { e.preventDefault(); stopVodPlayback(true); return; }
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

const savedFavs = localStorage.getItem('iptv_favorites');
if (savedFavs) try { favoriteIds = new Set(JSON.parse(savedFavs)); } catch (e) { }
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
setTimeout(() => { updateFocusableElements(); focusElement(0); }, 500);