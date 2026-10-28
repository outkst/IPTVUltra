/**
 * @fileoverview Saved playlists and remote navigation on the start page.
 */

// ----- Saved Playlists Management -----
function loadSavedPlaylists() {
  const saved = localStorage.getItem('iptv_playlists');
  if (saved) try {
      savedPlaylists = JSON.parse(saved);
    } catch (e) {
    }
  renderSavedPlaylists();
}
function savePlaylistsToStorage() {
  localStorage.setItem('iptv_playlists', JSON.stringify(savedPlaylists));
  renderSavedPlaylists();
}
function addPlaylist(url, name, epgUrl) {
  if (!url) return;
  const existing = savedPlaylists.find(p => p.url === url);
  if (existing) {
    existing.name = name || existing.name;
    existing.epgUrl = epgUrl !== undefined ? epgUrl : (existing.epgUrl || '');
    savePlaylistsToStorage();
    updateStartStatus(
        `Playlist "${existing.name}" updated!`, false, true, false, 0);
  } else {
    savedPlaylists.push(
        {name: name || url.substring(0, 40), url, epgUrl: epgUrl || ''});
    savePlaylistsToStorage();
    updateStartStatus(`Playlist saved!`, false, true, false, 0);
  }
  setTimeout(() => updateStartStatus('Ready', false, false, false, 0), 2000);
  newM3uUrl.value = '';
  newM3uName.value = '';
  updateFocusableElements();
  focusElement(0);
}
function removePlaylist(idx) {
  savedPlaylists.splice(idx, 1);
  savePlaylistsToStorage();
  if (selectedPlaylistId === idx) {
    selectedPlaylistId = null;
    setLoadSelectedButtonEnabled(false);
  }
  updateFocusableElements();
  focusElement(0);
}
function clearAllPlaylists() {
  savedPlaylists = [];
  selectedPlaylistId = null;
  savePlaylistsToStorage();
  setLoadSelectedButtonEnabled(false);
  updateFocusableElements();
  focusElement(0);
  updateStartStatus('All playlists cleared', false, true, false, 0);
  setTimeout(() => updateStartStatus('Ready', false, false, false, 0), 2000);
}
function renderSavedPlaylists() {
  const container = document.getElementById('savedSourcesList');
  if (!container) return;
  if (!savedPlaylists.length) {
    container.innerHTML =
        '<div class="empty-saved">No saved playlists yet. Add one below!</div>';
    updateFocusableElements();
    return;
  }
  container.innerHTML = '';
  savedPlaylists.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = 'saved-item';
    div.onclick = () => {
      document.querySelectorAll('.saved-item')
          .forEach(i => i.style.background = '#1e2028');
      div.style.background = '#2a3a70';
      selectedPlaylistId = idx;
      setLoadSelectedButtonEnabled(true);
      if (p.type === 'xtream') {
        switchTab('xtream');
        xtreamServer.value = p.url;
        xtreamUsername.value = p.username || '';
        xtreamPassword.value = p.password || '';
        xtreamEpgUrl.value = p.epgUrl || '';
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
      try {
        displayUrl = `🔑 ${p.username}@${new URL(p.url).host}`;
      } catch {
        displayUrl = `🔑 ${p.username}@${p.url}`;
      }
    } else {
      displayUrl = p.url.substring(0, 54) + (p.url.length > 54 ? '…' : '');
    }
    if (p.epgUrl)
      subLine =
          `<div class="saved-epg">📅 ${escapeHtml(p.epgUrl.substring(0, 50))}${
              p.epgUrl.length > 50 ? '…' : ''}</div>`;
    div.innerHTML = `<div class="saved-info"><div class="saved-name">${
        escapeHtml(p.name)}</div><div class="saved-url">${
        escapeHtml(displayUrl)}</div>${subLine}</div>
            <div class="saved-actions"><button class="edit-saved" onclick="event.stopPropagation(); editPlaylist(${
        idx});">✏️</button>
            <button class="delete-saved" onclick="event.stopPropagation(); removePlaylist(${
        idx});">✕</button></div>`;
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
    document.querySelectorAll('.saved-item')
        .forEach(el => focusableElements.push(el));
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
      if (xtreamEpgUrl) focusableElements.push(xtreamEpgUrl);
      if (xtreamName) focusableElements.push(xtreamName);
      if (saveXtreamBtn) focusableElements.push(saveXtreamBtn);
    }
    if (loadSelectedBtn && !loadSelectedBtn.disabled)
      focusableElements.push(loadSelectedBtn);
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
  if (el) {
    el.focus();
    el.scrollIntoView({block: 'nearest'});
  }
}
