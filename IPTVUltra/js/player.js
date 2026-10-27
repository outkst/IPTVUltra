/**
 * @fileoverview App-owned player for live and VOD, audio and subtitle tracks,
 * and the webOS media service.
 */

// ── playback ─────────────────────────────────────────────────
function _inPlayerMode() {
  return playerActive() && !settingsOpen && !diagOpen && !versionsOpen &&
      !(confirmDialog && !confirmDialog.classList.contains('hidden'));
}
function showPlayerControls() {
  if (playerActive())
    showVodOsd();
  else
    showTopControls();
}
function vodNextVisible() {
  return !document.getElementById('vodNext').classList.contains('hidden');
}
function restoreLiveVideoSlot() {
  const wrap = (currentPlaylistType === 'xtream' && epgMode) ?
      document.getElementById('epgVideoWrap') :
      videoArea;
  if (videoPlayer.parentNode !== wrap) {
    if (wrap === videoArea)
      videoArea.insertBefore(videoPlayer, videoArea.firstChild);
    else
      wrap.appendChild(videoPlayer);
  }
  const badge = document.getElementById('pbTrickBadge');
  if (badge && badge.parentNode !== videoArea) videoArea.appendChild(badge);
  placeLiveNotice();
}
function startVodPlayback(p) {
  if (!_xt) return;
  const key = p.kind === 'movie' ?
      progressKeyFor('movie', p.item.id) :
      progressKeyFor('episode', p.ep.id, p.item.id);
  const saved = vodProgress[key];
  const resumeAt =
      (!p.restart && saved && !saved.watched && saved.dur &&
       saved.pos >= vodMinResume(saved.dur) && saved.pos < saved.dur * 0.9) ?
      saved.pos :
      0;
  if (p.restart && saved) {
    delete vodProgress[key];
    saveJson('iptv_vod_progress', vodProgress);
  }
  if (vodPlay.active) {
    saveVodProgress(true);
    clearVodNext();
  }
  stopStallWatchdog();
  if (_errRetryTimer) {
    clearTimeout(_errRetryTimer);
    _errRetryTimer = null;
  }
  vodPlay.active = true;
  vodPlay.kind = p.kind;
  vodPlay.key = key;
  vodPlay.item = p.item;
  vodPlay.ep = p.ep || null;
  vodPlay.season = p.season || null;
  vodPlay.epIdx = p.epIdx;
  vodPlay.seasons = p.seasons || null;
  vodPlay.resumeAt = resumeAt;
  vodPlay.dur = (p.ep ? p.ep.duration : (p.info && p.info.duration)) ||
      (saved && saved.dur) || 0;
  vodPlay.saveAt = 0;
  vodPlay.ended = false;
  vodPlay.subManual = false;
  vodPlay.audioManual = false;
  closeVodTracks();
  vodPlay.title = p.kind === 'movie' ?
      p.item.name :
      `${p.item.name} · S${p.season} E${p.ep.num}${
          p.ep.title ? ' · ' + p.ep.title : ''}`;
  vodPlay.sub = p.kind === 'movie' ?
      [yearOf(p.info && p.info.releaseDate), fmtRuntime(vodPlay.dur)]
          .filter(Boolean)
          .join(' · ') :
      [`Season ${p.season}`, fmtRuntime(vodPlay.dur)].filter(Boolean).join(
          ' · ');
  if (resumeAt) vodPlay.sub += ` · Resumed from ${fmtClock(resumeAt)}`;
  const player = document.getElementById('vodPlayer'),
        slot = document.getElementById('vodVideoSlot');
  if (videoPlayer.parentNode !== slot) slot.appendChild(videoPlayer);
  const badge = document.getElementById('pbTrickBadge');
  if (badge && badge.parentNode !== player) player.appendChild(badge);
  videoPlayer.removeAttribute('controls');
  player.classList.remove('hidden');
  document.getElementById('vodPaused').classList.add('hidden');
  document.getElementById('vodLoading').classList.remove('hidden');
  document.getElementById('vodNext').classList.add('hidden');
  vodNav.screen = 'player';
  const url = p.kind === 'movie' ?
      vodStreamUrl(p.item.id, (p.info && p.info.ext) || p.item.ext) :
      episodeUrl(p.ep);
  vodPlay.syncMs = vodSubSync[key] || 0;
  player.focus = 'bar';
  player.btn = 0;
  player.btns = [];
  _nativeRate = 0;
  umsRelease(liveUms);
  liveUms = null;
  liveEngineDestroy();
  umsNoteCurrentId();
  const techEl = document.getElementById('vodOsdTech');
  if (techEl) techEl.textContent = vodTech[key] || '';
  videoPlayer.pause();
  // A Shaka Player live engine removes the src attribute at the end of its
  // asynchronous detach; the VOD source waits for it. The media service
  // attach and the play also wait: the pipeline of the movie does not exist
  // before the source.
  afterLiveTeardown(() => {
    if (!vodPlay.active) return;  // the player closed during the teardown
    videoPlayer.src = url;
    videoPlayer.load();
    umsAttach();
    if (resumeAt > 0)
      videoPlayer.addEventListener('loadedmetadata', function seekOnce() {
        try {
          videoPlayer.currentTime = resumeAt;
        } catch (_) { /* not seekable yet */
        }
      }, {once: true});
    videoPlayer.addEventListener('loadedmetadata', function tracksOnce() {
      applyVodTrackPrefs();
    }, {once: true});
    setTimeout(() => {
      if (vodPlay.active) applyVodTrackPrefs();
    }, 4000);  // some files announce tracks late
    videoPlayer.play().catch(() => {});
  });
  statusArea.innerText = `▶️ ${vodPlay.title}`;
  updateVodOsd();
  showVodOsd();
}
function stopVodPlayback(backToDetails) {
  if (!vodPlay.active) return;
  saveVodProgress(true);
  clearVodNext();
  _scrubPos =
      null;  // abandon any scrub in progress; no seek/play on the way out
  _nativeRate = 0;  // the pipeline is being unloaded; nothing to restore
  if (_isHolding()) _stopHold();
  _holdKeyDir = null;
  closeVodTracks();
  umsDetach();
  videoPlayer.querySelectorAll('track').forEach(t => t.remove());
  if (vodPlay.osdTimer) {
    clearTimeout(vodPlay.osdTimer);
    vodPlay.osdTimer = null;
  }
  videoPlayer.pause();
  videoPlayer.removeAttribute('src');
  videoPlayer.load();
  vodPlay.active = false;
  document.getElementById('vodPlayer').classList.add('hidden');
  hideVodOsd();
  restoreLiveVideoSlot();
  if (backToDetails !== false && vodMode !== 'live') {
    vodNav.screen = 'details';
    const d = vodNav.detail;
    if (d && d.item.kind === 'series' && d.info && d.info.seasons.length) {
      // Put the cursor on the episode to watch next
      const t = seriesPlayTarget(d.item, d.info);
      if (t) {
        vodNav.season = t.si;
        vodNav.epIdx = t.ei;
        vodNav.detailZone = 'episodes';
      }
    }
    renderVodDetails();
  }
}
function saveVodProgress(force) {
  if (!vodPlay.active || !vodPlay.key) return;
  const now = Date.now();
  if (!force && now - vodPlay.saveAt < 10000) return;
  const pos = videoPlayer.currentTime || 0;
  const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) ||
      vodPlay.dur || 0;
  vodPlay.saveAt = now;
  if (!vodPlay.ended && pos < vodMinResume(dur))
    return;  // not "in progress" yet
  const it = vodPlay.item;
  const watched = vodPlay.ended || (dur > 0 && pos / dur >= 0.9);
  const e = {
    kind: vodPlay.kind,
    id: vodPlay.kind === 'movie' ? it.id : vodPlay.ep.id,
    name: it.name,
    icon: it.icon,
    ext: it.ext,
    catId: it.catId,
    rating: it.rating || 0,
    pos: watched ? dur : pos,
    dur,
    at: now,
    watched
  };
  if (vodPlay.kind === 'episode') {
    e.seriesId = it.id;
    e.season = vodPlay.season;
    e.epNum = vodPlay.ep.num;
    e.epTitle = vodPlay.ep.title;
    e.epId = vodPlay.ep.id;
    e.lastOfSeries = !nextEpisode();
  }
  vodProgress[vodPlay.key] = e;
  pruneVodProgress();
  saveJson('iptv_vod_progress', vodProgress);
}
function updateVodOsd(posOverride) {
  if (livePlayer.active && !vodPlay.active) {
    updateLiveOsd();
    return;
  }
  const pos =
      posOverride !== undefined ? posOverride : (videoPlayer.currentTime || 0);
  const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) ||
      vodPlay.dur || 0;
  document.getElementById('vodOsdTitle').textContent = vodPlay.title || '';
  document.getElementById('vodOsdSub').textContent = vodPlay.sub || '';
  const pct = dur ? Math.min(100, pos / dur * 100) : 0;
  document.getElementById('vodBarFill').style.width = pct + '%';
  document.getElementById('vodBarKnob').style.left = pct + '%';
  document.getElementById('vodTimePos').textContent = fmtClock(pos);
  document.getElementById('vodTimeRem').textContent =
      dur ? '−' + fmtClock(Math.max(0, dur - pos)) : '';
}
// Live banner: channel number + name, group and current programme, programme
// progress as the bar
function updateLiveOsd() {
  const ch = currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
  if (!ch) return;
  if (catchup && catchup.chIdx === currentChannelIndex) {
    // Catch-up: the programme being replayed, its position as the bar
    const p = catchup.prog;
    document.getElementById('vodOsdTitle').textContent =
        `${chDisplayNum(ch, currentChannelIndex)}  ${ch.name} · ⏪ Catch-up`;
    document.getElementById('vodOsdSub').textContent =
        `${p.title} · ${formatClock(p.start)} – ${formatClock(p.stop)}`;
    const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) ||
        catchup.dur || 0;
    const pos = videoPlayer.currentTime || 0;
    const pct = dur ? Math.min(100, pos / dur * 100) : 0;
    document.getElementById('vodBarFill').style.width = pct + '%';
    document.getElementById('vodBarKnob').style.left = pct + '%';
    document.getElementById('vodTimePos').textContent = fmtClock(pos);
    document.getElementById('vodTimeRem').textContent =
        dur ? '−' + fmtClock(Math.max(0, dur - pos)) : '';
    if (!document.getElementById('vodOsd').dataset.catchup) {
      document.getElementById('vodOsd').dataset.catchup = '1';
      renderPlayerButtons();
    }
    return;
  }
  if (document.getElementById('vodOsd').dataset.catchup) {
    document.getElementById('vodOsd').dataset.catchup = '';
    renderPlayerButtons();
  }
  const sc = surfChannel();
  if (sc) {
    // Channel surfing: the banner describes the previewed channel, not the one
    // playing
    const now = getCurrentProgramme(sc.tvgId),
          next = getNextProgramme(sc.tvgId);
    document.getElementById('vodOsdTitle').textContent =
        `${chDisplayNum(sc, getChannelIndex(sc))}  ${sc.name}`;
    document.getElementById('vodOsdSub').textContent = [
      sc.group || '', now ? now.title : (sc.tvgId ? 'Loading program …' : '')
    ].filter(Boolean).join(' · ');
    let pct = 0;
    if (now && now.stop > now.start)
      pct = Math.min(
          100,
          Math.max(0, (Date.now() - now.start) / (now.stop - now.start) * 100));
    document.getElementById('vodBarFill').style.width = pct + '%';
    document.getElementById('vodBarKnob').style.left = pct + '%';
    document.getElementById('vodTimePos').textContent =
        now ? `${formatClock(now.start)} – ${formatClock(now.stop)}` : '';
    document.getElementById('vodTimeRem').textContent =
        next ? `Next: ${next.title} · ${formatClock(next.start)}` : '';
    document.getElementById('vodOsdTech').textContent =
        `▲ ▼ browse · OK watch · Back cancel · ${surf.idx + 1} / ${
            currentFilteredChannels.length}`;
    return;
  }
  const now = getCurrentProgramme(ch.tvgId), next = getNextProgramme(ch.tvgId);
  document.getElementById('vodOsdTitle').textContent =
      `${chDisplayNum(ch, currentChannelIndex)}  ${ch.name}`;
  const subBits = [ch.group || '', now ? now.title : ''].filter(Boolean);
  document.getElementById('vodOsdSub').textContent = subBits.join(' · ');
  let pct = 0;
  if (now && now.stop > now.start)
    pct = Math.min(
        100,
        Math.max(0, (Date.now() - now.start) / (now.stop - now.start) * 100));
  document.getElementById('vodBarFill').style.width = pct + '%';
  document.getElementById('vodBarKnob').style.left = pct + '%';
  const behind = liveBehindSecs();
  document.getElementById('vodTimePos').textContent = behind > 5 ?
      `⏪ −${fmtClock(behind)} behind live` :
      (now ? `${formatClock(now.start)} – ${formatClock(now.stop)}` : 'LIVE');
  document.getElementById('vodTimeRem').textContent = next ?
      `Next: ${next.title} · ${formatClock(next.start)}` :
      (now ? `${
                 Math.max(
                     0, Math.ceil((now.stop - Date.now()) / 60000))} min left` :
             '');
  const wasBehind = !!document.getElementById('vodOsd').dataset.behind;
  if ((behind > 5) !== wasBehind) {
    document.getElementById('vodOsd').dataset.behind = behind > 5 ? '1' : '';
    renderPlayerButtons();
  }  // Go live button appears/disappears
}
function showVodOsd() {
  const osd = document.getElementById('vodOsd');
  updateVodOsd();
  renderPlayerButtons();
  osd.classList.add('visible');
  if (vodPlay.osdTimer) clearTimeout(vodPlay.osdTimer);
  vodPlay.osdTimer = setTimeout(() => {
    if (videoPlayer.paused && !surf.active) return;  // keep it up while paused
    osd.classList.remove('visible');
    surfCancel();  // a preview that was not tuned is dropped with the banner
    player.focus = 'bar';  // next Up always starts from the bar
    updatePlayerFocus();
  }, surf.active ? 5000 : 3000);
}
function hideVodOsd() {
  const osd = document.getElementById('vodOsd');
  osd.classList.remove('visible');
  surfCancel();
  if (vodPlay.osdTimer) {
    clearTimeout(vodPlay.osdTimer);
    vodPlay.osdTimer = null;
  }
  player.focus = 'bar';
  updatePlayerFocus();
}
function toggleVodPause() {
  if (videoPlayer.paused)
    videoPlayer.play().catch(() => {});
  else
    videoPlayer.pause();
  document.getElementById('vodPaused')
      .classList.toggle('hidden', !videoPlayer.paused);
  showVodOsd();
}
// OSD button row. Up from the bar focuses it (CC first), Left/Right move, OK
// activates; Down returns to the bar.
function playerButtonsFor() {
  const btns = [];
  if (vodPlay.active) {
    if (vodPlay.kind === 'episode' && nextEpisode())
      btns.push({
        id: 'next',
        label: '⏭ Next episode',
        act: () => {
          vodPlay.nextEp = nextEpisode();
          clearVodNext();
          playNextEpisode();
        }
      });
    btns.push({
      id: 'cc',
      label: 'CC Audio & Subtitles',
      act: () => {
        if (vodTracksOpen())
          closeVodTracks();
        else
          openVodTracks();
      }
    });
    btns.push({
      id: 'settings',
      label: '⚙️ Settings',
      act: () => {
        closeVodTracks();
        openSettings();
      }
    });
  } else if (livePlayer.active) {
    if (catchup)
      btns.push({id: 'live', label: '⏩ Back to live', act: catchupBackToLive});
    else if (liveBehindSecs() > 5)
      btns.push({id: 'live', label: '⏩ Go live', act: liveGoLive});
    btns.push({
      id: 'cc',
      label: 'CC Audio & Subtitles',
      act: () => {
        if (vodTracksOpen())
          closeVodTracks();
        else
          openVodTracks();
      }
    });
    if (!catchup && versionsOf(currentChannelIndex).length > 1)
      btns.push({
        id: 'versions',
        label: '⇄ Versions',
        act: () => {
          closeVodTracks();
          openVersions(currentChannelIndex);
        }
      });
    btns.push({
      id: 'guide',
      label: currentPlaylistType === 'xtream' ? '📺 Guide' : '📡 Channels',
      act: exitLivePlayer
    });
    btns.push({
      id: 'settings',
      label: '⚙️ Settings',
      act: () => {
        closeVodTracks();
        openSettings();
      }
    });
  }
  return btns;
}
function renderPlayerButtons() {
  const box = document.getElementById('vodOsdBtns');
  if (!box) return;
  const btns = playerButtonsFor();
  const keep = player.btns[player.btn] && player.btns[player.btn].id;
  player.btns = btns;
  let idx = btns.findIndex(b => b.id === keep);
  if (idx < 0) idx = btns.findIndex(b => b.id === 'cc');
  player.btn = Math.max(0, idx);
  // Rebuild only when the set of buttons changes. The pointer's mousemove calls
  // this constantly; replacing the elements under the Magic Remote cursor made
  // clicks land on nothing.
  const sig = btns.map(b => b.id).join(',');
  if (box.dataset.sig !== sig || box.children.length !== btns.length) {
    box.innerHTML = '';
    btns.forEach(b => {
      const el = document.createElement('button');
      el.className = 'vod-osd-btn' + (b.id === 'cc' ? ' vod-cc-btn' : '');
      el.dataset.id = b.id;
      if (b.id === 'cc') el.id = 'vodCcBtn';
      box.appendChild(el);
    });
    box.dataset.sig = sig;
  }
  Array.from(box.children).forEach((el, i) => {
    const b = btns[i];
    if (el.textContent !== b.label) el.textContent = b.label;
    el.onclick = e => {
      e.stopPropagation();
      player.btn = i;
      b.act();
    };
  });
  updatePlayerFocus();
}
function updatePlayerFocus() {
  const osd = document.getElementById('vodOsd');
  if (!osd) return;
  osd.classList.toggle('bar-focused', player.focus === 'bar');
  const els = osd.querySelectorAll('.vod-osd-btn');
  els.forEach(
      (el, i) => el.classList.toggle(
          'focused', player.focus === 'buttons' && i === player.btn));
  const u = activeUms();
  const on = u ? u.selectedSub >= 0 :
                 getSubtitleTracks().some(t => t.mode === 'showing');
  const cc = document.getElementById('vodCcBtn');
  if (cc) cc.classList.toggle('on', on);
}
function activatePlayerButton() {
  const b = player.btns[player.btn];
  if (b) b.act();
}
function handleVodPlayerKey(e, up, down, left, right, enter) {
  if (e.keyCode === 404 || e.key === 'ColorF1Green') {
    e.preventDefault();
    if (vodTracksOpen())
      closeVodTracks();
    else
      openVodTracks();
    return;
  }
  if (e.keyCode === 405 || e.key === 'ColorF2Yellow') {
    e.preventDefault();
    closeVodTracks();
    openSettings();
    return;
  }  // subtitle style etc., applied live
  if (vodTracksOpen()) {
    const it = vodPlay.tracksItems[vodPlay.tracksFocus];
    if (up || down) {
      e.preventDefault();
      moveVodTracksFocus(up ? -1 : 1);
    } else if ((left || right) && it && it.kind === 'sync') {
      e.preventDefault();
      umsSetSync(vodPlay.syncMs + (right ? 250 : -250));
      renderVodTracks();
    } else if (left || right || enter)
      e.preventDefault();  // Enter handled on keyup
    return;
  }
  if (vodNextVisible()) {
    if (left || right) {
      e.preventDefault();
      vodPlay.nextFocus = left ? 'play' : 'cancel';
      updateVodNextFocus();
    } else if (up || down)
      e.preventDefault();
    return;  // Enter is handled by the shared keyup listener
  }
  const osdVisible =
      document.getElementById('vodOsd').classList.contains('visible');
  // Up/Down with the OSD hidden only show the OSD. The auto-repeat of the same
  // key is ignored until the key is released.
  if ((up || down) && e.repeat && player.wakeKey === e.keyCode) {
    e.preventDefault();
    return;
  }
  player.wakeKey = 0;
  if ((up || down) && !osdVisible) {
    e.preventDefault();
    player.wakeKey = e.keyCode;
    player.focus = 'bar';
    showVodOsd();
    return;
  }
  if (livePlayer.active && !vodPlay.active) {
    // Red: previous channel
    if (e.keyCode === 403 || e.key === 'ColorF0Red') {
      e.preventDefault();
      surfCancel();
      if (swapToPreviousChannel()) showVodOsd();
      return;
    }
    // Channel surfing: Down on the bar starts it, then Up/Down move the preview
    if ((up || down) && (surf.active || (down && player.focus === 'bar'))) {
      e.preventDefault();
      surfStep(down ? 1 : -1);
      return;
    }
  }
  if (up) {
    e.preventDefault();
    if (player.focus === 'bar') player.focus = 'buttons';
    showVodOsd();
  } else if (down) {
    e.preventDefault();
    player.focus = 'bar';
    showVodOsd();
  } else if ((left || right) && player.focus === 'buttons') {
    e.preventDefault();
    if (player.btns.length)
      player.btn = (player.btn + (right ? 1 : -1) + player.btns.length) %
          player.btns.length;
    showVodOsd();
  } else if (enter)
    e.preventDefault();  // handled on keyup: button activation or play/pause on
                         // the bar
}
function nextEpisode() {
  if (vodPlay.kind !== 'episode' || !vodPlay.seasons) return null;
  const si = vodPlay.seasons.findIndex(s => s.num === vodPlay.season);
  if (si < 0) return null;
  const eps = vodPlay.seasons[si].episodes;
  if (vodPlay.epIdx + 1 < eps.length)
    return {
      season: vodPlay.season,
      epIdx: vodPlay.epIdx + 1,
      ep: eps[vodPlay.epIdx + 1]
    };
  for (let j = si + 1; j < vodPlay.seasons.length; j++)
    if (vodPlay.seasons[j].episodes.length)
      return {
        season: vodPlay.seasons[j].num,
        epIdx: 0,
        ep: vodPlay.seasons[j].episodes[0]
      };
  return null;
}
function onVodEnded() {
  if (!vodPlay.active) {
    if (catchup && vodMode === 'live') catchupBackToLive();
    return;
  }  // a catch-up programme ended: back to live

  vodPlay.ended = true;
  saveVodProgress(true);
  const nxt = nextEpisode();
  if (nxt) {
    showVodNext(nxt);
    return;
  }
  stopVodPlayback(true);
}
function showVodNext(nxt) {
  vodPlay.nextEp = nxt;
  vodPlay.nextCountdown = VOD_NEXT_COUNTDOWN;
  vodPlay.nextFocus = 'play';
  document.getElementById('vodNextName').textContent =
      `${vodPlay.item.name} · S${nxt.season} E${nxt.ep.num}${
          nxt.ep.title ? ' · ' + nxt.ep.title : ''}`;
  document.getElementById('vodNext').classList.remove('hidden');
  updateVodNextFocus();
  if (settings.autoNext === false) {
    document.getElementById('vodNextLabel').textContent = 'Up next';
    return;
  }  // card only; OK plays, Back leaves
  const tick = () => {
    document.getElementById('vodNextLabel').textContent =
        `Up next · plays in ${vodPlay.nextCountdown} s`;
    if (vodPlay.nextCountdown <= 0) {
      playNextEpisode();
      return;
    }
    vodPlay.nextCountdown--;
    vodPlay.nextTimer = setTimeout(tick, 1000);
  };
  tick();
}
function updateVodNextFocus() {
  document.getElementById('vodNextPlay')
      .classList.toggle('focused', vodPlay.nextFocus !== 'cancel');
  document.getElementById('vodNextCancel')
      .classList.toggle('focused', vodPlay.nextFocus === 'cancel');
}
function clearVodNext() {
  if (vodPlay.nextTimer) {
    clearTimeout(vodPlay.nextTimer);
    vodPlay.nextTimer = null;
  }
  vodPlay.nextEp = null;
  document.getElementById('vodNext').classList.add('hidden');
}
function playNextEpisode() {
  const nxt = vodPlay.nextEp;
  if (!nxt) return;
  const item = vodPlay.item, seasons = vodPlay.seasons;
  clearVodNext();
  startVodPlayback({
    kind: 'episode',
    item,
    ep: nxt.ep,
    season: nxt.season,
    epIdx: nxt.epIdx,
    seasons
  });
}
function activateVodNext() {
  if (vodPlay.nextFocus === 'cancel') {
    clearVodNext();
    stopVodPlayback(true);
  } else
    playNextEpisode();
}
// ── audio & subtitle tracks (VOD) ────────────────────────────
function trackMatchesLang(track, lang) {
  const l = (track.language || '').toLowerCase();
  const lb = (track.label || '').toLowerCase();
  const name = (LANG_NAMES[lang] || '').toLowerCase();
  return l === lang || l.slice(0, 2) === lang || l.startsWith(lang + '-') ||
      (!!name && lb.includes(name));
}
function trackDisplayName(track, i) {
  const lang = track.language ? resolveLanguage(track.language) : null;
  let name =
      (track.label && track.label.trim()) || lang || ('Track ' + (i + 1));
  if (track.kind === 'captions')
    name += ' [CC]';
  else if (
      track.kind && track.kind !== 'main' && track.kind !== 'subtitles' &&
      track.kind !== '')
    name += ' [' + track.kind + ']';
  return name;
}
// Apply the Settings preferences to whatever tracks the file exposes (unless
// the user picked manually)
function applyVodTrackPrefs() {
  if (!vodPlay.active) return;
  const u = vodPlay.ums;
  if (u && u.subTracks.length) {
    if (!vodPlay.subManual) {
      const pref = settings.subLang;
      let chosen = null;
      if (settings.subAuto) {
        if (pref === 'any')
          chosen = u.subTracks[0];
        else
          chosen =
              u.subTracks.find(
                  t => trackMatchesLang(
                      {language: t.language, label: t.languageName}, pref)) ||
              null;
      }
      umsSelectSubtitle(chosen ? chosen.trackNum : -1);
    }
    if (u.audioTracks.length > 1 && !vodPlay.audioManual &&
        settings.audioLang !== 'default') {
      const i = u.audioTracks.findIndex(
          t => trackMatchesLang(
              {language: t.language, label: ''}, settings.audioLang));
      if (i >= 0 && i !== u.selectedAudio) umsSelectAudio(i);
    }
    updateVodTracksHint();
    return;
  }
  const subs = getSubtitleTracks();
  if (subs.length && !vodPlay.subManual) {
    const pref = settings.subLang;
    let chosen = null;
    if (settings.subAuto) {
      if (pref === 'any')
        chosen = subs[0];
      else
        chosen = subs.find(t => trackMatchesLang(t, pref)) || null;
    }
    subs.forEach(t => {
      const want = t === chosen ? 'showing' : 'disabled';
      if (t.mode !== want) t.mode = want;
    });
  }
  const auds = getAudioTracks();
  if (auds.length > 1 && !vodPlay.audioManual &&
      settings.audioLang !== 'default') {
    const t = auds.find(a => trackMatchesLang(a, settings.audioLang));
    if (t && !t.enabled)
      auds.forEach(a => {
        a.enabled = a === t;
      });
  }
  updateVodTracksHint();
}
function updateVodTracksHint() {
  const el = document.getElementById('vodOsdTracks');
  if (!el) return;
  const u = activeUms();
  if (u && u.subTracks.length) {
    const on = u.subTracks.find(t => t.trackNum === u.selectedSub);
    const bits =
        ['Subtitles: ' + (on ? umsTrackLabel(on, u.subTracks) : 'Off')];
    if (u.audioTracks.length > 1) {
      const a = u.audioTracks[u.selectedAudio];
      if (a) bits.push('Audio: ' + umsAudioLabel(a, u.selectedAudio));
    }
    bits.push('Green: audio & subtitles');
    el.textContent = bits.join(' · ');
    updatePlayerFocus();
    return;
  }
  const subs = getSubtitleTracks(), auds = getAudioTracks();
  const on = subs.find(t => t.mode === 'showing');
  const bits = [];
  if (subs.length)
    bits.push(
        'Subtitles: ' + (on ? trackDisplayName(on, subs.indexOf(on)) : 'Off'));
  if (auds.length > 1) {
    const a = auds.find(t => t.enabled);
    if (a) bits.push('Audio: ' + trackDisplayName(a, auds.indexOf(a)));
  }
  if (!subs.length) bits.push('No subtitle tracks in this file');
  bits.push('Green: audio & subtitles');
  el.textContent = bits.join(' · ');
  updatePlayerFocus();
}
function vodTracksOpen() {
  const p = document.getElementById('vodTracks');
  return !!p && !p.classList.contains('hidden');
}
function vodTracksItems() {
  const items = [];
  // Live through Shaka Player: its audio tracks and text tracks
  if (!vodPlay.active && liveEngine.shaka) {
    const p = liveEngine.shaka;
    let auds = [], subs = [];
    try {
      auds = p.getAudioTracks() || [];
      subs = p.getTextTracks() || [];
    } catch (_) { /* not loaded yet */
    }
    if (auds.length > 1) {
      items.push({header: 'Audio'});
      auds.forEach((t, i) => items.push({
        kind: 'audio',
        shaka: t,
        label: engineTrackLabel(t.language, t.label, i),
        on: !!t.active
      }));
    }
    items.push({header: 'Subtitles'});
    items.push({
      kind: 'sub',
      shaka: null,
      label: 'Off',
      on: !subs.some(t => t.active)
    });
    subs.forEach((t, i) => items.push({
      kind: 'sub',
      shaka: t,
      label: shakaTextLabel(t, i),
      on: !!t.active
    }));
    if (!subs.length)
      items.push({note: 'This channel has no subtitle tracks.'});
    return items;
  }
  // Live through hls.js: its own alternate audio and subtitle renditions (the
  // media service does not see MSE playback)
  if (!vodPlay.active && liveEngineActive()) {
    const h = liveEngine.hls;
    const auds = h.audioTracks || [], subs = h.subtitleTracks || [];
    if (auds.length > 1) {
      items.push({header: 'Audio'});
      auds.forEach((t, i) => items.push({
        kind: 'audio',
        hls: i,
        label: hlsTrackLabel(t, i),
        on: i === h.audioTrack
      }));
    }
    items.push({header: 'Subtitles'});
    items.push({
      kind: 'sub',
      hls: -1,
      label: 'Off',
      on: h.subtitleTrack < 0 || !h.subtitleDisplay
    });
    subs.forEach((t, i) => items.push({
      kind: 'sub',
      hls: i,
      label: hlsTrackLabel(t, i),
      on: i === h.subtitleTrack && h.subtitleDisplay
    }));
    if (!subs.length)
      items.push({note: 'This channel has no subtitle tracks.'});
    return items;
  }
  const u = activeUms();
  if (u && (u.subTracks.length || u.audioTracks.length > 1)) {
    if (u.audioTracks.length > 1) {
      items.push({header: 'Audio'});
      u.audioTracks.forEach((t, i) => items.push({
        kind: 'audio',
        ums: i,
        label: umsAudioLabel(t, i),
        on: i === u.selectedAudio
      }));
    }
    items.push({header: 'Subtitles'});
    items.push({kind: 'sub', ums: -1, label: 'Off', on: u.selectedSub < 0});
    u.subTracks.forEach(t => items.push({
      kind: 'sub',
      ums: t.trackNum,
      label: umsTrackLabel(t, u.subTracks),
      on: t.trackNum === u.selectedSub
    }));
    if (!u.subTracks.length)
      items.push({
        note: vodPlay.active ? 'This file has no subtitle tracks.' :
                               'This channel has no subtitle tracks.'
      });
    else if (vodPlay.active) {
      items.push({header: 'Timing'});
      items.push({
        kind: 'sync',
        label: `Sync offset  ◀ ${vodPlay.syncMs > 0 ? '+' : ''}${
            (vodPlay.syncMs / 1000).toFixed(2)} s ▶`,
        on: vodPlay.syncMs !== 0
      });
    }
    return items;
  }
  const auds = getAudioTracks();
  if (auds.length > 1) {
    items.push({header: 'Audio'});
    auds.forEach((t, i) => items.push({
      kind: 'audio',
      track: t,
      label: trackDisplayName(t, i),
      on: !!t.enabled
    }));
  }
  const subs = getSubtitleTracks();
  items.push({header: 'Subtitles'});
  items.push({
    kind: 'sub',
    track: null,
    label: 'Off',
    on: !subs.some(t => t.mode === 'showing')
  });
  subs.forEach((t, i) => items.push({
    kind: 'sub',
    track: t,
    label: trackDisplayName(t, i),
    on: t.mode === 'showing'
  }));
  if (!subs.length)
    items.push({
      note:
          'This file has no subtitle tracks. Only subtitles embedded in the provider\'s file can be shown.'
    });
  return items;
}
function openVodTracks() {
  if (!playerActive()) return;
  const items = vodTracksItems();
  vodPlay.tracksItems = items;
  // Open on the active subtitle row (the menu's main purpose); fall back to the
  // first selectable row
  let first = items.findIndex(it => it.kind === 'sub' && it.on);
  if (first < 0) first = items.findIndex(it => it.kind && it.on);
  vodPlay.tracksFocus = first >= 0 ? first : items.findIndex(it => it.kind);
  document.getElementById('vodTracks').classList.remove('hidden');
  renderVodTracks();
  showVodOsd();
}
function closeVodTracks() {
  const p = document.getElementById('vodTracks');
  if (p) p.classList.add('hidden');
}
function renderVodTracks() {
  const list = document.getElementById('vodTracksList');
  if (!list) return;
  const items = vodTracksItems();
  vodPlay.tracksItems = items;
  if (vodPlay.tracksFocus >= items.length || !items[vodPlay.tracksFocus] ||
      !items[vodPlay.tracksFocus].kind)
    vodPlay.tracksFocus = items.findIndex(it => it.kind);
  list.innerHTML = '';
  items.forEach((it, i) => {
    if (it.header) {
      list.appendChild(el('div', 'vod-tracks-h', escapeHtml(it.header)));
      return;
    }
    if (it.note) {
      list.appendChild(el('div', 'vod-tracks-note', escapeHtml(it.note)));
      return;
    }
    const row =
        el('div',
           'vod-track' + (it.on ? ' on' : '') +
               (i === vodPlay.tracksFocus ? ' focused' : ''),
           `<span class="vod-track-dot">${it.on ? '●' : '○'}</span>${
               escapeHtml(it.label)}`);
    // stopPropagation: activateVodTrack re-renders this list, so by the time
    // the click bubbled to the player the row was detached and looked like a
    // click on the video (which toggled pause)
    row.addEventListener('click', e => {
      e.stopPropagation();
      vodPlay.tracksFocus = i;
      activateVodTrack();
    });
    list.appendChild(row);
  });
  const f = list.querySelector('.vod-track.focused');
  if (f) f.scrollIntoView({block: 'nearest'});
}
function moveVodTracksFocus(dir) {
  const items = vodPlay.tracksItems;
  let i = vodPlay.tracksFocus;
  do {
    i += dir;
  } while (i >= 0 && i < items.length && !items[i].kind);
  if (i >= 0 && i < items.length) {
    vodPlay.tracksFocus = i;
    renderVodTracks();
  }
}
function hlsTrackLabel(t, i) {
  return engineTrackLabel(t.lang, t.name, i);
}
/**
 * Gives the label of an engine track for the tracks menu.
 * @param {string|undefined} lang The language code of the track.
 * @param {string|undefined} name The name of the track.
 * @param {number} i The index of the track.
 * @return {string} The label.
 */
