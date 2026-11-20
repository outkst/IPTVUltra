/**
 * @fileoverview Channel indexes, event (PPV) channels, previous channel,
 * surfing, alternate sources, Recent, versions, and channel number entry.
 */

// ----- EPG (XMLTV) -----
let _chanByNum = new Map();  // provider channel number → index in channels[]
                             // (direct entry with the digit keys)
let _chanByUrl =
    new Map();  // stream URL → index (Recent list, alternate sources)
let _chansByFavId = new Map();  // favorite id → [channels], so Favorites can
                                // follow the user's order
// A favorite is one exact channel: the Xtream stream id, else the stream URL.
// (Until 3.12 it was the tvg-id, which quality variants share, so starring the
// 1080p entry also listed its 720p and 480p copies.)
function favIdOf(ch, idx) {
  return ch.streamId != null && ch.streamId !== '' ? `s:${ch.streamId}` :
      ch.url ? `u:${ch.url}` :
               `idx_${idx}`;
}

/**
 * Gives the group name that the app uses for a channel. The name has no spaces
 * at the start or at the end. A provider group with the key of a pinned group
 * (`favorites`, `all`, or `recent`) gets a capital first letter, because the
 * two groups must have different keys.
 * @param {*} group The group name from the provider.
 * @return {string} The group name.
 */
function normGroupName(group) {
  const g = group == null ? '' : String(group).trim();
  if (g === 'favorites' || g === 'all' || g === 'recent')
    return g[0].toUpperCase() + g.slice(1);
  // The key of a saved search starts with "ss:" (lower case only). The result
  // must not change when the function runs again on its own result.
  if (g.startsWith('ss:')) return 'SS:' + g.slice(3);
  return g;
}
/**
 * Decodes the percent codes of a URL.
 * @param {string} url
 * @return {string} The decoded URL, or the URL if it has an incorrect code.
 */
function decodeUrlSafe(url) {
  try {
    return decodeURIComponent(url);
  } catch (_) {
    return url;
  }
}
/**
 * The index of the channel with a stream URL. A saved URL can have no URL
 * encoding.
 * @param {string} url
 * @return {number|undefined}
 */
function chanIndexByUrl(url) {
  if (!url) return undefined;
  const i = _chanByUrl.get(url);
  return i !== undefined ? i : _chanByUrl.get(decodeUrlSafe(url));
}
function buildChannelIndexMap() {
  channelIndexMap = new Map();
  _chanByNum = new Map();
  _chanByUrl = new Map();
  _chansByFavId = new Map();
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const g = normGroupName(ch.group);
    if (g !== ch.group) ch.group = g;
    channelIndexMap.set(ch, i);
    const n = ch.num;
    if (n > 0 && !_chanByNum.has(n)) _chanByNum.set(n, i);
    if (ch.url && !_chanByUrl.has(ch.url)) {
      _chanByUrl.set(ch.url, i);
      // Saved URLs from before 3.17.0 have no URL encoding of the user name
      // and the password
      const plain = decodeUrlSafe(ch.url);
      if (plain !== ch.url && !_chanByUrl.has(plain)) _chanByUrl.set(plain, i);
    }
    const fid = favIdOf(ch, i);
    if (_chansByFavId.has(fid))
      _chansByFavId.get(fid).push(ch);
    else
      _chansByFavId.set(fid, [ch]);
  }
  _searchCache = {query: null, result: null};
  _altSources.clear();
  _altIndex = null;
  buildEventProgs();
}
function chDisplayNum(ch, idx) {
  return ch && ch.num > 0 ? ch.num : idx + 1;
}

// ----- Event (PPV) channels -----
// Event channels carry their schedule in the name instead of the EPG, in many
// provider formats. Only formats whose time zone is known are read; the zones
// were checked on the real provider 2026-10-15 against the same event listed in
// two formats ("Oct 15 7:00AM ET (2026-10-15 07:00:00)"; "@ Oct 15 02:30 AM" =
// "Thu 15 Oct 02:30 EDT"; "@ Oct 15 9:00 AM" = "Thu 15 Oct 10:30 NDT";
// "start:… 11:00" = a 13:00 session in Central Europe, that is, UTC). Read
// formats (<event> is the text of the event):
//   "LIVE | <event> | Thu 15 Oct 20:30 NDT (CA) | …"
//   (also "// UK Sat 10 Oct 12:30pm") "End | <event> | … |
//   2026-10-15 | 00:15 (GMT) | …"               (also 15-10-2026) "<event> …
//   start:2026-10-11 01:55:00 stop:2026-10-11 06:00:00"  (UTC)
//   "US (<group> 001) | <event> (2026-10-15 08:00:00)" (US Eastern; "AU ("
//   names Sydney) "<event> @ Oct 14 7:30 PM :<league> 04" (US
//   Eastern; US| and CA| groups only)
// Times without a zone ("7pm <event>", "Fri 18 Apr 22:05") and
// the 2098 placeholder slots are skipped. A parsed event fills the guide for a
// channel that has no EPG of its own (epgProgsOf) and orders its group.
const EV_MON = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11
};
const EV_ABBR = {
  UTC: 0,
  GMT: 0,
  BST: 60,
  CET: 60,
  CEST: 120,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
  AST: -240,
  ADT: -180,
  NST: -210,
  NDT: -150,
  AEST: 600,
  AEDT: 660
};
const EV_ZONE = {
  ET: 'America/New_York',
  CT: 'America/Chicago',
  PT: 'America/Los_Angeles',
  UK: 'Europe/London'
};
const EVENT_DEFAULT_MS =
    3 * 3600000;  // assumed length when the name gives only a start
const EVENT_HIDE_AFTER_MS = 3600000;  // finished events stay listed this long
const _RE_EV_PRE = /\d:\d\d|\d{4}-\d\d-\d\d|\d\d-\d\d-\d{4}/;
const _RE_EV_TAG = /^\s*(LIVE|NEXT|ENDED|End)\s*\|\s*/i;
const _RE_EV_STARTSTOP =
    /\bstart:(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)(?::\d\d)?\s+stop:(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/;
const _RE_EV_PIPEDATE =
    /(?:(\d{4})-(\d\d)-(\d\d)|(\d\d)-(\d\d)-(\d{4}))\s*\|\s*(\d{1,2}):(\d\d)\s*\((?:GMT|UTC)\)/;
const _RE_EV_PAREN = /\((\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):\d\d\)\s*$/;
const _RE_EV_DAY =
    /(?:\b(UK|ET)\s+)?\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}):(\d\d)(?::\d\d)?\s*([ap]m)?\s*([A-Z]{2,4})?\b/i;
const _RE_EV_AT =
    /@\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\s+(\d{1,2}):(\d\d)\s*([ap]m)?/i;
const _RE_EV_JUNKSEG =
    /^(?:\d+K EXCLUSIVE|all|[A-Z]{2}: .+ \d+|(?:[A-Z]{2}\s*)?(?:\([^)]*\)\s*)+\d*)$/i;
