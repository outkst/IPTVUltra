/**
 * @fileoverview Live engine (native video or hls.js with a rewind buffer), the
 * provider connection limit, and AV sync on rooted TVs.
 */

// ----- Live engine: native <video> or hls.js with a rewind buffer -----
// HLS channels (.m3u8; Xtream live URLs are built that way) can be played
// through hls.js, which feeds the <video> via Media Source Extensions so the
// app owns the buffer: `settings.liveBuffer` minutes behind the playhead are
// kept for rewind, and the same amount is fetched ahead while paused so
// playback resumes where it stopped. Raw MPEG-TS streams stay on the native
// pipeline, which decodes everything but exposes no rewind buffer. Anything
// hls.js cannot play (HEVC or AC-3 inside TS segments, a bad manifest) raises a
// fatal hls.js error and the channel goes back to the native player for the
// rest of the session (`_hlsBroken`). The webOS media service (liveUms) is not
// used on the hls.js path; the codec line comes from the HLS level instead.
const liveEngine = {
  hls: null,
  url: '',
  tech: '',
  recovered: false,
  resumeUrl: '',
  fps: 0,
  fpsSamples: []
};
const _hlsBroken = new Set();
// Measured on the C4 (2026-10-06): a SourceBuffer refuses appends ("full,
// cannot free space") at ~86 MB, i.e. 120 s of 1080p at 6.2 Mbps. Fetching
// ahead is capped below that so the limit is never hit; the minutes setting is
// therefore an upper bound and the real reach depends on the channel's bitrate.
const HLS_BUFFER_BYTES = 70 * 1000 * 1000;
function hlsReachMinutes(bitrate) {
  if (!(bitrate > 0)) return settings.liveBuffer;
  return Math.max(
      1,
      Math.min(
          settings.liveBuffer,
          Math.floor(HLS_BUFFER_BYTES * 8 / bitrate / 60)));
}
function isHlsUrl(url) {
  return /\.m3u8(\?|#|$)/i.test(url || '') ||
      /[?&](type|output)=m3u8/i.test(url || '');
}
function hlsAvailable() {
  return settings.liveBuffer > 0 && typeof Hls !== 'undefined' &&
      Hls.isSupported();
}
function liveEngineActive() {
  return !!liveEngine.hls;
}
// The provider starts a relay when the first viewer connects. The first
// playlist of a cold relay has 1 segment and #EXT-X-ENDLIST (seen on the
// "CA| SPORTSNET PPV" channels, 2026-10-20). hls.js then plays the stream as a
// finished VOD: approximately 11 s, then the state ENDED. Later playlists of
// the same stream are usual live playlists. A live channel does not end, thus
// this playlist loader removes the tag.
let _livePlaylistLoader = null;
function livePlaylistLoader() {
  if (_livePlaylistLoader) return _livePlaylistLoader;
  _livePlaylistLoader = class extends Hls.DefaultConfig.loader {
    load(context, config, callbacks) {
      const onSuccess = callbacks.onSuccess;
      super.load(context, config, Object.assign({}, callbacks, {
        onSuccess(response, stats, ctx, networkDetails) {
          if (typeof response.data === 'string') {
            response.data =
                response.data.replace(/^#EXT-X-ENDLIST[ \t]*\r?$/gm, '');
          }
          onSuccess(response, stats, ctx, networkDetails);
        }
      }));
    }
  };
  return _livePlaylistLoader;
}
function liveEngineDestroy() {
  if (liveEngine.hls) {
    try {
      liveEngine.hls.destroy();
    } catch (_) { /* already gone */
    }
    liveEngine.hls = null;
  }
  liveEngine.url = '';
  liveEngine.tech = '';
}
// Point the live <video> at a channel URL through whichever engine fits.
// Returns true when hls.js took it.
function loadLiveSource(url) {
  liveEngineDestroy();
  if (!(hlsAvailable() && isHlsUrl(url) && !_hlsBroken.has(url))) {
    videoPlayer.src = url;
    videoPlayer.load();
    return false;
  }
  const secs = settings.liveBuffer * 60;
  const hls = new Hls({
    backBufferLength: secs,  // keep this much behind the playhead for rewind
    maxBufferLength: secs,   // and fetch this far ahead, so a pause can be
                             // resumed from the buffer
    maxMaxBufferLength: secs * 2,
    maxBufferSize: HLS_BUFFER_BYTES,  // bytes ahead of the playhead; below the
                                      // TV's ~86 MB SourceBuffer quota
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount:
        Infinity,  // never force the playhead back to the live edge
    lowLatencyMode: false,
    enableWorker: true,
    capLevelToPlayerSize: false,
    manifestLoadingMaxRetry: 2,
    fragLoadingMaxRetry: 4,
    pLoader: livePlaylistLoader(),  // a live playlist never ends
  });
  liveEngine.hls = hls;
  liveEngine.url = url;
  liveEngine.tech = '';
  liveEngine.recovered = false;
  liveEngine.resumeUrl = '';
  liveEngine.fps = 0;
  liveEngine.fpsSamples = [];
  liveEngine.subManual = false;
  liveEngine.audioManual = false;
  videoPlayer.removeAttribute(
      'src');  // hls.js attaches its own MediaSource URL
  hls.on(Hls.Events.ERROR, (_, data) => onHlsError(url, data));
  hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, applyHlsTrackPrefs);
  hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, applyHlsTrackPrefs);
  hls.on(Hls.Events.MANIFEST_PARSED, liveTechFromHls);
  hls.on(Hls.Events.LEVEL_SWITCHED, liveTechFromHls);
  hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, liveTechFromHls);
  hls.on(Hls.Events.BUFFER_APPENDING, (_, d) => hlsFpsFromAppend(hls, d));
  hls.loadSource(url);
  hls.attachMedia(videoPlayer);
  return true;
}
// Body of the manifest response hls.js could not parse ('' when there was none)
function hlsReplyBody(data) {
  return data && data.response && typeof data.response.data === 'string' ?
      data.response.data :
      '';
}
function onHlsError(url, data) {
  if (!data || !data.fatal || liveEngine.url !== url) return;
  console.log('hls.js fatal error', data.type, data.details);
  // A provider that refuses the stream (one-connection account in use, expired,
  // rate limited) answers the playlist request with an HTML or text page, which
  // hls.js reports as a manifest parsing error. Only a real playlist (#EXTM3U)
  // that still fails to parse says the channel is unplayable through hls.js.
  const isParse = data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;
  const body = isParse ? hlsReplyBody(data) : '';
  const notPlaylist = isParse && !/^\s*#EXTM3U/.test(body);
  const nd = data.networkDetails,
        status = nd && nd.status ? nd.status :
                                   (data.response && data.response.code) || 0;
  const reply = isParse ?
      (body.replace(/\s+/g, ' ').trim().slice(0, 160) || '(empty)') :
      '';
  diagLog(
      `hls.js fatal ${data.type}/${data.details}${
          status ? ` HTTP ${status}` : ''}${reply ? ` reply: ${reply}` : ''}` +
      `${notPlaylist ? ' → not a playlist, treated as a network failure' : ''}${
          document.hidden ? ' (app hidden)' : ''}`);
  noteStreamFail(
      'hls.js',
      `${data.type}/${data.details}${status ? ` · HTTP ${status}` : ''}`,
      reply);
  const hls = liveEngine.hls;
  // Hidden app: webOS freezes the page's timers and network, which hls.js
  // reports as failed requests. Nothing is wrong with the channel; retry on the
  // hls path when the app is visible again.
  if (document.hidden) {
    liveEngine.resumeUrl = url;
    liveEngineDestroy();
    return;
  }
  // A media error gets one in-place recovery (hls.js re-creates its
  // SourceBuffers) before we give up on it
  if (hls && data.type === Hls.ErrorTypes.MEDIA_ERROR &&
      !liveEngine.recovered &&
      data.details !== Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR) {
    liveEngine.recovered = true;
    try {
      hls.recoverMediaError();
      videoPlayer.play().catch(() => {});
      return;
    } catch (_) { /* fall through to native */
    }
  }
  // Content hls.js cannot handle (codecs it cannot demux, unparsable manifest)
  // is remembered so the native pipeline takes the channel for the rest of the
  // session; plain network failures are not held against it
  const incompatible = data.type === Hls.ErrorTypes.MEDIA_ERROR ||
      data.type === Hls.ErrorTypes.MUX_ERROR || (isParse && !notPlaylist) ||
      data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR;
  if (incompatible) _hlsBroken.add(url);
  liveEngineDestroy();
  // Hand the channel to the native pipeline; its own error handler and reload
  // budget take over from here
  if (vodMode === 'live' && !vodPlay.active && currentChannelIndex >= 0 &&
      channels[currentChannelIndex].url === url) {
    umsNoteCurrentId();
    videoPlayer.src = url;
    videoPlayer.load();
    liveUmsRefresh();
    videoPlayer.play().catch(() => {});
  }
}
// Codec / resolution / bitrate line from the HLS level (the media service does
// not describe MSE playback)
function liveTechFromHls() {
  const hls = liveEngine.hls;
  if (!hls || !hls.levels || !hls.levels.length) return;
  const lvl = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : 0];
  const bits = [];
  const vc = String(lvl.videoCodec || '').toLowerCase();
  if (vc)
    bits.push(
        /^(avc|h264)/.test(vc)         ? 'H.264' :
            /^(hvc|hev|h265)/.test(vc) ? 'HEVC' :
                                         vc.split('.')[0].toUpperCase());
  if (lvl.width && lvl.height)
    bits.push(`${lvl.width}×${lvl.height}`);
  else if (videoPlayer.videoWidth)
    bits.push(`${videoPlayer.videoWidth}×${videoPlayer.videoHeight}`);
  const fps = lvl.frameRate || liveEngine.fps;
  if (fps) bits.push(fmtFps(fps));
  if (lvl.bitrate) bits.push(`${Math.round(lvl.bitrate / 1000)} kbps`);
  const ac = String(lvl.audioCodec || '').toLowerCase();
  if (ac)
    bits.push(
        /^mp4a\.40/.test(ac) ? 'AAC' :
            /^ac-3/.test(ac) ? 'AC-3' :
            /^ec-3/.test(ac) ? 'E-AC-3' :
                               ac.toUpperCase());
  const reach = hlsReachMinutes(lvl.bitrate);
  bits.push(`⏪ ${reach < settings.liveBuffer ? '~' : ''}${reach} min`);
  liveEngine.tech = bits.join(' · ');
  noteCurrentStreamTech();
  if (livePlayer.active) {
    const el = document.getElementById('vodOsdTech');
    if (el) el.textContent = liveEngine.tech;
  } else
    showFeedStats(liveEngine.tech);
}
// Frame rate as shown on the codec line; measured rates snap to the broadcast
// ones (23.976 … 120) within 2 %
const FPS_STD =
    [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];