function engineTrackLabel(lang, name, i) {
  const language = lang ? resolveLanguage(lang) : '';
  name = (name || '').trim();
  if (name && language && name.toLowerCase() !== language.toLowerCase())
    return `${language} · ${name}`;
  return name || language || ('Track ' + (i + 1));
}
/**
 * Gives the menu label of a Shaka Player text track. Shaka Player finds
 * closed captions (CEA-608 or CEA-708) in the video of MPEG-TS segments, and
 * gives them the service name (for example CC1) and no label.
 * @param {!Object} t The text track.
 * @param {number} i The index of the track.
 * @return {string} The label.
 */
function shakaTextLabel(t, i) {
  if (!/cea-(608|708)/i.test(t.mimeType || ''))
    return engineTrackLabel(t.language, t.label, i);
  // With no language in the playlist, Shaka Player puts the service name in
  // `language` (seen on the C4: CC1 and svc1, which reads as Swedish)
  const code = t.language || '';
  const lang = code && code !== 'und' && code !== t.originalTextId &&
          !/^(cc\d|svc\d+)$/i.test(code) ?
      ` · ${resolveLanguage(code)}` :
      '';
  return `Closed captions${t.originalTextId ? ` (${t.originalTextId})` : ''}${
      lang}`;
}
// Shaka Player shows closed captions in a <track> of the <video>, with the
// service name as the label. Its cues have the position of the caption grid
// as a percent and the full width (size 100), centered at that position. On
// the C4 (2026-10-27), the box started out of the frame at the left, and the
// line was at the top. Thus, each caption cue gets the full width, centered,
// at the bottom of the frame.
const CAPTION_TRACK = /^(CC\d|svc\d+)$/;
/**
 * Moves the active cues of a caption track to the bottom center.
 * @param {!TextTrack} track The caption track.
 */