const _RE_EV_SPORT = /^([a-z][a-z ]{1,20}):\s+(\S.*)$/;
const _RE_EV_LABEL =
    /^(?:(?:\S+\s+){0,2}\d{1,3}\S?\s*:|[a-z]+:\s*\d+\s+name:)\s*/i;  // "UFC 02
                                                                     // :", "PDC
                                                                     // Board 01
                                                                     // :",
                                                                     // "wnba: 1
                                                                     // name:"
const EV_WDAY = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
};
// Wall-clock time in a zone (IANA id or fixed offset in minutes) → UTC ms
function evWallToUtc(y, mo, d, h, mi, zone) {
  const wall = Date.UTC(y, mo, d, h, mi);
  if (typeof zone === 'number') return wall - zone * 60000;
  const t = wall - tzOffsetMin(zone, wall) * 60000;
  return wall -
      tzOffsetMin(zone, t) *
      60000;  // second pass lands on the right side of a DST change
}
// Names without a year: the year that puts the event nearest to now. With a
// weekday ("Sat 3 Feb") only years where the date falls on that day count, so a
// stale name from an older season ("2024 round 5 … Sat 3 Feb") reads as
// nothing.
function evNearestYear(mo, d, h, mi, zone, wday) {
  const now = Date.now(), y = new Date(now).getUTCFullYear();
  let best = NaN;
  for (const yy of [y - 1, y, y + 1]) {
    if (wday !== undefined &&
        new Date(Date.UTC(yy, mo, d)).getUTCDay() !== wday)
      continue;
    const t = evWallToUtc(yy, mo, d, h, mi, zone);
    if (isNaN(best) || Math.abs(t - now) < Math.abs(best - now)) best = t;
  }
  return best;
}
function ev12h(h, ampm) {
  if (!ampm || h > 12) return h;
  return /p/i.test(ampm) ? (h % 12) + 12 : h % 12;
}
// { start, stop, title, desc, tag: 'live' | 'next' | 'ended' | '' } or null
function parseEventName(ch) {
  const name = ch.name || '';
  if (!_RE_EV_PRE.test(name)) return null;
  const tm = _RE_EV_TAG.exec(name);
  const tag = tm ? (/^l/i.test(tm[1])     ? 'live' :
                        /^n/i.test(tm[1]) ? 'next' :
                                            'ended') :
                   '';
  let start = NaN, stop = NaN, m;
  if ((m = _RE_EV_STARTSTOP.exec(name))) {
    start = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
    stop = Date.UTC(+m[6], m[7] - 1, +m[8], +m[9], +m[10]);
  } else if ((m = _RE_EV_PIPEDATE.exec(name))) {
    start = m[1] ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[7], +m[8]) :
                   Date.UTC(+m[6], m[5] - 1, +m[4], +m[7], +m[8]);
  } else if ((m = _RE_EV_PAREN.exec(name))) {
    start = evWallToUtc(
        +m[1], m[2] - 1, +m[3], +m[4], +m[5],
        /^\s*AU\b/.test(name) ? 'Australia/Sydney' : 'America/New_York');
  } else if ((m = _RE_EV_DAY.exec(name))) {
    const after = (m[8] || '').toUpperCase(),
          before = (m[1] || '').toUpperCase();
    const zone =
        after in EV_ABBR ? EV_ABBR[after] : EV_ZONE[after] || EV_ZONE[before];
    if (zone === undefined) return null;
    start = evNearestYear(
        EV_MON[m[4].toLowerCase()], +m[3], ev12h(+m[5], m[7]), +m[6], zone,
        EV_WDAY[m[2].toLowerCase()]);
  } else if (
      (m = _RE_EV_AT.exec(name)) && /^(US|CA)\s*\|/i.test(ch.group || '')) {
    start = evNearestYear(
        EV_MON[m[1].toLowerCase()], +m[2], ev12h(+m[3], m[5]), +m[4],
        'America/New_York');
  }
  if (!(start > 0) || Math.abs(start - Date.now()) > 400 * 86400000)
    return null;
  if (!(stop > start)) stop = start + EVENT_DEFAULT_MS;
  // Title: the name without the status word, the date part (and what follows it
  // in that segment) and filler segments
  let rest = tm ? name.slice(tm[0].length) : name;
  const at = rest.indexOf(m[0]);
  const segs = [];
  let pos = 0;
  for (const seg of rest.split('|')) {
    const segStart = pos;
    pos += seg.length + 1;
    let t = seg;
    if (at >= segStart && at < pos)
      t = seg.slice(0, at - segStart).replace(/[\s/:@-]+$/, '');
    else if (at >= 0 && segStart > at)
      continue;  // everything after the date is channel labelling
    t = t.trim();
    if (t && !_RE_EV_JUNKSEG.test(t)) segs.push(t);
  }
  if (segs.length > 1 && /^(?:[A-Z]{2}|[^:]{1,30}\s\d{1,3})$/.test(segs[0]))
    segs.shift();  // slot label: "CA", "National League 1"
  if (segs.length) segs[0] = segs[0].replace(_RE_EV_LABEL, '') || segs[0];
  // A sport label in lower case goes to the description: "hockey:  A vs B _
  // U18" gives the title "A vs B · U18" and the description "Hockey"
  let sport = '';
  if (segs.length) {
    const sm = _RE_EV_SPORT.exec(segs[0]);
    if (sm) {
      const s = sm[1];
      if (s !== 'live') sport = s.charAt(0).toUpperCase() + s.slice(1);
      segs[0] = sm[2];
    }
    segs[0] = segs[0].replace(/\s+_\s+/g, ' · ').replace(/\s{2,}/g, ' ');
  }
  const title = segs.length ? segs[0] : name;
  const desc = [sport].concat(segs.slice(1)).filter(Boolean).join(' · ');
  return {start, stop, title, desc, tag};
}
// Parsed once per channel object (names do not change; a playlist refresh
// brings new objects)
const _evCache = new WeakMap();
let _eventProgs = new Map();  // tvgId -> [programme] built from event names,
                              // the guide's fallback
function eventOf(ch) {
  let ev = _evCache.get(ch);
  if (ev === undefined) {
    ev = parseEventName(ch);
    _evCache.set(ch, ev);
  }
  return ev;
}
// Event names with no usable time, for example "Xyz (XY) 25: 2025 A vs B -
// Field Hockey - 22/10 15:00". The name gives no time zone, and on the
// provider (2026-11-08) the dates were more than 1 year old. Thus, the guide
// shows the title with no time: in the row in place of "No data", in the info
// panel, and in the live banner.
const _RE_UT_GROUP = /PPV|EVENT/i;
const _RE_UT_LABEL = /^[^:|]{1,30}?\d{1,4}\s*:\s*(\S.*)$/;
const _RE_UT_DATE = /\s*-\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d\d)\s*$/;
const _RE_UT_YEAR = /^((?:19|20)\d\d)\s+/;
const _untimedCache = new WeakMap();
// Channel -> {title, note}. The key is the channel, not the tvg-id: event
// channels can share 1 EPG id, and each one has its own title.
let _untimedEvents = new WeakMap();
/**
 * Reads the title of an event name that has no usable time.
 * @param {!Object} ch The channel.
 * @return {?{title: string, note: string}} The title and a note with the
 *     date of the name, or null.
 */
