// Run only against a disposable test database: TEST_DATABASE_URL is mandatory.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {Pool}=require('pg');
const bcrypt=require('bcrypt');
assert(process.env.TEST_DATABASE_URL,'Set TEST_DATABASE_URL to a test database');
const schema='review_'+process.pid;
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
const handlers={};
const router={post:(p,f)=>handlers[p]=f,get:()=>{}};
const sessions=async(id,reason,db)=>db.query('update session set ended=true where user_id=$1',[id]);
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/routes/auth.js'),'utf8'),{
  require:n=>n==='express'?{Router:()=>router}:n==='bcrypt'?bcrypt:n==='crypto'?require('crypto'):n==='../db'?{pool}:n.endsWith('/sessions')?{endUserSessions:sessions}:n.endsWith('/verification')?{issueVerification:async()=>{}}:{},
  module:{exports:{}},process,console,Date,Map
});
async function call(password){let status=200;await handlers['/reset-password']({body:{token:'test-token',password}}, {status(n){status=n;return this;},json(){}},e=>{throw e;});return status;}
(async()=>{
 try {
  await admin.query('create schema '+schema);
  await pool.query('create table users(id int primary key, active boolean, password_hash text); create table password_reset_tokens(id serial primary key,user_id int,token_hash text,used_at timestamptz,expires_at timestamptz); create table session(user_id int,ended boolean)');
  await pool.query("insert into users values(1,true,'old'); insert into session values(1,false)");
  const tokenHash=require('crypto').createHash('sha256').update('test-token').digest('hex');
  await pool.query("insert into password_reset_tokens(user_id,token_hash,expires_at) values(1,$1,now()+interval '1 hour')",[tokenHash]);
  const statuses=await Promise.all([call('new-password-A'),call('new-password-B')]);
  assert.deepEqual([...statuses].sort(),[200,400]);
  const {rows}=await pool.query('select password_hash from users where id=1');
  assert(await bcrypt.compare(statuses[0]===200?'new-password-A':'new-password-B',rows[0].password_hash));
  assert.equal((await pool.query('select ended from session')).rows[0].ended,true);
  assert.equal(await call('replay-password'),400);
  console.log('PASS: concurrent reset has one winner; sessions ended; replay rejected');
 } finally {await pool.end();await admin.query('drop schema if exists '+schema+' cascade');await admin.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
