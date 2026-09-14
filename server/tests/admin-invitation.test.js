const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const handlers={};let invited=null;
const router={use(){},get(){},patch(){},delete(){},post:(p,f)=>handlers[p]=f};
const user={id:'test-user',email:'invite@example.test',role:'user'};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/routes/admin.js'),'utf8'),{
 require:n=>n==='express'?{Router:()=>router}:n==='bcrypt'?{hash:async()=> 'hash'}:n==='../db'?{pool:{query:async sql=>({rows:sql.includes('insert into users')?[user]:[]})}}:n.endsWith('/verification')?{issueVerification:async u=>{invited=u;}}:n.endsWith('/sessions')?{}:()=>{},
 module:{exports:{}},console
});
(async()=>{let status;await handlers['/users']({body:{email:user.email,password:'test-password'},user:{id:'admin'}},{status(n){status=n;return this;},json(){}},e=>{throw e;});assert.equal(status,201);assert.equal(invited.email,user.email);console.log('PASS: admin creation invokes verification mail (mock, no email sent)');})().catch(e=>{console.error(e);process.exitCode=1;});
