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

    await fetch(BASE + '/__reset'); // server may have been running across runs
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
    await page.waitForFunction(() => currentGroup === 'all' && epgRenderedRows.size > 5);
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
    check('typing in EPG search filters guide (best match first)', await page.evaluate(() => currentSearchQuery === 'Channel 000' && currentFilteredChannels[0].name === 'Channel 00001' && document.getElementById('epgSearchInput').value === 'Channel 000'), await page.evaluate(() => currentFilteredChannels.length + ' results, first=' + currentFilteredChannels[0].name + ' query=' + JSON.stringify(currentSearchQuery) + ' input=' + JSON.stringify(document.getElementById('epgSearchInput').value) + ' active=' + (document.activeElement && document.activeElement.id)));
    await key('ArrowDown', 40); // leaves the search box
    check('Down leaves the search box', await page.evaluate(() => document.activeElement !== document.getElementById('epgSearchInput')));
    await page.click('#epgClearSearchBtn');

    // ---------- Dedicated media keys: Play/Pause/CH+/CH- ----------
    {
        const start = await page.evaluate(() => ({ idx: currentChannelIndex, pos: currentFilteredChannels.indexOf(channels[currentChannelIndex]), len: currentFilteredChannels.length }));
        await key('ChannelUp', 427); await sleep(200);
        const up = await page.evaluate(() => ({ idx: currentChannelIndex, pos: currentFilteredChannels.indexOf(channels[currentChannelIndex]), focus: epgFocusedRowIdx }));
        check('CH+ steps to the next channel in the on-screen list', up.pos === (start.pos + 1) % start.len && up.focus === up.pos, `pos ${start.pos} → ${up.pos}`);
        await key('ChannelDown', 428); await sleep(200);
        const down = await page.evaluate(() => currentChannelIndex);
        check('CH- steps back', down === start.idx);
        await page.evaluate(() => { currentChannelIndex = getChannelIndex(currentFilteredChannels[0]); });
        await key('ChannelDown', 428); await sleep(200);
        check('CH- wraps from first to last', await page.evaluate(() => currentFilteredChannels.indexOf(channels[currentChannelIndex]) === currentFilteredChannels.length - 1));
        await key('MediaPause', 19); await sleep(100);
        check('Pause key pauses', await page.evaluate(() => videoPlayer.paused));
        await key('MediaPlay', 415); await sleep(100);
        check('Play key resumes (play() called)', await page.evaluate(() => !videoPlayer.paused || videoPlayer.error !== null));
    }

    // ---------- VOD: Movies & Series ----------
    {
        check('mode switch shown for Xtream playlists', await page.evaluate(() => document.getElementById('modeSwitch').style.display !== 'none'));
        await key('ColorF3Blue', 406); // Live → Movies
        await page.waitForFunction(() => vodMode === 'movies' && vodNav.screen === 'home' && (vodCats || []).length > 0, { timeout: 10000 });
        await page.waitForFunction(() => !!vodRecent, { timeout: 15000 }); // background full fetch for Recently Added
        await sleep(200);
        const mv = await page.evaluate(() => ({ vv: document.getElementById('vodView').style.display, ev: document.getElementById('epgView').style.display, cats: [...document.querySelectorAll('#groupsList .group-item')].map(g => g.textContent.trim()), recent: document.querySelectorAll('.vod-card[data-pos^="recent:"]').length, paused: videoPlayer.paused }));
        check('nothing counts as in progress before 2 min (10% for short items)', await page.evaluate(() => vodMinResume(7200) === 120 && vodMinResume(20) === 2 && vodMinResume(0) === 120));
        check('Continue Watching ignores entries under the threshold', await page.evaluate(() => { const k = localStorage.getItem('iptv_last_playlist'); vodProgress[k + '|m:999001'] = { kind: 'movie', id: '999001', name: 'Short', icon: '', ext: 'mp4', catId: '100', pos: 60, dur: 7200, at: Date.now(), watched: false }; vodProgress[k + '|m:999002'] = { kind: 'movie', id: '999002', name: 'Long', icon: '', ext: 'mp4', catId: '100', pos: 200, dur: 7200, at: Date.now(), watched: false }; const ids = continueWatchingItems('movies').map(i => i.id); delete vodProgress[k + '|m:999001']; delete vodProgress[k + '|m:999002']; return !ids.includes('999001') && ids.includes('999002'); }));
        check('settings offer subtitle and audio language rows (default English / Default)', await page.evaluate(() => { const r = settingsRows(); const s = r.find(x => x.id === 'subLang'), a = r.find(x => x.id === 'audioLang'); return !!s && !!a && s.get() === 'en' && a.get() === 'default'; }));
        check('Blue opens Movies home; adult category hidden; live video paused', mv.vv === 'flex' && mv.ev === 'none' && mv.cats.length === 5 && !mv.cats.some(c => /adult/i.test(c)) && mv.paused, JSON.stringify(mv));
        check('Recently Added row filled from the background catalog fetch', mv.recent === 18, `recent=${mv.recent}`);
        // Left → categories, Down to "Action", Enter → grid
        await key('ArrowLeft', 37); await key('ArrowDown', 40); await key('ArrowDown', 40); await key('ArrowDown', 40);
        check('category column focus on Action', await page.evaluate(() => document.querySelector('.group-item.focused') && document.querySelector('.group-item.focused').textContent.includes('Action')));
        await fetch(BASE + '/__reset');
        await key('Enter', 13);
        await page.waitForFunction(() => vodNav.screen === 'grid' && vodNav.items.length === 60 && vodGridRows.size > 0, { timeout: 10000 });
        s = await stats();
        check('category grid loads only that category (one request, 60 titles, 6 columns)', (s.vod_actions || []).join() === 'get_vod_streams@100' && await page.evaluate(() => vodGrid.cols === 6 && document.querySelectorAll('#vodGridInner .vod-card').length >= 12 && document.querySelectorAll('#vodGridInner .vod-card').length < 60), JSON.stringify(s.vod_actions));
        await key('ArrowRight', 39); await key('ArrowDown', 40); await key('ArrowRight', 39);
        check('grid D-pad: Right, Down, Right → index 7 focused', await page.evaluate(() => vodNav.zone === 'content' && vodNav.focus === 7 && document.querySelector('.vod-card.focused').dataset.idx === '7'));
        await page.evaluate(() => { for (let i = 0; i < 8; i++) { vodNav.focus = Math.min(vodNav.items.length - 1, vodNav.focus + 6); } updateVodGridFocus(); });
        check('grid virtualization keeps a bounded number of cards', await page.evaluate(() => document.querySelectorAll('#vodGridInner .vod-card').length <= 36 && !!document.querySelector('.vod-card.focused')));
        await page.evaluate(() => { vodNav.focus = 7; updateVodGridFocus(); });
        await key('Enter', 13);
        await page.waitForFunction(() => vodNav.screen === 'details' && vodNav.detail && vodNav.detail.info, { timeout: 10000 });
        const det = await page.evaluate(() => ({ title: document.querySelector('.vod-dtitle').textContent, plot: document.querySelector('.vod-dplot').textContent, btn: document.querySelector('.vod-btn.focused') && document.querySelector('.vod-btn.focused').textContent, meta: document.querySelector('.vod-dmeta').textContent }));
        check('movie details show plot, metadata and a focused Play button', /Plot of/.test(det.plot) && det.btn === '▶ Play' && /2023/.test(det.meta), JSON.stringify(det));
        // Play → player screen with the movie file, playback progresses
        await key('Enter', 13);
        await page.waitForFunction(() => vodPlay.active && !document.getElementById('vodPlayer').classList.contains('hidden'), { timeout: 5000 });
        await page.waitForFunction(() => videoPlayer.currentTime > 1.5, { timeout: 15000 }).catch(() => {});
        const pl = await page.evaluate(() => ({ src: videoPlayer.currentSrc || videoPlayer.src, t: videoPlayer.currentTime, controls: videoPlayer.hasAttribute('controls'), inSlot: videoPlayer.parentNode.id, osd: document.getElementById('vodOsdTitle').textContent }));
        check('movie plays in the app-owned player without native controls', /\/movie\/user\/pass\/\d+\.mp4$/.test(pl.src) && pl.t > 1.5 && !pl.controls && pl.inSlot === 'vodVideoSlot' && pl.osd === det.title, JSON.stringify(pl));
        await key('ArrowUp', 38); await sleep(300);
        check('Up seeks forward 60 s (clamped to the clip) and shows the OSD', await page.evaluate(() => videoPlayer.currentTime > 10 && document.getElementById('vodOsd').classList.contains('visible')));
        await page.evaluate(() => { videoPlayer.currentTime = 6; });
        await sleep(400);
        // Hold Right: the OSD scrubs while the video stays put; release seeks once
        await page.evaluate(() => { const d = new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true }); Object.defineProperty(d, 'keyCode', { get: () => 39 }); document.dispatchEvent(d); });
        await sleep(1300);
        const hold = await page.evaluate(() => ({ holding: _isHolding(), scrub: _scrubPos, t: videoPlayer.currentTime, osd: document.getElementById('vodOsd').classList.contains('visible'), badge: document.getElementById('pbTrickBadge').textContent, paused: videoPlayer.paused, shown: document.getElementById('vodTimePos').textContent }));
        check('holding Right scrubs the OSD at 10× without seeking the video', hold.holding && hold.scrub > hold.t + 3 && hold.osd && /▶▶ 10×/.test(hold.badge) && hold.paused && hold.shown === (Math.floor(hold.scrub / 60) + ':' + String(Math.floor(hold.scrub % 60)).padStart(2, '0')), JSON.stringify(hold));
        await page.evaluate(() => { const u = new KeyboardEvent('keyup', { key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true }); Object.defineProperty(u, 'keyCode', { get: () => 39 }); document.dispatchEvent(u); });
        await sleep(700);
        const rel = await page.evaluate(() => ({ holding: _isHolding(), scrub: _scrubPos, t: videoPlayer.currentTime, paused: videoPlayer.paused }));
        check('release seeks once to the scrubbed position and resumes playback', !rel.holding && rel.scrub === null && rel.t > 12 && rel.t < 16 && !rel.paused, JSON.stringify(rel));
        // OK pauses, OK resumes
        await page.evaluate(() => { const d = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }); Object.defineProperty(d, 'keyCode', { get: () => 13 }); document.dispatchEvent(d); const u = new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }); Object.defineProperty(u, 'keyCode', { get: () => 13 }); document.dispatchEvent(u); });
        await sleep(200);
        check('OK pauses VOD playback', await page.evaluate(() => videoPlayer.paused && !document.getElementById('vodPaused').classList.contains('hidden')));
        // Subtitles: simulate tracks announced by the file; English auto-selects per Settings default
        await page.evaluate(() => { for (const [l, n] of [['es', 'Spanish'], ['en', 'English']]) { const t = document.createElement('track'); t.kind = 'subtitles'; t.srclang = l; t.label = n; videoPlayer.appendChild(t); } });
        await sleep(300);
        const st = await page.evaluate(() => { const subs = getSubtitleTracks(); return { n: subs.length, en: subs.find(t => t.language === 'en').mode, es: subs.find(t => t.language === 'es').mode, hint: document.getElementById('vodOsdTracks').textContent }; });
        check('English subtitle track auto-selected, Spanish off, OSD shows it', st.n === 2 && st.en === 'showing' && st.es === 'disabled' && /Subtitles: English/.test(st.hint) && /Green/.test(st.hint), JSON.stringify(st));
        await key('ColorF1Green', 404);
        const tm = await page.evaluate(() => ({ open: vodTracksOpen(), rows: [...document.querySelectorAll('.vod-track')].map(r => r.textContent.trim()), focused: document.querySelector('.vod-track.focused') && document.querySelector('.vod-track.focused').textContent.trim() }));
        check('Green opens the tracks menu with Off/Spanish/English, English focused', tm.open && tm.rows.length === 3 && /English/.test(tm.focused), JSON.stringify(tm));
        await key('ArrowUp', 38); await key('ArrowUp', 38);
        await page.evaluate(() => { const d = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }); Object.defineProperty(d, 'keyCode', { get: () => 13 }); document.dispatchEvent(d); const u = new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }); Object.defineProperty(u, 'keyCode', { get: () => 13 }); document.dispatchEvent(u); });
        await sleep(100);
        check('Up Up OK picks Off: all subtitle tracks disabled, manual choice remembered', await page.evaluate(() => getSubtitleTracks().every(t => t.mode === 'disabled') && vodPlay.subManual && /Subtitles: Off/.test(document.getElementById('vodOsdTracks').textContent)));
        await back();
        check('Back closes the tracks menu but keeps the player', await page.evaluate(() => !vodTracksOpen() && vodPlay.active));
        await back();
        await sleep(300);
        const afterBack = await page.evaluate(() => ({ screen: vodNav.screen, playerHidden: document.getElementById('vodPlayer').classList.contains('hidden'), slot: videoPlayer.parentNode.id, controls: videoPlayer.hasAttribute('controls'), btn: document.querySelector('.vod-btn.focused') && document.querySelector('.vod-btn.focused').textContent, prog: Object.values(vodProgress).filter(p => p.kind === 'movie').length, stored: !!localStorage.getItem('iptv_vod_progress') }));
        check('Back from player returns to details with a Resume button; progress saved; video returned to the guide', afterBack.screen === 'details' && afterBack.playerHidden && afterBack.slot === 'epgVideoWrap' && afterBack.controls && /Resume from 0:1\d/.test(afterBack.btn) && afterBack.prog === 1 && afterBack.stored, JSON.stringify(afterBack));
        // Start over button exists; Favorite toggles
        await key('ArrowRight', 39); await key('ArrowRight', 39); await key('Enter', 13); await sleep(100);
        check('Favorite toggles on from details', await page.evaluate(() => document.querySelector('.vod-btn.focused').textContent === '★ Favorite' && Object.keys(JSON.parse(localStorage.getItem('iptv_vod_favorites'))[localStorage.getItem('iptv_last_playlist')].movies).length === 1));
        await key('ArrowRight', 39);
        check('Remove from Continue Watching button is last', await page.evaluate(() => /Remove from Continue Watching/.test(document.querySelector('.vod-btn.focused').textContent)));
        const savedEntry = await page.evaluate(() => JSON.stringify(vodProgress));
        await key('Enter', 13); await sleep(100);
        check('Remove clears the movie progress; Play button no longer offers Resume', await page.evaluate(() => Object.values(vodProgress).filter(p => p.kind === 'movie').length === 0 && document.querySelector('.vod-btn.pri').textContent === '▶ Play' && !document.querySelector('.vod-btn.focused') === false));
        await page.evaluate(s => { vodProgress = JSON.parse(s); saveJson('iptv_vod_progress', vodProgress); renderVodDetails(); }, savedEntry); // restore for the Home checks
        await back(); // → grid
        check('Back from details returns to the grid', await page.evaluate(() => vodNav.screen === 'grid' && document.getElementById('vodDetails').style.display === 'none'));
        await back(); // → home
        await sleep(300);
        const home = await page.evaluate(() => ({ screen: vodNav.screen, list: vodNav.list, cw: document.querySelectorAll('.vod-card[data-pos^="cw:"]').length, fav: document.querySelectorAll('.vod-card[data-pos^="favs:"]').length, cwMeta: document.querySelector('.vod-card[data-pos="cw:0"] .vod-card-m') && document.querySelector('.vod-card[data-pos="cw:0"] .vod-card-m').textContent }));
        check('Home shows Continue Watching and Favorites rows', home.screen === 'home' && home.cw === 1 && home.fav === 1 && /left/.test(home.cwMeta), JSON.stringify(home));
        const cwBackup = await page.evaluate(() => JSON.stringify(vodProgress));
        await page.evaluate(() => { vodNav.zone = 'content'; vodNav.homeRow = 0; updateVodHomeFocus(); });
        await key('ColorF0Red', 403); await sleep(200);
        check('Red on a Continue Watching card removes it from the row', await page.evaluate(() => document.querySelectorAll('.vod-card[data-pos^="cw:"]').length === 0 && document.querySelectorAll('.vod-card[data-pos^="favs:"]').length === 1 && document.getElementById('epgToastTitle').textContent === 'Continue Watching'));
        await page.evaluate(s => { vodProgress = JSON.parse(s); saveJson('iptv_vod_progress', vodProgress); renderVodHome(); }, cwBackup);
        // Search all: typing filters the full catalog
        await page.evaluate(() => { document.querySelectorAll('.group-item')[2].click(); });
        await page.waitForFunction(() => vodNav.list === 'all' && vodNav.screen === 'grid' && vodNav.items.length === 300, { timeout: 10000 });
        check('Search all shows the full (non-adult) catalog and focuses the search box', await page.evaluate(() => document.activeElement === document.getElementById('vodSearchInput')));
        await page.keyboard.type('Comedy Movie 1');
        await sleep(400);
        check('typing filters all movies (prefix matches first)', await page.evaluate(() => vodNav.items.length === 15 && /^Comedy Movie 1\d$/.test(vodNav.items[0].name)), await page.evaluate(() => vodNav.items.length + ' first=' + (vodNav.items[0] && vodNav.items[0].name)));
        await key('ArrowDown', 40);
        check('Down leaves the search box into the grid', await page.evaluate(() => document.activeElement !== document.getElementById('vodSearchInput') && vodNav.zone === 'content'));

        // ---- Series
        await key('ColorF3Blue', 406); // Movies → Series
        await page.waitForFunction(() => vodMode === 'series' && vodNav.screen === 'home' && (seriesCats || []).length > 0, { timeout: 10000 });
        await page.evaluate(() => { document.querySelectorAll('#groupsList .group-item')[0].click(); }); // Drama Series
        await page.waitForFunction(() => vodNav.screen === 'grid' && vodNav.items.length === 20, { timeout: 10000 });
        await page.evaluate(() => { vodNav.zone = 'content'; vodNav.focus = 0; updateVodGridFocus(); });
        await key('Enter', 13);
        await page.waitForFunction(() => vodNav.screen === 'details' && vodNav.detail && vodNav.detail.info, { timeout: 10000 });
        const sd = await page.evaluate(() => ({ seasons: document.querySelectorAll('.vod-season').length, eps: document.querySelectorAll('.vod-ep').length, btn: document.querySelector('.vod-btn.focused').textContent, meta: document.querySelector('.vod-dmeta').textContent }));
        check('series details: 2 seasons, 3 episodes in season 1, Play S1 E1', sd.seasons === 2 && sd.eps === 3 && sd.btn === '▶ Play S1 E1' && /2 seasons · 5 episodes/.test(sd.meta), JSON.stringify(sd));
        await key('ArrowDown', 40); await key('ArrowRight', 39);
        check('Down to seasons, Right selects season 2 (2 episodes)', await page.evaluate(() => vodNav.detailZone === 'seasons' && vodNav.season === 1 && document.querySelectorAll('.vod-ep').length === 2));
        await key('ArrowLeft', 37); await key('ArrowDown', 40); await key('ArrowDown', 40);
        check('Down into episodes, E2 focused', await page.evaluate(() => vodNav.detailZone === 'episodes' && vodNav.epIdx === 1 && document.querySelector('.vod-ep.focused .vod-ept').textContent.includes('E2')));
        await key('Enter', 13);
        await page.waitForFunction(() => vodPlay.active && vodPlay.kind === 'episode', { timeout: 5000 });
        const ep = await page.evaluate(() => ({ src: videoPlayer.currentSrc || videoPlayer.src, title: vodPlay.title }));
        check('episode plays from the series endpoint', /\/series\/user\/pass\/\d+\.mp4$/.test(ep.src) && /S1 E2/.test(ep.title), JSON.stringify(ep));
        await page.waitForFunction(() => videoPlayer.currentTime > 0.5, { timeout: 10000 }).catch(() => {});
        // Simulate the end of the episode → Up Next card with countdown
        await page.evaluate(() => { videoPlayer.pause(); videoPlayer.dispatchEvent(new Event('ended')); });
        await sleep(200);
        const nx = await page.evaluate(() => ({ visible: vodNextVisible(), name: document.getElementById('vodNextName').textContent, label: document.getElementById('vodNextLabel').textContent, watched: Object.values(vodProgress).some(p => p.kind === 'episode' && p.watched) }));
        check('ended → Up Next card for S1 E3 with countdown; E2 marked watched', nx.visible && /S1 E3/.test(nx.name) && /plays in \d+ s/.test(nx.label) && nx.watched, JSON.stringify(nx));
        await page.evaluate(() => { const d = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }); Object.defineProperty(d, 'keyCode', { get: () => 13 }); document.dispatchEvent(d); const u = new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }); Object.defineProperty(u, 'keyCode', { get: () => 13 }); document.dispatchEvent(u); });
        await page.waitForFunction(() => vodPlay.active && /S1 E3/.test(vodPlay.title), { timeout: 5000 });
        check('OK on Play now starts the next episode', await page.evaluate(() => !vodNextVisible() && vodPlay.epIdx === 2));
        // Last episode of season 1 ends → rolls into season 2
        await page.evaluate(() => { videoPlayer.dispatchEvent(new Event('ended')); });
        await sleep(100);
        check('end of season rolls Up Next into season 2', await page.evaluate(() => vodNextVisible() && /S2 E1/.test(document.getElementById('vodNextName').textContent)));
        await key('ArrowRight', 39); // focus Cancel
        await page.evaluate(() => { const d = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }); Object.defineProperty(d, 'keyCode', { get: () => 13 }); document.dispatchEvent(d); const u = new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }); Object.defineProperty(u, 'keyCode', { get: () => 13 }); document.dispatchEvent(u); });
        await sleep(300);
        const canc = await page.evaluate(() => ({ active: vodPlay.active, screen: vodNav.screen, season: vodNav.season, ep: vodNav.epIdx, zone: vodNav.detailZone, checks: document.querySelectorAll('.vod-ep .vod-chk').length, btn: document.querySelector('.vod-btn.pri').textContent, focusedEp: document.querySelector('.vod-ep.focused .vod-ept') && document.querySelector('.vod-ep.focused .vod-ept').textContent }));
        check('Cancel returns to details on S2 E1; Play button advances; S1 fully ticked', !canc.active && canc.screen === 'details' && canc.btn === '▶ Play S2 E1' && canc.season === 1 && canc.ep === 0 && canc.zone === 'episodes' && /E1/.test(canc.focusedEp), JSON.stringify(canc));
        await key('ArrowLeft', 37); await key('ArrowLeft', 37); await sleep(100);
        check('season 1 shows both watched episodes ticked', await page.evaluate(() => vodNav.season === 0 && document.querySelectorAll('.vod-ep .vod-chk').length === 2));
        // Series home shows Continue Watching
        await back(); await back(); await sleep(300);
        check('Series home shows the show in Continue Watching', await page.evaluate(() => vodNav.screen === 'home' && document.querySelectorAll('.vod-card[data-pos^="cw:"]').length === 1 && /S1 E3/.test(document.querySelector('.vod-card[data-pos="cw:0"] .vod-card-m').textContent)));
        // Adult toggle in settings
        await page.evaluate(() => { settings.showAdult = true; saveSettings(); renderGroupsList(); });
        check('Show adult categories reveals the hidden category', await page.evaluate(() => [...document.querySelectorAll('#groupsList .group-item')].some(g => /Adult/.test(g.textContent))));
        await page.evaluate(() => { settings.showAdult = false; saveSettings(); renderGroupsList(); });
        // Back from Home → Live, channel resumes
        await back();
        await page.waitForFunction(() => vodMode === 'live', { timeout: 5000 });
        await sleep(400);
        const live = await page.evaluate(() => ({ ev: document.getElementById('epgView').style.display, vv: document.getElementById('vodView').style.display, slot: videoPlayer.parentNode.id, src: videoPlayer.getAttribute('src') || '', controls: videoPlayer.hasAttribute('controls'), rows: epgRenderedRows.size }));
        check('Back from Home returns to Live: guide visible, live stream reloaded, controls restored', live.ev === 'flex' && live.vv === 'none' && live.slot === 'epgVideoWrap' && /\/live\//.test(live.src) && live.controls && live.rows > 0, JSON.stringify(live));
    }

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
    await page.waitForFunction(() => currentPlaylistType === 'm3u' && mainApp.style.display === 'flex', { timeout: 10000 }).catch(async e => { console.log('DEMO STATE', JSON.stringify(await page.evaluate(() => ({ isLoading, type: currentPlaylistType, main: mainApp.style.display, start: startPage.className, status: startStatusMessage.textContent }))), 'ERRORS', errors.slice(0, 5)); throw e; });
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

    // ---------- Settings overlay (opened from the channel-list footer) ----------
    await page.evaluate(() => { document.querySelectorAll('.group-item')[1].click(); }); // All Channels (non-empty)
    await sleep(300);
    check('empty group leaves no stale rows (regression)', await page.evaluate(() => { const g = currentGroup; currentGroup = 'no-such-group'; renderChannelList(); const empty = renderedItems.size === 0; currentGroup = g; renderChannelList(); return empty && renderedItems.size > 0; }));
    await page.click('#settingsFooterBtn');
    check('settings opens from footer button', await page.evaluate(() => settingsOpen && !document.getElementById('settingsOverlay').classList.contains('hidden')));
    check('settings: first row focused', await page.evaluate(() => document.querySelector('.settings-row.focused').dataset.id === 'textScale'));
    await key('ArrowLeft', 37); await sleep(150);
    const ts = await page.evaluate(() => ({ s: settings.textScale, rowH: EPG_ROW_H, cssVar: getComputedStyle(document.documentElement).getPropertyValue('--epg-row-h').trim(), item: renderedItems.get(0) && renderedItems.get(0).style.height, stored: JSON.parse(localStorage.getItem('iptv_settings')).textScale }));
    check('text size Left → 125%, rows and CSS var follow, persisted', ts.s === 1.25 && ts.rowH === 79 && ts.cssVar === '78px' && ts.item === '63px' && ts.stored === 1.25, JSON.stringify(ts));
    await key('ArrowRight', 39); await sleep(150);
    check('text size Right → back to 137%', await page.evaluate(() => settings.textScale === 1.375 && EPG_ROW_H === 86));
    await key('ArrowDown', 40); await key('ArrowRight', 39); await sleep(100);
    check('clock Right → 24-hour, persisted', await page.evaluate(() => settings.clock === '24' && JSON.parse(localStorage.getItem('iptv_settings')).clock === '24' && /^\d{2}:\d{2}$/.test(formatClock(Date.now()))));
    await key('ArrowLeft', 37); await sleep(100);
    check('clock Left → 12-hour', await page.evaluate(() => settings.clock === '12' && /[AP]M$/.test(formatClock(Date.now()))));
    await key('ArrowDown', 40); await key('Enter', 13); await sleep(100);
    check('auto-load toggle Enter → On, persisted', await page.evaluate(() => settings.autoLoad === true && JSON.parse(localStorage.getItem('iptv_settings')).autoLoad === true));
    check('per-playlist rows disabled for the demo', await page.evaluate(() => [...document.querySelectorAll('.settings-row')].filter(r => r.classList.contains('disabled')).map(r => r.dataset.id).join(',') === 'startGroup,resume'));
    await back();
    check('Back closes settings', await page.evaluate(() => !settingsOpen && document.getElementById('settingsOverlay').classList.contains('hidden')));
    await key('ColorF2Yellow', 405);
    check('Yellow key opens settings', await page.evaluate(() => settingsOpen));
    // Clear favorites via confirm dialog
    await page.evaluate(() => { favoriteIds.add('x1'); favoriteIds.add('x2'); renderSettings(); });
    await page.evaluate(() => { settingsFocusIdx = settingsFocusables(_settingsRowsCache).indexOf('clearFavs'); renderSettings(); });
    await key('Enter', 13);
    check('Clear favorites opens confirm dialog', await page.evaluate(() => !confirmDialog.classList.contains('hidden')));
    await key('ArrowLeft', 37); await key('Enter', 13); await sleep(100);
    check('confirm Yes clears favorites, settings still open', await page.evaluate(() => favoriteIds.size === 0 && settingsOpen && localStorage.getItem('iptv_favorites') === '[]'));
    await back();

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

    // ---------- Auto-load + per-playlist resume / starting group across a relaunch ----------
    // The Xtream playlist was the last real playlist loaded; mark a starting group and a last channel for it.
    await page.evaluate(() => {
        const key = localStorage.getItem('iptv_last_playlist');
        const st = JSON.parse(localStorage.getItem('iptv_playlist_state') || '{}');
        st[key] = Object.assign(st[key] || {}, { startGroup: 'all', lastChannel: { url: 'http://localhost:8765/live/user/pass/1234.m3u8', tvgId: 'ch1234.test' } });
        localStorage.setItem('iptv_playlist_state', JSON.stringify(st));
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => currentPlaylistType === 'xtream' && epgMode && currentChannelIndex >= 0, { timeout: 30000 }).catch(() => {});
    await sleep(500);
    const al = await page.evaluate(() => ({ type: currentPlaylistType, group: currentGroup, idx: currentChannelIndex, name: channels[currentChannelIndex] && channels[currentChannelIndex].name, focus: epgFocusedRowIdx, rowOk: !!epgRenderedRows.get(epgFocusedRowIdx) && epgRenderedRows.get(epgFocusedRowIdx).classList.contains('epg-focused') }));
    check('auto-load relaunch opens the last playlist in the guide', al.type === 'xtream', JSON.stringify(al));
    check('starting group "All Channels" applied', al.group === 'all');
    check('resumes last channel and focuses its row', al.name === 'Channel 01234' && al.focus === 1233 && al.rowOk, JSON.stringify(al));
    await page.click('#epgSettingsBtn');
    check('settings opens from the guide button; per-playlist rows enabled', await page.evaluate(() => settingsOpen && !document.querySelector('.settings-row[data-id="startGroup"]').classList.contains('disabled') && document.querySelector('.settings-row[data-id="startGroup"] .settings-val').textContent === 'All Channels'));
    await page.evaluate(() => { settingsFocusIdx = settingsFocusables(_settingsRowsCache).indexOf('resume'); renderSettings(); });
    await key('ArrowLeft', 37); await sleep(100);
    check('resume Left → Off for this playlist', await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_playlist_state'))[localStorage.getItem('iptv_last_playlist')].resume === false));
    await back();
    // Up/Down in the guide must still work after the settings overlay closes
    const fb = await page.evaluate(() => epgFocusedRowIdx);
    await key('ArrowDown', 40);
    check('guide navigation resumes after closing settings', await page.evaluate(() => epgFocusedRowIdx) === fb + 1);

    check('no uncaught page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
    await browser.close();
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('E2E CRASH', e); process.exit(2); });