function fixCaptionCues(track) {
  for (const c of Array.from(track.activeCues || [])) {
    if (c.iptvFixed || typeof c.snapToLines !== 'boolean') continue;
    c.iptvFixed = true;
    c.snapToLines = true;
    c.line = 'auto';
    c.position = 'auto';
    c.size = 100;
    c.align = 'center';
  }
}
videoPlayer.textTracks.addEventListener('addtrack', e => {
  const track = e.track;
  if (!track || !CAPTION_TRACK.test(track.label || '')) return;
  track.addEventListener('cuechange', () => fixCaptionCues(track));
});
// Settings language preferences applied to the tracks of Shaka Player when a
// channel announces them. A selection by the user stays.
function applyShakaTrackPrefs() {
  const p = liveEngine.shaka;
  if (!p) return;
  let subs = [], auds = [];
  try {
    subs = p.getTextTracks() || [];
    auds = p.getAudioTracks() || [];
    if (subs.length && !liveEngine.subManual) {
      let pick = null;
      if (settings.subAuto)
        pick = settings.subLang === 'any' ?
            subs[0] :
            subs.find(
                t => trackMatchesLang(
                    {language: t.language || '', label: t.label || ''},
                    settings.subLang)) ||
                null;
      const cur = subs.find(t => t.active) || null;
      if ((pick && pick.id) !== (cur && cur.id)) p.selectTextTrack(pick);
    }
    if (auds.length > 1 && !liveEngine.audioManual &&
        settings.audioLang !== 'default') {
      const t = auds.find(
          a => trackMatchesLang(
              {language: a.language || '', label: a.label || ''},
              settings.audioLang));
      if (t && !t.active) p.selectAudioTrack(t);
    }
  } catch (_) { /* not loaded yet */
  }
  updateVodTracksHint();
}
// Settings language preferences applied to hls.js renditions when a channel
// announces them
function applyHlsTrackPrefs() {
  const h = liveEngine.hls;
  if (!h) return;
  const subs = h.subtitleTracks || [], auds = h.audioTracks || [];
  if (subs.length && !liveEngine.subManual) {
    let pick = -1;
    if (settings.subAuto)
      pick = settings.subLang === 'any' ?
          0 :
          subs.findIndex(
              t => trackMatchesLang(
                  {language: t.lang || '', label: t.name || ''},
                  settings.subLang));
    h.subtitleTrack = pick;
    h.subtitleDisplay = pick >= 0;
  }
  if (auds.length > 1 && !liveEngine.audioManual &&
      settings.audioLang !== 'default') {
    const i = auds.findIndex(
        t => trackMatchesLang(
            {language: t.lang || '', label: t.name || ''}, settings.audioLang));
    if (i >= 0 && i !== h.audioTrack) h.audioTrack = i;
  }
  updateVodTracksHint();
}
function activateVodTrack() {
  const it = vodPlay.tracksItems[vodPlay.tracksFocus];
  if (!it || !it.kind) return;
  if (it.kind === 'sync') {
    umsSetSync(0);
    renderVodTracks();
    showVodOsd();
    return;
  }  // OK resets the offset
  if (it.shaka !== undefined && liveEngine.shaka) {
    const p = liveEngine.shaka;
    try {
      if (it.kind === 'sub') {
        p.selectTextTrack(it.shaka);
        liveEngine.subManual = true;
      } else {
        p.selectAudioTrack(it.shaka);
        liveEngine.audioManual = true;
      }
    } catch (_) { /* not loaded yet */
    }
    updateVodTracksHint();
    renderVodTracks();
    showVodOsd();
    return;
  }
  if (it.hls !== undefined && liveEngine.hls) {
    const h = liveEngine.hls;
    if (it.kind === 'sub') {
      h.subtitleTrack = it.hls;
      h.subtitleDisplay = it.hls >= 0;
      liveEngine.subManual = true;
    } else {
      h.audioTrack = it.hls;
      liveEngine.audioManual = true;
    }
    updateVodTracksHint();
    renderVodTracks();
    showVodOsd();
    return;
  }
  if (it.ums !== undefined) {
    const u = activeUms();
    if (it.kind === 'sub') {
      umsSelectSubtitle(it.ums, u);
      if (u) u.subManual = true;
      vodPlay.subManual = true;
    } else {
      umsSelectAudio(it.ums, u);
      if (u) u.audioManual = true;
      vodPlay.audioManual = true;
    }
    updateVodTracksHint();
    renderVodTracks();
    showVodOsd();
    return;
  }
  if (it.kind === 'sub') {
    getSubtitleTracks().forEach(t => {
      t.mode = t === it.track ? 'showing' : 'disabled';
    });
    vodPlay.subManual = true;
  } else {
    getAudioTracks().forEach(t => {
      t.enabled = t === it.track;
    });
    vodPlay.audioManual = true;
  }
  updateVodTracksHint();
  renderVodTracks();
  showVodOsd();
}

