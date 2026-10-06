// Profiles guide scrolling in headless Chrome against the mock server: loads the Xtream playlist,
// switches to All Channels, holds ArrowDown (simulated key repeat), and reports where the time goes.
//   python mock_server.py 3000   (terminal 1)
//   node profile_guide.js [steps] [intervalMs]
const puppeteer = require('puppeteer-core');
const BASE = 'http://localhost:8765';
const STEPS = parseInt(process.argv[2] || '80', 10);
const INTERVAL = parseInt(process.argv[3] || '60', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        headless: true,
        args: ['--window-size=1920,1080', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
        defaultViewport: { width: 1920, height: 1080 },
    });
    const page = await browser.newPage();
    await fetch(BASE + '/__reset');
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('iptv_settings', JSON.stringify({ liveBuffer: 0, schema: 3 })); });
    await page.reload({ waitUntil: 'load' });
    await page.type('#xtreamServer', BASE); await page.type('#xtreamUsername', 'user'); await page.type('#xtreamPassword', 'pass');
    await page.click('#saveXtreamBtn'); await page.waitForSelector('.saved-item', { timeout: 5000 });
    await page.click('.saved-item'); await page.click('#loadSelectedBtn');
    await page.waitForFunction(() => document.getElementById('epgView').style.display === 'flex' && document.querySelectorAll('.group-item').length > 1, { timeout: 90000 }); // Favorites is empty here; All Channels is clicked next
    await page.evaluate(() => { document.querySelectorAll('.group-item')[1].click(); });
    await page.waitForFunction(() => currentGroup === 'all' && epgRenderedRows.size > 5);
    if (process.env.OVERRIDE_CSS) { await page.addStyleTag({ content: process.env.OVERRIDE_CSS }); console.log('CSS override applied:', process.env.OVERRIDE_CSS); }
    await sleep(1500);

    const cdp = await page.target().createCDPSession();
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    // Instrument: time spent inside handleRemoteNav per key, and long tasks
    await page.evaluate(() => {
        window.__keyTimes = []; window.__long = [];
        const orig = handleRemoteNav;
        window.handleRemoteNav = function (e) { const t0 = performance.now(); orig(e); window.__keyTimes.push(performance.now() - t0); };
        document.removeEventListener('keydown', orig);
        document.addEventListener('keydown', window.handleRemoteNav);
        try { new PerformanceObserver(l => { for (const en of l.getEntries()) window.__long.push(Math.round(en.duration)); }).observe({ type: 'longtask', buffered: false }); } catch (_) {}
        window.__fetches = 0; const of = window.fetch; window.fetch = function () { window.__fetches++; return of.apply(this, arguments); };
        window.__rowsBuilt = 0; const ob = buildEPGRow; window.buildEPGRow = function (i) { window.__rowsBuilt++; return ob(i); };
    });
    await cdp.send('Profiler.start');
    await page.tracing.start({ categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing'] });
    const t0 = Date.now();
    for (let i = 0; i < STEPS; i++) {
        await page.evaluate(() => {
            const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'keyCode', { get: () => 40 });
            document.dispatchEvent(ev);
        });
        await sleep(INTERVAL);
    }
    await sleep(2500); // let debounced fetches + row updates land
    const wall = Date.now() - t0;
    const { profile } = await cdp.send('Profiler.stop');
    const traceBuf = await page.tracing.stop();
    // Renderer-side costs the JS profiler does not see: style, layout, paint, image decode, HTML parsing
    let ev = [];
    try { const txt = Buffer.from(traceBuf).toString('utf8'); const j = JSON.parse(txt.slice(txt.indexOf('{') === 0 || txt.indexOf('[') === 0 ? 0 : Math.min(...[txt.indexOf('{'), txt.indexOf('[')].filter(i => i >= 0)))); ev = Array.isArray(j) ? j : (j.traceEvents || []); }
    catch (e) { console.log('trace parse failed:', e.message, 'head:', JSON.stringify(Buffer.from(traceBuf).toString('utf8').slice(0, 120))); }
    const cats = {}; const counts = {};
    for (const e of ev) {
        if (e.ph !== 'X' || !e.dur) continue;
        if (!/^(UpdateLayoutTree|Layout|Paint|PrePaint|Decode Image|ImageDecodeTask|ParseHTML|FunctionCall|EventDispatch|HitTest|CompositeLayers|Layerize|UpdateLayer|ScrollLayer|RunTask|Commit|ParseAuthorStyleSheet)$/.test(e.name)) continue;
        cats[e.name] = (cats[e.name] || 0) + e.dur / 1000; counts[e.name] = (counts[e.name] || 0) + 1;
    }
    const imgReq = ev.filter(e => e.name === 'ResourceSendRequest' && e.args && e.args.data && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(e.args.data.url || '')).length;
    console.log('renderer work during the run (ms, count):', Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v.toFixed(0)}(${counts[k]})`).join('  '), ` image requests=${imgReq}`);

    // Aggregate self time per function
    const self = new Map();
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const dt = profile.timeDeltas; let total = 0;
    for (let i = 0; i < profile.samples.length; i++) {
        const n = byId.get(profile.samples[i]); const d = dt[i] || 0; total += d;
        const cf = n.callFrame; const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
        self.set(key, (self.get(key) || 0) + d);
    }
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22);
    const m = await page.evaluate(() => ({ keys: window.__keyTimes, long: window.__long, fetches: window.__fetches, rows: window.__rowsBuilt, rendered: epgRenderedRows.size, focus: epgFocusedRowIdx }));
    const avg = m.keys.reduce((a, b) => a + b, 0) / Math.max(1, m.keys.length);
    const max = Math.max(...m.keys);
    console.log(`steps=${STEPS} interval=${INTERVAL}ms wall=${wall}ms  rows built=${m.rows} (rendered ${m.rendered}, focus ${m.focus})  epg fetches=${m.fetches}`);
    console.log(`handleRemoteNav per key: avg ${avg.toFixed(1)} ms, max ${max.toFixed(1)} ms;  long tasks(>50ms): ${m.long.length} ${m.long.slice(0, 12).join(',')}`);
    console.log(`sampled ${(total / 1000).toFixed(0)} ms; top self-time:`);
    for (const [k, v] of top) console.log(`  ${(v / 1000).toFixed(1).padStart(7)} ms  ${k}`);
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
