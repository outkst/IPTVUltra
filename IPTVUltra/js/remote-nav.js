/**
 * @fileoverview Remote navigation for the channel list and the guide, and the
 * programme cursor.
 */

// ── Standard (M3U) View Remote Navigation ─────────────────────
function resetStdFocus() {
  stdFocusZone = 'channels';
  stdFocusIdx = 0;
  stdGroupFocusIdx = Math.max(0, groupsList.indexOf(currentGroup));
}

function _groupItemEls() {
  // Document order matches groupsList order: pinned (favorites, all) first,
  // then the rest
  return document.querySelectorAll(
      '#groupsPinned .group-item, #groupsList .group-item');
}

function updateStdGroupFocus(scroll) {
  const els = _groupItemEls();
  for (let i = 0; i < els.length; i++)
    els[i].classList.toggle(
        'focused', stdFocusZone === 'groups' && i === stdGroupFocusIdx);
  if (scroll && els[stdGroupFocusIdx])
    els[stdGroupFocusIdx].scrollIntoView({block: 'nearest'});
}

function updateStdChannelFocus() {
  if (stdFocusZone === 'channels' && _stdItemH &&
      currentFilteredChannels.length) {
    const top = stdFocusIdx * _stdItemH, bottom = top + _stdItemH;
    if (top < channelListDiv.scrollTop)
      channelListDiv.scrollTop = top;
    else if (bottom > channelListDiv.scrollTop + channelListDiv.clientHeight)
      channelListDiv.scrollTop = bottom - channelListDiv.clientHeight;
    if (_stdRenderVisible) _stdRenderVisible();
  }
  for (const [idx, el] of renderedItems)
    el.classList.toggle(
        'focused', stdFocusZone === 'channels' && idx === stdFocusIdx);
}

