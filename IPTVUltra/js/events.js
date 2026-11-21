/**
 * @fileoverview Event listeners for the remote and the page.
 */

// ----- Event Listeners -----
saveNewBtn.addEventListener('click', () => {
  const url = newM3uUrl.value.trim();
  const name = newM3uName.value.trim();
  const epgUrl = newEpgUrl.value.trim();
  if (url)
    addPlaylist(url, name, epgUrl);
  else
    updateStartStatus('Please enter a valid URL', true, false, false, 0);
});
loadSelectedBtn.addEventListener('click', () => {
  if (!isLoading && selectedPlaylistId !== null &&
      savedPlaylists[selectedPlaylistId]) {
    const p = savedPlaylists[selectedPlaylistId];
    if (p.type === 'xtream')
      loadXtreamPlaylist(p.url, p.username, p.password, p.epgUrl || '');
    else
      loadM3UFromUrl(p.url, p.epgUrl || '');
  }
});
saveXtreamBtn.addEventListener('click', () => {
  // Save only — the server is contacted when the user presses "Load Selected"
  const server = xtreamServer.value.trim();
  const uname = xtreamUsername.value.trim();
  const pass = xtreamPassword.value.trim();
  const name = xtreamName.value.trim();
  const epgUrl = xtreamEpgUrl.value.trim();
  if (!server || !uname || !pass) {
    updateStartStatus(
        'Please enter server URL, username, and password', true, false, false,
        0);
    return;
  }
  if (!/^https?:\/\//i.test(server)) {
    updateStartStatus(
        'Server URL must start with http:// or https://', true, false, false,
        0);
    return;
  }
  if (epgUrl && !/^https?:\/\//i.test(epgUrl)) {
    updateStartStatus(
        'EPG URL must start with http:// or https://', true, false, false, 0);
    return;
  }
  addXtreamPlaylist(server, uname, pass, name, epgUrl);
});
tabM3u.addEventListener('click', () => switchTab('m3u'));
tabXtream.addEventListener('click', () => switchTab('xtream'));
startDemoBtn.addEventListener('click', loadDemoM3U);
clearAllBtn.addEventListener('click', () => {
  showConfirmDialog(
      '⚠️ Clear All Playlists',
      'Are you sure you want to clear all saved playlists?', clearAllPlaylists);
});

const epgTimePrevBtn = document.getElementById('epgTimePrevBtn');
const epgTimeNextBtn = document.getElementById('epgTimeNextBtn');
if (epgTimePrevBtn)
  epgTimePrevBtn.addEventListener('click', () => scrollEPGTimeBy(-30));
if (epgTimeNextBtn)
  epgTimeNextBtn.addEventListener('click', () => scrollEPGTimeBy(30));
const epgScrollOuterEl = document.getElementById('epgScrollOuter');
if (epgScrollOuterEl)
  epgScrollOuterEl.addEventListener('scroll', updateEPGNavVisibility);
const epgInfoFavBtn = document.getElementById('epgInfoFavBtn');
if (epgInfoFavBtn)
  epgInfoFavBtn.addEventListener('click', () => {
    if (epgInfoFavBtn.dataset.favId) toggleEPGFav(epgInfoFavBtn.dataset.favId);
  });
reloadBtn.addEventListener('click', reloadStream);
homePageBtn.addEventListener('click', goToHomeScreen);
document.querySelectorAll('#modeSwitch .mode-btn')
    .forEach(
        b => b.addEventListener('click', () => setVodMode(b.dataset.mode)));
const vodSearchInputEl = document.getElementById('vodSearchInput');
if (vodSearchInputEl)
  vodSearchInputEl.addEventListener('input', () => {
    vodNav.query = vodSearchInputEl.value;
    clearTimeout(_vodSearchTimer);
    _vodSearchTimer = setTimeout(applyVodSearch, 150);
  });
const vodNextPlayEl = document.getElementById('vodNextPlay'),
      vodNextCancelEl = document.getElementById('vodNextCancel');
if (vodNextPlayEl)
  vodNextPlayEl.addEventListener('click', () => {
    vodPlay.nextFocus = 'play';
    activateVodNext();
  });
