/**
 * @fileoverview Settings overlay and the Diagnostics overlay.
 */

// ----- Settings -----
function getPlaylistState(key) {
  if (!playlistState[key]) playlistState[key] = {};
  return playlistState[key];
}
function playlistKeyOf(p) {
  return p.type === 'xtream' ?
      'x:' + String(p.url).replace(/\/$/, '') + '|' + p.username :
      'm:' + p.url;
}
function rememberLastPlaylist(key) {
  try {
    localStorage.setItem(LAST_PLAYLIST_KEY, key);
  } catch (_) { /* storage unavailable */
  }
}
function refreshViewIfLoaded() {
  if (currentPlaylistType) refreshCurrentView();
}

// Starting group for a playlist: Favorites (default), All Channels, or the last
// group used
function initialGroupFor(key) {
  const ps = getPlaylistState(key);
  if (ps.startGroup === 'all' || ps.startGroup === 'recent')
    return ps.startGroup;
  if (ps.startGroup === 'last' && ps.lastGroup) return ps.lastGroup;
  return 'favorites';
}
// Called after extractGroups(): a remembered group may no longer exist in the
// playlist
function validateCurrentGroup() {
  if (groupsList.indexOf(currentGroup) === -1) {
    currentGroup = 'favorites';
    renderGroupsList();
  }
}
// First channel after a playlist loads: the last one watched (if enabled and
// still present), else the first row
function selectInitialChannel() {
  if (!channels.length) return;
  const ps = _activePlaylistKey ? getPlaylistState(_activePlaylistKey) : null;
  if (ps && ps.resume !== false && ps.lastChannel) {
    let idx = channels.findIndex(c => c.url === ps.lastChannel.url);
    if (idx < 0 && ps.lastChannel.tvgId)
      idx = channels.findIndex(c => c.tvgId === ps.lastChannel.tvgId);
    if (idx >= 0) {
      selectChannel(idx);
      if (epgMode) {
        const fi = currentFilteredChannels.indexOf(channels[idx]);
        if (fi >= 0) {
          epgFocusedRowIdx = fi;
          updateEPGRowFocus();
        }
      }
      return;
    }
  }
  selectChannel(
      currentFilteredChannels.length ?
          getChannelIndex(currentFilteredChannels[0]) :
          0);
}

// Which playlist the per-playlist rows apply to: the loaded one, else the one
// selected on the start page
function settingsTargetKey() {
  if (_activePlaylistKey && _activePlaylistKey !== 'm:demo') {
    const p =
        savedPlaylists.find(pl => playlistKeyOf(pl) === _activePlaylistKey);
    return {key: _activePlaylistKey, name: p ? p.name : 'current playlist'};
  }
  if (!startPage.classList.contains('hidden') && selectedPlaylistId !== null &&
      savedPlaylists[selectedPlaylistId]) {
    const p = savedPlaylists[selectedPlaylistId];
    return {key: playlistKeyOf(p), name: p.name};
  }
  return null;
}

