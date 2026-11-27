// testpace/db-share.js - exploratory only.
//
// Question: is the account DB shared between www.yelp.com and the CloudFront sites
// (www.yelp.co.uk, www.yelp.com.au) that showed an independent 429 bucket?
//
// Method: create one throwaway account on www.yelp.com (signup auto-login),
// then try username/password login on .co.uk and .com.au.
// success:true there => same account DB => those hosts are usable as extra verdict lanes.
//
// env: PU_BASE PW [PU] [SESSID] [BID=9] [EMAIL] [PASS]

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BID = parseInt(process.env.BID || '9', 10);
const PU_BASE = process.env.PU_BASE, PW = process.env.PW;
const SESS = process.env.SESSID || ('db' + BID + Math.floor(Math.random() * 100000));
const PU = process.env.PU || (PU_BASE + '-sessid-' + SESS + '-sesstime-1800');
const PH = process.env.PROXY_HOST || 'pr.oxylabs.io';
const PP = parseInt(process.env.PROXY_PORT || '7777', 10);
const SITEKEY = process.env.SITEKEY || '6660d4df-1884-4ac6-a933-e5f3bd460946';
const AUTH = 'Basic ' + Buffer.from(PU + ':' + PW).toString('base64');
const LP = 9190 + BID, CP = 9590 + BID;
const OUT = process.env.OUT || path.join(__dirname, 'dbshare-' + SESS + '.jsonl');
const EMAIL = process.env.EMAIL || ('db.probe.' + Date.now() + '@gmail.com');
const PASS = process.env.PASS || 'TestPass!7788';
const HOSTS = (process.env.HOSTS || 'www.yelp.co.uk,www.yelp.com.au').split(',');

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
  rec({ event: 'start', sess: SESS, email: EMAIL });
  await new Promise(r => relay.listen(LP, '127.0.0.1', r));
  const udd = path.join(os.tmpdir(), 'db-' + Date.now());
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
    setTimeout(() => resolve(null), 25000);
  });

  await sendS('Page.enable'); await sendS('Network.enable', {});
  await sendS('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sendS('Page.bringToFront', {});
  await sendS('Fetch.enable', { patterns: [
    { urlPattern: '*', resourceType: 'Image', requestStage: 'Request' },
    { urlPattern: '*', resourceType: 'Media', requestStage: 'Request' },
    { urlPattern: '*', resourceType: 'Font', requestStage: 'Request' }] });
  try { await sendS('Network.setBlockedURLs', { urls: require('../runner/bw-blocklist') }); } catch (e) {}

  async function hydrate(url, need) {
    for (let a = 0; a < 3; a++) {
      await sendS('Page.navigate', { url });
      for (let k = 0; k < 30; k++) {
        await sleep(800);
        const s = await ev(`JSON.stringify({f:${need.form},h:!!window.hcaptcha,l:document.documentElement.outerHTML.length,u:location.href})`);
        try { const o = JSON.parse(s); if (o && o.f && o.h) return o; } catch (e) {}
      }
    }
    return null;
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
      else if(n>70){ clearInterval(iv); fin(''); }
    },200);
  })`);
  const csrfIn = sel => ev(`(function(){var i=document.querySelector(${JSON.stringify(sel)});return i?i.value:'';})()`);
  const postJS = (url, opts) => ev(`(async function(){
    try {
      var r=await fetch(${JSON.stringify(url)},${JSON.stringify(opts)});
      var txt=await r.text();
      return JSON.stringify({status:r.status, loc:r.headers.get('location')||'', ra:r.headers.get('retry-after')||'', body:txt.slice(0,300)});
    } catch(e){ return JSON.stringify({status:-1, body:'fetch:'+e.message}); }
  })()`);
  const loggedIn = () => ev(`(async()=>{ try { const r=await fetch('/profile',{credentials:'include',redirect:'manual'}); return JSON.stringify({status:r.status,loc:r.headers.get('location')||'',len:(await r.text()).length}); } catch(e){ return JSON.stringify({status:-1}); } })()`);

  // ---- 1) signup on www.yelp.com ----
  const su = await hydrate('https://www.yelp.com/signup', { form: "!!document.getElementById('signup-form')" });
  if (!su) { rec({ event: 'abort', why: 'signup-hydrate' }); chrome.kill(); relay.close(); return; }
  rec({ event: 'signup-page', url: su.u, len: su.l });
  const armed = await arm();
  rec({ event: 'widget', armed });
  const tok = await mint();
  if (!tok) { rec({ event: 'abort', why: 'token' }); chrome.kill(); relay.close(); return; }
  const csrf = await csrfIn('#signup-form input[name=csrftok]');
  const b = new URLSearchParams();
  b.set('csrftok', csrf); b.set('first_name', 'Test'); b.set('last_name', 'Probe');
  b.set('email', EMAIL); b.set('password', PASS); b.set('city', 'San Francisco'); b.set('zip', '94103');
  b.set('signup_source', 'default'); b.set('hcaptcha_response', tok);
  const r = await postJS('/signup', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() });
  let o = {}; try { o = JSON.parse(r || '{}'); } catch (e) {}
  rec({ event: 'signup', status: o.status, loc: o.loc, body: (o.body || '').slice(0, 200) });
  await sleep(2500);
  rec({ event: 'profile-after-signup', v: await loggedIn() });
  {
    const ck = await sendS('Network.getAllCookies', {});
    const all = (ck && ck.result && ck.result.cookies) || [];
    rec({ event: 'auth-cookies', zss: all.filter(x => x.name === 'zss').map(x => ({ d: x.domain, len: x.value.length })), names: all.filter(x => /^(zss|bv|datadome)$/.test(x.name)).map(x => x.name + '@' + x.domain) });
  }

  // ---- 2) login with those creds on other hosts ----
  for (const h of HOSTS) {
    const p = await hydrate('https://' + h + '/login', { form: "!!document.getElementById('ajax-login')" });
    if (!p) { rec({ event: 'host', host: h, why: 'no-page' }); continue; }
    const a = await arm();
    rec({ event: 'host-page', host: h, url: p.u, csrfLen: (await csrfIn('#ajax-login input[name=csrftok]') || '').length, armed: a });
    const t2 = await mint();
    if (!t2) { rec({ event: 'host', host: h, why: 'token' }); continue; }
    const c2 = await csrfIn('#ajax-login input[name=csrftok]');
    const bb = new URLSearchParams();
    bb.set('csrftok', c2); bb.set('email', EMAIL); bb.set('password', PASS); bb.set('hcaptcha_response', t2);
    const rr = await postJS('/login/newajax', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body: bb.toString() });
    let oo = {}; try { oo = JSON.parse(rr || '{}'); } catch (e) {}
    rec({ event: 'host-login', host: h, status: oo.status, body: (oo.body || '').slice(0, 160) });
    await sleep(1500);
    rec({ event: 'host-profile', host: h, v: await loggedIn() });
  }

  // ---- 3) duplicate-email check: signup again with same email on .co.uk / .com.au ----
  for (const h of HOSTS) {
    const p = await hydrate('https://' + h + '/signup', { form: "!!document.getElementById('signup-form')" });
    if (!p) { rec({ event: 'dupe', host: h, why: 'no-page' }); continue; }
    await arm();
    const t3 = await mint();
    if (!t3) { rec({ event: 'dupe', host: h, why: 'token' }); continue; }
    const c3 = await csrfIn('#signup-form input[name=csrftok]');
    const bb = new URLSearchParams();
    bb.set('csrftok', c3); bb.set('first_name', 'Test'); bb.set('last_name', 'Probe');
    bb.set('email', EMAIL); bb.set('password', PASS); bb.set('city', 'London'); bb.set('zip', 'SW1A 1AA'); bb.set('signup_source', 'default'); bb.set('hcaptcha_response', t3);
    const rr = await postJS('/signup', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: bb.toString() });
    let oo = {}; try { oo = JSON.parse(rr || '{}'); } catch (e) {}
    rec({ event: 'dupe-signup', host: h, status: oo.status, loc: oo.loc, body: (oo.body || '').slice(0, 200) });
  }

  rec({ event: 'summary', sess: SESS, email: EMAIL, pass: PASS });
  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  try { relay.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 500);
})();