if (vodNextCancelEl)
  vodNextCancelEl.addEventListener('click', () => {
    vodPlay.nextFocus = 'cancel';
    activateVodNext();
  });
const vodPlayerEl = document.getElementById('vodPlayer');
if (vodPlayerEl) {
  // The Magic Remote pointer does not show, hide or extend the OSD: moving the
  // cursor (or the TV re-showing it) kept popping the banner up over
  // full-screen video. Keys and clicks do.
  vodPlayerEl.addEventListener('click', e => {
    if (!playerActive()) return;
    // Tracks menu open: a row click re-renders the list before this bubbles, so
    // e.target is already detached and closest('.vod-tracks') fails — which
    // used to toggle pause on every OK in the menu. While the menu is open a
    // click inside it is the menu's; a click outside just closes it.
    if (vodTracksOpen()) {
      if (!e.target.closest('.vod-tracks')) closeVodTracks();
      return;
    }
    if (e.target.closest('.vod-next') || e.target.closest('.vod-osd-btn') ||
        e.target.closest('.vod-bar'))
      return;
    // A click with the OSD hidden only shows the OSD
    if (!document.getElementById('vodOsd').classList.contains('visible')) {
      showVodOsd();
      return;
    }
    if (vodPlay.active)
      toggleVodPause();
    else
      toggleLivePause();
  });
  // Click on the timeline (VOD) jumps there and plays
  const barEl = vodPlayerEl.querySelector('#vodOsd .vod-bar');
  if (barEl)
    barEl.addEventListener('click', e => {
      e.stopPropagation();
      if (!vodPlay.active) return;
      const r = barEl.getBoundingClientRect();
      const f =
          Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) ||
          vodPlay.dur || 0;
      if (!dur) return;
      try {
        videoPlayer.currentTime = f * dur;
      } catch (_) { /* not seekable yet */
      }
      videoPlayer.play().catch(() => {});
      document.getElementById('vodPaused').classList.add('hidden');
      showVodOsd();
    });
}
videoPlayer.addEventListener('timeupdate', function() {
  if (!vodPlay.active) {
    // Live on hls.js (behind-live readout) and catch-up (position bar): keep
    // the banner current while it is up
    if (livePlayer.active && (liveEngineActive() || catchup) &&
        document.getElementById('vodOsd').classList.contains('visible'))
      updateLiveOsd();
    return;
  }
  if (document.getElementById('vodOsd').classList.contains('visible'))
    updateVodOsd();
  saveVodProgress(false);
});
videoPlayer.addEventListener('ended', onVodEnded);
videoPlayer.addEventListener('waiting', function() {
  if (vodPlay.active)
    document.getElementById('vodLoading').classList.remove('hidden');
});
let _perfFirstPlay = false;
videoPlayer.addEventListener('playing', function() {
  if (!_perfFirstPlay) {
    _perfFirstPlay = true;
    perfMark('first-playing');
  }
  if (vodPlay.active) {
    document.getElementById('vodLoading').classList.add('hidden');
    document.getElementById('vodPaused').classList.add('hidden');
  }
});
videoPlayer.addEventListener('pause', function() {
  if (playerActive() && !vodPlay.ended && !videoPlayer.ended) {
    document.getElementById('vodPaused').classList.remove('hidden');
    renderPlayerButtons();
  }
});
videoPlayer.addEventListener('play', function() {
  if (playerActive()) {
    document.getElementById('vodPaused').classList.add('hidden');
    renderPlayerButtons();
  }
});
['settingsBtn', 'sideSettingsBtn'].forEach(id => {
  const b = document.getElementById(id);
  if (b) b.addEventListener('click', openSettings);
});
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettings);
const settingsOverlayEl = document.getElementById('settingsOverlay');
if (settingsOverlayEl)
  settingsOverlayEl.addEventListener('click', e => {
    if (e.target === settingsOverlayEl) closeSettings();
  });
