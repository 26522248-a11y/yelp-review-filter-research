// testpace/pace-paths.js - after the 15/min budget is spent on /login/newajax,
// do other credential-ish endpoints answer, and does changing UA help?
//
// env: PU_BASE PW [PU] [SESSID] [BID=2]

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BID = parseInt(process.env.BID || '2', 10);
const PU_BASE = process.env.PU_BASE, PW = process.env.PW;
const SESS = process.env.SESSID || ('pp' + BID + Math.floor(Math.random() * 100000));
const PU = process.env.PU || (PU_BASE + '-sessid-' + SESS + '-sesstime-1800');
const PH = process.env.PROXY_HOST || 'pr.oxylabs.io';
const PP = parseInt(process.env.PROXY_PORT || '7777', 10);
const SITEKEY = process.env.SITEKEY || '6660d4df-1884-4ac6-a933-e5f3bd460946';
const AUTH = 'Basic ' + Buffer.from(PU + ':' + PW).toString('base64');
const LP = 9490 + BID, CP = 9890 + BID;
const OUT = process.env.OUT || path.join(__dirname, 'paths-' + SESS + '.jsonl');

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
  rec({ event: 'start', sess: SESS });
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
    '--proxy-server=http://127.0.0.1:' + LP, '--remote-debugging-port=' + CP, 'about:blank'
  ], { stdio: 'ignore' });

  let ver = null;
  for (let k = 0; k < 60 && !ver; k++) { await sleep(250); try { ver = await (await fetch('http://127.0.0.1:' + CP + '/json/version')).json(); } catch (e) {} }
  if (!ver) { rec({ event: 'abort', why: 'cdp' }); chrome.kill(); relay.close(); return; }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  ws.addEventListener('error', () => {});
  let id = 0; const pend = new Map();
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Fetch.requestPaused') { ws.send(JSON.stringify({ id: ++id, method: 'Fetch.failRequest', params: { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, sessionId: m.sessionId })); return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {} })); });
  let sid = null;
  for (let k = 0; k < 60 && !sid; k++) { await sleep(250); const t = await send('Target.getTargets'); if (t && t.result) { const pg = t.result.targetInfos.find(x => x.type === 'page'); if (pg) { const a = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true }); if (a && a.result) sid = a.result.sessionId; } } }
  if (!sid) { rec({ event: 'abort', why: 'cdp' }); chrome.kill(); relay.close(); return; }
  const sendS = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {}, sessionId: sid })); });
  const ev = e => new Promise(resolve => {
    const mid = Math.floor(Math.random() * 1e9);
    const h = x => { try { const m = JSON.parse(x.data); if (m.id === mid) { ws.removeEventListener('message', h); resolve(m.result && m.result.result ? m.result.result.value : null); } } catch (err) {} };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true }, sessionId: sid }));
    setTimeout(() => resolve(null), 40000);
  });
  await sendS('Page.enable'); await sendS('Network.enable', {});
  await sendS('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sendS('Page.bringToFront', {});
  await sendS('Fetch.enable', { patterns: [
    { urlPattern: '*', resourceType: 'Image', requestStage: 'Request' },
    { urlPattern: '*', resourceType: 'Media', requestStage: 'Request' },
    { urlPattern: '*', resourceType: 'Font', requestStage: 'Request' }] });

  await sendS('Page.navigate', { url: 'https://www.yelp.com/login/' });
  let ok = false;
  for (let k = 0; k < 30; k++) {
    await sleep(1000);
    const s = await ev(`JSON.stringify({f:!!document.getElementById('ajax-login'),h:!!window.hcaptcha,l:document.documentElement.outerHTML.length})`);
    try { const o = JSON.parse(s); if (o && o.f && o.h) { ok = true; break; } } catch (e) {}
  }
  if (!ok) { rec({ event: 'abort', why: 'hydrate' }); chrome.kill(); relay.close(); return; }
  rec({ event: 'widget', armed: await ev(`(function(){ if(!window.hcaptcha) return 'no-api'; var d=document.createElement('div');d.style.display='none';document.body.appendChild(d);window.__wid=window.hcaptcha.render(d,{sitekey:'${SITEKEY}',size:'invisible',callback:function(t){window.__fcTok=t}});return 'own:'+window.__wid; })()`) });
  const mint = () => ev(`new Promise(function(res){var w=window.__wid;window.__fcTok='';try{window.hcaptcha.execute(w)}catch(e){res('');return}var n=0;var iv=setInterval(function(){n++;var t=window.__fcTok||window.hcaptcha.getResponse(w)||'';if(t){clearInterval(iv);res(t)}else if(n>60){clearInterval(iv);res('')}},200)})`);
  const csrfIn = sel => ev(`(function(){var i=document.querySelector(${JSON.stringify(sel)});return i?i.value:''})()`);
  const post = (url, body, hdr) => ev(`(async function(){try{var r=await fetch(${JSON.stringify(url)},{method:'POST',credentials:'include',headers:Object.assign({'Content-Type':'application/x-www-form-urlencoded'},${JSON.stringify(hdr || {})}),body:${JSON.stringify(body)}});var t=await r.text();return JSON.stringify({status:r.status,loc:r.headers.get('location')||'',body:t.slice(0,180)})}catch(e){return JSON.stringify({status:-1,body:String(e)})}})()`);

  const ajaxCsrf = await csrfIn('#ajax-login input[name=csrftok]');
  // burn the budget
  for (let k = 0; k < 15; k++) {
    const t = await mint(); if (!t) { rec({ event: 'tokfail', k }); break; }
    const b = new URLSearchParams({ csrftok: ajaxCsrf, email: 'burn' + k + '@gmail.com', password: 'WrongPass!7788', hcaptcha_response: t }).toString();
    const r = await post('/login/newajax', b, { 'X-Requested-With': 'XMLHttpRequest' });
    let o = {}; try { o = JSON.parse(r) } catch (e) {}
    rec({ phase: 'burn', k: k + 1, status: o.status, body: (o.body || '').slice(0, 40) });
  }
  const control = await (async () => { const t = await mint(); const b = new URLSearchParams({ csrftok: ajaxCsrf, email: 'ctl@gmail.com', password: 'WrongPass!7788', hcaptcha_response: t }).toString(); return await post('/login/newajax', b, { 'X-Requested-With': 'XMLHttpRequest' }); })();
  rec({ phase: 'control', v: control });

  // magic link form (its own csrf, password field exists in the markup)
  const mlCsrf = await csrfIn('#magic-link-login input[name=csrftok]');
  {
    const t = await mint();
    const b = new URLSearchParams({ csrftok: mlCsrf, email: 'magic.probe@gmail.com', password: 'WrongPass!7788', hcaptcha_response: t }).toString();
    rec({ phase: 'magic_link', csrfLen: (mlCsrf || '').length, v: await post('/login/magic_link', b, { 'X-Requested-With': 'XMLHttpRequest' }) });
  }
  // magic link request form (email only)
  {
    const c2 = await csrfIn('form[name=magic_link_request_form] input[name=csrftok]');
    const t = await mint();
    const b = new URLSearchParams({ csrftok: c2, email: 'magic.probe@gmail.com', hcaptcha_response: t }).toString();
    rec({ phase: 'magic', csrfLen: (c2 || '').length, v: await post('/login/magic', b, { 'X-Requested-With': 'XMLHttpRequest' }) });
  }
  // forgot password (email only)
  {
    const c3 = await csrfIn('form[name=forgot_form] input[name=csrftok]');
    const t = await mint();
    const b = new URLSearchParams({ csrftok: c3, email: 'magic.probe@gmail.com', hcaptcha_response: t }).toString();
    rec({ phase: 'forgot', csrfLen: (c3 || '').length, v: await post('/forgot/ajax', b, { 'X-Requested-With': 'XMLHttpRequest' }) });
  }
  // same endpoint, different UA (Chrome desktop -> iPhone)
  {
    let uaSet = null;
    try { uaSet = await sendS('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1' }); } catch (e) {}
    const t = await mint();
    const b = new URLSearchParams({ csrftok: ajaxCsrf, email: 'ua.probe@gmail.com', password: 'WrongPass!7788', hcaptcha_response: t }).toString();
    rec({ phase: 'ua', v: await post('/login/newajax', b, { 'X-Requested-With': 'XMLHttpRequest' }) });
    try { await sendS('Network.setUserAgentOverride', { userAgent: '' }); } catch (e) {}
  }
  // wait one full window, then magic_link once more (still wrong password)
  await sleep(62000);
  {
    const t = await mint();
    const b = new URLSearchParams({ csrftok: mlCsrf, email: 'magic.probe@gmail.com', password: 'WrongPass!7788', hcaptcha_response: t }).toString();
    rec({ phase: 'magic_link_cold', tokLen: String(t || '').length, v: await post('/login/magic_link', b, { 'X-Requested-With': 'XMLHttpRequest' }) });
  }

  rec({ event: 'summary', sess: SESS });
  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  try { relay.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 500);
})();