function parseUntimedName(ch) {
  if (!_RE_UT_GROUP.test(ch.group || '')) return null;
  const m = _RE_UT_LABEL.exec(ch.name || '');
  if (!m) return null;
  let rest = m[1].trim(), note = '';
  const d = _RE_UT_DATE.exec(rest);
  rest = rest.replace(_RE_UT_DATE, '');
  const y = _RE_UT_YEAR.exec(rest);
  rest = rest.replace(_RE_UT_YEAR, '').replace(/\s+-\s+/g, ' · ').trim();
  if (!rest || rest.length < 3) return null;
  if (d) {
    const mon = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
      'Nov', 'Dec'
    ][+d[2] - 1];
    if (mon)
      note = `Listed for ${+ d[1]} ${mon}${y ? ' ' + y[1] : ''}, ${d[3]}:${
          d[4]} (no time zone in the name)`;
  }
  return {title: rest, note};
}
/**
 * The title of an untimed event for a channel, if the channel has no EPG.
 * @param {?Object} ch The channel.
 * @return {?{title: string, note: string}}
 */
function untimedEventOf(ch) {
  return (ch && _untimedEvents.get(ch)) || null;
}
function buildEventProgs() {
  _eventProgs = new Map();
  _untimedEvents = new WeakMap();
  for (const ch of channels) {
    const ev = eventOf(ch);
    if (!ev && ch.tvgId && _RE_UT_GROUP.test(ch.group || '')) {
      let u = _untimedCache.get(ch);
      if (u === undefined) {
        u = parseUntimedName(ch);
        _untimedCache.set(ch, u);
      }
      if (u) _untimedEvents.set(ch, u);
    }
    if (ev && ch.tvgId && !_eventProgs.has(ch.tvgId))
      _eventProgs.set(ch.tvgId, [{
                        start: ev.start,
                        stop: ev.stop,
                        title: ev.title,
                        desc: ev.desc,
                        fromName: true
                      }]);
  }
}
// Programmes for a channel: its EPG when there is any, else the event read from
// its name
function epgProgsOf(tvgId) {
  const id = resolveEpgId(tvgId);
  const p = id ? epgData.get(id) : null;
  const x = xmltvProgsOf(tvgId);
  // When the XMLTV programs ended (the file stops, or its refresh fails), the
  // provider programs come first
  if (x && (xmltvCurrent(x) || !(p && p.length)))
    return p && p.length ? xmltvWithPast(tvgId, x, p) : x;
  if (p && p.length) return p;
  return (tvgId && _eventProgs.get(tvgId)) || null;
}
// True while an XMLTV list has a program that did not stop
function xmltvCurrent(x) {
  return x.length > 0 && x[x.length - 1].stop > Date.now();
}
// tvgId -> {x, p, list}: the last list that xmltvWithPast made
const _xmltvMerged = new Map();
/**
 * The XMLTV data starts 1 h before the current time. Thus, the programs
 * before it come from the provider: the archive table of a catch-up channel,
 * or a lazy fetch. The result stays in a cache until 1 of the 2 lists changes.
 * @param {string} tvgId
 * @param {!Array<!Object>} x XMLTV programs, sorted.
 * @param {!Array<!Object>} p Provider programs, sorted.
 * @return {!Array<!Object>}
 */
function xmltvWithPast(tvgId, x, p) {
  if (p[0].start >= x[0].start) return x;
  const c = _xmltvMerged.get(tvgId);
  if (c && c.x === x && c.p === p) return c.list;
  const first = x[0].start;
  const list = [];
  for (const q of p) {
    if (q.stop > first) break;
    list.push(q);
  }
  const all = list.length ? list.concat(x) : x;
  _xmltvMerged.set(tvgId, {x, p, list: all});
  return all;
}
function evFinished(ev, now) {
  return ev.tag === 'ended' || now >= ev.stop;
}
// Order a group of event channels by start time (finished ones last, unparsed
// ones after them), optionally leaving out events finished over an hour ago.
// The playing channel always stays. Groups where fewer than half the names
// carry a time are left as listed.
function arrangeEventGroup(list) {
  const mode = settings.ppvEvents;
  if (mode === 'off' || list.length < 2) return list;
  let n = 0;
  for (const ch of list)
    if (eventOf(ch)) n++;
  if (n < list.length / 2) return list;
  const now = Date.now();
  const playing =
      currentChannelIndex >= 0 ? channels[currentChannelIndex] : null;
  const items = [];
  for (let i = 0; i < list.length; i++) {
    const ch = list[i], ev = eventOf(ch);
    const done = ev ? evFinished(ev, now) : false;
    if (mode === 'hide' && done && ch !== playing &&
        !isPlayingIdx(channelIndexMap.get(ch)) &&
        now > (ev.tag === 'ended' ? Math.min(ev.start, ev.stop) : ev.stop) +
                EVENT_HIDE_AFTER_MS)
      continue;
    items.push({ch, ev, i, rank: !ev ? 2 : done ? 1 : 0});
  }
  items.sort(
      (a, b) => a.rank - b.rank ||
          (a.ev && b.ev ? a.ev.start - b.ev.start : 0) || a.i - b.i);
  return items.map(x => x.ch);
}

