// node server/tests/checker-access.test.js
// Optional real-browser check: set PLAYWRIGHT_MODULE to an installed playwright-core path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const session = require('express-session');
const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'tnved_checker.html'), 'utf8');
const code = fs.readFileSync(path.join(root, 'server/private/checker.js'), 'utf8');
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
new vm.Script(code);
assert(!html.includes('const BAN_DB='));
assert(!html.includes('const ETT_DB='));
const users = {
  valid: {id:'valid', email:'test@example.test', role:'user', active:true, email_verified_at:new Date(), last_seen_at:new Date()},
  unverified: {id:'unverified', active:true},
  disabled: {id:'disabled', active:false},
  expired: {id:'expired', active:true, subscription_expires_at:'2000-01-01'},
};
// Exercise the real auth middleware without touching any database or sending email.
require.cache[require.resolve('../src/db')] = {exports:{pool:{query:async(sql, args)=>({rows:users[args[0]]?[users[args[0]]]:[]})}}};
const app = express();
app.use(express.json());
app.use(session({secret:'local-check-only', resave:false, saveUninitialized:false}));
app.use(require('../src/middleware/auth'));
app.get('/api/auth/config', (req,res)=>res.json({}));
app.get('/api/auth/me', (req,res)=>req.user?res.json({...req.user,emailVerified:true}):res.status(401).json({}));
app.post('/api/auth/login', (req,res)=>{req.session.userId=req.body.password;res.json({...users[req.body.password], emailVerified:true});});
app.post('/api/auth/logout', (req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/nbkr-rates', (req,res)=>res.status(503).json({}));
const guestPosts=[];
app.post('/api/auth/register', (req,res)=>{guestPosts.push('register '+req.body.email);res.status(201).json({email:req.body.email,needsVerification:true});});
app.post('/api/auth/resend-verification-public', (req,res)=>{guestPosts.push('resend '+req.body.email);res.json({ok:true});});
app.post('/api/auth/forgot-password', (req,res)=>{guestPosts.push('forgot '+req.body.email);res.json({ok:true});});
app.post('/api/auth/verify-email', (req,res)=>{guestPosts.push('verify '+req.body.token);res.json({ok:true,email:'new@example.test'});});
app.post('/api/auth/reset-password', (req,res)=>{guestPosts.push('reset '+req.body.token);res.json({ok:true});});
app.use('/api/checker.js', require('../src/routes/checker'));
// The page is served with the production Content-Security-Policy taken from nginx.conf, so a
// script or connection the policy would block fails this test instead of the live site.
const csp=fs.readFileSync(path.join(__dirname,'../nginx.conf'),'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1];
app.get('/', (req,res)=>res.set('Content-Security-Policy',csp).type('html').send(html));

(async()=>{
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  // Raw HTTP leaves conditional headers untouched (no browser cache simulation).
  const conditional=(cookie,etag)=>new Promise((resolve,reject)=>{
    require('node:http').get(origin+'/api/checker.js',{headers:{cookie,'If-None-Match':etag}},res=>{
      let bytes=0;res.on('data',chunk=>bytes+=chunk.length);
      res.on('end',()=>resolve({status:res.statusCode,bytes}));
    }).on('error',reject);
  });
  let browser;
  try{
    assert.equal((await fetch(origin+'/api/checker.js')).status,401);
    for(const [user,status] of [['valid',200],['unverified',403],['disabled',401],['expired',401],['deleted',401]]){
      const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:user})});
      const cookie=login.headers.get('set-cookie').split(';')[0];
      const res=await fetch(origin+'/api/checker.js',{headers:{cookie}});
      assert.equal(res.status,status,user);
      assert.match(res.headers.get('cache-control'),status===200?/private, no-cache, must-revalidate/:/no-store/);
      if(status===200){
        assert.equal(await res.text(),code);
        const etag=res.headers.get('etag');
        assert(etag);
        assert.deepEqual(await conditional(cookie,etag),{status:304,bytes:0});
        assert.equal((await conditional(cookie,'"old-version"')).status,200);
        await fetch(origin+'/api/auth/logout',{method:'POST',headers:{cookie}});
        assert.equal((await fetch(origin+'/api/checker.js',{headers:{cookie}})).status,401);
        assert.equal((await conditional(cookie,etag)).status,401);
      }else{
        assert.equal((await conditional(cookie,'*')).status,status);
      }
    }
    assert.equal((await fetch(origin+'/server/private/checker.js')).status,404);
    if(process.env.PLAYWRIGHT_MODULE){
      browser=await require(process.env.PLAYWRIGHT_MODULE).chromium.launch({channel:'msedge',headless:true});
      // A visitor without an account never receives checker.js, so registration,
      // resend and password recovery may use only the page's own code. Until
      // 17.09.2026 the register button called EMAIL_RE, declared in checker.js:
      // it threw for every new visitor and worked only in a window where someone
      // had already logged in and out.
      const cspViolations=[];
      const watchCsp=async p=>{
        await p.exposeFunction('__cspViolation',v=>cspViolations.push(v)).catch(()=>{});
        await p.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>window.__cspViolation(e.violatedDirective+' '+e.blockedURI)));
      };
      const guest=await browser.newPage();
      await watchCsp(guest);
      const guestErrors=[];
      guest.on('pageerror',e=>guestErrors.push(e.message));
      await guest.goto(origin);
      await guest.locator('#authRegisterLink').click();
      await guest.locator('#authRegisterEmail').fill('new@example.test');
      await guest.locator('#authRegisterPassword').fill('long-enough-1');
      await guest.locator('#authRegisterSubmit').click();
      await guest.locator('#authViewVerify').waitFor({state:'visible',timeout:5000}).catch(()=>{});
      assert.deepEqual(guestErrors,[],'register view');
      await guest.locator('#authVerifyResend').click();
      await guest.locator('#authVerifyInfo').waitFor({state:'visible',timeout:5000});
      await guest.locator('#authVerifyBackLink').click();
      await guest.locator('#authForgotLink').click();
      await guest.locator('#authForgotEmail').fill('new@example.test');
      await guest.locator('#authForgotSubmit').click();
      await guest.locator('#authForgotInfo').waitFor({state:'visible',timeout:5000});
      // the two links from the mails are guest paths too
      await guest.goto(origin+'/?verify=verify-token');
      await guest.locator('#authInfo').filter({hasText:'подтверждён'}).waitFor({timeout:5000});
      await guest.goto(origin+'/?reset=reset-token');
      await guest.locator('#authResetPassword').fill('new-password-1');
      await guest.locator('#authResetPassword2').fill('new-password-1');
      await guest.locator('#authResetSubmit').click();
      await guest.locator('#authInfo').filter({hasText:'Пароль изменён'}).waitFor({timeout:5000});
      assert.deepEqual(guestPosts,['register new@example.test','resend new@example.test','forgot new@example.test','verify verify-token','reset reset-token']);
      assert.equal(await guest.evaluate(()=>typeof findETT),'undefined');
      assert.deepEqual(guestErrors,[]);
      await guest.close();
      const page=await browser.newPage({viewport:{width:1280,height:900}});
      await watchCsp(page);
      const errors=[];let requests=0;
      page.on('pageerror',e=>errors.push(e.message));
      page.on('request',r=>{if(r.url().endsWith('/api/checker.js'))requests++;});
      await page.goto(origin);
      await page.locator('#authEmail').waitFor({state:'visible'});
      assert.equal(requests,0);
      assert.equal(await page.evaluate(()=>typeof findETT),'undefined');
      await page.locator('#authEmail').fill('test@example.test');
      await page.locator('#authPassword').fill('valid');
      // Failed download must leave login usable and permit a retry.
      await page.route('**/api/checker.js',route=>route.abort());
      await page.locator('#authSubmit').click();
      await page.locator('#authLoadError').filter({hasText:'Соединение прервалось'}).waitFor();
      await page.unroute('**/api/checker.js');
      await page.locator('#authLoadRetry').click();
      await page.locator('#appWrap').waitFor({state:'visible'});
      await page.locator('#inp').fill('8517130000');
      await page.locator('#result .card').first().waitFor();
      assert.match(await page.locator('#result').innerText(),/8517|Смартфон/i);
      // the in-app privacy link must lead to the published policy, not to a «в разработке» stub
      await page.evaluate(()=>openFooterDocModal('Политика конфиденциальности'));
      await page.locator('#activeModal a[href="/privacy.html"]').waitFor({timeout:5000});
      await page.evaluate(()=>closeModal());
      await page.reload();
      await page.locator('#appWrap').waitFor({state:'visible'});
      assert.equal(requests,3); // failed request, retry, fresh page with a session
      await page.locator('#logoutBtn').click();
      await page.locator('#authScreen').waitFor({state:'visible'});
      assert.equal((await page.request.get(origin+'/api/checker.js')).status(),401);
      await page.setViewportSize({width:420,height:844});
      await page.locator('#authEmail').fill('test@example.test');
      await page.locator('#authPassword').fill('valid');
      await page.locator('#authSubmit').click();
      await page.locator('#appWrap').waitFor({state:'visible'});
      await page.locator('#inp').fill('8703231910');
      await page.locator('#result .card').first().waitFor();
      assert.deepEqual(errors,[]);
      assert.deepEqual(cspViolations,[],'Content-Security-Policy');
      const delayed=await browser.newPage();
      let pendingRoute, started;
      const downloading=new Promise(resolve=>started=resolve);
      await delayed.route('**/api/checker.js',route=>{pendingRoute=route;started();});
      await delayed.goto(origin);
      await delayed.locator('#authEmail').fill('test@example.test');
      await delayed.locator('#authPassword').fill('valid');
      await delayed.locator('#authSubmit').click();
      await downloading;
      await delayed.evaluate(()=>doLogout());
      await pendingRoute.abort().catch(()=>{});
      assert.equal(await delayed.locator('#appWrap').isVisible(),false);
      await delayed.close();
      console.log('PASS: browser login, failed load/retry, search, session reload, logout and mobile re-login');
    }
    console.log('PASS: access checks precede 304; unchanged file has no body; changed ETag gets 200; errors no-store; syntax');
  }finally{
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
