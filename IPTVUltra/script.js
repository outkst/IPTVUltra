// ---------- App State ----------
let channels = [];
let currentChannelIndex = -1;
let favoriteIds = new Set();
let currentGroup = 'favorites';
let savedPlaylists = [];
let selectedPlaylistId = null;
let groupsList = [];
let groupsColumnVisible = true;
let isLoading = false;
let currentSearchQuery = '';

let activeTab = 'm3u'; // 'm3u' | 'xtream'

// EPG state
let epgData = new Map();      // channelId -> [{start, stop, title, desc}]
let epgIdMap = new Map();     // lowercase string -> actual channelId key in epgData
let epgLoading = false;
let currentEpgUrl = '';
let epgRefreshTimer = null;

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

function resolveEpgId(tvgId) {
    if (!tvgId) return null;
    if (epgData.has(tvgId)) return tvgId;
    return epgIdMap.get(tvgId.toLowerCase()) || null;
}

function getCurrentProgramme(tvgId) {
    const id = resolveEpgId(tvgId);
    if (!id) return null;
    const now = Date.now();
    const progs = epgData.get(id);
    if (!progs) return null;
    for (const p of progs) {
        if (p.start <= now && p.stop > now) return p;
    }
    return null;
}

function getNextProgramme(tvgId) {
    const id = resolveEpgId(tvgId);
    if (!id) return null;
    const now = Date.now();
    const progs = epgData.get(id);
    if (!progs) return null;
    let next = null;
    for (const p of progs) {
        if (p.start > now && (!next || p.start < next.start)) next = p;
    }
    return next;
}