// ----- Previous channel, channel surfing, alternate sources, recent channels
// ----- Red (or a long press on OK) flips between the two most recent channels
function swapToPreviousChannel() {
  if (lastChannelIndex < 0 || !channels[lastChannelIndex] ||
      isPlayingIdx(lastChannelIndex)) {
    showEPGToast('No previous channel', 'success', 'Channel');
    hideEPGToast(2500);
    return false;
  }
  const idx = lastChannelIndex;
  selectChannel(idx);
  moveCursorToChannel(channels[idx]);
  return true;
}
// Mark the rendered rows of the playing channel (guide or channel list): the
// version that plays and the channel that you selected
function markPlayingRows() {
  const rows = epgMode ? epgRenderedRows : renderedItems;
  for (const [fi, el] of rows) {
    const ch = currentFilteredChannels[fi];
    el.classList.toggle('active', !!ch && isPlayingIdx(getChannelIndex(ch)));
  }
}
// True when the channel at `idx` plays, also when the app plays a better
// version of it (`_bestFrom`)
function isPlayingIdx(idx) {
  return idx >= 0 &&
      (idx === currentChannelIndex || (_bestFrom >= 0 && idx === _bestFrom));
}
// The position of the playing channel in a list. When the app plays a better
// version of the channel that you selected, it is the position of the selected
// channel, so that the cursor stays on that row.
function playingListIndex(list) {
  if (currentChannelIndex < 0) return -1;
  if (_bestFrom >= 0 && channels[_bestFrom]) {
    const i = list.indexOf(channels[_bestFrom]);
    if (i >= 0) return i;
  }
  return list.indexOf(channels[currentChannelIndex]);
}
// Put the guide / list cursor on a channel after a selection that did not come
// from the cursor
function moveCursorToChannel(ch) {
  let fi = currentFilteredChannels.indexOf(ch);
  if (fi < 0 && channels[currentChannelIndex] === ch)
    fi = playingListIndex(currentFilteredChannels);
  if (fi < 0) return;
  if (epgMode) {
    epgFocusedRowIdx = fi;
    epgFocusT = 0;
    updateEPGRowFocus();
  } else {
    stdFocusIdx = fi;
    stdFocusZone = 'channels';
    updateStdChannelFocus();
  }
}
// Channel surfing in the live player: with the banner hidden, Up/Down step
// through the current list in the banner without tuning; OK tunes the previewed
// channel, Back (or the banner timing out) cancels. CH± still zap.
const surf = {
  active: false,
  idx: -1
};  // idx into currentFilteredChannels
function surfChannel() {
  return surf.active ? currentFilteredChannels[surf.idx] || null : null;
}
function surfStep(dir) {
  const list = currentFilteredChannels;
  if (!list.length) return;
  if (!surf.active) {
    const cur = playingListIndex(list);
    // Not in the list: the first step shows the first (or the last) row
    surf.idx = cur >= 0 ? cur : dir > 0 ? -1 : 0;
    surf.active = true;
    document.getElementById('vodOsd').classList.add('surf');
  }
  surf.idx = (surf.idx + dir + list.length) % list.length;
  const ch = list[surf.idx];
  if (ch && ch.tvgId && !getCurrentProgramme(ch.tvgId))
    queueEpgFetch([ch.tvgId], true);
  player.focus = 'bar';
  showVodOsd();
}
function surfCancel() {
  if (!surf.active) return;
  surf.active = false;
  surf.idx = -1;
  const osd = document.getElementById('vodOsd');
  if (osd) osd.classList.remove('surf');
  const techEl = document.getElementById('vodOsdTech');
  if (techEl)
    techEl.textContent = liveUms ?
        umsTechString(liveUms) :
        (liveEngine.tech || '');  // the hint line goes back to the codec line
}
function surfTune() {
  const ch = surfChannel();
  surfCancel();
  if (!ch) return;
  const idx = getChannelIndex(ch);
  if (idx < 0) return;
  // The channel of a catch-up stays in the archive
  if (isPlayingIdx(idx) && (catchup || playingStreamHealthy())) {
    showVodOsd();
    return;
  }
  selectChannel(idx);
  moveCursorToChannel(ch);
}
// Alternate sources: other entries of the same channel in the playlist (same
// tvg-id, or the same name once quality tags and punctuation are ignored). When
// a stream exhausts its reload budget the next source is tried.
const _RE_NAME_TAGS =
    /\b(u?hd|fhd|4k|sd|hevc|h\.?26[45]|raw|backup|vip|\d{3,4}p)\b/g;
const _RE_NAME_BRACKETS = /\([^)]*\)|\[[^\]]*\]/g;
const _RE_NON_ALNUM = /[^a-z0-9]+/g;
function normChannelName(name) {
  return String(name || '')
      .toLowerCase()
      .replace(_RE_NAME_BRACKETS, ' ')
      .replace(_RE_NAME_TAGS, ' ')
      .replace(_RE_NON_ALNUM, '');
}
const _altSources = new Map();  // channel index → [indices] (built on first
                                // need, reset with the channel list)
let _altIndex = null;  // { byId, byName }: lower-case tvg-id / normalised name
                       // → [indices], built once per list
function alternateSources(idx) {
  if (_altSources.has(idx)) return _altSources.get(idx);
  const ch = channels[idx];
  const out = [];
  if (ch) {
    if (!_altIndex) {
      const byId = new Map(), byName = new Map();
      const add = (m, k, i) => {
        if (!k) return;
        const l = m.get(k);
        if (l)
          l.push(i);
        else
          m.set(k, [i]);
      };
      for (let i = 0; i < channels.length; i++) {
        const c = channels[i];
        add(byId, (c.tvgId || '').toLowerCase(), i);
        add(byName, normChannelName(c.name), i);
      }
      _altIndex = {byId, byName};
    }
    const id = (ch.tvgId || '').toLowerCase(), nm = normChannelName(ch.name);
    const set = new Set([].concat(
        (id && _altIndex.byId.get(id)) || [],
        (nm && _altIndex.byName.get(nm)) || []));
    for (const i of [...set].sort((a, b) => a - b))
      if (i !== idx && channels[i].url !== ch.url) out.push(i);
  }
  _altSources.set(idx, out);
  return out;
}
let _altOrigin = -1;  // the channel the user actually chose
// The selected channel when a better version of it plays
let _bestFrom = -1;
let _bestIdx = -1;  // the best version that bestVersionOf gave for _bestFrom
const _bestFailed = new Set();  // versions that failed in this session
let _altTried = new Set();      // indices already tried for it this time
let _selectingAlt =
    false;  // selectChannel() called by the fallback (not a user choice)
let _returningLive = false;   // selectChannel() after a catch-up
let _keepSelection = false;   // selectChannel() keeps _bestFrom and _altOrigin
let _selectingExact = false;  // selectChannel() plays this version, not the
                              // best version
function tryAlternateSource(msg) {
  // A catch-up that fails is not a failure of the live stream
  if (_altOrigin < 0 || vodMode !== 'live' || vodPlay.active || catchup)
    return false;
  // A best version that fails is not selected again in this session
  if (_bestIdx >= 0 && currentChannelIndex === _bestIdx)
    _bestFailed.add(currentChannelIndex);
  // The selected channel is first: the app can play a better version of it
  const alts = [_altOrigin].concat(alternateSources(_altOrigin));
  const next = alts.find(i => !_altTried.has(i) && channels[i]);
  if (next === undefined) return false;
  _altTried.add(next);
  const n = _altTried.size - 1, total = alts.length - 1;
  showEPGToast(
      `${msg}. Trying alternate source ${n} of ${total}: ${
          channels[next].name}`,
      'loading', 'Stream');
  hideEPGToast(4000);
  diagLog(`${channels[_altOrigin].name}: ${msg}; trying source ${n}/${total} (${
      channels[next].name})`);
  _selectingAlt = true;
  try {
    selectChannel(next);
  } finally {
    _selectingAlt = false;
  }
  return true;
}
// Recent channels (per playlist, most recent first)
const RECENT_MAX = 20;
function noteRecentChannel(ch) {
  if (!_activePlaylistKey || !ch || !ch.url) return;
  const ps = getPlaylistState(_activePlaylistKey);
  const list = (ps.recent || []).filter(r => r.url !== ch.url);
  list.unshift({url: ch.url, tvgId: ch.tvgId || ''});
  ps.recent = list.slice(0, RECENT_MAX);
}
function recentChannels() {
  const ps = _activePlaylistKey ? getPlaylistState(_activePlaylistKey) : null;
  const out = [];
  for (const r of (ps && ps.recent) || []) {
    let i = chanIndexByUrl(r.url);
    if (i === undefined && r.tvgId)
      i = channels.findIndex(c => c.tvgId === r.tvgId);
    if (i !== undefined && i >= 0 && channels[i] && !out.includes(channels[i]))
      out.push(channels[i]);
  }
  return out;
}
// Favorites in the user's order (the Set keeps insertion order; Manage
// favorites rebuilds it)
function favoriteChannels() {
  const out = [];
  for (const id of favoriteIds) {
    const l = _chansByFavId.get(id);
    if (l) out.push(l[0]);
  }  // a URL listed twice is still one favorite
  return out;
}

