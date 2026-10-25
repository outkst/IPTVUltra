/**
 * @fileoverview Stall watchdog, live video control, and the start page tabs.
 */

// ----- Stall Watchdog -----
function startStallWatchdog() {
  stopStallWatchdog();
  stallLastTime = -1;
  stallCount = 0;
  _stallGoodChecks = 0;
  _stallBufEnd = 0;
  _stallBufAt = 0;
  stallWatchdogTimer = setInterval(function() {
    // hls.js with no media yet waits for a relay (see livePlaylistLoader). Its
    // own timeouts stop a dead server.
    if (videoPlayer.paused || currentChannelIndex < 0 ||
        (liveEngineActive() && videoPlayer.readyState === 0)) {
      stallCount = 0;
      return;
    }
    const t = videoPlayer.currentTime;
    const bufEnd = stallBufferedEnd();
    if (bufEnd > _stallBufEnd + 0.5) {
      _stallBufEnd = bufEnd;
      _stallBufAt = Date.now();
    } else if (bufEnd < _stallBufEnd - 0.5) {
      _stallBufEnd = bufEnd;  // a new source or a seek
    }
    if (t === stallLastTime && videoPlayer.readyState < 3) {
      stallCount++;
      _stallGoodChecks = 0;
      if (stallCount >= STALL_THRESHOLD_CHECKS && bufEnd - t < 2 &&
          Date.now() - _stallBufAt < STALL_ALIVE_MS) {
        stallCount = STALL_THRESHOLD_CHECKS - 1;  // slow, not dead: wait
      } else if (stallCount >= STALL_THRESHOLD_CHECKS) {
        stallCount = 0;
        stallLastTime = -1;
        noteStreamFail(
            liveEngineActive() ? 'hls.js' : 'native',
            `No progress for ${STALL_THRESHOLD_CHECKS * 2} s (readyState ${
                videoPlayer.readyState}, t=${t.toFixed(1)} s)`,
            '');
        if (_reloadAttempts >= MAX_AUTO_RELOADS) {
          // Budget exhausted: try another source of the same channel, else stop
          // hammering it and tell the user
          stopStallWatchdog();
          if (!tryAlternateSource('Stream not responding'))
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

/**
 * Gives the end of the buffered range that contains the playhead.
 * @return {number} The end in seconds, or 0 when there is no such range.
 */
function stallBufferedEnd() {
  const b = videoPlayer.buffered, t = videoPlayer.currentTime;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) - 1 <= t && t <= b.end(i) + 1) return b.end(i);
  }
  return 0;
}

function stopStallWatchdog() {
  if (stallWatchdogTimer) {
    clearInterval(stallWatchdogTimer);
    stallWatchdogTimer = null;
  }
}

function showStreamError(msg) {
  const name = (currentChannelIndex >= 0 && channels[currentChannelIndex]) ?
      channels[currentChannelIndex].name :
      '';
  const tried = _altTried.size > 1 ? ` (${_altTried.size} sources tried)` : '';
  const acct = accountProblemText(_consInfo);
  statusArea.innerText = `⚠️ ${acct || msg}`;
  channelInfoTag.innerText = `⚠️ ${name ? name + ' — ' : ''}${acct || msg}`;
  if (acct)
    showEPGToast(
        `${acct}. Stop playback on the other device, then press Reload.`,
        'error', 'Connection limit');
  else
    showEPGToast(
        `${name ? name + ': ' : ''}${msg}${tried}. Press Reload to retry.`,
        'error', 'Stream Error');
  hideEPGToast(7000);
  diagLog(`Stream error: ${name}: ${msg}${tried}${acct ? ' · ' + acct : ''}`);
}

// Enter on the already-playing row (or a click on the live picture): open the
// app-owned player
function toggleLivePlayer() {
  if (livePlayer.active) {
    exitLivePlayer();
    return;
  }
  if (currentChannelIndex < 0 || vodPlay.active) return;
  enterLivePlayer();
}
function enterLivePlayer() {
  if (livePlayer.active || vodPlay.active || currentChannelIndex < 0) return;
  livePlayer.active = true;
  // Do NOT move the <video>: re-parenting destroys the webOS media pipeline
  // (verified on the C4: currentTime resets to 0, mediaId empties, picture
  // never returns). The element stays where it is and body.live-player
  // stretches it to the viewport underneath the transparent player overlay.
  const playerEl = document.getElementById('vodPlayer');
  document.body.classList.add('live-player');
  playerEl.classList.add('live');
  const badge = document.getElementById('pbTrickBadge');
  if (badge && badge.parentNode !== playerEl) playerEl.appendChild(badge);
  playerEl.classList.remove('hidden');
  document.getElementById('vodPaused')
      .classList.toggle('hidden', !videoPlayer.paused);
  document.getElementById('vodLoading').classList.add('hidden');
  document.getElementById('vodNext').classList.add('hidden');
  player.focus = 'bar';
  player.btn = 0;
  player.btns = [];
  const techEl = document.getElementById('vodOsdTech');
  if (techEl)
    techEl.textContent = liveUms ? umsTechString(liveUms) : liveEngine.tech;
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
  // Put the cursor on the playing channel so the next key press continues from
  // it
  if (currentChannelIndex >= 0) {
    if (epgMode) {
      const fi = currentFilteredChannels.indexOf(channels[currentChannelIndex]);
      if (fi >= 0) {
        epgFocusedRowIdx = fi;
        updateEPGRowFocus();
      }
    } else {
      const fi = currentFilteredChannels.indexOf(channels[currentChannelIndex]);
      if (fi >= 0) {
        stdFocusIdx = fi;
        stdFocusZone = 'channels';
        updateStdChannelFocus();
      }
    }
  }
}
function toggleLivePause() {
  if (videoPlayer.paused)
    videoPlayer.play().catch(() => {});
  else
    videoPlayer.pause();
  document.getElementById('vodPaused')
      .classList.toggle('hidden', !videoPlayer.paused);
  showVodOsd();
}

// ----- Video Control -----
function selectChannel(index) {
  if (!channels[index]) return;
  if (vodPlay.active) stopVodPlayback(false);
  stopStallWatchdog();
  catchup = null;  // any channel selection returns to live
  surfCancel();
  if (_selectingAlt) {
    // fallback to another source of the same channel: not a channel change for
    // history purposes
  } else {
    if (currentChannelIndex >= 0 && currentChannelIndex !== index)
      lastChannelIndex = _altOrigin >= 0 && channels[_altOrigin] ?
          _altOrigin :
          currentChannelIndex;
    _altOrigin = index;
    _altTried = new Set([index]);
    noteRecentChannel(channels[index]);
  }
  currentChannelIndex = index;
  _reloadAttempts = 0;
  if (_errRetryTimer) {
    clearTimeout(_errRetryTimer);
    _errRetryTimer = null;
  }
  const ch = channels[index];
  videoPlayer.pause();
  umsNoteCurrentId();
  if (loadLiveSource(ch.url)) {
    umsRelease(liveUms);
    liveUms = null;
  } else
    liveUmsRefresh();
  videoPlayer.play().catch(e => console.log);
  startStallWatchdog();
  channelInfoTag.innerText = `📺 ${ch.name}`;
  channelInfoTag.style.visibility = '';
  statusArea.innerText = `▶️ ${ch.name}`;
  if (_activePlaylistKey) {
    getPlaylistState(_activePlaylistKey).lastChannel = {
      url: ch.url,
      tvgId: ch.tvgId || ''
    };
    savePlaylistState();
  }
  if (epgMode) {
    // Don't rebuild the EPG grid — just update active row highlighting in-place
    for (const [, el] of epgRenderedRows) el.classList.remove('active');
    const filteredIdx = currentFilteredChannels.indexOf(ch);
    if (filteredIdx >= 0 && epgRenderedRows.has(filteredIdx))
      epgRenderedRows.get(filteredIdx).classList.add('active');
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
  if (livePlayer.active) {
    document.getElementById('vodPaused').classList.add('hidden');
    const techEl = document.getElementById('vodOsdTech');
    if (techEl) techEl.textContent = '';
    updateVodTracksHint();
    showVodOsd();
  } else
    showTopControls();

  // Reset per-stream state
  if (subtitlePanelOpen) {
    subtitlePanel.classList.add('hidden');
    subtitlePanelOpen = false;
  }
  if (audioPanelOpen) {
    audioPanel.classList.add('hidden');
    audioPanelOpen = false;
  }

  // Some streams add tracks well after loadedmetadata — check again after a
  // delay
  setTimeout(function() {
    updateSubtitleButton();
    updateAudioButton();
  }, 4000);
}

function showTopControls() {
  const c = document.getElementById('topControls');
  c.classList.add('visible');
  if (controlsTimeout) clearTimeout(controlsTimeout);
  controlsTimeout = setTimeout(() => {
    c.classList.remove('visible');
  }, 3000);
}

function resolveLanguage(code) {
  if (!code) return null;
  const short = code.toLowerCase().substring(0, 2);
  return LANG_NAMES[short] || code;
}

function getSubtitleTracks() {
  if (!videoPlayer.textTracks) return [];
  return Array.from(videoPlayer.textTracks).filter(function(t) {
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
    if (subtitlePanelOpen) {
      subtitlePanel.classList.add('hidden');
      subtitlePanelOpen = false;
    }
  }
}

function buildSubtitlePanel() {
  const subs = getSubtitleTracks();
  const listEl = document.getElementById('subtitleTrackList');
  listEl.innerHTML = '';

  const allOff = subs.every(function(t) {
    return t.mode !== 'showing';
  });
  const offItem = document.createElement('div');
  offItem.className = 'subtitle-track-item' + (allOff ? ' active' : '');
  offItem.textContent = 'Off';
  offItem.onclick = function() {
    subs.forEach(function(t) {
      t.mode = 'disabled';
    });
    buildSubtitlePanel();
    showTopControls();
  };
  listEl.appendChild(offItem);

  subs.forEach(function(track, i) {
    const item = document.createElement('div');
    const isActive = track.mode === 'showing';
    item.className = 'subtitle-track-item' + (isActive ? ' active' : '');

    const lang = track.language ? resolveLanguage(track.language) : null;
    const label = track.label || lang || ('Track ' + (i + 1));
    const kindLabel = track.kind === 'captions' ? ' [CC]' : '';
    item.textContent = label + kindLabel;

    item.onclick = function() {
      subs.forEach(function(t) {
        t.mode = 'disabled';
      });
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
    if (audioPanelOpen) {
      audioPanel.classList.add('hidden');
      audioPanelOpen = false;
    }
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
    if (audioPanelOpen) {
      audioPanel.classList.add('hidden');
      audioPanelOpen = false;
    }
  }
}

function buildAudioPanel() {
  const tracks = getAudioTracks();
  const listEl = document.getElementById('audioTrackList');
  listEl.innerHTML = '';

  // Count how many times each language appears so we can disambiguate
  // duplicates
  const langCount = {};
  tracks.forEach(function(t) {
    const k = t.language || '';
    langCount[k] = (langCount[k] || 0) + 1;
  });
  const langSeen = {};

  tracks.forEach(function(track, i) {
    const item = document.createElement('div');
    item.className = 'subtitle-track-item' + (track.enabled ? ' active' : '');

    const resolvedLang =
        track.language ? resolveLanguage(track.language) : null;
    const langKey = track.language || '';
    langSeen[langKey] = (langSeen[langKey] || 0) + 1;

    let name;
    if (track.label && track.label.trim()) {
      // Label is the most descriptive source ("English 5.1", "Deutsch
      // Director's Cut", etc.)
      name = track.label.trim();
    } else {
      name = resolvedLang || ('Track ' + (i + 1));
      // When the same language appears more than once and there's no label to
      // distinguish, append an ordinal so the user can tell them apart
      if (langCount[langKey] > 1) {
        name += ' ' + langSeen[langKey];
      }
    }

    // Kind badge for anything other than 'main'
    if (track.kind && track.kind !== 'main' && track.kind !== '') {
      name += ' [' + track.kind + ']';
    }

    item.textContent = name;
    item.onclick = function() {
      tracks.forEach(function(t) {
        t.enabled = false;
      });
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
    if (subtitlePanelOpen) {
      subtitlePanel.classList.add('hidden');
      subtitlePanelOpen = false;
    }
    buildAudioPanel();
    audioPanel.classList.remove('hidden');
  } else {
    audioPanel.classList.add('hidden');
  }
}

function reloadStream(auto) {
  if (currentChannelIndex < 0) return;
  if (vodPlay.active || vodMode !== 'live')
    return;  // live reloads pause while in Movies/Series
  const isAuto = auto === true;
  if (!isAuto)
    _reloadAttempts = 0;  // a manual reload restores the auto-reload budget
  stopStallWatchdog();
  const url = catchup && catchup.chIdx === currentChannelIndex ?
      catchup.url :
      channels[currentChannelIndex].url;
  const wasPlaying = !videoPlayer.paused;
  videoPlayer.pause();
  umsNoteCurrentId();
  if (loadLiveSource(url)) {
    umsRelease(liveUms);
    liveUms = null;
  } else
    liveUmsRefresh();
  if (wasPlaying || isAuto) videoPlayer.play().catch(e => console.log);
  startStallWatchdog();
  statusArea.innerText = isAuto ?
      `🔄 Reloading (${_reloadAttempts}/${MAX_AUTO_RELOADS}) …` :
      '🔄 Reloading ...';
  setTimeout(
      () => statusArea.innerText =
          `▶️ ${channels[currentChannelIndex].name}`,
      2000);
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
  const yesHandler = () => {
    onYes();
    confirmDialog.classList.add('hidden');
    confirmYes.removeEventListener('click', yesHandler);
    confirmNo.removeEventListener('click', noHandler);
  };
  const noHandler = () => {
    confirmDialog.classList.add('hidden');
    confirmYes.removeEventListener('click', yesHandler);
    confirmNo.removeEventListener('click', noHandler);
  };
  confirmYes.addEventListener('click', yesHandler);
  confirmNo.addEventListener('click', noHandler);
}

function goToHomeScreen() {
  // Abort any in-flight fetches
  if (_epgAbortController) {
    _epgAbortController.abort();
    _epgAbortController = null;
  }
  if (_m3uAbortController) {
    _m3uAbortController.abort();
    _m3uAbortController = null;
  }

  // Stop all timers
  if (epgRefreshTimer) {
    clearInterval(epgRefreshTimer);
    epgRefreshTimer = null;
  }
  if (controlsTimeout) {
    clearTimeout(controlsTimeout);
    controlsTimeout = null;
  }
  if (_epgToastTimer) {
    clearTimeout(_epgToastTimer);
    _epgToastTimer = null;
  }

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
  _epgWinStart = 0;
  _epgWinEnd = 0;
  _epgTotalGuideW = 0;
  _epgSkeletonWinStart = 0;
  _epgX = 0;
  _epgPrevFocusIdx = -1;
  if (_epgPersistTimer)
    flushEpgPersist();  // write what the last session fetched before the key
                        // changes
  _playlistCacheAt = 0;
  _m3uSource = null;
  catchup = null;
  epgFocusT = 0;
  _epgFullFetched.clear();
  _epgFullPending.clear();
  EPG_WIN_HOURS = EPG_PAST_HOURS_MIN + EPG_AHEAD_HOURS;

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
  stdFocusZone = 'channels';
  stdFocusIdx = 0;
  stdGroupFocusIdx = 0;
  _reloadAttempts = 0;
  channels = [];
  currentFilteredChannels = [];
  groupsList = [];
  channelIndexMap.clear();
  _searchCache = {query: null, result: null};
  currentChannelIndex = -1;
  lastChannelIndex = -1;
  currentSearchQuery = '';
  selectedPlaylistId = null;

  // Reset app state (also restores the standard layout if the guide was
  // showing)
  if (vodPlay.active) stopVodPlayback(false);
  if (livePlayer.active) exitLivePlayer();
  umsRelease(liveUms);
  liveUms = null;
  resetVodState(false);
  exitEPGMode();
  _activePlaylistKey = null;
  _epgShiftOn = false;
  _epgTz = '';
  _epgExtraMs = 0;
  favoriteIds = new Set();  // favorites belong to a playlist; the next one
                            // applied loads its own
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
  setTimeout(() => {
    updateFocusableElements();
    focusElement(0);
  }, 100);
}

function toggleGroupsColumn() {
  groupsColumnVisible = !groupsColumnVisible;
  groupsColumn.classList.toggle('collapsed', !groupsColumnVisible);
  toggleGroupsBtn.innerHTML = groupsColumnVisible ? '◀ Hide' : '▶ Show';
  showGroupsBtn.style.display = groupsColumnVisible ? 'none' : 'block';
  const floatingBtn = document.getElementById('epgFloatingGroupsBtn');
  if (floatingBtn)
    floatingBtn.style.display =
        (currentPlaylistType === 'xtream' && !groupsColumnVisible) ? '' :
                                                                     'none';
  if (currentPlaylistType === 'xtream')
    requestAnimationFrame(updateEPGNowMarker);
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
