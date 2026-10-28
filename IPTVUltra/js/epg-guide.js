/**
 * @fileoverview Xtream API helpers, EPG toasts, the guide layout, catch-up,
 * lazy Xtream EPG, and the minute tick.
 */

// ----- Xtream API -----
/**
 * Saves an Xtream playlist, or updates the saved playlist with the same server
 * and user name.
 * @param {string} serverUrl
 * @param {string} username
 * @param {string} password
 * @param {string} name Empty for the default name.
 * @param {string=} epgUrl Optional XMLTV address. Empty removes it, and
 *     `undefined` keeps the saved address.
 */
function addXtreamPlaylist(serverUrl, username, password, name, epgUrl) {
  const existing = savedPlaylists.find(
      p => p.type === 'xtream' && p.url === serverUrl &&
          p.username === username);
  if (existing) {
    existing.name = name || existing.name;
    existing.password = password;
    if (epgUrl !== undefined) existing.epgUrl = epgUrl;
    savePlaylistsToStorage();
    updateStartStatus(
        `Playlist "${existing.name}" updated!`, false, true, false, 0);
  } else {
    let displayName = name;
    if (!displayName) {
      try {
        displayName = `${username}@${new URL(serverUrl).host}`;
      } catch {
        displayName = username;
      }
    }
    savedPlaylists.push({
      type: 'xtream',
      name: displayName,
      url: serverUrl,
      username,
      password,
      epgUrl: epgUrl || ''
    });
    savePlaylistsToStorage();
    updateStartStatus('Xtream playlist saved!', false, true, false, 0);
  }
  setTimeout(() => updateStartStatus('Ready', false, false, false, 0), 2000);
  xtreamServer.value = '';
  xtreamUsername.value = '';
  xtreamPassword.value = '';
  xtreamEpgUrl.value = '';
  xtreamName.value = '';
  updateFocusableElements();
  focusElement(0);
}

// ── EPG Toast Notifications ───────────────────────────────────
let _epgToastTimer = null;
function showEPGToast(msg, type = 'loading', title) {
  const toast = document.getElementById('epgToast');
  const titleEl = document.getElementById('epgToastTitle');
  const msgEl = document.getElementById('epgToastMsg');
  const spinner = document.getElementById('epgToastSpinner');
  if (!toast) return;
  if (_epgToastTimer) {
    clearTimeout(_epgToastTimer);
    _epgToastTimer = null;
  }
  const titles = {
    loading: 'EPG Loading',
    error: 'EPG Error',
    success: 'EPG Ready'
  };
  toast.className = `epg-toast epg-toast--${type} epg-toast--visible`;
  if (titleEl) titleEl.textContent = title || titles[type] || 'EPG';
  if (msgEl) msgEl.textContent = msg;
  if (spinner) spinner.style.display = type === 'loading' ? '' : 'none';
}
function hideEPGToast(delayMs = 0) {
  const dismiss = () => {
    const toast = document.getElementById('epgToast');
    if (toast) toast.classList.remove('epg-toast--visible');
  };
  if (delayMs > 0) {
    _epgToastTimer = setTimeout(dismiss, delayMs);
  } else {
    dismiss();
  }
}

// ── EPG Guide Layout ──────────────────────────────────────────
const EPG_CH_W = 300;      // channel label column px (must match .epg-ch-label
                           // width in style.css)
const EPG_PX_PER_MIN = 8;  // pixels per minute — ~3.6h visible on 1920px screen
const EPG_AHEAD_HOURS = 6;      // guide window ahead of now
const EPG_PAST_HOURS_MIN = 1;   // behind now when no channel offers catch-up
const EPG_PAST_HOURS_MAX = 72;  // behind now with catch-up (provider archives
                                // are 1–7 days; the guide shows up to 3)
let EPG_WIN_HOURS = EPG_PAST_HOURS_MIN +
    EPG_AHEAD_HOURS;  // total window; recomputed per playlist by epgPastHours()
// Hours of history the guide shows: 1 h, or the longest catch-up archive in the
// playlist (capped)
function epgPastHours() {
  let days = 0;
  for (const ch of channels)
    if (ch.archive > days) days = ch.archive;
  return days ? Math.min(EPG_PAST_HOURS_MAX, days * 24) : EPG_PAST_HOURS_MIN;
}

// ── Catch-up (provider timeshift archive) ─────────────────────
// Xtream channels flagged tv_archive carry `archive` (days). Past programmes on
// those rows within the archive are playable: the guide extends into the past
// (epgPastHours), Left/Right move a programme cursor (epgFocusT) along the
// focused row, and OK on a past programme plays the provider's timeshift
// stream: /timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<streamId>.ts,
// start time expressed in the server's timezone (server_info.timezone from the
// auth call). Past programmes come from get_simple_data_table (full table incl.
// history, with has_archive); the short EPG only lists what is coming up. While
// a timeshift stream plays, `catchup` holds the programme and the live slot
// plays it through the native pipeline; any channel change returns to live.
let catchup = null;  // { chIdx, prog, url, dur } while a timeshift stream plays
let epgFocusT = 0;   // programme cursor time in the guide (ms); 0 = "now"
const _epgFullFetched = new Set();  // tvgIds whose full table (history) has
                                    // been requested this session
