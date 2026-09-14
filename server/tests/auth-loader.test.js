const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../../tnved_checker.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){
  const els=new Map(),requests=[],downloads=[];let releaseMe,ctx;
  const element=id=>{
    if(!els.has(id))els.set(id,{style:{},value:'',textContent:'',innerHTML:'',classList:{add(){},remove(){},toggle(){},contains(){return false;}},
      addEventListener(){},setAttribute(){},removeAttribute(){},querySelector(){return element(id+'child');},remove(){},closest(){return null;}});
    return els.get(id);
  };
  class XHR{
    open(){} send(){downloads.push(this);} abort(){this.onabort();}
  }
  ctx=vm.createContext({console,URLSearchParams,Blob,XMLHttpRequest:XHR,
    URL:{createObjectURL(){return 'blob:test';},revokeObjectURL(){}},
    location:{search:'',pathname:'/'},history:{replaceState(){}},window:{},localStorage:{getItem(){return null;},setItem(){}},
    document:{getElementById:element,querySelectorAll(){return [];},documentElement:{getAttribute(){return null;}},
      createElement(){return element('script');},head:{appendChild(script){vm.runInContext('appCodeLoaded=true',ctx);script.onload();}}},
    esc:s=>s,adminUsers:[],searchMode:'code',currentPage:'search',initApp(){ctx.started=(ctx.started||0)+1;},
    fetch:async(url,opts)=>{
      requests.push(url);
      if(url==='/api/auth/config')return {ok:true,json:async()=>({})};
      if(url==='/api/auth/me')return new Promise(r=>releaseMe=r);
      if(url==='/api/auth/logout')return {ok:true};
      const good=JSON.parse(opts.body).password==='correct';
      return {ok:good,status:good?200:401,json:async()=>good?{email:'test@example.test',role:'admin'}:{error:'invalid credentials'}};
    }});
  vm.runInContext(source,ctx);
  return {ctx,element,requests,downloads,me:(ok)=>releaseMe({ok,json:async()=>ok?{email:'test@example.test',role:'admin'}:{}})};
}
(async()=>{
  const t=setup();
  t.element('authEmail').value='test@example.test';t.element('authPassword').value='correct';
  await vm.runInContext('doLogin()',t.ctx);
  assert(!t.requests.includes('/api/auth/login'),'login must wait for the session check');
  t.me(false);await tick();
  assert.equal(t.element('authViewLogin').style.display,'');
  t.element('authPassword').value='wrong';await vm.runInContext('doLogin()',t.ctx);
  assert.equal(t.downloads.length,0,'wrong password must not start a download');
  t.element('authPassword').value='correct';
  const login=vm.runInContext('doLogin()',t.ctx);await tick();
  assert.equal(t.element('authViewLogin').style.display,'none');
  assert.equal(t.element('authViewLoading').style.display,'');
  const logins=t.requests.filter(r=>r==='/api/auth/login').length;
  await vm.runInContext('doLogin()',t.ctx);
  assert.equal(t.requests.filter(r=>r==='/api/auth/login').length,logins,'no concurrent logins');
  t.downloads[0].onprogress({loaded:1048576,lengthComputable:false});
  assert.match(t.element('authLoadStatus').textContent,/1\.0/);
  t.downloads[0].onerror();await login;
  assert.equal(t.element('authLoadRetry').style.display,'');
  assert.equal(t.element('authViewLogin').style.display,'none');
  const retry=vm.runInContext('retryAppLoad()',t.ctx);await tick();
  assert.equal(t.requests.filter(r=>r==='/api/auth/login').length,logins,'retry must preserve the session');
  t.downloads[1].status=200;t.downloads[1].response=new Blob(['']);t.downloads[1].onload();await retry;
  assert.equal(t.ctx.started,1);assert.equal(t.element('appWrap').style.display,'block');
  const stale=setup();await vm.runInContext('doLogout()',stale.ctx);stale.me(true);await tick();
  assert.equal(stale.downloads.length,0,'old session check must not undo logout');
  const expired=setup();expired.me(true);await tick();
  expired.downloads[0].status=401;expired.downloads[0].onload();await tick();
  assert.equal(expired.element('authViewLogin').style.display,'');
  assert.equal(expired.element('authViewLoading').style.display,'none');
  console.log('PASS: session/login serialization, wrong password, progress, retry without login, expired session and logout race');
})().catch(e=>{console.error(e);process.exitCode=1;});
