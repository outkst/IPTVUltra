/**
 * @fileoverview Groups, the categories and favorites manager, and the virtual
 * channel list.
 */

// ----- Groups & Channels -----
// Categories hidden by the user for this playlist (also dropped from All
// Channels and search)
let _hiddenGroups = new Set();
let _groupOrder = [
];  // user order for this playlist; groups not listed follow alphabetically
function allGroupNames() {
  const groups = new Set();
  for (const ch of channels)
    if (ch.group && ch.group.trim()) groups.add(ch.group.trim());
  return Array.from(groups);
}
function sortGroupNames(names) {
  const pos = new Map(_groupOrder.map((g, i) => [g, i]));
  return names.sort((a, b) => {
    const pa = pos.has(a) ? pos.get(a) : Infinity,
          pb = pos.has(b) ? pos.get(b) : Infinity;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}
function extractGroups() {
  const ps = _activePlaylistKey ? getPlaylistState(_activePlaylistKey) : null;
  _hiddenGroups = new Set((ps && ps.hiddenGroups) || []);
  _groupOrder = (ps && ps.groupOrder) || [];
  groupsList = ['favorites', 'all', 'recent'].concat(
      sortGroupNames(allGroupNames().filter(g => !_hiddenGroups.has(g))));
  renderGroupsList();
}
const PINNED_GROUPS = ['favorites', 'all', 'recent'];

// ----- Categories manager (hide / reorder, per playlist) and Favorites manager
// (reorder / remove) ----- The same overlay serves both: `catsMode` is 'cats'
// (group names) or 'favs' (favorite ids in the user's order)
let catsOpen = false, catsFocus = 0, _catsNames = [], catsMode = 'cats';
function openCatsManager(mode) {
  catsMode = mode === 'favs' ? 'favs' : 'cats';
  if (!_activePlaylistKey ||
      (catsMode === 'cats' && _activePlaylistKey === 'm:demo'))
    return;
  const ov = document.getElementById('catsOverlay');
  if (!ov) return;
  if (catsMode === 'favs') {
    _catsNames = [...favoriteIds].filter(
        id => _chansByFavId.has(id));  // favorites present in this playlist
    if (!_catsNames.length) return;
    catsFocus = 0;
  } else {
    _catsNames = sortGroupNames(allGroupNames());
    catsFocus = Math.max(0, _catsNames.indexOf(currentGroup));
  }
  const title = ov.querySelector('.settings-title');
  if (title)
    title.textContent =
        catsMode === 'favs' ? '⭐ Manage favorites' : '📁 Manage categories';
  const hint = ov.querySelector('.settings-hint');
  if (hint)
    hint.textContent = catsMode === 'favs' ?
        'OK remove / restore · ◀ ▶ or Red / Green move · Back close' :
        'OK hide / show · ◀ ▶ or Red / Green move · Back close';
  catsOpen = true;
  if (settingsOpen) closeSettings();
  ov.classList.remove('hidden');
  renderCats();
}
function closeCatsManager() {
  if (!catsOpen) return;
  catsOpen = false;
  const ov = document.getElementById('catsOverlay');
  if (ov) ov.classList.add('hidden');
  const list = document.getElementById('catsList');
  if (list) list.innerHTML = '';  // rows share .settings-row; leave none behind
  if (catsMode === 'favs') {
    refreshCurrentView();
    return;
  }  // favorites were saved as they changed
  // Apply once on close: group list, All Channels and search all follow the new
  // state
  extractGroups();
  validateCurrentGroup();
  refreshCurrentView();
}
function catsFavLabel(id) {
  const l = _chansByFavId.get(id) || [];
  return l.length ?
      (l.length > 1 ? `${l[0].name} (+${l.length - 1})` : l[0].name) :
      id;
}
function saveCatsState() {
  if (!_activePlaylistKey) return;
  const ps = getPlaylistState(_activePlaylistKey);
  ps.hiddenGroups = [..._hiddenGroups];
  ps.groupOrder = _groupOrder.slice();
  savePlaylistState();
}
function renderCats() {
  const list = document.getElementById('catsList');
  if (!list) return;
  list.innerHTML = '';
  const favs = catsMode === 'favs';
  _catsNames.forEach((g, i) => {
    const row = document.createElement('div');
    const off = favs ? !favoriteIds.has(g) : _hiddenGroups.has(g);
    row.className = 'settings-row cats-row' + (off ? ' cats-hidden' : '') +
        (i === catsFocus ? ' focused' : '');
    row.dataset.idx = i;
    const label = favs ? catsFavLabel(g) : g;
    const state = favs ? (off ? '✕ Removed' : '★ Favorite') :
                         (off ? '🚫 Hidden' : '👁 Shown');
    row.innerHTML = `<div class="settings-label"><div class="settings-name">${
        escapeHtml(
            label)}</div></div><div class="settings-value"><span class="settings-val">${
        state}</span></div>`;
    row.addEventListener('click', () => {
      catsFocus = i;
      catsToggleHidden();
    });
    list.appendChild(row);
  });
  const f = list.querySelector('.cats-row.focused');
  if (f) f.scrollIntoView({block: 'nearest'});
}
// Favorites belong to the playlist they were starred in (playlist state `favs`,
// in the user's order)
function saveFavorites() {
  if (!_activePlaylistKey) return;
  getPlaylistState(_activePlaylistKey).favs = [...favoriteIds];
  savePlaylistState();
}
// Providers write quality tags in superscript ("ᵁᴴᴰ ³⁸⁴⁰ᴾ", "⁴ᵏ", "⁸ᴷ", "ᶠᴴᴰ").
// Each run of superscript characters becomes its own plain word ("uhd 3840p"),
// split where letters meet digits so word boundaries still find the tag.
const SUPER_MAP = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁺': '+',
  '⁽': '(',
  '⁾': ')',
  'ᴬ': 'a',
  'ᴮ': 'b',
  'ᴰ': 'd',
  'ᴱ': 'e',
  'ᴳ': 'g',
  'ᴴ': 'h',
  'ᴵ': 'i',
  'ᴶ': 'j',
  'ᴷ': 'k',
  'ᴸ': 'l',
  'ᴹ': 'm',
  'ᴺ': 'n',
  'ᴼ': 'o',
  'ᴾ': 'p',
  'ᴿ': 'r',
  'ᵀ': 't',
  'ᵁ': 'u',
  'ⱽ': 'v',
  'ᵂ': 'w',
  'ᵃ': 'a',
  'ᵇ': 'b',
  'ᶜ': 'c',
  'ᵈ': 'd',
  'ᵉ': 'e',
  'ᶠ': 'f',
  'ᵍ': 'g',
  'ʰ': 'h',
  'ⁱ': 'i',
  'ʲ': 'j',
  'ᵏ': 'k',
  'ˡ': 'l',
  'ᵐ': 'm',
  'ⁿ': 'n',
  'ᵒ': 'o',
  'ᵖ': 'p',
  'ʳ': 'r',
  'ˢ': 's',
  'ᵗ': 't',
  'ᵘ': 'u',
  'ᵛ': 'v',
  'ʷ': 'w',
  'ˣ': 'x',
  'ʸ': 'y',
  'ᶻ': 'z'
};
const _RE_SUPER_RUN =
    new RegExp('[' + Object.keys(SUPER_MAP).join('') + ']+', 'g');
function unsuperscript(s) {
  return String(s || '').replace(
      _RE_SUPER_RUN,
      run => ' ' +
          Array.from(run, c => SUPER_MAP[c])
              .join('')
              .replace(/([a-z])(\d)/g, '$1 $2') +
          ' ');
}
// Quality from the channel name, for choosing among variants: 8K > 4K/UHD >
// FHD/1080 > HD/720 > untagged > SD/576/480/360
function nameQualityRank(name) {
  const n = unsuperscript(name).toLowerCase();
  if (/\b(8k|4320p?)\b/.test(n)) return 6;
  if (/\b(4k|uhd|2160p?|3840p?)\b/.test(n)) return 5;
  if (/\b(fhd|1080[pi]?)\b/.test(n)) return 4;
  if (/\b(hd|720p?)\b/.test(n)) return 3;
  if (/\b(sd|576[pi]?|480[pi]?|360p?)\b/.test(n)) return 1;
  return 2;
}
// Applied playlist: load its favorites. The first time, favorites saved
// globally by tvg-id (before 3.12) are converted: each becomes the best-quality
// channel among those sharing that tvg-id (first listed on a tie).
function favoritesLoad() {
  const ps = _activePlaylistKey ? getPlaylistState(_activePlaylistKey) : null;
  if (!ps) {
    favoriteIds = new Set();
    return;
  }
  if (Array.isArray(ps.favs)) {
    favoriteIds = new Set(ps.favs);
    return;
  }
  let legacy = [];
  try {
    legacy = JSON.parse(localStorage.getItem('iptv_favorites') || '[]') || [];
  } catch (_) {
    legacy = [];
  }
  const byTvg = new Map();
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    if (!ch.tvgId) continue;
    const best = byTvg.get(ch.tvgId);
    if (best === undefined ||
        nameQualityRank(ch.name) > nameQualityRank(channels[best].name))
      byTvg.set(ch.tvgId, i);
  }
  const out = [];
  for (const id of legacy) {
    const m = /^idx_(\d+)$/.exec(String(id));
    const i = m ? +m[1] : byTvg.get(id);
    if (i !== undefined && channels[i]) out.push(favIdOf(channels[i], i));
  }
  favoriteIds = new Set(out);
  saveFavorites();
  if (out.length)
    diagLog(`Favorites: ${out.length} of ${
        legacy
            .length} saved favorites matched this playlist (best-quality variant kept)`);
}
function catsToggleHidden() {
  const g = _catsNames[catsFocus];
  if (!g) return;
  if (catsMode === 'favs') {
    // Removed favorites stay listed (struck through) until the manager closes,
    // so OK again restores them in place
    if (favoriteIds.has(g))
      favoriteIds.delete(g);
    else
      catsRebuildFavOrder();
    saveFavorites();
    renderCats();
    return;
  }
  if (_hiddenGroups.has(g))
    _hiddenGroups.delete(g);
  else
    _hiddenGroups.add(g);
  saveCatsState();
  renderCats();
}
// favoriteIds in the manager's order (kept ones only), followed by favorites
// that belong to other playlists
function catsRebuildFavOrder() {
  const shown = new Set(_catsNames);
  const removed = new Set(_catsNames.filter(id => !favoriteIds.has(id)));
  const rest = [...favoriteIds].filter(id => !shown.has(id));
  favoriteIds = new Set(
      _catsNames.filter(id => !removed.has(id) || id === _catsNames[catsFocus])
          .concat(rest));
}
function catsMove(dir) {
  const i = catsFocus, j = i + dir;
  if (j < 0 || j >= _catsNames.length) return;
  [_catsNames[i], _catsNames[j]] = [_catsNames[j], _catsNames[i]];
  catsFocus = j;
  if (catsMode === 'favs') {
    const removed = new Set(_catsNames.filter(id => !favoriteIds.has(id)));
    const rest = [...favoriteIds].filter(id => !_catsNames.includes(id));
    favoriteIds =
        new Set(_catsNames.filter(id => !removed.has(id)).concat(rest));
    saveFavorites();
  } else {
    _groupOrder = _catsNames.slice();  // the full explicit order from now on
    saveCatsState();
  }
  renderCats();
}
function handleCatsKey(e) {
  const k = e.key, kc = e.keyCode;
  if (k === 'ArrowUp' || kc === 38) {
    e.preventDefault();
    catsFocus = Math.max(0, catsFocus - 1);
    renderCats();
  } else if (k === 'ArrowDown' || kc === 40) {
    e.preventDefault();
    catsFocus = Math.min(_catsNames.length - 1, catsFocus + 1);
    renderCats();
  } else if (k === 'Enter' || kc === 13) {
    e.preventDefault();
    catsToggleHidden();
  } else if (
      kc === 403 || k === 'ColorF0Red' || k === 'ArrowLeft' || kc === 37) {
    e.preventDefault();
    catsMove(-1);
  } else if (
      kc === 404 || k === 'ColorF1Green' || k === 'ArrowRight' || kc === 39) {
    e.preventDefault();
    catsMove(1);
  }
}