function fpsSnap(f) {
  let best = 0;
  for (const c of FPS_STD)
    if (Math.abs(f - c) / c < 0.02 &&
        (!best || Math.abs(f - c) < Math.abs(f - best)))
      best = c;
  return best || Math.round(f);
}
function fmtFps(f) {
  return `${(+f).toFixed(3).replace(/\.?0+$/, '')} fps`;
}
// HLS playlists rarely state FRAME-RATE (the provider's never do), so the
// hls.js path counts it: hls.js remuxes each segment to fMP4 before appending,
// and the moof's trun carries the number of video samples in it. Samples over
// the segment's PTS span is the frame rate. One segment of 6 s or more is
// enough (a frame more or less moves the rate by under 0.2 fps; some channels
// are a single 600 s segment); shorter ones take the median of three.
function hlsFpsFromAppend(hls, d) {
  if (liveEngine.hls !== hls || liveEngine.fps || !d || d.type !== 'video' ||
      !(d.data instanceof Uint8Array))
    return;
  const b = d.data, f = d.frag;
  const es = f && f.elementaryStreams && f.elementaryStreams.video;
  const span = es && es.endPTS > es.startPTS ? es.endPTS - es.startPTS :
                                               (f && f.duration) || 0;
  if (!(span > 1)) return;
  let n = 0;
  for (let i = 4, end = Math.min(b.length - 12, 8192); i < end; i++) {
    if (b[i] === 0x74 && b[i + 1] === 0x72 && b[i + 2] === 0x75 &&
        b[i + 3] === 0x6e) {  // 'trun': version/flags, then sample_count
      n = ((b[i + 8] << 24) | (b[i + 9] << 16) | (b[i + 10] << 8) |
           b[i + 11]) >>>
          0;
      break;
    }
  }
  if (!(n > 0)) return;
  const fs = liveEngine.fpsSamples;
  fs.push(n / span);
  if (span >= 6)
    liveEngine.fps = fpsSnap(n / span);
  else if (fs.length >= 3)
    liveEngine.fps = fpsSnap(fs.slice().sort((a, b2) => a - b2)[1]);
  else
    return;
  liveTechFromHls();
}
// Where the live playhead may go on the hls.js path: the buffered range around
// it, up to the live edge
function liveBufferRange() {
  const hls = liveEngine.hls;
  const t = videoPlayer.currentTime || 0;
  const b = videoPlayer.buffered;
  let start = t, end = t;
  for (let i = 0; i < b.length; i++)
    if (b.start(i) - 1 <= t && t <= b.end(i) + 1) {
      start = b.start(i);
      end = b.end(i);
      break;
    }
  if (b.length && start === t && end === t) {
    start = b.start(0);
    end = b.end(b.length - 1);
  }
  const live = hls && typeof hls.liveSyncPosition === 'number' &&
          hls.liveSyncPosition > 0 ?
      hls.liveSyncPosition :
      end;
  return {start, end: Math.max(end, live), live};
}
function liveBehindSecs() {
  if (!liveEngine.hls) return 0;
  const r = liveBufferRange();
  return Math.max(0, r.live - (videoPlayer.currentTime || 0));
}
function liveGoLive() {
  if (!liveEngine.hls) return;
  try {
    videoPlayer.currentTime = liveBufferRange().live;
  } catch (_) { /* not seekable yet */
  }
  videoPlayer.play().catch(() => {});
  if (livePlayer.active) showVodOsd();
}
// ----- Provider connection limit (Xtream) -----
// A second device on a one-connection account makes every channel fail with a
// plain network error. On a stream failure the auth call is repeated (cheap,
// never a stream) and active_cons / max_connections tell.
let _consInfo = null;  // { active, max, status, exp, at }
let _consCheckAt = 0;
async function xtreamCheckConnections() {
  if (!_xt || Date.now() - _consCheckAt < 15000) return _consInfo;
  _consCheckAt = Date.now();
  try {
    const r = await fetch(
        `${_xt.base}/player_api.php?username=${_xt.u}&password=${_xt.pw}`);
    if (!r.ok) return _consInfo;
    const j = await r.json();
    const ui = j && j.user_info;
    if (!ui) return _consInfo;
    const active = parseInt(ui.active_cons), max = parseInt(ui.max_connections);
    _consInfo = {
      active: isNaN(active) ? -1 : active,
      max: isNaN(max) ? -1 : max,
      status: String(ui.status || ''),
      exp: parseInt(ui.exp_date) > 0 ? parseInt(ui.exp_date) * 1000 : 0,
      at: Date.now()
    };
  } catch (_) { /* provider unreachable: nothing to say */
  }
  return _consInfo;
}
// Human explanation of a failing stream when the account, not the channel, is
// the cause; '' otherwise
function accountProblemText(ci) {
  if (!ci || Date.now() - ci.at > 60000) return '';
  if (/expired|disabled|banned/i.test(ci.status))
    return `Account ${ci.status.toLowerCase()}`;
  if (ci.max > 0 && ci.active >= ci.max)
    return ci.max === 1 ?
        'Another device is streaming with this account (1 connection allowed)' :
        `All ${ci.max} connections of this account are in use`;
  return '';
}
function noteStreamFailureForAccount(idx) {
  if (!_xt || currentPlaylistType !== 'xtream') return;
  xtreamCheckConnections().then(ci => {
    const t = accountProblemText(ci);
    if (!t || currentChannelIndex !== idx) return;
    statusArea.innerText = `⚠️ ${t}`;
    showEPGToast(
        `${t}. Stop playback on the other device, then press Reload.`, 'error',
        'Connection limit');
    hideEPGToast(8000);
    diagLog(`Account: ${t} (active ${ci.active} / max ${ci.max})`);
  });
}

