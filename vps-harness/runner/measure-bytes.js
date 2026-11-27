// Measure how many bytes the Yelp login page pulls over the wire, with and without
// the bandwidth filters used by batch-fast.js. Direct connection, no proxy credits burnt.
//
//   set MODE=baseline & node runner\measure-bytes.js
//   set MODE=lean     & node runner\measure-bytes.js
//
// Prints total MB, per-resource-type MB and the request count.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const MODE = process.env.MODE || 'lean';
const LEAN = MODE !== 'baseline';
const CP = 9600 + Math.floor(Math.random() * 200);
const udd = path.join(os.tmpdir(), 'meas-' + MODE + '-' + Date.now());
const CDD = path.join(os.tmpdir(), 'meas-cache-' + MODE);
try { fs.mkdirSync(CDD, { recursive: true }); } catch (e) {}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const flags = ['--no-first-run', '--no-default-browser-check', '--window-size=900,700',
  '--user-data-dir=' + udd, '--remote-debugging-port=' + CP, 'about:blank'];
if (LEAN) flags.push(
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--blink-settings=imagesEnabled=false', '--disable-remote-fonts',
  '--disk-cache-dir=' + CDD, '--disk-cache-size=67108864', '--media-cache-size=1',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,Prerender2,SpeculationRulesPrefetch'
);

const BLOCK = require('./bw-blocklist');

(async () => {
  const chrome = spawn(process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', flags, { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) {
    await sleep(300);
    try { ver = await (await fetch('http://127.0.0.1:' + CP + '/json/version')).json(); } catch (e) {}
  }
  if (!ver) { console.log('cdp fail'); chrome.kill(); process.exit(1); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0; const pend = new Map();
  let bytes = 0, reqs = 0; const byType = {}; const byHost = {};
  const types = new Map(); // requestId -> {type, host}
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Fetch.requestPaused') {
      ws.send(JSON.stringify({ id: ++id, method: 'Fetch.failRequest', params: { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, sessionId: m.sessionId }));
      return;
    }
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request; let host = '';
      try { host = new URL(r.url).hostname; } catch (e) {}
      types.set(m.params.requestId, { type: m.params.type, host });
    }
    if (m.method === 'Network.loadingFinished') {
      const meta = types.get(m.params.requestId) || { type: 'Other', host: '?' };
      const n = m.params.encodedDataLength || 0;
      bytes += n; reqs++;
      byType[meta.type] = (byType[meta.type] || 0) + n;
      byHost[meta.host] = (byHost[meta.host] || 0) + n;
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {} })); });
  let sid = null;
  const t = await send('Target.getTargets');
  for (const tg of (t.result.targetInfos || [])) {
    if (tg.type === 'page') {
      const a = await send('Target.attachToTarget', { targetId: tg.targetId, flatten: true });
      sid = a.result.sessionId; break;
    }
  }
  const sendS = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {}, sessionId: sid })); });
  await sendS('Page.enable'); await sendS('Network.enable', {});
  if (LEAN) {
    await sendS('Fetch.enable', { patterns: [
      { urlPattern: '*', resourceType: 'Image', requestStage: 'Request' },
      { urlPattern: '*', resourceType: 'Media', requestStage: 'Request' },
      { urlPattern: '*', resourceType: 'Font', requestStage: 'Request' }] });
    await sendS('Network.setBlockedURLs', { urls: BLOCK });
  }
  await sendS('Page.navigate', { url: 'https://www.yelp.com/login/' });
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) await sleep(500);

  const probe = await (async () => {
    const mid = ++id;
    return await new Promise(resolve => {
      pend.set(mid, m => resolve(m && m.result && m.result.result ? m.result.result.value : null));
      ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: `JSON.stringify({form:!!document.getElementById('ajax-login'),hcaptcha:!!window.hcaptcha,title:document.title,size:document.documentElement.outerHTML.length})`, returnByValue: true }, sessionId: sid }));
      setTimeout(() => resolve(null), 10000);
    });
  })();

  const mb = n => Math.round(n / 1048576 * 100) / 100;
  const top = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + mb(v) + 'MB');
  const hosts = Object.entries(byHost).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + '=' + mb(v) + 'MB');
  console.log(JSON.stringify({ mode: MODE, mb: mb(bytes), bytes, requests: reqs, hydrated: probe ? JSON.parse(probe) : null, byType: top, topHosts: hosts }, null, 2));
  try { ws.close(); } catch (e) {}
  chrome.kill();
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})();
