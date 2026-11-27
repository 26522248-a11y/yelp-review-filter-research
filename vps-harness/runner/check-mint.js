// Sanity check: with the bandwidth filters on, does the login page still mint an
// hCaptcha token? Direct connection, so no proxy credits are used. Token length is the
// only thing printed - no credentials are involved.
//
//   node runner\check-mint.js
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const SITEKEY = process.env.SITEKEY || '6660d4df-1884-4ac6-a933-e5f3bd460946';
const CP = 9800 + Math.floor(Math.random() * 100);
const udd = path.join(os.tmpdir(), 'mint-' + Date.now());
const CDD = path.join(os.tmpdir(), 'meas-cache-lean');
try { fs.mkdirSync(CDD, { recursive: true }); } catch (e) {}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const chrome = spawn(process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--no-first-run', '--no-default-browser-check', '--window-size=900,700',
    '--user-data-dir=' + udd, '--remote-debugging-port=' + CP,
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--blink-settings=imagesEnabled=false',
    '--disable-remote-fonts', '--disk-cache-dir=' + CDD, '--disk-cache-size=67108864',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,Prerender2,SpeculationRulesPrefetch',
    'about:blank'
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) { await sleep(300); try { ver = await (await fetch('http://127.0.0.1:' + CP + '/json/version')).json(); } catch (e) {} }
  if (!ver) { console.log('cdp fail'); chrome.kill(); process.exit(1); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Fetch.requestPaused') {
      ws.send(JSON.stringify({ id: ++id, method: 'Fetch.failRequest', params: { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, sessionId: m.sessionId }));
      return;
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {} })); });
  let sid = null;
  const t = await send('Target.getTargets');
  for (const tg of (t.result.targetInfos || [])) {
    if (tg.type === 'page') { const a = await send('Target.attachToTarget', { targetId: tg.targetId, flatten: true }); sid = a.result.sessionId; break; }
  }
  const sendS = (mth, p) => new Promise(resolve => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method: mth, params: p || {}, sessionId: sid })); });
  const ev = e => new Promise(resolve => {
    const mid = ++id;
    pend.set(mid, m => resolve(m && m.result && m.result.result ? m.result.result.value : null));
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true }, sessionId: sid }));
    setTimeout(() => resolve(null), 30000);
  });

  await sendS('Page.enable'); await sendS('Network.enable', {});
  await sendS('Fetch.enable', { patterns: [
    { urlPattern: '*', resourceType: 'Image', requestStage: 'Request' },
    { urlPattern: '*', resourceType: 'Media', requestStage: 'Request' },
    { urlPattern: '*', resourceType: 'Font', requestStage: 'Request' }] });
  await sendS('Network.setBlockedURLs', { urls: require('./bw-blocklist') });
  await sendS('Page.navigate', { url: 'https://www.yelp.com/login/' });

  let ready = false;
  for (let k = 0; k < 30 && !ready; k++) {
    await sleep(1000);
    const s = await ev(`JSON.stringify({f:!!document.getElementById('ajax-login'),h:!!window.hcaptcha})`);
    try { const o = JSON.parse(s); if (o && o.f && o.h) ready = true; } catch (e) {}
  }
  console.log('hydrated=' + ready);
  if (!ready) { chrome.kill(); process.exit(0); }

  const armed = await ev(`(function(){
    if(!window.hcaptcha) return 'no-api';
    var c=document.querySelector('[data-hcaptcha-widget-id]');
    if(c && c.getAttribute('data-hcaptcha-widget-id')){ window.__wid=c.getAttribute('data-hcaptcha-widget-id'); return 'site:'+window.__wid; }
    var d=document.createElement('div'); d.id='__fcap'; d.style.display='none'; document.body.appendChild(d);
    window.__wid=window.hcaptcha.render(d,{sitekey:'${SITEKEY}',size:'invisible',callback:function(t){window.__fcTok=t;}});
    return 'own:'+window.__wid;
  })()`);
  console.log('widget=' + armed);

  const t0 = Date.now();
  const tok = await ev(`new Promise(function(res){
    var w=window.__wid;
    if(!w){ res(''); return; }
    var done=false; function fin(t){ if(!done){ done=true; res(t||''); } }
    window.__fcTok='';
    try { window.hcaptcha.execute(w); } catch(e){ fin(''); return; }
    var n=0;
    var iv=setInterval(function(){
      n++;
      var t=window.__fcTok||'';
      if(!t){ try { t=window.hcaptcha.getResponse(w)||''; } catch(e){} }
      if(t){ clearInterval(iv); fin(t); }
      else if(n>75){ clearInterval(iv); fin(''); }
    },200);
  })`);
  console.log(JSON.stringify({ tokLen: String(tok || '').length, ms: Date.now() - t0 }));
  try { ws.close(); } catch (e) {}
  chrome.kill();
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})();
