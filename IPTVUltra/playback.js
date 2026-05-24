'use strict';
// Shaka Player wrapper — owns the player instance, trick-play state, and track management.
// Exposed as window.playback for script.js to call.
const playback = (() => {

  // ── Constants ──────────────────────────────────────────────────────────────
  const REWIND_RAMP = [
    { after: 0,    speed: -1 },
    { after: 1500, speed: -2 },
    { after: 4000, speed: -4 },
    { after: 8000, speed: -8 },
  ];
  const FF_RAMP = [
    { after: 0,    speed: 2 },
    { after: 1500, speed: 4 },
    { after: 4000, speed: 8 },
  ];
  const PLAYBACK_RATES = [0.5, 0.75, 1, 1.5, 2];

  // ── State ───────────────────────────────────────────────────────────────────
  let _player      = null;   // shaka.Player
  let _video       = null;   // <video> element
  let _isDVR       = false;
  let _rateIndex = 2;     // index into PLAYBACK_RATES (default 1×)
  let _trickState = 'NORMAL'; // 'NORMAL' | 'REWINDING' | 'FAST_FWD'
  let _holdDir   = null;  // 'left' | 'right' | null
  let _holdStart = 0;
  let _holdInterval = null;

  // ── Internal helpers ────────────────────────────────────────────────────────
  function _getRampSpeed(ramp, heldMs) {
    let speed = ramp[0].speed;
    for (const step of ramp) { if (heldMs >= step.after) speed = step.speed; }
    return speed;
  }

  function _stopTrickPlay() {
    if (_holdInterval) { clearInterval(_holdInterval); _holdInterval = null; }
    if (_video) _video.playbackRate = 1;
    _trickState = 'NORMAL';
    _holdDir = null;
    _holdStart = 0;
    const badge = document.getElementById('pbTrickBadge');
    if (badge) badge.style.display = 'none';
  }

  function _showTrickBadge(text) {
    const el = document.getElementById('pbTrickBadge');
    if (!el) return;
    el.textContent = text;
    el.style.display = '';
  }

  function _showRateBadge(rate) {
    const el = document.getElementById('pbRateBadge');
    if (!el) return;
    if (rate === 1) { el.style.display = 'none'; return; }
    el.textContent = rate + '×';
    el.style.display = '';
  }

  function _updateSeekBar() {
    if (!_player || !_video) return;
    const panel = document.getElementById('playbackPanel');
    if (!panel || panel.style.display === 'none') return;
    const range = _seekRange();
    const duration = range.end - range.start;
    if (duration <= 0) return;
    const pct = Math.min(100, Math.max(0, (_video.currentTime - range.start) / duration * 100));
    const fill  = document.getElementById('pbSeekFill');
    const thumb = document.getElementById('pbSeekThumb');
    const offset = document.getElementById('pbTimeOffset');
    const liveBtn = document.getElementById('pbLiveBtn');
    if (fill)  fill.style.width = pct + '%';
    if (thumb) thumb.style.left  = pct + '%';
    const behind = Math.max(0, range.end - _video.currentTime);
    if (offset) offset.textContent = behind < 3 ? 'At live edge' : '-' + _fmtDur(Math.round(behind)) + ' behind live';
    if (liveBtn) liveBtn.classList.toggle('at-live', behind < 3);
  }

  function _fmtDur(secs) {
    const m = Math.floor(secs / 60), s = secs % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function _audioLabel(t) {
    let label = t.language ? t.language.toUpperCase() : 'Unknown';
    if (t.audioCodec) label += ' (' + (t.audioCodec.split('.')[0] || t.audioCodec) + ')';
    if (t.channelsCount > 2) label += ' ' + t.channelsCount + 'ch';
    return label;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async function init(videoElement) {
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      console.warn('playback: Shaka not supported on this browser');
      return;
    }
    _video = videoElement;
    _player = new shaka.Player();
    await _player.attach(_video);
    _player.configure({
      streaming: {
        bufferingGoal: 120,
        bufferBehind: 120,
        rebufferingGoal: 2,
        stallEnabled: true,
      },
    });
    _player.addEventListener('error', e => console.error('Shaka error:', e.detail));
  }

  async function loadChannel(url) {
    if (!_player) return;
    _stopTrickPlay();
    _rateIndex = 2;
    _showRateBadge(1);
    await _player.load(url);
    const range = _player.seekRange();
    _isDVR = (range.end - range.start) > 30;
    _video.play().catch(() => {});
    _updateSeekBar();
  }

  function _seekRange() {
    if (!_player) return { start: 0, end: _video ? (_video.duration || 0) : 0 };
    return _player.seekRange();
  }

  function seekBy(seconds) {
    if (!_video) return;
    const range = _seekRange();
    _video.currentTime = Math.max(range.start, Math.min(range.end - 1, _video.currentTime + seconds));
    _video.play().catch(() => {});
    _updateSeekBar();
  }

  function startHold(dir) {
    if (_holdDir || !_video) return;
    _holdDir = dir;
    _holdStart = Date.now();
    _trickState = dir === 'left' ? 'REWINDING' : 'FAST_FWD';
    _video.pause();
    const ramp = dir === 'left' ? REWIND_RAMP : FF_RAMP;
    _holdInterval = setInterval(() => {
      if (!_video) return;
      const heldMs = Date.now() - _holdStart;
      const speed  = _getRampSpeed(ramp, heldMs);
      const range  = _seekRange();
      if (dir === 'left') {
        _video.currentTime = Math.max(range.start, _video.currentTime + speed * 0.1);
        _showTrickBadge('◀◀ ' + Math.abs(speed) + '×');
      } else {
        _video.currentTime = Math.min(range.end - 1, _video.currentTime + speed * 0.1);
        _showTrickBadge('▶▶ ' + speed + '×');
        if (_video.currentTime >= range.end - 1) stopHold();
      }
      _updateSeekBar();
    }, 100);
  }

  function stopHold() {
    _stopTrickPlay();
    if (_video) _video.play().catch(() => {});
  }

  function goToLive() {
    if (!_video) return;
    _stopTrickPlay();
    _video.currentTime = _seekRange().end - 0.5;
    _video.play().catch(() => {});
    _updateSeekBar();
  }

  function setRate(rate) {
    if (!_video) return;
    _video.playbackRate = rate;
    const idx = PLAYBACK_RATES.indexOf(rate);
    _rateIndex = idx >= 0 ? idx : 2;
    _showRateBadge(rate);
  }

  function changeRate(delta) {
    const next = Math.max(0, Math.min(PLAYBACK_RATES.length - 1, _rateIndex + delta));
    if (next !== _rateIndex) setRate(PLAYBACK_RATES[next]);
  }

  function getSeekInfo() {
    if (!_video) return { pct: 100, behindSeconds: 0, isDVR: _isDVR };
    const range = _seekRange();
    const dur = range.end - range.start;
    const pct = dur > 0 ? Math.min(100, Math.max(0, (_video.currentTime - range.start) / dur * 100)) : 100;
    return { pct, behindSeconds: Math.max(0, range.end - _video.currentTime), isDVR: _isDVR };
  }

  function getStats() {
    if (!_video || !_player) return null;
    const stats  = _player.getStats();
    const tracks = _player.getVariantTracks();
    const active = tracks.find(t => t.active) || {};
    const info   = _player.getBufferedInfo();
    let bufferAhead = 0;
    if (info && info.total && info.total.length) {
      const seg = info.total.find(s => s.start <= _video.currentTime && s.end > _video.currentTime);
      if (seg) bufferAhead = Math.round(seg.end - _video.currentTime);
    }
    let liveLatency = '—';
    try { const ll = _player.getLiveLatency(); if (isFinite(ll)) liveLatency = ll.toFixed(1) + ' s'; } catch (_) {}
    return {
      width:  active.width  || 0,
      height: active.height || 0,
      frameRate:  active.frameRate ? active.frameRate.toFixed(2) : '—',
      videoCodec: active.videoCodec || '—',
      audioCodec: active.audioCodec || '—',
      bandwidth:  active.bandwidth ? (active.bandwidth / 1e6).toFixed(1) + ' Mbps' : '—',
      estimatedBandwidth: stats.estimatedBandwidth ? (stats.estimatedBandwidth / 1e6).toFixed(1) + ' Mbps' : '—',
      liveLatency,
      bufferAhead: bufferAhead + ' s',
      droppedFrames:   stats.droppedFrames   || 0,
      corruptedFrames: stats.corruptedFrames || 0,
      loadLatency: stats.loadLatency ? stats.loadLatency.toFixed(2) + ' s' : '—',
    };
  }

  function getTrackLists() {
    if (!_player) return { audio: [], subtitles: [], quality: [] };
    const variantTracks = _player.getVariantTracks();

    // Audio — deduplicate by audioId
    const seenAudio = new Set();
    const audio = [];
    for (const t of variantTracks) {
      if (t.audioId != null && !seenAudio.has(t.audioId)) {
        seenAudio.add(t.audioId);
        audio.push({ id: t.audioId, label: _audioLabel(t), active: t.active });
      }
    }

    // Subtitles — "Off" pinned at index 0
    const textTracks = _player.getTextTracks();
    const anySubActive = textTracks.some(t => t.active) && _player.isTextTrackVisible();
    const subtitles = [{ id: null, label: 'Off', active: !anySubActive }];
    for (const t of textTracks) {
      subtitles.push({ id: t.id, label: t.label || t.language || 'Unknown', active: t.active && anySubActive });
    }

    // Quality — sorted by height desc, Auto at top
    const heights = new Set();
    const qualityItems = [];
    for (const t of variantTracks) {
      if (t.height && !heights.has(t.height)) {
        heights.add(t.height);
        qualityItems.push({ id: t.id, label: t.height + 'p', height: t.height });
      }
    }
    qualityItems.sort((a, b) => b.height - a.height);
    const abrEnabled = _player.getConfiguration().abr.enabled;
    const quality = [{ id: null, label: 'Auto', active: abrEnabled }, ...qualityItems.map(q => ({ ...q, active: false }))];

    return { audio, subtitles, quality };
  }

  function setAudioTrack(audioId) {
    if (!_player) return;
    const match = _player.getVariantTracks().filter(t => t.audioId === audioId);
    if (match.length) _player.selectVariantTrack(match[0], true);
  }

  function setSubtitleTrack(id) {
    if (!_player) return;
    if (id === null) { _player.setTextTrackVisibility(false); return; }
    const track = _player.getTextTracks().find(t => t.id === id);
    if (track) { _player.selectTextTrack(track); _player.setTextTrackVisibility(true); }
  }

  function setQuality(id) {
    if (!_player) return;
    if (id === null) { _player.configure({ abr: { enabled: true } }); return; }
    const track = _player.getVariantTracks().find(t => t.id === id);
    if (track) { _player.configure({ abr: { enabled: false } }); _player.selectVariantTrack(track, true); }
  }

  function updateMediaSession(ch) {
    if (typeof webOS === 'undefined' || !webOS.service) return;
    webOS.service.request('luna://com.webos.service.mediacontroller', {
      method: 'registerMediaSession',
      parameters: {
        mediaId: 'com.outkst.iptvultra',
        title:  ch ? ch.name  || '' : '',
        artist: ch ? ch.group || '' : '',
        mediaType:  'video',
        playStatus: _video && !_video.paused ? 'playing' : 'paused',
      },
      onSuccess: () => {},
      onFailure: e => console.warn('mediacontroller:', e),
    });
  }

  function destroy() {
    _stopTrickPlay();
    if (_player) { _player.destroy(); _player = null; }
    _video = null;
    _isDVR = false;
    _rateIndex = 2;
  }

  // Accessors used by script.js key handlers
  function getTrickState()     { return _trickState; }
  function isHolding()         { return _holdDir !== null; }
  function getRateIndex()      { return _rateIndex; }
  function getPlaybackRates()  { return [...PLAYBACK_RATES]; }
  function updateSeekBar()     { _updateSeekBar(); }

  return {
    init, loadChannel, seekBy,
    startHold, stopHold, goToLive,
    setRate, changeRate,
    getSeekInfo, getStats, getTrackLists,
    setAudioTrack, setSubtitleTrack, setQuality,
    updateMediaSession, destroy,
    getTrickState, isHolding, getRateIndex, getPlaybackRates, updateSeekBar,
  };
})();
