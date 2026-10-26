/**
 * @fileoverview Live engine (native video, or hls.js or Shaka Player with a
 * rewind buffer), the provider connection limit, and AV sync on rooted TVs.
 */

// ----- Live engine: native <video>, hls.js, or Shaka Player -----
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
// The setting "Live engine" (settings.liveEngine) selects hls.js or Shaka
// Player for the MSE path. Shaka Player has its own MPEG-TS transmuxer, which
// also reads E-AC-3 audio. Both engines share the state in `liveEngine`, the
// relay workarounds, and the hand-over to the native pipeline.
const liveEngine = {
  hls: null,
  shaka: null,
  url: '',
  tech: '',
  recovered: false,
  resumeUrl: '',
  fps: 0,
  fpsSamples: [],
  relayWaits: 0,
  placeholder: false,
  // Shaka Player: the measured bitrate and the buffer that fits in memory
  bitrate: 0,
  reach: 0,
  appendBytes: 0,
  appendSpan: 0,
  segments: 0,
  pendingSamples: 0,
  videoTrackId: 0,
  lastReply: '',
  manifestFails: 0
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
  return !!(liveEngine.hls || liveEngine.shaka);
}
/**
 * Gives the name of the engine that plays the live channel.
 * @return {string} 'hls.js', 'Shaka Player', or 'native'.
 */
function liveEngineName() {
  return liveEngine.shaka ? 'Shaka Player' :
      liveEngine.hls      ? 'hls.js' :
                            'native';
}
function shakaAvailable() {
  return settings.liveBuffer > 0 && typeof shaka !== 'undefined' &&
      shaka.Player.isBrowserSupported();
}
/**
 * Gives the MSE engine that the settings select for an HLS channel.
 * @return {string} 'shaka', 'hls', or '' when the native pipeline plays.
 */