// ── webOS media service (luna://com.webos.media) ─────────────
// The HTML <video> on webOS never exposes subtitle tracks embedded in MKV
// files, but the app may subscribe to its own pipeline (video.mediaId) and
// call selectTrack / setSubtitleEnable on it. sourceInfo arrives on load with
// the full subtitle/audio/video track lists. getActivePipelines and
// getPipelineState are denied to third-party apps, so subscribe early.
function umsAvailable() {
  return typeof webOS !== 'undefined' && webOS.service &&
      typeof webOS.service.request === 'function';
}
function umsCall(method, parameters) {
  return new Promise(res => {
    if (!umsAvailable()) return res({ok: false, e: 'no webOS'});
    try {
      webOS.service.request('luna://com.webos.media', {
        method,
        parameters,
        onSuccess: r => res({ok: !!r.returnValue, r}),
        onFailure: e => res({ok: false, e})
      });
    } catch (ex) {
      res({ok: false, e: String(ex)});
    }
    setTimeout(() => res({ok: false, e: 'timeout'}), 5000);
  });
}
let _umsPrevId = '';  // pipeline id seen before the last src change; the new
                      // pipeline must differ
function umsValidId(id) {
  return !!id && typeof id === 'string' && id.charAt(0) !== '<';
}
function umsNoteCurrentId() {
  const id = videoPlayer.mediaId;
  _umsPrevId = umsValidId(id) ? id : '';
}
// Subscribe to the pipeline that the <video> is about to create. kind: 'vod' |
// 'live'
function umsAttachFor(kind) {
  if (!umsAvailable()) return null;
  const u = {
    kind,
    mediaId: '',
    sub: null,
    subTracks: [],
    audioTracks: [],
    video: null,
    videoInfo: null,
    selectedSub: -1,
    selectedAudio: 0,
    keys: {},
    dead: false
  };
  const t0 = Date.now();
  const prev = _umsPrevId;
  const poll = () => {
    if (u.dead) return;
    const id = videoPlayer.mediaId;
    // Wait for a new pipeline id; after 1.5 s accept an unchanged one (the old
    // pipeline is gone by then)
    if (!umsValidId(id) || (id === prev && Date.now() - t0 < 1500)) {
      if (Date.now() - t0 < 10000) setTimeout(poll, 25);
      return;
    }
    u.mediaId = id;
    try {
      u.sub = webOS.service.request('luna://com.webos.media', {
        method: 'subscribe',
        parameters: {mediaId: id},
        subscribe: true,
        onSuccess: m => {
          if (!u.dead) umsOnMessage(u, m);
        },
        onFailure: () => {
          /* subscription refused: HTML track fallback stays in place */
        }
      });
    } catch (_) {
      u.dead = true;
    }
  };
  poll();
  return u;
}
function umsRelease(u) {
  if (!u) return;
  u.dead = true;
  if (u.sub && typeof u.sub.cancel === 'function') {
    try {
      u.sub.cancel();
    } catch (_) { /* already gone */
    }
  }
}
function umsAttach() {
  umsDetach();
  vodPlay.ums = umsAttachFor('vod');
}
function umsDetach() {
  umsRelease(vodPlay.ums);
  vodPlay.ums = null;
}
function liveUmsRefresh() {
  umsRelease(liveUms);
  liveUms =
      (vodMode === 'live' && !vodPlay.active) ? umsAttachFor('live') : null;
}
function umsOnMessage(u, m) {
  for (const k of Object.keys(m))
    if (k !== 'returnValue') u.keys[k] = (u.keys[k] || 0) + 1;
  let techChanged = false;
  if (m.sourceInfo && Array.isArray(m.sourceInfo.programInfo) &&
      m.sourceInfo.programInfo.length) {
    const p = m.sourceInfo.programInfo[0];
    u.container = m.sourceInfo.container || '';
    u.subTracks =
        (p.subtitleTrackInfo ||
         []).map((t, i) => ({
                   trackNum: typeof t.trackNum === 'number' ? t.trackNum : i,
                   language: t.language || '',
                   languageName: t.languageName || '',
                   type: t.type || 'text'
                 }));
    u.audioTracks = (p.audioTrackInfo || []).map(t => ({
                                                   language: t.language || '',
                                                   codec: t.codec || '',
                                                   channels: t.channels || 0,
                                                   sampleRate: t.sampleRate || 0
                                                 }));
    u.video = (p.videoTrackInfo || [])[0] || null;
    techChanged = true;
    if (u.kind === 'vod' && vodPlay.ums === u) {
      applyVodTrackPrefs();
      if (vodTracksOpen()) renderVodTracks();
    } else if (u.kind === 'live' && liveUms === u) {
      applyLiveTrackPrefs(u);
      if (vodTracksOpen()) renderVodTracks();
      if (livePlayer.active) updateVodTracksHint();
    }
  }
  if (m.videoInfo) {
    u.videoInfo = Object.assign(u.videoInfo || {}, m.videoInfo);
    techChanged = true;
  }
  if (m.audioInfo) {
    u.audioInfo = Object.assign(u.audioInfo || {}, m.audioInfo);
    techChanged = true;
  }
  if (techChanged) umsTechUpdated(u);
  if (m.error) { /* keep playing; the HTML error handler reports real failures
                  */
  }
}
// Re-apply the subtitle preferences to whatever is playing (Settings changed)
function reapplySubtitlePrefs() {
  if (vodPlay.active) {
    vodPlay.subManual = false;
    applyVodTrackPrefs();
  } else if (liveUms) {
    liveUms.subManual = false;
    applyLiveTrackPrefs(liveUms);
  }
}
// Live: same subtitle/audio language preferences as VOD, applied to the live
// pipeline unless chosen manually
function applyLiveTrackPrefs(u) {
  if (!u || u.subManual) {
    if (u && u.audioTracks.length > 1 && !u.audioManual &&
        settings.audioLang !== 'default') {
      const i = u.audioTracks.findIndex(
          t => trackMatchesLang(
              {language: t.language, label: ''}, settings.audioLang));
      if (i >= 0 && i !== u.selectedAudio) umsSelectAudio(i, u);
    }
    return;
  }
  if (u.subTracks.length) {
    const pref = settings.subLang;
    let chosen = null;
    if (settings.subAuto) {
      if (pref === 'any')
        chosen = u.subTracks[0];
      else
        chosen =
            u.subTracks.find(
                t => trackMatchesLang(
                    {language: t.language, label: t.languageName}, pref)) ||
            null;
    }
    umsSelectSubtitle(chosen ? chosen.trackNum : -1, u);
  }
  if (u.audioTracks.length > 1 && !u.audioManual &&
      settings.audioLang !== 'default') {
    const i = u.audioTracks.findIndex(
        t => trackMatchesLang(
            {language: t.language, label: ''}, settings.audioLang));
    if (i >= 0 && i !== u.selectedAudio) umsSelectAudio(i, u);
  }
}
// Codec / resolution / HDR summary from the pipeline, e.g. "HEVC · 10-bit ·
// 3840×1600 · 23.98 fps · HDR10 · E-AC-3 5.1"
function umsTechString(u) {
  if (!u || !u.video) return '';
  const v = u.video, vi = u.videoInfo || {};
  const bits = [];
  if (v.codec)
    bits.push(String(v.codec)
                  .toUpperCase()
                  .replace(/^H264$/, 'H.264')
                  .replace(/^H265$/, 'HEVC'));
  if (/10/.test(String(v.profile || '')) || vi.bitDepth === 10)
    bits.push('10-bit');
  const w = vi.width || v.width, h = vi.height || v.height;
  if (w && h) bits.push(`${w}×${h}`);
  const fps = vi.frameRate || v.frameRate || (u.measuredFps || 0);
  if (fps) bits.push(fmtFps(fps));
  const hdr = vi.hdrType || vi.hdr || vi.transferCharacteristics || '';
  if (hdr && !/^(none|sdr|0)$/i.test(String(hdr)))
    bits.push(String(hdr)
                  .replace(/dolby\s*vision|dolbyvision|dv/i, 'Dolby Vision')
                  .replace(/hdr10plus|hdr10\+/i, 'HDR10+')
                  .replace(/^hlg$/i, 'HLG')
                  .replace(/^hdr10$/i, 'HDR10'));
  const a = u.audioTracks[u.selectedAudio] || u.audioTracks[0];
  if (a) {
    const codec = String(a.codec || '')
                      .toUpperCase()
                      .replace(/^EAC3$/, 'E-AC-3')
                      .replace(/^AC3$/, 'AC-3')
                      .replace(/^TRUEHD$/, 'TrueHD');
    const ch = a.channels >= 8 ? '7.1' :
        a.channels >= 6        ? '5.1' :
        a.channels === 2       ? 'Stereo' :
        a.channels === 1       ? 'Mono' :
                                 '';
    const s = [codec, ch].filter(Boolean).join(' ');
    if (s) bits.push(s);
  }
  return bits.join(' · ');
}
// When the media service names no frame rate, count decoded frames over 3 s
// (getVideoPlaybackQuality); a counter that does not move (frames rendered on
// the TV's video plane bypass the browser) leaves the line without fps
function umsMeasureFps(u) {
  if (u.fpsTried || !u.video || u.video.frameRate ||
      (u.videoInfo && u.videoInfo.frameRate) ||
      !videoPlayer.getVideoPlaybackQuality)
    return;
  u.fpsTried = true;
  const q0 = videoPlayer.getVideoPlaybackQuality().totalVideoFrames,
        t0 = performance.now();
  setTimeout(() => {
    const live = u.kind === 'live' ? liveUms === u : vodPlay.ums === u;
    if (!live || videoPlayer.paused) return;
    const n = videoPlayer.getVideoPlaybackQuality().totalVideoFrames - q0,
          dt = (performance.now() - t0) / 1000;
    if (n > 0 && dt > 1) {
      u.measuredFps = fpsSnap(n / dt);
      umsTechUpdated(u);
    }
  }, 3000);
}
function umsTechUpdated(u) {
  const s = umsTechString(u);
  umsMeasureFps(u);
  if (u.kind === 'vod' && vodPlay.ums === u) {
    const el = document.getElementById('vodOsdTech');
    if (el) el.textContent = s;
    if (s && vodPlay.key) {
      vodTech[vodPlay.key] = s;
      const ks = Object.keys(vodTech);
      if (ks.length > 300) delete vodTech[ks[0]];
      saveJson('iptv_vod_tech', vodTech);
    }
  } else if (u.kind === 'live' && liveUms === u) {
    noteCurrentStreamTech();
    if (livePlayer.active) {
      const el = document.getElementById('vodOsdTech');
      if (el) el.textContent = s;
      if (s) showVodOsd();
    } else if (s)
      showFeedStats(s);
  }
}
// Brief chip over the live picture (panel view) with the feed's
// codec/resolution/audio
let _feedStatsTimer = null;
function showFeedStats(text) {
  if (vodMode !== 'live' || vodPlay.active || livePlayer.active || !text)
    return;
  const wrap = (currentPlaylistType === 'xtream' && epgMode) ?
      document.getElementById('epgVideoWrap') :
      videoArea;
  let chip = document.getElementById('feedStats');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'feedStats';
    chip.className = 'feed-stats';
  }
  if (chip.parentNode !== wrap) wrap.appendChild(chip);
  chip.textContent = text;
  chip.classList.add('visible');
  if (_feedStatsTimer) clearTimeout(_feedStatsTimer);
  _feedStatsTimer = setTimeout(() => chip.classList.remove('visible'), 4000);
}
// Subtitle appearance (Settings) and the per-title sync offset, applied to the
// pipeline
async function umsApplySubtitleStyle(u) {
  u = u || activeUms();
  if (!u || !u.mediaId) return;
  const id = u.mediaId;
  const sizeIdx =
      Math.max(0, SUB_SIZE_OPTIONS.findIndex(o => o.v === settings.subSize));
  await umsCall(
      'setSubtitleCharacterFontSize',
      {mediaId: id, charFontSize: settings.subSize});
  await umsCall('setSubtitleFontSize', {mediaId: id, fontSize: sizeIdx});
  await umsCall(
      'setSubtitleCharacterColor', {mediaId: id, charColor: settings.subColor});
  // charOpacity is on a 0–255 scale on the C4 (100 rendered visibly
  // translucent, and 85 vs 100 looked the same); send the 0–255 value and fall
  // back to the percentage if a firmware rejects values above 100
  const op255 = Math.round(settings.subOpacity * 2.55);
  const opRes = await umsCall(
      'setSubtitleCharacterOpacity', {mediaId: id, charOpacity: op255});
  if (!opRes.ok && op255 > 100)
    await umsCall(
        'setSubtitleCharacterOpacity',
        {mediaId: id, charOpacity: settings.subOpacity});
  await umsCall('setSubtitleBackgroundColor', {mediaId: id, bgColor: 'black'});
  const bgOpacity = settings.subBg === 'none' ? 0 :
      settings.subBg === 'solid'              ? 100 :
                                                50;
  await umsCall('setSubtitleBackgroundOpacity', {mediaId: id, bgOpacity});
  if (settings.subBg === 'solid')
    await umsCall('setSubtitleBackgroundOpacity', {
      mediaId: id,
      bgOpacity: 255
    });  // 0-255 scale on some firmware; ignored otherwise
  // Edge colour is never set by the pipeline on its own; without it the edge is
  // invisible
  await umsCall(
      'setSubtitleCharacterEdgeColor', {mediaId: id, charEdgeColor: 'black'});
  await umsCall(
      'setSubtitleCharacterEdge',
      {mediaId: id, charEdgeType: SUB_EDGE_UMS[settings.subEdge] || 'none'});
  await umsCall(
      'setSubtitleSync',
      {mediaId: id, sync: u.kind === 'vod' ? (vodPlay.syncMs || 0) : 0});
}
function umsSetSync(ms) {
  ms = Math.max(-10000, Math.min(10000, Math.round(ms / 50) * 50));
  vodPlay.syncMs = ms;
  if (vodPlay.key) {
    if (ms)
      vodSubSync[vodPlay.key] = ms;
    else
      delete vodSubSync[vodPlay.key];
    saveJson('iptv_vod_subsync', vodSubSync);
  }
  const u = vodPlay.ums;
  if (u && u.mediaId)
    umsCall('setSubtitleSync', {mediaId: u.mediaId, sync: ms});
  updateVodTracksHint();
}
// Native speed playback through the pipeline (picture at 2×…32×); falls back to
// the scrub bar if the position does not move
const _UMS_RATE_RAMP = [
  {after: 0, speed: 2}, {after: 1500, speed: 4}, {after: 4000, speed: 8},
  {after: 8000, speed: 16}, {after: 12000, speed: 32}
];
function startNativeRate(dir) {
  const u = vodPlay.ums;
  const startT = videoPlayer.currentTime || 0, startAt = Date.now();
  let checked = false;
  if (vodPlay.osdTimer) {
    clearTimeout(vodPlay.osdTimer);
    vodPlay.osdTimer = null;
  }
  document.getElementById('vodOsd').classList.add('visible');
  videoPlayer.play().catch(() => {});
  _trickInterval = setInterval(() => {
    const rate = _getRampSpeed(_UMS_RATE_RAMP, Date.now() - _trickHoldStart) *
        (dir === 'left' ? -1 : 1);
    if (rate !== _nativeRate) {
      _nativeRate = rate;
      umsCall(
          'setPlayRate',
          {mediaId: u.mediaId, playRate: rate, audioOutput: false});
    }
    _showTrickBadge((dir === 'left' ? '◀◀ ' : '▶▶ ') + Math.abs(rate) + '×');
    updateVodOsd();
    const t = videoPlayer.currentTime || 0;
    if (!checked && Date.now() - startAt > 1500) {
      checked = true;
      const d = t - startT;
      if ((dir === 'right' && d < 0.5) || (dir === 'left' && d > -0.5)) {
        // The pipeline did not honour the rate on this file: switch to
        // scrubbing for the rest of the session
        _umsRateBroken = true;
        _nativeRate = 0;
        umsCall(
            'setPlayRate',
            {mediaId: u.mediaId, playRate: 1, audioOutput: true});
        clearInterval(_trickInterval);
        _trickInterval = null;
        videoPlayer.pause();
        startScrub(dir);
        return;
      }
    }
    const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) ||
        vodPlay.dur || 0;
    if ((dir === 'right' && dur && t >= dur - 1) ||
        (dir === 'left' && t <= 0.5))
      _stopHold();
  }, 100);
}
function startScrub(dir) {
  _scrubPos = videoPlayer.currentTime || 0;
  if (vodPlay.osdTimer) {
    clearTimeout(vodPlay.osdTimer);
    vodPlay.osdTimer = null;
  }
  document.getElementById('vodOsd').classList.add('visible');
  _trickInterval = setInterval(() => {
    const heldMs = Date.now() - _trickHoldStart;
    const speed = _getRampSpeed(_VOD_SCRUB_RAMP, heldMs);
    const dur = (isFinite(videoPlayer.duration) && videoPlayer.duration) ||
        vodPlay.dur || 0;
    const max = dur ? Math.max(0, dur - 1) : Number.MAX_VALUE;
    _scrubPos = Math.max(
        0, Math.min(max, _scrubPos + (dir === 'left' ? -1 : 1) * speed * 0.1));
    _showTrickBadge((dir === 'left' ? '◀◀ ' : '▶▶ ') + speed + '×');
    updateVodOsd(_scrubPos);
    if ((dir === 'right' && dur && _scrubPos >= max) ||
        (dir === 'left' && _scrubPos <= 0))
      _stopHold();
  }, 100);
}
function umsTrackLabel(t, all) {
  const base = t.languageName ? t.languageName.split(/[;,]/)[0].trim() :
                                (t.language ? resolveLanguage(t.language) :
                                              ('Track ' + (t.trackNum + 1)));
  const same = all.filter(
      x => (x.languageName || x.language) === (t.languageName || t.language));
  if (same.length > 1) return `${base} ${same.indexOf(t) + 1}`;
  return base;
}
function umsAudioLabel(t, i) {
  const lang = t.language ? resolveLanguage(t.language) : ('Track ' + (i + 1));
  const ch = t.channels >= 6 ? '5.1' :
      t.channels === 2       ? 'Stereo' :
      t.channels === 1       ? 'Mono' :
                               '';
  return [lang, (t.codec || '').toUpperCase(), ch].filter(Boolean).join(' · ');
}
async function umsSelectSubtitle(trackNum, u) {
  u = u || activeUms();
  if (!u || !u.mediaId) return;
  u.selectedSub = trackNum;
  if (trackNum < 0) {
    await umsCall('setSubtitleEnable', {mediaId: u.mediaId, enable: false});
  } else {
    await umsCall(
        'selectTrack', {mediaId: u.mediaId, type: 'text', index: trackNum});
    await umsCall('setSubtitleEnable', {mediaId: u.mediaId, enable: true});
    umsApplySubtitleStyle(u);
  }
  updateVodTracksHint();
}
async function umsSelectAudio(index, u) {
  u = u || activeUms();
  if (!u || !u.mediaId) return;
  u.selectedAudio = index;
  await umsCall('selectTrack', {mediaId: u.mediaId, type: 'audio', index});
  updateVodTracksHint();
}

function onVodError() {
  const code = videoPlayer.error ? videoPlayer.error.code : 0;
  const msg = code === 2 ? 'Network error' :
      code === 3         ? 'Decode error' :
      code === 4         ? 'File unavailable or unsupported' :
                           'Playback error';
  const title = vodPlay.title;
  stopVodPlayback(true);
  showEPGToast(`${title}: ${msg}`, 'error', 'Playback Error');
  hideEPGToast(7000);
}
