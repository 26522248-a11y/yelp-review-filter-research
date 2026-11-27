// testpace/logout-test.js - does /logout?return_url=%2Flogin%2F bring the ajax form back?
// env: HOST www.yelp.com EMAIL PASS [BID=5]

const http = require('http'); const net = require('net'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const BID = parseInt(process.env.BID || '5', 10);
const HOST = process.env.HOST || 'www.yelp.com';
const EMAIL = process.env.EMAIL, PASS = process.env.PASS;
const PU_BASE = process.env.PU_BASE, PW = process.env.PW;
const SESS = process.env.SESSID || ('lo' + BID + Math.floor(Math.random() * 100000));
const PU = process.env.PU || (PU_BASE + '-sessid-' + SESS + '-sesstime-1800');
const AUTH = 'Basic ' + Buffer.from(PU + ':' + PW).toString('base64');
const PH = 'pr.oxylabs.io', PP = 7777, LP = 9390 + BID, CP = 9790 + BID;
const SITEKEY = '6660d4df-1884-4ac6-a933-e5f3bd460946';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rec = o => console.log(JSON.stringify(o));

const relay = http.createServer((q, s) => { s.on('error',()=>{}); q.on('error',()=>{}); try { const u=new URL(q.url); const pr=http.request({host:u.hostname,port:u.port||80,method:q.method,path:u.pathname+u.search,headers:Object.assign({},q.headers,{host:u.host})},r=>{s.writeHead(r.statusCode,r.headers);r.pipe(s);}); pr.on('error',()=>s.destroy()); q.pipe(pr); } catch(e){ s.destroy(); } });
relay.on('clientError',(e,s)=>{try{s.destroy()}catch(_){}});
relay.on('connect',(req,cs,head)=>{ const sock=net.connect(PP,PH,()=>sock.write('CONNECT '+req.url+' HTTP/1.1\r\nHost: '+req.url+'\r\nProxy-Authorization: '+AUTH+'\r\n\r\n')); let buf=Buffer.alloc(0); function onData(d){ buf=Buffer.concat([buf,d]); const i=buf.indexOf('\r\n\r\n'); if(i<0)return; sock.removeListener('data',onData); const rest=buf.slice(i+4); const m=buf.slice(0,i).toString().match(/^HTTP\/1\.[01]\s+(\d+)/); if(!m||parseInt(m[1],10)!==200){try{cs.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')}catch(e){} sock.destroy(); return;} cs.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if(rest.length)cs.write(rest); sock.pipe(cs); cs.pipe(sock); if(head&&head.length)sock.write(head); sock.on('error',()=>cs.destroy()); cs.on('error',()=>sock.destroy()); } sock.on('data',onData); sock.on('error',()=>{try{cs.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')}catch(e){}}); });