function liveMseEngine() {
  if (settings.liveEngine === 'shaka' && shakaAvailable()) return 'shaka';
  return hlsAvailable() ? 'hls' : '';
}
// The native pipeline plays HLS with the GStreamer element hlsdemux2. On
// one 4K channel (EC-3 audio, which hls.js cannot play, 2026-10-25),
// hlsdemux2 downloaded 2 segments again and again for 40 s, and the picture
// stopped. The provider also sends each Xtream live channel as 1 continuous
// MPEG-TS stream (.ts), which started in 1.3 s. Thus, a channel that hls.js
// cannot play gets the .ts URL on the native pipeline.
const XTREAM_LIVE_HLS = /(\/live\/[^/?#]+\/[^/?#]+\/\d+)\.m3u8$/;
/**
 * Gives the URL that the native pipeline plays for a live channel.
 * @param {string} url The URL of the channel.
 * @return {string} The .ts URL for an Xtream channel in `_hlsBroken`, else
 *     the URL of the channel.
 */
function nativeLiveUrl(url) {
  return _hlsBroken.has(url) ? url.replace(XTREAM_LIVE_HLS, '$1.ts') : url;
}
// The provider starts a relay when the first viewer connects. The first
// playlist of a cold relay has 1 segment and #EXT-X-ENDLIST (seen on
// some event (PPV) channels, 2026-10-20). hls.js then plays the stream as a
// finished VOD: approximately 11 s, then the state ENDED. Later playlists of
// the same stream are usual live playlists. A live channel does not end, thus
// this playlist loader removes the tag.
//
// When the relay cannot send the stream, the provider answers the playlist
// request with the text "Cannot read /home/nxt/storage/streams/<id>_.m3u8"
// (seen on channels 13980 to 13983, 2026-10-25). This occurs before the relay
// is ready, and also between 2 good playlists. hls.js cannot parse the text,
// and a new start plays the first segment again. Thus, the loader does not give
// the text to hls.js:
// - For the first playlist of a URL, the loader requests the playlist again
//   each HLS_RELAY_WAIT_MS, for a maximum of HLS_RELAY_WAIT_MAX_MS.
// - For a reload, the loader gives the last good playlist. hls.js sees an
//   unchanged playlist and reloads it later.
const HLS_RELAY_NOT_READY = /^\s*Cannot read \S*\.m3u8/;
const HLS_RELAY_WAIT_MS = 3000;
const HLS_RELAY_WAIT_MAX_MS = 60 * 1000;
const _hlsLastPlaylist = new Map();  // playlist URL -> last good text
let _livePlaylistLoader = null;
function livePlaylistLoader() {
  if (_livePlaylistLoader) return _livePlaylistLoader;
  _livePlaylistLoader = class extends Hls.DefaultConfig.loader {
    load(context, config, callbacks) {
      const onSuccess = callbacks.onSuccess;
      const from = this._relayWaitFrom || Date.now();
      super.load(context, config, Object.assign({}, callbacks, {
        onSuccess: (response, stats, ctx, networkDetails) => {
          const text = response.data;
          if (typeof text === 'string' && HLS_RELAY_NOT_READY.test(text)) {
            const last = _hlsLastPlaylist.get(context.url);
            if (last) {
              response.data = last;
            } else if (Date.now() - from < HLS_RELAY_WAIT_MAX_MS) {
              if (!this._relayWaitFrom) {
                liveEngine.relayWaits++;
                diagLog('hls.js waits for the relay of the provider');
              }
              this._relayWaitFrom = from;
              this._relayTimer = setTimeout(() => {
                this._relayTimer = null;
                // A loader accepts only 1 load: start with new statistics
                this.stats = new this.stats.constructor();
                this.load(context, config, callbacks);
              }, HLS_RELAY_WAIT_MS);
              return;
            }
          } else if (typeof text === 'string') {
            response.data = text.replace(/^#EXT-X-ENDLIST[ \t]*\r?$/gm, '');
            if (/^\s*#EXTM3U/.test(text)) {
              _hlsLastPlaylist.set(context.url, response.data);
              // Not for an audio or a subtitle playlist
              if (context.type === 'manifest' || context.type === 'level') {
                notePlaceholderPlaylist(text);
              }
            }
          }
          this._relayWaitFrom = 0;
          onSuccess(response, stats, ctx, networkDetails);
        }
      }));
    }
    abort() {
      clearTimeout(this._relayTimer);
      this._relayTimer = null;
      super.abort();
    }
    destroy() {
      clearTimeout(this._relayTimer);
      this._relayTimer = null;
      super.destroy();
    }
  };
  return _livePlaylistLoader;
}
// For an event that is finished or did not start, the provider sends a 15 s
// black placeholder (".../video/black.ts") with #EXT-X-ENDLIST (seen on the
// "ENDED" event (PPV) channels, 2026-10-25). The app then tells why
// the picture is black.
const HLS_PLACEHOLDER_SEGMENT = /(^|\/)black\.ts(\?|#|$)/;
/**
 * Tells the user when a live playlist has only placeholder segments.
 * @param {string} text The playlist text.
 */
function notePlaceholderPlaylist(text) {
  const segs = text.split(/\r?\n/).filter(l => l && l[0] !== '#');
  const placeholder =
      segs.length > 0 && segs.every(l => HLS_PLACEHOLDER_SEGMENT.test(l));
  if (placeholder === liveEngine.placeholder) return;
  liveEngine.placeholder = placeholder;
  if (!placeholder) return;
  const t = 'The event of this channel is not on the air';
  statusArea.innerText = `⚠️ ${t}`;
  showEPGToast(
      `${t}. The provider sends a black picture until the event starts.`,
      'error', 'No broadcast');
  hideEPGToast(8000);
  diagLog('The provider sends a placeholder (black.ts) for this channel');
}
// ── Shaka Player: playlist filter
// A response filter does the work of livePlaylistLoader() for Shaka Player:
// it removes #EXT-X-ENDLIST and #EXT-X-PLAYLIST-TYPE (a live channel does not
// end), waits for a cold relay, gives the last good playlist on a reload, and
// finds a relay restart. Shaka Player gives no error for a relay restart, thus
// the filter compares the MEDIA-SEQUENCE and the first segment with the
// previous playlist of the same URL.
const _shakaSeq = new Map();  // playlist URL -> {seq, first}
const _shakaRaw = new Map();  // playlist URL -> requests of the filter itself
/**
 * Tells if a media playlist starts again (a relay restart).
 * @param {string} uri The playlist URL.
 * @param {string} text The playlist text.
 * @return {boolean} True when the sequence went back, or the same sequence
 *     has a different first segment.
 */
function playlistRestarted(uri, text) {
  const m = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(text);
  const first = text.split(/\r?\n/).find(l => l && l[0] !== '#') || '';
  if (!m || !first) return false;
  const seq = +m[1], prev = _shakaSeq.get(uri);
  _shakaSeq.set(uri, {seq, first});
  return !!prev &&
      (seq < prev.seq || (seq === prev.seq && first !== prev.first));
}
/**
 * Makes the playlist response filter of a Shaka Player.
 * @param {string} url The URL of the channel.
 * @param {!Object} player The Shaka Player.
 * @return {function(number, !Object): (Promise|undefined)} The filter.
 */
function shakaResponseFilter(url, player) {
  const RT = shaka.net.NetworkingEngine.RequestType;
  const SU = shaka.util.StringUtils;
  return async (type, response) => {
    if (type !== RT.MANIFEST || liveEngine.shaka !== player) return;
    const uri = response.uri || url;
    const raw = _shakaRaw.get(uri) || 0;
    if (raw > 0) {  // a request of this filter: no second filter pass
      _shakaRaw.set(uri, raw - 1);
      return;
    }
    let text = SU.fromUTF8(response.data);
    if (HLS_RELAY_NOT_READY.test(text)) {
      const last = _hlsLastPlaylist.get(uri);
      if (last) {
        response.data = SU.toUTF8(last);
        return;
      }
      liveEngine.relayWaits++;
      diagLog('Shaka Player waits for the relay of the provider');
      const from = Date.now();
      while (Date.now() - from < HLS_RELAY_WAIT_MAX_MS) {
        await new Promise(r => setTimeout(r, HLS_RELAY_WAIT_MS));
        if (liveEngine.shaka !== player) return;
        const req = shaka.net.NetworkingEngine.makeRequest(
            [uri], player.getConfiguration().manifest.retryParameters);
        _shakaRaw.set(uri, (_shakaRaw.get(uri) || 0) + 1);
        try {
          const r =
              await player.getNetworkingEngine().request(type, req).promise;
          text = SU.fromUTF8(r.data);
          if (!HLS_RELAY_NOT_READY.test(text)) {
            response.data = r.data;
            break;
          }
        } catch (_) { /* the next try */
        }
      }
      if (liveEngine.shaka !== player || HLS_RELAY_NOT_READY.test(text))
        return;  // Shaka Player reports the text as a bad playlist
    }
    if (!/^\s*#EXTM3U/.test(text)) {
      liveEngine.lastReply = text.replace(/\s+/g, ' ').trim().slice(0, 160);
      return;
    }
    const media = /^#EXTINF/m.test(text);
    if (media && playlistRestarted(uri, text) && hlsRelayRestart(url)) return;
    const clean =
        text.replace(/^#EXT-X-(ENDLIST|PLAYLIST-TYPE:[A-Z]*)[ \t]*\r?$/gm, '');
    response.data = SU.toUTF8(clean);
    _hlsLastPlaylist.set(uri, clean);
    liveEngine.manifestFails = 0;
    if (media) notePlaceholderPlaylist(text);
  };
}
// A cold relay can also restart. Its next playlist then starts again at
// MEDIA-SEQUENCE 0 with a different segment (seen on one
// event (PPV) channel, 2026-10-25). hls.js cannot merge it ("media sequence
// mismatch") and stops with a fatal level parsing error. A new hls.js on the
// same URL reads the new playlist. HLS_RELAY_RESTARTS limits the restarts of 1
// URL in HLS_RELAY_WINDOW_MS. Then the usual hand-over to the native player
// occurs.
const HLS_RELAY_RESTARTS = 5;
const HLS_RELAY_WINDOW_MS = 120 * 1000;
const _hlsRelayRestart = {
  url: '',
  n: 0,
  at: 0
};
/**
 * Starts hls.js again on the playing live channel after its relay restarted.
 * @param {string} url The URL of the channel.
 * @return {boolean} True when hls.js started again.
 */
function hlsRelayRestart(url) {
  if (!(vodMode === 'live' && !vodPlay.active && currentChannelIndex >= 0 &&
        channels[currentChannelIndex].url === url)) {
    return false;
  }
  const r = _hlsRelayRestart, now = Date.now();
  if (r.url !== url || now - r.at > HLS_RELAY_WINDOW_MS) {
    r.url = url;
    r.n = 0;
    r.at = now;
  }
  if (r.n >= HLS_RELAY_RESTARTS) return false;
  r.n++;
  diagLog(`${liveEngineName()} restarted after a relay restart (${r.n}/${
      HLS_RELAY_RESTARTS})`);
  loadLiveSource(url);
  videoPlayer.play().catch(() => {});
  return true;
}
// Shaka Player destroys itself asynchronously, and at the end it removes the
// src attribute of the <video>. Thus, the next source waits for the destroy.
let _shakaTeardown = null;
function liveEngineDestroy() {
  if (liveEngine.hls) {
    try {
      liveEngine.hls.destroy();
    } catch (_) { /* already gone */
    }
    liveEngine.hls = null;
  }
  if (liveEngine.shaka) {
    const p = liveEngine.shaka;
    liveEngine.shaka = null;
    const t =
        Promise.resolve().then(() => p.destroy()).catch(() => {}).then(() => {
          if (_shakaTeardown === t) _shakaTeardown = null;
        });
    _shakaTeardown = t;
  }
  liveEngine.url = '';
  liveEngine.tech = '';
}
/**
 * Runs a function when no Shaka Player destroy is pending.
 * @param {function()} fn The function.
 */
function afterLiveTeardown(fn) {
  if (_shakaTeardown)
    _shakaTeardown.then(fn);
  else
    fn();
}
/**
 * Points the live <video> at a URL on the native pipeline.
 * @param {string} url The URL.
 */
function setNativeSrc(url) {
  afterLiveTeardown(() => {
    if (liveEngineActive()) return;  // an engine took the element meanwhile
    videoPlayer.src = url;
    videoPlayer.load();
  });
}
/**
 * Gives the playing channel to the native pipeline after a fatal engine
 * error. Its own error handler and reload budget take over from here.
 * @param {string} url The URL of the channel.
 */
function liveHandToNative(url) {
  if (vodMode === 'live' && !vodPlay.active && currentChannelIndex >= 0 &&
      channels[currentChannelIndex].url === url) {
    umsNoteCurrentId();
    setNativeSrc(nativeLiveUrl(url));
    liveUmsRefresh();
    videoPlayer.play().catch(() => {});
  }
}
// Point the live <video> at a channel URL through whichever engine fits.
// Returns true when an MSE engine took it. A cause (for example 'watchdog')
// goes to the diagnostics log, so that each unusual start tells why it
// occurred.
function loadLiveSource(url, cause = '') {
  _lastStreamOpenAt = Date.now();
  if (cause) {
    const ch = channels[currentChannelIndex];
    diagLog(`Live start (${cause}): ${ch ? ch.name.slice(0, 60) : url}`);
  }
  liveEngineDestroy();
  const engine = isHlsUrl(url) && !_hlsBroken.has(url) ? liveMseEngine() : '';
  if (!engine) {
    setNativeSrc(nativeLiveUrl(url));
    return false;
  }
  liveEngine.url = url;
  liveEngine.tech = '';
  liveEngine.recovered = false;
  liveEngine.resumeUrl = '';
  liveEngine.fps = 0;
  liveEngine.fpsSamples = [];
  liveEngine.relayWaits = 0;
  liveEngine.placeholder = false;
  liveEngine.bitrate = 0;
  liveEngine.reach = settings.liveBuffer;
  liveEngine.appendBytes = 0;
  liveEngine.appendSpan = 0;
  liveEngine.segments = 0;
  liveEngine.pendingSamples = 0;
  liveEngine.videoTrackId = 0;
  liveEngine.lastReply = '';
  liveEngine.manifestFails = 0;
  _hlsLastPlaylist.clear();  // a new start must not get an old playlist
  _shakaSeq.clear();
  liveEngine.subManual = false;
  liveEngine.audioManual = false;
  videoPlayer.removeAttribute('src');  // the engine attaches its MediaSource
  if (engine === 'shaka') {
    loadShakaSource(url);
    return true;
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
    // The provider can keep a playlist request open for approximately 10 s
    playlistLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 20000,
        maxLoadTimeMs: 30000,
        timeoutRetry: {maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0},
        errorRetry: {maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 8000}
      }
    },
  });
  liveEngine.hls = hls;
  hls.on(Hls.Events.ERROR, (_, data) => onHlsError(url, data));
  hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, applyHlsTrackPrefs);
  hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, applyHlsTrackPrefs);
  hls.on(Hls.Events.MANIFEST_PARSED, liveTechFromHls);
  hls.on(Hls.Events.LEVEL_SWITCHED, liveTechFromHls);
  hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, liveTechFromHls);
  hls.on(Hls.Events.BUFFER_APPENDING, (_, d) => hlsFpsFromAppend(hls, d));
  afterLiveTeardown(() => {
    if (liveEngine.hls !== hls) return;
    hls.loadSource(url);
    hls.attachMedia(videoPlayer);
  });
  return true;
}
// ── Shaka Player
// The retry parameters of Shaka Player, in the same spirit as the hls.js
// policies: the provider can keep a playlist request open for approximately
// 10 s.
const SHAKA_RETRY = {
  timeout: 30000,
  stallTimeout: 20000,
  connectionTimeout: 20000,
  maxAttempts: 3,
  baseDelay: 1000,
  backoffFactor: 2,
  fuzzFactor: 0.5
};
/**
 * Gives the configuration of a Shaka Player for a live channel.
 * @param {number} secs The buffer ahead of and behind the playhead, in
 *     seconds.
 * @return {!Object} The configuration.
 */
