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
const EPG_ROW_H = 63;           // 62px row height + 1px border-bottom
let epgRenderedRows = new Map(); // rowIdx → DOM element currently in the DOM
let epgVirtualScrollListener = null;
let _epgWinStart = 0;
let _epgWinEnd = 0;
let _epgTotalGuideW = 0;
let _epgSkeletonWinStart = 0;  // tracks which hour window the time strip was built for

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

let controlsTimeout = null;
let _pbPanelTimer = null;
let _holdKeyDir   = null;  // 'left' | 'right' | null
let _holdKeyStart = 0;
const HOLD_THRESHOLD_MS = 500;
let subtitlePanelOpen = false;
let audioPanelOpen = false;

// Stall watchdog — detects frozen streams and auto-reloads
let stallWatchdogTimer = null;
let stallLastTime = -1;
let stallCount = 0;
const STALL_CHECK_INTERVAL_MS = 2000;
const STALL_THRESHOLD_CHECKS = 5; // ~10 s of no progress


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
    epgData.clear();
    epgIdMap.clear();
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
                        epgIdMap.set(cid.toLowerCase(), cid);
                        if (nmM) epgIdMap.set(nmM[1].toLowerCase().trim(), cid);
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
                            if (!epgData.has(cid)) {
                                epgData.set(cid, []);
                                epgIdMap.set(cid.toLowerCase(), cid);
                            }
                            epgData.get(cid).push({ start: pStart, stop: pStop || 0, title: tiM ? unescapeXml(tiM[1].trim()) : '' });
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
        for (const progs of epgData.values()) {
            progs.sort((a, b) => a.start - b.start);
        }

        renderChannelList();
        updateNowNext();

        // Refresh Now/Next every minute as current programme advances
        if (epgRefreshTimer) clearInterval(epgRefreshTimer);
        epgRefreshTimer = setInterval(updateNowNext, 60000);

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
            ? formatTimeHHMM(nowProg.start) + '–' + formatTimeHHMM(nowProg.stop)
            : formatTimeHHMM(nowProg.start);
        html += `<div class="epg-row epg-now"><span class="epg-badge">NOW</span><span class="epg-title">${escapeHtml(nowProg.title)}</span><span class="epg-time">${timeStr}</span></div>`;
        html += `<div class="epg-progress-bar"><div class="epg-progress-fill" style="width:${pct.toFixed(1)}%"></div></div>`;
    }
    if (nextProg) {
        html += `<div class="epg-row epg-next"><span class="epg-badge epg-badge-next">NEXT</span><span class="epg-title epg-title-next">${escapeHtml(nextProg.title)}</span><span class="epg-time">${formatTimeHHMM(nextProg.start)}</span></div>`;
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
    epgData.clear();
    epgIdMap.clear();
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
        currentGroup = 'favorites';
        currentPlaylistType = 'm3u';
        extractGroups();
        startPage.classList.add('hidden');
        mainApp.style.display = 'flex';
        renderChannelList();
        statusArea.innerText = `✅ ${channels.length.toLocaleString()} channels`;
        if (channels.length) setTimeout(() => {
            const firstIdx = currentFilteredChannels.length ? getChannelIndex(currentFilteredChannels[0]) : 0;
            selectChannel(firstIdx);
        }, 500);
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
        currentGroup = 'favorites';
        currentPlaylistType = 'm3u';
        extractGroups();
        startPage.classList.add('hidden');
        mainApp.style.display = 'flex';
        renderChannelList();
        statusArea.innerText = `🎬 Demo: ${channels.length} channels`;
        if (channels.length) setTimeout(() => {
            const firstIdx = currentFilteredChannels.length ? getChannelIndex(currentFilteredChannels[0]) : 0;
            selectChannel(firstIdx);
        }, 500);
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
            displayName = group;
        }
        if (currentSearchQuery && group !== 'favorites' && group !== 'all' && displayName.toLowerCase().includes(currentSearchQuery.toLowerCase())) {
            displayName = highlightText(displayName, currentSearchQuery);
        }
        div.innerHTML = `<span class="group-folder">${folderIcon}</span><span>${displayName}</span>`;
        div.onclick = () => {
            currentGroup = group;
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
    if (currentPlaylistType === 'xtream') return;
    const total = filtered.length;
    const info = currentSearchQuery ? ` (search: "${currentSearchQuery}")` : '';
    channelCountSpan.innerText = `${total} channels${info}`;
    if (!total) {
        channelListDiv.innerHTML = `<div style="padding:24px;text-align:center;">📭 No channels found</div>`;
        return;
    }

    // Remove old scroll listener
    if (currentScrollListener) {
        channelListDiv.removeEventListener('scroll', currentScrollListener);
    }
    // Clear rendered items map
    renderedItems.clear();

    // Row height depends on whether EPG data is available
    const ITEM_H = epgData.size > 0 ? 68 : 52;
    const ITEM_INNER = epgData.size > 0 ? 66 : 50;

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
            div.className = 'virtual-item' + (currentChannelIndex === originalIndex ? ' active' : '');
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
                renderChannelList(); // re-render to update stars
            };
            div.onclick = () => selectChannel(originalIndex);
            virtualContainer.appendChild(div);
            renderedItems.set(i, div);
        }
    };

    const onScroll = () => { requestAnimationFrame(renderVisible); };
    channelListDiv.addEventListener('scroll', onScroll);
    currentScrollListener = onScroll;
    channelListDiv.scrollTop = savedScrollTop;
    renderVisible();
}

