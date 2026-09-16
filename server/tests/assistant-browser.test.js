// node server/tests/assistant-browser.test.js  (нужен PLAYWRIGHT_MODULE)
// AI-помощник в Edge: вход, вопрос, Markdown-ответ, ширина 1280/420, очистка при выходе.
// Модель подменена — сеть и баланс DeepSeek не нужны.
const assert=require('node:assert/strict');const fs=require('fs');const path=require('path');
const express=require('express');const session=require('express-session');
const root=path.join(__dirname,'../..');const html=fs.readFileSync(path.join(root,'tnved_checker.html'),'utf8');
process.env.AI_API_KEY='test';
const user={id:'valid',email:'test@example.test',role:'user',active:true,email_verified_at:new Date(),last_seen_at:new Date()};
require.cache[require.resolve('../src/db')]={exports:{pool:{query:async()=>({rows:[user]})}}};
let n=0;global.fetch=async(url,opts)=>{n++;const b=JSON.parse(opts.body);
  const content=b.tool_choice?[{type:'tool_use',id:'t'+n,name:'search_base',input:{query:'8517130000'}}]
   :[{type:'text',text:'### Результат\n**Код:** 8517 13 000 0\n- Пошлина: 0% — [ЕТТ](https://eec.eaeunion.org/)\n- '+'длинноесловобезпробелов'.repeat(8)}];
  return {ok:true,json:async()=>({content})}};
const app=express();app.use(express.json());
app.use(session({secret:'x',resave:false,saveUninitialized:false}));
app.use(require('../src/middleware/auth'));
app.get('/api/auth/config',(q,r)=>r.json({}));
app.get('/api/auth/me',(q,r)=>q.user?r.json({...q.user,emailVerified:true}):r.status(401).json({}));
app.post('/api/auth/login',(q,r)=>{q.session.userId='valid';r.json({...user,emailVerified:true})});
app.post('/api/auth/logout',(q,r)=>q.session.destroy(()=>r.json({})));
app.get('/api/nbkr-rates',(q,r)=>r.status(503).json({}));
app.get('/api/class-decisions',(q,r)=>r.json({items:[]}));
app.use('/api/checker.js',require('../src/routes/checker'));
app.use('/api/assistant',require('../src/routes/assistant'));
app.get('/',(q,r)=>r.type('html').send(html));
(async()=>{const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const browser=await require(process.env.PLAYWRIGHT_MODULE).chromium.launch({channel:'msedge',headless:true});
 try{
  for(const w of [1280,420]){
  const page=await browser.newPage({viewport:{width:w,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.fill('#authEmail','test@example.test');await page.fill('#authPassword','valid');await page.click('#authSubmit');
  await page.locator('#appWrap').waitFor({state:'visible'});
  await page.evaluate(()=>setPage('ai'));
  await page.locator('#aiInput').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>document.getElementById('navAiBtn').classList.contains('active')),true);
  await page.fill('#aiInput','Пошлина на смартфон?');await page.keyboard.press('Enter');
  await page.locator('.ai-msg.a h4').waitFor();
  const r=await page.evaluate(()=>({h:document.querySelector('.ai-msg.a:last-child').innerHTML,msgs:document.querySelectorAll('.ai-msg').length,
    over:document.documentElement.scrollWidth>document.documentElement.clientWidth,hist:aiHistory.length}));
  assert.match(r.h,/<b>Код:<\/b>/);assert.match(r.h,/Поиск в базе: 8517130000/);
  assert.equal(r.msgs,2);assert.equal(r.hist,2);assert.equal(r.over,false,'horizontal overflow at '+w);
  if(process.env.SHOT)await page.screenshot({path:process.env.SHOT+'/ai_'+w+'.png'});
  await page.evaluate(()=>doLogout());
  await page.locator('#authScreen').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>document.getElementById('pageAi').innerHTML+aiHistory.length),'0');
  assert.deepEqual(errors,[]);
  console.log('PASS browser',w);await page.close();}
 }finally{await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exit(1)});