function shakaConfig(secs) {
  return {
    streaming: {
      bufferingGoal: secs,  // fetch this far ahead, so a pause can be resumed
                            // from the buffer
      bufferBehind: secs,   // keep this much behind the playhead for rewind
      rebufferingGoal: 2,
      retryParameters: Object.assign({}, SHAKA_RETRY, {maxAttempts: 4}),
      lowLatencyMode: false,
      segmentPrefetchLimit: 0
    },
    manifest: {
      retryParameters: SHAKA_RETRY,
      // The seek range of a live stream is the playlist window. The buffer
      // behind the playhead must stay seekable, and the playhead must not go
      // back to the live edge by itself.
      availabilityWindowOverride: secs * 2,
      hls: {liveSegmentsDelay: 3}
    }
  };
}
let _shakaPolyfilled = false;
/**
 * Starts a Shaka Player on a live channel. `loadLiveSource` has reset the
 * state of `liveEngine` before the call.
 * @param {string} url The URL of the channel.
 */
function loadShakaSource(url) {
  if (!_shakaPolyfilled) {
    _shakaPolyfilled = true;
    try {
      shaka.polyfill.installAll();
    } catch (_) { /* the polyfills are optional */
    }
  }
  const player = new shaka.Player();
  liveEngine.shaka = player;
  player.configure(shakaConfig(settings.liveBuffer * 60));
  player.addEventListener('error', e => {
    if (liveEngine.shaka === player) onShakaError(url, e.detail);
  });
  player.addEventListener('trackschanged', applyShakaTrackPrefs);
  player.addEventListener('audiotrackschanged', applyShakaTrackPrefs);
  player.addEventListener('loaded', liveTechFromShaka);
  player.addEventListener('variantchanged', liveTechFromShaka);
  player.addEventListener('adaptation', liveTechFromShaka);
  player.addEventListener('bufferappending', e => shakaOnAppend(player, e));
  player.addEventListener('segmentappended', e => shakaOnSegment(player, e));
  afterLiveTeardown(() => {
    if (liveEngine.shaka !== player) return;
    player.attach(videoPlayer)
        .then(() => {
          if (liveEngine.shaka !== player) return;
          player.getNetworkingEngine().registerResponseFilter(
              shakaResponseFilter(url, player));
          return player.load(url);
        })
        .catch(e => {
          if (liveEngine.shaka === player) onShakaError(url, e);
        });
  });
}
/**
 * Gives the name of a Shaka Player error code.
 * @param {number} code The code.
 * @return {string} The name, or the number as text.
 */