function renderGroupsList() {
  if (vodMode !== 'live') {
    renderVodCats();
    return;
  }
  const hdrSpan = document.querySelector('.groups-header span');
  if (hdrSpan && hdrSpan.textContent !== '📁 Groups')
    hdrSpan.textContent = '📁 Groups';
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
    if (currentSearchQuery && !PINNED_GROUPS.includes(group) &&
        group.toLowerCase().includes(currentSearchQuery.toLowerCase())) {
      displayName = highlightText(displayName, currentSearchQuery);
    }
    div.innerHTML = `<span class="group-folder">${folderIcon}</span><span>${
        displayName}</span>`;
    div.onclick = () => {
      currentGroup = group;
      stdGroupFocusIdx = Math.max(0, groupsList.indexOf(group));
      if (_activePlaylistKey) {
        getPlaylistState(_activePlaylistKey).lastGroup = group;
        savePlaylistState();
      }
      if (currentSearchQuery) {
        currentSearchQuery = '';
        searchInput.value = '';
      }
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
    const regex =
        new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result =
        result.replace(regex, '<span class="search-match-highlight">$1</span>');
  }
  return result;
}

function searchChannels(query) {
  if (!query.trim()) return [...channels];
  if (_searchCache.query === query) return _searchCache.result;
  const terms = query.toLowerCase().split(/\s+/);
  // Matches channel names and groups, and also what is on now: a programme
  // title match (from the EPG already loaded, lazily per channel) ranks just
  // below a name match. Hidden categories are excluded.
  const q = query.toLowerCase();
  const scored = channels.map((ch, idx) => {
    if (_hiddenGroups.size && _hiddenGroups.has(ch.group))
      return {idx, score: 0};
    let score = 0;
    const nameLower = ch.name.toLowerCase();
    const groupLower = (ch.group || '').toLowerCase();
    if (nameLower === q)
      score = 100;
    else if (nameLower.startsWith(q))
      score = 90;
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
        for (const t of terms)
          if (tl.includes(t)) m++;
        if (m === terms.length)
          score = Math.max(score, tl === q ? 88 : 85);
        else if (m)
          score = Math.max(score, 40 * m / terms.length);
      }
    }
    return {idx, score};
  });
  const result = scored.filter(s => s.score > 0)
                     .sort((a, b) => b.score - a.score)
                     .map(s => channels[s.idx]);
  _searchCache = {query, result};
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
    filtered = _hiddenGroups.size ?
        channels.filter(ch => !_hiddenGroups.has(ch.group)) :
        [...channels];
  } else {
    filtered =
        arrangeEventGroup(channels.filter(ch => ch.group === currentGroup));
  }
  currentFilteredChannels = filtered;
  if (stdFocusIdx >= filtered.length)
    stdFocusIdx = Math.max(0, filtered.length - 1);
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
    channelListDiv.innerHTML =
        `<div style="padding:24px;text-align:center;">📭 No channels found</div>`;
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
    const endIdx =
        Math.min(total - 1, startIdx + Math.ceil(containerHeight / ITEM_H) + 2);
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
      div.className = 'virtual-item' +
          (currentChannelIndex === originalIndex ? ' active' : '') +
          (stdFocusZone === 'channels' && i === stdFocusIdx ? ' focused' : '');
      div.style.top = `${i * ITEM_H}px`;
      div.style.height = `${ITEM_INNER}px`;
      // Build logo HTML
      let logoHtml = '';
      if (ch.tvgLogo && ch.tvgLogo.trim()) {
        logoHtml = `
                    <img class="logo-img" src="${
            escapeHtml(
                ch.tvgLogo)}" loading="lazy" onerror="this.style.display='none'" onload="this.nextElementSibling.style.display='none'">
                    <div class="logo-placeholder">📺</div>
                `;
      } else {
        logoHtml = `<div class="logo-placeholder">📺</div>`;
      }
      // EPG "now playing" line
      const nowProg = getCurrentProgramme(ch.tvgId);
      const epgLine = nowProg ?
          `<span class="channel-epg">${
              escapeHtml(
                  nowProg.title.length > 36 ?
                      nowProg.title.substring(0, 34) + '…' :
                      nowProg.title)}</span>` :
          (epgData.size > 0 ? '<span class="channel-epg"></span>' : '');
      div.innerHTML = `
                <div class="channel-logo">
                    <span class="channel-num">${originalIndex + 1}</span>
                    <div class="channel-logo-img">${logoHtml}</div>
                </div>
                <div class="channel-info"><span class="channel-name">${
          escapeHtml(
              ch.name.length > 40 ? ch.name.substring(0, 37) + '...' :
                                    ch.name)}</span>${epgLine}</div>
                <span class="favorite-star">${fav ? '★' : '☆'}</span>
            `;
      const starSpan = div.querySelector('.favorite-star');
      starSpan.onclick = (e) => {
        e.stopPropagation();
        const id = favIdOf(ch, originalIndex);
        if (favoriteIds.has(id))
          favoriteIds.delete(id);
        else
          favoriteIds.add(id);
        saveFavorites();
        if (currentGroup === 'favorites' && !currentSearchQuery)
          renderChannelList();  // list membership changed
        else
          starSpan.textContent =
              favoriteIds.has(id) ? '★' : '☆';  // otherwise update in place
      };
      div.onclick = () => selectChannel(originalIndex);
      virtualContainer.appendChild(div);
      renderedItems.set(i, div);
    }
  };

  const onScroll = () => {
    requestAnimationFrame(renderVisible);
  };
  channelListDiv.addEventListener('scroll', onScroll);
  currentScrollListener = onScroll;
  _stdRenderVisible = renderVisible;
  channelListDiv.scrollTop = savedScrollTop;
  renderVisible();
}