function _isTextInput(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

// ── EPG Remote Navigation ─────────────────────────────────────
let _epgPrevFocusIdx = -1;
function updateEPGRowFocus() {
  // Only the row losing focus and the row gaining it change class; the others
  // are untouched
  if (_epgPrevFocusIdx !== epgFocusedRowIdx) {
    const prev = epgRenderedRows.get(_epgPrevFocusIdx);
    if (prev) {
      prev.classList.remove('epg-focused');
      const b = prev.querySelector('.epg-block-focused');
      if (b) b.classList.remove('epg-block-focused');
    }
    _epgPrevFocusIdx = epgFocusedRowIdx;
  }
  const cur = epgRenderedRows.get(epgFocusedRowIdx);
  if (cur) cur.classList.add('epg-focused');
  scrollEPGRowIntoView(epgFocusedRowIdx);
  updateEPGBlockFocus();
}

// ── Programme cursor ─────────────────────────────────────────
// The focused row highlights the programme at epgFocusT (0 = now). Left/Right
// move it to the previous/ next programme and pan the guide to keep it in view;
// Up/Down keep the time. OK on a past programme of a catch-up channel plays it
// from the archive; anywhere else OK plays the channel live, as before.
function epgCursorTime() {
  return epgFocusT || Date.now();
}
function epgFocusedProgs() {
  const ch = currentFilteredChannels[epgFocusedRowIdx];
  if (!ch) return {ch: null, progs: []};
  return {ch, progs: epgProgsOf(ch.tvgId) || []};
}
function epgFocusedProg() {
  const {progs} = epgFocusedProgs();
  const t = epgCursorTime();
  const i = _epgBinarySearch(progs, t);
  return i >= 0 && progs[i].stop > t ? progs[i] : null;
}
function updateEPGBlockFocus() {
  const row = epgRenderedRows.get(epgFocusedRowIdx);
  if (!row) return;
  const prev = row.querySelector('.epg-block-focused');
  const p = epgFocusedProg();
  const next =
      p ? row.querySelector(`.epg-prog-block[data-start="${p.start}"]`) : null;
  if (prev === next) return;
  if (prev) prev.classList.remove('epg-block-focused');
  if (next) next.classList.add('epg-block-focused');
}
// Pan so the time range [a, b] (ms) is inside the visible programme area
function epgEnsureTimeVisible(a, b) {
  if (!_epgWinStart) return;
  if (!_epgViewW) epgMeasureViewport();
  const visW = Math.max(1, _epgViewW - EPG_CH_W);
  const ax = (a - _epgWinStart) / 60000 * EPG_PX_PER_MIN,
        bx = (b - _epgWinStart) / 60000 * EPG_PX_PER_MIN;
  let x = _epgX;
  if (ax < x + 40)
    x = ax - 40;
  else if (bx > x + visW - 40)
    x = Math.min(ax - 40, bx - visW + 40);
  x = Math.max(0, Math.min(epgMaxPan(), Math.round(x)));
  if (x !== _epgX) {
    _epgX = x;
    epgApplyPan();
  }
}
// Left/Right in the guide: previous/next programme on the focused row; without
// data, pan half an hour
function epgMoveCursor(dir) {
  const {ch, progs} = epgFocusedProgs();
  const t = epgCursorTime();
  if (!progs.length) {
    scrollEPGTimeBy(dir * 30);
    epgFocusT = t + dir * 1800000;
    if (ch && dir < 0) epgMaybeFetchHistory(ch);
    return;
  }
  let i = _epgBinarySearch(progs, t);
  if (i >= 0 && progs[i].stop <= t)
    i = Math.min(
        progs.length - 1,
        i + (dir > 0 ? 0 : 1));  // cursor in a gap: nearest side
  let j = i + dir;
  if (j < 0) {
    // Earlier than anything loaded: the archive may hold more; fetch the full
    // table and nudge the view back
    if (ch && channelHasCatchup(ch) &&
        progs[0].start > Date.now() - ch.archive * 86400000)
      epgMaybeFetchHistory(ch);
    epgFocusT = Math.max(_epgWinStart || 0, progs[0].start - 1800000);
    epgEnsureTimeVisible(epgFocusT, epgFocusT + 1800000);
    updateEPGBlockFocus();
    return;
  }
  if (j >= progs.length) {
    epgFocusT =
        Math.min(_epgWinEnd || Infinity, progs[progs.length - 1].stop + 1);
    epgEnsureTimeVisible(epgFocusT, epgFocusT + 1800000);
    updateEPGBlockFocus();
    return;
  }
  const p = progs[j];
  epgFocusT = p.start + Math.min(60000, Math.max(1, (p.stop - p.start) / 2));
  if (dir < 0 && ch && channelHasCatchup(ch) && j <= 2)
    epgMaybeFetchHistory(ch);
  epgEnsureTimeVisible(p.start, p.stop);
  updateEPGBlockFocus();
}
function epgMaybeFetchHistory(ch) {
  if (!channelHasCatchup(ch) || !ch.tvgId || _epgFullFetched.has(ch.tvgId))
    return;
  const row = epgRenderedRows.get(epgFocusedRowIdx);
  if (row) row.classList.add('epg-row-loading-past');
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
  // Setting scrollTop raises a scroll event; the rows are rendered from there,
  // once per frame
  if (rowTop < viewTop)
    scrollOuter.scrollTop = rowTop;
  else if (rowBottom > viewBottom)
    scrollOuter.scrollTop = rowBottom + timeStripH - _epgViewH;
  else
    return;
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
  if (favoriteIds.has(id))
    favoriteIds.delete(id);
  else
    favoriteIds.add(id);
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
  // Programme cursor on a past programme of a catch-up channel: play it from
  // the archive
  const p = epgFocusedProg();
  if (p && progIsCatchup(ch, p, Date.now())) {
    startCatchup(idx, p);
    return;
  }
  if (idx === currentChannelIndex) {
    toggleLivePlayer();
    return;
  }
  const row = epgRenderedRows.get(epgFocusedRowIdx);
  if (row)
    row.click();
  else
    selectChannel(idx);
}

function handleRemoteNav(e) {
  const k = e.key, kc = e.keyCode;
  const up = k === 'ArrowUp' || kc === 38,
        down = k === 'ArrowDown' || kc === 40;
  const left = k === 'ArrowLeft' || kc === 37,
        right = k === 'ArrowRight' || kc === 39;
  const enter = k === 'Enter' || kc === 13;

  // The confirm dialog owns the remote while it is open
  if (confirmDialog && !confirmDialog.classList.contains('hidden')) {
    if (left || up) {
      e.preventDefault();
      confirmYes.focus();
    } else if (right || down) {
      e.preventDefault();
      confirmNo.focus();
    } else if (enter) {
      e.preventDefault();
      (document.activeElement === confirmYes ? confirmYes : confirmNo).click();
    }
    return;
  }

  // Diagnostics / Sort menu / Categories manager / Settings overlay own the
  // remote while open
  if (versionsOpen) {
    handleVersionsKey(e);
    return;
  }
  if (diagOpen) {
    handleDiagKey(e);
    return;
  }
  if (vodSortOpen) {
    handleVodSortKey(e);
    return;
  }
  if (catsOpen) {
    handleCatsKey(e);
    return;
  }
  if (settingsOpen) {
    handleSettingsKey(e);
    return;
  }

  if (playerActive()) {
    handleVodPlayerKey(e, up, down, left, right, enter);
    return;
  }

  // Yellow colour key opens Settings from any screen
  if (kc === 405 || k === 'ColorF2Yellow') {
    e.preventDefault();
    openSettings();
    return;
  }

  const inMain = mainApp && mainApp.style.display !== 'none';

  // Blue colour key cycles Live / Movies / Series (Xtream playlists only)
  if (kc === 406 || k === 'ColorF3Blue') {
    if (inMain && currentPlaylistType === 'xtream') {
      e.preventDefault();
      cycleVodMode();
    }
    return;
  }
  // Red in Live: back to the previous channel (Movies/Series use Red for their
  // own actions below)
  if ((kc === 403 || k === 'ColorF0Red') && inMain && vodMode === 'live' &&
      !_isTextInput(document.activeElement)) {
    e.preventDefault();
    swapToPreviousChannel();
    return;
  }
  // Green in a Movies/Series grid: sort & genre menu
  if ((kc === 404 || k === 'ColorF1Green') && inMain && vodMode !== 'live' &&
      vodNav.screen === 'grid') {
    e.preventDefault();
    if (_isTextInput(document.activeElement)) document.activeElement.blur();
    openVodSort();
    return;
  }

  // Typing in a search box: Down/Enter hand focus back to the list; other keys
  // pass through
  if (inMain && _isTextInput(document.activeElement)) {
    if (down || enter) {
      e.preventDefault();
      document.activeElement.blur();
      if (vodMode !== 'live') {
        vodNav.zone = 'content';
        refreshVodFocus();
      } else if (!epgMode) {
        stdFocusZone = 'channels';
        updateStdChannelFocus();
      }
    }
    return;
  }

  if (inMain && vodMode !== 'live') {
    handleVodBrowseKey(e, up, down, left, right, enter);
    return;
  }

  if (epgMode) {
    if (up) {
      e.preventDefault();
      epgFocusedRowIdx = Math.max(0, epgFocusedRowIdx - 1);
      updateEPGRowFocus();
    } else if (down) {
      e.preventDefault();
      epgFocusedRowIdx =
          Math.min(currentFilteredChannels.length - 1, epgFocusedRowIdx + 1);
      updateEPGRowFocus();
    } else if (left) {
      e.preventDefault();
      epgMoveCursor(-1);
    } else if (right) {
      e.preventDefault();
      epgMoveCursor(1);
    } else if (enter) {
      const ch = currentFilteredChannels[epgFocusedRowIdx];
      if (ch)
        rowOkPress(e, getChannelIndex(ch), selectEPGFocusedChannel);
      else
        e.preventDefault();
    }
    return;
  }

  if (inMain) {
    // Standard (M3U) view: groups column ◀▶ channel list
    if (stdFocusZone === 'groups') {
      if (up) {
        e.preventDefault();
        stdGroupFocusIdx = Math.max(0, stdGroupFocusIdx - 1);
        updateStdGroupFocus(true);
      } else if (down) {
        e.preventDefault();
        stdGroupFocusIdx =
            Math.min(groupsList.length - 1, stdGroupFocusIdx + 1);
        updateStdGroupFocus(true);
      } else if (right) {
        e.preventDefault();
        stdFocusZone = 'channels';
        updateStdGroupFocus(false);
        updateStdChannelFocus();
      } else if (enter) {
        e.preventDefault();
        const els = _groupItemEls();
        if (els[stdGroupFocusIdx]) els[stdGroupFocusIdx].click();
      }
    } else {
      if (up) {
        e.preventDefault();
        stdFocusIdx = Math.max(0, stdFocusIdx - 1);
        updateStdChannelFocus();
      } else if (down) {
        e.preventDefault();
        stdFocusIdx = Math.min(
            Math.max(0, currentFilteredChannels.length - 1), stdFocusIdx + 1);
        updateStdChannelFocus();
      } else if (left) {
        if (groupsColumnVisible) {
          e.preventDefault();
          stdFocusZone = 'groups';
          updateStdChannelFocus();
          updateStdGroupFocus(true);
        }
      } else if (enter) {
        e.preventDefault();
        const ch = currentFilteredChannels[stdFocusIdx];
        if (!ch) return;
        const idx = getChannelIndex(ch);
        rowOkPress(e, idx, () => {
          if (idx === currentChannelIndex)
            toggleLivePlayer();  // OK on the playing row opens the player
          else
            selectChannel(idx);
        });
      }
    }
    return;
  }

  if (!startPage.classList.contains('hidden')) {
    if (k === 'Tab') {
      e.preventDefault();
      switchTab(activeTab === 'm3u' ? 'xtream' : 'm3u');
    } else if (up) {
      e.preventDefault();
      currentFocusIndex--;
      focusElement(currentFocusIndex);
    } else if (down) {
      e.preventDefault();
      currentFocusIndex++;
      focusElement(currentFocusIndex);
    } else if (enter) {
      e.preventDefault();
      if (document.activeElement && document.activeElement.click)
        document.activeElement.click();
    }
  }
}