(async () => {
  await new Promise(r => relay.listen(LP, '127.0.0.1', r));
  const udd = path.join(os.tmpdir(), 'lo-' + Date.now());
  const chrome = spawn(process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--no-first-run','--no-default-browser-check','--window-size=900,700','--lang=en-US','--user-data-dir='+udd,
    '--disable-background-timer-throttling','--disable-renderer-backgrounding','--blink-settings=imagesEnabled=false',
    '--proxy-server=http://127.0.0.1:'+LP,'--remote-debugging-port='+CP,'about:blank'], { stdio:'ignore' });
  let ver=null; for(let k=0;k<60&&!ver;k++){await sleep(250);try{ver=await(await fetch('http://127.0.0.1:'+CP+'/json/version')).json();}catch(e){}}
  if(!ver){rec({event:'abort',why:'cdp'});chrome.kill();relay.close();return;}
  const ws=new WebSocket(ver.webSocketDebuggerUrl); ws.addEventListener('error',()=>{});
  let id=0; const pend=new Map();
  ws.addEventListener('message',ev=>{let m;try{m=JSON.parse(ev.data)}catch(e){return} if(m.method==='Fetch.requestPaused'){ws.send(JSON.stringify({id:++id,method:'Fetch.failRequest',params:{requestId:m.params.requestId,errorReason:'BlockedByClient'},sessionId:m.sessionId}));return;} if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
  await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej)});
  const send=(mth,p)=>new Promise(res=>{const mid=++id;pend.set(mid,res);ws.send(JSON.stringify({id:mid,method:mth,params:p||{}}))});
  let sid=null; for(let k=0;k<60&&!sid;k++){await sleep(250);const t=await send('Target.getTargets');if(t&&t.result){const pg=t.result.targetInfos.find(x=>x.type==='page');if(pg){const a=await send('Target.attachToTarget',{targetId:pg.targetId,flatten:true});if(a&&a.result)sid=a.result.sessionId;}}}
  const sendS=(mth,p)=>new Promise(res=>{const mid=++id;pend.set(mid,res);ws.send(JSON.stringify({id:mid,method:mth,params:p||{},sessionId:sid}))});
  const ev=e=>new Promise(res=>{const mid=Math.floor(Math.random()*1e9);const h=x=>{try{const m=JSON.parse(x.data);if(m.id===mid){ws.removeEventListener('message',h);res(m.result&&m.result.result?m.result.result.value:null)}}catch(err){}};ws.addEventListener('message',h);ws.send(JSON.stringify({id:mid,method:'Runtime.evaluate',params:{expression:e,returnByValue:true,awaitPromise:true},sessionId:sid}));setTimeout(()=>res(null),30000)});
  await sendS('Page.enable'); await sendS('Network.enable',{}); await sendS('Fetch.enable',{patterns:[{urlPattern:'*',resourceType:'Image',requestStage:'Request'},{urlPattern:'*',resourceType:'Font',requestStage:'Request'}]});
  await sendS('Page.navigate',{url:'https://'+HOST+'/login/'});
  for(let k=0;k<30;k++){await sleep(1000);const s=await ev(`JSON.stringify({f:!!document.getElementById('ajax-login'),h:!!window.hcaptcha,l:document.documentElement.outerHTML.length})`);try{const o=JSON.parse(s);if(o&&o.f&&o.h){rec({event:'hydrated',l:o.l});break}}catch(e){}}
  rec({event:'arm',v:await ev(`(function(){ if(!window.hcaptcha) return 'no-api'; var d=document.createElement('div');d.style.display='none';document.body.appendChild(d);window.__wid=window.hcaptcha.render(d,{sitekey:'${SITEKEY}',size:'invisible',callback:function(t){window.__fcTok=t}});return 'own:'+window.__wid; })()`)});
  const tok=await ev(`new Promise(function(res){var w=window.__wid;window.__fcTok='';try{window.hcaptcha.execute(w)}catch(e){res('');return}var n=0;var iv=setInterval(function(){n++;var t=window.__fcTok||window.hcaptcha.getResponse(w)||'';if(t){clearInterval(iv);res(t)}else if(n>60){clearInterval(iv);res('')}},200)})`);
  rec({event:'token',len:tok?tok.length:0});
  const csrf=await ev(`(function(){var i=document.querySelector('#ajax-login input[name=csrftok]');return i?i.value:''})()`);
  const raw=await ev(`(async function(){var b=new URLSearchParams();b.set('csrftok',${JSON.stringify(csrf)});b.set('email',${JSON.stringify(EMAIL)});b.set('password',${JSON.stringify(PASS)});b.set('hcaptcha_response',${JSON.stringify(tok)});try{var r=await fetch('/login/newajax',{method:'POST',credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:b.toString()});return JSON.stringify({status:r.status,body:(await r.text()).slice(0,120)})}catch(e){return JSON.stringify({status:-1,body:String(e)})}})()`);
  rec({event:'login',v:raw});
  await sleep(2000);
  rec({event:'profile',v:await ev(`(async()=>{const r=await fetch('/profile',{credentials:'include'});return r.status})()`)});
  await sendS('Page.navigate',{url:'https://'+HOST+'/logout?return_url=%2Flogin%2F'});
  await sleep(5000);
  rec({event:'after-logout',v:await ev(`JSON.stringify({u:location.href,t:document.title,f:!!document.getElementById('ajax-login'),h:!!window.hcaptcha,l:document.documentElement.outerHTML.length})`)});
  await sleep(3000);
  rec({event:'after-logout2',v:await ev(`JSON.stringify({u:location.href,t:document.title,f:!!document.getElementById('ajax-login'),h:!!window.hcaptcha,l:document.documentElement.outerHTML.length})`)});
  ws.close(); chrome.kill(); relay.close();
  try{fs.rmSync(udd,{recursive:true,force:true})}catch(e){}
  setTimeout(()=>process.exit(0),300);
})();
