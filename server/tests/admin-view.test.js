const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../tnved_checker.html'), 'utf8')
  + '\n' + fs.readFileSync(path.join(__dirname, '../private/checker.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp('(?:async )?function '+name+'\\('));
  const end = source.indexOf('\n}', start) + 2;
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}
async function checkStale(stage) {
  const elements = new Map();
  let release;
  const pending = new Promise(r => release = r);
  const ctx = vm.createContext({
    currentUser: {role:'admin'}, appViewVersion:0, adminUsers:[],
    document:{getElementById(id){if(!elements.has(id)) elements.set(id,{innerHTML:'',style:{},value:''});return elements.get(id);}},
    apiFetch:()=>stage === 'fetch' ? pending : Promise.resolve({ok:true,json:()=>pending}),
    adminUserRowHtml:()=>'<tr>private user</tr>'
  });
  vm.runInContext(extract('resetAppView')+'\n'+extract('renderAdminPanel'), ctx);
  const job=vm.runInContext('renderAdminPanel()',ctx);
  await Promise.resolve(); await Promise.resolve();
  vm.runInContext("resetAppView(); currentUser={role:'user'};",ctx);
  release(stage === 'fetch' ? {ok:true,json:async()=>[{email:'private@example.test'}]} : [{email:'private@example.test'}]);
  await job;
  assert.equal(elements.get('adminResult').innerHTML,'');
  assert.equal(ctx.adminUsers.length,0);
}
(async()=>{await checkStale('fetch');await checkStale('json');console.log('PASS: stale admin responses discarded before and after JSON parsing');})().catch(e=>{console.error(e);process.exitCode=1;});