toggleGroupsBtn.addEventListener('click', toggleGroupsColumn);
showGroupsBtn.addEventListener('click', toggleGroupsColumn);
const epgVideoWrap = document.getElementById('epgVideoWrap');
if (epgVideoWrap) epgVideoWrap.addEventListener('mousemove', showTopControls);
searchInput.addEventListener('input', () => {
  currentSearchQuery = searchInput.value;
  if (currentSearchQuery.trim()) currentGroup = 'all';
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    renderGroupsList();
    refreshCurrentView();
  }, 150);
});
clearSearchBtn.addEventListener('click', () => {
  currentSearchQuery = '';
  searchInput.value = '';
  searchInput.focus();
  renderGroupsList();
  refreshCurrentView();
});
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
subtitleBtn.addEventListener('click', () => {
  toggleSubtitlePanel();
  showTopControls();
});
audioBtn.addEventListener('click', () => {
  toggleAudioPanel();
  showTopControls();
});
videoPlayer.addEventListener('resize', noteCurrentStreamTech);
videoPlayer.addEventListener('loadedmetadata', function() {
  noteCurrentStreamTech();
  updateSubtitleButton();
  updateAudioButton();
  if (vodMode === 'live' && !vodPlay.active && !livePlayer.active &&
      !liveEngineActive()) {
    setTimeout(() => {
      if (!(liveUms && liveUms.video) && videoPlayer.videoWidth)
        showFeedStats(`${videoPlayer.videoWidth}×${videoPlayer.videoHeight}`);
    }, 1500);
  }
});
videoPlayer.addEventListener('error', function() {
  if (vodPlay.active) {
    if (videoPlayer.getAttribute('src')) onVodError();
    return;
  }
  if (vodMode !== 'live')
    return;  // live video is parked while browsing Movies/Series
  if (currentChannelIndex < 0 || !videoPlayer.getAttribute('src'))
    return;  // src cleared on purpose
  if (!videoPlayer.error)
    return;  // stale event from a source that has already been replaced (hls.js
             // → native hand-over)
  const code = videoPlayer.error ? videoPlayer.error.code : 0;
  const msg = code === 2 ? 'Network error' :
      code === 3         ? 'Decode error' :
      code === 4         ? 'Stream unavailable or unsupported' :
                           'Playback error';
  noteStreamFail(
      'native',
      `${msg} (MediaError ${code}${
          videoPlayer.error && videoPlayer.error.message ?
              `: ${videoPlayer.error.message}` :
              ''})`,
      '');
  stopStallWatchdog();
  if (_reloadAttempts === 0)
    noteStreamFailureForAccount(
        currentChannelIndex);  // first failure: is it the account rather than
                               // the channel?
  if (_reloadAttempts >= MAX_AUTO_RELOADS) {
    if (!tryAlternateSource(msg)) showStreamError(msg);
    return;
  }
  _reloadAttempts++;
  statusArea.innerText =
      `⚠️ ${msg} — retrying (${_reloadAttempts}/${MAX_AUTO_RELOADS}) …`;
  const idx = currentChannelIndex;
  if (_errRetryTimer) clearTimeout(_errRetryTimer);
  _errRetryTimer = setTimeout(function() {
    _errRetryTimer = null;
    if (currentChannelIndex === idx) reloadStream(true, 'error retry');
  }, 2500);
});
videoArea.addEventListener('mousemove', showTopControls);
videoArea.addEventListener('click', function(e) {
  if (subtitlePanelOpen && !subtitlePanel.contains(e.target) &&
      e.target !== subtitleBtn)
    toggleSubtitlePanel();
  if (audioPanelOpen && !audioPanel.contains(e.target) && e.target !== audioBtn)
    toggleAudioPanel();
});
videoArea.addEventListener('dblclick', function(e) {
  if (e.target === videoPlayer && currentChannelIndex >= 0 &&
      !livePlayer.active)
    enterLivePlayer();
});
if (epgVideoWrap)
  epgVideoWrap.addEventListener('dblclick', function(e) {
    if (e.target === videoPlayer && currentChannelIndex >= 0 &&
        !livePlayer.active)
      enterLivePlayer();
  });