const _epgFullPending = new Set();
function channelHasCatchup(ch) {
  return !!(_xt && ch && ch.archive > 0 && ch.streamId !== undefined);
}
function progIsCatchup(ch, p, now) {
  if (!channelHasCatchup(ch) || p.stop > (now || Date.now())) return false;
  if (p.hasArchive === false) return false;
  return p.start >= (now || Date.now()) - ch.archive * 86400000;
}
// The panel expects the timeshift start in the same clock it prints its EPG
// `start` strings in. That is not reliably server_info.timezone (one panel
// reports Europe/Amsterdam yet prints UTC strings), so the offset is learnt
// from the EPG itself: `start` string vs `start_timestamp`
// (xtreamNoteEpgOffset).
function fmtTimeshiftStart(ms, tz) {
  const d = new Date(
      ms +
      (typeof _xt === 'object' && _xt && typeof _xt.epgOffsetMin === 'number' ?
           _xt.epgOffsetMin * 60000 :
           0));
  const p = n => String(n).padStart(2, '0');
  if (typeof _xt === 'object' && _xt && typeof _xt.epgOffsetMin === 'number') {
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${
        p(d.getUTCDate())}:${p(d.getUTCHours())}-${p(d.getUTCMinutes())}`;
  }
  try {
    const parts = new Intl
                      .DateTimeFormat('en-GB', {
                        timeZone: tz || 'UTC',
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false
                      })
                      .formatToParts(new Date(ms));
    const g = t => (parts.find(x => x.type === t) || {}).value || '00';
    return `${g('year')}-${g('month')}-${g('day')}:${
        g('hour') === '24' ? '00' : g('hour')}-${g('minute')}`;
  } catch (_) {
    const u = new Date(ms);
    return `${u.getUTCFullYear()}-${p(u.getUTCMonth() + 1)}-${
        p(u.getUTCDate())}:${p(u.getUTCHours())}-${p(u.getUTCMinutes())}`;
  }
}
// Learn the panel's clock from one EPG listing: minutes between its `start`
// string (read as UTC) and start_timestamp
function xtreamNoteEpgOffset(ep) {
  if (!_xt || typeof _xt.epgOffsetMin === 'number' || !ep || !ep.start) return;
  const m =
      String(ep.start).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  const ts = parseInt(ep.start_timestamp) * 1000;
  if (!m || isNaN(ts)) return;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off = Math.round((asUtc - ts) / 60000);
  if (Math.abs(off) > 14 * 60) return;
  _xt.epgOffsetMin = off;
  // Remember it with the cached playlist so a cached launch can build catch-up
  // URLs before any EPG fetch
  const key = _activePlaylistKey, xt = _xt;
  if (key)
    cacheGet('playlists', key).then(rec => {
      if (rec && _xt === xt && _activePlaylistKey === key &&
          rec.epgOffsetMin !== off) {
        rec.epgOffsetMin = off;
        cachePut('playlists', key, rec);
      }
    });
}
function catchupUrl(ch, prog) {
  const mins = Math.max(1, Math.ceil((prog.stop - prog.start) / 60000));
  return `${_xt.base}/timeshift/${_xt.user}/${_xt.pass}/${mins}/${
      fmtTimeshiftStart(
          epgUnshiftTime(prog.start),
          _xt.tz)}/${ch.streamId}.${
      catchupExt()}`;  // archive is indexed by provider time
}
// When Shaka Player is the live engine, a catch-up first uses the archive as
// HLS (.m3u8): Shaka Player then plays E-AC-3 audio and gives the tracks
// menu. If the provider does not send the archive as HLS, the catch-up
// continues with the .ts URL on the native pipeline, and the next catch-ups
// of the session use the .ts URL immediately.
let _catchupHlsFailed = false;
function catchupExt() {
  return liveMseEngine() === 'shaka' && !_catchupHlsFailed ? 'm3u8' : 'ts';
}
/**
 * Plays the catch-up from its .ts URL on the native pipeline after Shaka
 * Player could not play the .m3u8 URL.
 * @param {string} url The .m3u8 URL of the catch-up.
 */
function catchupHlsFailed(url) {
  _catchupHlsFailed = true;
  const c = catchup;
  c.url = url.replace(/\.m3u8$/, '.ts');
  diagLog('Catch-up: Shaka Player cannot play the archive as HLS → .ts URL');
  umsNoteCurrentId();
  setNativeSrc(c.url);
  liveUmsRefresh();
  catchupSeekOnLoad(c);
  videoPlayer.play().catch(() => {});
}
// Goes to the start position of a catch-up when its stream has metadata
function catchupSeekOnLoad(c) {
  if (!c.seekTo) return;
  videoPlayer.addEventListener('loadedmetadata', () => {
    if (catchup !== c) return;
    try {
      videoPlayer.currentTime = c.seekTo;
    } catch (_) { /* not seekable: plays from the programme start */
    }
  }, {once: true});
}
// Server timezone is needed for timeshift start times; cached loads skip the
// auth call, so fetch it lazily
function xtreamEnsureServerInfo() {
  if (!_xt || _xt.tz || _xt.tzPending) return;
  const xt = _xt;
  xt.tzPending = true;
  fetch(`${xt.base}/player_api.php?username=${xt.u}&password=${xt.pw}`)
      .then(r => r.json())
      .then(d => {
        if (_xt !== xt) return;
        xt.tz = (d && d.server_info && d.server_info.timezone) || 'UTC';
        if (_activePlaylistKey)
          cacheGet('playlists', _activePlaylistKey).then(rec => {
            if (rec && _activePlaylistKey && rec.tz !== xt.tz) {
              rec.tz = xt.tz;
              cachePut('playlists', _activePlaylistKey, rec);
            }
          });
      })
      .catch(() => {
        if (_xt === xt) xt.tzPending = false;
      });
}
// Full EPG table (history + future) for one channel, merged into epgData
async function fetchXtreamEpgFull(tvgId) {
  const xt = _xt;
  const streamId = xt ? _xtStreamIdByTvgId.get(tvgId) : undefined;
  if (!xt || streamId === undefined || _epgFullFetched.has(tvgId)) return;
  _epgFullFetched.add(tvgId);
  _epgFullPending.add(tvgId);
  try {
    const resp =
        await fetch(`${xt.base}/player_api.php?username=${xt.u}&password=${
            xt.pw}&action=get_simple_data_table&stream_id=${streamId}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (_xt !== xt) return;
    const listings = data && data.epg_listings;
    if (!Array.isArray(listings)) return;
    const byStart = new Map();
    for (const p of epgData.get(tvgId) || []) byStart.set(p.start, p);
    if (listings.length) xtreamNoteEpgOffset(listings[0]);
    for (const ep of listings) {
      const pStart = epgShiftTime(parseInt(ep.start_timestamp) * 1000),
            pStop = epgShiftTime(parseInt(ep.stop_timestamp) * 1000);
      if (isNaN(pStart) || isNaN(pStop) || pStop <= pStart) continue;
      const title = unescapeXml(decodeBase64Field(ep.title || '').trim());
      const rawDesc =
          unescapeXml(decodeBase64Field(ep.description || '').trim());
      const prog = {
        start: pStart,
        stop: pStop,
        title,
        desc: rawDesc.replace(_RE_TS_INJECT, '').trim()
      };
      if (ep.has_archive !== undefined)
        prog.hasArchive = String(ep.has_archive) === '1';
      byStart.set(pStart, prog);
    }
    const progs = [...byStart.values()].sort((a, b) => a.start - b.start);
    if (!progs.length) return;
    epgData.delete(tvgId);
    epgData.set(tvgId, progs);
    epgIdMap.set(tvgId.toLowerCase(), tvgId);
    const m = _epgFetchMeta.get(tvgId);
    if (!m || m.status !== 'pending')
      _epgFetchMeta.set(tvgId, {at: Date.now(), status: 'done'});
    epgPersist(
        tvgId, Date.now(),
        epgShiftProgs(progs, -1));  // cache keeps provider time
    onEpgChannelUpdated(tvgId);
  } catch (_) {
    _epgFullFetched.delete(
        tvgId); /* retried next time the cursor moves there */
  } finally {
    _epgFullPending.delete(tvgId);
    if (epgMode) {
      for (const [idx, el] of epgRenderedRows) {
        const ch = currentFilteredChannels[idx];
        if (ch && ch.tvgId === tvgId)
          el.classList.remove('epg-row-loading-past');
      }
    }
  }
}
// Play a past programme from the provider archive in the live slot (Shaka
// Player or the native pipeline, see `catchupExt`). `startAt` is the position
// in the program (in s) where the stream starts.
function startCatchup(chIdx, prog, startAt) {
  const ch = channels[chIdx];
  if (!ch || !channelHasCatchup(ch)) return;
  if (vodPlay.active) stopVodPlayback(false);
  stopStallWatchdog();
  if (_errRetryTimer) {
    clearTimeout(_errRetryTimer);
    _errRetryTimer = null;
  }
  if (currentChannelIndex >= 0 && currentChannelIndex !== chIdx)
    lastChannelIndex = currentChannelIndex;
  currentChannelIndex = chIdx;
  _reloadAttempts = 0;
  catchup = {
    chIdx,
    prog,
    url: catchupUrl(ch, prog),
    dur: (prog.stop - prog.start) / 1000,
    seekTo: startAt > 0 ? startAt : 0
  };
  videoPlayer.pause();
  umsNoteCurrentId();
  if (loadLiveSource(catchup.url)) {
    umsRelease(liveUms);
    liveUms = null;
  } else
    liveUmsRefresh();
  // Shaka Player gets the position with its load
  if (!liveEngine.shaka) catchupSeekOnLoad(catchup);
  videoPlayer.play().catch(() => {});
  startStallWatchdog();
  // The banner does not keep the codec line of the live channel (with its
  // rewind reach): the catch-up writes its own line when it plays
  const techEl = document.getElementById('vodOsdTech');
  if (techEl) techEl.textContent = '';
  channelInfoTag.innerText = `⏪ ${ch.name} · ${prog.title}`;
  channelInfoTag.style.visibility = '';
  statusArea.innerText = `⏪ ${prog.title}`;
  if (epgMode) {
    for (const [, el] of epgRenderedRows) el.classList.remove('active');
    const fi = currentFilteredChannels.indexOf(ch);
    if (fi >= 0 && epgRenderedRows.has(fi))
      epgRenderedRows.get(fi).classList.add('active');
    updateEPGInfoPanel(ch);
  }
  if (!livePlayer.active)
    enterLivePlayer();
  else
    showVodOsd();
}
function catchupBackToLive() {
  if (!catchup) return;
  const idx = catchup.chIdx;
  catchup = null;
  if (channels[idx]) selectChannel(idx);
}