// ----- AV sync through Homebrew root exec (rooted TVs only) -----
// The app cannot reach LG's AV Sync Adjustment itself (settingsservice is
// denied by the ACG); on a rooted TV the Homebrew Channel service runs commands
// as root, so the TV's own setting is driven through luna-send and put back
// when the app goes to the background or exits.
let _hbAvailable = null;  // null = not probed yet
function hbExec(command, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('timeout'));
      }
    }, timeoutMs);
    try {
      if (typeof webOS === 'undefined' || !webOS.service ||
          !webOS.service.request)
        throw new Error('no webOS service bridge');
      webOS.service.request('luna://org.webosbrew.hbchannel.service', {
        method: 'exec',
        parameters: {command},
        onSuccess: r => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(
              (r &&
               (r.stdoutString !== undefined ? r.stdoutString : r.stdout)) ||
              '');
        },
        onFailure: e => {
          if (done) return;
          done = true;
          clearTimeout(t);
          reject(new Error((e && e.errorText) || 'exec failed'));
        }
      });
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(t);
        reject(e);
      }
    }
  });
}
function hbProbe() {
  if (_hbAvailable !== null) return Promise.resolve(_hbAvailable);
  return hbExec('echo hb-ok', 3000)
      .then(out => {
        _hbAvailable = /hb-ok/.test(out);
        return _hbAvailable;
      })
      .catch(() => {
        _hbAvailable = false;
        return false;
      });
}
const AV_SYNC_OPTIONS = (() => {
  const o = [{v: -1, label: 'TV setting'}];
  for (let v = AV_SYNC_MIN; v <= AV_SYNC_MAX; v++)
    o.push({v, label: String(v)});
  return o;
})();
const AV_SYNC_KEYS = [
  'avSyncSpeaker', 'avSyncSpdif', 'avSyncBtSurround', 'avSyncWisa'
];  // one per sound output family, all 0-60
// Which settingsservice key the TV's AV Sync Adjustment uses for the current
// sound output
function avSyncKeyFor(soundOutput) {
  const o = String(soundOutput || '');
  if (/optical/.test(o) && !/arc/.test(o)) return 'avSyncSpdif';
  if (/^bt_|bluetooth|bt_surround|bt_tv_atmos/.test(o))
    return 'avSyncBtSurround';
  if (/wisa/.test(o)) return 'avSyncWisa';
  return 'avSyncSpeaker';  // TV speaker, HDMI ARC/eARC and the rest
}
let _avSyncOrig =
    null;  // { avSync, <key>: value } as found before the app changed anything