videoPlayer.textTracks.addEventListener('addtrack', function() {
  updateSubtitleButton();
  if (subtitlePanelOpen) buildSubtitlePanel();
  if (vodPlay.active) {
    applyVodTrackPrefs();
    if (vodTracksOpen()) renderVodTracks();
  }
});
videoPlayer.textTracks.addEventListener('removetrack', function() {
  updateSubtitleButton();
});
if (videoPlayer.audioTracks) {
  videoPlayer.audioTracks.addEventListener('addtrack', function() {
    updateAudioButton();
    if (audioPanelOpen) buildAudioPanel();
    if (vodPlay.active) {
      applyVodTrackPrefs();
      if (vodTracksOpen()) renderVodTracks();
    }
  });
  videoPlayer.audioTracks.addEventListener('removetrack', function() {
    updateAudioButton();
  });
}
document.addEventListener('keydown', handleRemoteNav);
// Back from a different app: the guide shows the current time
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) epgReturnToNow();
});

// OK in the player: a hold of LONG_PRESS_MS in the live player switches to the
// previous channel while you hold the key. A short press acts on release: a
// button of the banner, else pause on the bar.
let _enterPressTime = 0;
let _enterDown = false;
let _enterLongTimer = 0;
let _enterLongDone = false;
let _enterOsdHeld = false;  // the push stopped the banner timer
const LONG_PRESS_MS = 600;
// Capture phase: runs before handleRemoteNav, so a press that opens the player
// (Play on a details page, OK on a guide row) is not also taken as a player OK
// on its release (which paused the movie it had just started)
document.addEventListener('keydown', (e) => {
  if (!_inPlayerMode()) return;
  if (e.key !== 'Enter' && e.keyCode !== 13) return;
  // An auto-repeat never starts a press: the press can start outside the
  // player (OK on Play, or on a row of an overlay that closes on keydown). A
  // press that is not a repeat starts again, also when the app did not get the
  // release of the previous press.
  if (e.repeat) return;
  _enterDown = true;
  _enterLongDone = false;
  _enterPressTime = Date.now();
  // The banner timer does not hide the banner (and its button focus or surf
  // preview) during the push. The release starts the timer again.
  if (vodPlay.osdTimer) {
    clearTimeout(vodPlay.osdTimer);
    vodPlay.osdTimer = null;
    _enterOsdHeld = true;
  }
  clearTimeout(_enterLongTimer);
  _enterLongTimer =
      livePlayer.active ? setTimeout(enterLongPress, LONG_PRESS_MS) : 0;
}, true);
// The hold of OK in the live player reached LONG_PRESS_MS
function enterLongPress() {
  _enterLongTimer = 0;
  if (!_enterDown || !_inPlayerMode() || !livePlayer.active ||
      vodTracksOpen() || vodNextVisible() || surf.active)
    return;
  // A button of the banner acts on the release
  if (player.focus === 'buttons' &&
      document.getElementById('vodOsd').classList.contains('visible'))
    return;
  _enterLongDone = true;
  surfCancel();
  if (swapToPreviousChannel()) showVodOsd();
}
function clearEnterPress() {
  clearTimeout(_enterLongTimer);
  _enterLongTimer = 0;
  _enterDown = false;
  _enterLongDone = false;
  _enterPressTime = 0;
}
document.addEventListener('keyup', (e) => {
  if (!_enterDown) return;
  if (e.key !== 'Enter' && e.keyCode !== 13) return;
  const long = _enterLongDone, osdHeld = _enterOsdHeld;
  _enterOsdHeld = false;
  clearEnterPress();
  // The banner timer starts again after the action of the release
  if (osdHeld)
    setTimeout(() => {
      if (playerActive() && !vodPlay.osdTimer &&
          document.getElementById('vodOsd').classList.contains('visible'))
        showVodOsd();
    }, 0);
  if (!_inPlayerMode()) return;
  e.preventDefault();
  if (long) return;  // the hold changed the channel
  if (vodTracksOpen())
    activateVodTrack();
  else if (vodNextVisible())
    activateVodNext();
  else if (livePlayer.active && surf.active)
    surfTune();
  else if (
      player.focus === 'buttons' &&
      document.getElementById('vodOsd').classList.contains('visible'))
    activatePlayerButton();
  else if (livePlayer.active)
    toggleLivePause();
  else
    toggleVodPause();  // OK on the bar: play/pause
});
// The app does not get the release of a key that it gets while hidden: the
// OK push, a Left/Right hold (no seek), and the stopped banner timer end
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  clearEnterPress();
  // The OK press of a guide or list row (its release goes to the other app)
  if (_rowOk) {
    clearTimeout(_rowOk.timer);
    _rowOk = null;
  }
  _holdKeyDir = null;
  const wasHolding = _isHolding();
  _cancelHold();
  // The banner shows the position again, and its timer starts again
  if ((wasHolding || _enterOsdHeld) && playerActive() &&
      document.getElementById('vodOsd').classList.contains('visible'))
    showVodOsd();
  _enterOsdHeld = false;
});