// ── Rewind into the archive ─────────────────────────────────────
// On an archive channel, a rewind in the live player can go before the start
// of the hls.js buffer. Then the rewind continues in the provider archive, at
// the same time of day. If the live stream has no buffer (the `<video>`
// element without hls.js), Left starts the archive
// `ARCHIVE_NATIVE_BEHIND_MS` before the live point. In the archive, the rewind
// stops at the start of the program.
const ARCHIVE_NATIVE_BEHIND_MS = 10000;
// The clock time of a position in the live stream, in `Date.now()` units
function liveWallTimeAt(t) {
  if (!liveEngineActive()) return Date.now();
  const r = liveBufferRange();
  return Date.now() - Math.max(0, r.live - t) * 1000;
}
// The program to play for a time on a channel. This is the EPG program that
// contains the time, cut at `Date.now()` if it continues. If the EPG
// has no program for the time, the result starts at the time (rounded down
// to 60 s) and stops at `Date.now()`. The result is `null` if the EPG
// shows that the archive does not have the program.
//
// The provider gives `has_archive` 0 to the program that is on at this time.
// But the archive has the first part of that program. Thus, the value is
// correct only for a program that stopped.
function archiveProgAt(ch, ms, now) {
  const progs = epgProgsOf(ch.tvgId) || [];
  const p = progs.find(x => !x.fromName && x.start <= ms && ms < x.stop);
  if (p) {
    if (p.hasArchive === false && p.stop <= now) return null;
    return {start: p.start, stop: Math.min(p.stop, now), title: p.title};
  }
  return {start: Math.floor(ms / 60000) * 60000, stop: now, title: 'Archive'};
}
// Start the archive of the channel that plays, at `targetMs`. The result is
// `false` if the channel has no archive for that time. Then the function does
// no action.
function rewindIntoArchive(targetMs) {
  const idx = currentChannelIndex;
  const ch = idx >= 0 ? channels[idx] : null;
  if (!ch || catchup || vodPlay.active || !channelHasCatchup(ch)) return false;
  const now = Date.now();
  if (targetMs >= now || targetMs < now - ch.archive * 86400000) return false;
  const prog = archiveProgAt(ch, targetMs, now);
  if (!prog) return false;
  startCatchup(idx, prog, (targetMs - prog.start) / 1000);
  return true;
}
// Left in the live player. The result is `true` if a step of `stepSec` goes
// before the start of the buffer, and the archive starts.
function liveLeftIntoArchive(stepSec) {
  if (catchup || vodPlay.active || !livePlayer.active) return false;
  // During the load of hls.js, no engine is active, but the channel does not
  // use the native pipeline
  if (liveEngine.hlsWait) return false;
  if (!liveEngineActive())
    return rewindIntoArchive(Date.now() - ARCHIVE_NATIVE_BEHIND_MS);
  const t = videoPlayer.currentTime || 0;
  if (t - stepSec >= liveBufferRange().start) return false;
  return rewindIntoArchive(liveWallTimeAt(t) - stepSec * 1000);
}

function enterEPGMode() {
  if (currentPlaylistType !== 'xtream') return;
  epgMode = true;
  const sv = document.getElementById('standardView');
  const ev = document.getElementById('epgView');
  if (!sv || !ev) return;
  sv.style.display = 'none';
  ev.style.display = 'flex';
  // Sync EPG search input with current query
  const epgSI = document.getElementById('epgSearchInput');
  if (epgSI) epgSI.value = currentSearchQuery;
  // Move <video> and stream-info overlay into the EPG video container
  const wrap = document.getElementById('epgVideoWrap');
  if (wrap) {
    if (videoPlayer.parentNode !== wrap) wrap.appendChild(videoPlayer);
  }
  placeLiveNotice();
  // Start focus cursor at the currently playing channel
  if (currentChannelIndex >= 0) {
    const idx = currentFilteredChannels.indexOf(channels[currentChannelIndex]);
    epgFocusedRowIdx = idx >= 0 ? idx : 0;
  } else {
    epgFocusedRowIdx = 0;
  }
  const floatingBtn = document.getElementById('epgFloatingGroupsBtn');
  if (floatingBtn)
    floatingBtn.style.display = !groupsColumnVisible ? '' : 'none';
  renderEPGGuide();
  if (currentChannelIndex >= 0 && channels[currentChannelIndex]) {
    updateEPGInfoPanel(channels[currentChannelIndex]);
  }
}

// Restore the standard layout after the EPG guide was shown: swap the view
// containers back and return the <video> + stream-info overlay to videoArea.
function exitEPGMode() {
  epgMode = false;
  const sv = document.getElementById('standardView');
  const ev = document.getElementById('epgView');
  if (sv) sv.style.display = 'flex';
  if (ev) ev.style.display = 'none';
  if (videoPlayer.parentNode !== videoArea)
    videoArea.insertBefore(videoPlayer, videoArea.firstChild);
  placeLiveNotice();
}

function refreshCurrentView() {
  if (vodMode !== 'live') {
    if (vodNav.screen === 'home')
      renderVodHome();
    else if (vodNav.screen === 'grid')
      renderVodGrid();
    else if (vodNav.screen === 'details')
      renderVodDetails();
    return;
  }
  if (currentPlaylistType === 'xtream')
    renderEPGGuide();
  else
    renderChannelList();
}