// ----- Versions of a channel (quality variants) -----
// Providers list one channel several times (FHD, HD, RAW, backups) under one
// tvg-id or one name: the same set alternateSources() falls back through. The
// Versions menu (live player banner button; long press OK on a guide or
// channel-list row) lists them with the resolution and frame rate seen the last
// time each one played. OK watches a version; Green makes it the favorite in
// place of the starred one (only on request). A version's real quality is only
// known after playing it (the provider allows one connection per account, so
// nothing can be probed in the background); the numbers fill in as channels are
// watched (`iptv_stream_tech`, per playlist and favIdOf key).
const STREAM_TECH_KEY = 'iptv_stream_tech';
const STREAM_TECH_MAX = 800;
const _streamTech = loadJson(STREAM_TECH_KEY, {}) || {};
function streamTechOf(ch, idx) {
  return _activePlaylistKey ?
      _streamTech[_activePlaylistKey + '|' + favIdOf(ch, idx)] || null :
      null;
}
// Remember what the playing live channel actually delivers (called on
// resize/metadata, hls level info, media service info)
function noteCurrentStreamTech() {
  if (!_activePlaylistKey || currentChannelIndex < 0 || vodMode !== 'live' ||
      vodPlay.active || catchup)
    return;
  let w = videoPlayer.videoWidth, h = videoPlayer.videoHeight, fps = 0;
  if (liveEngineActive()) {
    fps = liveEngineFps();
  } else if (liveUms && liveUms.video) {
    const vi = liveUms.videoInfo || {};
    fps = vi.frameRate || liveUms.video.frameRate || liveUms.measuredFps || 0;
    if (!(w > 0)) {
      w = vi.width || liveUms.video.width;
      h = vi.height || liveUms.video.height;
    }
  }
  if (!(w > 0 && h > 0)) return;
  const ch = channels[currentChannelIndex],
        k = _activePlaylistKey + '|' + favIdOf(ch, currentChannelIndex);
  const old = _streamTech[k];
  if (!(fps > 0) && old && old.w === w && old.h === h)
    fps = old.fps ||
        0;  // fps arrives after the size; keep the last one meanwhile
  if (old && old.w === w && old.h === h && old.fps === fps &&
      Date.now() - old.at < 86400000)
    return;
  delete _streamTech[k];
  _streamTech[k] = {w, h, fps: fps > 0 ? fps : 0, at: Date.now()};
  const ks = Object.keys(_streamTech);
  if (ks.length > STREAM_TECH_MAX) delete _streamTech[ks[0]];
  saveJson(STREAM_TECH_KEY, _streamTech);
}
function versionsOf(idx) {
  return channels[idx] ? [idx].concat(alternateSources(idx)) : [];
}
// The picture class of a height: 1920×1084 and 1920×1080 are the same class
function heightClass(h) {
  return h >= 2000 ? 2160 :
      h >= 1000    ? 1080 :
      h >= 700     ? 720 :
      h >= 540     ? 576 :
      h > 0        ? 480 :
                     0;
}
// The version of a channel with a better picture than the channel, or -1. Only
// a version that played before counts (`iptv_stream_tech`). The provider
// allows 1 connection, thus the app cannot test a version in the background.
// A channel with no measurement gets the height that its name gives.
function bestVersionOf(idx) {
  return settings.bestVersion === false ? -1 : betterMeasuredVersion(idx);
}
// The rule of bestVersionOf, also when the setting is Off (the Best mark of
// the Versions menu)
function betterMeasuredVersion(idx) {
  const ch = channels[idx];
  if (!ch) return -1;
  const own = streamTechOf(ch, idx);
  let bestH = own ? heightClass(own.h) :
                    heightClass(RANK_HEIGHT[nameQualityRank(ch.name)] || 0);
  let bestFps =
      own && own.fps ? own.fps : Infinity;  // with no measurement, only a
                                            // higher class counts
  let best = -1;
  for (const i of alternateSources(idx)) {
    if (_bestFailed.has(i) || !channels[i]) continue;
    const t = streamTechOf(channels[i], i);
    if (!t) continue;
    const h = heightClass(t.h), fps = t.fps || 0;
    if (h > bestH || (h === bestH && fps > bestFps + 1)) {
      best = i;
      bestH = h;
      bestFps = fps;
    }
  }
  return best;
}
function streamTechLabel(t) {
  return t ? `${t.w}×${t.h}${t.fps ? ' · ' + fmtFps(t.fps) : ''}` :
             'not watched yet';
}
// Expected height from the name when the version has not been watched (untagged
// sits between SD and HD)
const RANK_HEIGHT = {
  6: 4320,
  5: 2160,
  4: 1080,
  3: 720,
  2: 600,
  1: 480
};
let versionsOpen = false, versionsFocus = 0, _versionsRows = [],
    _versionsOrigin = -1, _versionsFavChanged = false;
