// Headless end-to-end checks for IPTV Ultra against the mock Xtream server.
const puppeteer = require('puppeteer-core');
const BASE = 'http://localhost:8765';
const results = [];
const check = (name, ok, info = '') => {
  results.push({name, ok, info});
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Rewind into the archive: Left in the live player of an archive channel
// continues in the archive. The suite has the buffer Off (the <video> element
// without hls.js), so the archive starts 10 s behind live. The mock clip is
// only some seconds long, so a seek into the archive ends it immediately, and
// the app goes back to live. Thus, the test records the call of startCatchup
// and examines that record. The live player must show channel 50 (3-day
// archive).
async function rewindIntoArchiveTests(page) {
  const leftEvent = type => page.evaluate(type => {
    const ev = new KeyboardEvent(
        type, {key: 'ArrowLeft', keyCode: 37, bubbles: true, cancelable: true});
    Object.defineProperty(ev, 'keyCode', {get: () => 37});
    document.dispatchEvent(ev);
  }, type);
  const leftKey = async holdMs => {
    await leftEvent('keydown');
    await sleep(holdMs);
    await leftEvent('keyup');
  };
  await page.evaluate(() => {
    window.__archive = null;
    const orig = startCatchup;
    startCatchup = function(chIdx, prog, startAt) {
      window.__archive = {
        at: Date.now(),
        start: prog.start,
        stop: prog.stop,
        startAt,
        url: catchupUrl(channels[chIdx], prog),
        player: livePlayer.active
      };
      return orig.apply(this, arguments);
    };
  });
  const archiveCall = () => page.evaluate(() => {
    const a = window.__archive;
    window.__archive = null;
    return a;
  });
  const isArchive = a => !!a && a.player && Math.abs(a.stop - a.at) < 2000 &&
      a.at - (a.start + a.startAt * 1000) >= 9000 &&
      a.at - (a.start + a.startAt * 1000) < 12000 &&
      /\/timeshift\/user\/pass\/\d+\/[\d:-]+\/50\.ts$/.test(a.url);
  await sleep(300);
  await leftKey(50);
  await sleep(100);
  const ra1 = await archiveCall();
  check(
      'a short press of Left in the live player of an archive channel continues in the archive, 10 s behind live',
      isArchive(ra1), JSON.stringify(ra1));
  await page.evaluate(() => catchupBackToLive());
  await sleep(300);
  await leftKey(await page.evaluate(() => HOLD_THRESHOLD_MS + 200));
  await sleep(100);
  const ra2 = await archiveCall();
  check(
      'a hold of Left in the live player of an archive channel also continues in the archive',
      isArchive(ra2), JSON.stringify(ra2));
  await page.evaluate(() => catchupBackToLive());
  await sleep(300);
}
const stats = async () => (await fetch(BASE + '/__stats')).json();

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: [
      '--window-size=1920,1080', '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      // Keep the page active when the screen of the PC locks
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ],
    defaultViewport: {width: 1920, height: 1080},
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => {
    errors.push('pageerror: ' + e.message);
    // The number of the last check tells where the error occurred
    console.log(`PAGEERROR after check ${results.length}: ${e.message} ${
        (e.stack || '').slice(0, 400)}`);
  });
  page.on('console', m => {
    if (m.type() === 'error' &&
        !/net::|404|Failed to load resource|MEDIA|PalmServiceBridge/.test(
            m.text()))
      errors.push('console: ' + m.text());
  });
  const channelsName = () => 'Channel ';
  // OK is pressed and released (guide and channel-list rows act on release; a
  // long press opens Versions)
  const key = (k, kc) => page.evaluate((k, kc) => {
    const ev = new KeyboardEvent(
        'keydown', {key: k, keyCode: kc, bubbles: true, cancelable: true});
    Object.defineProperty(ev, 'keyCode', {get: () => kc});
    document.dispatchEvent(ev);
    if (kc === 13) {
      const up = new KeyboardEvent(
          'keyup', {key: k, keyCode: kc, bubbles: true, cancelable: true});
      Object.defineProperty(up, 'keyCode', {get: () => kc});
      document.dispatchEvent(up);
    }
  }, k, kc);
  const back = () => key('GoBack', 461);
  // Real mouse and keyboard input through CDP sometimes does not reach the
  // page in headless Chrome on Windows (seen on 2026-10-24, probably when the
  // screen of the PC locks). Thus, the suite uses script events. typeText()
  // sends keydown to the focused element and adds the character only when no
  // handler prevents it, as a browser does.
  const typeText = text => page.evaluate(text => {
    for (const ch of text) {
      const el = document.activeElement || document.body;
      // Letters, digits, and space have their key codes. Other characters get
      // 0, because their character codes are the codes of keys such as the
      // arrows (for example, '(' is 40, ArrowDown).
      const kc = /[a-z0-9 ]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0;
      const ev = new KeyboardEvent(
          'keydown', {key: ch, bubbles: true, cancelable: true});
      Object.defineProperty(ev, 'keyCode', {get: () => kc});
      el.dispatchEvent(ev);
      if (!ev.defaultPrevented && 'value' in el) {
        el.value += ch;
        el.dispatchEvent(new InputEvent(
            'input', {bubbles: true, data: ch, inputType: 'insertText'}));
      }
      el.dispatchEvent(new KeyboardEvent('keyup', {key: ch, bubbles: true}));
    }
  }, text);
  const click = sel => page.$eval(sel, el => el.click());

  await fetch(BASE + '/__reset');  // server may have been running across runs
  await page.goto(BASE + '/', {waitUntil: 'load'});
  // The mock server has no HLS content, so the suite runs live TV on the native
  // path (rewind buffer Off); the hls.js engine selection and its native
  // fallback are checked explicitly below.
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem(
        'iptv_settings', JSON.stringify({liveBuffer: 0, schema: 3}));
  });
  await page.reload({waitUntil: 'load'});
  check(
      'webOS library loaded',
      await page.evaluate(
          () => typeof webOS !== 'undefined' && !!webOS.platformBack));
  check(
      'hls.js loaded; live engine stays native while the rewind buffer is Off',
      await page.evaluate(
          () => typeof Hls !== 'undefined' && Hls.isSupported() &&
              settings.liveBuffer === 0 && !hlsAvailable() &&
              isHlsUrl('http://x/live/u/p/1.m3u8') &&
              isHlsUrl('http://x/get.php?type=m3u8') &&
              !isHlsUrl('http://x/live/u/p/1.ts') &&
              LIVE_BUFFER_OPTIONS.some(o => o.v === 5)));

  // ---------- Xtream: add + load ----------
  for (const [sel, text] of [
           ['#xtreamServer', BASE], ['#xtreamUsername', 'user'],
           ['#xtreamPassword', 'pass']]) {
    await page.focus(sel);
    await typeText(text);
  }
  await click('#saveXtreamBtn');
  await page.waitForSelector('.saved-item', {timeout: 5000});
  // Pre-seed two favorites so the prefetch path runs (tvgIds ch3.test,
  // ch4.test)
  await page.evaluate(() => {
    favoriteIds.add('ch3.test');
    favoriteIds.add('ch4.test');
    localStorage.setItem('iptv_favorites', JSON.stringify([...favoriteIds]));
  });
  await click('.saved-item');
  await click('#loadSelectedBtn');
  await page.waitForFunction(
      () => document.getElementById('epgView').style.display === 'flex' &&
          epgRenderedRows.size > 0,
      {timeout: 30000});
  const t0 = Date.now();
  await sleep(2500);
  let s = await stats();
  const rendered = await page.evaluate(() => epgRenderedRows.size);
  check(
      'subtitles do not turn on automatically by default (Settings toggle off, language English)',
      await page.evaluate(
          () => settings.subAuto === false && settings.subLang === 'en' &&
              !SUB_LANG_OPTIONS.some(o => o.v === 'off') &&
              settingsRows().some(r => r.id === 'subAuto')));
  await page.evaluate(() => {
    settingsRows().find(r => r.id === 'subAuto').set(true);
  });  // the remaining checks exercise the auto-on path
  check(
      'guide opened with lazy EPG (requests ≈ favorites + visible rows)',
      s.epg_requests > 0 && s.epg_requests <= rendered + 10,
      `requests=${s.epg_requests} renderedRows=${rendered} channels=3000`);
  check(
      'favorites (group) view shows favorite rows',
      await page.evaluate(
          () => currentGroup === 'favorites' &&
              currentFilteredChannels.length === 2));
  check(
      'favorites saved by tvg-id before 3.12 were converted to exact channels (stream ids) for this playlist',
      await page.evaluate(
          () => [...favoriteIds].join() === 's:3,s:4' &&
              JSON.parse(localStorage.getItem(
                  'iptv_playlist_state'))[_activePlaylistKey]
                      .favs.join() === 's:3,s:4'),
      await page.evaluate(() => [...favoriteIds].join()));
  // Manage favorites: order follows the Set; the manager reorders / removes /
  // restores
  await page.evaluate(() => {
    openCatsManager('favs');
    catsMove(1);
  });
  check(
      'Manage favorites: Right moves the focused favorite down and the Favorites group follows the new order',
      await page.evaluate(() => {
        renderChannelList();
        return catsOpen && catsMode === 'favs' &&
            [...favoriteIds].slice(0, 2).join() === 's:4,s:3' &&
            currentFilteredChannels[0].tvgId === 'ch4.test' &&
            catsFocus === 1 &&
            /Channel 00003/.test(
                document.querySelector('.cats-row.focused .settings-name')
                    .textContent);
      }),
      await page.evaluate(() => [...favoriteIds].join()));
  await page.evaluate(() => catsToggleHidden());
  check(
      'OK removes the focused favorite but keeps it listed (struck through) for undo',
      await page.evaluate(
          () => !favoriteIds.has('s:3') && _catsNames.includes('s:3') &&
              document.querySelector('.cats-row.focused')
                  .classList.contains('cats-hidden')));
  await page.evaluate(() => catsToggleHidden());
  check(
      'OK again restores it in place',
      await page.evaluate(
          () => [...favoriteIds].slice(0, 2).join() === 's:4,s:3' &&
              !document.querySelector('.cats-row.focused')
                   .classList.contains('cats-hidden')));
  await back();
  await sleep(200);
  check(
      'Back closes the favorites manager; the guide lists favorites in the new order',
      await page.evaluate(
          () => !catsOpen &&
              currentFilteredChannels.map(c => c.tvgId).join() ===
                  'ch4.test,ch3.test' &&
              JSON.parse(localStorage.getItem(
                  'iptv_playlist_state'))[_activePlaylistKey]
                      .favs.join() === 's:4,s:3'));
  const loadedBlocks = await page.evaluate(
      () => document.querySelectorAll('#epgBody .epg-prog-block').length);
  check(
      'visible rows received programme blocks', loadedBlocks > 0,
      `blocks=${loadedBlocks}`);
  check(
      'info panel shows programme for playing channel',
      await page.evaluate(
          () =>
              /Show/.test(document.getElementById('epgInfoTitle').textContent)),
      await page.evaluate(
          () => document.getElementById('epgInfoTitle').textContent));
  check(
      'prefetch toast finished',
      await page.evaluate(() => !_epgPrefetchActive && !_epgQueue.length));

  // Switch to All Channels and scroll with D-pad
  await page.evaluate(() => {
    document.querySelectorAll('.group-item')[1].click();
  });
  await page.waitForFunction(
      () => currentGroup === 'all' && epgRenderedRows.size > 5);
  await sleep(600);
  await fetch(BASE + '/__reset');
  for (let i = 0; i < 40; i++) await key('ArrowDown', 40);
  await sleep(800);
  s = await stats();
  const focus = await page.evaluate(() => epgFocusedRowIdx);
  check('D-pad Down moves EPG focus 40 rows', focus === 40, `focus=${focus}`);
  check(
      'scrolling 40 rows fetched a bounded number of EPGs',
      s.epg_requests > 0 && s.epg_requests < 70, `requests=${s.epg_requests}`);
  const focusedVisible = await page.evaluate(() => {
    const el = epgRenderedRows.get(epgFocusedRowIdx);
    return !!el && el.classList.contains('epg-focused');
  });
  check(
      'focused row is rendered and highlighted after scrolling',
      focusedVisible);

  // ---------- Catch-up: archive channel, programme cursor into the past, OK
  // plays the timeshift stream ----------
  await page.evaluate(() => {
    epgFocusedRowIdx = 49;
    updateEPGRowFocus();
  });  // Channel 00050: 3-day archive in the mock
  await page.waitForFunction(() => epgData.has('ch50.test'), {timeout: 10000})
      .catch(() => {});
  await sleep(200);
  const win = await page.evaluate(
      () => ({
        past: epgPastHours(),
        winH: EPG_WIN_HOURS,
        archive: currentFilteredChannels[49].archive,
        num: currentFilteredChannels[49].num,
        dayLabels: document.querySelectorAll('.epg-day-label').length,
        cursor: !!document.querySelector(
            '.epg-row.epg-focused .epg-block-focused.now-playing')
      }));
  check(
      'guide window spans 72 h back for a playlist with archive channels; day labels; cursor on the current programme',
      win.past === 72 && win.winH === 78 && win.archive === 3 &&
          win.num === 50 && win.dayLabels >= 3 && win.cursor,
      JSON.stringify(win));
  await key('ArrowLeft', 37);
  await key('ArrowLeft', 37);
  await sleep(100);
  await page
      .waitForFunction(
          () => _epgFullFetched.has('ch50.test') &&
              (epgData.get('ch50.test') || []).some(p => p.hasArchive === true),
          {timeout: 10000})
      .catch(() => {});
  await sleep(150);
  const cur = await page.evaluate(() => {
    const p = epgFocusedProg();
    const b = document.querySelector('.epg-row.epg-focused .epg-block-focused');
    return {
      past: !!p && p.stop <= Date.now(),
      catchup: !!b && b.classList.contains('catchup'),
      hist: (epgData.get('ch50.test') || [])
                .filter(p => p.stop <= Date.now())
                .length,
      x: _epgX
    };
  });
  check(
      'Left moves the programme cursor into the past; history arrives from get_simple_data_table; block marked as catch-up',
      cur.past && cur.catchup && cur.hist > 10, JSON.stringify(cur));
  await key('Enter', 13);
  await sleep(400);
  const cu = await page.evaluate(
      () => ({
        active: !!catchup,
        player: livePlayer.active,
        src: videoPlayer.getAttribute('src') || '',
        title: document.getElementById('vodOsdTitle').textContent,
        btn: player.btns.map(b => b.id).join(),
        tz: _xt.tz,
        pos: document.getElementById('vodTimePos').textContent
      }));
  check(
      'OK on a past programme plays the provider timeshift stream in the live player, banner in catch-up mode',
      cu.active && cu.player &&
          /\/timeshift\/user\/pass\/30\/\d{4}-\d{2}-\d{2}:\d{2}-\d{2}\/50\.ts$/
              .test(cu.src) &&
          /Catch-up/.test(cu.title) && /^live,/.test(cu.btn) &&
          cu.tz === 'Europe/Amsterdam' && /^\d+:\d{2}$/.test(cu.pos),
      JSON.stringify(cu));
  const tsStats = await stats();
  check(
      'timeshift stream was requested from the provider',
      tsStats.timeshift_requests >= 1 &&
          /\/timeshift\//.test(tsStats.last_timeshift || ''),
      JSON.stringify(
          {n: tsStats.timeshift_requests, last: tsStats.last_timeshift}));
  await page.evaluate(() => catchupBackToLive());
  await sleep(300);
  check(
      'Back to live returns to the channel\'s live stream',
      await page.evaluate(
          () => !catchup &&
              /\/live\/user\/pass\/50\.m3u8$/.test(
                  videoPlayer.getAttribute('src') || '') &&
              currentChannelIndex ===
                  getChannelIndex(currentFilteredChannels[49])));
  await rewindIntoArchiveTests(page);
  await back();
  await back();
  await sleep(200);  // banner, then leave the player
  check(
      'left the player after catch-up; guide visible',
      await page.evaluate(() => !livePlayer.active && epgMode));

  // ---------- EPG timezone (per playlist): corrects loaded data per programme
  // (DST-aware); cache and catch-up stay in provider time ----------
  const off = await page.evaluate(async () => {
    const ch = currentFilteredChannels[49],
          past = epgData.get('ch50.test').find(p => p.hasArchive === true);
    const before = {start: past.start, url: catchupUrl(ch, past)};
    const rows = () => settingsRows(),
          row = id => rows().find(r => r.id === id);
    const dstBefore = row('epgDst').disabled;
    row('epgTz').set(
        'America/New_York');  // provider wrote New York wall-clock into UTC
                              // fields: true time = listed − (−4 or −5 h)
    const nyNow = tzOffsetMin(
        'America/New_York',
        before.start);  // −240 or −300 depending on the date
    const auto = {
      delta: past.start - before.start,
      want: -nyNow * 60000,
      url: catchupUrl(ch, past),
      dstEnabled: !row('epgDst').disabled,
      label: row('epgTz').options.find(o => o.v === 'America/New_York').label,
      n: row('epgTz').options.length
    };
    row('epgDst').set('std');
    const std = past.start - before.start;
    row('epgDst').set('dst');
    const dst = past.start - before.start;
    row('epgExtra').set(30);
    const extra = past.start - before.start;
    const saved = JSON.parse(
        localStorage.getItem('iptv_playlist_state'))[_activePlaylistKey];
    // A fetch made while the correction is on must land corrected in epgData
    // but be cached in provider time
    _epgFullFetched.delete('ch50.test');
    await fetchXtreamEpgFull('ch50.test');
    flushEpgPersist();
    await new Promise(r => setTimeout(r, 300));
    const cached =
        ((await cacheGetPrefix('epg', _activePlaylistKey + '|ch50.test'))[0] ||
         {
           v: {progs: []}
         }).v.progs;
    const live = epgData.get('ch50.test');
    const cacheProviderTime = cached.length === live.length &&
        cached.every(
            (p, i) => p.start === live[i].start - (4 * 60 + 30) * 60000 &&
                p.stop === live[i].stop - (4 * 60 + 30) * 60000);
    const refetchedUrl = catchupUrl(ch, live.find(p => p.start === past.start));
    row('epgExtra').set(0);
    row('epgDst').set('auto');
    row('epgTz').set('');
    return {
      before,
      dstBefore,
      auto,
      std,
      dst,
      extra,
      saved: {tz: saved.epgTz, dst: saved.epgDst, extra: saved.epgOffset},
      cacheProviderTime,
      refetchedUrl,
      cachedN: cached.length,
      liveN: live.length,
      restored: epgData.get('ch50.test').some(p => p.start === before.start) &&
          !_epgShiftOn && row('epgDst').disabled
    };  // `past` itself was replaced by the re-fetch
  });
  check(
      'EPG timezone: New York moves programmes by the zone\'s current offset (auto DST), standard/daylight pin 5 h/4 h, extra adds 30 min, saved per playlist, catch-up URL and EPG cache stay in provider time, reset restores',
      off.dstBefore && off.auto.delta === off.auto.want &&
          (off.auto.want === 4 * 3600000 || off.auto.want === 5 * 3600000) &&
          off.auto.url === off.before.url && off.auto.dstEnabled &&
          /^Eastern \(New York\) · UTC−[45]$/.test(off.auto.label) &&
          off.auto.n === 40 && off.std === 5 * 3600000 &&
          off.dst === 4 * 3600000 && off.extra === 4.5 * 3600000 &&
          off.saved.tz === 'America/New_York' && off.saved.dst === 'dst' &&
          off.saved.extra === 30 && off.cacheProviderTime &&
          off.refetchedUrl === off.before.url && off.restored,
      JSON.stringify(off));

  // ---------- Direct channel number entry: digits select the provider channel
  // number ----------
  await key('5', 53);
  await key('1', 49);
  check('digits show in the number overlay', await page.evaluate(() => {
    const o = document.getElementById('chNumOverlay');
    return !!o && o.textContent === '51' && o.classList.contains('typing');
  }));
  await sleep(2300);
  const dig = await page.evaluate(
      () => ({
        idx: currentChannelIndex,
        num: channels[currentChannelIndex] && channels[currentChannelIndex].num,
        name:
            channels[currentChannelIndex] && channels[currentChannelIndex].name,
        focus: epgFocusedRowIdx,
        overlay: document.getElementById('chNumOverlay').textContent
      }));
  check(
      'after 2 s the typed number selects provider channel 51 and moves the guide cursor there',
      dig.num === 51 && dig.name === 'Channel 00051' && dig.focus === 50 &&
          /51/.test(dig.overlay),
      JSON.stringify(dig));
  await key('9', 57);
  await key('9', 57);
  await key('9', 57);
  await key('9', 57);
  await key('9', 57);
  await sleep(100);
  check(
      'a number with no channel reports it and keeps the current channel',
      await page.evaluate(
          () => /no such channel/.test(
                    document.getElementById('chNumOverlay').textContent) &&
              channels[currentChannelIndex].num === 51));

  // ---------- Search also matches what is on now (programme titles from loaded
  // EPG) ----------
  await page.evaluate(() => {
    const si = document.getElementById('epgSearchInput');
    si.value = 'Show 3-1';
    si.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await sleep(400);
  const srch = await page.evaluate(
      () => ({
        n: currentFilteredChannels.length,
        first: currentFilteredChannels[0] && currentFilteredChannels[0].name,
        prog: (getCurrentProgramme('ch3.test') || {}).title
      }));
  check(
      'searching a programme title finds the channel airing it now',
      srch.first === 'Channel 00003' && srch.prog === 'Show 3-1',
      JSON.stringify(srch));
  await page.evaluate(() => {
    document.getElementById('epgClearSearchBtn').click();
  });
  await sleep(300);

  // ---------- Categories manager: hide and reorder, persisted per playlist
  // ----------
  await page.evaluate(() => {
    settingsRows().find(r => r.id === 'manageCats').run();
  });
  check(
      'Manage categories opens with the groups of the playlist',
      await page.evaluate(
          () => catsOpen &&
              !document.getElementById('catsOverlay')
                   .classList.contains('hidden') &&
              document.querySelectorAll('#catsList .cats-row').length === 30));
  await key('Enter', 13);  // hide the focused (first) group
  await key('ArrowDown', 40);
  await key('ArrowRight', 39);  // move the second group one step down
  const catsSt = await page.evaluate(
      () => ({
        hidden: [..._hiddenGroups],
        order: _groupOrder.slice(0, 3),
        saved: getPlaylistState(_activePlaylistKey).hiddenGroups
      }));
  await back();
  await sleep(300);
  const catsAfter = await page.evaluate(
      () => ({
        open: catsOpen,
        groups: groupsList.slice(0, 4),
        hiddenInAll: currentGroup === 'all' &&
            currentFilteredChannels.some(ch => ch.group === 'Group 01'),
        total: currentFilteredChannels.length
      }));
  check(
      'hidden group leaves the list and All Channels; order change applied and saved',
      catsSt.hidden.length === 1 && catsSt.hidden[0] === 'Group 01' &&
          catsSt.saved[0] === 'Group 01' && catsSt.order[0] === 'Group 01' &&
          catsSt.order[1] === 'Group 03' && catsSt.order[2] === 'Group 02' &&
          !catsAfter.open && !catsAfter.groups.includes('Group 01') &&
          catsAfter.groups[2] === 'recent' &&
          catsAfter.groups[3] === 'Group 03' && !catsAfter.hiddenInAll &&
          catsAfter.total === 2900,
      JSON.stringify({catsSt, catsAfter}));
  await page.evaluate(() => {
    openCatsManager();
    catsFocus = 0;
    catsToggleHidden();
    closeCatsManager();
  });  // restore for the rest of the suite
  await sleep(300);
  check(
      'unhiding restores the group and its channels',
      await page.evaluate(
          () => groupsList.includes('Group 01') &&
              currentFilteredChannels.length === 3000));

  await page.evaluate(() => {
    epgFocusedRowIdx = 40;
    epgFocusT = 0;
    updateEPGRowFocus();
  });
  await sleep(200);
  // Enter on a scrolled row must select that channel (old DOM-index lookup
  // broke this)
  const before = await page.evaluate(() => currentChannelIndex);
  await key('Enter', 13);
  await sleep(300);
  const after = await page.evaluate(
      () => ({
        idx: currentChannelIndex,
        expected: getChannelIndex(currentFilteredChannels[epgFocusedRowIdx])
      }));
  check(
      'Enter on scrolled EPG row selects that channel',
      after.idx === after.expected && after.idx !== before,
      `before=${before} after=${after.idx} expected=${after.expected}`);
  // Enter again on the playing row → the app-owned live player
  check(
      'video element has no native controls',
      await page.evaluate(() => !videoPlayer.hasAttribute('controls')));
  await key('Enter', 13);
  await sleep(300);
  const lp = await page.evaluate(
      () => ({
        active: livePlayer.active,
        visible:
            !document.getElementById('vodPlayer').classList.contains('hidden'),
        slot: videoPlayer.parentNode.id,
        title: document.getElementById('vodOsdTitle').textContent,
        osd: document.getElementById('vodOsd').classList.contains('visible'),
        btns: player.btns.map(b => b.id).join(),
        idx: currentChannelIndex,
        pos: document.getElementById('vodTimePos').textContent
      }));
  check(
      'Enter on the playing row opens the live player: video stays in its slot, stretched; banner shown',
      lp.active && lp.visible && lp.slot === 'epgVideoWrap' &&
          lp.title.includes(channelsName(lp.idx)) && lp.osd &&
          lp.btns === 'cc,guide,settings' && lp.idx === after.idx,
      JSON.stringify(lp));
  const geo = await page.evaluate(() => {
    const r = videoPlayer.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      pos: getComputedStyle(videoPlayer).position,
      bodyCls: document.body.classList.contains('live-player'),
      playerBg: getComputedStyle(document.getElementById('vodPlayer'))
                    .backgroundColor,
      t: videoPlayer.currentTime
    };
  });
  check(
      'live video is full-viewport in place under a transparent overlay',
      geo.x === 0 && geo.y === 0 && geo.w === 1920 && geo.h === 1080 &&
          geo.pos === 'fixed' && geo.bodyCls &&
          /rgba\(0, 0, 0, 0\)/.test(geo.playerBg),
      JSON.stringify(geo));
  check(
      'live banner shows the current programme time range from the EPG',
      /\d{1,2}:\d{2}(AM|PM) – \d{1,2}:\d{2}(AM|PM)/.test(lp.pos) ||
          lp.pos === 'LIVE',
      lp.pos);
  await key('ChannelUp', 427);
  await sleep(300);
  check(
      'CH+ in the live player zaps and refreshes the banner',
      await page.evaluate(
          idx => currentChannelIndex !== idx && livePlayer.active &&
              document.getElementById('vodOsdTitle')
                  .textContent.includes(channels[currentChannelIndex].name),
          after.idx));
  await key('ChannelDown', 428);
  await sleep(300);
  // Red: previous channel (CH+ went to B, CH- back to A, so the previous
  // channel is B)
  const prevIdx = await page.evaluate(() => lastChannelIndex);
  await key('ColorF0Red', 403);
  await sleep(200);
  check(
      'Red in the live player flips to the previous channel',
      await page.evaluate(
          p => currentChannelIndex === p && livePlayer.active &&
              document.getElementById('vodOsd').classList.contains('visible'),
          prevIdx));
  await key('ColorF0Red', 403);
  await sleep(200);
  check(
      'Red again flips back',
      await page.evaluate(
          p => currentChannelIndex !== p && lastChannelIndex === p, prevIdx));
  // With the banner hidden, the first Up or Down only shows the banner
  await page.evaluate(() => hideVodOsd());
  const playingIdx = await page.evaluate(() => currentChannelIndex);
  await key('ArrowDown', 40);
  await sleep(100);
  check(
      'Down with the banner hidden only shows the banner',
      await page.evaluate(
          p =>
              document.getElementById('vodOsd').classList.contains('visible') &&
              !surf.active && player.focus === 'bar' &&
              currentChannelIndex === p,
          playingIdx));
  await page.evaluate(() => hideVodOsd());
  await key('ArrowUp', 38);
  await sleep(100);
  check(
      'Up with the banner hidden only shows the banner',
      await page.evaluate(
          () =>
              document.getElementById('vodOsd').classList.contains('visible') &&
              !surf.active && player.focus === 'bar'));
  // Hidden OSD: the pointer cannot click its buttons, and a click on the
  // picture only shows the banner
  await page.evaluate(() => hideVodOsd());
  const hiddenClick = await page.evaluate(() => {
    const btn = document.querySelector('#vodOsdBtns .vod-osd-btn');
    const pe = btn ? getComputedStyle(btn).pointerEvents : '';
    const paused = videoPlayer.paused;
    document.getElementById('vodPlayer').click();
    return {
      pe,
      osd: document.getElementById('vodOsd').classList.contains('visible'),
      samePause: videoPlayer.paused === paused
    };
  });
  check(
      'Hidden OSD buttons take no pointer clicks; a click only shows the banner',
      hiddenClick.pe === 'none' && hiddenClick.osd && hiddenClick.samePause,
      JSON.stringify(hiddenClick));
  // Channel surfing: with the banner up and the bar focused, Down previews the
  // next channel in the banner without tuning
  await page.evaluate(() => {
    player.focus = 'bar';
    showVodOsd();
  });
  await key('ArrowDown', 40);
  await sleep(100);
  const sf = await page.evaluate(
      () => ({
        active: surf.active,
        idx: surf.idx,
        playing: currentChannelIndex,
        osd: document.getElementById('vodOsd').classList.contains('visible'),
        cls: document.getElementById('vodOsd').classList.contains('surf'),
        title: document.getElementById('vodOsdTitle').textContent,
        want: currentFilteredChannels[surf.idx] &&
            currentFilteredChannels[surf.idx].name,
        hint: document.getElementById('vodOsdTech').textContent,
        focus: player.focus
      }));
  check(
      'Down on the bar previews the next channel in the banner without tuning',
      sf.active && sf.playing === playingIdx && sf.osd && sf.cls && sf.want &&
          sf.title.includes(sf.want) && /OK watch/.test(sf.hint) &&
          sf.focus === 'bar',
      JSON.stringify(sf));
  await key('ArrowDown', 40);
  await sleep(100);
  check(
      'Down again steps the preview on',
      await page.evaluate(
          (i, p) =>
              surf.active && surf.idx === i + 1 && currentChannelIndex === p,
          sf.idx, playingIdx));
  await back();
  await sleep(100);
  check(
      'Back cancels the preview, hides the banner and leaves the channel alone',
      await page.evaluate(
          p => !surf.active && currentChannelIndex === p &&
              !document.getElementById('vodOsd').classList.contains(
                  'visible') &&
              !document.getElementById('vodOsd').classList.contains('surf'),
          playingIdx));
  await key('ArrowDown', 40);  // shows the banner
  await key('ArrowDown', 40);  // starts the preview
  await sleep(100);
  const surfTarget = await page.evaluate(
      () => surf.active ? getChannelIndex(currentFilteredChannels[surf.idx]) :
                          -1);
  await page.evaluate(() => {
    const d = new KeyboardEvent(
        'keydown', {key: 'Enter', keyCode: 13, bubbles: true});
    Object.defineProperty(d, 'keyCode', {get: () => 13});
    document.dispatchEvent(d);
    const u =
        new KeyboardEvent('keyup', {key: 'Enter', keyCode: 13, bubbles: true});
    Object.defineProperty(u, 'keyCode', {get: () => 13});
    document.dispatchEvent(u);
  });
  await sleep(300);
  check(
      'OK on a previewed channel tunes it and the guide cursor follows',
      await page.evaluate(
          t => t >= 0 && currentChannelIndex === t && !surf.active &&
              livePlayer.active &&
              epgFocusedRowIdx ===
                  currentFilteredChannels.indexOf(channels[t]) &&
              document.getElementById('vodOsd').classList.contains('visible'),
          surfTarget),
      `target=${surfTarget}`);
  check(
      'Recent group is pinned third and lists the channels just watched, newest first; it is a Starting group option',
      await page.evaluate(
          () => groupsList[2] === 'recent' &&
              document.querySelectorAll('#groupsPinned .group-item').length ===
                  3 &&
              recentChannels()[0] === channels[currentChannelIndex] &&
              recentChannels().length >= 3 &&
              settingsRows()
                  .find(r => r.id === 'startGroup')
                  .options.some(o => o.v === 'recent')));
  await key('ArrowUp', 38);
  await sleep(50);
  check(
      'Up focuses CC first in the live player too',
      await page.evaluate(
          () => player.focus === 'buttons' &&
              player.btns[player.btn].id === 'cc'));
  await key('ArrowRight', 39);
  await sleep(50);
  check(
      'Right focuses the Guide button',
      await page.evaluate(
          () => player.focus === 'buttons' &&
              player.btns[player.btn].id === 'guide'),
      await page.evaluate(() => player.btns[player.btn].id));
  await page.evaluate(() => {
    const d = new KeyboardEvent(
        'keydown', {key: 'Enter', keyCode: 13, bubbles: true});
    Object.defineProperty(d, 'keyCode', {get: () => 13});
    document.dispatchEvent(d);
    const u =
        new KeyboardEvent('keyup', {key: 'Enter', keyCode: 13, bubbles: true});
    Object.defineProperty(u, 'keyCode', {get: () => 13});
    document.dispatchEvent(u);
  });
  await sleep(300);
  const lx = await page.evaluate(
      () => ({
        active: livePlayer.active,
        hidden:
            document.getElementById('vodPlayer').classList.contains('hidden'),
        slot: videoPlayer.parentNode.id,
        focusRow: epgFocusedRowIdx,
        playingRow:
            currentFilteredChannels.indexOf(channels[currentChannelIndex]),
        ev: document.getElementById('epgView').style.display
      }));
  check(
      'OK on Guide leaves the player: video back to its panel size, cursor on the playing channel',
      !lx.active && lx.hidden && lx.slot === 'epgVideoWrap' &&
          lx.focusRow === lx.playingRow && lx.ev === 'flex' &&
          await page.evaluate(
              () => !document.body.classList.contains('live-player') &&
                  getComputedStyle(videoPlayer).position !== 'fixed'),
      JSON.stringify(lx));
  // Pointer: a click on the live picture opens the player; Back closes it
  await page.evaluate(
      () =>
          videoPlayer.dispatchEvent(new MouseEvent('click', {bubbles: true})));
  await sleep(200);
  check(
      'a single click on the live picture does nothing',
      await page.evaluate(() => !livePlayer.active));
  await page.evaluate(
      () => videoPlayer.dispatchEvent(
          new MouseEvent('dblclick', {bubbles: true})));
  await sleep(200);
  check(
      'double-clicking the live picture opens the player',
      await page.evaluate(() => livePlayer.active));
  await page.evaluate(() => {
    hideVodOsd();
    document.getElementById('vodPlayer')
        .dispatchEvent(new MouseEvent('mousemove', {bubbles: true}));
  });
  await sleep(100);
  check(
      'moving the pointer in the player does not bring up the OSD',
      await page.evaluate(
          () => !document.getElementById('vodOsd').classList.contains(
              'visible')));
  await page.evaluate(() => {
    showVodOsd();
    const t = vodPlay.osdTimer;
    for (let i = 0; i < 3; i++)
      document.getElementById('vodPlayer')
          .dispatchEvent(new MouseEvent('mousemove', {bubbles: true}));
    window._osdTimerSame = vodPlay.osdTimer === t;
  });
  check(
      'pointer movement does not extend the OSD hide timer either',
      await page.evaluate(() => window._osdTimerSame === true));
  check(
      'pointer movement does not replace the OSD buttons (clicks keep their target)',
      await page.evaluate(() => {
        const before = document.getElementById('vodCcBtn');
        for (let i = 0; i < 5; i++)
          document.getElementById('vodPlayer')
              .dispatchEvent(new MouseEvent('mousemove', {bubbles: true}));
        showVodOsd();
        return before === document.getElementById('vodCcBtn');
      }));
  await page.evaluate(() => document.getElementById('vodCcBtn').click());
  check(
      'pointer click on the CC button opens the tracks menu in the live player',
      await page.evaluate(() => vodTracksOpen()));
  await back();
  await sleep(50);
  await page.evaluate(
      () => document.querySelector('.vod-osd-btn[data-id="guide"]').click());
  await sleep(200);
  check(
      'pointer click on the Guide button leaves the live player',
      await page.evaluate(() => !livePlayer.active));
  await page.evaluate(
      () => videoPlayer.dispatchEvent(
          new MouseEvent('dblclick', {bubbles: true})));
  await sleep(200);
  check(
      'paused icon is the themed bars, not an emoji',
      await page.evaluate(
          () => document.querySelectorAll('#vodPaused .vod-paused-bars i')
                      .length === 2 &&
              !/⏸/.test(document.getElementById('vodPaused').textContent)));
  await back();
  await sleep(100);
  check(
      'Back with the live banner up hides the banner first',
      await page.evaluate(
          () => livePlayer.active &&
              !document.getElementById('vodOsd').classList.contains(
                  'visible')));
  await back();
  await sleep(200);
  check(
      'Back leaves the live player and returns to the guide',
      await page.evaluate(
          () => !livePlayer.active &&
              videoPlayer.parentNode.id === 'epgVideoWrap'));

  // Minute tick: in-place refresh and hour rollover
  const tickOk = await page.evaluate(() => {
    try {
      epgMinuteTick();
      return true;
    } catch (e) {
      return e.message;
    }
  });
  check('minute tick runs without error', tickOk === true, String(tickOk));
  const roll = await page.evaluate(() => {
    const old = _epgSkeletonWinStart;
    _epgSkeletonWinStart = old - 3600000;
    epgMinuteTick();
    return _epgSkeletonWinStart === old && epgRenderedRows.size > 0;
  });
  check('hour rollover rebuilds guide skeleton once', roll);
  const nowLines = await page.evaluate(() => {
    const tm = document.getElementById('epgTimeMarks');
    const line = tm.querySelector('.epg-now-line');
    const before = line.style.left;
    line.style.left = '0px';
    updateEPGNowMarker();
    const expected =
        ((Date.now() - _epgWinStart) / 60000 * EPG_PX_PER_MIN).toFixed(1) +
        'px';
    return {
      before,
      after: line.style.left,
      expected,
      full: document.querySelector('.epg-now-fullmarker').style.left
    };
  });
  check(
      'minute tick moves the time-strip NOW line as well as the tall marker',
      Math.abs(parseFloat(nowLines.after) - parseFloat(nowLines.expected)) <
              0.6 &&
          nowLines.full !== '',
      JSON.stringify(nowLines));
  check(
      'programme blocks carry data-start/stop for tick updates',
      await page.evaluate(() => {
        const b = document.querySelector('#epgBody .epg-prog-block');
        return !!b && !!b.dataset.start && !!b.dataset.stop;
      }));

  // EPG cache TTL: expire one visible channel and make sure it is re-queued
  await fetch(BASE + '/__reset');
  await page.evaluate(() => {
    const ch = currentFilteredChannels[epgFocusedRowIdx];
    const m = _epgFetchMeta.get(ch.tvgId);
    if (m) m.at = 0;
    scheduleEpgFetchForVisible();
  });
  await sleep(700);
  s = await stats();
  check(
      'TTL-expired visible channel is re-fetched (and only it)',
      s.epg_requests === 1, `requests=${s.epg_requests}`);

  // Minute tick must not treat every minute as an hour rollover on a catch-up
  // (72 h) window (regression: guide drifted into the past)
  // The 2 tests use a fixed time in the hour of the skeleton. With the real
  // time, they failed when the hour changed after the skeleton was built.
  const tick = await page.evaluate(() => {
    const realNow = Date.now;
    window.__pinnedNow =
        _epgSkeletonWinStart + epgPastHours() * 3600000 + 1800000;
    Date.now = () => window.__pinnedNow;
    try {
      const x0 = _epgX, s0 = _epgSkeletonWinStart;
      epgMinuteTick();
      epgMinuteTick();
      return {
        x0,
        x1: _epgX,
        s0,
        s1: _epgSkeletonWinStart,
        past: epgPastHours()
      };
    } finally {
      Date.now = realNow;
    }
  });
  check(
      'minute tick keeps the pan and the skeleton when the hour has not rolled over (72 h catch-up window)',
      tick.past === 72 && tick.x1 === tick.x0 && tick.s1 === tick.s0,
      JSON.stringify(tick));
  const hourRoll = await page.evaluate(() => {
    const realNow = Date.now;
    Date.now = () => window.__pinnedNow;
    try {
      const x0 = _epgX;
      _epgSkeletonWinStart -= 3600000;
      epgMinuteTick();
      return {
        x0,
        x1: _epgX,
        px: EPG_PX_PER_MIN * 60,
        rebuilt: _epgSkeletonWinStart ===
            Math.floor((Date.now() - epgPastHours() * 3600000) / 3600000) *
                3600000
      };
    } finally {
      Date.now = realNow;
    }
  });
  check(
      'a real hour rollover shifts the pan by one hour and rebuilds the skeleton once',
      hourRoll.x1 === Math.max(0, hourRoll.x0 - hourRoll.px) &&
          hourRoll.rebuilt,
      JSON.stringify(hourRoll));

  // Empty answers under load: an empty epg_listings never replaces data already
  // held and is retried soon
  const emp = await page.evaluate(async () => {
    const id = [...epgData.keys()].find(
        k => _xtStreamIdByTvgId.has(k) && epgData.get(k).length);
    const before = (epgData.get(id) || []).length;
    const realFetch = window.fetch;
    window.fetch = () => Promise.resolve(new Response(
        '{"epg_listings":[]}',
        {status: 200, headers: {'Content-Type': 'application/json'}}));
    try {
      await fetchXtreamEpgFor(id);
    } finally {
      window.fetch = realFetch;
    }
    const m = _epgFetchMeta.get(id);
    return {
      before,
      after: (epgData.get(id) || []).length,
      status: m.status,
      retryIn: Math.round((m.at + EPG_CACHE_TTL_MS - Date.now()) / 60000)
    };
  });
  check(
      'an empty EPG answer keeps the programmes already held and is retried after ~10 min instead of 2 h',
      emp.before > 0 && emp.after === emp.before && emp.status === 'done' &&
          emp.retryIn >= 9 && emp.retryIn <= 10,
      JSON.stringify(emp));
  await fetch(BASE + '/__reset');
  const sp = await page.evaluate(async () => {
    const ids = currentFilteredChannels
                    .slice(epgFocusedRowIdx + 30, epgFocusedRowIdx + 36)
                    .map(c => c.tvgId)
                    .filter(Boolean);
    ids.forEach(i => _epgFetchMeta.delete(i));
    queueEpgFetch(ids, true);
    const inFlight0 = _epgInFlight;
    await new Promise(r => setTimeout(r, 120));
    return {
      n: ids.length,
      inFlight0,
      limit: EPG_FETCH_CONCURRENCY,
      spacing: EPG_FETCH_SPACING_MS,
      after120: _epgInFlight + (ids.length - _epgQueue.length - _epgInFlight)
    };
  });
  await sleep(900);
  s = await stats();
  check(
      'EPG requests are rate-limited: at most 2 in flight and starts spaced 100 ms apart',
      sp.inFlight0 <= 2 && sp.limit === 2 && sp.spacing === 100 &&
          sp.after120 <= 3 && s.epg_requests === sp.n,
      JSON.stringify(Object.assign(sp, {requests: s.epg_requests})));

  // Search typing in the EPG corner box must not be hijacked by guide
  // navigation
  await page.focus('#epgSearchInput');
  await typeText('Channel 000');
  await sleep(400);
  check(
      'typing in EPG search filters guide (best match first)',
      await page.evaluate(
          () => currentSearchQuery === 'Channel 000' &&
              currentFilteredChannels[0].name === 'Channel 00001' &&
              document.getElementById('epgSearchInput').value ===
                  'Channel 000'),
      await page.evaluate(
          () => currentFilteredChannels.length +
              ' results, first=' + currentFilteredChannels[0].name +
              ' query=' + JSON.stringify(currentSearchQuery) + ' input=' +
              JSON.stringify(document.getElementById('epgSearchInput').value) +
              ' active=' +
              (document.activeElement && document.activeElement.id)));
  await key('ArrowDown', 40);  // leaves the search box
  check(
      'Down leaves the search box',
      await page.evaluate(
          () => document.activeElement !==
              document.getElementById('epgSearchInput')));
  await click('#epgClearSearchBtn');

  // ---------- Dedicated media keys: Play/Pause/CH+/CH- ----------
  {
    const start = await page.evaluate(
        () => ({
          idx: currentChannelIndex,
          pos: currentFilteredChannels.indexOf(channels[currentChannelIndex]),
          len: currentFilteredChannels.length
        }));
    await key('ChannelUp', 427);
    await sleep(200);
    const up = await page.evaluate(
        () => ({
          idx: currentChannelIndex,
          pos: currentFilteredChannels.indexOf(channels[currentChannelIndex]),
          focus: epgFocusedRowIdx
        }));
    check(
        'CH+ steps to the next channel in the on-screen list',
        up.pos === (start.pos + 1) % start.len && up.focus === up.pos,
        `pos ${start.pos} → ${up.pos}`);
    await key('ChannelDown', 428);
    await sleep(200);
    const down = await page.evaluate(() => currentChannelIndex);
    check('CH- steps back', down === start.idx);
    await page.evaluate(() => {
      currentChannelIndex = getChannelIndex(currentFilteredChannels[0]);
    });
    await key('ChannelDown', 428);
    await sleep(200);
    check(
        'CH- wraps from first to last',
        await page.evaluate(
            () => currentFilteredChannels.indexOf(
                      channels[currentChannelIndex]) ===
                currentFilteredChannels.length - 1));
    await key('MediaPause', 19);
    await sleep(100);
    check('Pause key pauses', await page.evaluate(() => videoPlayer.paused));
    await key('MediaPlay', 415);
    await sleep(100);
    check(
        'Play key resumes (play() called)',
        await page.evaluate(
            () => !videoPlayer.paused || videoPlayer.error !== null));
  }

  // ---------- VOD: Movies & Series ----------
  {
    check(
        'mode switch shown for Xtream playlists',
        await page.evaluate(
            () => document.getElementById('modeSwitch').style.display !==
                'none'));
    await key('ColorF3Blue', 406);  // Live → Movies
    await page.waitForFunction(
        () => vodMode === 'movies' && vodNav.screen === 'home' &&
            (vodCats || []).length > 0,
        {timeout: 10000});
    await page.waitForFunction(
        () => !!vodRecent,
        {timeout: 15000});  // background full fetch for Recently Added
    await sleep(200);
    const mv = await page.evaluate(
        () => ({
          vv: document.getElementById('vodView').style.display,
          ev: document.getElementById('epgView').style.display,
          cats: [...document.querySelectorAll('#groupsList .group-item')].map(
              g => g.textContent.trim()),
          recent: document.querySelectorAll('.vod-card[data-pos^="recent:"]')
                      .length,
          paused: videoPlayer.paused
        }));
    check(
        'nothing counts as in progress before 2 min (10% for short items)',
        await page.evaluate(
            () => vodMinResume(7200) === 120 && vodMinResume(20) === 2 &&
                vodMinResume(0) === 120));
    check(
        'Continue Watching ignores entries under the threshold',
        await page.evaluate(() => {
          const k = localStorage.getItem('iptv_last_playlist');
          vodProgress[k + '|m:999001'] = {
            kind: 'movie',
            id: '999001',
            name: 'Short',
            icon: '',
            ext: 'mp4',
            catId: '100',
            pos: 60,
            dur: 7200,
            at: Date.now(),
            watched: false
          };
          vodProgress[k + '|m:999002'] = {
            kind: 'movie',
            id: '999002',
            name: 'Long',
            icon: '',
            ext: 'mp4',
            catId: '100',
            pos: 200,
            dur: 7200,
            at: Date.now(),
            watched: false
          };
          const ids = continueWatchingItems('movies').map(i => i.id);
          delete vodProgress[k + '|m:999001'];
          delete vodProgress[k + '|m:999002'];
          return !ids.includes('999001') && ids.includes('999002');
        }));
    check(
        'settings offer subtitle and audio language rows (default English / Default)',
        await page.evaluate(() => {
          const r = settingsRows();
          const s = r.find(x => x.id === 'subLang'),
                a = r.find(x => x.id === 'audioLang');
          return !!s && !!a && s.get() === 'en' && a.get() === 'default';
        }));
    check(
        'pipeline tracks with auto-on OFF stay off until picked',
        await page.evaluate(() => {
          const saved = settings.subAuto;
          settings.subAuto = false;
          const u = {
            kind: 'vod',
            mediaId: '_probe',
            subTracks: [{trackNum: 0, language: 'en', languageName: 'English'}],
            audioTracks: [],
            selectedSub: 0
          };
          const prev = vodPlay.ums;
          const act = vodPlay.active;
          vodPlay.active = true;
          vodPlay.ums = u;
          vodPlay.subManual = false;
          applyVodTrackPrefs();
          const off = u.selectedSub === -1;
          vodPlay.ums = prev;
          vodPlay.active = act;
          settings.subAuto = saved;
          return off;
        }));
    check(
        'Blue opens Movies home; adult category hidden; live video paused',
        mv.vv === 'flex' && mv.ev === 'none' && mv.cats.length === 5 &&
            !mv.cats.some(c => /adult/i.test(c)) && mv.paused,
        JSON.stringify(mv));
    check(
        'Recently Added row filled from the background catalog fetch',
        mv.recent === 18, `recent=${mv.recent}`);
    // Left → categories, Down to "Action", Enter → grid
    await key('ArrowLeft', 37);
    await key('ArrowDown', 40);
    await key('ArrowDown', 40);
    await key('ArrowDown', 40);
    check(
        'category column focus on Action',
        await page.evaluate(
            () => document.querySelector('.group-item.focused') &&
                document.querySelector('.group-item.focused')
                    .textContent.includes('Action')));
    await fetch(BASE + '/__reset');
    await key('Enter', 13);
    await page.waitForFunction(
        () => vodNav.screen === 'grid' && vodNav.items.length === 60 &&
            vodGridRows.size > 0,
        {timeout: 10000});
    s = await stats();
    check(
        'category grid loads only that category (one request, 60 titles, 6 columns)',
        (s.vod_actions || []).join() === 'get_vod_streams@100' &&
            await page.evaluate(
                () => vodGrid.cols === 6 &&
                    document.querySelectorAll('#vodGridInner .vod-card')
                            .length >= 12 &&
                    document.querySelectorAll('#vodGridInner .vod-card')
                            .length < 60),
        JSON.stringify(s.vod_actions));
    // Sort & genre menu (Green)
    await key('ColorF1Green', 404);
    await sleep(100);
    const so = await page.evaluate(
        () => ({
          open: vodSortOpen,
          shown: !document.getElementById('vodSortOverlay')
                      .classList.contains('hidden'),
          rows: _vodSortRows.length,
          genres: _vodSortRows.filter(r => r.kind === 'genre')
                      .map(r => r.label)
                      .join('|'),
          focus: _vodSortRows[vodSortFocus].v
        }));
    check(
        'Green opens the sort & genre menu with the sort orders and the genres of the list',
        so.open && so.shown && so.rows === 5 + 1 + 3 &&
            /All genres\|Family\|Crime\|Thriller/.test(so.genres) &&
            so.focus === 'default',
        JSON.stringify(so));
    await page.evaluate(() => {
      vodSortFocus =
          _vodSortRows.findIndex(r => r.kind === 'sort' && r.v === 'rating');
      vodSortActivate();
    });
    const sr = await page.evaluate(
        () => ({
          sort: vodNav.sort,
          first: vodNav.items[0].rating,
          last: vodNav.items[vodNav.items.length - 1].rating,
          n: vodNav.items.length,
          hdr: document.getElementById('vodCount').textContent,
          saved: getPlaylistState(_activePlaylistKey).vodSort,
          focus: vodNav.focus
        }));
    check(
        'Rating sorts the grid highest first, shows in the header and is remembered per playlist',
        sr.sort === 'rating' && sr.first >= sr.last && sr.first === 9.9 &&
            sr.n === 60 && /Rating/.test(sr.hdr) && sr.saved === 'rating' &&
            sr.focus === 0,
        JSON.stringify(sr));
    await page.evaluate(() => {
      vodSortFocus =
          _vodSortRows.findIndex(r => r.kind === 'genre' && r.v === 'Family');
      vodSortActivate();
    });
    check(
        'a genre filters the list (Family: 40 of 60) and shows in the header',
        await page.evaluate(
            () => vodNav.genre === 'Family' && vodNav.items.length === 40 &&
                vodNav.items.every(it => /Family/.test(it.genre)) &&
                /Family/.test(
                    document.getElementById('vodCount').textContent)));
    await page.evaluate(() => {
      vodSortFocus =
          _vodSortRows.findIndex(r => r.kind === 'sort' && r.v === 'year');
      vodSortActivate();
    });
    check(
        'Year sorts newest first',
        await page.evaluate(
            () => vodNav.sort === 'year' &&
                yearOf(vodNav.items[0].releaseDate) >=
                    yearOf(vodNav.items[1].releaseDate) &&
                +yearOf(vodNav.items[0].releaseDate) === 2019));
    await page.evaluate(() => {
      vodSortFocus =
          _vodSortRows.findIndex(r => r.kind === 'genre' && r.v === null);
      vodSortActivate();
      vodSortFocus =
          _vodSortRows.findIndex(r => r.kind === 'sort' && r.v === 'default');
      vodSortActivate();
    });
    await back();
    await sleep(50);
    check(
        'All genres + Provider order restore the list; Back closes the menu',
        await page.evaluate(
            () => !vodSortOpen && vodNav.genre === null &&
                vodNav.sort === 'default' && vodNav.items.length === 60 &&
                vodNav.items[0].id === vodNav.baseItems[0].id &&
                vodNav.focus === 0));
    await key('ArrowRight', 39);
    await key('ArrowDown', 40);
    await key('ArrowRight', 39);
    check(
        'grid D-pad: Right, Down, Right → index 7 focused',
        await page.evaluate(
            () => vodNav.zone === 'content' && vodNav.focus === 7 &&
                document.querySelector('.vod-card.focused').dataset.idx ===
                    '7'));
    await page.evaluate(() => {
      for (let i = 0; i < 8; i++) {
        vodNav.focus = Math.min(vodNav.items.length - 1, vodNav.focus + 6);
      }
      updateVodGridFocus();
    });
    check(
        'grid virtualization keeps a bounded number of cards',
        await page.evaluate(
            () => document.querySelectorAll('#vodGridInner .vod-card').length <=
                    36 &&
                !!document.querySelector('.vod-card.focused')));
    await page.evaluate(() => {
      vodNav.focus = 7;
      updateVodGridFocus();
    });
    await key('Enter', 13);
    await page.waitForFunction(
        () =>
            vodNav.screen === 'details' && vodNav.detail && vodNav.detail.info,
        {timeout: 10000});
    const det = await page.evaluate(
        () => ({
          title: document.querySelector('.vod-dtitle').textContent,
          plot: document.querySelector('.vod-dplot').textContent,
          btn: document.querySelector('.vod-btn.focused') &&
              document.querySelector('.vod-btn.focused').textContent,
          meta: document.querySelector('.vod-dmeta').textContent
        }));
    check(
        'movie details show plot, metadata and a focused Play button',
        /Plot of/.test(det.plot) && det.btn === '▶ Play' &&
            /2023/.test(det.meta),
        JSON.stringify(det));
    const px = await page.evaluate(
        () => ({
          meta: document.querySelector('.vod-dmeta').textContent,
          extra: document.querySelector('.vod-dextra') &&
              document.querySelector('.vod-dextra').textContent,
          info: vodNav.detail.info
        }));
    check(
        'provider extras on the details page: age, country, file tech line, release date, added, TMDB id',
        /PG-13/.test(px.meta) && /USA/.test(px.meta) &&
            /1920×1080 · H264 · 23\.98 fps · AAC 5\.1 · 5\.0 Mbps/.test(
                px.meta) &&
            /Released 2023-05-01/.test(px.extra) && /Added /.test(px.extra) &&
            /TMDB 123/.test(px.extra) && px.info.trailer === 'abc123',
        JSON.stringify({meta: px.meta, extra: px.extra}));
    // Play → player screen with the movie file, playback progresses
    await key('Enter', 13);
    await page.waitForFunction(
        () => vodPlay.active &&
            !document.getElementById('vodPlayer').classList.contains('hidden'),
        {timeout: 5000});
    await page
        .waitForFunction(() => videoPlayer.currentTime > 1.5, {timeout: 15000})
        .catch(() => {});
    const pl = await page.evaluate(
        () => ({
          src: videoPlayer.currentSrc || videoPlayer.src,
          t: videoPlayer.currentTime,
          controls: videoPlayer.hasAttribute('controls'),
          inSlot: videoPlayer.parentNode.id,
          osd: document.getElementById('vodOsdTitle').textContent
        }));
    check(
        'movie plays in the app-owned player without native controls',
        /\/movie\/user\/pass\/\d+\.mp4$/.test(pl.src) && pl.t > 1.5 &&
            !pl.controls && pl.inSlot === 'vodVideoSlot' &&
            pl.osd === det.title,
        JSON.stringify(pl));
    await key('ArrowUp', 38);
    await sleep(100);
    const fo = await page.evaluate(
        () => ({
          focus: player.focus,
          btn: player.btns[player.btn] && player.btns[player.btn].id,
          labels: player.btns.map(b => b.id),
          focusedEl: document.querySelector('.vod-osd-btn.focused') &&
              document.querySelector('.vod-osd-btn.focused').textContent,
          osd: document.getElementById('vodOsd').classList.contains('visible'),
          t: videoPlayer.currentTime
        }));
    check(
        'Up focuses the OSD button row on CC without seeking',
        fo.focus === 'buttons' && fo.btn === 'cc' &&
            fo.labels.join() === 'cc,settings' &&
            /Audio & Subtitles/.test(fo.focusedEl) && fo.osd && fo.t < 8,
        JSON.stringify(fo));
    const t0 = await page.evaluate(() => videoPlayer.currentTime);
    await key('ArrowRight', 39);
    await sleep(100);
    check(
        'Right on the button row moves to Settings and does not seek',
        await page.evaluate(
            t0 => player.btns[player.btn].id === 'settings' &&
                Math.abs(videoPlayer.currentTime - t0) < 1,
            t0));
    await key('ArrowLeft', 37);
    await sleep(50);
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(d, 'keyCode', {get: () => 13});
      document.dispatchEvent(d);
      const u = new KeyboardEvent(
          'keyup', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(u, 'keyCode', {get: () => 13});
      document.dispatchEvent(u);
    });
    await sleep(100);
    check(
        'OK on the CC button opens Audio & Subtitles and does not pause',
        await page.evaluate(() => vodTracksOpen() && !videoPlayer.paused));
    await back();
    await sleep(50);
    await key('ArrowDown', 40);
    await sleep(50);
    check(
        'Down returns focus to the bar',
        await page.evaluate(
            () => player.focus === 'bar' &&
                document.getElementById('vodOsd').classList.contains(
                    'bar-focused')));
    await page.evaluate(() => {
      videoPlayer.currentTime = 6;
    });
    await sleep(400);
    // Hold Right: the OSD scrubs while the video stays put; release seeks once
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown',
          {key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true});
      Object.defineProperty(d, 'keyCode', {get: () => 39});
      document.dispatchEvent(d);
    });
    await sleep(1300);
    const hold = await page.evaluate(
        () => ({
          holding: _isHolding(),
          scrub: _scrubPos,
          t: videoPlayer.currentTime,
          osd: document.getElementById('vodOsd').classList.contains('visible'),
          badge: document.getElementById('pbTrickBadge').textContent,
          paused: videoPlayer.paused,
          shown: document.getElementById('vodTimePos').textContent
        }));
    check(
        'holding Right scrubs the OSD at 10× without seeking the video',
        hold.holding && hold.scrub > hold.t + 3 && hold.osd &&
            /▶▶ 10×/.test(hold.badge) && hold.paused &&
            hold.shown ===
                (Math.floor(hold.scrub / 60) + ':' +
                 String(Math.floor(hold.scrub % 60)).padStart(2, '0')),
        JSON.stringify(hold));
    await page.evaluate(() => {
      const u = new KeyboardEvent(
          'keyup',
          {key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true});
      Object.defineProperty(u, 'keyCode', {get: () => 39});
      document.dispatchEvent(u);
    });
    await sleep(700);
    const rel = await page.evaluate(() => ({
                                      holding: _isHolding(),
                                      scrub: _scrubPos,
                                      t: videoPlayer.currentTime,
                                      paused: videoPlayer.paused
                                    }));
    check(
        'release seeks once to the scrubbed position and resumes playback',
        !rel.holding && rel.scrub === null && rel.t > 12 && rel.t < 16 &&
            !rel.paused,
        JSON.stringify(rel));
    // OK pauses, OK resumes
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(d, 'keyCode', {get: () => 13});
      document.dispatchEvent(d);
      const u = new KeyboardEvent(
          'keyup', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(u, 'keyCode', {get: () => 13});
      document.dispatchEvent(u);
    });
    await sleep(200);
    check(
        'OK pauses VOD playback',
        await page.evaluate(
            () => videoPlayer.paused &&
                !document.getElementById('vodPaused')
                     .classList.contains('hidden')));
    // Pointer: click at 75% of the timeline → seek there and play
    await page.evaluate(() => {
      const bar = document.querySelector('#vodOsd .vod-bar');
      const r = bar.getBoundingClientRect();
      bar.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: r.left + r.width * 0.75,
        clientY: r.top + r.height / 2
      }));
    });
    await sleep(300);
    check(
        'clicking the timeline at 75% seeks there and resumes',
        await page.evaluate(
            () => Math.abs(videoPlayer.currentTime - 15) < 1.5 &&
                !videoPlayer.paused &&
                document.getElementById('vodPaused')
                    .classList.contains('hidden')),
        await page.evaluate(() => videoPlayer.currentTime + ''));
    await page.evaluate(() => {
      videoPlayer.pause();
    });
    // Subtitles: simulate tracks announced by the file; English auto-selects
    // per Settings default
    await page.evaluate(() => {
      for (const [l, n] of [['es', 'Spanish'], ['en', 'English']]) {
        const t = document.createElement('track');
        t.kind = 'subtitles';
        t.srclang = l;
        t.label = n;
        videoPlayer.appendChild(t);
      }
    });
    await sleep(300);
    const st = await page.evaluate(() => {
      const subs = getSubtitleTracks();
      return {
        n: subs.length,
        en: subs.find(t => t.language === 'en').mode,
        es: subs.find(t => t.language === 'es').mode,
        hint: document.getElementById('vodOsdTracks').textContent
      };
    });
    check(
        'English subtitle track auto-selected, Spanish off, OSD shows it',
        st.n === 2 && st.en === 'showing' && st.es === 'disabled' &&
            /Subtitles: English/.test(st.hint) && /Green/.test(st.hint),
        JSON.stringify(st));
    check(
        'OSD hint is present even for files without tracks',
        await page.evaluate(() => {
          const subs = getSubtitleTracks();
          const saved = subs.map(t => t.mode);
          return /Green/.test(
              document.getElementById('vodOsdTracks').textContent);
        }));
    const pausedBefore = await page.evaluate(() => videoPlayer.paused);
    await page.evaluate(() => document.getElementById('vodCcBtn').click());
    check(
        'CC button on the OSD opens the tracks menu without toggling playback',
        await page.evaluate(
            pb => vodTracksOpen() && videoPlayer.paused === pb, pausedBefore));
    await page.evaluate(() => document.getElementById('vodCcBtn').click());
    check(
        'CC button again closes it',
        await page.evaluate(() => !vodTracksOpen()));
    await key('ColorF1Green', 404);
    const tm = await page.evaluate(
        () => ({
          open: vodTracksOpen(),
          rows: [...document.querySelectorAll('.vod-track')].map(
              r => r.textContent.trim()),
          focused: document.querySelector('.vod-track.focused') &&
              document.querySelector('.vod-track.focused').textContent.trim()
        }));
    check(
        'Green opens the tracks menu with Off/Spanish/English, English focused',
        tm.open && tm.rows.length === 3 && /English/.test(tm.focused),
        JSON.stringify(tm));
    await key('ArrowUp', 38);
    await key('ArrowUp', 38);
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(d, 'keyCode', {get: () => 13});
      document.dispatchEvent(d);
      const u = new KeyboardEvent(
          'keyup', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(u, 'keyCode', {get: () => 13});
      document.dispatchEvent(u);
    });
    await sleep(100);
    check(
        'Up Up OK picks Off: all subtitle tracks disabled, manual choice remembered',
        await page.evaluate(
            () => getSubtitleTracks().every(t => t.mode === 'disabled') &&
                vodPlay.subManual &&
                /Subtitles: Off/.test(
                    document.getElementById('vodOsdTracks').textContent)));
    // Pointer OK on a menu row (a real click that bubbles to the player) must
    // not toggle pause
    check(
        'clicking a tracks-menu row does not pause the video',
        await page.evaluate(() => {
          const p = videoPlayer.paused;
          const row = document.querySelector('.vod-track');
          row.click();
          return vodTracksOpen() && videoPlayer.paused === p;
        }));
    check(
        'clicking outside the menu while it is open closes it without pausing',
        await page.evaluate(() => {
          const p = videoPlayer.paused;
          document.getElementById('vodPlayer').click();
          return !vodTracksOpen() && videoPlayer.paused === p;
        }));
    await page.evaluate(() => openVodTracks());
    await back();
    check(
        'Back closes the tracks menu but keeps the player',
        await page.evaluate(() => !vodTracksOpen() && vodPlay.active));
    check(
        'OSD is up after the menu closed',
        await page.evaluate(
            () => document.getElementById('vodOsd').classList.contains(
                'visible')));
    await back();
    check(
        'Back with the OSD up hides the OSD and stays in the player',
        await page.evaluate(
            () => vodPlay.active &&
                !document.getElementById('vodOsd').classList.contains(
                    'visible')));
    await back();
    await sleep(300);
    const afterBack = await page.evaluate(
        () => ({
          screen: vodNav.screen,
          playerHidden:
              document.getElementById('vodPlayer').classList.contains('hidden'),
          slot: videoPlayer.parentNode.id,
          controls: videoPlayer.hasAttribute('controls'),
          btn: document.querySelector('.vod-btn.focused') &&
              document.querySelector('.vod-btn.focused').textContent,
          prog:
              Object.values(vodProgress).filter(p => p.kind === 'movie').length,
          stored: !!localStorage.getItem('iptv_vod_progress')
        }));
    check(
        'Back from player returns to details with a Resume button; progress saved; video returned to the guide',
        afterBack.screen === 'details' && afterBack.playerHidden &&
            afterBack.slot === 'epgVideoWrap' && !afterBack.controls &&
            /Resume from 0:1\d/.test(afterBack.btn) && afterBack.prog === 1 &&
            afterBack.stored,
        JSON.stringify(afterBack));
    // Start over button exists; Favorite toggles
    await key('ArrowRight', 39);
    await key('ArrowRight', 39);
    await key('Enter', 13);
    await sleep(100);
    check(
        'Favorite toggles on from details',
        await page.evaluate(
            () => document.querySelector('.vod-btn.focused').textContent ===
                    '★ Favorite' &&
                Object.keys(
                          JSON.parse(localStorage.getItem('iptv_vod_favorites'))
                              [localStorage.getItem('iptv_last_playlist')]
                                  .movies)
                        .length === 1));
    await key('ArrowRight', 39);
    check(
        'Remove from Continue Watching button is last',
        await page.evaluate(
            () => /Remove from Continue Watching/.test(
                document.querySelector('.vod-btn.focused').textContent)));
    const savedEntry = await page.evaluate(() => JSON.stringify(vodProgress));
    await key('Enter', 13);
    await sleep(100);
    check(
        'Remove clears the movie progress; Play button no longer offers Resume',
        await page.evaluate(
            () => Object.values(vodProgress)
                        .filter(p => p.kind === 'movie')
                        .length === 0 &&
                document.querySelector('.vod-btn.pri').textContent ===
                    '▶ Play' &&
                !document.querySelector('.vod-btn.focused') === false));
    // Mark as watched / unwatched from the details page
    await page.evaluate(
        () => vodDetailButtons().find(b => b.id === 'watched').act());
    const mw = await page.evaluate(
        () => ({
          w: isMovieWatched(vodNav.detail.item),
          label: (vodDetailButtons().find(b => b.id === 'watched') || {}).label,
          cw: movieProgress(vodNav.detail.item),
          stored:
              Object
                  .values(JSON.parse(localStorage.getItem('iptv_vod_progress')))
                  .some(e => e.kind === 'movie' && e.watched)
        }));
    check(
        'Mark as watched stores a watched entry, flips the button and keeps the movie out of Continue Watching',
        mw.w && /mark unwatched/.test(mw.label) && mw.cw === null && mw.stored,
        JSON.stringify(mw));
    await page.evaluate(
        () => vodDetailButtons().find(b => b.id === 'watched').act());
    check(
        'Mark unwatched removes the entry again',
        await page.evaluate(
            () => !isMovieWatched(vodNav.detail.item) &&
                (vodDetailButtons().find(b => b.id === 'watched') ||
                 {}).label === '✓ Mark as watched'));
    await page.evaluate(s => {
      vodProgress = JSON.parse(s);
      saveJson('iptv_vod_progress', vodProgress);
      renderVodDetails();
    }, savedEntry);  // restore for the Home checks
    await back();    // → grid
    check(
        'Back from details returns to the grid',
        await page.evaluate(
            () => vodNav.screen === 'grid' &&
                document.getElementById('vodDetails').style.display ===
                    'none'));
    // Pointer: scroll down the grid, click a card that is not the focused one →
    // details → Back lands on that card
    await page.evaluate(() => {
      vodNav.focus = 31;
      updateVodGridFocus();
    });
    await sleep(200);
    await page.evaluate(
        () => document.querySelector('.vod-card[data-idx="37"]').click());
    await page.waitForFunction(
        () => vodNav.screen === 'details' && vodNav.detail &&
            vodNav.detail.item.id === vodNav.items[37].id,
        {timeout: 10000});
    await back();
    await sleep(200);
    const gridBack = await page.evaluate(
        () => ({
          screen: vodNav.screen,
          focus: vodNav.focus,
          zone: vodNav.zone,
          el: document.querySelector('.vod-card.focused') &&
              document.querySelector('.vod-card.focused').dataset.idx,
          scroll: document.getElementById('vodGrid').scrollTop
        }));
    check(
        'Back after a pointer-opened title returns to that card and scroll position, not the top',
        gridBack.screen === 'grid' && gridBack.focus === 37 &&
            gridBack.zone === 'content' && gridBack.el === '37' &&
            gridBack.scroll > 0,
        JSON.stringify(gridBack));
    await page.evaluate(() => {
      vodNav.focus = 7;
      updateVodGridFocus();
    });
    await back();  // → home
    await sleep(300);
    const home = await page.evaluate(
        () => ({
          screen: vodNav.screen,
          list: vodNav.list,
          cw: document.querySelectorAll('.vod-card[data-pos^="cw:"]').length,
          fav: document.querySelectorAll('.vod-card[data-pos^="favs:"]').length,
          cwMeta: document.querySelector(
                      '.vod-card[data-pos="cw:0"] .vod-card-m') &&
              document.querySelector('.vod-card[data-pos="cw:0"] .vod-card-m')
                  .textContent
        }));
    check(
        'Home shows Continue Watching and Favorites rows',
        home.screen === 'home' && home.cw === 1 && home.fav === 1 &&
            /left/.test(home.cwMeta),
        JSON.stringify(home));
    // Pointer on Home: click the Favorites card → details → Back returns to the
    // Favorites row, not the first row
    await page.evaluate(() => {
      vodNav.zone = 'content';
      vodNav.homeRow = 0;
      updateVodHomeFocus();
      document.querySelector('.vod-card[data-pos="favs:0"]').click();
    });
    await page.waitForFunction(
        () =>
            vodNav.screen === 'details' && vodNav.detail && vodNav.detail.info,
        {timeout: 10000});
    await back();
    await sleep(300);
    const homeBack = await page.evaluate(
        () => ({
          screen: vodNav.screen,
          row: vodNav.homeRow,
          favRow: vodHomeFocusRows().findIndex(r => r.key === 'favs'),
          col: vodNav.homeCol.favs,
          el: document.querySelector('.vod-card.focused') &&
              document.querySelector('.vod-card.focused').dataset.pos
        }));
    check(
        'Back after a pointer-opened Home card returns to that row and card',
        homeBack.screen === 'home' && homeBack.favRow > 0 &&
            homeBack.row === homeBack.favRow && homeBack.col === 0 &&
            homeBack.el === 'favs:0',
        JSON.stringify(homeBack));
    const cwBackup = await page.evaluate(() => JSON.stringify(vodProgress));
    await page.evaluate(() => {
      vodNav.zone = 'content';
      vodNav.homeRow = 0;
      updateVodHomeFocus();
    });
    await key('ColorF0Red', 403);
    await sleep(200);
    check(
        'Red on a Continue Watching card removes it from the row',
        await page.evaluate(
            () => document.querySelectorAll('.vod-card[data-pos^="cw:"]')
                        .length === 0 &&
                document.querySelectorAll('.vod-card[data-pos^="favs:"]')
                        .length === 1 &&
                document.getElementById('epgToastTitle').textContent ===
                    'Continue Watching'));
    await page.evaluate(s => {
      vodProgress = JSON.parse(s);
      saveJson('iptv_vod_progress', vodProgress);
      renderVodHome();
    }, cwBackup);
    // Search all: typing filters the full catalog
    await page.evaluate(() => {
      document.querySelectorAll('.group-item')[2].click();
    });
    await page.waitForFunction(
        () => vodNav.list === 'all' && vodNav.screen === 'grid' &&
            vodNav.items.length === 300,
        {timeout: 10000});
    check(
        'Search all shows the full (non-adult) catalog and focuses the search box',
        await page.evaluate(
            () => document.activeElement ===
                document.getElementById('vodSearchInput')));
    await typeText('Comedy Movie 1');
    await sleep(400);
    check(
        'typing filters all movies (prefix matches first)',
        await page.evaluate(
            () => vodNav.items.length === 15 &&
                /^Comedy Movie 1\d$/.test(vodNav.items[0].name)),
        await page.evaluate(
            () => vodNav.items.length +
                ' first=' + (vodNav.items[0] && vodNav.items[0].name)));
    await key('ArrowDown', 40);
    check(
        'Down leaves the search box into the grid',
        await page.evaluate(
            () => document.activeElement !==
                    document.getElementById('vodSearchInput') &&
                vodNav.zone === 'content'));

    // ---- Series
    await key('ColorF3Blue', 406);  // Movies → Series
    await page.waitForFunction(
        () => vodMode === 'series' && vodNav.screen === 'home' &&
            (seriesCats || []).length > 0,
        {timeout: 10000});
    await page.evaluate(() => {
      document.querySelectorAll('#groupsList .group-item')[0].click();
    });  // Drama Series
    await page.waitForFunction(
        () => vodNav.screen === 'grid' && vodNav.items.length === 20,
        {timeout: 10000});
    await page.evaluate(() => {
      vodNav.zone = 'content';
      vodNav.focus = 0;
      updateVodGridFocus();
    });
    await key('Enter', 13);
    await page.waitForFunction(
        () =>
            vodNav.screen === 'details' && vodNav.detail && vodNav.detail.info,
        {timeout: 10000});
    const sd = await page.evaluate(
        () => ({
          seasons: document.querySelectorAll('.vod-season').length,
          eps: document.querySelectorAll('.vod-ep').length,
          btn: document.querySelector('.vod-btn.focused').textContent,
          meta: document.querySelector('.vod-dmeta').textContent
        }));
    check(
        'series details: 2 seasons, 3 episodes in season 1, Play S1 E1',
        sd.seasons === 2 && sd.eps === 3 && sd.btn === '▶ Play S1 E1' &&
            /2 seasons · 5 episodes/.test(sd.meta),
        JSON.stringify(sd));
    // Season / series watched buttons
    const sb = await page.evaluate(
        () => ({
          labels: vodDetailButtons().map(b => b.label).join('|'),
          runtime: document.querySelector('.vod-dmeta').textContent
        }));
    check(
        'series details offer Mark season 1 watched and Mark all watched',
        /Mark season 1 watched/.test(sb.labels) &&
            /Mark all watched/.test(sb.labels),
        sb.labels);
    await page.evaluate(
        () => vodDetailButtons().find(b => b.id === 'season').act());
    const sw = await page.evaluate(() => {
      const d = vodNav.detail;
      const s1 = d.info.seasons[0].episodes.map(ep => {
        const p = episodeProgress(d.item.id, ep.id);
        return p && p.watched ? 1 : 0;
      });
      return {
        s1: s1.join(''),
        s2: d.info.seasons[1].episodes.some(
            ep => episodeProgress(d.item.id, ep.id)),
        play: document.querySelector('.vod-btn.pri').textContent,
        season: (vodDetailButtons().find(b => b.id === 'season') || {}).label,
        ticks: document.querySelectorAll('.vod-ep.watched').length
      };
    });
    check(
        'Mark season watched marks all of season 1, Play moves to S2 E1, button flips to unwatched',
        sw.s1 === '111' && !sw.s2 && /Play S2 E1/.test(sw.play) &&
            /Season 1: mark unwatched/.test(sw.season) && sw.ticks === 3,
        JSON.stringify(sw));
    await page.evaluate(
        () => vodDetailButtons().find(b => b.id === 'season').act());
    check('Season unwatched clears it again', await page.evaluate(() => {
      const d = vodNav.detail;
      return !d.info.seasons[0].episodes.some(
                 ep => episodeProgress(d.item.id, ep.id)) &&
          document.querySelector('.vod-btn.pri').textContent === '▶ Play S1 E1';
    }));
    await page.evaluate(
        () => vodDetailButtons().find(b => b.id === 'all').act());
    check(
        'Mark all watched asks for confirmation first',
        await page.evaluate(
            () => !confirmDialog.classList.contains('hidden') &&
                /all 5 episodes/.test(confirmMessage.textContent)));
    await page.evaluate(() => confirmYes.click());
    await sleep(100);
    const aw = await page.evaluate(() => {
      const d = vodNav.detail;
      const all = d.info.seasons.every(s => s.episodes.every(ep => {
        const p = episodeProgress(d.item.id, ep.id);
        return p && p.watched;
      }));
      return {
        all,
        label: (vodDetailButtons().find(b => b.id === 'all') || {}).label,
        cw: continueWatchingItems('series').some(it => it.id === d.item.id)
      };
    });
    check(
        'Yes marks all 5 episodes watched; the series leaves Continue Watching; button flips',
        aw.all && /Mark all unwatched/.test(aw.label) && !aw.cw,
        JSON.stringify(aw));
    await page.evaluate(
        () => vodDetailButtons().find(b => b.id === 'all').act());
    await page.evaluate(() => confirmYes.click());
    await sleep(100);
    check(
        'Mark all unwatched (confirmed) clears every episode',
        await page.evaluate(() => {
          const d = vodNav.detail;
          return !d.info.seasons.some(
                     s => s.episodes.some(
                         ep => episodeProgress(d.item.id, ep.id))) &&
              vodNav.detailZone === 'buttons';
        }));
    await page.evaluate(() => {
      vodNav.detailBtn = 0;
      vodNav.detailZone = 'buttons';
      renderVodDetails();
    });
    await key('ArrowDown', 40);
    await key('ArrowRight', 39);
    check(
        'Down to seasons, Right selects season 2 (2 episodes)',
        await page.evaluate(
            () => vodNav.detailZone === 'seasons' && vodNav.season === 1 &&
                document.querySelectorAll('.vod-ep').length === 2));
    await key('ArrowLeft', 37);
    await key('ArrowDown', 40);
    await key('ArrowDown', 40);
    check(
        'Down into episodes, E2 focused',
        await page.evaluate(
            () => vodNav.detailZone === 'episodes' && vodNav.epIdx === 1 &&
                document.querySelector('.vod-ep.focused .vod-ept')
                    .textContent.includes('E2')));
    // Red on an episode row toggles its watched state
    await key('ColorF0Red', 403);
    await sleep(100);
    const ew = await page.evaluate(() => {
      const d = vodNav.detail, ep = d.info.seasons[0].episodes[1];
      const p = episodeProgress(d.item.id, ep.id);
      return {
        w: !!(p && p.watched),
        last: p && p.lastOfSeries,
        cls: document.querySelector('.vod-ep.focused')
                 .classList.contains('watched'),
        focusKept: vodNav.detailZone === 'episodes' && vodNav.epIdx === 1,
        hint: /Red mark episode watched/.test(
            document.querySelector('.vod-dhint').textContent)
      };
    });
    check(
        'Red marks the focused episode watched (not last of series), row shows the tick, focus stays',
        ew.w && ew.last === false && ew.cls && ew.focusKept && ew.hint,
        JSON.stringify(ew));
    await key('ColorF0Red', 403);
    await sleep(100);
    check('Red again marks it unwatched', await page.evaluate(() => {
      const d = vodNav.detail, ep = d.info.seasons[0].episodes[1];
      return !episodeProgress(d.item.id, ep.id) &&
          !document.querySelector('.vod-ep.focused')
               .classList.contains('watched');
    }));
    await key('Enter', 13);
    await page.waitForFunction(
        () => vodPlay.active && vodPlay.kind === 'episode', {timeout: 5000});
    const ep =
        await page.evaluate(() => ({
                              src: videoPlayer.currentSrc || videoPlayer.src,
                              title: vodPlay.title
                            }));
    check(
        'episode plays from the series endpoint',
        /\/series\/user\/pass\/\d+\.mp4$/.test(ep.src) &&
            /S1 E2/.test(ep.title),
        JSON.stringify(ep));
    await page
        .waitForFunction(() => videoPlayer.currentTime > 0.5, {timeout: 10000})
        .catch(() => {});
    // Simulate the end of the episode → Up Next card with countdown
    await page.evaluate(() => {
      videoPlayer.pause();
      videoPlayer.dispatchEvent(new Event('ended'));
    });
    await sleep(200);
    const nx = await page.evaluate(
        () => ({
          visible: vodNextVisible(),
          name: document.getElementById('vodNextName').textContent,
          label: document.getElementById('vodNextLabel').textContent,
          watched: Object.values(vodProgress)
                       .some(p => p.kind === 'episode' && p.watched)
        }));
    check(
        'ended → Up Next card for S1 E3 with countdown; E2 marked watched',
        nx.visible && /S1 E3/.test(nx.name) &&
            /plays in \d+ s/.test(nx.label) && nx.watched,
        JSON.stringify(nx));
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(d, 'keyCode', {get: () => 13});
      document.dispatchEvent(d);
      const u = new KeyboardEvent(
          'keyup', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(u, 'keyCode', {get: () => 13});
      document.dispatchEvent(u);
    });
    await page.waitForFunction(
        () => vodPlay.active && /S1 E3/.test(vodPlay.title), {timeout: 5000});
    check(
        'OK on Play now starts the next episode',
        await page.evaluate(() => !vodNextVisible() && vodPlay.epIdx === 2));
    // Last episode of season 1 ends → rolls into season 2
    await page.evaluate(() => {
      videoPlayer.dispatchEvent(new Event('ended'));
    });
    await sleep(100);
    check(
        'end of season rolls Up Next into season 2',
        await page.evaluate(
            () => vodNextVisible() &&
                /S2 E1/.test(
                    document.getElementById('vodNextName').textContent)));
    // Auto-play next episode Off: the card appears without a countdown and
    // nothing starts by itself
    await page.evaluate(() => {
      clearVodNext();
      settings.autoNext = false;
      saveSettings();
      showVodNext(nextEpisode());
    });
    await sleep(1300);
    const an = await page.evaluate(
        () => ({
          visible: vodNextVisible(),
          label: document.getElementById('vodNextLabel').textContent,
          timer: vodPlay.nextTimer,
          row: settingsRows().find(r => r.id === 'autoNext').get()
        }));
    check(
        'Auto-play next Off: Up Next card shows without a countdown and does not start the episode',
        an.visible && an.label === 'Up next' && an.timer === null &&
            an.row === false,
        JSON.stringify(an));
    await page.evaluate(() => {
      clearVodNext();
      settings.autoNext = true;
      saveSettings();
      showVodNext(nextEpisode());
    });
    await sleep(100);
    check(
        'Auto-play next On again: countdown is back',
        await page.evaluate(
            () => /plays in \d+ s/.test(
                document.getElementById('vodNextLabel').textContent)));
    await key('ArrowRight', 39);  // focus Cancel
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(d, 'keyCode', {get: () => 13});
      document.dispatchEvent(d);
      const u = new KeyboardEvent(
          'keyup', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(u, 'keyCode', {get: () => 13});
      document.dispatchEvent(u);
    });
    await sleep(300);
    const canc = await page.evaluate(
        () => ({
          active: vodPlay.active,
          screen: vodNav.screen,
          season: vodNav.season,
          ep: vodNav.epIdx,
          zone: vodNav.detailZone,
          checks: document.querySelectorAll('.vod-ep .vod-chk').length,
          btn: document.querySelector('.vod-btn.pri').textContent,
          focusedEp: document.querySelector('.vod-ep.focused .vod-ept') &&
              document.querySelector('.vod-ep.focused .vod-ept').textContent
        }));
    check(
        'Cancel returns to details on S2 E1; Play button advances; S1 fully ticked',
        !canc.active && canc.screen === 'details' &&
            canc.btn === '▶ Play S2 E1' && canc.season === 1 && canc.ep === 0 &&
            canc.zone === 'episodes' && /E1/.test(canc.focusedEp),
        JSON.stringify(canc));
    await key('ArrowLeft', 37);
    await key('ArrowLeft', 37);
    await sleep(100);
    check(
        'season 1 shows both watched episodes ticked',
        await page.evaluate(
            () => vodNav.season === 0 &&
                document.querySelectorAll('.vod-ep .vod-chk').length === 2));
    // ---- webOS media-service path (simulated): pipeline reports embedded
    // tracks, app selects English natively
    await page.evaluate(() => {
      window.__ums = {calls: []};
      window.__loads = 0;
      const origLoad = videoPlayer.load.bind(videoPlayer);
      videoPlayer.load = function() {
        window.__loads++;
        return origLoad();
      };
      Object.defineProperty(
          videoPlayer, 'mediaId',
          {get: () => '_fakePipe' + window.__loads, configurable: true});
      window.__realWebOS = window.webOS;
      window.webOS = {
        service: {
          request: (uri, o) => {
            window.__ums.calls.push([o.method, JSON.stringify(o.parameters)]);
            if (o.method === 'subscribe') {
              setTimeout(
                  () => o.onSuccess({subscription: true, returnValue: true}),
                  5);
              setTimeout(
                  () => o.onSuccess({
                    returnValue: true,
                    sourceInfo: {
                      container: 'mkv',
                      programInfo: [{
                        audioTrackInfo: [
                          {language: 'en', codec: 'eac3', channels: 6},
                          {language: 'es', codec: 'aac', channels: 2}
                        ],
                        videoTrackInfo: [{
                          codec: 'HEVC',
                          width: 3840,
                          height: 1600,
                          profile: 'main-10',
                          frameRate: 23.976
                        }],
                        subtitleTrackInfo: [
                          {
                            trackNum: 0,
                            language: 'ar',
                            languageName: 'Arabic',
                            type: 'text'
                          },
                          {
                            trackNum: 1,
                            language: 'en',
                            languageName: 'English',
                            type: 'text'
                          },
                          {
                            trackNum: 2,
                            language: 'en',
                            languageName: 'English',
                            type: 'text'
                          },
                          {
                            trackNum: 3,
                            language: 'es',
                            languageName: 'Spanish; Castilian',
                            type: 'text'
                          }
                        ]
                      }]
                    }
                  }),
                  40);
              return {
                cancel: () => {
                  window.__ums.cancelled = true;
                }
              };
            }
            setTimeout(
                () => o.onSuccess(
                    {returnValue: true, errorCode: 0, mediaId: '_fakePipe1'}),
                2);
            return {};
          }
        }
      };
    });
    await page.evaluate(() => {
      vodNav.detailZone = 'episodes';
      vodNav.season = 1;
      vodNav.epIdx = 0;
      playFocusedEpisode();
    });
    await page.waitForFunction(
        () =>
            vodPlay.active && vodPlay.ums && vodPlay.ums.subTracks.length === 4,
        {timeout: 8000});
    await sleep(200);
    const um = await page.evaluate(
        () => ({
          sel: vodPlay.ums.selectedSub,
          calls: window.__ums.calls.map(c => c[0]),
          lastSel: window.__ums.calls.filter(c => c[0] === 'selectTrack')
                       .map(c => c[1]),
          hint: document.getElementById('vodOsdTracks').textContent
        }));
    check(
        'pipeline sourceInfo → first English subtitle track selected natively and enabled',
        um.sel === 1 && um.calls.includes('subscribe') &&
            um.lastSel.some(p => /"type":"text","index":1/.test(p)) &&
            um.calls.includes('setSubtitleEnable') &&
            /Subtitles: English 1/.test(um.hint),
        JSON.stringify(um));
    await key('ColorF1Green', 404);
    const um2 = await page.evaluate(
        () => ({
          rows: [...document.querySelectorAll('.vod-track')].map(
              r => r.textContent.trim()),
          headers: [...document.querySelectorAll('.vod-tracks-h')].map(
              h => h.textContent)
        }));
    check(
        'tracks menu lists pipeline audio and subtitle tracks with language names',
        um2.headers.join(',') === 'Audio,Subtitles,Timing' &&
            um2.rows.length === 2 + 5 + 1 &&
            um2.rows.some(r => /English 2/.test(r)) &&
            um2.rows.some(r => /Spanish/.test(r)) &&
            um2.rows.some(r => /English · EAC3 · 5\.1/.test(r)),
        JSON.stringify(um2));
    await key('ArrowDown', 40);
    await key('ArrowDown', 40);  // from English 1 → English 2 → Spanish
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(d, 'keyCode', {get: () => 13});
      document.dispatchEvent(d);
      const u = new KeyboardEvent(
          'keyup', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(u, 'keyCode', {get: () => 13});
      document.dispatchEvent(u);
    });
    await sleep(100);
    check(
        'picking Spanish calls selectTrack text index 3 and marks it manual',
        await page.evaluate(
            () => vodPlay.ums.selectedSub === 3 && vodPlay.subManual &&
                window.__ums.calls.some(
                    c => c[0] === 'selectTrack' && /"index":3/.test(c[1]))));
    const style = await page.evaluate(() => {
      const c = window.__ums.calls;
      const last = n => (c.filter(x => x[0] === n).pop() || [])[1] || '';
      return {
        size: last('setSubtitleCharacterFontSize'),
        bg: last('setSubtitleBackgroundOpacity'),
        edge: last('setSubtitleCharacterEdge'),
        color: last('setSubtitleCharacterColor'),
        sync: last('setSubtitleSync')
      };
    });
    check(
        'subtitle style applied after enabling: medium, white @85% (default opacity), translucent, outline, sync 0',
        /"charFontSize":"medium"/.test(style.size) &&
            /"charColor":"white"/.test(style.color) &&
            /"bgOpacity":50/.test(style.bg) &&
            /"charEdgeType":"uniform"/.test(style.edge) &&
            /"sync":0/.test(style.sync) &&
            await page.evaluate(
                () => settings.subColor === 'white' &&
                    settings.subOpacity === 85 &&
                    !SUB_COLOR_OPTIONS.some(o => o.v === 'gray') &&
                    settingsRows().some(r => r.id === 'subOpacity') &&
                    window.__ums.calls.some(
                        c => c[0] === 'setSubtitleCharacterOpacity' &&
                            /"charOpacity":217/.test(c[1]))),
        JSON.stringify(style));
    await page.evaluate(() => {
      settingsRows().find(x => x.id === 'subOpacity').set(55);
    });
    await sleep(100);
    check(
        'Subtitle opacity setting is sent to the pipeline as charOpacity on the 0-255 scale (55% → 140)',
        await page.evaluate(
            () => settings.subOpacity === 55 &&
                /"charOpacity":140/.test(
                    (window.__ums.calls
                         .filter(c => c[0] === 'setSubtitleCharacterOpacity')
                         .pop() ||
                     [])[1] ||
                    '')));
    await page.evaluate(() => {
      settingsRows().find(x => x.id === 'subOpacity').set(85);
    });
    await sleep(150);  // let that apply finish before the next setting change
                       // starts another
    await page.evaluate(() => {
      settingsRows().find(x => x.id === 'subEdge').set('shadow');
    });
    await sleep(150);
    check(
        'Shadow edge uses the renderer vocabulary (right_drop_shadow) and a black edge colour is sent',
        await page.evaluate(() => {
          const c = window.__ums.calls;
          const last = n => (c.filter(x => x[0] === n).pop() || [])[1] || '';
          return /"charEdgeType":"right_drop_shadow"/.test(
                     last('setSubtitleCharacterEdge')) &&
              /"charEdgeColor":"black"/.test(
                  last('setSubtitleCharacterEdgeColor')) &&
              SUB_EDGE_OPTIONS.some(o => o.v === 'raised');
        }));
    await page.evaluate(() => {
      settingsRows().find(x => x.id === 'subEdge').set('outline');
    });
    await sleep(150);
    await page.evaluate(() => {
      settingsRows().find(x => x.id === 'subBg').set('solid');
    });
    await sleep(100);
    check(
        'solid background sends opacity 100 then 255',
        await page.evaluate(() => {
          const o = window.__ums.calls
                        .filter(c => c[0] === 'setSubtitleBackgroundOpacity')
                        .map(c => c[1]);
          return /"bgOpacity":255/.test(o[o.length - 1]) &&
              /"bgOpacity":100/.test(o[o.length - 2]);
        }));
    await page.evaluate(() => {
      settingsRows().find(x => x.id === 'subBg').set('translucent');
    });
    await page.evaluate(() => {
      const r = settingsRows().find(x => x.id === 'subSize');
      r.set('large');
    });
    await sleep(100);
    check(
        'changing subtitle size in Settings re-applies live',
        await page.evaluate(
            () => settings.subSize === 'large' &&
                /"charFontSize":"large"/.test(
                    (window.__ums.calls
                         .filter(x => x[0] === 'setSubtitleCharacterFontSize')
                         .pop() ||
                     [])[1])));
    await page.evaluate(() => {
      settingsRows().find(x => x.id === 'subSize').set('medium');
    });
    // Sync offset row: Down to it, Right twice → +0.5 s, remembered; OK resets
    await page.evaluate(() => {
      vodPlay.tracksFocus =
          vodPlay.tracksItems.findIndex(i => i.kind === 'sync');
      renderVodTracks();
    });
    await key('ArrowRight', 39);
    await key('ArrowRight', 39);
    await sleep(50);
    const sy = await page.evaluate(
        () => ({
          ms: vodPlay.syncMs,
          stored:
              JSON.parse(localStorage.getItem('iptv_vod_subsync'))[vodPlay.key],
          call:
              (window.__ums.calls.filter(x => x[0] === 'setSubtitleSync')
                   .pop() ||
               [])[1],
          row: document.querySelector('.vod-track.focused').textContent
        }));
    check(
        'sync offset Right Right → +0.50 s, sent to the pipeline and remembered for the title',
        sy.ms === 500 && sy.stored === 500 && /"sync":500/.test(sy.call) &&
            /\+0\.50 s/.test(sy.row),
        JSON.stringify(sy));
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(d, 'keyCode', {get: () => 13});
      document.dispatchEvent(d);
      const u = new KeyboardEvent(
          'keyup', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(u, 'keyCode', {get: () => 13});
      document.dispatchEvent(u);
    });
    await sleep(50);
    check(
        'OK on the sync row resets it to 0 and forgets it',
        await page.evaluate(
            () => vodPlay.syncMs === 0 &&
                !(vodPlay.key in
                  JSON.parse(localStorage.getItem('iptv_vod_subsync')))));
    await back();  // close menu
    // Codec/HDR line in the OSD and stored for the details page
    check(
        'OSD shows codec, bit depth, resolution, frame rate and audio from the pipeline',
        await page.evaluate(
            () => document.getElementById('vodOsdTech').textContent ===
                    'HEVC · 10-bit · 3840×1600 · 23.976 fps · E-AC-3 5.1' &&
                JSON.parse(
                    localStorage.getItem('iptv_vod_tech'))[vodPlay.key] ===
                    'HEVC · 10-bit · 3840×1600 · 23.976 fps · E-AC-3 5.1'),
        await page.evaluate(
            () => document.getElementById('vodOsdTech').textContent));
    // Native speed playback: hold Right → setPlayRate 2 with picture; release →
    // rate 1
    await page.evaluate(() => {
      window.__ums.calls.length = 0;
      videoPlayer.currentTime = 2;
    });
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown',
          {key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true});
      Object.defineProperty(d, 'keyCode', {get: () => 39});
      document.dispatchEvent(d);
    });
    await sleep(900);
    const nr = await page.evaluate(
        () => ({
          holding: _isHolding(),
          rate: _nativeRate,
          scrub: _scrubPos,
          paused: videoPlayer.paused,
          badge: document.getElementById('pbTrickBadge').textContent,
          calls: window.__ums.calls.filter(c => c[0] === 'setPlayRate')
                     .map(c => c[1])
        }));
    check(
        'holding Right uses native setPlayRate 2× with the picture running',
        nr.holding && nr.rate === 2 && nr.scrub === null && !nr.paused &&
            /▶▶ 2×/.test(nr.badge) &&
            nr.calls.some(p => /"playRate":2,/.test(p)),
        JSON.stringify(nr));
    await page.evaluate(() => {
      const u = new KeyboardEvent(
          'keyup',
          {key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true});
      Object.defineProperty(u, 'keyCode', {get: () => 39});
      document.dispatchEvent(u);
    });
    await sleep(200);
    check(
        'release returns to 1× with audio',
        await page.evaluate(
            () => !_isHolding() && _nativeRate === 0 &&
                /"playRate":1,"audioOutput":true/.test(
                    (window.__ums.calls.filter(c => c[0] === 'setPlayRate')
                         .pop() ||
                     [])[1])));
    // Rewind cannot move backwards in the headless player → fallback to the
    // scrub bar after 1.5 s
    await page.evaluate(() => {
      videoPlayer.currentTime = 14;
    });
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown',
          {key: 'ArrowLeft', keyCode: 37, bubbles: true, cancelable: true});
      Object.defineProperty(d, 'keyCode', {get: () => 37});
      document.dispatchEvent(d);
    });
    await sleep(2200);
    const fb = await page.evaluate(() => ({
                                     holding: _isHolding(),
                                     broken: _umsRateBroken,
                                     scrub: _scrubPos,
                                     rate: _nativeRate,
                                     t: videoPlayer.currentTime
                                   }));
    check(
        'when the pipeline ignores the rate, the hold falls back to scrubbing',
        fb.holding && fb.broken && fb.scrub !== null && fb.scrub < fb.t &&
            fb.rate === 0,
        JSON.stringify(fb));
    await page.evaluate(() => {
      const u = new KeyboardEvent(
          'keyup',
          {key: 'ArrowLeft', keyCode: 37, bubbles: true, cancelable: true});
      Object.defineProperty(u, 'keyCode', {get: () => 37});
      document.dispatchEvent(u);
    });
    await sleep(300);
    await page.evaluate(() => {
      _umsRateBroken = false;
    });
    // Yellow opens Settings over the player; OK there must not pause playback
    await key('ColorF2Yellow', 405);
    const pb = await page.evaluate(() => videoPlayer.paused);
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(d, 'keyCode', {get: () => 13});
      document.dispatchEvent(d);
      const u = new KeyboardEvent(
          'keyup', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(u, 'keyCode', {get: () => 13});
      document.dispatchEvent(u);
    });
    await sleep(100);
    check(
        'Yellow opens Settings over the player and OK stays inside Settings',
        await page.evaluate(
            pb => settingsOpen && videoPlayer.paused === pb &&
                settings.textScale === 1.5,
            pb));  // OK cycled the focused Text size row
    await page.evaluate(() => {
      settingsRows().find(x => x.id === 'textScale').set(1.375);
    });
    await back();
    check(
        'Back closes Settings and keeps playing',
        await page.evaluate(() => !settingsOpen && vodPlay.active));
    await back();
    if (await page.evaluate(() => vodPlay.active))
      await back();  // first Back only hides the OSD when it is up
    await sleep(200);
    check(
        'stopping playback cancels the pipeline subscription',
        await page.evaluate(
            () => window.__ums.cancelled === true && vodPlay.ums === null));
    check(
        'details page shows the stored codec line for the last played episode',
        await page.evaluate(
            () => /HEVC · 10-bit/.test(
                document.querySelector('.vod-dmeta').textContent)),
        await page.evaluate(() => JSON.stringify({
          meta: document.querySelector('.vod-dmeta') &&
              document.querySelector('.vod-dmeta').textContent,
          screen: vodNav.screen,
          techKeys: Object.keys(vodTech),
          last: lastEpisodeEntry(vodNav.detail.item.id) &&
              lastEpisodeEntry(vodNav.detail.item.id).epId
        })));
    // Live subtitles through the same pipeline path: back to Live, zap a
    // channel, English auto-selected, menu in the live player
    await page.evaluate(() => {
      setVodMode('live');
    });
    await sleep(400);
    await page.evaluate(() => {
      window.__ums.calls.length = 0;
      zapChannel(1);
    });
    await page.waitForFunction(
        () => liveUms && liveUms.subTracks.length === 4 &&
            liveUms.selectedSub === 1,
        {timeout: 8000});
    await sleep(300);
    check(
        'feed stats chip appears over the live picture when the pipeline describes the channel',
        await page.evaluate(() => {
          const c = document.getElementById('feedStats');
          return !!c && c.classList.contains('visible') &&
              /HEVC/.test(c.textContent) && c.parentNode.id === 'epgVideoWrap';
        }),
        await page.evaluate(() => {
          const c = document.getElementById('feedStats');
          return c ? c.className + ' ' + c.textContent : 'no chip';
        }));
    check(
        'live channel: pipeline subtitle tracks read and English selected automatically',
        await page.evaluate(
            () => window.__ums.calls.some(
                      c => c[0] === 'selectTrack' &&
                          /"type":"text","index":1/.test(c[1])) &&
                window.__ums.calls.some(c => c[0] === 'setSubtitleEnable')),
        await page.evaluate(
            () => JSON.stringify(
                window.__ums.calls.map(c => c[0] + ' ' + c[1]).slice(0, 12))));
    await page.evaluate(() => enterLivePlayer());
    await sleep(200);
    await key('ColorF1Green', 404);
    const lm = await page.evaluate(
        () => ({
          open: vodTracksOpen(),
          rows: [...document.querySelectorAll('.vod-track')].map(
              r => r.textContent.trim()),
          hint: document.getElementById('vodOsdTracks').textContent,
          tech: document.getElementById('vodOsdTech').textContent
        }));
    check(
        'live player Green menu lists the channel\'s tracks; banner shows subtitle state and codec line',
        lm.open && lm.rows.some(r => /English 1/.test(r)) &&
            !lm.rows.some(r => /Sync offset/.test(r)) &&
            /Subtitles: English 1/.test(lm.hint) && /HEVC/.test(lm.tech),
        JSON.stringify(lm));
    check(
        'no Stream Info button or overlay anywhere',
        await page.evaluate(
            () => !document.getElementById('infoBtn') &&
                !document.getElementById('epgInfoBtn') &&
                !document.getElementById('streamInfoOverlay') &&
                typeof showStreamInfo === 'undefined' &&
                !player.btns.some(b => b.id === 'info' || b.id === 'pause')));
    await key('ArrowUp', 38);
    await key('ArrowUp', 38);  // Off
    await page.evaluate(() => {
      const d = new KeyboardEvent(
          'keydown', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(d, 'keyCode', {get: () => 13});
      document.dispatchEvent(d);
      const u = new KeyboardEvent(
          'keyup', {key: 'Enter', keyCode: 13, bubbles: true});
      Object.defineProperty(u, 'keyCode', {get: () => 13});
      document.dispatchEvent(u);
    });
    await sleep(50);
    check(
        'live: picking Off disables subtitles on the live pipeline and is remembered as manual',
        await page.evaluate(
            () => liveUms.selectedSub === -1 && liveUms.subManual &&
                /"enable":false/.test((
                    window.__ums.calls.filter(c => c[0] === 'setSubtitleEnable')
                        .pop() ||
                    [])[1])));
    await back();
    await back();
    check(
        'live: Back closes the menu, Back hides the banner, player stays',
        await page.evaluate(
            () => livePlayer.active && !vodTracksOpen() &&
                !document.getElementById('vodOsd').classList.contains(
                    'visible')));
    await back();
    await sleep(200);
    check(
        'live: Back with the banner hidden leaves the live player',
        await page.evaluate(() => !livePlayer.active && !vodTracksOpen()));
    await page.evaluate(() => {
      setVodMode('series');
    });
    await page.waitForFunction(
        () => vodMode === 'series' && vodNav.screen === 'home',
        {timeout: 8000});
    await page.evaluate(() => {
      document.querySelectorAll('#groupsList .group-item')[0].click();
    });
    await page.waitForFunction(
        () => vodNav.screen === 'grid' && vodNav.items.length === 20,
        {timeout: 8000});
    await page.evaluate(() => {
      vodNav.zone = 'content';
      vodNav.focus = 0;
      updateVodGridFocus();
    });
    await key('Enter', 13);
    await page.waitForFunction(
        () =>
            vodNav.screen === 'details' && vodNav.detail && vodNav.detail.info,
        {timeout: 8000});
    await page.evaluate(() => {
      window.webOS = window.__realWebOS;
      delete videoPlayer.mediaId;
      delete videoPlayer.load;
    });

    // Series home shows Continue Watching
    await back();
    await back();
    await sleep(300);
    check(
        'Series home shows the show in Continue Watching (last played S2 E1)',
        await page.evaluate(
            () => vodNav.screen === 'home' &&
                document.querySelectorAll('.vod-card[data-pos^="cw:"]')
                        .length === 1 &&
                /S2 E1/.test(
                    document
                        .querySelector('.vod-card[data-pos="cw:0"] .vod-card-m')
                        .textContent)),
        await page.evaluate(
            () => document.querySelector(
                      '.vod-card[data-pos="cw:0"] .vod-card-m') &&
                document.querySelector('.vod-card[data-pos="cw:0"] .vod-card-m')
                    .textContent));
    // Adult toggle in settings
    await page.evaluate(() => {
      settings.showAdult = true;
      saveSettings();
      renderGroupsList();
    });
    check(
        'Show adult categories reveals the hidden category',
        await page.evaluate(
            () => [...document.querySelectorAll('#groupsList .group-item')]
                      .some(g => /Adult/.test(g.textContent))));
    await page.evaluate(() => {
      settings.showAdult = false;
      saveSettings();
      renderGroupsList();
    });
    // Back from Home → Live, channel resumes
    await back();
    await page.waitForFunction(() => vodMode === 'live', {timeout: 5000});
    await sleep(400);
    const live = await page.evaluate(
        () => ({
          ev: document.getElementById('epgView').style.display,
          vv: document.getElementById('vodView').style.display,
          slot: videoPlayer.parentNode.id,
          src: videoPlayer.getAttribute('src') || '',
          controls: videoPlayer.hasAttribute('controls'),
          rows: epgRenderedRows.size
        }));
    check(
        'Back from Home returns to Live: guide visible, live stream reloaded, no native controls',
        live.ev === 'flex' && live.vv === 'none' &&
            live.slot === 'epgVideoWrap' && /\/live\//.test(live.src) &&
            !live.controls && live.rows > 0,
        JSON.stringify(live));
  }

  // ---------- Back + confirm dialog with D-pad ----------
  await back();
  check(
      'Back opens Return-to-Home dialog',
      await page.evaluate(() => !confirmDialog.classList.contains('hidden')));
  await key('ArrowDown', 40);  // must NOT move guide focus while dialog is open
  // Connection limit: the provider counts the last stream of the app for a
  // short time. A full account that is free at the second check is not
  // reported.
  await fetch(BASE + '/__cons?active=1&max=1');
  await page.evaluate(() => {
    _consRecheckMs = 1500;
    window.__savedUrl6 = channels[6].url;
    channels[6].url = 'http://localhost:8765/busy-account/live.m3u8';
    _consInfo = null;
    _consCheckAt = 0;
    document.getElementById('epgToastTitle').textContent = '';
    selectChannel(6);
  });
  await page.waitForFunction(() => _consInfo !== null, {timeout: 10000})
      .catch(() => {});
  await fetch(BASE + '/__cons?active=0&max=1');
  await sleep(2500);
  const own = await page.evaluate(
      () => ({
        title: document.getElementById('epgToastTitle').textContent,
        cons: _consInfo && [_consInfo.active, _consInfo.max].join('/'),
        text: accountProblemText(_consInfo),
        log: _diagLog.some(e => /Account: Another device/.test(e.msg))
      }));
  check(
      'a full account that is free at the second check is not reported',
      own.title !== 'Connection limit' && own.cons === '0/1' &&
          own.text === '' && !own.log,
      JSON.stringify(own));
  // If the recheck gets no answer, the old full result is not confirmed
  const stale = await page.evaluate(async () => {
    const realFetch = window.fetch;
    window.fetch = () => Promise.reject(new Error('offline'));
    _consInfo = {active: 1, max: 1, status: 'Active', exp: 0, at: Date.now()};
    _lastStreamOpenAt = 0;
    document.getElementById('epgToastTitle').textContent = '';
    recheckFullAccount();
    await new Promise(r => setTimeout(r, 300));
    window.fetch = realFetch;
    const r = {
      confirmed: _consInfo.confirmed,
      text: accountProblemText(_consInfo),
      title: document.getElementById('epgToastTitle').textContent
    };
    _consInfo = null;
    return r;
  });
  check(
      'a recheck with no answer does not confirm the old full result',
      !stale.confirmed && stale.text === '' &&
          stale.title !== 'Connection limit',
      JSON.stringify(stale));
  // A dead stream on a one-connection account that is busy elsewhere is
  // explained as such
  await fetch(BASE + '/__cons?active=1&max=1');
  await page.evaluate(() => {
    selectChannel(0);
    _consInfo = null;
    _consCheckAt = 0;
    document.getElementById('epgToastTitle').textContent = '';
    selectChannel(6);
  });
  await page
      .waitForFunction(
          () => document.getElementById('epgToastTitle').textContent ===
              'Connection limit',
          {timeout: 15000})
      .catch(() => {});
  const cl = await page.evaluate(
      () => ({
        title: document.getElementById('epgToastTitle').textContent,
        msg: document.getElementById('epgToastMsg').textContent,
        status: statusArea.innerText,
        cons: _consInfo && [_consInfo.active, _consInfo.max].join('/')
      }));
  check(
      'first stream failure checks the account: "Another device is streaming" toast, status line and diagnostics entry',
      cl.title === 'Connection limit' &&
          /Another device is streaming with this account/.test(cl.msg) &&
          /Another device/.test(cl.status) && cl.cons === '1/1' &&
          await page.evaluate(
              () => _diagLog.some(e => /Account: Another device/.test(e.msg))),
      JSON.stringify(cl));
  await page.evaluate(() => {
    _reloadAttempts = MAX_AUTO_RELOADS;
  });
  await page
      .waitForFunction(
          () => /Stop playback on the other device/.test(
                    document.getElementById('epgToastMsg').textContent) &&
              stallWatchdogTimer === null,
          {timeout: 15000})
      .catch(() => {});
  check(
      'the final error keeps the account explanation instead of a generic stream error',
      await page.evaluate(
          () => document.getElementById('epgToastTitle').textContent ===
              'Connection limit'));
  await fetch(BASE + '/__cons?active=0&max=1');
  await page.evaluate(() => {
    channels[6].url = window.__savedUrl6;
    _consInfo = null;
    _consCheckAt = 0;
    document.getElementById('epgToastTitle').textContent = '';
    selectChannel(0);
  });
  await sleep(300);
  check(
      'with the connection free again a failing stream is reported as a stream error',
      await page.evaluate(() => accountProblemText(_consInfo) === ''));
  const guideFocusBefore = await page.evaluate(() => epgFocusedRowIdx);
  await back();
  check(
      'Back again cancels the dialog',
      await page.evaluate(() => confirmDialog.classList.contains('hidden')));
  check(
      'guide focus untouched while dialog open',
      await page.evaluate(() => epgFocusedRowIdx) === guideFocusBefore);
  await back();
  await key('ArrowRight', 39);
  await key('Enter', 13);
  check(
      'Right+Enter picks Cancel and stays in app',
      await page.evaluate(
          () => confirmDialog.classList.contains('hidden') &&
              mainApp.style.display !== 'none'));
  await back();
  await key('ArrowLeft', 37);
  await key('Enter', 13);
  await sleep(300);
  check(
      'Left+Enter picks Yes and returns home',
      await page.evaluate(
          () => !startPage.classList.contains('hidden') &&
              mainApp.style.display === 'none'));
  check(
      'lazy EPG state cleared on home',
      await page.evaluate(
          () => _xt === null && _epgQueue.length === 0 && epgData.size === 0));

  // ---------- M3U demo: standard view D-pad ----------
  await click('#startDemoBtn');
  await page
      .waitForFunction(
          () =>
              currentPlaylistType === 'm3u' && mainApp.style.display === 'flex',
          {timeout: 10000})
      .catch(async e => {
        console.log(
            'DEMO STATE',
            JSON.stringify(
                await page.evaluate(() => ({
                                      isLoading,
                                      type: currentPlaylistType,
                                      main: mainApp.style.display,
                                      start: startPage.className,
                                      status: startStatusMessage.textContent
                                    }))),
            'ERRORS', errors.slice(0, 5));
        throw e;
      });
  await sleep(800);
  await page.evaluate(() => {
    document.querySelectorAll('.group-item')[1].click();
  });  // All Channels
  await sleep(300);
  check(
      'standard view: initial focus in channel list',
      await page.evaluate(
          () => stdFocusZone === 'channels' &&
              !!document.querySelector('.virtual-item.focused')));
  await key('ArrowDown', 40);
  await key('ArrowDown', 40);
  check(
      'standard view: Down moves channel focus',
      await page.evaluate(
          () => stdFocusIdx === 2 &&
              renderedItems.get(2).classList.contains('focused')));
  await key('Enter', 13);
  await sleep(200);
  check(
      'standard view: Enter plays focused channel',
      await page.evaluate(
          () => currentChannelIndex ===
                  getChannelIndex(currentFilteredChannels[2]) &&
              renderedItems.get(2).classList.contains('active')));
  await key('Enter', 13);
  await sleep(200);
  check(
      'standard view: Enter on the playing row opens the live player',
      await page.evaluate(
          () => livePlayer.active && videoPlayer.parentNode === videoArea &&
              player.btns.map(b => b.id).join() === 'cc,guide,settings' &&
              /Channels/.test(player.btns[1].label)));
  await back();
  await sleep(100);
  check(
      'standard view: Back hides the live banner first',
      await page.evaluate(
          () => livePlayer.active &&
              !document.getElementById('vodOsd').classList.contains(
                  'visible')));
  await back();
  await sleep(200);
  check(
      'Back returns the video to the channel-list layout',
      await page.evaluate(
          () => !livePlayer.active && videoPlayer.parentNode === videoArea &&
              stdFocusIdx === 2));
  await key('ArrowLeft', 37);
  check(
      'standard view: Left moves to groups column',
      await page.evaluate(
          () => stdFocusZone === 'groups' &&
              !!document.querySelector('.group-item.focused')));
  await key('ArrowDown', 40);
  await key('ArrowDown', 40);
  await key('Enter', 13);
  await sleep(300);
  check(
      'standard view: Enter on group switches group',
      await page.evaluate(() => currentGroup === groupsList[3]),
      await page.evaluate(() => currentGroup));
  await key('ArrowRight', 39);
  check(
      'standard view: Right returns to channel list',
      await page.evaluate(() => stdFocusZone === 'channels'));
  // Favorite star in place (not favorites group)
  const starBefore = await page.evaluate(
      () => renderedItems.get(0).querySelector('.favorite-star').textContent);
  await page.evaluate(
      () => renderedItems.get(0).querySelector('.favorite-star').click());
  const starAfter = await page.evaluate(
      () => renderedItems.get(0).querySelector('.favorite-star').textContent);
  check(
      'favorite star toggles in place', starBefore !== starAfter,
      `${starBefore} → ${starAfter}`);
  // Group name escaping
  check('group names are HTML-escaped', await page.evaluate(() => {
    channels[0].group = 'A&B <Sports>';
    extractGroups();
    return [...document.querySelectorAll('.group-item')].some(
               g => g.textContent.includes('A&B <Sports>')) &&
        !document.querySelector('.group-item sports');
  }));

  // ---------- Settings overlay (opened from the channel-list footer)
  // ----------
  await page.evaluate(() => {
    document.querySelectorAll('.group-item')[1].click();
  });  // All Channels (non-empty)
  await sleep(300);
  check(
      'empty group leaves no stale rows (regression)',
      await page.evaluate(() => {
        const g = currentGroup;
        currentGroup = 'no-such-group';
        renderChannelList();
        const empty = renderedItems.size === 0;
        currentGroup = g;
        renderChannelList();
        return empty && renderedItems.size > 0;
      }));
  await click('#settingsFooterBtn');
  check(
      'settings opens from footer button',
      await page.evaluate(
          () => settingsOpen &&
              !document.getElementById('settingsOverlay')
                   .classList.contains('hidden')));
  check(
      'settings: first row focused',
      await page.evaluate(
          () => document.querySelector('.settings-row.focused').dataset.id ===
              'textScale'));
  await key('ArrowLeft', 37);
  await sleep(150);
  const ts = await page.evaluate(
      () => ({
        s: settings.textScale,
        rowH: EPG_ROW_H,
        cssVar: getComputedStyle(document.documentElement)
                    .getPropertyValue('--epg-row-h')
                    .trim(),
        item: renderedItems.get(0) && renderedItems.get(0).style.height,
        stored: JSON.parse(localStorage.getItem('iptv_settings')).textScale
      }));
  check(
      'text size Left → 125%, rows and CSS var follow, persisted',
      ts.s === 1.25 && ts.rowH === 79 && ts.cssVar === '78px' &&
          ts.item === '63px' && ts.stored === 1.25,
      JSON.stringify(ts));
  await key('ArrowRight', 39);
  await sleep(150);
  check(
      'text size Right → back to 137%',
      await page.evaluate(
          () => settings.textScale === 1.375 && EPG_ROW_H === 86));
  await key('ArrowDown', 40);
  await key('ArrowRight', 39);
  await sleep(100);
  check(
      'clock Right → 24-hour, persisted',
      await page.evaluate(
          () => settings.clock === '24' &&
              JSON.parse(localStorage.getItem('iptv_settings')).clock ===
                  '24' &&
              /^\d{2}:\d{2}$/.test(formatClock(Date.now()))));
  await key('ArrowLeft', 37);
  await sleep(100);
  check(
      'clock Left → 12-hour',
      await page.evaluate(
          () => settings.clock === '12' &&
              /[AP]M$/.test(formatClock(Date.now()))));
  await key('ArrowDown', 40);
  await key('Enter', 13);
  await sleep(100);
  check(
      'auto-load toggle Enter → On, persisted',
      await page.evaluate(
          () => settings.autoLoad === true &&
              JSON.parse(localStorage.getItem('iptv_settings')).autoLoad ===
                  true));
  check(
      'per-playlist rows disabled for the demo',
      await page.evaluate(
          () => [...document.querySelectorAll('.settings-row')]
                    .filter(r => r.classList.contains('disabled'))
                    .map(r => r.dataset.id)
                    .join(',') ===
              'epgTz,epgDst,epgExtra,startGroup,resume,manageCats,refreshPlaylist'));  // the demo has no per-playlist state, cache or categories
  await back();
  check(
      'Back closes settings',
      await page.evaluate(
          () => !settingsOpen &&
              document.getElementById('settingsOverlay')
                  .classList.contains('hidden')));
  // Diagnostics overlay
  await page.evaluate(() => {
    diagLog('diag probe entry');
    openSettings();
    settingsRows().find(r => r.id === 'diag').run();
  });
  const dg = await page.evaluate(
      () => ({
        open: diagOpen,
        settings: settingsOpen,
        shown: !document.getElementById('diagOverlay')
                    .classList.contains('hidden'),
        text: document.getElementById('diagText').textContent
      }));
  check(
      'Diagnostics opens from Settings with startup marks, stream state and the logged error',
      dg.open && !dg.settings && dg.shown && /script-start \d+/.test(dg.text) &&
          /channels-applied/.test(dg.text) && /Stream: /.test(dg.text) &&
          /diag probe entry/.test(dg.text),
      dg.text.slice(0, 200).replace(/\n/g, ' | '));
  await back();
  check(
      'Back closes Diagnostics',
      await page.evaluate(
          () => !diagOpen &&
              document.getElementById('diagOverlay')
                  .classList.contains('hidden')));
  // AV sync (rooted TV only): no Homebrew service here, so the row is absent
  // and nothing is touched
  check(
      'AV sync row is hidden when the Homebrew service is unavailable',
      await page.evaluate(
          () => _hbAvailable === false &&
              !settingsRows().some(r => r.id === 'avSync') &&
              _avSyncOrig === null && settings.avSync === -1));
  const avs = await page.evaluate(() => {
    _hbAvailable = true;
    const r = settingsRows().find(r => r.id === 'avSync');
    const out = {
      rows: r && r.options.length,
      first: r && r.options[0].label,
      second: r && r.options[1].label,
      last: r && r.options[r.options.length - 1].label,
      get: r && r.get(),
      keys: [
        avSyncKeyFor('external_arc'), avSyncKeyFor('external_optical'),
        avSyncKeyFor('bt_soundbar'), avSyncKeyFor('wisa_speaker'),
        avSyncKeyFor('tv_speaker')
      ].join(),
      cmd: lunaSettingsCmd(
          'setSystemSettings',
          {category: 'sound', settings: {avSync: 'on', avSyncSpeaker: '3'}})
    };
    _hbAvailable = false;
    return out;
  });
  check(
      'AV sync row (when rooted) offers TV setting + LG\'s 0-60 range, picks the key per sound output and drives settingsservice through luna-send',
      avs.rows === 62 && avs.first === 'TV setting' && avs.second === '0' &&
          avs.last === '60' && avs.get === -1 &&
          avs.keys ===
              'avSyncSpeaker,avSyncSpdif,avSyncBtSurround,avSyncWisa,avSyncSpeaker' &&
          avs.cmd ===
              `luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings '{"category":"sound","settings":{"avSync":"on","avSyncSpeaker":"3"}}'`,
      JSON.stringify(avs));
  await key('ColorF2Yellow', 405);
  check('Yellow key opens settings', await page.evaluate(() => settingsOpen));
  // Clear favorites via confirm dialog
  await page.evaluate(() => {
    favoriteIds.add('x1');
    favoriteIds.add('x2');
    renderSettings();
  });
  await page.evaluate(() => {
    settingsFocusIdx =
        settingsFocusables(_settingsRowsCache).indexOf('clearFavs');
    renderSettings();
  });
  await key('Enter', 13);
  check(
      'Clear favorites opens confirm dialog',
      await page.evaluate(() => !confirmDialog.classList.contains('hidden')));
  await key('ArrowLeft', 37);
  await key('Enter', 13);
  await sleep(100);
  check(
      'confirm Yes clears favorites, settings still open',
      await page.evaluate(
          () => favoriteIds.size === 0 && settingsOpen &&
              JSON.parse(localStorage.getItem(
                  'iptv_playlist_state'))[_activePlaylistKey]
                      .favs.length === 0));
  await back();

  // ---------- hls.js live engine: takes HLS channels when the buffer is on,
  // falls back to native on a fatal error ---------- (the demo playlist is
  // loaded here; its channels are .m3u8 URLs) State is captured in the same
  // evaluate as the selection: the dead manifest makes hls.js hand over to
  // native within milliseconds
  const eng = await page.evaluate(() => {
    settings.liveBuffer = 5;
    settings.liveEngine = 'hls';  // the default is Shaka Player since 3.14.1
    saveSettings();
    channels[2].url = 'http://localhost:8765/no-such-stream/live.m3u8';
    selectChannel(2);
    return {
      hls: liveEngineActive(),
      url: liveEngine.url,
      src: videoPlayer.getAttribute('src') || '',
      ums: liveUms === null,
      row: settingsRows().find(r => r.id === 'liveBuffer').get()
    };
  });
  check(
      'rewind buffer on: hls.js owns the HLS channel (MediaSource src, media service released)',
      eng.hls && /\.m3u8$/.test(eng.url) && /^blob:/.test(eng.src) && eng.ums &&
          eng.row === 5,
      JSON.stringify(eng));
  await page
      .waitForFunction(
          () => !liveEngineActive() &&
              /no-such-stream/.test(videoPlayer.getAttribute('src') || ''),
          {timeout: 40000})
      .catch(() => {});
  const hlsFb =
      await page.evaluate(() => ({
                            hls: liveEngineActive(),
                            broken: [..._hlsBroken],
                            src: videoPlayer.getAttribute('src') || '',
                            url: channels[currentChannelIndex].url
                          }));
  // A network failure is not held against the channel (no _hlsBroken entry);
  // only media/mux/manifest-parse errors are
  check(
      'fatal hls.js network error (dead playlist) hands the channel to the native player without marking it incompatible',
      !hlsFb.hls && hlsFb.broken.length === 0 && hlsFb.src === hlsFb.url,
      JSON.stringify(hlsFb));
  // Let the native player exhaust its reload budget on that dead channel, then
  // clear the toast it leaves behind
  await page
      .waitForFunction(
          () => document.getElementById('epgToastTitle').textContent ===
              'Stream Error',
          {timeout: 25000})
      .catch(() => {});
  // Frame rate on the hls.js path is counted from the remuxed segments (the
  // playlist states none, like the provider's)
  const fpsOrigUrl = await page.evaluate(() => {
    const u = channels[1].url;
    channels[1].url = 'http://localhost:8765/hls50/index.m3u8';
    selectChannel(1);
    return u;
  });
  await page.waitForFunction(() => liveEngine.fps > 0, {timeout: 20000})
      .catch(() => {});
  const fps = await page.evaluate(
      () => ({
        rec: streamTechOf(channels[1], 1),
        hls: liveEngineActive(),
        fps: liveEngine.fps,
        samples: liveEngine.fpsSamples.map(x => +x.toFixed(2)),
        tech: liveEngine.tech,
        lvl: liveEngine.hls && liveEngine.hls.levels[0] &&
            liveEngine.hls.levels[0].frameRate,
        live:
            !!(liveEngine.hls && liveEngine.hls.levels[0] &&
               liveEngine.hls.levels[0].details &&
               liveEngine.hls.levels[0].details.live),
        snap: [fpsSnap(29.95), fpsSnap(23.98), fpsSnap(49.6), fpsSnap(37.2)],
        fmt: [fmtFps(29.97), fmtFps(23.976), fmtFps(50)]
      }));
  check(
      'hls.js path measures the frame rate from segment samples when the playlist has no FRAME-RATE; shown on the codec line',
      fps.hls && !fps.lvl && fps.fps === 50 && /· 50 fps ·/.test(fps.tech) &&
          fps.rec && fps.rec.w === 320 && fps.rec.h === 180 &&
          fps.rec.fps === 50 && fps.snap.join() === '29.97,23.976,50,37' &&
          fps.fmt.join() === '29.97 fps,23.976 fps,50 fps',
      JSON.stringify(fps));
  // The fixture ends with #EXT-X-ENDLIST, like the first playlist of a cold
  // provider relay; the live playlist loader removes it
  check(
      'hls.js live playlist with #EXT-X-ENDLIST stays live (cold relay)',
      fps.live, JSON.stringify(fps));
  // A relay that restarts sends MEDIA-SEQUENCE 0 again with a different
  // segment. hls.js starts again on the same URL and keeps the channel.
  await page.evaluate(() => {
    channels[1].url =
        'http://localhost:8765/hlsrestart/index.m3u8?r=' + Date.now();
    selectChannel(1);
  });
  await page
      .waitForFunction(
          () => _hlsRelayRestart.n >= 1 && liveEngineActive() &&
              liveEngine.hls.levels[0] && liveEngine.hls.levels[0].details,
          {timeout: 30000})
      .catch(() => {});
  const relay = await page.evaluate(() => ({
                                      n: _hlsRelayRestart.n,
                                      hls: liveEngineActive(),
                                      broken: _hlsBroken.size,
                                      url: liveEngine.url,
                                      log: _diagLog.slice(-3).map(d => d.msg)
                                    }));
  check(
      'hls.js starts again on the same URL after a relay restart (media sequence mismatch)',
      relay.n >= 1 && relay.hls && relay.broken === 0 &&
          /\/hlsrestart\//.test(relay.url) &&
          relay.log.some(m => /relay restart/.test(m)),
      JSON.stringify(relay));
  // A relay that is not ready answers "Cannot read ..._.m3u8". The
  // playlist loader requests the playlist again each 3 s, and hls.js gets
  // no error.
  await page.evaluate(() => {
    _hlsRelayRestart.url = '';
    _hlsRelayRestart.n = 0;
    channels[1].url =
        'http://localhost:8765/hlscold/index.m3u8?r=' + Date.now();
    selectChannel(1);
  });
  await page
      .waitForFunction(
          () => liveEngineActive() && liveEngine.hls.levels[0] &&
              liveEngine.hls.levels[0].details,
          {timeout: 30000})
      .catch(() => {});
  const cold = await page.evaluate(() => {
    return {
      waits: liveEngine.relayWaits,
      restarts: _hlsRelayRestart.n,
      hls: liveEngineActive(),
      src: videoPlayer.getAttribute('src') || '',
      reloads: _reloadAttempts,
      log: _diagLog.slice(-3).map(d => d.msg)
    };
  });
  check(
      'hls.js waits for a relay that is not ready: no error, restart, or reload',
      cold.waits === 1 && cold.restarts === 0 && cold.hls &&
          !/hlscold/.test(cold.src) && cold.reloads === 0 &&
          cold.log.some(m => /waits for the relay/.test(m)),
      JSON.stringify(cold));
  // A relay that answers "Cannot read" between 2 good playlists: hls.js
  // keeps the same instance and gets the next playlist.
  await page.evaluate(() => {
    window.__flapErrors = 0;
    channels[1].url =
        'http://localhost:8765/hlsflap/index.m3u8?r=' + Date.now();
    selectChannel(1);
    window.__flapHls = liveEngine.hls;
    liveEngine.hls.on(Hls.Events.ERROR, (_, d) => {
      if (d.fatal) window.__flapErrors++;
    });
  });
  await page
      .waitForFunction(
          () => liveEngine.hls === window.__flapHls &&
              liveEngine.hls.levels[0] && liveEngine.hls.levels[0].details &&
              liveEngine.hls.levels[0].details.fragments.length === 3,
          {timeout: 30000})
      .catch(() => {});
  const flap = await page.evaluate(() => {
    const d = liveEngine.hls && liveEngine.hls.levels[0] &&
        liveEngine.hls.levels[0].details;
    return {
      same: liveEngine.hls === window.__flapHls,
      frags: d && d.fragments.length,
      fatal: window.__flapErrors,
      restarts: _hlsRelayRestart.n
    };
  });
  check(
      'a "Cannot read" playlist reload keeps hls.js and its playlist',
      flap.same && flap.frags === 3 && flap.fatal === 0 && flap.restarts === 0,
      JSON.stringify(flap));
  // An event that is finished: the provider sends only black.ts. The app
  // tells why the picture is black.
  await page.evaluate(() => {
    document.getElementById('epgToastTitle').textContent = '';
    channels[1].url = 'http://localhost:8765/hlsblack/index.m3u8';
    selectChannel(1);
  });
  await page
      .waitForFunction(
          () => !document.getElementById('liveNotice')
                     .classList.contains('hidden'),
          {timeout: 15000})
      .catch(() => {});
  const black = await page.evaluate(() => {
    const n = document.getElementById('liveNotice');
    return {
      title: n.querySelector('.live-notice-title').textContent,
      inFrame: n.parentNode === videoPlayer.parentNode,
      toast: document.getElementById('epgToastTitle').textContent,
      placeholder: liveEngine.placeholder,
      status: statusArea.innerText,
      log: _diagLog.some(e => /placeholder \(black\.ts\)/.test(e.msg))
    };
  });
  check(
      'a playlist with only black.ts shows "No broadcast" in the video frame',
      black.title === 'No broadcast' && black.inFrame &&
          black.toast !== 'No broadcast' && black.placeholder &&
          /not on the air/.test(black.status) && black.log,
      JSON.stringify(black));
  // The watchdog does not reload a placeholder: a reload cannot start the
  // event
  const blackHls = await page.evaluate(() => {
    window.__blackHls = liveEngine.hls;
    return _reloadAttempts;
  });
  await sleep(14000);
  const blackAfter = await page.evaluate(
      () => ({
        same: liveEngine.hls === window.__blackHls,
        reloads: _reloadAttempts,
        pattern: [
          'black.ts', '/a/video/black.ts?x=1', 'notblack.ts', '/a/seg1.ts'
        ].map(u => HLS_PLACEHOLDER_SEGMENT.test(u))
      }));
  check(
      'the watchdog does not reload a black.ts placeholder; the pattern accepts a relative URI',
      blackAfter.same && blackAfter.reloads === blackHls &&
          blackAfter.pattern.join() === 'true,true,false,false',
      JSON.stringify(blackAfter));
  await page.evaluate(u => {
    channels[1].url = u;
    settings.liveBuffer = 0;
    saveSettings();
    _hlsBroken.clear();
    document.getElementById('epgToastTitle').textContent = '';
  }, fpsOrigUrl);
  check(
      'rewind buffer Off again: next channel load is native',
      await page.evaluate(() => {
        selectChannel(3);
        return !liveEngineActive() &&
            document.getElementById('liveNotice').classList.contains(
                'hidden') &&
            (videoPlayer.getAttribute('src') || '') === channels[3].url;
      }));

  // ---------- Shaka Player live engine: the setting "Live engine" selects it
  // for HLS channels, with the same provider workarounds and the same native
  // fallback ----------
  check(
      'Shaka Player loaded; it is the default live engine (settings schema 5)',
      await page.evaluate(
          () => typeof shaka !== 'undefined' &&
              shaka.Player.isBrowserSupported() &&
              DEFAULT_SETTINGS.liveEngine === 'shaka' &&
              DEFAULT_SETTINGS.schema === 5 &&
              LIVE_ENGINE_OPTIONS[0].v === 'shaka' &&
              settingsRows().some(r => r.id === 'liveEngine')));
  // The migration: an app with the previous default (hls, schema 4) gets
  // Shaka Player 1 time; a selection with schema 5 stays
  const smig = await page.evaluate(() => {
    const key = 'iptv_settings';
    const saved = localStorage.getItem(key);
    const out = {};
    localStorage.setItem(key, JSON.stringify({liveEngine: 'hls', schema: 4}));
    let s = loadSettings();
    out.migrated = s.liveEngine === 'shaka' && s.schema === 5;
    localStorage.setItem(key, JSON.stringify({liveEngine: 'hls', schema: 5}));
    s = loadSettings();
    out.kept = s.liveEngine === 'hls';
    localStorage.setItem(key, '{}');
    out.fresh = loadSettings().liveEngine === 'shaka';
    if (saved === null)
      localStorage.removeItem(key);
    else
      localStorage.setItem(key, saved);
    return out;
  });
  check(
      'settings schema 5: the previous default hls becomes Shaka Player 1 time',
      smig.migrated && smig.kept && smig.fresh, JSON.stringify(smig));
  const shk = await page.evaluate(() => {
    settings.liveEngine = 'shaka';
    settings.liveBuffer = 5;
    saveSettings();
    channels[1].url = 'http://localhost:8765/hls50/index.m3u8';
    selectChannel(1);
    return {
      engine: liveMseEngine(),
      active: liveEngineActive(),
      name: liveEngineName(),
      shaka: !!liveEngine.shaka,
      hls: !!liveEngine.hls,
      url: liveEngine.url,
      ums: liveUms === null,
      row: settingsRows().find(r => r.id === 'liveEngine').get()
    };
  });
  check(
      'live engine Shaka Player: it owns the HLS channel (media service released)',
      shk.engine === 'shaka' && shk.active && shk.shaka && !shk.hls &&
          shk.name === 'Shaka Player' && /hls50/.test(shk.url) && shk.ums &&
          shk.row === 'shaka',
      JSON.stringify(shk));
  await page
      .waitForFunction(
          () =>
              liveEngine.shaka && liveEngine.fps > 0 && liveEngine.bitrate > 0,
          {timeout: 20000})
      .catch(() => {});
  const sfps = await page.evaluate(
      () => ({
        fps: liveEngine.fps,
        samples: liveEngine.fpsSamples.map(x => +x.toFixed(2)),
        tech: liveEngine.tech,
        bitrate: liveEngine.bitrate,
        reach: liveEngine.reach,
        // Shaka Player attaches its MediaSource with a <source> child
        src: videoPlayer.currentSrc || '',
        attr: videoPlayer.getAttribute('src') || '',
        live: !!(liveEngine.shaka && liveEngine.shaka.isLive()),
        rec: streamTechOf(channels[1], 1),
        goal: liveEngine.shaka &&
            liveEngine.shaka.getConfiguration().streaming.bufferingGoal,
        trackId: liveEngine.videoTrackId,
        // The measured rate, never the estimate of the variant track
        fpsFn: liveEngineFps(),
        log: _diagLog.slice(-3).map(d => d.msg)
      }));
  check(
      'Shaka Player path: frame rate from the appended samples, bitrate, codec line',
      sfps.fps === 50 && /H\.264 · .*50 fps · \d+ kbps/.test(sfps.tech) &&
          sfps.bitrate > 0 && /^blob:/.test(sfps.src) && !sfps.attr &&
          sfps.rec && sfps.rec.fps === 50 && sfps.goal > 0 &&
          sfps.reach === 5 && sfps.fpsFn === 50,
      JSON.stringify(sfps));
  // A movie after a Shaka Player channel: the VOD source, the media service
  // attach, and the play wait for the asynchronous destroy (the demo playlist
  // is M3U, thus the Xtream state is set for the call)
  const svod = await page.evaluate(async () => {
    const xt = _xt;
    _xt = xt || {base: 'http://localhost:8765', user: 'user', pass: 'pass'};
    startVodPlayback({kind: 'movie', item: {id: 1, name: 'Movie', ext: 'mp4'}});
    const out = {active: vodPlay.active, shaka: !!liveEngine.shaka};
    out.srcBefore = videoPlayer.getAttribute('src') || '';
    await new Promise(r => setTimeout(r, 1500));
    out.src = videoPlayer.getAttribute('src') || '';
    out.teardown = !!_shakaTeardown;
    out.paused = videoPlayer.paused;
    stopVodPlayback(false);
    _xt = xt;
    return out;
  });
  check(
      'a movie after a Shaka Player channel keeps its source after the detach',
      svod.active && !svod.shaka &&
          /\/movie\/user\/pass\/1\.mp4$/.test(svod.src) && !svod.teardown,
      JSON.stringify(svod));
  // The fixture ends with #EXT-X-ENDLIST and has PLAYLIST-TYPE:VOD, like the
  // first playlist of a cold relay; the response filter removes both
  check(
      'Shaka Player live playlist with #EXT-X-ENDLIST stays live (cold relay)',
      sfps.live, JSON.stringify(sfps));
  // A dead playlist: a network error hands the channel to the native player
  // without marking it incompatible
  await page.evaluate(() => {
    channels[2].url = 'http://localhost:8765/no-such-stream/live.m3u8';
    selectChannel(2);
  });
  await page
      .waitForFunction(
          () => !liveEngineActive() &&
              /no-such-stream/.test(videoPlayer.getAttribute('src') || ''),
          {timeout: 40000})
      .catch(() => {});
  const sfb = await page.evaluate(() => ({
                                    active: liveEngineActive(),
                                    broken: [..._hlsBroken],
                                    src: videoPlayer.getAttribute('src') || '',
                                    url: channels[currentChannelIndex].url,
                                    log: _diagLog.slice(-4).map(d => d.msg)
                                  }));
  // The native pipeline then fails on the same URL, and its own failure
  // replaces `_lastStreamFail`; the log keeps the Shaka Player entry
  check(
      'fatal Shaka Player network error (dead playlist) hands the channel to native',
      !sfb.active && sfb.broken.length === 0 && sfb.src === sfb.url &&
          sfb.log.some(
              m =>
                  /Shaka Player fatal 1\/BAD_HTTP_STATUS HTTP 404 reply: /.test(
                      m)),
      JSON.stringify(sfb));
  await page
      .waitForFunction(
          () => document.getElementById('epgToastTitle').textContent ===
              'Stream Error',
          {timeout: 25000})
      .catch(() => {});
  // A relay that restarts: the response filter sees MEDIA-SEQUENCE 0 again
  // with a different segment, and Shaka Player starts again on the same URL
  await page.evaluate(() => {
    _hlsRelayRestart.url = '';
    _hlsRelayRestart.n = 0;
    channels[1].url =
        'http://localhost:8765/hlsrestart/index.m3u8?r=' + Date.now();
    selectChannel(1);
  });
  await page
      .waitForFunction(
          () => _hlsRelayRestart.n >= 1 && liveEngine.shaka &&
              liveEngine.shaka.isLive(),
          {timeout: 30000})
      .catch(() => {});
  const srelay = await page.evaluate(() => ({
                                       n: _hlsRelayRestart.n,
                                       shaka: !!liveEngine.shaka,
                                       broken: _hlsBroken.size,
                                       url: liveEngine.url,
                                       log: _diagLog.slice(-3).map(d => d.msg)
                                     }));
  check(
      'Shaka Player starts again on the same URL after a relay restart',
      srelay.n >= 1 && srelay.shaka && srelay.broken === 0 &&
          /\/hlsrestart\//.test(srelay.url) &&
          srelay.log.some(
              m => /Player restarted after a relay restart/.test(m)),
      JSON.stringify(srelay));
  // A channel whose transmuxed video the browser does not buffer (no IDR
  // slice): after 3 video segments with an empty video buffer, the channel is
  // incompatible, and the native pipeline plays it
  await page.evaluate(() => {
    channels[1].url = 'http://localhost:8765/hls50noidr/index.m3u8';
    selectChannel(1);
  });
  await page
      .waitForFunction(
          () => _hlsBroken.size >= 1 && !liveEngine.shaka &&
              /hls50noidr/.test(videoPlayer.currentSrc || ''),
          {timeout: 30000})
      .catch(() => {});
  const snovid = await page.evaluate(() => {
    const r = {
      broken: _hlsBroken.size,
      shaka: !!liveEngine.shaka,
      src: videoPlayer.currentSrc || '',
      fail: _lastStreamFail && _lastStreamFail.what,
      log: _diagLog.slice(-3).map(d => d.msg)
    };
    _hlsBroken.clear();
    return r;
  });
  check(
      'Shaka Player hands a channel with an empty video buffer to the native pipeline',
      snovid.broken === 1 && !snovid.shaka &&
          /\/hls50noidr\//.test(snovid.src) &&
          /no video after 3 segments/.test(snovid.fail || '') &&
          snovid.log.some(m => /video buffer is empty/.test(m)),
      JSON.stringify(snovid));
  // A relay that restarts and whose first URL answers HTTP 509 on each
  // refresh: after 2 recoverable errors, Shaka Player starts again on the URL
  await page.evaluate(() => {
    _hlsRelayRestart.url = '';
    _hlsRelayRestart.n = 0;
    channels[1].url =
        'http://localhost:8765/hlsdead/index.m3u8?r=' + Date.now();
    selectChannel(1);
  });
  await page
      .waitForFunction(
          () => _hlsRelayRestart.n >= 1 && liveEngine.shaka &&
              liveEngine.shaka.isLive() && liveEngine.segments >= 1,
          {timeout: 40000})
      .catch(() => {});
  const sdead = await page.evaluate(() => ({
                                      n: _hlsRelayRestart.n,
                                      shaka: !!liveEngine.shaka,
                                      broken: _hlsBroken.size,
                                      url: liveEngine.url,
                                      segments: liveEngine.segments,
                                      log: _diagLog.slice(-4).map(d => d.msg)
                                    }));
  check(
      'Shaka Player starts again when the playlist refresh answers HTTP 509',
      sdead.n >= 1 && sdead.shaka && sdead.broken === 0 &&
          sdead.segments >= 1 && /\/hlsdead\//.test(sdead.url) &&
          sdead.log.some(
              m => /refresh failed \(BAD_HTTP_STATUS HTTP 509\)/.test(m)),
      JSON.stringify(sdead));
  // A relay that is not ready: the filter requests the playlist again each
  // 3 s, and Shaka Player gets no error
  await page.evaluate(() => {
    _hlsRelayRestart.url = '';
    _hlsRelayRestart.n = 0;
    channels[1].url =
        'http://localhost:8765/hlscold/index.m3u8?r=' + Date.now();
    selectChannel(1);
  });
  await page
      .waitForFunction(
          () => liveEngine.shaka && liveEngine.shaka.isLive(), {timeout: 30000})
      .catch(() => {});
  const scold = await page.evaluate(() => ({
                                      waits: liveEngine.relayWaits,
                                      restarts: _hlsRelayRestart.n,
                                      shaka: !!liveEngine.shaka,
                                      src: videoPlayer.currentSrc || '',
                                      reloads: _reloadAttempts,
                                      log: _diagLog.slice(-3).map(d => d.msg)
                                    }));
  check(
      'Shaka Player waits for a relay that is not ready: no error, restart, or reload',
      scold.waits === 1 && scold.restarts === 0 && scold.shaka &&
          /^blob:/.test(scold.src) && scold.reloads === 0 &&
          scold.log.some(m => /Shaka Player waits for the relay/.test(m)),
      JSON.stringify(scold));
  // A poll of the filter that is rejected (HTTP 509): the count of the raw
  // requests goes back, and the next playlist of Shaka Player gets the filter
  await page.evaluate(() => {
    channels[1].url =
        'http://localhost:8765/hlscold/index.m3u8?fail=1&r=' + Date.now();
    selectChannel(1);
  });
  await page
      .waitForFunction(
          () => liveEngine.shaka && liveEngine.shaka.isLive(), {timeout: 30000})
      .catch(() => {});
  const sfail = await page.evaluate(() => ({
                                      shaka: !!liveEngine.shaka,
                                      live: !!(liveEngine.shaka &&
                                               liveEngine.shaka.isLive()),
                                      raw: [..._shakaRaw.values()],
                                      waits: liveEngine.relayWaits,
                                      restarts: _hlsRelayRestart.n
                                    }));
  check(
      'a rejected poll of the filter keeps no raw request count',
      sfail.shaka && sfail.live && sfail.raw.every(v => v === 0) &&
          sfail.waits === 1 && sfail.restarts === 0,
      JSON.stringify(sfail));
  // "Cannot read" between 2 good playlists: the same player gets the last good
  // playlist, then the next one
  await page.evaluate(() => {
    window.__flapErrors = 0;
    channels[1].url =
        'http://localhost:8765/hlsflap/index.m3u8?r=' + Date.now();
    selectChannel(1);
    window.__flapShaka = liveEngine.shaka;
    liveEngine.shaka.addEventListener('error', () => window.__flapErrors++);
  });
  await page
      .waitForFunction(
          () => liveEngine.shaka === window.__flapShaka &&
              [..._hlsLastPlaylist.values()].some(
                  t => t.split('#EXTINF').length === 4),
          {timeout: 30000})
      .catch(() => {});
  const sflap =
      await page.evaluate(() => ({
                            same: liveEngine.shaka === window.__flapShaka,
                            three: [..._hlsLastPlaylist.values()].some(
                                t => t.split('#EXTINF').length === 4),
                            fatal: window.__flapErrors,
                            restarts: _hlsRelayRestart.n,
                            waits: liveEngine.relayWaits
                          }));
  check(
      'a "Cannot read" playlist reload keeps Shaka Player and its playlist',
      sflap.same && sflap.three && sflap.fatal === 0 && sflap.restarts === 0 &&
          sflap.waits === 0,
      JSON.stringify(sflap));
  // A finished event: only black.ts. The app tells why, and the watchdog does
  // not reload
  await page.evaluate(() => {
    document.getElementById('epgToastTitle').textContent = '';
    channels[1].url = 'http://localhost:8765/hlsblack/index.m3u8';
    selectChannel(1);
  });
  await page
      .waitForFunction(
          () => !document.getElementById('liveNotice')
                     .classList.contains('hidden'),
          {timeout: 15000})
      .catch(() => {});
  const sblack = await page.evaluate(() => {
    window.__blackShaka = liveEngine.shaka;
    const n = document.getElementById('liveNotice');
    const slot = n.parentNode === videoPlayer.parentNode;
    enterLivePlayer();
    const inPlayer = n.parentNode === document.getElementById('vodPlayer');
    exitLivePlayer();
    return {
      title: n.querySelector('.live-notice-title').textContent,
      frame: slot && inPlayer && n.parentNode === videoPlayer.parentNode,
      placeholder: liveEngine.placeholder,
      shaka: !!liveEngine.shaka,
      reloads: _reloadAttempts
    };
  });
  await sleep(14000);
  const sblackAfter =
      await page.evaluate(() => ({
                            same: liveEngine.shaka === window.__blackShaka,
                            reloads: _reloadAttempts
                          }));
  check(
      'Shaka Player: a black.ts playlist shows "No broadcast" and gets no reload',
      sblack.title === 'No broadcast' && sblack.frame && sblack.placeholder &&
          sblack.shaka &&
          sblackAfter.same && sblackAfter.reloads === sblack.reloads,
      JSON.stringify({sblack, sblackAfter}));
  // A channel change keeps the 1 Shaka Player of the app: no detach, no
  // destroy, and a new load on the same player
  const sre0 = await page.evaluate(() => {
    window.__shakaApp = _shakaPlayer;
    const n = _shakaLoads;
    channels[1].url = 'http://localhost:8765/hls50/index.m3u8';
    selectChannel(1);
    return {
      n,
      teardown: !!_shakaTeardown,
      same: liveEngine.shaka === _shakaPlayer
    };
  });
  await page
      .waitForFunction(
          () => liveEngine.shaka && liveEngine.shaka.isLive() &&
              liveEngine.segments >= 1,
          {timeout: 20000})
      .catch(() => {});
  const sre = await page.evaluate(() => ({
                                    same: _shakaPlayer === window.__shakaApp,
                                    loads: _shakaLoads,
                                    live: !!(liveEngine.shaka &&
                                             liveEngine.shaka.isLive()),
                                    src: videoPlayer.currentSrc || ''
                                  }));
  check(
      'Shaka Player: a channel change loads on the same player, with no detach',
      sre0.same && !sre0.teardown && sre.same && sre.loads === sre0.n + 1 &&
          sre.live && /^blob:/.test(sre.src),
      JSON.stringify({sre0, sre}));
  // The background: the request filter holds the requests, and the player and
  // its buffer stay. The release lets the requests continue.
  const shold0 = await page.evaluate(() => {
    window.__shakaReqs = 0;
    liveEngine.shaka.getNetworkingEngine().registerRequestFilter(() => {
      window.__shakaReqs++;
    });
    shakaHoldRequests();
    return videoPlayer.buffered.length;
  });
  await sleep(5000);
  const sheld = await page.evaluate(() => ({
                                      reqs: window.__shakaReqs,
                                      buffered: videoPlayer.buffered.length,
                                      same: liveEngine.shaka === _shakaPlayer
                                    }));
  await page.evaluate(() => shakaReleaseRequests());
  await page
      .waitForFunction(() => window.__shakaReqs > 0, {timeout: 10000})
      .catch(() => {});
  const sfree = await page.evaluate(() => window.__shakaReqs);
  check(
      'Shaka Player: held requests wait, the buffer stays, and a release continues',
      shold0 > 0 && sheld.reqs === 0 && sheld.buffered > 0 && sheld.same &&
          sfree > 0,
      JSON.stringify({shold0, sheld, sfree}));
  // The buffer fit changes only the values that the goal sets
  const sfit = await page.evaluate(() => {
    const p = liveEngine.shaka, was = liveEngine.bitrate;
    liveEngine.bitrate = 100e6;
    shakaFitBuffer(p);
    const c = p.getConfiguration();
    const out = {
      goal: c.streaming.bufferingGoal,
      behind: c.streaming.bufferBehind,
      window: c.manifest.availabilityWindowOverride,
      retries: c.streaming.retryParameters.maxAttempts,
      delay: c.manifest.hls.liveSegmentsDelay
    };
    liveEngine.bitrate = was;
    shakaFitBuffer(p);
    return out;
  });
  check(
      'Shaka Player buffer fit: goal, behind, and window change; the rest stays',
      sfit.goal === 10 && sfit.behind === 10 && sfit.window === 20 &&
          sfit.retries === 4 && sfit.delay === 3,
      JSON.stringify(sfit));
  // Diagnostics shows the statistics of Shaka Player, "Go live" uses
  // goToLive(), and a closed caption track has its own label
  const sstat = await page.evaluate(() => {
    const line = shakaStatsLine();
    videoPlayer.currentTime = liveBufferRange().start;
    const behind = liveBehindSecs();
    liveGoLive();
    return {
      line,
      diag: diagLines().includes(line),
      behind,
      after: liveBehindSecs(),
      cc: shakaTextLabel(
          {mimeType: 'application/cea-608', originalTextId: 'CC1'}, 0),
      ccLang: shakaTextLabel(
          {mimeType: 'application/cea-708', originalTextId: 'svc1',
           language: 'en'},
          0),
      sub: shakaTextLabel({mimeType: 'text/vtt', language: 'en'}, 0)
    };
  });
  check(
      'Shaka Player: statistics in Diagnostics, goToLive, and closed caption labels',
      /^Shaka Player: frames \d+ decoded, \d+ dropped/.test(sstat.line) &&
          sstat.diag && sstat.behind > 1 && sstat.after < 1 &&
          sstat.cc === 'Closed captions (CC1)' &&
          sstat.ccLang === 'Closed captions (svc1) · English' &&
          sstat.sub === 'English',
      JSON.stringify(sstat));
  // A catch-up with Shaka Player as the engine: the archive as HLS, played
  // as a VOD playlist from its start position. With no HLS archive (HTTP 404),
  // the catch-up continues with the .ts URL on the native pipeline.
  const scu0 = await page.evaluate(() => {
    window.__cuXt = _xt;
    _xt = {
      base: 'http://localhost:8765',
      user: 'user',
      pass: 'pass',
      u: 'user',
      pw: 'pass',
      tz: 'UTC',
      epgOffsetMin: 0
    };
    const ch = channels[1];
    window.__cuCh = {streamId: ch.streamId, archive: ch.archive};
    ch.streamId = 50;
    ch.archive = 1;
    const now = Date.now();
    startCatchup(1, {start: now - 3600000, stop: now - 1800000, title: 'P'}, 2);
    return {url: catchup && catchup.url, shaka: !!liveEngine.shaka};
  });
  await page
      .waitForFunction(
          () => liveEngine.shaka && liveEngine.shaka.getManifest() &&
              videoPlayer.readyState >= 1,
          {timeout: 20000})
      .catch(() => {});
  const scu = await page.evaluate(() => ({
                                    live: liveEngine.shaka &&
                                        liveEngine.shaka.isLive(),
                                    t: videoPlayer.currentTime,
                                    range: _seekRange()
                                  }));
  check(
      'catch-up with Shaka Player: the archive as HLS (VOD) from its position',
      /\/timeshift\/user\/pass\/30\/[\d:-]+\/50\.m3u8$/.test(scu0.url) &&
          scu0.shaka && scu.live === false && scu.t >= 1.5 &&
          scu.range.start === 0 && scu.range.end >= 5,
      JSON.stringify({scu0, scu}));
  await page.evaluate(() => {
    channels[1].streamId = 404;
    const now = Date.now();
    startCatchup(1, {start: now - 3600000, stop: now - 1800000, title: 'P'});
  });
  await page
      .waitForFunction(
          () => !liveEngine.shaka &&
              /\/404\.ts$/.test(videoPlayer.getAttribute('src') || ''),
          {timeout: 20000})
      .catch(() => {});
  const scuf = await page.evaluate(() => {
    const out = {
      failed: _catchupHlsFailed,
      url: catchup && catchup.url,
      src: videoPlayer.getAttribute('src') || '',
      next: catchupExt(),
      log: _diagLog.slice(-3).map(d => d.msg)
    };
    _catchupHlsFailed = false;
    channels[1].streamId = window.__cuCh.streamId;
    channels[1].archive = window.__cuCh.archive;
    catchupBackToLive();
    exitLivePlayer();  // startCatchup opened the live player
    _xt = window.__cuXt;
    return out;
  });
  check(
      'catch-up with no HLS archive continues with the .ts URL on the native pipeline',
      scuf.failed && /\/404\.ts$/.test(scuf.url) && scuf.src === scuf.url &&
          scuf.next === 'ts' &&
          scuf.log.some(m => /cannot play the archive as HLS/.test(m)),
      JSON.stringify(scuf));
  // Error classes (unit-level): the reply that is not a playlist is a network
  // failure; unsupported content marks the channel; a recoverable error and an
  // interrupted load are ignored
  const serr = await page.evaluate(() => {
    const E = shaka.util.Error;
    const fake = () => ({
      detach() {
        return Promise.resolve();
      }
    });
    const out = {};
    liveEngineDestroy();  // the real player of the previous check
    let u = 'http://shaka.test/html.m3u8';
    liveEngine.shaka = fake();
    liveEngine.url = u;
    liveEngine.lastReply = '<html><body>Max connections reached</body></html>';
    onShakaError(
        u,
        new E(
            E.Severity.CRITICAL, E.Category.MANIFEST,
            E.Code.HLS_PLAYLIST_HEADER_MISSING, u));
    out.html = _hlsBroken.has(u);
    out.htmlGone = !liveEngine.shaka;
    u = 'http://xt.test/live/user/pass/777.m3u8';
    liveEngine.shaka = fake();
    liveEngine.url = u;
    onShakaError(
        u,
        new E(
            E.Severity.CRITICAL, E.Category.MANIFEST,
            E.Code.CONTENT_UNSUPPORTED_BY_BROWSER));
    out.unsupported = _hlsBroken.has(u);
    out.ts = nativeLiveUrl(u);
    u = 'http://shaka.test/rec.m3u8';
    liveEngine.shaka = fake();
    liveEngine.url = u;
    onShakaError(
        u,
        new E(
            E.Severity.RECOVERABLE, E.Category.NETWORK, E.Code.HTTP_ERROR, u));
    out.recoverableKept = !!liveEngine.shaka;
    onShakaError(
        u,
        new E(E.Severity.CRITICAL, E.Category.PLAYER, E.Code.LOAD_INTERRUPTED));
    out.interruptedKept = !!liveEngine.shaka;
    liveEngineDestroy();
    out.log = _diagLog.map(e => e.msg)
                  .filter(m => /Shaka Player fatal/.test(m))
                  .slice(-2);
    out.names = [shakaCodeName(E.Code.BAD_HTTP_STATUS), shakaCodeName(-5)];
    return out;
  });
  check(
      'Shaka Player errors: HTML reply = network failure; unsupported content marks',
      !serr.html && serr.htmlGone && serr.unsupported &&
          serr.ts === 'http://xt.test/live/user/pass/777.ts' &&
          serr.recoverableKept && serr.interruptedKept &&
          /4\/HLS_PLAYLIST_HEADER_MISSING reply: <html>.*not a playlist/.test(
              serr.log[0]) &&
          /4\/CONTENT_UNSUPPORTED_BY_BROWSER/.test(serr.log[1]) &&
          serr.names.join() === 'BAD_HTTP_STATUS,-5',
      JSON.stringify(serr));
  // The detaches of Shaka Player make a chain: a fast detach cannot end before
  // a slow detach, and the next source waits for the two (unit-level)
  const stear = await page.evaluate(async () => {
    await (_shakaTeardown || Promise.resolve());
    const order = [];
    liveEngine.shaka = {
      detach: () => new Promise(r => setTimeout(() => {
                                   order.push('slow');
                                   r();
                                 }, 300))
    };
    liveEngineDestroy();
    liveEngine.shaka = {
      detach: () => {
        order.push('fast');
        return Promise.resolve();
      }
    };
    liveEngineDestroy();
    await new Promise(r => afterLiveTeardown(() => {
      order.push('next');
      r();
    }));
    return {order, pending: !!_shakaTeardown};
  });
  check(
      'Shaka detaches make a chain: the next source waits for the slow one',
      stear.order.join() === 'slow,fast,next' && !stear.pending,
      JSON.stringify(stear));
  // The request type of a recoverable network error is at a different index
  // of `data` for each code; only a MANIFEST request counts as a failed
  // playlist refresh (unit-level)
  const sreq = await page.evaluate(() => {
    const E = shaka.util.Error, RT = shaka.net.NetworkingEngine.RequestType;
    const u = 'http://shaka.test/refresh.m3u8';
    const fake = () => ({
      detach() {
        return Promise.resolve();
      }
    });
    const err = (code, ...data) =>
        new E(E.Severity.RECOVERABLE, E.Category.NETWORK, code, ...data);
    const fails = e => {
      liveEngine.shaka = fake();
      liveEngine.url = u;
      liveEngine.manifestFails = 0;
      onShakaError(u, e);
      return liveEngine.manifestFails;
    };
    const out = {
      timeout: fails(err(E.Code.TIMEOUT, u, RT.MANIFEST)),
      httpErr: fails(err(E.Code.HTTP_ERROR, u, {}, RT.MANIFEST)),
      badStatus:
          fails(err(E.Code.BAD_HTTP_STATUS, u, 509, '', {}, RT.MANIFEST)),
      segment: fails(err(E.Code.TIMEOUT, u, RT.SEGMENT)),
      segmentErr: fails(err(E.Code.HTTP_ERROR, u, {}, RT.SEGMENT)),
      other: fails(err(E.Code.MALFORMED_DATA_URI, u)),
      types: [
        shakaRequestType(err(E.Code.TIMEOUT, u, RT.SEGMENT)),
        shakaRequestType(err(E.Code.HTTP_ERROR, u, {}, RT.SEGMENT)),
        shakaRequestType(err(E.Code.BAD_HTTP_STATUS, u, 1, '', {}, RT.SEGMENT)),
        shakaRequestType(err(E.Code.MALFORMED_DATA_URI, u))
      ]
    };
    liveEngineDestroy();
    return out;
  });
  check(
      'TIMEOUT, HTTP_ERROR, and BAD_HTTP_STATUS of a playlist refresh count',
      sreq.timeout === 1 && sreq.httpErr === 1 && sreq.badStatus === 1 &&
          sreq.segment === 0 && sreq.segmentErr === 0 && sreq.other === 0 &&
          sreq.types.join() === '1,1,1,',
      JSON.stringify(sreq));
  // The relay restart detector (unit-level)
  const srst = await page.evaluate(() => {
    _shakaSeq.clear();
    const u = 'http://seq.test/a.m3u8';
    const pl = (seq, segs) => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${seq}\n` +
        segs.map(s => `#EXTINF:2.0,\n${s}\n`).join('');
    return [
      playlistRestarted(u, pl(0, ['seg0.ts'])),
      playlistRestarted(u, pl(0, ['seg0.ts'])),             // unchanged
      playlistRestarted(u, pl(1, ['seg1.ts', 'seg2.ts'])),  // slides
      playlistRestarted(u, pl(0, ['seg7.ts'])),             // restart
      playlistRestarted(u, pl(0, ['seg9.ts'])),  // the same number, new segment
      playlistRestarted(u, 'Cannot read'),
    ];
  });
  check(
      'the relay restart detector: a lower sequence or a new first segment',
      srst.join() === 'false,false,false,true,true,false',
      JSON.stringify(srst));
  await page.evaluate(u => {
    channels[1].url = u;
    settings.liveBuffer = 0;
    settings.liveEngine = 'shaka';  // the default again
    saveSettings();
    _hlsBroken.clear();
    document.getElementById('epgToastTitle').textContent = '';
    selectChannel(3);
  }, fpsOrigUrl);
  await page
      .waitForFunction(
          () => !liveEngineActive() &&
              (videoPlayer.getAttribute('src') || '') === channels[3].url,
          {timeout: 5000})
      .catch(() => {});
  check(
      'live engine hls.js and buffer Off again: the next channel load is native',
      await page.evaluate(
          () => !liveEngineActive() && liveMseEngine() === '' &&
              (videoPlayer.getAttribute('src') || '') === channels[3].url));

  // ---------- XMLTV name fallback (unit-level: the demo has no XMLTV feed)
  // ----------
  const fz = await page.evaluate(() => {
    const ch = channels[0];
    const savedId = ch.tvgId;
    ch.tvgId = 'nomatch-xyz';
    epgData.set('fuzzy.id', [
      {start: Date.now() - 60000, stop: Date.now() + 60000, title: 'Fuzzy Show'}
    ]);
    const n = applyEpgNameFallback(
        new Map([[normChannelName(ch.name + ' HD'), 'fuzzy.id']]));
    const p = getCurrentProgramme(ch.tvgId);
    const alias = epgIdMap.get('nomatch-xyz');
    ch.tvgId = savedId;
    epgData.delete('fuzzy.id');
    epgIdMap.delete('nomatch-xyz');
    buildChannelIndexMap();
    return {
      n,
      title: p && p.title,
      alias,
      norm: normChannelName('BBC One HD (UK) [backup]'),
      norm2: normChannelName('bbc-one 1080p')
    };
  });
  check(
      'XMLTV name fallback: a channel whose tvg-id matches nothing is aliased to the same-named XMLTV channel',
      fz.n === 1 && fz.title === 'Fuzzy Show' && fz.alias === 'fuzzy.id' &&
          fz.norm === 'bbcone' && fz.norm2 === 'bbcone',
      JSON.stringify(fz));

  // ---------- Alternate sources: a duplicate of the channel (same name,
  // quality tag) is tried when the budget runs out ----------
  await page.evaluate(() => {
    const c = channels[2];
    channels.push({
      name: c.name + ' FHD',
      tvgId: '',
      tvgLogo: '',
      group: c.group,
      url: 'http://localhost:8765/alt-source-dead.m3u8'
    });
    buildChannelIndexMap();
    channels[2].url = 'http://localhost:8765/does-not-exist-2.m3u8';
    document.getElementById('epgToastTitle').textContent = '';
    selectChannel(2);
  });
  check(
      'alternate sources are found by normalised name',
      await page.evaluate(
          () => alternateSources(2).length === 1 &&
              alternateSources(2)[0] === channels.length - 1 &&
              _altOrigin === 2));
  await page
      .waitForFunction(
          () => currentChannelIndex === channels.length - 1, {timeout: 20000})
      .catch(() => {});
  const alt = await page.evaluate(
      () => ({
        idx: currentChannelIndex,
        last: channels.length - 1,
        origin: _altOrigin,
        tried: _altTried.size,
        prev: lastChannelIndex,
        toast: document.getElementById('epgToastMsg').textContent,
        recent: recentChannels()[0] === channels[2]
      }));
  check(
      'after the reload budget the app switches to the alternate source; history and Recent still name the chosen channel',
      alt.idx === alt.last && alt.origin === 2 && alt.tried === 2 &&
          alt.prev !== 2 && /Trying alternate source 1 of 1/.test(alt.toast) &&
          alt.recent,
      JSON.stringify(alt));
  await page
      .waitForFunction(
          () => document.getElementById('epgToastTitle').textContent ===
              'Stream Error',
          {timeout: 20000})
      .catch(() => {});
  check(
      'when every source fails the error names how many were tried',
      await page.evaluate(
          () => /2 sources tried/.test(
              document.getElementById('epgToastMsg').textContent)),
      await page.evaluate(
          () => document.getElementById('epgToastMsg').textContent));
  await page.evaluate(() => {
    channels.pop();
    buildChannelIndexMap();
    document.getElementById('epgToastTitle').textContent = '';
  });

  // ---------- Stream error budget ----------
  await page.evaluate(() => {
    channels[1].url = 'http://localhost:8765/does-not-exist.m3u8';
    selectChannel(1);
  });
  await page
      .waitForFunction(
          () => document.getElementById('epgToastTitle').textContent ===
              'Stream Error',
          {timeout: 20000})
      .catch(() => {});
  const errState = await page.evaluate(
      () => ({
        attempts: _reloadAttempts,
        toast: document.getElementById('epgToastTitle').textContent,
        msg: document.getElementById('epgToastMsg').textContent,
        watchdog: stallWatchdogTimer
      }));
  check(
      'dead stream stops after 3 auto-reloads and reports error',
      errState.attempts === 3 && errState.toast === 'Stream Error' &&
          errState.watchdog === null,
      JSON.stringify(errState));
  await page.evaluate(() => reloadStream());
  check(
      'manual Reload resets the auto-reload budget',
      await page.evaluate(
          () => _reloadAttempts === 0 && stallWatchdogTimer !== null));
  check(
      'each reload writes its cause in the diagnostics log',
      await page.evaluate(
          () =>
              _diagLog.some(e => /^Live start \(Reload button\)/.test(e.msg)) &&
              _diagLog.some(
                  e => /^Live start \((error retry|watchdog)\)/.test(e.msg))));
  // A slow relay: the playhead waits at the end of the buffer, and the
  // buffer got data a short time ago. The watchdog waits and does not
  // reload.
  await page.evaluate(() => {  // stop the dead stream of the last test
    videoPlayer.removeAttribute('src');
    videoPlayer.load();
  });
  await new Promise(r => setTimeout(r, 1000));
  await page.evaluate(() => {
    const v = videoPlayer;
    clearTimeout(_errRetryTimer);
    _reloadAttempts = 0;
    window.__slow = {end: 10.5, reloads: 0, reload: window.reloadStream};
    window.reloadStream = () => window.__slow.reloads++;
    Object.defineProperty(v, 'paused', {get: () => false, configurable: true});
    Object.defineProperty(
        v, 'currentTime', {get: () => 10, set() {}, configurable: true});
    Object.defineProperty(v, 'readyState', {get: () => 2, configurable: true});
    Object.defineProperty(v, 'buffered', {
      get: () => ({length: 1, start: () => 0, end: () => window.__slow.end}),
      configurable: true
    });
    startStallWatchdog();
  });
  await new Promise(r => setTimeout(r, 14000));
  const slow = await page.evaluate(() => {
    const r = {
      reloads: window.__slow.reloads,
      attempts: _reloadAttempts,
      count: stallCount,
      aliveAgo: Date.now() - _stallBufAt,
      thr: STALL_THRESHOLD_CHECKS,
      alive: STALL_ALIVE_MS
    };
    for (const k of ['paused', 'currentTime', 'readyState', 'buffered'])
      delete videoPlayer[k];
    window.reloadStream = window.__slow.reload;
    startStallWatchdog();
    return r;
  });
  check(
      'watchdog waits for a slow relay (playhead at the buffer end) and does not reload',
      slow.reloads === 0 && slow.attempts === 0 &&
          slow.count === slow.thr - 1 && slow.aliveAgo < slow.alive,
      JSON.stringify(slow));


  // Back → dialog in standard view; Back on start page calls platformBack
  await page.evaluate(() => {
    window.__pb = 0;
    window.PalmSystem = {
      platformBack: () => {
        window.__pb++;
      }
    };
  });
  await back();
  await key('ArrowLeft', 37);
  await key('Enter', 13);
  await sleep(300);
  await back();
  const st =
      await page.evaluate(() => ({
                            pb: window.__pb,
                            start: !startPage.classList.contains('hidden'),
                            main: mainApp.style.display,
                            dlg: confirmDialog.classList.contains('hidden')
                          }));
  check(
      'Back on start page calls webOS.platformBack', st.pb === 1 && st.start,
      JSON.stringify(st));

  // ---------- Auto-load + per-playlist resume / starting group across a
  // relaunch ---------- The Xtream playlist was the last real playlist loaded;
  // mark a starting group and a last channel for it.
  await page.evaluate(() => {
    const key = localStorage.getItem('iptv_last_playlist');
    const st = JSON.parse(localStorage.getItem('iptv_playlist_state') || '{}');
    st[key] = Object.assign(st[key] || {}, {
      startGroup: 'all',
      lastChannel: {
        url: 'http://localhost:8765/live/user/pass/1234.m3u8',
        tvgId: 'ch1234.test'
      }
    });
    localStorage.setItem('iptv_playlist_state', JSON.stringify(st));
  });
  await page.reload({waitUntil: 'load'});
  await page
      .waitForFunction(
          () => currentPlaylistType === 'xtream' && epgMode &&
              currentChannelIndex >= 0,
          {timeout: 30000})
      .catch(() => {});
  await sleep(500);
  const al =
      await page.evaluate(() => ({
                            type: currentPlaylistType,
                            group: currentGroup,
                            idx: currentChannelIndex,
                            name: channels[currentChannelIndex] &&
                                channels[currentChannelIndex].name,
                            focus: epgFocusedRowIdx,
                            rowOk: !!epgRenderedRows.get(epgFocusedRowIdx) &&
                                epgRenderedRows.get(epgFocusedRowIdx)
                                    .classList.contains('epg-focused')
                          }));
  check(
      'auto-load relaunch opens the last playlist in the guide',
      al.type === 'xtream', JSON.stringify(al));
  // ---------- Local cache: the relaunch came from IndexedDB, with last
  // session's EPG restored ----------
  const cacheInfo = await page.evaluate(async () => {
    const rec =
        await cacheGet('playlists', localStorage.getItem('iptv_last_playlist'));
    const restored =
        [..._epgFetchMeta.values()]
            .filter(m => m.status === 'done' && m.at < performance.timeOrigin)
            .length;
    return {
      has: !!rec && Array.isArray(rec.channels) &&
          rec.channels.length === channels.length,
      at: rec && rec.at,
      cacheAt: _playlistCacheAt,
      restored,
      epg: epgData.size,
      num: channels[0].num,
      archive: channels[0].archive
    };
  });
  check(
      'relaunch applied the cached channel list and restored cached EPG entries',
      cacheInfo.has && cacheInfo.cacheAt > 0 &&
          cacheInfo.cacheAt === cacheInfo.at && cacheInfo.restored > 0 &&
          cacheInfo.epg >= cacheInfo.restored &&
          typeof cacheInfo.num === 'number' &&
          typeof cacheInfo.archive === 'number',
      JSON.stringify(cacheInfo));
  // Background refresh: an unchanged list is a no-op; a changed one is swapped
  // in place with the playing channel kept
  const refresh = await page.evaluate(async () => {
    const before = currentChannelIndex;
    const unchanged = await refreshPlaylistInBackground(true);
    channels[5].name = 'LOCALLY EDITED';
    channels[5].group = 'Nowhere';
    const changed = await refreshPlaylistInBackground(true);
    return {
      unchanged,
      changed,
      name: channels[5].name,
      idx: currentChannelIndex,
      before,
      toast: document.getElementById('epgToastMsg').textContent,
      groups: groupsList.includes('Nowhere')
    };
  });
  check(
      'background refresh: no-op when unchanged, in-place swap when the provider list differs',
      refresh.unchanged === false && refresh.changed === true &&
          /^Channel/.test(refresh.name) && refresh.idx === refresh.before &&
          /Playlist updated/.test(refresh.toast) && !refresh.groups,
      JSON.stringify(refresh));
  check(
      'Settings offers Refresh playlist now for a loaded playlist',
      await page.evaluate(() => {
        const r = settingsRows().find(x => x.id === 'refreshPlaylist');
        return !!r && !r.disabled && /fetched/.test(r.sub);
      }));
  check('starting group "All Channels" applied', al.group === 'all');
  check(
      'resumes last channel and focuses its row',
      al.name === 'Channel 01234' && al.focus === 1233 && al.rowOk,
      JSON.stringify(al));
  await click('#epgSettingsBtn');
  check(
      'settings opens from the guide button; per-playlist rows enabled',
      await page.evaluate(
          () => settingsOpen &&
              !document.querySelector('.settings-row[data-id="startGroup"]')
                   .classList.contains('disabled') &&
              document.querySelector(
                          '.settings-row[data-id="startGroup"] .settings-val')
                      .textContent === 'All Channels'));
  await page.evaluate(() => {
    settingsFocusIdx = settingsFocusables(_settingsRowsCache).indexOf('resume');
    renderSettings();
  });
  await key('ArrowLeft', 37);
  await sleep(100);
  check(
      'resume Left → Off for this playlist',
      await page.evaluate(
          () => JSON.parse(localStorage.getItem(
                    'iptv_playlist_state'))[localStorage
                                                .getItem('iptv_last_playlist')]
                    .resume === false));
  await back();
  // Up/Down in the guide must still work after the settings overlay closes
  const fb = await page.evaluate(() => epgFocusedRowIdx);
  await key('ArrowDown', 40);
  check(
      'guide navigation resumes after closing settings',
      await page.evaluate(() => epgFocusedRowIdx) === fb + 1);

  // ---------- hls.js: a refused stream (HTML instead of a playlist) is not
  // held against the channel ----------
  const hlsCls = await page.evaluate(() => {
    const out = {};
    for (const [k, body] of [
             ['html', '<html><body>Max connections reached</body></html>'],
             ['empty', ''], ['playlist', '#EXTM3U\n#EXT-X-GARBAGE']]) {
      const u = 'http://hls.test/' + k + '.m3u8';
      liveEngine.url = u;
      onHlsError(u, {
        fatal: true,
        type: Hls.ErrorTypes.NETWORK_ERROR,
        details: Hls.ErrorDetails.MANIFEST_PARSING_ERROR,
        response: {url: u, data: body},
        networkDetails: {status: 200}
      });
      out[k] = _hlsBroken.has(u);
    }
    out.log =
        _diagLog.map(e => e.msg).filter(m => /hls\.js fatal/.test(m)).slice(-3);
    return out;
  });
  check(
      'manifest parse error: an HTML or empty reply is a network failure; only a real #EXTM3U marks the channel hls-incompatible',
      !hlsCls.html && !hlsCls.empty && hlsCls.playlist &&
          /HTTP 200 reply: <html><body>Max connections reached.*not a playlist/
              .test(hlsCls.log[0]) &&
          /reply: \(empty\)/.test(hlsCls.log[1]) &&
          !/not a playlist/.test(hlsCls.log[2]),
      JSON.stringify(hlsCls));
  // ---------- Diagnostics: last failure with the server reply, account line,
  // persisted log, Red clears ----------
  const diag = await page.evaluate(() => {
    openDiag();
    const text = document.getElementById('diagText').textContent;
    diagSave();
    const stored =
        JSON.parse(localStorage.getItem('iptv_diag_log') || '[]').length;
    handleDiagKey({key: 'ColorF0Red', keyCode: 403, preventDefault() {}});
    const after = {
      mem: _diagLog.length,
      stored: JSON.parse(localStorage.getItem('iptv_diag_log') || '[]').length
    };
    closeDiag();
    return {
      lastFail:
          /Last stream failure: .* hls\.js · networkError\/manifestParsingError · HTTP 200/
              .test(text),
      reply: /Server reply: #EXTM3U #EXT-X-GARBAGE/.test(text),
      acct: /Account check: /.test(text),
      stored,
      after
    };
  });
  check(
      'Diagnostics shows the last stream failure with the server reply and the account check; log persists and Red clears it',
      diag.lastFail && diag.reply && diag.acct && diag.stored > 0 &&
          diag.after.mem === 0 && diag.after.stored === 0,
      JSON.stringify(diag));
  // A codec that hls.js cannot demux gets no recovery. The native pipeline
  // then plays an Xtream channel as 1 MPEG-TS stream, not with hlsdemux2.
  const hlsTs = await page.evaluate(() => {
    const u = 'http://xt.test/live/user/pass/1781953.m3u8';
    let recovered = false;
    liveEngine.hls = {
      recoverMediaError() {
        recovered = true;
      },
      destroy() {}
    };
    liveEngine.url = u;
    liveEngine.recovered = false;
    onHlsError(u, {
      fatal: true,
      type: Hls.ErrorTypes.MEDIA_ERROR,
      details: Hls.ErrorDetails.FRAG_PARSING_ERROR,
      reason: 'Unsupported EC-3 in M2TS found'
    });
    const other = 'http://hls.test/playlist.m3u8';
    return {
      recovered,
      broken: _hlsBroken.has(u),
      ts: nativeLiveUrl(u),
      other: nativeLiveUrl(other) === other,
      good: nativeLiveUrl('http://xt.test/live/user/pass/5.m3u8')
    };
  });
  check(
      'unsupported codec: no hls.js recovery; native plays the Xtream .ts URL',
      !hlsTs.recovered && hlsTs.broken &&
          hlsTs.ts === 'http://xt.test/live/user/pass/1781953.ts' &&
          hlsTs.other && /\/5\.m3u8$/.test(hlsTs.good),
      JSON.stringify(hlsTs));
  // ---------- Event (PPV) channels: times read from names fill the guide and
  // order the group ----------
  const ev = await page.evaluate(() => {
    const H = 3600000, now = Math.floor(Date.now() / 60000) * 60000;
    const p2 = n => String(n).padStart(2, '0');
    const ymd = t => {
      const d = new Date(t);
      return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${
          p2(d.getUTCDate())}`;
    };
    const hm = t => {
      const d = new Date(t);
      return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
    };
    const day = t => {
      const d = new Date(t);
      return `${
              ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri',
               'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${
              ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
               'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
    };
    const names = [
      `End | Old Match | all | ${ymd(now - 10 * H)} | ${
          hm(now -
             10 * H)} (GMT) | 8K EXCLUSIVE | US: TEST PPV 1`,  // finished long
                                                               // ago → hidden
      `Slot 2 | 7pm Somebody at Somewhere`,  // no zone → not an event
      `NEXT | LATER VS LATEST | ${day(now + 3 * H)} ${
          hm(now + 3 * H)} UTC (UK) | 8K EXCLUSIVE | UK: TEST PPV 3`,
      `UFC 04 : MAIN CARD start:${ymd(now - H / 2)} ${
          hm(now - H / 2)}:00 stop:${ymd(now + 2 * H)} ${
          hm(now + 2 * H)}:00`,  // on now
      `NEXT | SOON VS SOONER | ${day(now - 3 * H)} ${
          hm(now -
             3 * H)} EDT (US) | 8K EXCLUSIVE | US: TEST PPV 5`,  // EDT
                                                                 // wall-clock:
                                                                 // starts now +
                                                                 // 1 h
      `(Test) (PPV) 006 |  (2098-12-31 08:00:01)`,  // placeholder slot
    ];
    const parsed =
        names.map(n => parseEventName({name: n, group: 'US| TEST PPV'}));
    const base = channels.findIndex(c => c.group === 'Group 30');
    const orig = channels.slice(base, base + 6);
    orig.forEach((c, i) => {
      channels[base + i] = Object.assign(
          {}, c, {name: names[i], group: 'US| TEST PPV', tvgId: `ev${i}.test`});
    });
    buildChannelIndexMap();
    const saveGroup = currentGroup, saveMode = settings.ppvEvents;
    currentGroup = 'US| TEST PPV';
    settings.ppvEvents = 'hide';
    renderChannelList();
    const hide = currentFilteredChannels.map(c => c.tvgId).join();
    settings.ppvEvents = 'sort';
    renderChannelList();
    const sort = currentFilteredChannels.map(c => c.tvgId).join();
    settings.ppvEvents = 'off';
    renderChannelList();
    const off = currentFilteredChannels.map(c => c.tvgId).join();
    const cur = getCurrentProgramme('ev3.test'),
          next = getNextProgramme('ev2.test');
    const html = epgProgsHtml(channels[base + 3]);
    orig.forEach((c, i) => {
      channels[base + i] = c;
    });
    buildChannelIndexMap();
    settings.ppvEvents = saveMode;
    currentGroup = saveGroup;
    refreshCurrentView();
    return {
      starts: parsed.map(e => e ? (e.start - now) / H : null),
      tags: parsed.map(e => e ? e.tag : null),
      titles: parsed.map(e => e ? e.title : null),
      stop3: parsed[3] && (parsed[3].stop - now) / H,
      hide,
      sort,
      off,
      cur: cur && cur.title,
      next: next && next.title,
      block: /epg-prog-block now-playing[^>]*>.*MAIN CARD/.test(html),
      setting: settingsRows().some(r => r.id === 'ppvEvents'),
    };
  });
  check(
      'event names parsed: GMT pipe date, UTC/EDT day formats, start:/stop:; zone-less and placeholder names ignored',
      JSON.stringify(ev.starts) ===
              JSON.stringify([-10, null, 3, -0.5, 1, null]) &&
          ev.stop3 === 2 && ev.tags.join() === 'ended,,next,,next,' &&
          ev.titles.join('|') ===
              'Old Match||LATER VS LATEST|MAIN CARD|SOON VS SOONER|',
      JSON.stringify(ev));
  check(
      'event group: sorted by start time, finished hidden (Sort, hide finished) or last (Sort), untouched when As listed',
      ev.hide === 'ev3.test,ev4.test,ev2.test,ev1.test,ev5.test' &&
          ev.sort === 'ev3.test,ev4.test,ev2.test,ev0.test,ev1.test,ev5.test' &&
          ev.off === 'ev0.test,ev1.test,ev2.test,ev3.test,ev4.test,ev5.test' &&
          ev.setting,
      JSON.stringify(ev));
  check(
      'event fills the guide for a channel without EPG: current programme, next, now-playing block',
      ev.cur === 'MAIN CARD' && ev.next === 'LATER VS LATEST' && ev.block,
      JSON.stringify(ev));

  // ---------- Favorites are exact channels: quality variants sharing a tvg-id
  // are not pulled in ----------
  const fv = await page.evaluate(() => {
    const save = [10, 11, 12].map(
        i => ({name: channels[i].name, tvgId: channels[i].tvgId}));
    const savedFavs = [...favoriteIds],
          ps = getPlaylistState(_activePlaylistKey), savedPs = ps.favs,
          savedLegacy = localStorage.getItem('iptv_favorites');
    [['Dup HD', 10], ['Dup FHD', 11], ['Dup SD', 12]].forEach(([n, i]) => {
      channels[i].name = n;
      channels[i].tvgId = 'dup.test';
    });
    buildChannelIndexMap();
    favoriteIds = new Set([favIdOf(channels[11], 11)]);
    const listed = favoriteChannels().map(c => c.name).join();
    // Conversion of an old tvg-id favorite keeps the best-quality variant even
    // when it is not listed first
    delete ps.favs;
    localStorage.setItem(
        'iptv_favorites',
        JSON.stringify(['dup.test', 'ch20.test', 'gone.test']));
    favoritesLoad();
    const migrated = [...favoriteIds].join();
    const ranks =
        [
          'X 8K', 'X ᵁᴴᴰ 3840P', 'X 4K', 'X FHD', 'X 1080p', 'X HD', 'X 720p',
          'X', 'X SD', 'X 480p', 'X ⁸ᴷ', 'X ⁴ᵏ & ³⁸⁴⁰ᴾ', 'X ᵁᴴᴰ³⁸⁴⁰ᴾ',
          'X ᴴᴰᴿ ³⁸⁴⁰ᴾ', 'X ᶠᴴᴰ', 'X ᴴᴰ', 'X ⁽ᴮᴷ⁾ ᴿᴬᵂ', 'X ˢᴰ'
        ].map(nameQualityRank)
            .join();
    [10, 11, 12].forEach((i, k) => Object.assign(channels[i], save[k]));
    buildChannelIndexMap();
    ps.favs = savedPs;
    savePlaylistState();
    favoriteIds = new Set(savedFavs);
    if (savedLegacy === null)
      localStorage.removeItem('iptv_favorites');
    else
      localStorage.setItem('iptv_favorites', savedLegacy);
    return {listed, migrated, ranks};
  });
  check(
      'starring one quality variant lists only that channel; old tvg-id favorites convert to the best-quality variant',
      fv.listed === 'Dup FHD' && fv.migrated === 's:12,s:20' &&
          fv.ranks === '6,5,5,4,4,3,3,2,1,1,6,5,5,5,4,3,2,1',
      JSON.stringify(fv));

  // ---------- Versions: the same channel's variants, with remembered quality;
  // watch one, make one the favorite ----------
  const vs = await page.evaluate(() => {
    const idx = [30, 31, 32],
          save = idx.map(
              i => ({name: channels[i].name, tvgId: channels[i].tvgId}));
    [['Vers FHD', 30], ['Vers HD', 31], ['Vers', 32]].forEach(([n, i]) => {
      channels[i].name = n;
      channels[i].tvgId = 'vers.test';
    });
    buildChannelIndexMap();
    const key = i => _activePlaylistKey + '|' + favIdOf(channels[i], i);
    const savedTech = idx.map(i => _streamTech[key(i)]);
    _streamTech[key(30)] = {w: 1280, h: 720, fps: 50, at: Date.now()};
    _streamTech[key(32)] = {w: 1920, h: 1080, fps: 60, at: Date.now()};
    const savedFavs = [...favoriteIds];
    favoriteIds = new Set(['s:1', favIdOf(channels[30], 30), 's:2']);
    const out = {n: versionsOf(30).length};
    out.opened = openVersions(30);
    out.order = _versionsRows.map(r => r.ch.name + (r.best ? '*' : '')).join();
    out.focus = _versionsRows[versionsFocus].ch.name;
    out.text = document.getElementById('versionsList').textContent;
    versionsFocus = _versionsRows.findIndex(r => r.ch.name === 'Vers');
    handleVersionsKey({key: 'ColorF1Green', keyCode: 404, preventDefault() {}});
    out.favs = [...favoriteIds].join();
    out.stored = getPlaylistState(_activePlaylistKey).favs.join();
    handleVersionsKey({key: 'Enter', keyCode: 13, preventDefault() {}});
    out.closed = !versionsOpen;
    out.playing = channels[currentChannelIndex].name;
    enterLivePlayer();
    out.btn = playerButtonsFor().map(b => b.id).join();
    exitLivePlayer();
    out.single = openVersions(5);  // a channel with no other version: no menu
    window.__vsRestore = () => {
      idx.forEach((i, k) => Object.assign(channels[i], save[k]));
      idx.forEach((i, k) => {
        if (savedTech[k])
          _streamTech[key(i)] = savedTech[k];
        else
          delete _streamTech[key(i)];
      });
      buildChannelIndexMap();
      favoriteIds = new Set(savedFavs);
      saveFavorites();
    };
    return out;
  });
  check(
      'Versions lists the variants best first (remembered resolution beats the name), marks the best, opens on the chosen one',
      vs.n === 3 && vs.opened && vs.order === 'Vers*,Vers FHD,Vers HD' &&
          vs.focus === 'Vers FHD' && /1920×1080 · 60 fps/.test(vs.text) &&
          /not watched yet/.test(vs.text) && vs.single === false,
      JSON.stringify(vs));
  check(
      'Green makes the focused version the favorite in place of the starred one; OK watches it; the live player offers the Versions button',
      vs.favs === 's:1,s:33,s:2' && vs.stored === vs.favs && vs.closed &&
          vs.playing === 'Vers' && /,versions,/.test(vs.btn),
      JSON.stringify(vs));
  // Long press OK on a guide row opens Versions without tuning; a short press
  // tunes as before
  const vlp = await page.evaluate(async () => {
    const ev = (type) => {
      const e = new KeyboardEvent(
          type, {key: 'Enter', keyCode: 13, bubbles: true, cancelable: true});
      Object.defineProperty(e, 'keyCode', {get: () => 13});
      document.dispatchEvent(e);
    };
    currentGroup = 'all';
    refreshCurrentView();
    const fi = currentFilteredChannels.indexOf(channels[31]);
    epgFocusedRowIdx = fi;
    epgFocusT = 0;
    updateEPGRowFocus();
    const before = currentChannelIndex;
    ev('keydown');
    await new Promise(r => setTimeout(r, LONG_PRESS_MS + 150));
    const open = versionsOpen,
          focus = versionsOpen && _versionsRows[versionsFocus].ch.name;
    ev('keyup');
    const after = currentChannelIndex;
    closeVersions();
    ev('keydown');
    ev('keyup');
    const tuned = channels[currentChannelIndex].name;
    window.__vsRestore();
    return {fi, open, focus, unchanged: after === before, tuned};
  });
  check(
      'long press OK on a guide row opens Versions for that row without tuning; a short press tunes it',
      vlp.fi >= 0 && vlp.open && vlp.focus === 'Vers HD' && vlp.unchanged &&
          vlp.tuned === 'Vers HD',
      JSON.stringify(vlp));

  check(
      'no uncaught page errors', errors.length === 0,
      errors.slice(0, 5).join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('E2E CRASH', e);
  process.exit(2);
});