// Logos that failed to load this session: never re-requested (the provider's
// CDN answers slowly for them)
const _epgLogoFailed = new Set();
function epgLogoFailed(img) {
  img.style.display = 'none';
  img.classList.add('failed');
  if (img.dataset.src) _epgLogoFailed.add(img.dataset.src);
  if (img.parentNode) img.parentNode.classList.remove('has-logo');
}
// Logos are not requested while the guide is being scrolled: rows carry
// data-src and the src is set once scrolling has settled (epgOnScrollSettled).
// Otherwise every key repeat fetched and decoded an image the user never saw,
// which is paint and network work the TV cannot afford.
function epgLoadVisibleLogos() {
  for (const [, el] of epgRenderedRows) {
    const img = el.querySelector('.epg-ch-logo[data-src]:not([src])');
    if (img) img.src = img.dataset.src;
  }
}
// Descriptions are a single clipped line; the widest block shows ~1.5 lines of
// text at most, so the rest of a long description is only layout work for the
// TV.
const EPG_DESC_MAX = 160;
// Programme blocks (or the placeholder) for one channel over the current window
function epgProgsHtml(ch) {
  const now = Date.now();
  const progs = epgProgsOf(ch.tvgId) || [];
  const parts =
      [`<div class="epg-progs-clip"><div class="epg-progs" style="width:${
          _epgTotalGuideW}px">`];
  let hadBlock = false;
  for (const p of progs) {
    if (p.stop <= _epgWinStart || p.start >= _epgWinEnd) continue;
    const sx = Math.max(0, (p.start - _epgWinStart) / 60000 * EPG_PX_PER_MIN)
                   .toFixed(1);
    const ex = Math.min(
        _epgTotalGuideW, (p.stop - _epgWinStart) / 60000 * EPG_PX_PER_MIN);
    const w = (ex - parseFloat(sx) - 2).toFixed(1);
    if (parseFloat(w) < 4) continue;
    const isNow = p.start <= now && p.stop > now;
    const isPast = p.stop <= now;
    const wNum = parseFloat(w);
    const descHtml = p.desc && wNum > 120 * TEXT_SCALE ?
        `<span class="epg-prog-desc">${
            escapeHtml(
                p.desc.length > EPG_DESC_MAX ? p.desc.slice(0, EPG_DESC_MAX) :
                                               p.desc)}</span>` :
        '';
    const cls = (isNow ? ' now-playing' : '') +
        (isPast ? (progIsCatchup(ch, p, now) ? ' past catchup' : ' past') : '');
    parts.push(
        `<div class="epg-prog-block${cls}" data-start="${p.start}" data-stop="${
            p.stop}" style="left:${sx}px;width:${w}px">` +
        `<span class="epg-prog-title">${escapeHtml(p.title)}</span>${
            descHtml}</div>`);
    hadBlock = true;
  }
  if (!hadBlock) {
    // An event outside the window (next week's race) names its date instead of
    // "No data"
    const ev = progs.length === 1 && progs[0].fromName ? progs[0] : null;
    const label = ev ?
        escapeHtml(
            `${ev.title} · ${new Date(ev.start).toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short'
            })} ${formatClock(ev.start)}`) :
        epgPlaceholderText(ch.tvgId);
    const cls = label === 'Loading ...' ? 'epg-prog-placeholder loading' :
                                          'epg-prog-placeholder';
    parts.push(
        `<div class="${cls}" style="left:2px;width:${
            (_epgTotalGuideW - 4).toFixed(1)}px">` +
        `<span class="epg-prog-title">${label}</span></div>`);
  }
  parts.push('</div></div>');
  return parts.join('');
}