// ----- Stall Watchdog -----
function startStallWatchdog() {
    stopStallWatchdog();
    stallLastTime = -1;
    stallCount = 0;
    stallWatchdogTimer = setInterval(function () {
        if (videoPlayer.paused || currentChannelIndex < 0) { stallCount = 0; return; }
        const t = videoPlayer.currentTime;
        if (t === stallLastTime && videoPlayer.readyState < 3) {
            stallCount++;
            if (stallCount >= STALL_THRESHOLD_CHECKS) {
                stallCount = 0;
                stallLastTime = -1;
                statusArea.innerText = '🔄 Buffering ...';
                reloadStream();
            }
        } else {
            stallCount = 0;
            stallLastTime = t;
        }
    }, STALL_CHECK_INTERVAL_MS);
}

function stopStallWatchdog() {
    if (stallWatchdogTimer) { clearInterval(stallWatchdogTimer); stallWatchdogTimer = null; }
}

// ----- Video Control -----
function selectChannel(index) {
    if (!channels[index]) return;
    stopStallWatchdog();
    if (currentChannelIndex >= 0 && currentChannelIndex !== index) lastChannelIndex = currentChannelIndex;
    currentChannelIndex = index;
    const ch = channels[index];
    playback.loadChannel(ch.url).catch(err => {
        statusArea.innerText = `⚠️ Failed to load stream: ${err.message || err}`;
    });
    channelInfoTag.innerText = `📺 ${ch.name}`;
    statusArea.innerText = `▶️ ${ch.name}`;
    playback.updateMediaSession(ch);
    if (epgMode) {
        // Don't rebuild the EPG grid — just update active row highlighting in-place
        for (const [, el] of epgRenderedRows) el.classList.remove('active');
        const filteredIdx = currentFilteredChannels.indexOf(ch);
        if (filteredIdx >= 0 && epgRenderedRows.has(filteredIdx)) epgRenderedRows.get(filteredIdx).classList.add('active');
        updateEPGInfoPanel(ch);
    } else {
        renderChannelList();
    }
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

    // Show playback panel only when fullscreen
    if (document.fullscreenElement) {
        const panel = document.getElementById('playbackPanel');
        if (panel) {
            panel.style.display = '';
            if (_pbPanelTimer) { clearTimeout(_pbPanelTimer); _pbPanelTimer = null; }
            _pbPanelTimer = setTimeout(() => {
                const sp = document.getElementById('settingsPanel');
                if (!sp || sp.style.display === 'none') {
                    const p = document.getElementById('playbackPanel');
                    if (p) p.style.display = 'none';
                }
            }, 3000);
        }
    }
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
    return; // track selection handled by settings panel
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
    return; // track selection handled by settings panel
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

function reloadStream() {
    if (currentChannelIndex >= 0 && channels[currentChannelIndex]) {
        playback.loadChannel(channels[currentChannelIndex].url).catch(() => {});
    }
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
    epgData.clear();
    epgIdMap.clear();
    epgLoading = false;
    currentEpgUrl = '';
    channels = [];
    currentFilteredChannels = [];
    groupsList = [];
    channelIndexMap.clear();
    _searchCache = { query: null, result: null };
    currentChannelIndex = -1;
    lastChannelIndex = -1;
    currentSearchQuery = '';
    selectedPlaylistId = null;

    // Reset app state
    epgMode = false;
    currentPlaylistType = null;
    isLoading = false;
    playback.destroy();
    playback.init(videoPlayer);
    // Move panels back to standardView container in case they were moved to EPG
    const videoArea = document.getElementById('videoArea');
    const pbPanel = document.getElementById('playbackPanel');
    const spPanel = document.getElementById('settingsPanel');
    if (videoArea && pbPanel && pbPanel.parentNode !== videoArea) videoArea.appendChild(pbPanel);
    if (videoArea && spPanel && spPanel.parentNode !== videoArea) videoArea.appendChild(spPanel);
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
function showEPGToast(msg, type = 'loading') {
    const toast = document.getElementById('epgToast');
    const titleEl = document.getElementById('epgToastTitle');
    const msgEl = document.getElementById('epgToastMsg');
    const spinner = document.getElementById('epgToastSpinner');
    if (!toast) return;
    if (_epgToastTimer) { clearTimeout(_epgToastTimer); _epgToastTimer = null; }
    const titles = { loading: 'EPG Loading', error: 'EPG Error', success: 'EPG Ready' };
    toast.className = `epg-toast epg-toast--${type} epg-toast--visible`;
    if (titleEl) titleEl.textContent = titles[type] || 'EPG';
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
const EPG_CH_W = 200;      // channel label column px
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
    // Move <video> and panels into the EPG video container
    const wrap = document.getElementById('epgVideoWrap');
    const pbPanel = document.getElementById('playbackPanel');
    const spPanel = document.getElementById('settingsPanel');
    if (wrap) {
        if (videoPlayer.parentNode !== wrap) wrap.appendChild(videoPlayer);
        if (pbPanel && pbPanel.parentNode !== wrap) wrap.appendChild(pbPanel);
        if (spPanel && spPanel.parentNode !== wrap) wrap.appendChild(spPanel);
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

function refreshCurrentView() {
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
        const descHtml = p.desc && wNum > 120
            ? `<span class="epg-prog-desc">${escapeHtml(p.desc)}</span>`
            : '';
        progsParts.push(`<div class="epg-prog-block${isNow ? ' now-playing' : ''}" style="left:${sx}px;width:${w}px">` +
            `<span class="epg-prog-title">${escapeHtml(p.title)}</span>${descHtml}</div>`);
        hadBlock = true;
    }
    if (!hadBlock) {
        const label = epgLoading ? 'Loading ...' : 'No data available ...';
        const cls = epgLoading ? 'epg-prog-placeholder loading' : 'epg-prog-placeholder';
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
    const TIME_STRIP_H = 34;
    const scrollTop = Math.max(0, scrollOuter.scrollTop - TIME_STRIP_H);
    const viewH = scrollOuter.clientHeight - TIME_STRIP_H;
    const startIdx = Math.max(0, Math.floor(scrollTop / EPG_ROW_H) - BUFFER);
    const endIdx = Math.min(currentFilteredChannels.length - 1,
        Math.ceil((scrollTop + viewH) / EPG_ROW_H) + BUFFER);
    for (const [idx, el] of epgRenderedRows) {
        if (idx < startIdx || idx > endIdx) { el.remove(); epgRenderedRows.delete(idx); }
    }
    for (let i = startIdx; i <= endIdx; i++) {
        if (epgRenderedRows.has(i)) continue;
        const row = buildEPGRow(i);
        body.appendChild(row);
        epgRenderedRows.set(i, row);
    }
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
        time.textContent = `${formatTime12(curr.start)} – ${formatTime12(curr.stop)}  (${formatDuration(minsLeft)})`;
        title.textContent = curr.title;
        desc.textContent = curr.desc || '';
        if (nowPlayingLabel) nowPlayingLabel.style.display = '';
    } else {
        const placeholder = epgLoading ? 'Loading ...' : 'No data available ...';
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
        nextTimeEl.textContent = `${formatTime12(next.start)} – ${formatTime12(next.stop)}`;
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

async function loadXtreamEPG(base, username, password) {
    if (epgLoading) return;
    epgLoading = true;
    epgData.clear();
    epgIdMap.clear();
    showEPGToast('Connecting to EPG …', 'loading');

    const u = encodeURIComponent(username);
    const pw = encodeURIComponent(password);
    const now2 = Date.now();
    const windowStart = now2 - 120000;
    const windowEnd = now2 + 6 * 3600000; // 6h ahead

    const BATCH = 200;
    const total = channels.length;

    try {
        for (let i = 0; i < total; i += BATCH) {
            const batch = channels.slice(i, i + BATCH).filter(ch => ch.streamId);
            if (!batch.length) continue;

            const results = await Promise.allSettled(
                batch.map(ch =>
                    fetch(`${base}/player_api.php?username=${u}&password=${pw}&action=get_short_epg&stream_id=${ch.streamId}&limit=48`)
                        .then(r => r.ok ? r.json() : null)
                        .catch(() => null)
                )
            );

            results.forEach((result, j) => {
                if (result.status !== 'fulfilled' || !result.value) return;
                const ch = batch[j];
                const listings = result.value.epg_listings;
                if (!Array.isArray(listings) || !listings.length) return;

                const progs = [];
                for (const ep of listings) {
                    const pStart = parseInt(ep.start_timestamp) * 1000;
                    const pStop = parseInt(ep.stop_timestamp) * 1000;
                    if (isNaN(pStart) || isNaN(pStop)) continue;
                    if (pStart > windowEnd || pStop < windowStart) continue;
                    const title = unescapeXml(decodeBase64Field(ep.title || '').trim());
                    const rawDesc = unescapeXml(decodeBase64Field(ep.description || '').trim());
                    const desc = rawDesc.replace(_RE_TS_INJECT, '').trim();
                    progs.push({ start: pStart, stop: pStop, title, desc });
                }
                if (progs.length) {
                    progs.sort((a, b) => a.start - b.start);
                    epgData.set(ch.tvgId, progs);
                    epgIdMap.set(ch.tvgId.toLowerCase(), ch.tvgId);
                }
            });

            const _batchMsg = `${Math.min(i + BATCH, total).toLocaleString()} / ${total.toLocaleString()} channels …`;
            statusArea.innerText = `📅 EPG: ${_batchMsg}`;
            showEPGToast(_batchMsg, 'loading');
            await new Promise(r => setTimeout(r, 80));
        }

        if (epgRefreshTimer) clearInterval(epgRefreshTimer);
        epgRefreshTimer = setInterval(() => { if (currentPlaylistType === 'xtream') renderEPGVisibleRows(); else updateNowNext(); }, 60000);
        enterEPGMode();
        const xtReadyMsg = `${epgData.size.toLocaleString()} channels loaded`;
        statusArea.innerText = `📅 EPG ready — ${xtReadyMsg}`;
        showEPGToast(xtReadyMsg, 'success');
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
    }
}

async function loadXtreamPlaylist(serverUrl, username, password) {
    if (isLoading) return;
    isLoading = true;
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
        statusArea.innerText = `✅ ${channels.length.toLocaleString()} channels`;
        if (channels.length) setTimeout(() => {
            const firstIdx = currentFilteredChannels.length ? getChannelIndex(currentFilteredChannels[0]) : 0;
            selectChannel(firstIdx);
        }, 500);

        // 5. Load EPG via per-channel JSON API (avoids downloading the full XMLTV)
        setTimeout(() => loadXtreamEPG(base, username, password), 1500);

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
    const timeStripH = 34;
    const rowTop = idx * EPG_ROW_H;
    const rowBottom = rowTop + EPG_ROW_H;
    const viewTop = scrollOuter.scrollTop + timeStripH;
    const viewBottom = scrollOuter.scrollTop + scrollOuter.clientHeight;
    if (rowTop < viewTop) {
        scrollOuter.scrollTop = rowTop - timeStripH;
        renderEPGVisibleRows();
    } else if (rowBottom > viewBottom) {
        scrollOuter.scrollTop = rowBottom - scrollOuter.clientHeight;
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
    const body = document.getElementById('epgBody');
    if (!body) return;
    const rows = body.querySelectorAll('.epg-row');
    if (rows[epgFocusedRowIdx]) rows[epgFocusedRowIdx].click();
}

function handleRemoteNav(e) {
    // Settings panel takes over all remote nav when open in fullscreen
    if (_settingsOpen && document.fullscreenElement) {
        _handleSettingsKey(e);
        return;
    }

    // Up/Down in fullscreen (non-EPG): adjust playback rate
    if (document.fullscreenElement && !epgMode && !_settingsOpen) {
        const isUp   = e.key === 'ArrowUp'   || e.keyCode === 38;
        const isDown = e.key === 'ArrowDown'  || e.keyCode === 40;
        if (isUp || isDown) {
            e.preventDefault();
            playback.changeRate(isUp ? 1 : -1);
            showTopControls();
            return;
        }
    }

    if (epgMode) {
        if (e.key === 'ArrowUp' || e.keyCode === 38) {
            e.preventDefault();
            epgFocusedRowIdx = Math.max(0, epgFocusedRowIdx - 1);
            updateEPGRowFocus();
        } else if (e.key === 'ArrowDown' || e.keyCode === 40) {
            e.preventDefault();
            epgFocusedRowIdx = Math.min(currentFilteredChannels.length - 1, epgFocusedRowIdx + 1);
            updateEPGRowFocus();
        } else if (e.key === 'ArrowLeft' || e.keyCode === 37) {
            e.preventDefault();
            scrollEPGTimeBy(-30);
        } else if (e.key === 'ArrowRight' || e.keyCode === 39) {
            e.preventDefault();
            scrollEPGTimeBy(30);
        } else if (e.key === 'Enter' || e.keyCode === 13) {
            e.preventDefault();
            selectEPGFocusedChannel();
        }
        return;
    }
    if (!startPage.classList.contains('hidden') && (!confirmDialog || confirmDialog.classList.contains('hidden'))) {
        if (e.key === 'Tab') { e.preventDefault(); switchTab(activeTab === 'm3u' ? 'xtream' : 'm3u'); }
        else if (e.key === 'ArrowUp' || e.keyCode === 38) { e.preventDefault(); currentFocusIndex--; focusElement(currentFocusIndex); }
        else if (e.key === 'ArrowDown' || e.keyCode === 40) { e.preventDefault(); currentFocusIndex++; focusElement(currentFocusIndex); }
        else if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); if (document.activeElement && document.activeElement.click) document.activeElement.click(); }
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
saveXtreamBtn.addEventListener('click', async () => {
    const server = xtreamServer.value.trim();
    const uname = xtreamUsername.value.trim();
    const pass = xtreamPassword.value.trim();
    const name = xtreamName.value.trim();
    if (!server || !uname || !pass) {
        updateStartStatus('Please enter server URL, username, and password', true, false, false, 0);
        return;
    }
    updateStartStatus('Verifying credentials …', false, false, true, 50);
    try {
        const base = server.replace(/\/$/, '');
        const resp = await fetch(`${base}/player_api.php?username=${encodeURIComponent(uname)}&password=${encodeURIComponent(pass)}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.user_info && data.user_info.auth === 0) throw new Error('Invalid credentials');
        addXtreamPlaylist(server, uname, pass, name);
    } catch (err) {
        updateStartStatus(`Login failed: ${err.message}`, true, false, false, 0);
        setTimeout(() => updateStartStatus('Ready', false, false, false, 0), 3000);
    }
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
toggleGroupsBtn.addEventListener('click', toggleGroupsColumn);
showGroupsBtn.addEventListener('click', toggleGroupsColumn);
const epgVideoWrap = document.getElementById('epgVideoWrap');
if (epgVideoWrap) epgVideoWrap.addEventListener('mousemove', showTopControls);
searchInput.addEventListener('input', () => {
    currentSearchQuery = searchInput.value;
    if (currentSearchQuery.trim()) currentGroup = 'all';
    renderGroupsList();
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(refreshCurrentView, 150);
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
videoPlayer.addEventListener('loadedmetadata', function () { updateSubtitleButton(); updateAudioButton(); });
videoArea.addEventListener('mousemove', showTopControls);
videoArea.addEventListener('click', function (e) {
    if (subtitlePanelOpen && !subtitlePanel.contains(e.target) && e.target !== subtitleBtn) toggleSubtitlePanel();
    if (audioPanelOpen && !audioPanel.contains(e.target) && e.target !== audioBtn) toggleAudioPanel();
});
videoPlayer.textTracks.addEventListener('addtrack', function () {
    updateSubtitleButton();
    if (subtitlePanelOpen) buildSubtitlePanel();
});
videoPlayer.textTracks.addEventListener('removetrack', function () { updateSubtitleButton(); });
if (videoPlayer.audioTracks) {
    videoPlayer.audioTracks.addEventListener('addtrack', function () {
        updateAudioButton();
        if (audioPanelOpen) buildAudioPanel();
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
    if (!document.fullscreenElement) return;
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
    if (!document.fullscreenElement) return;
    e.preventDefault();
    if (held >= LONG_PRESS_MS) {
        if (lastChannelIndex >= 0 && channels[lastChannelIndex]) selectChannel(lastChannelIndex);
    } else {
        if (videoPlayer.paused) videoPlayer.play().catch(e => console.log);
        else videoPlayer.pause();
        if (channels[currentChannelIndex]) playback.updateMediaSession(channels[currentChannelIndex]);
        showTopControls();
    }
});

// Hold ◀/▶ in fullscreen: hold-to-rewind / hold-to-FF
document.addEventListener('keydown', (e) => {
    if (!document.fullscreenElement) return;
    if (_settingsOpen) return;
    if (e.repeat) return; // ignore key-repeat; we drive timing ourselves
    const isLeft  = e.key === 'ArrowLeft'  || e.keyCode === 37;
    const isRight = e.key === 'ArrowRight' || e.keyCode === 39;
    if (!isLeft && !isRight) return;
    e.preventDefault();
    if (_holdKeyDir) return; // already tracking a hold
    _holdKeyDir   = isLeft ? 'left' : 'right';
    _holdKeyStart = Date.now();
    showTopControls();
    // After hold threshold, start trick play
    const capturedDir = _holdKeyDir;
    setTimeout(() => {
        if (_holdKeyDir === capturedDir) {
            playback.startHold(capturedDir);
        }
    }, HOLD_THRESHOLD_MS);
});

document.addEventListener('keyup', (e) => {
    const isLeft  = e.key === 'ArrowLeft'  || e.keyCode === 37;
    const isRight = e.key === 'ArrowRight' || e.keyCode === 39;
    if (!isLeft && !isRight) return;
    if (!document.fullscreenElement || _settingsOpen) { _holdKeyDir = null; return; }

    e.preventDefault();
    const held = Date.now() - _holdKeyStart;
    const dir  = _holdKeyDir;
    _holdKeyDir = null;

    if (playback.isHolding()) {
        // Was in trick play — stop and resume
        playback.stopHold();
    } else if (held < HOLD_THRESHOLD_MS) {
        // Short press — single ±3s seek
        playback.seekBy(dir === 'left' ? -3 : 3);
    }
    showTopControls();
    if (!document.fullscreenElement) {
        _holdKeyDir = null;
        if (_isHolding()) _stopHold();
    }
});

document.addEventListener('fullscreenchange', () => {
    showTopControls();
    if (!document.fullscreenElement) {
        _closeSettings();
        _holdKeyDir = null;
        playback.stopHold();
        const panel = document.getElementById('playbackPanel');
        if (panel) panel.style.display = 'none';
    }
});

// Back/Return button — context-dependent behavior (keyCode 461 on webOS)
document.addEventListener('keydown', (e) => {
    if (e.keyCode !== 461 && e.key !== 'GoBack') return;

    // Settings panel: close sub-list first, then panel
    if (_settingsOpen) {
        e.preventDefault();
        if (_settingsFocus === 'subopts') {
            _settingsFocus = 'categories';
            _settingsOptIdx = 0;
            _renderSettingsCategories();
            if (_settingsStatsInterval) { clearInterval(_settingsStatsInterval); _settingsStatsInterval = null; }
        } else {
            _closeSettings();
        }
        return;
    }

    if (document.fullscreenElement) {
        e.preventDefault();
        document.exitFullscreen();
        return;
    }

    // Main app visible (not start page): confirm return to home
    if (mainApp && mainApp.style.display !== 'none') {
        e.preventDefault();
        showConfirmDialog('🏠 Return to Home', 'Return to the home screen?', goToHomeScreen);
        return;
    }

    // Start page: show platform exit prompt
    if (typeof webOS !== 'undefined' && webOS.platformBack) webOS.platformBack();
}, true);

// ── Settings Panel State ─────────────────────────────────────────
let _settingsOpen = false;
let _settingsFocus = 'categories'; // 'categories' | 'subopts'
let _settingsCatIdx = 0;           // 0–4
let _settingsOptIdx = 0;           // index in current sub-list
let _settingsStatsInterval = null;
const SETTINGS_CATS = ['audio', 'subtitles', 'quality', 'speed', 'info'];

function _openSettings() {
    _settingsOpen = true;
    _settingsFocus = 'categories';
    _settingsCatIdx = 0;
    _settingsOptIdx = 0;
    const sp = document.getElementById('settingsPanel');
    if (sp) sp.style.display = '';
    _renderSettingsCategories();
    _clearSettingsSubopts();
    // Keep playback panel visible while settings open
    if (_pbPanelTimer) { clearTimeout(_pbPanelTimer); _pbPanelTimer = null; }
}

function _closeSettings() {
    _settingsOpen = false;
    const sp = document.getElementById('settingsPanel');
    if (sp) sp.style.display = 'none';
    if (_settingsStatsInterval) { clearInterval(_settingsStatsInterval); _settingsStatsInterval = null; }
}

function _renderSettingsCategories() {
    const cats = document.querySelectorAll('#spCategories .sp-cat');
    cats.forEach((el, i) => {
        el.classList.toggle('active', false);
        el.classList.toggle('focused', i === _settingsCatIdx);
    });
}

function _clearSettingsSubopts() {
    const sub = document.getElementById('spSubopts');
    if (sub) sub.innerHTML = '<span style="color:#333;font-size:0.75rem;padding:14px;display:block;">Select a category</span>';
}

function _enterSettingsSubopts() {
    _settingsFocus = 'subopts';
    _settingsOptIdx = 0;
    const cat = SETTINGS_CATS[_settingsCatIdx];
    if (cat === 'audio')     _buildAudioSublist();
    if (cat === 'subtitles') _buildSubtitleSublist();
    if (cat === 'quality')   _buildQualitySublist();
    if (cat === 'speed')     _buildSpeedSublist();
    if (cat === 'info')      _buildStreamInfoSublist();
    // Mark active category
    document.querySelectorAll('#spCategories .sp-cat').forEach((el, i) => {
        el.classList.toggle('active', i === _settingsCatIdx);
        el.classList.toggle('focused', false);
    });
}

function _buildTrackSublist(header, items, onSelect) {
    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    sub.innerHTML = '';
    const h = document.createElement('span');
    h.className = 'sp-subheader';
    h.textContent = header;
    sub.appendChild(h);
    items.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'sp-opt' + (item.active ? ' active' : '') + (i === _settingsOptIdx ? ' focused' : '');
        div.innerHTML = `<span>${escapeHtml(item.label)}</span><span class="sp-check">${item.active ? '✓' : ''}</span>`;
        div.addEventListener('click', () => { onSelect(item); _enterSettingsSubopts(); });
        sub.appendChild(div);
    });
}

function _buildAudioSublist() {
    const { audio } = playback.getTrackLists();
    _buildTrackSublist('Audio Track', audio, item => playback.setAudioTrack(item.id));
}

function _buildSubtitleSublist() {
    const { subtitles } = playback.getTrackLists();
    _buildTrackSublist('Subtitle Track', subtitles, item => playback.setSubtitleTrack(item.id));
}

function _buildQualitySublist() {
    const { quality } = playback.getTrackLists();
    _buildTrackSublist('Video Quality', quality, item => playback.setQuality(item.id));
}

function _updateSettingsOptFocus() {
    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    const cat = SETTINGS_CATS[_settingsCatIdx];
    if (cat === 'speed') {
        sub.querySelectorAll('.sp-chip').forEach((el, i) => el.classList.toggle('focused', i === _settingsOptIdx));
    } else if (cat === 'info') {
        // info is read-only, no focus update needed
    } else {
        sub.querySelectorAll('.sp-opt').forEach((el, i) => el.classList.toggle('focused', i === _settingsOptIdx));
    }
}

function _selectCurrentSettingsOpt() {
    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    const cat = SETTINGS_CATS[_settingsCatIdx];
    if (cat === 'speed') {
        const chips = sub.querySelectorAll('.sp-chip');
        if (chips[_settingsOptIdx]) chips[_settingsOptIdx].click();
        return;
    }
    const opts = sub.querySelectorAll('.sp-opt');
    if (opts[_settingsOptIdx]) opts[_settingsOptIdx].click();
}

function _buildSpeedSublist() {
    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    sub.innerHTML = '';
    const h = document.createElement('span');
    h.className = 'sp-subheader';
    h.textContent = 'Playback Speed';
    sub.appendChild(h);
    const wrap = document.createElement('div');
    wrap.className = 'sp-speeds';
    const rates = playback.getPlaybackRates();
    const currentIdx = playback.getRateIndex();
    rates.forEach((rate, i) => {
        const chip = document.createElement('div');
        chip.className = 'sp-chip' + (i === currentIdx ? ' active' : '') + (i === _settingsOptIdx ? ' focused' : '');
        chip.textContent = rate + '×';
        chip.addEventListener('click', () => {
            playback.setRate(rate);
            _buildSpeedSublist(); // refresh to show new active chip
        });
        wrap.appendChild(chip);
    });
    sub.appendChild(wrap);
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:4px 14px;font-size:0.68rem;color:#444;';
    hint.textContent = '▲/▼ also changes speed when not in settings';
    sub.appendChild(hint);
}

function _buildStreamInfoSublist() {
    if (_settingsStatsInterval) clearInterval(_settingsStatsInterval);
    _renderStreamInfo();
    _settingsStatsInterval = setInterval(_renderStreamInfo, 1000);
}

function _renderStreamInfo() {
    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    const s = playback.getStats();
    if (!s) {
        sub.innerHTML = '<span style="color:#555;padding:14px;display:block;font-size:0.75rem;">No stream loaded</span>';
        return;
    }

    function row(key, val, cls) {
        return `<div class="si-row-sp"><span class="si-key-sp">${escapeHtml(key)}</span><span class="si-val-sp ${cls || ''}">${escapeHtml(String(val))}</span></div>`;
    }
    function section(title, rows) {
        return `<div class="si-section-sp"><span class="si-label-sp">${escapeHtml(title)}</span>${rows}</div>`;
    }
    function divider() { return '<div class="si-divider-sp"></div>'; }
    function valCls(n) { return Number(n) === 0 ? 'good' : 'warn'; }

    const res = s.width && s.height ? `${s.width} × ${s.height}` : '—';
    sub.innerHTML =
        section('Video',
            row('Resolution', res) +
            row('Frame Rate', s.frameRate) +
            row('Codec', s.videoCodec) +
            row('Bitrate', s.bandwidth)
        ) +
        divider() +
        section('Audio',
            row('Codec', s.audioCodec)
        ) +
        divider() +
        section('Network',
            row('Est. Bandwidth', s.estimatedBandwidth, 'good') +
            row('Live Latency', s.liveLatency) +
            row('Buffer Ahead', s.bufferAhead)
        ) +
        divider() +
        section('Playback',
            row('Dropped Frames', s.droppedFrames, valCls(s.droppedFrames)) +
            row('Corrupted', s.corruptedFrames, valCls(s.corruptedFrames)) +
            row('Load Time', s.loadLatency)
        ) +
        divider() +
        section('Player',
            row('Engine', playback.isActive() ? 'Shaka v5.1.6' : 'Native (Shaka unavailable)', playback.isActive() ? 'good' : 'warn')
        );
}

function _handleSettingsKey(e) {
    const key = e.key;
    const isUp    = key === 'ArrowUp'    || e.keyCode === 38;
    const isDown  = key === 'ArrowDown'  || e.keyCode === 40;
    const isLeft  = key === 'ArrowLeft'  || e.keyCode === 37;
    const isRight = key === 'ArrowRight' || e.keyCode === 39;
    const isEnter = key === 'Enter'      || e.keyCode === 13;

    e.preventDefault();

    if (_settingsFocus === 'categories') {
        const catCount = SETTINGS_CATS.length;
        if (isUp)    { _settingsCatIdx = Math.max(0, _settingsCatIdx - 1); _renderSettingsCategories(); }
        if (isDown)  { _settingsCatIdx = Math.min(catCount - 1, _settingsCatIdx + 1); _renderSettingsCategories(); }
        if (isRight || isEnter) { _enterSettingsSubopts(); }
        if (isLeft)   { _closeSettings(); }
        return;
    }

    // focus === 'subopts'
    const cat = SETTINGS_CATS[_settingsCatIdx];
    if (isLeft) {
        _settingsFocus = 'categories';
        _settingsOptIdx = 0;
        _renderSettingsCategories();
        if (_settingsStatsInterval) { clearInterval(_settingsStatsInterval); _settingsStatsInterval = null; }
        return;
    }
    if (cat === 'info') return; // read-only, no selection

    const sub = document.getElementById('spSubopts');
    if (!sub) return;
    const isSpeed = cat === 'speed';
    const items = isSpeed ? sub.querySelectorAll('.sp-chip') : sub.querySelectorAll('.sp-opt');
    const count = items.length;
    if (count === 0) return;

    if (isUp || (isSpeed && isLeft)) {
        _settingsOptIdx = Math.max(0, _settingsOptIdx - 1);
        _updateSettingsOptFocus();
    }
    if (isDown || (isSpeed && isRight)) {
        _settingsOptIdx = Math.min(count - 1, _settingsOptIdx + 1);
        _updateSettingsOptFocus();
    }
    if (isEnter) { _selectCurrentSettingsOpt(); }
}

// ----- Initialization -----
playback.init(videoPlayer).then(() => {
    const engine = playback.isActive() ? 'Shaka v5.1.6' : 'Native player (Shaka unavailable)';
    statusArea.innerText = engine;
    setTimeout(() => { if (statusArea.innerText === engine) statusArea.innerText = ''; }, 3000);
});

// Seek bar update — fires every 500ms while fullscreen
setInterval(() => {
    if (document.fullscreenElement) playback.updateSeekBar();
}, 500);

const pbLiveBtn = document.getElementById('pbLiveBtn');
if (pbLiveBtn) pbLiveBtn.addEventListener('click', () => { playback.goToLive(); showTopControls(); });

const pbGearBtn = document.getElementById('pbGearBtn');
if (pbGearBtn) pbGearBtn.addEventListener('click', () => { _openSettings(); });
const epgGearBtn = document.getElementById('epgGearBtn');
if (epgGearBtn) epgGearBtn.addEventListener('click', () => { _openSettings(); });
// Audio/Subtitle buttons are superseded by the settings panel
if (typeof audioBtn !== 'undefined' && audioBtn) audioBtn.style.display = 'none';
if (typeof subtitleBtn !== 'undefined' && subtitleBtn) subtitleBtn.style.display = 'none';
const savedFavs = localStorage.getItem('iptv_favorites');
if (savedFavs) try { favoriteIds = new Set(JSON.parse(savedFavs)); } catch (e) { }
loadSavedPlaylists();
const lastUrl = localStorage.getItem('last_m3u_url');
if (lastUrl) newM3uUrl.value = lastUrl;
// Force a channel list refresh to show favorites
if (currentGroup === 'favorites') refreshCurrentView();
setTimeout(() => { updateFocusableElements(); focusElement(0); }, 500);