function openVersions(idx) {
  const list = versionsOf(idx);
  const ov = document.getElementById('versionsOverlay');
  if (list.length < 2 || !ov) return false;
  if (settingsOpen) closeSettings();
  _versionsOrigin = idx;
  _versionsFavChanged = false;
  _versionsRows = list.map((i, order) => {
    const ch = channels[i], tech = streamTechOf(ch, i);
    return {
      i,
      ch,
      tech,
      order,
      h: heightClass(tech ? tech.h : RANK_HEIGHT[nameQualityRank(ch.name)]),
      fps: tech ? tech.fps || 0 : 0
    };
  });
  _versionsRows.sort(
      (a, b) => (b.h - a.h) || (b.fps - a.fps) ||
          ((b.tech ? 1 : 0) - (a.tech ? 1 : 0)) || (a.i - b.i));
  // "Best" is the version that a selection plays (bestVersionOf), else the
  // selected channel when it has a measurement
  const sel = _bestFrom >= 0 && list.includes(_bestFrom) ? _bestFrom : idx;
  const bv = betterMeasuredVersion(sel);
  const bestI = bv >= 0 ? bv : streamTechOf(channels[sel], sel) ? sel : -1;
  const known = _versionsRows.filter(r => r.tech).length;
  _versionsRows.forEach(r => {
    r.best = known >= 2 && r.i === bestI;
  });
  versionsFocus = Math.max(0, _versionsRows.findIndex(r => r.i === idx));
  versionsOpen = true;
  document.getElementById('versionsTitle').textContent =
      `⇄ Versions · ${channels[idx].name}`;
  ov.classList.remove('hidden');
  renderVersions();
  return true;
}
function closeVersions() {
  if (!versionsOpen) return;
  versionsOpen = false;
  const ov = document.getElementById('versionsOverlay');
  if (ov) ov.classList.add('hidden');
  const list = document.getElementById('versionsList');
  if (list) list.innerHTML = '';
  if (_versionsFavChanged) {
    _versionsFavChanged = false;
    refreshViewIfLoaded();
  }
}
function renderVersions() {
  const list = document.getElementById('versionsList');
  if (!list) return;
  list.innerHTML = '';
  _versionsRows.forEach((r, k) => {
    const fav = favoriteIds.has(favIdOf(r.ch, r.i));
    const tags = [
      r.i === currentChannelIndex ? '▶ Playing' : '', r.best ? 'Best' : '',
      fav ? '★' : ''
    ].filter(Boolean).join('  ');
    const row = document.createElement('div');
    row.className = 'settings-row cats-row version-row' +
        (k === versionsFocus ? ' focused' : '') +
        (r.i === currentChannelIndex ? ' on' : '');
    row.innerHTML =
        `<div class="settings-label"><div class="settings-name">${
            escapeHtml(r.ch.name)}</div>` +
        `<div class="settings-sub">${escapeHtml(r.ch.group || '')} · #${
            chDisplayNum(r.ch, r.i)} · ${streamTechLabel(r.tech)}</div></div>` +
        `<div class="settings-value"><span class="settings-val">${
            tags}</span></div>`;
    row.addEventListener('click', () => {
      versionsFocus = k;
      versionsWatch();
    });
    list.appendChild(row);
  });
  const f = list.querySelector('.cats-row.focused');
  if (f) f.scrollIntoView({block: 'nearest'});
}
function versionsWatch() {
  const r = _versionsRows[versionsFocus];
  if (!r) return;
  closeVersions();
  // The version that plays loads again only after an error
  if (r.i === currentChannelIndex && playingStreamHealthy()) return;
  // The version that you select plays, also when a different one is better
  _selectingExact = true;
  try {
    selectChannel(r.i);
  } finally {
    _selectingExact = false;
  }
  if (livePlayer.active) {
    updateLiveOsd();
    showVodOsd();
  } else
    moveCursorToChannel(r.ch);
}
// Green: this version becomes the favorite. It takes the place (and position)
// of the starred version of this channel; with several starred, of the one the
// menu was opened for; with none, it is added at the end.
function versionsMakeFavorite() {
  const r = _versionsRows[versionsFocus];
  if (!r) return;
  const newId = favIdOf(r.ch, r.i);
  if (favoriteIds.has(newId)) {
    showEPGToast(`${r.ch.name} is already a favorite`, 'success', 'Favorites');
    hideEPGToast(2500);
    return;
  }
  const starred = _versionsRows.map(x => favIdOf(x.ch, x.i))
                      .filter(id => favoriteIds.has(id));
  const originId = favIdOf(channels[_versionsOrigin], _versionsOrigin);
  const replaceId = starred.length === 1 ? starred[0] :
      favoriteIds.has(originId)          ? originId :
                                           null;
  const replaced = replaceId ?
      (_versionsRows.find(x => favIdOf(x.ch, x.i) === replaceId) || {}).ch :
      null;
  const ids = [...favoriteIds];
  if (replaceId)
    ids[ids.indexOf(replaceId)] = newId;
  else
    ids.push(newId);
  favoriteIds = new Set(ids);
  saveFavorites();
  _versionsFavChanged = true;
  showEPGToast(
      replaced ? `★ ${r.ch.name} replaces ${replaced.name}` :
                 `★ ${r.ch.name} added`,
      'success', 'Favorites');
  hideEPGToast(3500);
  renderVersions();
}
function handleVersionsKey(e) {
  const k = e.key, kc = e.keyCode;
  if (k === 'ArrowUp' || kc === 38) {
    e.preventDefault();
    versionsFocus = Math.max(0, versionsFocus - 1);
    renderVersions();
  } else if (k === 'ArrowDown' || kc === 40) {
    e.preventDefault();
    versionsFocus = Math.min(_versionsRows.length - 1, versionsFocus + 1);
    renderVersions();
  } else if (k === 'Enter' || kc === 13) {
    e.preventDefault();
    versionsWatch();
  } else if (kc === 404 || k === 'ColorF1Green') {
    e.preventDefault();
    versionsMakeFavorite();
  } else if (k === 'ArrowLeft' || k === 'ArrowRight' || kc === 37 || kc === 39)
    e.preventDefault();
}
// OK on a guide or channel-list row acts on release; held for LONG_PRESS_MS it
// opens Versions instead (only when the channel has other versions; otherwise
// the release does the normal thing)
let _rowOk = null;  // { timer, fired, short }
function rowOkPress(e, idx, shortAct) {
  e.preventDefault();
  if (e.repeat) return;  // auto-repeat: also a hold that started elsewhere
  if (_rowOk) clearTimeout(_rowOk.timer);  // a release we never saw
  const st = {fired: false, short: shortAct};
  st.timer = setTimeout(() => {
    if (_rowOk === st && openVersions(idx)) st.fired = true;
  }, LONG_PRESS_MS);
  _rowOk = st;
}
document.addEventListener('keyup', e => {
  if (!_rowOk || !(e.key === 'Enter' || e.keyCode === 13)) return;
  const st = _rowOk;
  _rowOk = null;
  clearTimeout(st.timer);
  if (!st.fired) st.short();
});

// ----- Direct channel number entry -----
// Digits on the remote (in Live, guide or channel list, and in the live player)
// type a provider channel number into an overlay; after 2 s without another
// digit (or at 5 digits) the channel is selected.
let _digitBuf = '';
let _digitTimer = null;
function digitOverlay() {
  let el = document.getElementById('chNumOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'chNumOverlay';
    el.className = 'ch-num-overlay hidden';
    document.body.appendChild(el);
  }
  return el;
}
function showDigitOverlay(text, cls) {
  const el = digitOverlay();
  el.textContent = text;
  el.className = 'ch-num-overlay' + (cls ? ' ' + cls : '');
}
function hideDigitOverlay() {
  const el = document.getElementById('chNumOverlay');
  if (el) el.className = 'ch-num-overlay hidden';
}
function digitKeyValue(e) {
  const kc = e.keyCode;
  if (kc >= 48 && kc <= 57) return kc - 48;
  if (kc >= 96 && kc <= 105) return kc - 96;
  if (/^\d$/.test(e.key || '')) return +e.key;
  return -1;
}
function digitEntryAllowed() {
  if (!mainApp || mainApp.style.display === 'none' || !channels.length)
    return false;
  if (confirmDialog && !confirmDialog.classList.contains('hidden'))
    return false;
  if (settingsOpen || catsOpen || diagOpen || versionsOpen || ssOpen ||
      vodPlay.active || vodMode !== 'live')
    return false;
  if (_isTextInput(document.activeElement)) return false;
  return !_chanByNum.size ? false : true;
}
function onDigitKey(d) {
  if (_digitTimer) clearTimeout(_digitTimer);
  _digitBuf = (_digitBuf + d).slice(0, 5);
  showDigitOverlay(_digitBuf, 'typing');
  if (_digitBuf.length >= 5) {
    commitDigits();
    return;
  }
  _digitTimer = setTimeout(commitDigits, 2000);
}
function commitDigits() {
  if (_digitTimer) {
    clearTimeout(_digitTimer);
    _digitTimer = null;
  }
  const n = parseInt(_digitBuf, 10);
  _digitBuf = '';
  if (!(n > 0)) {
    hideDigitOverlay();
    return;
  }
  const idx = _chanByNum.get(n);
  if (idx === undefined) {
    showDigitOverlay(`${n} · no such channel`, 'missing');
    setTimeout(() => {
      if (!_digitBuf) hideDigitOverlay();
    }, 1500);
    return;
  }
  const ch = channels[idx];
  showDigitOverlay(`${n}  ${ch.name}`, 'found');
  setTimeout(() => {
    if (!_digitBuf) hideDigitOverlay();
  }, 1500);
  // The number of the channel that plays does not load the stream again (the
  // provider counts the previous connection for approximately 15 s)
  if (isPlayingIdx(idx) && playingStreamHealthy()) {
    surfCancel();
    if (livePlayer.active) showVodOsd();
  } else
    selectChannel(idx);
  // Put the cursor on the channel where it is listed
  const fi = currentFilteredChannels.indexOf(ch);
  if (fi >= 0) {
    if (epgMode) {
      epgFocusedRowIdx = fi;
      epgFocusT = 0;
      updateEPGRowFocus();
    } else {
      stdFocusIdx = fi;
      stdFocusZone = 'channels';
      updateStdChannelFocus();
    }
  }
  if (livePlayer.active) showVodOsd();
}
function getChannelIndex(ch) {
  const i = channelIndexMap.get(ch);
  return i !== undefined ? i : -1;
}