function buildEPGRow(i) {
  const ch = currentFilteredChannels[i];
  const origIdx = getChannelIndex(ch);
  const isActive = origIdx === currentChannelIndex;

  const row = document.createElement('div');
  row.className = 'epg-row' + (isActive ? ' active' : '') +
      (i === epgFocusedRowIdx ? ' epg-focused' : '');
  row.style.cssText = `position:absolute;top:${i * EPG_ROW_H}px;left:0;right:0`;

  const logoSrc = ch.tvgLogo && !_epgLogoFailed.has(ch.tvgLogo) ?
      escapeHtml(ch.tvgLogo) :
      '';
  const favId = favIdOf(ch, origIdx);
  const isFav = favoriteIds.has(favId);
  const labelHtml = `<div class="epg-ch-label"><div class="epg-ch-logo-wrap${
      logoSrc ? ' has-logo' : ''}"><span class="epg-ch-no-logo">📺</span>${
      logoSrc ? `<img class="epg-ch-logo" data-src="${
                    logoSrc}" decoding="async" onerror="epgLogoFailed(this)">` :
                ''}</div><span class="epg-ch-name">${
      escapeHtml(
          ch.name.length > 22 ? ch.name.slice(0, 20) + '…' :
                                ch.name)}</span><button class="epg-fav-btn${
      isFav ? ' fav-active' : ''}" data-fav-id="${escapeHtml(favId)}">${
      isFav ? '★' : '☆'}</button></div>`;

  row.innerHTML = labelHtml + epgProgsHtml(ch);
  row.querySelector('.epg-fav-btn').addEventListener('click', e => {
    e.stopPropagation();
    toggleEPGFav(favId);
  });
  row.addEventListener('click', () => {
    for (const [, el] of epgRenderedRows) el.classList.remove('active');
    row.classList.add('active');
    selectChannel(origIdx);
    updateEPGInfoPanel(ch);
  });
  return row;
}

// Viewport size of the guide scroller, read once per layout change instead of
// on every key (each read forces a synchronous layout, which is what made key
// repeats stutter on the TV).
let _epgViewH = 0, _epgViewW = 0;
let _epgRenderQueued = false;
let _epgLastStartIdx = -1;
function epgMeasureViewport() {
  const so = document.getElementById('epgScrollOuter');
  if (!so) return;
  _epgViewH = so.clientHeight;
  _epgViewW = so.clientWidth;
}
// One render per animation frame, however many scroll events or key repeats
// arrived in between
function queueEPGRender() {
  if (_epgRenderQueued) return;
  _epgRenderQueued = true;
  requestAnimationFrame(() => {
    _epgRenderQueued = false;
    renderEPGVisibleRows();
  });
}

function renderEPGVisibleRows() {
  const body = document.getElementById('epgBody');
  const scrollOuter = document.getElementById('epgScrollOuter');
  if (!body || !scrollOuter || !currentFilteredChannels.length ||
      !_epgTotalGuideW)
    return;
  const BUFFER = 3;
  // Row i occupies content offset [strip + i*rowH, strip + (i+1)*rowH)
  const scrollTop = scrollOuter.scrollTop;
  if (!_epgViewH) epgMeasureViewport();
  const viewH = _epgViewH;
  const startIdx = Math.max(0, Math.floor(scrollTop / EPG_ROW_H) - BUFFER);
  const endIdx = Math.min(
      currentFilteredChannels.length - 1,
      Math.ceil((scrollTop + viewH - EPG_TIME_STRIP_H) / EPG_ROW_H) + BUFFER);
  let changed = false;
  for (const [idx, el] of epgRenderedRows) {
    if (idx < startIdx || idx > endIdx) {
      el.remove();
      epgRenderedRows.delete(idx);
      changed = true;
    }
  }
  if (epgRenderedRows.size < endIdx - startIdx + 1) {
    const frag = document.createDocumentFragment();
    for (let i = startIdx; i <= endIdx; i++) {
      if (epgRenderedRows.has(i)) continue;
      const row = buildEPGRow(i);
      frag.appendChild(row);
      epgRenderedRows.set(i, row);
      changed = true;
    }
    body.appendChild(frag);
  }
  if (changed || startIdx !== _epgLastStartIdx) {
    _epgScrollDir = startIdx >= _epgLastStartIdx ? 1 : -1;
    _epgLastStartIdx = startIdx;
    scheduleEpgFetchForVisible();
  }
  if (changed) updateEPGBlockFocus();
}
let _epgScrollDir = 1;

// Horizontal position of the guide in px (0 = window start). Applied as a CSS
// variable on the scroller that the time strip and every row's programme area
// translate by; see .epg-progs in style.css.
let _epgX = 0;
function epgMaxPan() {
  if (!_epgViewW) epgMeasureViewport();
  return Math.max(
      0,
      EPG_WIN_HOURS * 60 * EPG_PX_PER_MIN - Math.max(1, _epgViewW - EPG_CH_W));
}
function epgApplyPan() {
  const so = document.getElementById('epgScrollOuter');
  if (!so) return;
  so.style.setProperty('--epg-x', `${- _epgX}px`);
  updateEPGNowMarker();
  updateEPGNavVisibility();
}

function updateEPGNowMarker() {
  const body = document.getElementById('epgBody');
  const timeMarks = document.getElementById('epgTimeMarks');
  if (!body || !timeMarks || !_epgWinStart) return;
  const fullMarker = body.querySelector('.epg-now-fullmarker');
  if (!fullMarker) return;
  const nowOffsetPx = (Date.now() - _epgWinStart) / 60000 * EPG_PX_PER_MIN;
  const x = EPG_CH_W + nowOffsetPx - _epgX;
  fullMarker.style.display = x < EPG_CH_W ? 'none' : '';
  fullMarker.style.left = `${x.toFixed(1)}px`;
  const stripLine =
      timeMarks.querySelector('.epg-now-line');  // the labelled NOW line in the
                                                 // time strip (pans with it)
  if (stripLine) stripLine.style.left = `${nowOffsetPx.toFixed(1)}px`;
}

function rebuildEPGSkeleton(winStart, winEnd) {
  const timeMarks = document.getElementById('epgTimeMarks');
  if (!timeMarks) return;
  const totalGuideW = EPG_WIN_HOURS * 60 * EPG_PX_PER_MIN;
  _epgWinStart = winStart;
  _epgWinEnd = winEnd;
  _epgTotalGuideW = totalGuideW;
  _epgSkeletonWinStart = winStart;

  timeMarks.style.width = totalGuideW + 'px';
  const QUARTER_HOUR_MS = 15 * 60000;
  const firstMark = Math.ceil(winStart / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  let tmHtml = '';
  for (let t = firstMark; t <= winEnd; t += QUARTER_HOUR_MS) {
    const x = ((t - winStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
    const minOfHour = new Date(t).getMinutes();
    if (minOfHour === 0) {
      tmHtml += `<span class="epg-time-marker" style="left:${x}px">${
          formatClock(t)}</span>`;
    } else if (minOfHour === 30) {
      tmHtml += `<span class="epg-time-tick epg-time-tick-half" style="left:${
          x}px"></span>`;
    } else {
      tmHtml += `<span class="epg-time-tick" style="left:${x}px"></span>`;
    }
  }
  // Day labels at each midnight when the window spans more than one day
  // (catch-up history)
  if (winEnd - winStart > 26 * 3600000) {
    const d0 = new Date(winStart);
    d0.setHours(0, 0, 0, 0);
    for (let t = d0.getTime(); t <= winEnd; t += 86400000) {
      if (t < winStart) continue;
      const x = ((t - winStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
      const d = new Date(t);
      tmHtml += `<span class="epg-day-label" style="left:${x}px">${
          d.toLocaleDateString(
              undefined,
              {weekday: 'short', day: 'numeric', month: 'short'})}</span>`;
    }
  }
  const nowOffsetPx =
      ((Date.now() - winStart) / 60000 * EPG_PX_PER_MIN).toFixed(1);
  tmHtml += `<div class="epg-now-line" style="left:${
      nowOffsetPx}px"><span class="epg-now-label">NOW</span></div>`;
  timeMarks.innerHTML = tmHtml;
}

function refreshEPGRows() {
  const scrollOuter = document.getElementById('epgScrollOuter');
  const body = document.getElementById('epgBody');
  if (!body) return;

  const prevScrollTop = scrollOuter ? scrollOuter.scrollTop : 0;

  body.innerHTML = '';
  body.style.height = '';
  epgRenderedRows.clear();
  if (epgVirtualScrollListener && scrollOuter) {
    scrollOuter.removeEventListener('scroll', epgVirtualScrollListener);
    epgVirtualScrollListener = null;
  }

  if (!currentFilteredChannels.length) {
    body.innerHTML =
        `<div class="epg-empty-group">📭 No channels exist for this group …</div>`;
    updateEPGNavVisibility();
    return;
  }

  body.style.height = `${currentFilteredChannels.length * EPG_ROW_H}px`;
  epgMeasureViewport();
  _epgLastStartIdx = -1;
  renderEPGVisibleRows();
  epgVirtualScrollListener = queueEPGRender;
  if (scrollOuter)
    scrollOuter.addEventListener(
        'scroll', epgVirtualScrollListener, {passive: true});

  // Full-height "now" line — positioned after layout via rAF so offsetLeft is
  // accurate
  if (scrollOuter) {
    let fullMarker = body.querySelector('.epg-now-fullmarker');
    if (!fullMarker) {
      fullMarker = document.createElement('div');
      fullMarker.className = 'epg-now-fullmarker';
      body.appendChild(fullMarker);
    }
    requestAnimationFrame(updateEPGNowMarker);
  }

  // Restore the vertical position; keep the time pan, or centre it on "now" the
  // first time
  if (scrollOuter) {
    if (prevScrollTop > 0) scrollOuter.scrollTop = prevScrollTop;
    if (_epgX > 0) {
      epgApplyPan();
    } else {
      requestAnimationFrame(() => {
        const nowOffsetPx = (_epgWinStart ? (Date.now() - _epgWinStart) : 0) /
            60000 * EPG_PX_PER_MIN;
        epgMeasureViewport();
        const visibleW = Math.max(1, _epgViewW - EPG_CH_W);
        _epgX = Math.max(
            0, Math.min(epgMaxPan(), Math.floor(nowOffsetPx - visibleW / 3)));
        epgApplyPan();
      });
    }
  }

  // Clamp focused row and apply highlight
  epgFocusedRowIdx = Math.min(
      epgFocusedRowIdx, Math.max(0, currentFilteredChannels.length - 1));
  updateEPGRowFocus();
}

function renderEPGGuide() {
  const guideWrap = document.getElementById('epgGuideWrap');
  if (!guideWrap) return;
  if (guideWrap.clientWidth <= 0) {
    requestAnimationFrame(renderEPGGuide);
    return;
  }

  renderChannelList();  // always updates currentFilteredChannels (exits early
                        // for Xtream after filtering)

  const now = Date.now();
  const HOUR_MS = 3600000;
  const pastH = epgPastHours();
  const winHours = pastH + EPG_AHEAD_HOURS;
  const winStart = Math.floor((now - pastH * HOUR_MS) / HOUR_MS) * HOUR_MS;
  const winEnd = winStart + winHours * HOUR_MS;

  if (winStart !== _epgSkeletonWinStart || winHours !== EPG_WIN_HOURS) {
    const keepX = EPG_WIN_HOURS === winHours ?
        0 :
        -1;  // a different window width invalidates the pan
    EPG_WIN_HOURS = winHours;
    rebuildEPGSkeleton(winStart, winEnd);
    if (keepX < 0) _epgX = 0;
  }
  refreshEPGRows();
}

function updateEPGInfoPanel(ch) {
  const logo = document.getElementById('epgInfoLogo');
  const name = document.getElementById('epgInfoName');
  const time = document.getElementById('epgInfoTime');
  const title = document.getElementById('epgInfoTitle');
  const desc = document.getElementById('epgInfoDesc');
  const favBtn = document.getElementById('epgInfoFavBtn');
  if (!name) return;

  if (ch.tvgLogo) {
    logo.src = ch.tvgLogo;
    logo.style.display = '';
  } else
    logo.style.display = 'none';

  name.textContent = ch.name;
  const groupEl = document.getElementById('epgInfoGroup');
  if (groupEl) groupEl.textContent = ch.group || '';

  if (favBtn) {
    const favId = favIdOf(ch, getChannelIndex(ch));
    favBtn.dataset.favId = favId;
    const isFav = favoriteIds.has(favId);
    favBtn.textContent = isFav ? '★' : '☆';
    favBtn.classList.toggle('fav-active', isFav);
  }

  const nowPlayingLabel = document.getElementById('epgInfoNowPlayingLabel');
  const curr = getCurrentProgramme(ch.tvgId);
  if (curr) {
    const minsLeft = Math.max(0, Math.ceil((curr.stop - Date.now()) / 60000));
    time.textContent = `${formatClock(curr.start)} – ${
        formatClock(curr.stop)}  (${formatDuration(minsLeft)})`;
    title.textContent = curr.title;
    desc.textContent = curr.desc || '';
    if (nowPlayingLabel) nowPlayingLabel.style.display = '';
  } else {
    const placeholder = epgPlaceholderText(ch.tvgId);
    time.textContent = '';
    title.textContent = placeholder;
    desc.textContent = '';
    if (nowPlayingLabel) nowPlayingLabel.style.display = 'none';
  }

  const upNextEl = document.getElementById('epgInfoUpNext');
  const nextTimeEl = document.getElementById('epgInfoNextTime');
  const nextTitleEl = document.getElementById('epgInfoNextTitle');
  const nextDescEl = document.getElementById('epgInfoNextDesc');
  const next = getNextProgramme(ch.tvgId);
  if (upNextEl && next) {
    nextTimeEl.textContent =
        `${formatClock(next.start)} – ${formatClock(next.stop)}`;
    nextTitleEl.textContent = next.title;
    nextDescEl.textContent = next.desc || '';
    upNextEl.style.display = '';
  } else if (upNextEl) {
    upNextEl.style.display = 'none';
  }
}

function unescapeXml(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s
      .replace(
          /&#x([0-9A-Fa-f]+);/g,
          (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, '\'')
      .replace(/&nbsp;/g, ' ');
}

function decodeBase64Field(s) {
  if (!s || s.length % 4 !== 0 || !_RE_B64.test(s)) return s || '';
  try {
    const bytes = Uint8Array.from(atob(s), c => c.charCodeAt(0));
    // Try UTF-8 first — atob() gives raw bytes as Latin-1 chars, which
    // produces mojibake when the actual content is multi-byte UTF-8.
    try {
      const r = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      if (r.length > 0 && _RE_B64_ALPHA.test(r)) return r;
    } catch (_) { /* not valid UTF-8 */
    }
    // Fallback: treat as Latin-1
    const r = String.fromCharCode(...bytes);
    let ok = r.length > 0;
    for (let ci = 0; ok && ci < r.length; ci++) {
      const c = r.charCodeAt(ci);
      if (c < 0x20 && c !== 0x09 && c !== 0x0A) ok = false;
    }
    if (ok && _RE_B64_ALPHA.test(r)) return r;
  } catch (e) {
  }
  return s;
}

// ── Xtream lazy EPG (per channel, on demand) ─────────────────
// Fetching get_short_epg for every channel up front took minutes on large
// providers (17k channels ≈ 17k requests). Instead EPG is fetched only for
// rows that are on screen, for the playing channel, and in the background
// for favorites. Results live in epgData with a TTL and LRU eviction.
function resetLazyEpg() {
  _xt = null;
  _xtStreamIdByTvgId = new Map();
  _epgFetchMeta.clear();
  _epgQueue = [];
  _epgQueued.clear();
  _epgPrefetchActive = false;
  if (_epgVisibleFetchTimer) {
    clearTimeout(_epgVisibleFetchTimer);
    _epgVisibleFetchTimer = null;
  }
}

function epgNeedsFetch(tvgId) {
  if (!_xt || !tvgId) return false;
  const m = _epgFetchMeta.get(tvgId);
  if (!m) return true;
  if (m.status === 'pending') return false;
  return (Date.now() - m.at) > EPG_CACHE_TTL_MS;
}

// Placeholder text for a guide row / info panel that has no programme blocks
function epgPlaceholderText(tvgId) {
  if (_xt) {
    if (!tvgId || !_xtStreamIdByTvgId.has(tvgId))
      return 'No data available ...';
    const m = _epgFetchMeta.get(tvgId);
    if (!m || m.status === 'pending') return 'Loading ...';
    return 'No data available ...';
  }
  return epgLoading ? 'Loading ...' : 'No data available ...';
}

// Queue channels for EPG fetch. front=true puts them ahead of everything queued
// (visible rows / playing channel); front=false appends (favorites prefetch).
function queueEpgFetch(tvgIds, front) {
  if (!_xt) return;
  const add = [];
  for (const id of tvgIds) {
    if (!id) continue;
    if (_epgQueued.has(id)) {
      if (front) add.push(id);
      continue;
    }
    if (!epgNeedsFetch(id)) continue;
    _epgQueued.add(id);
    _epgFetchMeta.set(id, {at: 0, status: 'pending'});
    add.push(id);
  }
  if (add.length) {
    if (front) {
      const addSet = new Set(add);
      _epgQueue = add.concat(_epgQueue.filter(x => !addSet.has(x)));
    } else {
      _epgQueue = _epgQueue.concat(add);
    }
    // Bound the backlog: drop the lowest-priority tail; it is re-queued if it
    // scrolls into view
    while (_epgQueue.length > EPG_QUEUE_MAX) {
      const dropped = _epgQueue.pop();
      _epgQueued.delete(dropped);
      _epgFetchMeta.delete(dropped);
    }
  }
  pumpEpgQueue();
}

// Request starts are spaced out: the provider answers bursts of get_short_epg
// with empty listings (measured on the C4 2026-10-07: 60 parallel requests → 15
// with data; the same ids one at a time → all with data)
let _epgLastStart = 0, _epgPumpTimer = null;
function pumpEpgQueue() {
  while (_epgInFlight < EPG_FETCH_CONCURRENCY && _epgQueue.length) {
    const wait = _epgLastStart + EPG_FETCH_SPACING_MS - Date.now();
    if (wait > 0) {
      if (!_epgPumpTimer)
        _epgPumpTimer = setTimeout(() => {
          _epgPumpTimer = null;
          pumpEpgQueue();
        }, wait);
      return;
    }
    _epgLastStart = Date.now();
    const id = _epgQueue.shift();
    _epgQueued.delete(id);
    _epgInFlight++;
    fetchXtreamEpgFor(id).then(null, () => {}).then(() => {
      _epgInFlight--;
      pumpEpgQueue();
    });
  }
  if (_epgPrefetchActive && !_epgQueue.length && !_epgInFlight) {
    _epgPrefetchActive = false;
    showEPGToast('Favorites guide ready', 'success');
    hideEPGToast(2500);
    if (currentChannelIndex >= 0 && channels[currentChannelIndex])
      statusArea.innerText = `▶️ ${channels[currentChannelIndex].name}`;
  }
}

async function fetchXtreamEpgFor(tvgId) {
  const xt = _xt;
  const streamId = xt ? _xtStreamIdByTvgId.get(tvgId) : undefined;
  if (!xt || streamId === undefined) {
    _epgFetchMeta.set(tvgId, {at: Date.now(), status: 'done'});
    return;
  }
  const progs = [];
  let ok = false;
  try {
    const resp = await fetch(`${xt.base}/player_api.php?username=${
        xt.u}&password=${xt.pw}&action=get_short_epg&stream_id=${
        streamId}&limit=${EPG_XT_LIMIT}`);
    if (resp.ok) {
      const data = await resp.json();
      ok = true;
      const listings = data && data.epg_listings;
      if (Array.isArray(listings)) {
        const cutoff = Date.now() -
            2 * 3600000;  // keep a little history for the 1h-back guide window
        if (listings.length) xtreamNoteEpgOffset(listings[0]);
        for (const ep of listings) {
          const pStart = epgShiftTime(parseInt(ep.start_timestamp) * 1000);
          const pStop = epgShiftTime(parseInt(ep.stop_timestamp) * 1000);
          if (isNaN(pStart) || isNaN(pStop) || pStop < cutoff) continue;
          const title = unescapeXml(decodeBase64Field(ep.title || '').trim());
          const rawDesc =
              unescapeXml(decodeBase64Field(ep.description || '').trim());
          progs.push({
            start: pStart,
            stop: pStop,
            title,
            desc: rawDesc.replace(_RE_TS_INJECT, '').trim()
          });
        }
        progs.sort((a, b) => a.start - b.start);
      }
    }
  } catch (_) { /* network error — becomes eligible for retry below */
  }
  if (_xt !== xt) return;  // playlist changed while this request was in flight
  // A failed fetch is retried after 60 s instead of waiting out the full TTL.
  // An empty answer is retried after EPG_EMPTY_RETRY_MS (providers return empty
  // lists under load) and never replaces data already held.
  const empty = ok && !progs.length;
  _epgFetchMeta.set(tvgId, {
    at: ok ? (empty ? Date.now() - EPG_CACHE_TTL_MS + EPG_EMPTY_RETRY_MS :
                      Date.now()) :
             Date.now() - EPG_CACHE_TTL_MS + 60000,
    status: ok ? 'done' : 'error'
  });
  if (ok && progs.length)
    epgPersist(
        tvgId, Date.now(),
        epgShiftProgs(progs, -1));  // cache keeps provider time
  if (empty && epgData.has(tvgId)) {
    onEpgChannelUpdated(tvgId);
    return;
  }  // keep what we have (stale beats blank)
  if (progs.length) {
    epgData.delete(
        tvgId);  // re-insert so Map insertion order doubles as LRU order
    epgData.set(tvgId, progs);
    epgIdMap.set(tvgId.toLowerCase(), tvgId);
    if (epgData.size > EPG_CACHE_MAX) {
      for (const k of epgData.keys()) {
        if (epgData.size <= EPG_CACHE_MAX) break;
        epgData.delete(k);
        _epgFetchMeta.delete(k);
      }
    }
  } else {
    epgData.delete(tvgId);
  }
  onEpgChannelUpdated(tvgId);
}

// Refresh whatever is on screen for this channel, in place. Completed fetches
// arrive in bursts after a scroll stops, so they are batched: one animation
// frame swaps the programme area of every affected row, and only that area (the
// label and its logo stay; rebuilding whole rows re-decoded every logo).
const _epgDirtyIds = new Set();
let _epgDirtyRaf = 0;
function onEpgChannelUpdated(tvgId) {
  if (currentPlaylistType !== 'xtream') return;
  _epgDirtyIds.add(tvgId);
  if (!_epgDirtyRaf) _epgDirtyRaf = requestAnimationFrame(flushEpgRowUpdates);
}
function flushEpgRowUpdates() {
  _epgDirtyRaf = 0;
  const ids = new Set(_epgDirtyIds);
  _epgDirtyIds.clear();
  if (!ids.size) return;
  const sc = surfChannel();
  if (sc && sc.tvgId && ids.has(sc.tvgId) && livePlayer.active)
    updateLiveOsd();  // previewed channel's programme arrived
  if (epgMode) {
    for (const [idx, el] of epgRenderedRows) {
      const ch = currentFilteredChannels[idx];
      if (!ch || !ids.has(ch.tvgId)) continue;
      const progs = el.querySelector('.epg-progs-clip');
      if (progs) progs.outerHTML = epgProgsHtml(ch);
    }
    updateEPGBlockFocus();  // the focused row's blocks may have been replaced
  }
  const cur = currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
  if (cur && ids.has(cur.tvgId)) {
    if (epgMode) updateEPGInfoPanel(cur);
    updateNowNext();
  }
}

// Debounced: once scrolling settles, load the logos of the rendered rows and
// fetch EPG for them (front of the queue), then prefetch the next rows in the
// direction of travel so they are already filled in when they scroll into view
// (back of the queue; dropped first when the backlog is full).
const EPG_LOOKAHEAD_ROWS = 12;
function scheduleEpgFetchForVisible() {
  if (_epgVisibleFetchTimer) clearTimeout(_epgVisibleFetchTimer);
  _epgVisibleFetchTimer = setTimeout(epgOnScrollSettled, 150);
}
function epgOnScrollSettled() {
  _epgVisibleFetchTimer = null;
  if (!epgMode) return;
  epgLoadVisibleLogos();
  if (!_xt) return;
  const ids = [];
  let lo = Infinity, hi = -1;
  for (const idx of epgRenderedRows.keys()) {
    if (idx < lo) lo = idx;
    if (idx > hi) hi = idx;
    const ch = currentFilteredChannels[idx];
    if (ch && ch.tvgId) ids.push(ch.tvgId);
  }
  if (ids.length) queueEpgFetch(ids, true);
  if (hi < 0) return;
  const ahead = [];
  const from =
      _epgScrollDir >= 0 ? hi + 1 : Math.max(0, lo - EPG_LOOKAHEAD_ROWS);
  const to = _epgScrollDir >= 0 ?
      Math.min(currentFilteredChannels.length - 1, hi + EPG_LOOKAHEAD_ROWS) :
      lo - 1;
  for (let i = from; i <= to; i++) {
    const ch = currentFilteredChannels[i];
    if (ch && ch.tvgId) ahead.push(ch.tvgId);
  }
  if (ahead.length) queueEpgFetch(ahead, false);
}

// Background prefetch so the Favorites group is populated without scrolling
function prefetchFavoritesEpg() {
  if (!_xt) return;
  const ids = new Set();
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    if (ch.tvgId && favoriteIds.has(favIdOf(ch, i)) && epgNeedsFetch(ch.tvgId))
      ids.add(ch.tvgId);
  }
  if (!ids.size) return;
  _epgPrefetchActive = true;
  showEPGToast(
      `Loading guide for ${ids.size.toLocaleString()} favorites …`, 'loading');
  queueEpgFetch([...ids], false);
}

// ── Minute tick ───────────────────────────────────────────────
function startEpgTick() {
  if (epgRefreshTimer) clearInterval(epgRefreshTimer);
  epgRefreshTimer = setInterval(epgMinuteTick, 60000);
}

// Runs once a minute. Updates only what is on screen, in place; the full guide
// is rebuilt only when the hour window rolls over.
function epgMinuteTick() {
  const now = Date.now();
  if (currentPlaylistType === 'xtream' && epgMode && vodMode === 'live') {
    const HOUR_MS = 3600000;
    // Same window origin as renderEPGGuide (catch-up playlists start days back,
    // not 1 h): with a 1 h lookback here every tick looked like a rollover and
    // panned the guide an hour into the past per minute
    const winStart =
        Math.floor((now - epgPastHours() * HOUR_MS) / HOUR_MS) * HOUR_MS;
    if (_epgSkeletonWinStart && winStart !== _epgSkeletonWinStart) {
      // Hour rolled over: shift the horizontal scroll so the same wall-clock
      // time stays in view, then rebuild the time strip and rows once.
      _epgX = Math.max(0, _epgX - 60 * EPG_PX_PER_MIN);
      renderEPGGuide();
    } else {
      updateEPGNowMarker();
      for (const [, el] of epgRenderedRows) {
        const blocks = el.getElementsByClassName('epg-prog-block');
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          b.classList.toggle(
              'now-playing', +b.dataset.start <= now && +b.dataset.stop > now);
        }
      }
      scheduleEpgFetchForVisible();  // re-queues rows whose cached EPG passed
                                     // its TTL
    }
    if (currentChannelIndex >= 0 && channels[currentChannelIndex])
      updateEPGInfoPanel(channels[currentChannelIndex]);
  } else if (currentPlaylistType === 'm3u') {
    // Refresh the "now" line of visible channel rows in place
    for (const [idx, el] of renderedItems) {
      const ch = currentFilteredChannels[idx];
      const span = el.querySelector('.channel-epg');
      if (!ch || !span) continue;
      const p = getCurrentProgramme(ch.tvgId);
      span.textContent = p ?
          (p.title.length > 36 ? p.title.substring(0, 34) + '…' : p.title) :
          '';
    }
    // Re-download the XMLTV feed periodically so the 6h window never runs dry
    if (currentEpgUrl && !epgLoading && _epgLoadedAt &&
        now - _epgLoadedAt > EPG_M3U_REFRESH_MS)
      loadEPG(currentEpgUrl);
  }
  updateNowNext();
  if (livePlayer.active &&
      document.getElementById('vodOsd').classList.contains('visible'))
    updateLiveOsd();
}