let _avSyncKey = 'avSyncSpeaker';
function lunaSettingsCmd(method, payload) {
  return `luna-send -n 1 luna://com.webos.settingsservice/${method} '${
      JSON.stringify(payload)}'`;
}
async function avSyncRead() {
  const out = await hbExec(lunaSettingsCmd('getSystemSettings', {
    category: 'sound',
    keys: ['avSync', 'soundOutput'].concat(AV_SYNC_KEYS)
  }));
  const j = JSON.parse(out);
  if (!j || !j.settings) throw new Error('no settings');
  return j.settings;
}
async function avSyncApply(v) {
  if (!_hbAvailable || !(v >= 0)) return false;
  if (_avSyncOrig === null) {
    try {
      const s = await avSyncRead();
      _avSyncKey = avSyncKeyFor(s.soundOutput);
      _avSyncOrig = {avSync: s.avSync, [_avSyncKey]: s[_avSyncKey]};
    } catch (e) {
      diagLog('AV sync: cannot read TV setting: ' + e.message);
      return false;
    }
  }
  try {
    await hbExec(lunaSettingsCmd('setSystemSettings', {
      category: 'sound',
      settings: {avSync: 'on', [_avSyncKey]: String(v)}
    }));
    return true;
  } catch (e) {
    diagLog('AV sync: cannot set TV setting: ' + e.message);
    return false;
  }
}
async function avSyncRestore() {
  if (!_avSyncOrig) return;
  const o = _avSyncOrig;
  _avSyncOrig = null;
  try {
    await hbExec(
        lunaSettingsCmd('setSystemSettings', {category: 'sound', settings: o}));
  } catch (e) {
    diagLog('AV sync: restore failed: ' + e.message);
  }
}
function avSyncOnVisibility() {
  if (!_hbAvailable || !(settings.avSync >= 0)) return;
  if (document.hidden)
    avSyncRestore();
  else
    avSyncApply(settings.avSync);
}
window.addEventListener('pagehide', () => {
  if (_avSyncOrig && _hbAvailable) avSyncRestore();
});