// Binary search: index of rightmost programme with start <= target, or -1
function _epgBinarySearch(progs, target) {
  let lo = 0, hi = progs.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (progs[mid].start <= target) {
      result = mid;
      lo = mid + 1;
    } else
      hi = mid - 1;
  }
  return result;
}

function parseXMLTVDate(str) {
  if (!str) return null;
  const m = str.match(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})/);
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const sign = m[7] === '+' ? 1 : -1;
  return utc - sign * ((+m[8]) * 60 + (+m[9])) * 60000;
}

function formatTimeHHMM(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, '0') + ':' +
      d.getMinutes().toString().padStart(2, '0');
}

function formatTime12(ts) {
  const d = new Date(ts);
  const h = d.getHours(), min = d.getMinutes();
  const h12 = h % 12 || 12;
  return `${h12}:${min.toString().padStart(2, '0')}${h >= 12 ? 'PM' : 'AM'}`;
}

// Clock format follows the user setting (12-hour default)
function formatClock(ts) {
  return settings.clock === '24' ? formatTimeHHMM(ts) : formatTime12(ts);
}

function formatDuration(totalMins) {
  if (totalMins < 60) return `${totalMins} min`;
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins > 0 ? `${hrs}hr ${mins}min` : `${hrs}hr`;
}

function resolveEpgId(tvgId) {
  if (!tvgId) return null;
  if (epgData.has(tvgId)) return tvgId;
  return epgIdMap.get(tvgId.toLowerCase()) || null;
}
// XMLTV channels whose tvg-id matches nothing get their guide data by name:
// "BBC One HD" ↔ <display-name>BBC One</display-name>. A channel with a tvg-id
// is aliased in epgIdMap; one without gets the XMLTV id as its tvgId (its
// favorite key moves with it).
function applyEpgNameFallback(nameMap) {
  if (!nameMap || !nameMap.size || currentPlaylistType !== 'm3u') return 0;
  let n = 0;
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    if (resolveEpgId(ch.tvgId)) continue;
    const cid = nameMap.get(normChannelName(ch.name));
    if (!cid || !epgData.has(cid)) continue;
    if (ch.tvgId)
      epgIdMap.set(ch.tvgId.toLowerCase(), cid);
    else {
      ch.tvgId = cid;
      ch.tvgIdFromName = true;  // replaceChannelList keeps this tvgId
    }
    n++;
  }
  if (n)
    buildChannelIndexMap();  // search cache and EPG lookups follow the new
                             // tvgIds
  return n;
}

function getCurrentProgramme(tvgId) {
  const progs = epgProgsOf(tvgId);
  if (!progs || !progs.length) return null;
  const now = Date.now();
  const idx = _epgBinarySearch(progs, now);
  if (idx === -1) return null;
  const p = progs[idx];
  return p.stop > now ? p : null;
}

function getNextProgramme(tvgId) {
  const progs = epgProgsOf(tvgId);
  if (!progs || !progs.length) return null;
  const now = Date.now();
  const idx = _epgBinarySearch(progs, now);
  const nextIdx = idx + 1;
  return nextIdx < progs.length ? progs[nextIdx] : null;
}