async function loadXtreamPlaylist(serverUrl, username, password) {
  if (isLoading) return;
  isLoading = true;
  resetLazyEpg();
  resetVodState(false);
  epgData.clear();
  epgIdMap.clear();
  setLoadSelectedButtonEnabled(false);
  updateStartStatus('Connecting to Xtream API …', false, false, true, 0);
  showLoading(true, 'Connecting to Xtream API …');

  const base = serverUrl.replace(/\/$/, '');
  const u = encodeURIComponent(username);
  const pw = encodeURIComponent(password);

  try {
    const key = 'x:' + base + '|' + username;
    const cached = await cacheGet('playlists', key);
    if (cached && Array.isArray(cached.channels) && cached.channels.length) {
      applyXtreamChannels(
          cached.channels, base, username, password, true, cached.tz || '',
          cached.epgOffsetMin);
      _playlistCacheAt = cached.at || 0;
      setTimeout(() => refreshPlaylistInBackground(false), 2500);
      return;
    }

    // 1. Authenticate (only on a fresh load; a cached list is trusted until the
    // background refresh)
    const authResp =
        await fetch(`${base}/player_api.php?username=${u}&password=${pw}`);
    if (!authResp.ok) throw new Error(`Auth HTTP ${authResp.status}`);
    const authData = await authResp.json();
    if (authData.user_info && authData.user_info.auth === 0)
      throw new Error('Invalid username or password');
    updateStartStatus(
        'Authenticated! Loading categories …', false, false, true, 15);
    const tz = (authData.server_info && authData.server_info.timezone) || 'UTC';

    const parsed = await xtreamFetchChannels(
        base, username, password,
        (msg, pct) => updateStartStatus(msg, false, false, true, pct));
    applyXtreamChannels(parsed, base, username, password, false, tz);
    _playlistCacheAt = Date.now();
    cachePut(
        'playlists', key,
        {at: _playlistCacheAt, type: 'xtream', channels: parsed, tz});
  } catch (err) {
    updateStartStatus(`Error: ${err.message}`, true, false, false, 0);
    setLoadSelectedButtonEnabled(true);
  } finally {
    isLoading = false;
    showLoading(false);
    setTimeout(() => {
      if (!startPage.classList.contains('hidden'))
        updateStartStatus('Ready', false, false, false, 0);
    }, 3000);
  }
}
// Categories + live streams from the provider, mapped to the internal channel
// shape in batches. progress(msg, pct) is optional (the start page shows it;
// the background refresh passes null).
async function xtreamFetchChannels(base, username, password, progress) {
  const u = encodeURIComponent(username), pw = encodeURIComponent(password);
  const note = (msg, pct) => {
    if (progress) progress(msg, pct);
  };
  let catMap = {};
  try {
    const catResp = await fetch(`${base}/player_api.php?username=${
        u}&password=${pw}&action=get_live_categories`);
    if (catResp.ok) {
      const cats = await catResp.json();
      if (Array.isArray(cats))
        cats.forEach(c => {
          catMap[String(c.category_id)] = c.category_name;
        });
    }
  } catch { /* categories are optional */
  }
  note('Loading channel list …', 30);
  const streamsResp = await fetch(`${base}/player_api.php?username=${
      u}&password=${pw}&action=get_live_streams`);
  if (!streamsResp.ok) throw new Error(`Streams HTTP ${streamsResp.status}`);
  const streamsText = await streamsResp.text();
  note('Parsing channels …', 55);
  await new Promise(r => setTimeout(r, 0));  // yield before heavy JSON parse
  const streams = JSON.parse(streamsText);
  if (!Array.isArray(streams) || !streams.length)
    throw new Error('No live channels found');
  const parsed = [];
  const BATCH = 5000;
  for (let i = 0; i < streams.length; i += BATCH) {
    const slice = streams.slice(i, i + BATCH);
    for (const s of slice) {
      const num = parseInt(s.num);
      const archiveDays = String(s.tv_archive) === '1' ?
          (parseInt(s.tv_archive_duration) || 0) :
          0;
      parsed.push({
        name: s.name || 'Unknown',
        tvgId: s.epg_channel_id || String(s.stream_id),
        tvgLogo: s.stream_icon || '',
        group: catMap[String(s.category_id)] || '',
        url: `${base}/live/${username}/${password}/${s.stream_id}.m3u8`,
        streamId: s.stream_id,
        num: isNaN(num) ?
            0 :
            num,  // provider channel number (direct entry with the digit keys)
        archive:
            archiveDays,  // catch-up days offered by the provider, 0 = none
      });
    }
    note(
        `Parsed ${parsed.length.toLocaleString()} channels …`,
        Math.min(90, 55 + Math.round((i / streams.length) * 35)));
    await new Promise(r => setTimeout(r, 5));
  }
  return parsed;
}
// Everything after an Xtream channel list is available (parsed fresh or read
// from the cache)
function applyXtreamChannels(
    parsed, base, username, password, fromCache, tz, epgOffsetMin) {
  channels = parsed;
  buildChannelIndexMap();
  _xt = {
    base,
    u: encodeURIComponent(username),
    pw: encodeURIComponent(password),
    user: username,
    pass: password,
    tz: tz || ''
  };
  if (typeof epgOffsetMin === 'number') _xt.epgOffsetMin = epgOffsetMin;
  if (!_xt.tz)
    xtreamEnsureServerInfo();  // timeshift start times need the server timezone
  catchup = null;
  epgFocusT = 0;
  _epgFullFetched.clear();
  _epgFullPending.clear();
  resetVodState(true);  // show the Live / Movies / Series switch
  _xtStreamIdByTvgId = new Map();
  for (const ch of parsed)
    if (!_xtStreamIdByTvgId.has(ch.tvgId))
      _xtStreamIdByTvgId.set(ch.tvgId, ch.streamId);
  localStorage.setItem(
      'last_m3u_url', '');  // clear M3U cache; Xtream uses its own auth
  updateStartStatus(
      `Loaded ${channels.length.toLocaleString()} channels${
          fromCache ? ' (cached)' : ''}!`,
      false, true, false, 100);
  currentSearchQuery = '';
  searchInput.value = '';
  _activePlaylistKey = 'x:' + base + '|' + username;
  epgOffsetLoad();
  favoritesLoad();
  _m3uSource = null;
  rememberLastPlaylist(_activePlaylistKey);
  currentGroup = initialGroupFor(_activePlaylistKey);
  currentPlaylistType = 'xtream';
  extractGroups();
  validateCurrentGroup();
  startPage.classList.add('hidden');
  mainApp.style.display = 'flex';
  perfMark(`channels-applied(${channels.length}${fromCache ? ',cache' : ''})`);
  enterEPGMode();  // switch to guide layout immediately; programme blocks fill
                   // in as EPG loads
  perfMark('guide-rendered');
  statusArea.innerText = `✅ ${channels.length.toLocaleString()} channels`;
  if (channels.length) setTimeout(selectInitialChannel, 500);
  // EPG is fetched lazily per visible row (see "Xtream lazy EPG"): cached
  // entries first, then favorites in the background
  startEpgTick();
  const key = _activePlaylistKey;
  epgRestoreFromCache(key).then(n => {
    perfMark(`epg-cache-restored(${n})`);
    if (_activePlaylistKey === key) setTimeout(prefetchFavoritesEpg, 800);
  });
}