async function loadEPG(url) {
    if (epgLoading) return;
    epgLoading = true;
    epgData.clear();
    epgIdMap.clear();
    currentEpgUrl = url;

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let programmeCount = 0;
    let bytesRead = 0;
    const now = Date.now();
    const windowStart = now - 120000;   // keep up to 2min ago (in-progress shows)
    const windowEnd = now + 10800000;  // up to 3h ahead

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytesRead += value.byteLength;
            buffer += decoder.decode(value, { stream: true });

            // Extract complete <channel> elements (always before <programme> in XMLTV)
            let idx;
            while ((idx = buffer.indexOf('</channel>')) !== -1) {
                const s = buffer.lastIndexOf('<channel', idx);
                if (s !== -1) {
                    const xml = buffer.substring(s, idx + 10);
                    const idM = xml.match(/id="([^"]*)"/);
                    const nmM = xml.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
                    if (idM) {
                        const cid = idM[1];
                        epgIdMap.set(cid.toLowerCase(), cid);
                        if (nmM) epgIdMap.set(nmM[1].toLowerCase().trim(), cid);
                    }
                }
                buffer = buffer.substring(idx + 10);
            }

            // Extract complete <programme> elements
            while ((idx = buffer.indexOf('</programme>')) !== -1) {
                const s = buffer.lastIndexOf('<programme', idx);
                if (s !== -1) {
                    const xml = buffer.substring(s, idx + 12);
                    const chM = xml.match(/channel="([^"]*)"/);
                    const stM = xml.match(/start="([^"]*)"/);
                    const spM = xml.match(/stop="([^"]*)"/);
                    const tiM = xml.match(/<title[^>]*>([^<]*)<\/title>/);
                    if (chM && stM) {
                        const pStart = parseXMLTVDate(stM[1]);
                        const pStop = spM ? parseXMLTVDate(spM[1]) : null;
                        // Only keep programmes within the time window
                        if (pStart !== null && pStart <= windowEnd && (pStop === null || pStop >= windowStart)) {
                            const cid = chM[1];
                            if (!epgData.has(cid)) {
                                epgData.set(cid, []);
                                epgIdMap.set(cid.toLowerCase(), cid);
                            }
                            const arr = epgData.get(cid);
                            arr.push({
                                start: pStart,
                                stop: pStop || 0,
                                title: tiM ? tiM[1].trim() : ''
                            });
                            // Cap at 4 entries per channel; drop oldest past entries first
                            if (arr.length > 4) {
                                const now2 = Date.now();
                                const pastIdx = arr.findIndex(p => p.stop > now2);
                                if (pastIdx > 0) arr.splice(0, pastIdx);
                                if (arr.length > 4) arr.splice(0, arr.length - 4);
                            }
                            programmeCount++;
                        }
                    }
                }
                buffer = buffer.substring(idx + 12);
            }

            // Safety trim: if buffer grew past 1 MB with no complete element, keep only the
            // last partial open tag so we don't accumulate a runaway blob
            if (buffer.length > 1048576) {
                const trim = Math.max(buffer.lastIndexOf('<programme'), buffer.lastIndexOf('<channel'));
                buffer = trim > 0 ? buffer.substring(trim) : '';
            }

            // Yield every 256 programmes to keep UI responsive and let GC run
            if (programmeCount > 0 && programmeCount % 256 === 0) {
                statusArea.innerText = `📅 EPG: ${(bytesRead / 1048576).toFixed(1)} MB — ${programmeCount.toLocaleString()} programmes…`;
                await new Promise(r => setTimeout(r, 0));
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
        statusArea.innerText = `📅 EPG ready — ${epgData.size.toLocaleString()} channels, ${programmeCount.toLocaleString()} programmes (${mb} MB)`;
        setTimeout(() => {
            if (currentChannelIndex >= 0) statusArea.innerText = `▶️ ${channels[currentChannelIndex].name}`;
        }, 4000);

    } catch (err) {
        statusArea.innerText = `⚠️ EPG failed: ${err.message}`;
        setTimeout(() => {
            if (currentChannelIndex >= 0) statusArea.innerText = `▶️ ${channels[currentChannelIndex].name}`;
        }, 3000);
    } finally {
        epgLoading = false;
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
    epgData.clear();
    epgIdMap.clear();
    currentEpgUrl = epgUrl;
    setLoadSelectedButtonEnabled(false);
    updateStartStatus(`Fetching playlist...`, false, false, true, 0);
    showLoading(true, 'Fetching playlist...');
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let content = await response.text();
        updateStartStatus(`Downloaded ${(content.length / 1024 / 1024).toFixed(1)} MB, parsing...`, false, false, true, 20);
        const parsed = await parseM3UStreaming(content);
        content = null; // free memory
        if (!parsed.length) throw new Error('No channels found');
        channels = parsed;
        localStorage.setItem('last_m3u_url', url);
        updateStartStatus(`Loaded ${channels.length.toLocaleString()} channels!`, false, true, false, 100);
        currentSearchQuery = '';
        searchInput.value = '';
        currentGroup = 'favorites';
        extractGroups();
        startPage.classList.add('hidden');
        mainApp.style.display = 'flex';
        renderChannelList();
        statusArea.innerText = `✅ ${channels.length.toLocaleString()} channels`;
        if (channels.length) setTimeout(() => {
            const firstIdx = currentFilteredChannels.length ? channels.indexOf(currentFilteredChannels[0]) : 0;
            selectChannel(firstIdx);
        }, 500);
        // Start EPG load in background after playlist is ready
        if (epgUrl) setTimeout(() => loadEPG(epgUrl), 1500);
    } catch (err) {
        updateStartStatus(`Error: ${err.message}`, true, false, false, 0);
        setLoadSelectedButtonEnabled(true);
    } finally {
        isLoading = false;
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
        updateStartStatus(`Demo loaded: ${channels.length} channels`, false, true, false, 100);
        currentSearchQuery = '';
        searchInput.value = '';
        currentGroup = 'favorites';
        extractGroups();
        startPage.classList.add('hidden');
        mainApp.style.display = 'flex';
        renderChannelList();
        statusArea.innerText = `🎬 Demo: ${channels.length} channels`;
        if (channels.length) setTimeout(() => {
            const firstIdx = currentFilteredChannels.length ? channels.indexOf(currentFilteredChannels[0]) : 0;
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
    groupsListDiv.innerHTML = '';
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
            renderChannelList();
        };
        groupsListDiv.appendChild(div);
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
    const sorted = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
    return sorted.map(s => channels[s.idx]);
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

    // Setup virtual container
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
        const endIdx = Math.min(total, startIdx + Math.ceil(containerHeight / ITEM_H) + 2);
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
            const originalIndex = channels.findIndex(c => c === ch);
            const fav = favoriteIds.has(ch.tvgId || `idx_${originalIndex}`);
            const div = document.createElement('div');
            div.className = 'virtual-item' + (currentChannelIndex === originalIndex ? ' active' : '');
            div.style.top = `${i * ITEM_H}px`;
            div.style.height = `${ITEM_INNER}px`;
            // Build logo HTML
            let logoHtml = '';
            if (ch.tvgLogo && ch.tvgLogo.trim()) {
                logoHtml = `
                    <img class="logo-img" src="${escapeHtml(ch.tvgLogo)}" loading="lazy" onerror="this.style.display='none'">
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
    renderVisible();
}

// ----- Video Control -----
function selectChannel(index) {
    if (!channels[index]) return;
    currentChannelIndex = index;
    const ch = channels[index];
    videoPlayer.pause();
    videoPlayer.src = ch.url;
    videoPlayer.load();
    videoPlayer.play().catch(e => console.log);
    channelInfoTag.innerText = `📺 ${ch.name}`;
    statusArea.innerText = `▶️ ${ch.name}`;
    renderChannelList();
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
    if (controlsTimeout) clearTimeout(controlsTimeout);
    controlsTimeout = setTimeout(() => c.classList.remove('visible'), 3000);
}

function resolveLanguage(code) {
    if (!code) return null;
    const short = code.toLowerCase().substring(0, 2);
    return LANG_NAMES[short] || code;
}

function showStreamInfo() {
    const w = videoPlayer.videoWidth, h = videoPlayer.videoHeight;

    // Video resolution
    let resText = (w && h) ? (w + '×' + h) : 'Loading…';
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
    if (infoHideTimeout) clearTimeout(infoHideTimeout);
    infoHideTimeout = setTimeout(function () { streamInfoOverlay.style.opacity = '0'; }, 3000);
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

function reloadStream() {
    if (currentChannelIndex < 0) return;
    const url = channels[currentChannelIndex].url;
    const wasPlaying = !videoPlayer.paused;
    videoPlayer.pause();
    videoPlayer.src = url;
    videoPlayer.load();
    if (wasPlaying) videoPlayer.play().catch(e => console.log);
    statusArea.innerText = '🔄 Reloading...';
    setTimeout(() => statusArea.innerText = `▶️ ${channels[currentChannelIndex].name}`, 2000);
    showTopControls();
}

function goToHomeScreen() {
    if (epgRefreshTimer) { clearInterval(epgRefreshTimer); epgRefreshTimer = null; }
    videoPlayer.pause();
    startPage.classList.remove('hidden');
    mainApp.style.display = 'none';
    renderSavedPlaylists();
    statusArea.innerText = '✨ Ready';
    setLoadSelectedButtonEnabled(true);
    isLoading = false;
    showLoading(false);
    updateStartStatus('Ready', false, false, false, 0);
    setTimeout(() => { updateFocusableElements(); focusElement(0); }, 100);
}

function toggleGroupsColumn() {
    groupsColumnVisible = !groupsColumnVisible;
    groupsColumn.classList.toggle('collapsed', !groupsColumnVisible);
    toggleGroupsBtn.innerHTML = groupsColumnVisible ? '◀ Hide' : '▶ Show';
    showGroupsBtn.style.display = groupsColumnVisible ? 'none' : 'block';
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

async function loadXtreamPlaylist(serverUrl, username, password) {
    if (isLoading) return;
    isLoading = true;
    epgData.clear();
    epgIdMap.clear();
    setLoadSelectedButtonEnabled(false);
    updateStartStatus('Connecting to Xtream API…', false, false, true, 0);
    showLoading(true, 'Connecting to Xtream API…');

    const base = serverUrl.replace(/\/$/, '');
    const u = encodeURIComponent(username);
    const pw = encodeURIComponent(password);

    try {
        // 1. Authenticate
        const authResp = await fetch(`${base}/player_api.php?username=${u}&password=${pw}`);
        if (!authResp.ok) throw new Error(`Auth HTTP ${authResp.status}`);
        const authData = await authResp.json();
        if (authData.user_info && authData.user_info.auth === 0) throw new Error('Invalid username or password');
        updateStartStatus('Authenticated! Loading categories…', false, false, true, 15);

        // 2. Categories (for group names)
        let catMap = {};
        try {
            const catResp = await fetch(`${base}/player_api.php?username=${u}&password=${pw}&action=get_live_categories`);
            if (catResp.ok) {
                const cats = await catResp.json();
                if (Array.isArray(cats)) cats.forEach(c => { catMap[String(c.category_id)] = c.category_name; });
            }
        } catch { /* categories are optional */ }
        updateStartStatus('Loading channel list…', false, false, true, 30);

        // 3. Live streams
        const streamsResp = await fetch(`${base}/player_api.php?username=${u}&password=${pw}&action=get_live_streams`);
        if (!streamsResp.ok) throw new Error(`Streams HTTP ${streamsResp.status}`);
        const streamsText = await streamsResp.text();
        updateStartStatus('Parsing channels…', false, false, true, 55);
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
                    url: `${base}/live/${username}/${password}/${s.stream_id}.m3u8`
                });
            }
            const pct = Math.min(90, 55 + Math.round((i / streams.length) * 35));
            updateStartStatus(`Parsed ${parsed.length.toLocaleString()} channels…`, false, false, true, pct);
            await new Promise(r => setTimeout(r, 5));
        }

        channels = parsed;
        localStorage.setItem('last_m3u_url', ''); // clear M3U cache; Xtream uses its own auth
        updateStartStatus(`Loaded ${channels.length.toLocaleString()} channels!`, false, true, false, 100);
        currentSearchQuery = '';
        searchInput.value = '';
        currentGroup = 'favorites';
        extractGroups();
        startPage.classList.add('hidden');
        mainApp.style.display = 'flex';
        renderChannelList();
        statusArea.innerText = `✅ ${channels.length.toLocaleString()} channels`;
        if (channels.length) setTimeout(() => {
            const firstIdx = currentFilteredChannels.length ? channels.indexOf(currentFilteredChannels[0]) : 0;
            selectChannel(firstIdx);
        }, 500);

        // 5. Start EPG in background from Xtream XMLTV endpoint
        const epgUrl = `${base}/xmltv.php?username=${u}&password=${pw}`;
        currentEpgUrl = epgUrl;
        setTimeout(() => loadEPG(epgUrl), 1500);

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
        if (tabM3u) focusableElements.push(tabM3u);
        if (tabXtream) focusableElements.push(tabXtream);
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
function handleRemoteNav(e) {
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
    updateStartStatus('Verifying credentials…', false, false, true, 50);
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
    confirmDialog.classList.remove('hidden');
    const yesHandler = () => { clearAllPlaylists(); confirmDialog.classList.add('hidden'); confirmYes.removeEventListener('click', yesHandler); confirmNo.removeEventListener('click', noHandler); };
    const noHandler = () => { confirmDialog.classList.add('hidden'); confirmYes.removeEventListener('click', yesHandler); confirmNo.removeEventListener('click', noHandler); };
    confirmYes.addEventListener('click', yesHandler);
    confirmNo.addEventListener('click', noHandler);
});
infoBtn.addEventListener('click', () => { showStreamInfo(); showTopControls(); });
reloadBtn.addEventListener('click', reloadStream);
homePageBtn.addEventListener('click', goToHomeScreen);
toggleGroupsBtn.addEventListener('click', toggleGroupsColumn);
showGroupsBtn.addEventListener('click', toggleGroupsColumn);
searchInput.addEventListener('input', () => { currentSearchQuery = searchInput.value; if (currentSearchQuery.trim()) currentGroup = 'all'; renderGroupsList(); renderChannelList(); });
clearSearchBtn.addEventListener('click', () => { currentSearchQuery = ''; searchInput.value = ''; searchInput.focus(); renderGroupsList(); renderChannelList(); });
subtitleBtn.addEventListener('click', () => { toggleSubtitlePanel(); showTopControls(); });
audioBtn.addEventListener('click', () => { toggleAudioPanel(); showTopControls(); });
videoPlayer.addEventListener('loadedmetadata', function () { showStreamInfo(); updateSubtitleButton(); updateAudioButton(); });
videoPlayer.addEventListener('resize', showStreamInfo);
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
document.addEventListener('fullscreenchange', () => {
    showTopControls();
});


// ----- Initialization -----
const savedFavs = localStorage.getItem('iptv_favorites');
if (savedFavs) try { favoriteIds = new Set(JSON.parse(savedFavs)); } catch (e) { }
loadSavedPlaylists();
const lastUrl = localStorage.getItem('last_m3u_url');
if (lastUrl) newM3uUrl.value = lastUrl;
// Force a channel list refresh to show favorites
if (currentGroup === 'favorites') renderChannelList();
setTimeout(() => { updateFocusableElements(); focusElement(0); }, 500);