// Hidden (another app in front, Home, screensaver): stop fetching segments so
// nothing times out while the page is frozen; visible again: resume, or re-open
// the channel if the engine was torn down meanwhile.
document.addEventListener('visibilitychange', () => {
  avSyncOnVisibility();
  if (liveEngine.hls) {
    try {
      if (document.hidden)
        liveEngine.hls.stopLoad();
      else
        liveEngine.hls.startLoad(-1);
    } catch (_) { /* engine gone */
    }
    return;
  }
  if (!document.hidden && liveEngine.resumeUrl && vodMode === 'live' &&
      !vodPlay.active && currentChannelIndex >= 0 &&
      channels[currentChannelIndex].url === liveEngine.resumeUrl) {
    liveEngine.resumeUrl = '';
    reloadStream(false);
  }
});


let _holdKeyDir =
    null;  // 'left' | 'right' | null — tracks which key is physically held
let _holdKeyStart = 0;
const HOLD_THRESHOLD_MS = 500;

// Trick-play (hold-to-rewind / hold-to-FF)
const _REWIND_RAMP = [
  {after: 0, speed: -1},
  {after: 1500, speed: -2},
  {after: 4000, speed: -4},
  {after: 8000, speed: -8},
];
const _FF_RAMP = [
  {after: 0, speed: 2},
  {after: 1500, speed: 4},
  {after: 4000, speed: 8},
];
let _trickInterval = null;
let _trickHoldStart = 0;
let _trickHoldDir =
    null;  // 'left' | 'right' | null — null means not in trick play