// Hold Left/Right in the player: short-press = ±3s seek; hold = trick play
document.addEventListener('keydown', (e) => {
  if (!_inPlayerMode()) return;
  if (playerActive() && (vodNextVisible() || vodTracksOpen()))
    return;  // Left/Right belong to the card / menu
  if (playerActive() && player.focus === 'buttons' &&
      document.getElementById('vodOsd').classList.contains('visible'))
    return;  // moving between buttons
  if (e.repeat) return;
  const isLeft = e.key === 'ArrowLeft' || e.keyCode === 37;
  const isRight = e.key === 'ArrowRight' || e.keyCode === 39;
  if (!isLeft && !isRight) return;
  e.preventDefault();
  if (_holdKeyDir) return;
  _holdKeyDir = isLeft ? 'left' : 'right';
  _holdKeyStart = Date.now();
  showPlayerControls();
  const capturedDir = _holdKeyDir, pressAt = _holdKeyStart;
  setTimeout(() => {
    // Only the same press: not the second tap of a quick double tap
    if (_holdKeyDir === capturedDir && _holdKeyStart === pressAt)
      _startHold(capturedDir);
  }, HOLD_THRESHOLD_MS);
}, true);

document.addEventListener('keyup', (e) => {
  const isLeft = e.key === 'ArrowLeft' || e.keyCode === 37;
  const isRight = e.key === 'ArrowRight' || e.keyCode === 39;
  if (!isLeft && !isRight) return;
  if (!_inPlayerMode()) {
    _holdKeyDir = null;
    return;
  }
  if (playerActive() && (vodNextVisible() || vodTracksOpen())) {
    _holdKeyDir = null;
    return;
  }
  if (playerActive() && player.focus === 'buttons' && !_holdKeyDir) return;
  e.preventDefault();
  const held = Date.now() - _holdKeyStart;
  const dir = _holdKeyDir;
  _holdKeyDir = null;
  if (_isHolding()) {
    _stopHold();
  } else if (dir && held < HOLD_THRESHOLD_MS) {
    // Live 3 s, VOD and catch-up 10 s. On an archive channel, a step before
    // the start of the buffer continues in the archive.
    playerStep(dir === 'left' ? -1 : 1);
  }
  showPlayerControls();
});

// Step to the previous/next channel within the list currently on screen
// (group, favorites or search result), wrapping at the ends.
function zapChannel(dir) {
  const list = currentFilteredChannels;
  if (!list.length) return;
  const cur = playingListIndex(list);
  let next = cur >= 0 ? (cur + dir + list.length) % list.length :
      dir > 0         ? 0 :
                        list.length - 1;
  // Skip the rows of the stream that plays: in a group of versions, CH+ and
  // CH- go to a different stream
  let found = false;
  for (let n = 0; n < list.length && !found; n++) {
    const i = getChannelIndex(list[next]);
    if (!isPlayingIdx(i) && bestVersionOf(i) !== currentChannelIndex)
      found = true;
    else
      next = (next + dir + list.length) % list.length;
  }
  if (!found) return;  // each row of the list plays this stream
  if (epgMode) {
    epgFocusedRowIdx = next;
    updateEPGRowFocus();
  }
  selectChannel(getChannelIndex(list[next]));
}

