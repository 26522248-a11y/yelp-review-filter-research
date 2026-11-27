// testpace/page-dump.js - exploratory only: what login form does a host serve?
// env: URL [BID=6] [WAIT=8000] [PU_BASE PW / PU]

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BID = parseInt(process.env.BID || '6', 10);
const URLX = process.env.URL || 'https://biz.yelp.com/login';
const WAIT = parseInt(process.env.WAIT || '9000', 10);
const PU_BASE = process.env.PU_BASE, PW = process.env.PW;
const SESS = process.env.SESSID || ('pd' + BID + Math.floor(Math.random() * 100000));
const PU = process.env.PU || (PU_BASE + '-sessid-' + SESS + '-sesstime-1800');
const AUTH = 'Basic ' + Buffer.from(PU + ':' + PW).toString('base64');
const PH = process.env.PROXY_HOST || 'pr.oxylabs.io';
const PP = parseInt(process.env.PROXY_PORT || '7777', 10);
const LP = 9290 + BID, CP = 9690 + BID;

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
(async () => {
  await new Promise(r => relay.listen(LP, '127.0.0.1', r));
  const udd = path.join(os.tmpdir(), 'pd-' + Date.now());
  const chrome = spawn(process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--no-first-run', '--no-default-browser-check', '--window-size=900,700', '--lang=en-US',
    '--user-data-dir=' + udd, '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--proxy-server=http://127.0.0.1:' + LP, '--remote-debugging-port=' + CP, 'about:blank'
  ], { stdio: 'ignore' });
  let ver = null;
  for (let k = 0; k < 60 && !ver; k++) { await sleep(250); try { ver = await (await fetch('http://127.0.0.1:' + CP + '/json/version')).json(); } catch (e) {} }
  if (!ver) { console.log('no cdp'); chrome.kill(); relay.close(); return; }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  ws.addEventListener('error', () => {});
  let id = 0; const pend = new Map();
  ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {} })); });
  let sid = null;
  for (let k = 0; k < 60 && !sid; k++) { await sleep(250); const t = await send('Target.getTargets'); if (t && t.result) { const pg = t.result.targetInfos.find(x => x.type === 'page'); if (pg) { const a = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true }); if (a && a.result) sid = a.result.sessionId; } } }
  if (!sid) { console.log('no sid'); chrome.kill(); relay.close(); return; }
  const sendS = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {}, sessionId: sid })); });
  const ev = e => new Promise(resolve => {
    const mid = Math.floor(Math.random() * 1e9);
    const h = x => { try { const m = JSON.parse(x.data); if (m.id === mid) { ws.removeEventListener('message', h); resolve(m.result && m.result.result ? m.result.result.value : null); } } catch (err) {} };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true }, sessionId: sid }));
    setTimeout(() => resolve(null), 25000);
  });
  await sendS('Page.enable');
  await sendS('Page.navigate', { url: URLX });
  await sleep(WAIT);
  if (process.env.SUBMIT === '1') {
    const sub = await ev(`(async function(){
      window.__log=[];
      var of=window.fetch; window.fetch=function(u,o){ try{ window.__log.push({t:'f',u:String(u),m:(o&&o.method)||'GET',b:o&&o.body?String(o.body).slice(0,200):''}); }catch(e){} return of.apply(this,arguments); };
      var ox=XMLHttpRequest.prototype.open, os=XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open=function(m,u){ this.__m=m; this.__u=u; return ox.apply(this,arguments); };
      XMLHttpRequest.prototype.send=function(b){ try{ window.__log.push({t:'x',u:String(this.__u),m:this.__m,b:b?String(b).slice(0,200):''}); }catch(e){} return os.apply(this,arguments); };
      function setv(el,v){ var d=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value'); try{ d.set.call(el,v); }catch(e){ el.value=v; } el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
      var e=document.querySelector('input[name=email],input[type=email]'); var p=document.querySelector('input[name=password],input[type=password]');
      if(e) setv(e,'biz.probe.${Date.now()}@gmail.com'); if(p) setv(p,'WrongPass!7788');
      var w=document.querySelector('[data-hcaptcha-widget-id]'); var wid=w&&w.getAttribute('data-hcaptcha-widget-id');
      if(wid&&window.hcaptcha){ try{ window.hcaptcha.execute(wid); }catch(err){} await new Promise(r=>setTimeout(r,2500)); }
      var tok=''; try{ tok=window.hcaptcha.getResponse(wid)||''; }catch(err){}
      ['h-captcha-response','g-recaptcha-response'].forEach(function(n){ var t=document.querySelector('textarea[name='+n+'],input[name='+n+']'); if(t&&tok) setv(t,tok); });
      var f=document.forms[0]; if(f){ if(f.requestSubmit) f.requestSubmit(); else f.submit(); }
      await new Promise(r=>setTimeout(r,12000));
      return JSON.stringify({tokLen:tok.length,u:location.href,t:document.title,txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300),log:window.__log.slice(0,8)});
    })()`);
    console.log('SUBMIT ' + sub);
    chrome.kill(); relay.close();
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
    setTimeout(() => process.exit(0), 300);
    return;
  }
  const out = await ev(`JSON.stringify({u:location.href,t:document.title,
    forms:[...document.forms].map(f=>({id:f.id,a:f.getAttribute('action'),m:f.method,inp:[...f.querySelectorAll('input,select')].map(i=>i.name+(i.type==='hidden'?':h':'')).slice(0,14)})),
    hc:!!window.hcaptcha, dd:(document.documentElement.outerHTML.match(/captcha-delivery|datadome/i)||[''])[0],
    links:[...document.querySelectorAll('a[href*="login"],a[href*="signup"]')].map(a=>a.href).slice(0,6), sk:[...document.documentElement.outerHTML.matchAll(/sitekey["':= ]+([0-9a-f-]{36})/g)].map(m=>m[1]), w:[...document.querySelectorAll('[data-hcaptcha-widget-id]')].map(e=>e.getAttribute('data-hcaptcha-widget-id')), btn:[...document.querySelectorAll('button')].map(b=>b.type+":"+b.textContent.trim().slice(0,20)).slice(0,8), api:Object.keys(window).filter(k=>/login|config|api|__/i.test(k)).slice(0,15),
    len:document.documentElement.outerHTML.length})`);
  console.log(out);
  chrome.kill(); relay.close();
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(0), 300);
})();