// VOD scrubbing: while Left/Right is held the OSD position moves at these
// speeds (seconds of content per second) and the video seeks once on release.
// Seeking a large file on every tick stalls the decoder and the bar never
// moves.
const _VOD_SCRUB_RAMP = [
  {after: 0, speed: 10},
  {after: 1500, speed: 30},
  {after: 4000, speed: 60},
  {after: 8000, speed: 120},
];
let _scrubPos = null;  // virtual position during a VOD scrub, null otherwise

function _seekRange() {
  if (liveEngineActive() && !vodPlay.active) {
    const r = liveBufferRange();
    return {start: r.start, end: r.end};
  }
  if (videoPlayer.seekable && videoPlayer.seekable.length > 0)
    return {
      start: videoPlayer.seekable.start(0),
      end: videoPlayer.seekable.end(0)
    };
  return {start: 0, end: videoPlayer.duration || 0};
}

function _seekBy(seconds) {
  const range = _seekRange();
  videoPlayer.currentTime = Math.max(
      range.start, Math.min(range.end - 1, videoPlayer.currentTime + seconds));
  videoPlayer.play().catch(() => {});
}

function _getRampSpeed(ramp, heldMs) {
  let speed = ramp[0].speed;
  for (const step of ramp) {
    if (heldMs >= step.after) speed = step.speed;
  }
  return speed;
}

function _showTrickBadge(text) {
  const el = document.getElementById('pbTrickBadge');
  if (!el) return;
  el.textContent = text;
  el.style.display = '';
}

function _hideTrickBadge() {
  const el = document.getElementById('pbTrickBadge');
  if (el) el.style.display = 'none';
}

function _startHold(dir) {
  if (_trickHoldDir) return;
  // Live with no buffer on an archive channel: the rewind goes to the archive
  if (dir === 'left' && !liveEngineActive() && liveLeftIntoArchive(10)) return;
  _trickHoldDir = dir;
  _trickHoldStart = Date.now();
  videoPlayer.pause();
  // Native speed playback only once the pipeline is attached and has described
  // the file
  if (vodPlay.active && vodPlay.ums && vodPlay.ums.mediaId &&
      vodPlay.ums.video && !_umsRateBroken) {
    startNativeRate(dir);
    return;
  }
  if (vodPlay.active) {
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
          0,
          Math.min(max, _scrubPos + (dir === 'left' ? -1 : 1) * speed * 0.1));
      _showTrickBadge((dir === 'left' ? '◀◀ ' : '▶▶ ') + speed + '×');
      updateVodOsd(_scrubPos);
      if ((dir === 'right' && dur && _scrubPos >= max) ||
          (dir === 'left' && _scrubPos <= 0))
        _stopHold();
    }, 100);
    return;
  }
  const ramp = dir === 'left' ? _REWIND_RAMP : _FF_RAMP;
  _trickInterval = setInterval(() => {
    const heldMs = Date.now() - _trickHoldStart;
    const speed = _getRampSpeed(ramp, heldMs);
    const range = _seekRange();
    if (dir === 'left') {
      // At the start of the hls.js buffer, the rewind continues in the archive
      if (liveEngineActive() && !catchup &&
          videoPlayer.currentTime <= range.start + 0.5) {
        const target = liveWallTimeAt(range.start);
        _stopHold();
        rewindIntoArchive(target);
        return;
      }
      videoPlayer.currentTime =
          Math.max(range.start, videoPlayer.currentTime + speed * 0.1);
      _showTrickBadge('◀◀ ' + Math.abs(speed) + '×');
    } else {
      videoPlayer.currentTime =
          Math.min(range.end - 1, videoPlayer.currentTime + speed * 0.1);
      _showTrickBadge('▶▶ ' + speed + '×');
      if (videoPlayer.currentTime >= range.end - 1) _stopHold();
    }
  }, 100);
}