function shakaCodeName(code) {
  const C = shaka.util.Error.Code;
  for (const k in C)
    if (C[k] === code) return k;
  return String(code);
}
// A fatal Shaka Player error. The error categories follow the hls.js types:
// a network error or a reply that is not a playlist is not held against the
// channel. Content that Shaka Player cannot play (codecs, a bad playlist, a
// media error) puts the channel in `_hlsBroken`, and the native pipeline takes
// it. Shaka Player does its own media source recovery
// (streaming.allowMediaSourceRecoveries) before a fatal error.
function onShakaError(url, err) {
  if (!err || liveEngine.url !== url || !liveEngine.shaka) return;
  const E = shaka.util.Error;
  const isShaka = err instanceof E;
  if (isShaka && err.severity !== E.Severity.CRITICAL) {
    if (err.category === E.Category.NETWORK && Array.isArray(err.data) &&
        err.data[4] === shaka.net.NetworkingEngine.RequestType.MANIFEST)
      shakaManifestFailed(url, err);
    return;
  }
  // The app changed the source during a load (LOAD_INTERRUPTED,
  // OPERATION_ABORTED)
  if (isShaka && err.category === E.Category.PLAYER) return;
  const code = isShaka ? err.code : 0, cat = isShaka ? err.category : 0;
  const name = isShaka ? shakaCodeName(code) : (err.message || String(err));
  const data = Array.isArray(err.data) ? err.data : [];
  const badStatus = isShaka && code === E.Code.BAD_HTTP_STATUS;
  const status = badStatus ? +data[1] || 0 : 0;
  // A refused stream (one-connection account in use, expired, rate limited)
  // is an HTML or text page, which Shaka Player reports as a playlist with no
  // header
  const notPlaylist = isShaka && code === E.Code.HLS_PLAYLIST_HEADER_MISSING;
  const reply = notPlaylist ?
      (liveEngine.lastReply || '(empty)') :
      badStatus ?
      String(data[2] || '').replace(/\s+/g, ' ').trim().slice(0, 160) :
      '';
  console.log('Shaka Player fatal error', cat, name);
  diagLog(`Shaka Player fatal ${cat}/${name}${status ? ` HTTP ${status}` : ''}${
      reply ? ` reply: ${reply}` : ''}${
      notPlaylist ? ' → not a playlist, treated as a network failure' :
                    ''}${document.hidden ? ' (app hidden)' : ''}`);
  noteStreamFail(
      'Shaka Player', `${cat}/${name}${status ? ` · HTTP ${status}` : ''}`,
      reply);
  if (document.hidden) {
    liveEngine.resumeUrl = url;
    liveEngineDestroy();
    return;
  }
  const incompatible = isShaka &&
      ((cat === E.Category.MEDIA && code !== E.Code.QUOTA_EXCEEDED_ERROR) ||
       (cat === E.Category.MANIFEST && !notPlaylist));
  if (incompatible) _hlsBroken.add(url);
  liveEngineDestroy();
  liveHandToNative(url);
}
// Seen on the C4 (2026-10-26, one 4K channel): the relay of the provider
// restarted, and the redirect URL of the first playlist then answered HTTP 509
// on each refresh. Shaka Player reports each failed refresh cycle as a
// recoverable error and tries again without end, while the playhead waits at
// the end of the buffer. hls.js stops with a fatal level load error in the
// same case. After SHAKA_MANIFEST_FAILS cycles, the engine starts again on the
// channel URL, which gives a new redirect. The restart limit of
// hlsRelayRestart applies, then the native pipeline gets the channel.
const SHAKA_MANIFEST_FAILS = 2;
/**
 * Counts a failed playlist refresh of Shaka Player (a recoverable error).
 * @param {string} url The URL of the channel.
 * @param {!shaka.util.Error} err The error.
 */
