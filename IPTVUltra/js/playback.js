/**
 * @fileoverview Stall watchdog, live video control, and the start page tabs.
 */

// ----- Stall Watchdog -----
// A frozen picture (the playhead does not move, readyState 3 or 4) gets this
// number of times the checks of a stall before a reload.
const STALL_FROZEN_FACTOR = 2;
function startStallWatchdog() {
  stopStallWatchdog();
  stallLastTime = -1;
  stallCount = 0;
  _stallGoodChecks = 0;
  _stallBufEnd = 0;
  _stallBufAt = 0;
  stallWatchdogTimer = setInterval(function() {
    // hls.js with no media yet waits for a relay (see livePlaylistLoader). Its
    // own timeouts stop a dead server. A placeholder (black.ts) stops at its
    // end, and a reload cannot make the event start.
    // A channel that waits for the load of hls.js has no source.
    // A live stream that ended (the provider closed a .ts stream) is a stall:
    // the element is paused at `ended`. Only an Xtream live .ts URL: an M3U
    // file and a placeholder (black.ts with ENDLIST) also end.
    const liveEnded = videoPlayer.ended && vodMode === 'live' && !catchup &&
        !vodPlay.active &&
        (_RE_LIVE_TS.test(videoPlayer.currentSrc || '') || _srcNoEnd);
    if ((videoPlayer.paused && !liveEnded) || currentChannelIndex < 0 ||
        liveEngine.hlsWait ||
        (liveEngineActive() &&
         (videoPlayer.readyState === 0 || liveEngine.placeholder))) {
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
    // Shaka Player sets the playback rate to 0 while it waits for data, and
    // the element then keeps readyState 4 (seen on the C4, 2026-10-26)
    const waits = videoPlayer.readyState < 3 ||
        (!!liveEngine.shaka && liveEngine.shaka.isBuffering());
    // A playhead that does not move with data (readyState 3 or 4) is a frozen
    // picture. It is not good playback, but it gets more time than a stall.
    const limit = waits ? STALL_THRESHOLD_CHECKS :
                          STALL_FROZEN_FACTOR * STALL_THRESHOLD_CHECKS;
    if (t === stallLastTime) {
      stallCount++;
      _stallGoodChecks = 0;
      if (stallCount >= limit && bufEnd - t < 2 && !liveEnded &&
          Date.now() - _stallBufAt < STALL_ALIVE_MS) {
        stallCount = limit - 1;  // slow, not dead: wait
      } else if (stallCount >= limit) {
        stallCount = 0;
        stallLastTime = -1;
        noteStreamFail(
            liveEngineName(),
            `No progress for ${limit * 2} s (readyState ${
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
        reloadStream(true, 'watchdog');
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
        `${name ? name + ': ' : ''}${msg}${tried}. ${
            consRecheckPending() ?
                'Checking whether another device is using this account…' :
                'Press Reload to retry.'}`,
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
  placeLiveNotice();
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
  _cancelHold();
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
      const fi = playingListIndex(currentFilteredChannels);
      if (fi >= 0) {
        epgFocusedRowIdx = fi;
        updateEPGRowFocus();
      }
    } else {
      const fi = playingListIndex(currentFilteredChannels);
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
// Saves the channel that you selected and the previous channel in the playlist
// data: the next start selects the best version again, the cursor finds the
// row, and the previous channel (long press of OK, Red) stays.
function noteSelectedChannel() {
  if (!_activePlaylistKey || currentChannelIndex < 0) return;
  const ps = getPlaylistState(_activePlaylistKey);
  const sel = channels[_bestFrom] || channels[currentChannelIndex];
  if (!sel) return;
  ps.lastChannel = {url: sel.url, tvgId: sel.tvgId || ''};
  const prev = channels[lastChannelIndex];
  if (prev) ps.prevChannel = {url: prev.url, tvgId: prev.tvgId || ''};
  savePlaylistState();
}
// True while the live stream plays with no error: a selection of the channel
// that plays does not need to load it again
function playingStreamHealthy() {
  return currentChannelIndex >= 0 && !catchup && !vodPlay.active &&
      vodMode === 'live' && !!stallWatchdogTimer && !_errRetryTimer &&
      !videoPlayer.error && !videoPlayer.ended;
}
// The previous channel is never the channel that plays. If a change made it
// that channel, the value from before the change comes back (or -1).
// True when the source had no end (duration Infinity) at its metadata: a live
// stream. An M3U file and a placeholder playlist have a duration.
let _srcNoEnd = false;
videoPlayer.addEventListener('loadedmetadata', () => {
  _srcNoEnd = !Number.isFinite(videoPlayer.duration);
});
videoPlayer.addEventListener('emptied', () => {
  _srcNoEnd = false;
});
// An Xtream live stream as 1 continuous MPEG-TS stream
const _RE_LIVE_TS = /\/live\/[^/]+\/[^/]+\/\d+\.ts(\?|$)/;
function keepPreviousChannel(prevLast) {
  if (!isPlayingIdx(lastChannelIndex)) return;
  lastChannelIndex =
      prevLast >= 0 && channels[prevLast] && !isPlayingIdx(prevLast) ?
      prevLast :
      -1;
}
function selectChannel(index) {
  if (!channels[index]) return;
  // A selection of a channel plays its best measured version (Settings, "Best
  // version automatically"). A retry of the selection (`_bestFrom`) gets the
  // best version again, or the selected channel if that version failed.
  const picked = index, prevLast = lastChannelIndex;
  let better = -1;
  // Also the end of a catch-up of a different channel (`_returningLive`)
  // A selection during a catch-up goes back to live, also on the same row.
  if (!_selectingAlt && !_selectingExact &&
      (index !== currentChannelIndex || index === _bestFrom || _returningLive ||
       catchup)) {
    better = bestVersionOf(index);
    if (better >= 0) index = better;
  }
  // The selection plays already (a different row of the same stream): no
  // reload. The provider counts the previous connection for approximately 15 s.
  // Also the row of the version that plays, when a different row selected it.
  // Only when the stream plays: a stream with an error loads again.
  const userPick = !_selectingAlt && !_selectingExact && !_returningLive;
  if (userPick && index === currentChannelIndex &&
      (better >= 0 || _bestFrom >= 0) && playingStreamHealthy()) {
    surfCancel();
    // A different channel row that plays the same stream: the previous
    // selection becomes the previous channel
    if (!isPlayingIdx(picked) && picked !== _altOrigin && _altOrigin >= 0 &&
        channels[_altOrigin])
      lastChannelIndex = _altOrigin;
    _bestFrom = better >= 0 ? picked : -1;
    _bestIdx = better >= 0 ? index : -1;
    _altOrigin = picked;
    _altTried = new Set([index]);
    noteRecentChannel(channels[picked]);
    keepPreviousChannel(prevLast);
    noteSelectedChannel();
    markPlayingRows();
    if (livePlayer.active) showVodOsd();
    return;
  }
  if (vodPlay.active) stopVodPlayback(false);
  stopStallWatchdog();
  _cancelHold();   // a seek of the previous channel must not go to this one
  catchup = null;  // any channel selection returns to live
  surfCancel();
  if (_selectingAlt) {
    // fallback to another source of the same channel: not a channel change for
    // history purposes. The selected channel stays the selected row.
    _bestFrom =
        _altOrigin >= 0 && _altOrigin !== index && channels[_altOrigin] ?
        _altOrigin :
        -1;
  } else if (_keepSelection) {
    // The version that plays loads again (the return from Movies or Series,
    // the end of a catch-up): the caller set the selection
    _altTried = new Set([index]);
  } else {
    // A retry of the selection, a version of it from the Versions menu, or the
    // end of a catch-up is not a channel change
    const sameSel = _returningLive || isPlayingIdx(picked) ||
        picked === _altOrigin ||
        (_selectingExact && _altOrigin >= 0 &&
         versionsOf(_altOrigin).includes(picked));
    if (!sameSel && currentChannelIndex >= 0)
      lastChannelIndex = _altOrigin >= 0 && channels[_altOrigin] ?
          _altOrigin :
          currentChannelIndex;
    _bestFrom = better >= 0 ? picked : -1;
    _bestIdx = better >= 0 ? index : -1;
    _altOrigin = picked;
    _altTried = new Set([index]);
    if (!_returningLive) noteRecentChannel(channels[picked]);
  }
  const cause = _selectingAlt       ? 'alternative source' :
      currentChannelIndex === index ? 'same channel again' :
                                      '';
  const prevPlaying =
      currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
  currentChannelIndex = index;
  keepPreviousChannel(prevLast);
  _reloadAttempts = 0;
  if (_errRetryTimer) {
    clearTimeout(_errRetryTimer);
    _errRetryTimer = null;
  }
  const ch = channels[index];
  videoPlayer.pause();
  umsNoteCurrentId();
  if (loadLiveSource(ch.url, cause)) {
    umsRelease(liveUms);
    liveUms = null;
  } else
    liveUmsRefresh();
  videoPlayer.play().catch(e => console.log);
  startStallWatchdog();
  channelInfoTag.innerText = `📺 ${ch.name}`;
  channelInfoTag.style.visibility = '';
  statusArea.innerText = `▶️ ${ch.name}`;
  noteSelectedChannel();
  if (better >= 0) {
    const t = streamTechOf(ch, index);
    showEPGToast(
        `${ch.name}${t ? ' · ' + streamTechLabel(t) : ''}`, 'success',
        'Best version');
    hideEPGToast(3000);
  }
  if (epgMode) {
    // Don't rebuild the EPG grid — just update active row highlighting in-place
    markPlayingRows();
    const filteredIdx = playingListIndex(currentFilteredChannels);
    // The cursor goes to the channel that plays. Thus, Up and Down start from
    // that row also after a pointer click or a long press of OK. An
    // alternative source after a failure moves the cursor only if the cursor
    // was on the row that played: you can scroll the guide during a failure.
    const followAlt = !_selectingAlt ||
        (prevPlaying &&
         currentFilteredChannels[epgFocusedRowIdx] === prevPlaying);
    if (filteredIdx >= 0 && filteredIdx !== epgFocusedRowIdx && followAlt) {
      epgFocusedRowIdx = filteredIdx;
      epgFocusT = 0;
      updateEPGRowFocus();
    }
    updateEPGInfoPanel(ch);
  } else {
    // Update the active row in place — no list rebuild
    markPlayingRows();
    const fi = playingListIndex(currentFilteredChannels);
    if (fi >= 0) {
      stdFocusIdx = fi;
      stdFocusZone = 'channels';
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

/**
 * Loads the current live channel again.
 * @param {boolean|!Event=} auto True for an automatic reload. The Reload
 *     button gives its click event.
 * @param {string=} cause The cause, for the diagnostics log.
 */
function reloadStream(auto, cause) {
  if (currentChannelIndex < 0) return;
  if (vodPlay.active || vodMode !== 'live')
    return;  // live reloads pause while in Movies/Series
  // A waiting error retry does not load the stream a second time
  if (_errRetryTimer) {
    clearTimeout(_errRetryTimer);
    _errRetryTimer = null;
  }
  _clearSteps();
  const isAuto = auto === true;
  if (!isAuto)
    _reloadAttempts = 0;  // a manual reload restores the auto-reload budget
  stopStallWatchdog();
  const c = catchup && catchup.chIdx === currentChannelIndex ? catchup : null;
  // A catch-up continues from the position in the program. Before the
  // metadata of the stream, the position is not known: keep the last value.
  if (c && videoPlayer.readyState >= 1 && videoPlayer.currentTime > 0)
    c.seekTo = videoPlayer.currentTime;
  const url = c ? c.url : channels[currentChannelIndex].url;
  const wasPlaying = !videoPlayer.paused;
  videoPlayer.pause();
  umsNoteCurrentId();
  const why = typeof cause === 'string' ? cause :
      isAuto                            ? 'automatic reload' :
                                          'Reload button';
  if (loadLiveSource(url, why)) {
    umsRelease(liveUms);
    liveUms = null;
  } else
    liveUmsRefresh();
  // Shaka Player gets the position with its load (loadShakaSource)
  if (c && !liveEngine.shaka) catchupSeekOnLoad(c);
  if (wasPlaying || isAuto) videoPlayer.play().catch(e => console.log);
  startStallWatchdog();
  const reloading = isAuto ?
      `🔄 Reloading (${_reloadAttempts}/${MAX_AUTO_RELOADS}) …` :
      '🔄 Reloading ...';
  statusArea.innerText = reloading;
  setTimeout(() => {
    // The user can go to the start page in the 2 s, and a different message
    // (account, placeholder) can replace the text
    const ch = channels[currentChannelIndex];
    if (ch && statusArea.innerText === reloading)
      statusArea.innerText = `▶️ ${ch.name}`;
  }, 2000);
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
  // The live timers must not reload or seek a stream on the start page
  stopStallWatchdog();
  if (_errRetryTimer) {
    clearTimeout(_errRetryTimer);
    _errRetryTimer = null;
  }
  _cancelHold();

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
  xmltvSetSource('');
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
  _bestFrom = -1;
  _bestIdx = -1;
  _bestFailed.clear();
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
    xtreamEpgUrl.value = p.epgUrl || '';
    xtreamName.value = p.name || '';
  } else {
    switchTab('m3u');
    newM3uUrl.value = p.url;
    newM3uName.value = p.name;
    newEpgUrl.value = p.epgUrl || '';
  }
}