// The parser streams the file, thus the size of the file is not the memory
// limit. The kept programs are the memory. These 2 limits stop a very large
// file. When a limit stops the parse, the toast and the log tell you.
const EPG_M3U_MAX_BYTES = 200 * 1048576;
const EPG_M3U_MAX_PROGS = 150000;
async function loadEPG(url) {
  if (epgLoading) return;
  epgLoading = true;
  if (_epgAbortController) _epgAbortController.abort();
  _epgAbortController = new AbortController();
  // Parse into fresh maps and swap them in on success, so a background
  // refresh never blanks the existing guide while it downloads.
  const newData = new Map();
  const newIdMap = new Map();
  const newNameMap = new Map();  // normalised <display-name> → channel id, for
                                 // channels whose tvg-id matches nothing
  currentEpgUrl = url;

  const decoder = new TextDecoder('utf-8');
  // cursor tracks how far into `buffer` we've processed; we only slice the
  // string once per 64 KB consumed rather than once per element, which avoids
  // the O(n²) string-copy behaviour that exhausts memory on large feeds.
  let buffer = '';
  let cursor = 0;
  let programmeCount = 0;
  let bytesRead = 0;
  let cut = '';          // why the parse stopped before the end of the file
  let elementCount = 0;  // all <programme> elements, for the yields
  const now = Date.now();
  const windowStart = now - 120000;
  const windowEnd = now + 6 * 3600000;  // 6h

  showEPGToast('Downloading EPG data …', 'loading');
  try {
    const response = await fetch(url, {signal: _epgAbortController.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > EPG_M3U_MAX_BYTES) {
        cut = `${Math.round(EPG_M3U_MAX_BYTES / 1048576)} MB limit`;
        reader.cancel();
        break;
      }

      // Drop already-processed portion before appending — one slice per chunk
      // instead of one slice per element.
      if (cursor > 65536) {
        buffer = buffer.slice(cursor);
        cursor = 0;
      }
      buffer += decoder.decode(value, {stream: true});

      // Extract complete <channel> elements (always before <programme> in
      // XMLTV)
      let idx;
      while ((idx = buffer.indexOf('</channel>', cursor)) !== -1) {
        const s = buffer.lastIndexOf('<channel', idx);
        if (s !== -1 && s >= cursor) {
          const xml = buffer.substring(s, idx + 10);
          const idM = _RE_CHAN_ID.exec(xml);
          const nmM = _RE_DISP_NAME.exec(xml);
          if (idM) {
            // Each kept string is a copy (copyStr), else it keeps a part of
            // the download in memory
            const cid = copyStr(idM[1]);
            newIdMap.set(cid.toLowerCase(), cid);
            if (nmM) {
              newIdMap.set(copyStr(nmM[1].toLowerCase().trim()), cid);
              const nn = normChannelName(unescapeXml(nmM[1]));
              if (nn && !newNameMap.has(nn)) newNameMap.set(copyStr(nn), cid);
            }
          }
        }
        cursor = idx + 10;
      }

      // Extract complete <programme> elements
      while ((idx = buffer.indexOf('</programme>', cursor)) !== -1) {
        const s = buffer.lastIndexOf('<programme', idx);
        if (s !== -1 && s >= cursor) {
          const xml = buffer.substring(s, idx + 12);
          const chM = _RE_CHAN_ATTR.exec(xml);
          const stM = _RE_START_ATTR.exec(xml);
          const spM = _RE_STOP_ATTR.exec(xml);
          const tiM = _RE_TITLE_TAG.exec(xml);
          if (chM && stM) {
            let pStart = parseXMLTVDate(stM[1]);
            let pStop = spM ? parseXMLTVDate(spM[1]) : null;
            if (pStart !== null && _epgShiftOn) {
              pStart = epgShiftTime(pStart);
              if (pStop !== null) pStop = epgShiftTime(pStop);
            }
            if (pStart !== null && pStart <= windowEnd &&
                (pStop === null || pStop >= windowStart)) {
              const cid = chM[1];
              if (!newData.has(cid)) {
                const k = copyStr(cid);
                newData.set(k, []);
                newIdMap.set(k.toLowerCase(), k);
              }
              newData.get(cid).push({
                start: pStart,
                stop: pStop || 0,
                title: tiM ? copyStr(unescapeXml(tiM[1].trim())) : ''
              });
              programmeCount++;
              if (programmeCount >= EPG_M3U_MAX_PROGS) {
                cut = `${EPG_M3U_MAX_PROGS.toLocaleString()} programs limit`;
                break;
              }
            }
          }
        }
        cursor = idx + 12;

        // Yield inside the loop so GC can run between elements
        // Count each element, also an element out of the window. Before, the
        // count of kept programs stayed at a multiple of 128 for the elements
        // out of the window, and each of these elements yielded.
        if (++elementCount % 512 === 0) {
          const _progMsg = `${(bytesRead / 1048576).toFixed(1)} MB — ${
              programmeCount.toLocaleString()} programs …`;
          statusArea.innerText = `📅 EPG: ${_progMsg}`;
          showEPGToast(_progMsg, 'loading');
          await new Promise(r => setTimeout(r, 0));
          // Re-trim after yield so resumed work starts on a small buffer
          if (cursor > 65536) {
            buffer = buffer.slice(cursor);
            cursor = 0;
          }
        }
      }

      if (cut) {
        reader.cancel();
        break;
      }
      // Safety: if a single element is pathologically large, discard to cursor
      if (buffer.length - cursor > 1048576) {
        const trim = Math.max(
            buffer.lastIndexOf('<programme', buffer.length),
            buffer.lastIndexOf('<channel', buffer.length));
        if (trim > cursor) {
          buffer = buffer.slice(trim);
          cursor = 0;
        } else {
          buffer = buffer.slice(cursor);
          cursor = 0;
        }
      }
    }

    // Sort each channel's programme list chronologically for fast lookup
    for (const progs of newData.values()) {
      progs.sort((a, b) => a.start - b.start);
    }
    epgData = newData;
    epgIdMap = newIdMap;
    _epgLoadedAt = Date.now();
    const byName = applyEpgNameFallback(newNameMap);

    renderChannelList();
    updateNowNext();
    startEpgTick();
    perfMark('xmltv-ready');

    const mb = (bytesRead / 1048576).toFixed(1);
    const readyMsg = `${epgData.size.toLocaleString()} channels, ${
        programmeCount.toLocaleString()} programs (${mb} MB)${
        byName ? `, ${byName.toLocaleString()} matched by name` :
                 ''}${cut ? ` · file cut at the ${cut}` : ''}`;
    if (cut) diagLog(`XMLTV (M3U): the parse stopped at the ${cut}`);
    statusArea.innerText = `📅 EPG ready — ${readyMsg}`;
    showEPGToast(readyMsg, 'success');
    hideEPGToast(3500);
    setTimeout(() => {
      if (currentChannelIndex >= 0)
        statusArea.innerText = `▶️ ${channels[currentChannelIndex].name}`;
    }, 4000);

  } catch (err) {
    statusArea.innerText = `⚠️ EPG failed: ${err.message}`;
    showEPGToast(err.message, 'error');
    hideEPGToast(7000);
    setTimeout(() => {
      if (currentChannelIndex >= 0)
        statusArea.innerText = `▶️ ${channels[currentChannelIndex].name}`;
    }, 3000);
  } finally {
    epgLoading = false;
    _epgAbortController = null;
    buffer = null;
  }
}

function updateNowNext() {
  const panel = document.getElementById('epgNowNext');
  if (!panel) return;
  if (currentChannelIndex < 0 || !channels[currentChannelIndex]) {
    panel.style.display = 'none';
    return;
  }
  const ch = channels[currentChannelIndex];
  const nowProg = getCurrentProgramme(ch.tvgId);
  const nextProg = getNextProgramme(ch.tvgId);
  if (!nowProg && !nextProg) {
    panel.style.display = 'none';
    return;
  }

  let html = '';
  if (nowProg) {
    const pct = (nowProg.stop && nowProg.stop > nowProg.start) ?
        Math.min(
            100,
            Math.max(
                0,
                (Date.now() - nowProg.start) / (nowProg.stop - nowProg.start) *
                    100)) :
        0;
    const timeStr = nowProg.stop ?
        formatClock(nowProg.start) + '–' + formatClock(nowProg.stop) :
        formatClock(nowProg.start);
    html +=
        `<div class="epg-row epg-now"><span class="epg-badge">NOW</span><span class="epg-title">${
            escapeHtml(nowProg.title)}</span><span class="epg-time">${
            timeStr}</span></div>`;
    html +=
        `<div class="epg-progress-bar"><div class="epg-progress-fill" style="width:${
            pct.toFixed(1)}%"></div></div>`;
  }
  if (nextProg) {
    html +=
        `<div class="epg-row epg-next"><span class="epg-badge epg-badge-next">NEXT</span><span class="epg-title epg-title-next">${
            escapeHtml(nextProg.title)}</span><span class="epg-time">${
            formatClock(nextProg.start)}</span></div>`;
  }
  panel.innerHTML = html;
  panel.style.display = 'block';
}

// Virtual scrolling globals
let renderedItems = new Map();
let currentFilteredChannels = [];
let currentScrollListener = null;