function _stopHold() {
  if (_trickInterval) {
    clearInterval(_trickInterval);
    _trickInterval = null;
  }
  videoPlayer.playbackRate = 1;
  _trickHoldDir = null;
  _trickHoldStart = 0;
  _hideTrickBadge();
  if (_nativeRate !== 0) {
    // VOD native speed playback: back to 1× with audio
    _nativeRate = 0;
    if (vodPlay.ums)
      umsCall(
          'setPlayRate',
          {mediaId: vodPlay.ums.mediaId, playRate: 1, audioOutput: true});
    videoPlayer.play().catch(() => {});
    if (vodPlay.active) showVodOsd();
    return;
  }
  if (_scrubPos !== null) {
    // VOD: one seek to the scrubbed position, then resume
    const target = _scrubPos;
    _scrubPos = null;
    try {
      videoPlayer.currentTime = target;
    } catch (_) { /* not seekable yet */
    }
    videoPlayer.play().catch(() => {});
    if (vodPlay.active) showVodOsd();
    return;
  }
  videoPlayer.play().catch(() => {});
}

function _isHolding() {
  return _trickHoldDir !== null;
}

const LANG_NAMES = {
  // Western Europe
  en: 'English',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  es: 'Spanish',
  pt: 'Portuguese',
  nl: 'Dutch',
  sv: 'Swedish',
  da: 'Danish',
  fi: 'Finnish',
  nb: 'Norwegian',
  no: 'Norwegian',
  is: 'Icelandic',
  lb: 'Luxembourgish',
  ca: 'Catalan',
  gl: 'Galician',
  eu: 'Basque',
  mt: 'Maltese',
  cy: 'Welsh',
  ga: 'Irish',
  af: 'Afrikaans',
  // Eastern Europe
  ru: 'Russian',
  pl: 'Polish',
  cs: 'Czech',
  sk: 'Slovak',
  hu: 'Hungarian',
  ro: 'Romanian',
  uk: 'Ukrainian',
  bg: 'Bulgarian',
  hr: 'Croatian',
  sr: 'Serbian',
  sl: 'Slovenian',
  bs: 'Bosnian',
  mk: 'Macedonian',
  sq: 'Albanian',
  el: 'Greek',
  // Baltic
  lt: 'Lithuanian',
  lv: 'Latvian',
  et: 'Estonian',
  // Middle East / Central Asia
  ar: 'Arabic',
  he: 'Hebrew',
  fa: 'Persian',
  ur: 'Urdu',
  tr: 'Turkish',
  az: 'Azerbaijani',
  ka: 'Georgian',
  hy: 'Armenian',
  kk: 'Kazakh',
  uz: 'Uzbek',
  // South Asia
  hi: 'Hindi',
  bn: 'Bengali',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  mr: 'Marathi',
  gu: 'Gujarati',
  pa: 'Punjabi',
  si: 'Sinhala',
  ne: 'Nepali',
  // East / Southeast Asia
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  vi: 'Vietnamese',
  th: 'Thai',
  id: 'Indonesian',
  ms: 'Malay',
  tl: 'Filipino',
  my: 'Burmese',
  km: 'Khmer',
  // Africa
  sw: 'Swahili',
  am: 'Amharic',
  yo: 'Yoruba',
  ig: 'Igbo',
  ha: 'Hausa',
  so: 'Somali',
  // Americas
  ht: 'Haitian Creole',
  qu: 'Quechua',
  // Mongolian / misc
  mn: 'Mongolian'
};