function shakaManifestFailed(url, err) {
  if (++liveEngine.manifestFails < SHAKA_MANIFEST_FAILS) return;
  liveEngine.manifestFails = 0;
  const status = +err.data[1] || 0;
  const what = `${shakaCodeName(err.code)}${status ? ` HTTP ${status}` : ''}`;
  diagLog(`Shaka Player: the playlist refresh failed (${what})`);
  if (hlsRelayRestart(url)) return;
  noteStreamFail('Shaka Player', `playlist refresh: ${what}`, '');
  liveEngineDestroy();
  liveHandToNative(url);
}
/**
 * Reads the boxes of an ISO BMFF (MP4) byte range.
 * @param {!Uint8Array} b The data.
 * @param {number} start The first byte of the range.
 * @param {number} end The byte after the range.
 * @return {!Array<{type: string, start: number, end: number}>} The boxes,
 *     with `start` at the box header.
 */
function mp4Boxes(b, start, end) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size =
        ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    let hdr = 8;
    if (size === 1) {  // largesize: the high 32 bits are 0 for a segment
      size = ((b[i + 12] << 24) | (b[i + 13] << 16) | (b[i + 14] << 8) |
              b[i + 15]) >>>
          0;
      hdr = 16;
    } else if (size === 0)
      size = end - i;
    if (size < hdr) break;
    out.push({type, start: i, end: Math.min(end, i + size), hdr});
    i += size;
  }
  return out;
}
function mp4U32(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}
/**
 * Gives the track ID of the video track of an fMP4 init segment.
 * @param {!Uint8Array} b The init segment.
 * @return {number} The track ID, or 0.
 */
