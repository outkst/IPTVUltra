// Headless end-to-end checks for IPTV Ultra against the mock Xtream server.
const puppeteer = require('puppeteer-core');
const BASE = 'http://localhost:8765';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stats = async () => (await fetch(BASE + '/__stats')).json();

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        headless: true,
        args: ['--window-size=1920,1080', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
        defaultViewport: { width: 1920, height: 1080 },
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/net::|404|Failed to load resource|MEDIA/.test(m.text())) errors.push('console: ' + m.text()); });
    const key = (k, kc) => page.evaluate((k, kc) => {
        const ev = new KeyboardEvent('keydown', { key: k, keyCode: kc, bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'keyCode', { get: () => kc });
        document.dispatchEvent(ev);
    }, k, kc);
    const back = () => key('GoBack', 461);

    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload({ waitUntil: 'load' });
    check('webOS library loaded', await page.evaluate(() => typeof webOS !== 'undefined' && !!webOS.platformBack));

    // ---------- Xtream: add + load ----------
    await page.type('#xtreamServer', BASE);
    await page.type('#xtreamUsername', 'user');
    await page.type('#xtreamPassword', 'pass');
    await page.click('#saveXtreamBtn');
    await page.waitForSelector('.saved-item', { timeout: 5000 });
    // Pre-seed two favorites so the prefetch path runs (tvgIds ch3.test, ch4.test)
    await page.evaluate(() => { favoriteIds.add('ch3.test'); favoriteIds.add('ch4.test'); localStorage.setItem('iptv_favorites', JSON.stringify([...favoriteIds])); });
    await page.click('.saved-item');
    await page.click('#loadSelectedBtn');
    await page.waitForFunction(() => document.getElementById('epgView').style.display === 'flex' && epgRenderedRows.size > 0, { timeout: 30000 });
    const t0 = Date.now();
    await sleep(2500);
    let s = await stats();
    const rendered = await page.evaluate(() => epgRenderedRows.size);
    check('guide opened with lazy EPG (requests ≈ favorites + visible rows)', s.epg_requests > 0 && s.epg_requests <= rendered + 10, `requests=${s.epg_requests} renderedRows=${rendered} channels=3000`);
    check('favorites (group) view shows favorite rows', await page.evaluate(() => currentGroup === 'favorites' && currentFilteredChannels.length === 2));
    const loadedBlocks = await page.evaluate(() => document.querySelectorAll('#epgBody .epg-prog-block').length);
    check('visible rows received programme blocks', loadedBlocks > 0, `blocks=${loadedBlocks}`);
    check('info panel shows programme for playing channel', await page.evaluate(() => /Show/.test(document.getElementById('epgInfoTitle').textContent)), await page.evaluate(() => document.getElementById('epgInfoTitle').textContent));
    check('prefetch toast finished', await page.evaluate(() => !_epgPrefetchActive && !_epgQueue.length));

    // Switch to All Channels and scroll with D-pad
    await page.evaluate(() => { document.querySelectorAll('.group-item')[1].click(); });
    await page.waitForFunction(() => currentGroup === 'all' && epgRenderedRows.size > 10);
    await sleep(600);
    await fetch(BASE + '/__reset');
    for (let i = 0; i < 40; i++) await key('ArrowDown', 40);
    await sleep(800);
    s = await stats();
    const focus = await page.evaluate(() => epgFocusedRowIdx);
    check('D-pad Down moves EPG focus 40 rows', focus === 40, `focus=${focus}`);
    check('scrolling 40 rows fetched a bounded number of EPGs', s.epg_requests > 0 && s.epg_requests < 70, `requests=${s.epg_requests}`);
    const focusedVisible = await page.evaluate(() => { const el = epgRenderedRows.get(epgFocusedRowIdx); return !!el && el.classList.contains('epg-focused'); });
    check('focused row is rendered and highlighted after scrolling', focusedVisible);
    // Enter on a scrolled row must select that channel (old DOM-index lookup broke this)
    const before = await page.evaluate(() => currentChannelIndex);
    await key('Enter', 13);
    await sleep(300);
    const after = await page.evaluate(() => ({ idx: currentChannelIndex, expected: getChannelIndex(currentFilteredChannels[epgFocusedRowIdx]) }));
    check('Enter on scrolled EPG row selects that channel', after.idx === after.expected && after.idx !== before, `before=${before} after=${after.idx} expected=${after.expected}`);
    // Enter again on the playing row → fullscreen toggle attempted (no gesture in headless, must not throw)
    let fsCalled = false;
    await page.exposeFunction('__fs', () => { fsCalled = true; });
    await page.evaluate(() => { const o = videoPlayer.requestFullscreen.bind(videoPlayer); videoPlayer.requestFullscreen = () => { window.__fs(); return o(); }; });
    await key('Enter', 13);
    await sleep(200);
    check('Enter on playing row toggles fullscreen', fsCalled);
    check('channel unchanged after fullscreen toggle', await page.evaluate(() => currentChannelIndex) === after.idx);
    // Headless Chrome may grant fullscreen; leave it so Back behaves as in the TV's non-fullscreen state
    await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
    await sleep(300);
    check('left fullscreen for the remaining checks', await page.evaluate(() => !document.fullscreenElement));

    // Minute tick: in-place refresh and hour rollover
    const tickOk = await page.evaluate(() => { try { epgMinuteTick(); return true; } catch (e) { return e.message; } });
    check('minute tick runs without error', tickOk === true, String(tickOk));
    const roll = await page.evaluate(() => { const old = _epgSkeletonWinStart; _epgSkeletonWinStart = old - 3600000; epgMinuteTick(); return _epgSkeletonWinStart === old && epgRenderedRows.size > 0; });
    check('hour rollover rebuilds guide skeleton once', roll);
    check('programme blocks carry data-start/stop for tick updates', await page.evaluate(() => { const b = document.querySelector('#epgBody .epg-prog-block'); return !!b && !!b.dataset.start && !!b.dataset.stop; }));

    // EPG cache TTL: expire one visible channel and make sure it is re-queued
    await fetch(BASE + '/__reset');
    await page.evaluate(() => { const ch = currentFilteredChannels[epgFocusedRowIdx]; const m = _epgFetchMeta.get(ch.tvgId); if (m) m.at = 0; scheduleEpgFetchForVisible(); });
    await sleep(700);
    s = await stats();
    check('TTL-expired visible channel is re-fetched (and only it)', s.epg_requests === 1, `requests=${s.epg_requests}`);

    // Search typing in the EPG corner box must not be hijacked by guide navigation
    await page.focus('#epgSearchInput');
    await page.keyboard.type('Channel 000');
    await sleep(400);
    check('typing in EPG search filters guide (best match first)', await page.evaluate(() => currentSearchQuery === 'Channel 000' && currentFilteredChannels[0].name === 'Channel 00001' && document.getElementById('epgSearchInput').value === 'Channel 000'), await page.evaluate(() => currentFilteredChannels.length + ' results, first=' + currentFilteredChannels[0].name));
    await key('ArrowDown', 40); // leaves the search box
    check('Down leaves the search box', await page.evaluate(() => document.activeElement !== document.getElementById('epgSearchInput')));
    await page.click('#epgClearSearchBtn');

    // ---------- Back + confirm dialog with D-pad ----------
    await back();
    check('Back opens Return-to-Home dialog', await page.evaluate(() => !confirmDialog.classList.contains('hidden')));
    await key('ArrowDown', 40); // must NOT move guide focus while dialog is open
    const guideFocusBefore = await page.evaluate(() => epgFocusedRowIdx);
    await back();
    check('Back again cancels the dialog', await page.evaluate(() => confirmDialog.classList.contains('hidden')));
    check('guide focus untouched while dialog open', await page.evaluate(() => epgFocusedRowIdx) === guideFocusBefore);
    await back();
    await key('ArrowRight', 39); await key('Enter', 13);
    check('Right+Enter picks Cancel and stays in app', await page.evaluate(() => confirmDialog.classList.contains('hidden') && mainApp.style.display !== 'none'));
    await back();
    await key('ArrowLeft', 37); await key('Enter', 13);
    await sleep(300);
    check('Left+Enter picks Yes and returns home', await page.evaluate(() => !startPage.classList.contains('hidden') && mainApp.style.display === 'none'));
    check('lazy EPG state cleared on home', await page.evaluate(() => _xt === null && _epgQueue.length === 0 && epgData.size === 0));

    // ---------- M3U demo: standard view D-pad ----------
    await page.click('#startDemoBtn');
    await page.waitForFunction(() => currentPlaylistType === 'm3u' && mainApp.style.display === 'flex', { timeout: 10000 });
    await sleep(800);
    await page.evaluate(() => { document.querySelectorAll('.group-item')[1].click(); }); // All Channels
    await sleep(300);
    check('standard view: initial focus in channel list', await page.evaluate(() => stdFocusZone === 'channels' && !!document.querySelector('.virtual-item.focused')));
    await key('ArrowDown', 40); await key('ArrowDown', 40);
    check('standard view: Down moves channel focus', await page.evaluate(() => stdFocusIdx === 2 && renderedItems.get(2).classList.contains('focused')));
    await key('Enter', 13);
    await sleep(200);
    check('standard view: Enter plays focused channel', await page.evaluate(() => currentChannelIndex === getChannelIndex(currentFilteredChannels[2]) && renderedItems.get(2).classList.contains('active')));
    await key('ArrowLeft', 37);
    check('standard view: Left moves to groups column', await page.evaluate(() => stdFocusZone === 'groups' && !!document.querySelector('.group-item.focused')));
    await key('ArrowDown', 40); await key('ArrowDown', 40); await key('Enter', 13);
    await sleep(300);
    check('standard view: Enter on group switches group', await page.evaluate(() => currentGroup === groupsList[3]), await page.evaluate(() => currentGroup));
    await key('ArrowRight', 39);
    check('standard view: Right returns to channel list', await page.evaluate(() => stdFocusZone === 'channels'));
    // Favorite star in place (not favorites group)
    const starBefore = await page.evaluate(() => renderedItems.get(0).querySelector('.favorite-star').textContent);
    await page.evaluate(() => renderedItems.get(0).querySelector('.favorite-star').click());
    const starAfter = await page.evaluate(() => renderedItems.get(0).querySelector('.favorite-star').textContent);
    check('favorite star toggles in place', starBefore !== starAfter, `${starBefore} → ${starAfter}`);
    // Group name escaping
    check('group names are HTML-escaped', await page.evaluate(() => { channels[0].group = 'A&B <Sports>'; extractGroups(); return [...document.querySelectorAll('.group-item')].some(g => g.textContent.includes('A&B <Sports>')) && !document.querySelector('.group-item sports'); }));

    // ---------- Stream error budget ----------
    await page.evaluate(() => { channels[1].url = 'http://localhost:8765/does-not-exist.m3u8'; selectChannel(1); });
    await page.waitForFunction(() => document.getElementById('epgToastTitle').textContent === 'Stream Error', { timeout: 20000 }).catch(() => {});
    const errState = await page.evaluate(() => ({ attempts: _reloadAttempts, toast: document.getElementById('epgToastTitle').textContent, msg: document.getElementById('epgToastMsg').textContent, watchdog: stallWatchdogTimer }));
    check('dead stream stops after 3 auto-reloads and reports error', errState.attempts === 3 && errState.toast === 'Stream Error' && errState.watchdog === null, JSON.stringify(errState));
    await page.evaluate(() => reloadStream());
    check('manual Reload resets the auto-reload budget', await page.evaluate(() => _reloadAttempts === 0 && stallWatchdogTimer !== null));

    // Back → dialog in standard view; Back on start page calls platformBack
    await page.evaluate(() => { window.__pb = 0; window.PalmSystem = { platformBack: () => { window.__pb++; } }; });
    await back(); await key('ArrowLeft', 37); await key('Enter', 13);
    await sleep(300);
    await back();
    const st = await page.evaluate(() => ({ pb: window.__pb, start: !startPage.classList.contains('hidden'), main: mainApp.style.display, dlg: confirmDialog.classList.contains('hidden'), fs: !!document.fullscreenElement }));
    check('Back on start page calls webOS.platformBack', st.pb === 1 && st.start, JSON.stringify(st));

    check('no uncaught page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
    await browser.close();
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('E2E CRASH', e); process.exit(2); });