// Digit keys: direct channel number entry (see "Direct channel number entry")
document.addEventListener('keydown', (e) => {
  const d = digitKeyValue(e);
  if (d < 0 || !digitEntryAllowed()) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;  // a held digit is 1 digit
  onDigitKey(d);
}, true);

// Dedicated remote keys: Play (415), Pause (19), CH+ (427), CH- (428).
// These work in the player and in both main views.
document.addEventListener('keydown', (e) => {
  const kc = e.keyCode;
  if (kc !== 415 && kc !== 19 && kc !== 427 && kc !== 428) return;
  if (!mainApp || mainApp.style.display === 'none' || currentChannelIndex < 0)
    return;
  if (confirmDialog && !confirmDialog.classList.contains('hidden')) return;
  if (settingsOpen || catsOpen || diagOpen || versionsOpen || ssOpen) return;
  if (vodMode !== 'live' && !vodPlay.active) return;
  if (vodPlay.active && (kc === 427 || kc === 428)) return;
  e.preventDefault();
  // A held CH+ or CH- changes the channel 1 time: each change opens a provider
  // stream, and the provider counts the previous one for approximately 15 s
  if (e.repeat) return;
  if (kc === 415) {
    videoPlayer.play().catch(() => {});
    showPlayerControls();
    if (playerActive())
      document.getElementById('vodPaused').classList.add('hidden');
  } else if (kc === 19) {
    videoPlayer.pause();
    showPlayerControls();
    if (playerActive())
      document.getElementById('vodPaused').classList.remove('hidden');
  } else
    zapChannel(kc === 427 ? 1 : -1);
}, true);

// Back/Return button (webOS keyCode 461) — capture phase so system default is
// suppressed
document.addEventListener('keydown', (e) => {
  if (e.keyCode !== 461 && e.key !== 'GoBack') return;
  // A held Back goes back 1 step
  if (e.repeat) {
    e.preventDefault();
    return;
  }

  // Back while the confirm dialog is open cancels it
  if (confirmDialog && !confirmDialog.classList.contains('hidden')) {
    e.preventDefault();
    confirmNo.click();
    return;
  }
  if (ssOpen) {
    e.preventDefault();
    savedSearchBack();
    return;
  }
  if (versionsOpen) {
    e.preventDefault();
    closeVersions();
    return;
  }
  if (diagOpen) {
    e.preventDefault();
    closeDiag();
    return;
  }
  if (vodSortOpen) {
    e.preventDefault();
    closeVodSort();
    return;
  }
  if (catsOpen) {
    e.preventDefault();
    closeCatsManager();
    return;
  }
  if (settingsOpen) {
    e.preventDefault();
    closeSettings();
    return;
  }

  // Player: tracks menu → OSD → leave the player (→ details for VOD, →
  // guide/channels for live)
  if (playerActive() && vodTracksOpen()) {
    e.preventDefault();
    closeVodTracks();
    return;
  }
  if (playerActive() && !vodNextVisible() &&
      document.getElementById('vodOsd').classList.contains('visible')) {
    e.preventDefault();
    hideVodOsd();
    return;
  }
  if (vodPlay.active) {
    e.preventDefault();
    stopVodPlayback(true);
    return;
  }
  if (livePlayer.active) {
    e.preventDefault();
    exitLivePlayer();
    return;
  }
  if (vodMode !== 'live' && mainApp && mainApp.style.display !== 'none') {
    e.preventDefault();
    if (vodNav.screen === 'details')
      closeVodDetails();
    else if (vodNav.list !== 'home') {
      vodNav.zone = 'content';
      openVodList('home');
    } else
      setVodMode('live');
    return;
  }

  if (mainApp && mainApp.style.display !== 'none') {
    e.preventDefault();
    showConfirmDialog(
        '🏠 Return to Home', 'Return to the home screen?', goToHomeScreen);
    return;
  }

  // Start page: show platform exit prompt (disableBackHistoryAPI=true so we
  // must call explicitly)
  if (typeof webOS !== 'undefined' && webOS.platformBack) webOS.platformBack();
}, true);