function mp4VideoTrackId(b) {
  for (const moov of mp4Boxes(b, 0, b.length)) {
    if (moov.type !== 'moov') continue;
    for (const trak of mp4Boxes(b, moov.start + moov.hdr, moov.end)) {
      if (trak.type !== 'trak') continue;
      let id = 0, video = false;
      for (const x of mp4Boxes(b, trak.start + trak.hdr, trak.end)) {
        if (x.type === 'tkhd')
          id =
              mp4U32(b, x.start + x.hdr + (b[x.start + x.hdr] === 1 ? 20 : 12));
        else if (x.type === 'mdia')
          for (const y of mp4Boxes(b, x.start + x.hdr, x.end))
            if (y.type === 'hdlr')
              video =
                  String.fromCharCode(...b.subarray(
                      y.start + y.hdr + 8, y.start + y.hdr + 12)) === 'vide';
      }
      if (video && id) return id;
    }
  }
  return 0;
}
/**
 * Gives the number of samples of a track in an fMP4 media segment (the
 * `trun` of its `traf`).
 * @param {!Uint8Array} b The segment.
 * @param {number} trackId The track ID, or 0 for the first track.
 * @return {number} The sample count, or 0.
 */
function mp4SampleCount(b, trackId) {
  for (const moof of mp4Boxes(b, 0, Math.min(b.length, 65536))) {
    if (moof.type !== 'moof') continue;
    for (const traf of mp4Boxes(b, moof.start + moof.hdr, moof.end)) {
      if (traf.type !== 'traf') continue;
      let id = 0, n = 0;
      for (const x of mp4Boxes(b, traf.start + traf.hdr, traf.end)) {
        if (x.type === 'tfhd')
          id = mp4U32(b, x.start + x.hdr + 4);
        else if (x.type === 'trun')
          n = mp4U32(b, x.start + x.hdr + 4);
      }
      if (n && (!trackId || id === trackId)) return n;
    }
  }
  return 0;
}
/**
 * Notes a frame rate sample (video samples over the segment span).
 * @param {number} n The number of video samples.
 * @param {number} span The span of the segment, in seconds.
 * @param {function()} show Shows the codec line when the rate is known.
 */