function settingsRows() {
  const t = settingsTargetKey();
  const ps = t ? getPlaylistState(t.key) : null;
  const forName = t ? `For ${t.name}` : 'Select or load a playlist first';
  const cur = () =>
      (currentChannelIndex >= 0 ? channels[currentChannelIndex] : null);
  return [
    {
      id: 'textScale',
      type: 'choice',
      label: 'Text size',
      sub: 'Applies to every screen',
      options:
          TEXT_SCALE_OPTIONS.map(v => ({v, label: Math.round(v * 100) + '%'})),
      get: () => settings.textScale,
      set: v => {
        settings.textScale = v;
        saveSettings();
        applyTextScale(v);
        _epgSkeletonWinStart = 0;
        refreshViewIfLoaded();
      }
    },
    {
      id: 'clock',
      type: 'choice',
      label: 'Clock',
      sub: 'Guide, Now/Next and program times',
      options: [{v: '12', label: '12-hour'}, {v: '24', label: '24-hour'}],
      get: () => settings.clock,
      set: v => {
        settings.clock = v;
        saveSettings();
        _epgSkeletonWinStart = 0;
        refreshViewIfLoaded();
        updateNowNext();
        if (epgMode && cur()) updateEPGInfoPanel(cur());
      }
    },
    {
      id: 'epgTz',
      type: 'choice',
      label: 'EPG timezone',
      disabled: !t,
      sub: t ?
          `${forName} · pick the zone whose clock the provider used if guide times are hours off; times are converted to your TV clock` :
          forName,
      options: epgTzOptions(),
      get: () => epgTzSettingsFor(t && t.key).tz,
      set: v => {
        ps.epgTz = v;
        savePlaylistState();
        if (t.key === _activePlaylistKey) epgOffsetChange();
      }
    },
    {
      id: 'epgDst',
      type: 'choice',
      label: 'Daylight saving',
      disabled: !t || !epgTzSettingsFor(t.key).tz,
      sub: t && epgTzSettingsFor(t.key).tz ?
          'Automatic follows that zone\'s rules on each program\'s date; pin standard or daylight time if the provider never switches' :
          'Choose an EPG timezone first',
      options: EPG_DST_OPTIONS,
      get: () => epgTzSettingsFor(t && t.key).dst,
      set: v => {
        ps.epgDst = v;
        savePlaylistState();
        if (t.key === _activePlaylistKey) epgOffsetChange();
      }
    },
    {
      id: 'epgExtra',
      type: 'choice',
      label: 'EPG extra adjustment',
      disabled: !t,
      sub: t ?
          'Added on top of the timezone for providers that are off by an odd amount' :
          forName,
      options: EPG_EXTRA_OPTIONS,
      get: () => epgTzSettingsFor(t && t.key).extra,
      set: v => {
        ps.epgOffset = v;
        savePlaylistState();
        if (t.key === _activePlaylistKey) epgOffsetChange();
      }
    },
    {
      id: 'autoLoad',
      type: 'toggle',
      label: 'Auto-load last playlist',
      sub: 'Skip the start page on launch',
      get: () => settings.autoLoad,
      set: v => {
        settings.autoLoad = v;
        saveSettings();
      }
    },
    {
      id: 'startGroup',
      type: 'choice',
      label: 'Starting group',
      sub: forName,
      disabled: !t,
      options: [
        {v: 'favorites', label: 'Favorites'}, {v: 'all', label: 'All Channels'},
        {v: 'recent', label: 'Recent'}, {v: 'last', label: 'Last used'}
      ],
      get: () => (ps && ps.startGroup) || 'favorites',
      set: v => {
        ps.startGroup = v;
        savePlaylistState();
      }
    },
    {
      id: 'resume',
      type: 'toggle',
      label: 'Resume last channel',
      sub: forName,
      disabled: !t,
      get: () => !ps || ps.resume !== false,
      set: v => {
        ps.resume = v;
        savePlaylistState();
      }
    },
    {
      id: 'manageCats',
      type: 'action',
      label: 'Manage categories',
      sub: t ?
          `Hide or reorder categories for ${t.name}${
              _hiddenGroups.size ? ` · ${_hiddenGroups.size} hidden` : ''}` :
                                   'Load a playlist first',
      button: 'Open',
      disabled: !t || !_activePlaylistKey || _activePlaylistKey === 'm:demo' ||
          _activePlaylistKey !== t.key,
      run: () => openCatsManager('cats')
    },
    {
      id: 'manageFavs',
      type: 'action',
      label: 'Manage favorites',
      sub: favoriteIds.size ?
          `Reorder or remove · ${favoriteIds.size.toLocaleString()} saved` :
          'No favorites yet',
      button: 'Open',
      disabled: !favoriteIds.size || !_activePlaylistKey || vodMode !== 'live',
      run: () => openCatsManager('favs')
    },
    {
      id: 'refreshPlaylist',
      type: 'action',
      label: 'Refresh playlist now',
      button: 'Refresh',
      sub: _activePlaylistKey && _activePlaylistKey !== 'm:demo' ?
          (_playlistRefreshing ?
               'Refreshing …' :
               `Channel list fetched ${
                   _playlistCacheAt ?
                       fmtAge(_playlistCacheAt) :
                       'this session'}; refreshes itself after 6 h`) :
               'Load a playlist first',
      disabled: !_activePlaylistKey || _activePlaylistKey === 'm:demo' ||
          _playlistRefreshing,
      run: () => {
        showEPGToast('Refreshing playlist …', 'loading', 'Playlist');
        refreshPlaylistInBackground(true).then(() => renderSettings());
        renderSettings();
      }
    },
    {
      id: 'liveBuffer',
      type: 'choice',
      label: 'Live rewind buffer',
      sub:
          'HLS channels: pause and rewind live TV up to this far back. Limited by TV memory (about 70 MB): HD channels reach 1–3 min, SD channels more',
      options: LIVE_BUFFER_OPTIONS,
      get: () => settings.liveBuffer,
      set: v => {
        settings.liveBuffer = v;
        saveSettings();
        if (vodMode === 'live' && !vodPlay.active && currentChannelIndex >= 0 &&
            (liveEngineActive() || v > 0))
          reloadStream(false, 'Settings');
      }
    },
    {
      id: 'liveEngine',
      type: 'choice',
      label: 'Live engine',
      sub:
          'Plays HLS channels with the rewind buffer. Shaka Player also plays E-AC-3 audio in MPEG-TS segments, which hls.js cannot play',
      options: LIVE_ENGINE_OPTIONS,
      get: () => settings.liveEngine,
      set: v => {
        settings.liveEngine = v;
        saveSettings();
        _hlsBroken.clear();  // the other engine can play a channel that this
                             // one could not
        if (vodMode === 'live' && !vodPlay.active && currentChannelIndex >= 0 &&
            settings.liveBuffer > 0)
          reloadStream(false, 'Settings');
      }
    },
    {
      id: 'ppvEvents',
      type: 'choice',
      label: 'Event channels (PPV)',
      sub:
          'Groups of event channels whose names give the start time: list them by start time, optionally without events that ended over an hour ago',
      options: PPV_EVENT_OPTIONS,
      get: () => settings.ppvEvents,
      set: v => {
        settings.ppvEvents = v;
        saveSettings();
        refreshViewIfLoaded();
      }
    },
    {
      id: 'subAuto',
      type: 'toggle',
      label: 'Subtitles on automatically',
      sub:
          'Turn on the subtitle language below whenever a file or channel has it',
      get: () => !!settings.subAuto,
      set: v => {
        settings.subAuto = v;
        saveSettings();
        reapplySubtitlePrefs();
      }
    },
    {
      id: 'subLang',
      type: 'choice',
      label: 'Subtitle language',
      sub: 'Used when subtitles turn on automatically',
      options: SUB_LANG_OPTIONS,
      get: () => settings.subLang,
      set: v => {
        settings.subLang = v;
        saveSettings();
        reapplySubtitlePrefs();
      }
    },
    {
      id: 'audioLang',
      type: 'choice',
      label: 'Audio language',
      sub: 'Movies and Series: picked when the file offers it',
      options: AUDIO_LANG_OPTIONS,
      get: () => settings.audioLang,
      set: v => {
        settings.audioLang = v;
        saveSettings();
        if (vodPlay.active) {
          vodPlay.audioManual = false;
          applyVodTrackPrefs();
        }
      }
    },
    {
      id: 'subSize',
      type: 'choice',
      label: 'Subtitle size',
      sub: 'Movies and Series',
      options: SUB_SIZE_OPTIONS,
      get: () => settings.subSize,
      set: v => {
        settings.subSize = v;
        saveSettings();
        umsApplySubtitleStyle();
      }
    },
    {
      id: 'subColor',
      type: 'choice',
      label: 'Subtitle color',
      sub: 'Movies and Series',
      options: SUB_COLOR_OPTIONS,
      get: () => settings.subColor,
      set: v => {
        settings.subColor = v;
        saveSettings();
        umsApplySubtitleStyle();
      }
    },
    {
      id: 'subOpacity',
      type: 'choice',
      label: 'Subtitle opacity',
      sub: 'Text transparency; lower is dimmer',
      options: SUB_OPACITY_OPTIONS,
      get: () => settings.subOpacity,
      set: v => {
        settings.subOpacity = v;
        saveSettings();
        umsApplySubtitleStyle();
      }
    },
    {
      id: 'subBg',
      type: 'choice',
      label: 'Subtitle background',
      sub: 'Movies and Series',
      options: SUB_BG_OPTIONS,
      get: () => settings.subBg,
      set: v => {
        settings.subBg = v;
        saveSettings();
        umsApplySubtitleStyle();
      }
    },
    {
      id: 'subEdge',
      type: 'choice',
      label: 'Subtitle edge',
      sub: 'Movies and Series',
      options: SUB_EDGE_OPTIONS,
      get: () => settings.subEdge,
      set: v => {
        settings.subEdge = v;
        saveSettings();
        umsApplySubtitleStyle();
      }
    },
    {
      id: 'autoNext',
      type: 'toggle',
      label: 'Auto-play next episode',
      sub:
          'Series: when an episode ends, the next one starts after a short countdown',
      get: () => settings.autoNext !== false,
      set: v => {
        settings.autoNext = v;
        saveSettings();
      }
    },
    ...(_hbAvailable ? [{
      id: 'avSync',
      type: 'choice',
      label: 'AV sync (rooted TV)',
      sub:
          `LG AV Sync Adjustment (0-60), applied while this app is in front and restored when you leave it${
              _avSyncOrig ?
                  ` · TV was ${_avSyncOrig[_avSyncKey]} (${_avSyncKey})` :
                  ''}`,
      options: AV_SYNC_OPTIONS,
      get: () => (settings.avSync >= 0 ? settings.avSync : -1),
      set: v => {
        settings.avSync = v;
        saveSettings();
        if (v >= 0)
          avSyncApply(v).then(() => {
            if (settingsOpen) renderSettings();
          });
        else
          avSyncRestore();
      }
    }] :
                       []),
    {
      id: 'showAdult',
      type: 'toggle',
      label: 'Show adult categories',
      sub: 'Movies and Series',
      get: () => !!settings.showAdult,
      set: v => {
        settings.showAdult = v;
        saveSettings();
        if (vodMode !== 'live') {
          renderGroupsList();
          if (vodNav.screen === 'home')
            renderVodHome();
          else if (vodNav.screen === 'grid' && vodNav.list === 'all')
            openVodList('all');
        }
      }
    },
    {
      id: 'clearFavs',
      type: 'action',
      label: 'Clear favorites',
      sub: `${favoriteIds.size.toLocaleString()} saved`,
      button: 'Clear',
      disabled: !favoriteIds.size,
      run: () => showConfirmDialog(
          '⭐ Clear Favorites',
          `Remove all ${favoriteIds.size.toLocaleString()} favorites?`,
          clearFavorites)
    },
    {
      id: 'diag',
      type: 'action',
      label: 'Diagnostics',
      sub: `Startup timings, memory, stream engine and the last ${
          _diagLog.length ? _diagLog.length + ' ' : ''}errors`,
      button: 'Open',
      run: openDiag
    },
  ];
}
function settingsFocusables(rows) {
  return rows.filter(r => !r.disabled).map(r => r.id).concat(['close']);
}

