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

let infoHideTimeout = null;
let controlsTimeout = null;

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
async function loadM3UFromUrl(url) {
    if (isLoading) return;
    isLoading = true;
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
    // Setup virtual container
    channelListDiv.innerHTML = '';
    channelListDiv.style.position = 'relative';
    const virtualContainer = document.createElement('div');
    virtualContainer.className = 'channel-list-virtual';
    virtualContainer.style.height = `${total * 52}px`; // approximate row height
    channelListDiv.appendChild(virtualContainer);

    // Function to render visible items
    const renderVisible = () => {
        const scrollTop = channelListDiv.scrollTop;
        const containerHeight = channelListDiv.clientHeight;
        const startIdx = Math.floor(scrollTop / 52);
        const endIdx = Math.min(total, startIdx + Math.ceil(containerHeight / 52) + 2);
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
            div.style.top = `${i * 52}px`;
            div.style.height = '50px';
            // Build content efficiently
            let logoHtml = '';
            if (ch.tvgLogo && ch.tvgLogo.trim()) {
                logoHtml = `
                    <img class="logo-img" src="${escapeHtml(ch.tvgLogo)}" loading="lazy" onerror="this.style.display='none'">
                    <div class="logo-placeholder">📺</div>
                `;
            } else {
                logoHtml = `<div class="logo-placeholder">📺</div>`;
            }
            div.innerHTML = `
                <div class="channel-logo">${logoHtml}</div>
                <div class="channel-info"><span class="channel-num">${originalIndex + 1}</span><span class="channel-name">${escapeHtml(ch.name.length > 40 ? ch.name.substring(0, 37) + '...' : ch.name)}</span></div>
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
    showTopControls();
}

function showTopControls() {
    const c = document.getElementById('topControls');
    c.classList.add('visible');
    if (controlsTimeout) clearTimeout(controlsTimeout);
    controlsTimeout = setTimeout(() => c.classList.remove('visible'), 3000);
}

function showStreamInfo() {
    const w = videoPlayer.videoWidth, h = videoPlayer.videoHeight;
    if (!w) { streamInfoOverlay.innerText = '📊 Loading...'; streamInfoOverlay.style.opacity = '1'; setTimeout(() => streamInfoOverlay.style.opacity = '0', 3000); return; }
    let res = `${w}x${h}`;
    if (w >= 3840) res += ' (4K)';
    else if (w >= 1920) res += ' (1080p)';
    else if (w >= 1280) res += ' (720p)';
    let audio = 'Unknown';
    if (videoPlayer.audioTracks && videoPlayer.audioTracks.length) {
        const active = Array.from(videoPlayer.audioTracks).find(t => t.enabled);
        if (active) audio = active.label || active.language || 'AAC';
    }
    streamInfoOverlay.innerText = `📐 ${res}\n🔊 ${audio}`;
    streamInfoOverlay.style.opacity = '1';
    if (infoHideTimeout) clearTimeout(infoHideTimeout);
    infoHideTimeout = setTimeout(() => streamInfoOverlay.style.opacity = '0', 5000);
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


// ----- Saved Playlists Management -----
function loadSavedPlaylists() {
    const saved = localStorage.getItem('iptv_playlists');
    if (saved) try { savedPlaylists = JSON.parse(saved); } catch (e) { }
    renderSavedPlaylists();
}
function savePlaylistsToStorage() { localStorage.setItem('iptv_playlists', JSON.stringify(savedPlaylists)); renderSavedPlaylists(); }
function addPlaylist(url, name) {
    if (!url) return;
    const existing = savedPlaylists.find(p => p.url === url);
    if (existing) {
        existing.name = name || existing.name;
        savePlaylistsToStorage();
        updateStartStatus(`Playlist "${existing.name}" updated!`, false, true, false, 0);
    } else {
        savedPlaylists.push({ name: name || url.substring(0, 40), url });
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
    if (!savedPlaylists.length) { container.innerHTML = '<div class="empty-saved">No saved playlists yet. Add one below!</div>'; updateFocusableElements(); return; }
    container.innerHTML = '';
    savedPlaylists.forEach((p, idx) => {
        const div = document.createElement('div');
        div.className = 'saved-item';
        div.onclick = () => {
            document.querySelectorAll('.saved-item').forEach(i => i.style.background = '#1e2028');
            div.style.background = '#2a3a70';
            selectedPlaylistId = idx;
            setLoadSelectedButtonEnabled(true);
            newM3uUrl.value = p.url;
            newM3uName.value = p.name;
        };
        div.innerHTML = `<div class="saved-info"><div class="saved-name">${escapeHtml(p.name)}</div><div class="saved-url">${p.url.substring(0, 57)}${p.url.length > 57 ? '...' : ''}</div></div>
            <div class="saved-actions"><button class="edit-saved" onclick="event.stopPropagation(); document.getElementById('newM3uUrl').value='${escapeHtml(p.url)}'; document.getElementById('newM3uName').value='${escapeHtml(p.name)}';">✏️</button>
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
        if (newM3uUrl) focusableElements.push(newM3uUrl);
        if (newM3uName) focusableElements.push(newM3uName);
        if (saveNewBtn) focusableElements.push(saveNewBtn);
        if (loadSelectedBtn && !loadSelectedBtn.disabled) focusableElements.push(loadSelectedBtn);
        if (startDemoBtn) focusableElements.push(startDemoBtn);
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
        if (e.key === 'ArrowUp' || e.keyCode === 38) { e.preventDefault(); currentFocusIndex--; focusElement(currentFocusIndex); }
        else if (e.key === 'ArrowDown' || e.keyCode === 40) { e.preventDefault(); currentFocusIndex++; focusElement(currentFocusIndex); }
        else if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); if (document.activeElement && document.activeElement.click) document.activeElement.click(); }
    }
}

// ----- Event Listeners -----
saveNewBtn.addEventListener('click', () => {
    const url = newM3uUrl.value.trim();
    const name = newM3uName.value.trim();
    if (url) addPlaylist(url, name);
    else updateStartStatus('Please enter a valid URL', true, false, false, 0);
});
loadSelectedBtn.addEventListener('click', () => { if (!isLoading && selectedPlaylistId !== null && savedPlaylists[selectedPlaylistId]) loadM3UFromUrl(savedPlaylists[selectedPlaylistId].url); });
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
videoPlayer.addEventListener('loadedmetadata', showStreamInfo);
videoPlayer.addEventListener('resize', showStreamInfo);
videoArea.addEventListener('mousemove', showTopControls);
document.addEventListener('keydown', handleRemoteNav);
document.addEventListener('fullscreenchange', () => {
    const isFull = !!document.fullscreenElement;
    header.classList.toggle('hidden', isFull);
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