function noteFpsSample(n, span, show) {
  if (!(n > 0 && span > 1) || liveEngine.fps) return;
  const fs = liveEngine.fpsSamples;
  fs.push(n / span);
  if (span >= 6)
    liveEngine.fps = fpsSnap(n / span);
  else if (fs.length >= 3)
    liveEngine.fps = fpsSnap(fs.slice().sort((a, b2) => a - b2)[1]);
  else
    return;
  show();
}
// Shaka Player appends the transmuxed fMP4 of each segment: `bufferappending`
// carries the data (video and audio can be in 1 moof), and `segmentappended`
// then carries the time span. The sample count and the span give the frame
// rate, the bytes and the span give the bitrate.
function shakaOnAppend(player, e) {
  if (liveEngine.shaka !== player || !e || !e.data) return;
  const b = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
  if (e.contentType !== 'video') {
    if (!e.isInitData) liveEngine.appendBytes += b.length;
    return;
  }
  if (e.isInitData) {
    liveEngine.videoTrackId = mp4VideoTrackId(b) || liveEngine.videoTrackId;
    return;
  }
  liveEngine.appendBytes += b.length;
  if (!liveEngine.fps)
    liveEngine.pendingSamples = mp4SampleCount(b, liveEngine.videoTrackId);
}
function shakaOnSegment(player, e) {
  if (liveEngine.shaka !== player || !e || e.contentType !== 'video') return;
  const span = e.end - e.start;
  if (!(span > 0)) return;
  if (liveEngine.pendingSamples) {
    noteFpsSample(liveEngine.pendingSamples, span, liveTechFromShaka);
    liveEngine.pendingSamples = 0;
  }
  liveEngine.appendSpan += span;
  liveEngine.segments++;
  if (liveEngine.appendSpan >= 6 || liveEngine.segments >= 3) {
    const was = liveEngine.bitrate;
    liveEngine.bitrate =
        Math.round(liveEngine.appendBytes * 8 / liveEngine.appendSpan);
    shakaFitBuffer(player);
    // The codec line shows the first measurement, then a change of 20 %
    if (!was || Math.abs(liveEngine.bitrate - was) > was * 0.2)
      liveTechFromShaka();
  }
}
// The TV's SourceBuffer refuses appends at ~86 MB (see HLS_BUFFER_BYTES). The
// buffer ahead and the buffer behind the playhead share that budget, thus
// each gets half of the seconds that fit at the measured bitrate.
function shakaFitBuffer(player) {
  const secs = settings.liveBuffer * 60;
  const fit = liveEngine.bitrate > 0 ?
      Math.max(10, Math.floor(HLS_BUFFER_BYTES * 8 / liveEngine.bitrate / 2)) :
      secs;
  const goal = Math.min(secs, fit);
  const reach = Math.max(1, Math.floor(goal / 60));
  const cur = player.getConfiguration().streaming.bufferingGoal;
  if (Math.abs(cur - goal) > cur * 0.1) player.configure(shakaConfig(goal));
  liveEngine.reach = reach;
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
  const cause = data.reason || (data.error && data.error.message) || '';
  const why = !isParse && cause ?
      ` (${String(cause).replace(/\s+/g, ' ').slice(0, 120)})` :
      '';
  diagLog(
      `hls.js fatal ${data.type}/${data.details}${
          status ? ` HTTP ${status}` : ''}${reply ? ` reply: ${reply}` : ''}` +
      `${why}${
          notPlaylist ? ' → not a playlist, treated as a network failure' :
                        ''}${document.hidden ? ' (app hidden)' : ''}`);
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
  if (data.details === Hls.ErrorDetails.LEVEL_PARSING_ERROR &&
      hlsRelayRestart(url)) {
    return;
  }
  // A media error gets one in-place recovery (hls.js re-creates its
  // SourceBuffers) before we give up on it. A codec that hls.js cannot demux
  // ("Unsupported EC-3 in M2TS found") gets no recovery: the same segments
  // fail again, and the provider refused the next playlist with HTTP 509.
  const unsupported = /\bunsupported\b/i.test(cause);
  if (hls && data.type === Hls.ErrorTypes.MEDIA_ERROR && !unsupported &&
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
  liveHandToNative(url);
}
// Codec / resolution / bitrate line from the HLS level (the media service does
// not describe MSE playback)
function liveTechFromHls() {
  const hls = liveEngine.hls;
  if (!hls || !hls.levels || !hls.levels.length) return;
  const lvl = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : 0];
  liveTechSet(lvl, lvl.bitrate, hlsReachMinutes(lvl.bitrate));
}
// The same line from the active variant track of Shaka Player. The provider's
// playlists carry no BANDWIDTH, thus the measured bitrate comes first.
function liveTechFromShaka() {
  const p = liveEngine.shaka;
  if (!p) return;
  let t = null;
  try {
    t = p.getVariantTracks().find(x => x.active) || null;
  } catch (_) { /* not loaded yet */
  }
  if (!t) return;
  liveTechSet(
      {
        videoCodec: t.videoCodec,
        audioCodec: t.audioCodec,
        width: t.width,
        height: t.height,
        // Shaka Player estimates the rate from the first MPEG-TS segment, and
        // the estimate is frequently a fraction of the real rate (6.25 for a
        // 50 fps channel on the C4). The measured rate comes first.
        frameRate: liveEngine.fps || t.frameRate
      },
      liveEngine.bitrate || t.bandwidth || 0, liveEngine.reach);
}
/**
 * Gives the frame rate that the live engine knows (the playlist, else the
 * measured rate).
 * @return {number} The frame rate, or 0.
 */
function liveEngineFps() {
  if (liveEngine.hls) {
    const hls = liveEngine.hls,
          lvl = hls.levels &&
        hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : 0];
    return (lvl && lvl.frameRate) || liveEngine.fps || 0;
  }
  if (liveEngine.shaka) {
    try {
      const t = liveEngine.shaka.getVariantTracks().find(x => x.active);
      if (t && t.frameRate) return t.frameRate;
    } catch (_) { /* not loaded yet */
    }
    return liveEngine.fps || 0;
  }
  return 0;
}
/**
 * Writes the codec line of the live engine and shows it.
 * @param {!Object} lvl The level or track: videoCodec, audioCodec, width,
 *     height, frameRate.
 * @param {number} bitrate The bitrate in bits per second, or 0.
 * @param {number} reach The rewind reach in minutes.
 */