function renderSettings() {
  const list = document.getElementById('settingsList');
  if (!list) return;
  const rows = settingsRows();
  _settingsRowsCache = rows;
  const foc = settingsFocusables(rows);
  settingsFocusIdx = Math.max(0, Math.min(settingsFocusIdx, foc.length - 1));
  const focusedId = foc[settingsFocusIdx];
  list.innerHTML = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'settings-row' + (r.disabled ? ' disabled' : '') +
        (r.id === focusedId ? ' focused' : '');
    row.dataset.id = r.id;
    let valueHtml;
    if (r.type === 'choice') {
      const o = r.options.find(x => x.v === r.get()) || r.options[0];
      valueHtml = `<button class="settings-arrow" data-dir="-1" aria-label="Previous">◀</button><span class="settings-val">${
          escapeHtml(
              o.label)}</span><button class="settings-arrow" data-dir="1" aria-label="Next">▶</button>`;
    } else if (r.type === 'toggle') {
      const on = !!r.get();
      valueHtml = `<span class="settings-switch${
          on ?
              ' on' :
              ''}"><span class="settings-knob"></span></span><span class="settings-val">${
          on ? 'On' : 'Off'}</span>`;
    } else {
      valueHtml = `<button class="settings-action">${
          escapeHtml(r.button || 'Go')}</button>`;
    }
    row.innerHTML = `<div class="settings-label"><div class="settings-name">${
        escapeHtml(r.label)}</div>${
        r.sub ? `<div class="settings-sub">${escapeHtml(r.sub)}</div>` :
                ''}</div><div class="settings-value">${valueHtml}</div>`;
    if (!r.disabled) {
      row.querySelectorAll('.settings-arrow')
          .forEach(b => b.addEventListener('click', e => {
            e.stopPropagation();
            settingsFocusIdx = foc.indexOf(r.id);
            settingsChange(r, +b.dataset.dir);
          }));
      row.addEventListener('click', () => {
        settingsFocusIdx = foc.indexOf(r.id);
        settingsActivate(r);
      });
    }
    list.appendChild(row);
  }
  const closeBtn = document.getElementById('settingsCloseBtn');
  if (closeBtn) closeBtn.classList.toggle('focused', focusedId === 'close');
  const f = list.querySelector('.settings-row.focused');
  if (f) f.scrollIntoView({block: 'nearest'});
}
function settingsChange(r, dir) {
  if (r.type === 'choice') {
    const i = r.options.findIndex(x => x.v === r.get());
    r.set(r.options[(i + dir + r.options.length) % r.options.length].v);
  } else if (r.type === 'toggle') {
    r.set(dir > 0 ? true : dir < 0 ? false : !r.get());
  }
  renderSettings();
}
function settingsActivate(r) {
  if (r.type === 'action') {
    r.run();
    return;
  }
  settingsChange(r, r.type === 'toggle' ? 0 : 1);
}
function handleSettingsKey(e) {
  const k = e.key, kc = e.keyCode;
  const rows = _settingsRowsCache || settingsRows();
  const foc = settingsFocusables(rows);
  const id = foc[settingsFocusIdx];
  const row = rows.find(r => r.id === id);
  if (k === 'ArrowUp' || kc === 38) {
    e.preventDefault();
    settingsFocusIdx = Math.max(0, settingsFocusIdx - 1);
    renderSettings();
  } else if (k === 'ArrowDown' || kc === 40) {
    e.preventDefault();
    settingsFocusIdx = Math.min(foc.length - 1, settingsFocusIdx + 1);
    renderSettings();
  } else if (k === 'ArrowLeft' || kc === 37) {
    e.preventDefault();
    if (row && row.type !== 'action') settingsChange(row, -1);
  } else if (k === 'ArrowRight' || kc === 39) {
    e.preventDefault();
    if (row && row.type !== 'action') settingsChange(row, 1);
  } else if (k === 'Enter' || kc === 13) {
    e.preventDefault();
    if (id === 'close')
      closeSettings();
    else if (row)
      settingsActivate(row);
  }
}
function openSettings() {
  if (confirmDialog && !confirmDialog.classList.contains('hidden')) return;
  const ov = document.getElementById('settingsOverlay');
  if (!ov) return;
  settingsOpen = true;
  settingsFocusIdx = 0;
  renderSettings();
  ov.classList.remove('hidden');
  if (document.activeElement && document.activeElement.blur)
    document.activeElement.blur();
}
function closeSettings() {
  const ov = document.getElementById('settingsOverlay');
  if (ov) ov.classList.add('hidden');
  settingsOpen = false;
  if (!startPage.classList.contains('hidden')) {
    updateFocusableElements();
    focusElement(currentFocusIndex);
  }
}
// ── Diagnostics overlay ──────────────────────────────────────
let diagOpen = false;
let _appVersion = '';
function diagLines() {
  const L = [];
  const mem = performance.memory ?
      `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB used of ${
          Math.round(
              performance.memory.jsHeapSizeLimit / 1048576)} MB JS heap` :
      'n/a';
  L.push(`IPTV Ultra ${_appVersion || ''}`.trim());
  L.push(`Up ${fmtClock(Math.round(performance.now() / 1000))} · ${
      new Date().toLocaleString()}`);
  L.push(`Memory: ${mem}`);
  L.push(`Agent: ${navigator.userAgent.slice(0, 120)}`);
  L.push('');
  L.push(`Playlist: ${_activePlaylistKey || 'none'} (${
      currentPlaylistType ||
      '-'}) · ${channels.length.toLocaleString()} channels · ${
      groupsList.length} groups · ${favoriteIds.size} favorites`);
  L.push(`EPG: ${epgData.size.toLocaleString()} channels cached · queue ${
      typeof _epgQueue !== 'undefined' ?
          _epgQueue.length :
          0} · window ${EPG_WIN_HOURS} h · past ${epgPastHours()} h`);
  const ch = currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
  const verr = videoPlayer.error ? ` · error ${videoPlayer.error.code}` : '';
  L.push(`Stream: ${ch ? ch.name : 'none'} · ${liveEngineName()} · ${
      liveEngine.tech ||
      '-'} · t=${(videoPlayer.currentTime || 0).toFixed(1)} s · readyState ${
      videoPlayer.readyState}${verr} · reloads ${_reloadAttempts}/${
      MAX_AUTO_RELOADS}${
      _altTried.size > 1 ? ` · ${_altTried.size} sources tried` : ''}`);
  L.push(`Engine incompatible this session: ${
      _hlsBroken.size ? [..._hlsBroken].length + ' channel(s)' :
                        'none'} · live buffer ${
      settings.liveBuffer ? settings.liveBuffer + ' min' : 'Off'} · engine ${
      settings.liveEngine === 'shaka' ? 'Shaka Player' : 'hls.js'}`);
  if (catchup) L.push(`Catch-up: ${catchup.prog && catchup.prog.title}`);
  const ago = t => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s} s ago` :
        s < 3600 ? `${Math.round(s / 60)} min ago` :
                   `${(s / 3600).toFixed(1)} h ago`;
  };
  const f = _lastStreamFail;
  if (f) {
    L.push(`Last stream failure: ${new Date(f.t).toLocaleTimeString()} (${
        ago(f.t)}) · ${f.engine} · ${f.what}`);
    if (f.name) L.push(`  Channel: ${f.name}`);
    if (f.reply) L.push(`  Server reply: ${f.reply}`);
  } else
    L.push('Last stream failure: none this session');
  if (currentPlaylistType === 'xtream') {
    const ci = _consInfo;
    L.push(
        ci ?
            `Account check: ${ci.active} of ${ci.max} connection${
                ci.max === 1 ? '' : 's'} in use · status ${ci.status || '?'}${
                ci.exp ? ` · expires ${new Date(ci.exp).toLocaleDateString()}` :
                         ''} · checked ${ago(ci.at)}${
                accountProblemText(ci) ?
                    ' · ⚠️ ' + accountProblemText(ci) :
                    ''}` :
            'Account check: not run yet (runs on the first failure of a stream)');
  }
  L.push('');
  const pt = performance.timing;
  if (pt && pt.navigationStart)
    L.push(`Page: DOM ready ${
        pt.domContentLoadedEventEnd - pt.navigationStart} ms · load ${
        pt.loadEventEnd > 0 ? pt.loadEventEnd - pt.navigationStart : '?'} ms`);
  L.push(
      'Startup marks (ms since script start): ' +
      _perfMarks.map(m => `${m.label} ${m.t}`).join(' · '));
  L.push('');
  L.push(`Errors (last ${_diagLog.length}):`);
  if (!_diagLog.length) L.push('  none');
  let prevHeader = false;
  for (let i = _diagLog.length - 1; i >= 0; i--) {
    const e = _diagLog[i];
    if (e.prev && !prevHeader) {
      prevHeader = true;
      L.push('  ── earlier runs ──');
    }
    L.push(`  ${
        e.prev ? new Date(e.t).toLocaleString() :
                 new Date(e.t).toLocaleTimeString()}  ${e.msg}`);
  }
  return L;
}
function renderDiag() {
  const pre = document.getElementById('diagText');
  if (!pre) return;
  pre.textContent = diagLines().join('\n');
}
function openDiag() {
  const ov = document.getElementById('diagOverlay');
  if (!ov) return;
  if (settingsOpen) closeSettings();
  diagOpen = true;
  ov.classList.remove('hidden');
  renderDiag();
  if (!_appVersion)
    fetch('appinfo.json')
        .then(r => r.json())
        .then(j => {
          _appVersion = j.version || '';
          if (diagOpen) renderDiag();
        })
        .catch(() => {});
  const pre = document.getElementById('diagText');
  if (pre) pre.scrollTop = 0;
}
function closeDiag() {
  if (!diagOpen) return;
  diagOpen = false;
  const ov = document.getElementById('diagOverlay');
  if (ov) ov.classList.add('hidden');
}
function handleDiagKey(e) {
  const k = e.key, kc = e.keyCode;
  const pre = document.getElementById('diagText');
  if (k === 'ArrowUp' || kc === 38) {
    e.preventDefault();
    if (pre) pre.scrollTop -= 160;
  } else if (k === 'ArrowDown' || kc === 40) {
    e.preventDefault();
    if (pre) pre.scrollTop += 160;
  } else if (k === 'Enter' || kc === 13) {
    e.preventDefault();
    renderDiag();
  } else if (kc === 403 || k === 'ColorF0Red') {
    e.preventDefault();
    _diagLog.length = 0;
    diagSave();
    renderDiag();
  }
}

function clearFavorites() {
  favoriteIds.clear();
  saveFavorites();
  document.querySelectorAll('.epg-fav-btn, .epg-info-fav-btn').forEach(el => {
    el.textContent = '☆';
    el.classList.remove('fav-active');
  });
  refreshViewIfLoaded();
  if (settingsOpen) renderSettings();
}