function liveTechSet(lvl, bitrate, reach) {
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
  if (bitrate) bits.push(`${Math.round(bitrate / 1000)} kbps`);
  const ac = String(lvl.audioCodec || '').toLowerCase();
  if (ac)
    bits.push(
        /^mp4a\.40/.test(ac) ? 'AAC' :
            /^ac-3/.test(ac) ? 'AC-3' :
            /^ec-3/.test(ac) ? 'E-AC-3' :
                               ac.toUpperCase());
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
  noteFpsSample(mp4SampleCount(b, 0), span, liveTechFromHls);
}
// Where the live playhead may go on the MSE path: the buffered range around
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
  let live = end;
  if (hls && typeof hls.liveSyncPosition === 'number' &&
      hls.liveSyncPosition > 0)
    live = hls.liveSyncPosition;
  else if (liveEngine.shaka) {
    try {
      const r = liveEngine.shaka.seekRange();
      if (r && r.end > 0) live = r.end;
    } catch (_) { /* not loaded yet */
    }
  }
  return {start, end: Math.max(end, live), live};
}
function liveBehindSecs() {
  if (!liveEngineActive()) return 0;
  const r = liveBufferRange();
  return Math.max(0, r.live - (videoPlayer.currentTime || 0));
}
function liveGoLive() {
  if (!liveEngineActive()) return;
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
// The provider counts the last stream of this app for approximately 15 s after
// a channel change. Thus, a full account is reported only when a second check
// _consRecheckMs later is also full and the channel still does not play
// (`confirmed`). Before, the app told you that a different device streamed.
let _consInfo = null;  // { active, max, status, exp, at, confirmed }
let _consCheckAt = 0;
let _consRecheckMs = 20 * 1000;  // the e2e suite sets a shorter time
async function xtreamCheckConnections(force = false) {
  if (!_xt || (!force && Date.now() - _consCheckAt < 15000)) return _consInfo;
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
      at: Date.now(),
      confirmed: false
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
  if (ci.confirmed && consFull(ci))
    return ci.max === 1 ?
        'Another device is streaming with this account (1 connection allowed)' :
        `All ${ci.max} connections of this account are in use`;
  return '';
}
/**
 * Tells if all the connections of the account are in use.
 * @param {?Object} ci The result of xtreamCheckConnections.
 * @return {boolean} True when the account is full.
 */
function consFull(ci) {
  return !!ci && ci.max > 0 && ci.active >= ci.max;
}
let _consRecheckTimer = null;  // 1 recheck for the app, not for each channel
let _lastStreamOpenAt = 0;     // set by loadLiveSource
function noteStreamFailureForAccount(idx) {
  if (!_xt || currentPlaylistType !== 'xtream') return;
  xtreamCheckConnections().then(ci => {
    if (!ci || currentChannelIndex !== idx) return;
    if (accountProblemText(ci)) {
      reportAccountProblem(ci);
    } else if (consFull(ci)) {
      scheduleAccountRecheck();
    }
  });
}
/**
 * Tells if a recheck of a full account is pending.
 * @return {boolean} True while the app waits for the recheck.
 */
function consRecheckPending() {
  return !!_consRecheckTimer;
}
/**
 * Starts the recheck _consRecheckMs after the last stream that the app opened.
 * The automatic reloads and the alternate sources open new streams, and the
 * provider counts each of them for a short time.
 */
function scheduleAccountRecheck() {
  if (_consRecheckTimer) return;
  const wait = _lastStreamOpenAt + _consRecheckMs - Date.now();
  _consRecheckTimer = setTimeout(recheckFullAccount, Math.max(wait, 0));
}
/**
 * Checks the account again after a first check found it full. Only a new
 * answer counts: on a failure, xtreamCheckConnections gives the old result.
 */
function recheckFullAccount() {
  _consRecheckTimer = null;
  if (Date.now() - _lastStreamOpenAt < _consRecheckMs) {
    scheduleAccountRecheck();  // the app opened a stream in the wait
    return;
  }
  const playing = !videoPlayer.paused && videoPlayer.readyState >= 3;
  if (currentChannelIndex < 0 || vodMode !== 'live' || playing) return;
  const old = _consInfo;  // a new answer is always a new object
  xtreamCheckConnections(true).then(ci => {
    if (!ci || ci === old || !consFull(ci)) return;
    ci.confirmed = true;
    reportAccountProblem(ci);
  });
}
/**
 * Shows the account problem in the status line and a toast, and logs it.
 * @param {!Object} ci The result of xtreamCheckConnections.
 */
function reportAccountProblem(ci) {
  const t = accountProblemText(ci);
  if (!t) return;
  statusArea.innerText = `⚠️ ${t}`;
  showEPGToast(
      `${t}. Stop playback on the other device, then press Reload.`, 'error',
      'Connection limit');
  hideEPGToast(8000);
  diagLog(`Account: ${t} (active ${ci.active} / max ${ci.max})`);
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
  // Shaka Player has no stopLoad(). The app closes the engine while hidden
  // (the provider connection also ends) and starts the channel again when
  // the app is visible.
  if (liveEngine.shaka && document.hidden) {
    liveEngine.resumeUrl = liveEngine.url;
    stopStallWatchdog();
    liveEngineDestroy();
    return;
  }
  if (!document.hidden && liveEngine.resumeUrl && vodMode === 'live' &&
      !vodPlay.active && currentChannelIndex >= 0 &&
      channels[currentChannelIndex].url === liveEngine.resumeUrl) {
    liveEngine.resumeUrl = '';
    reloadStream(false, 'return from background');
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
