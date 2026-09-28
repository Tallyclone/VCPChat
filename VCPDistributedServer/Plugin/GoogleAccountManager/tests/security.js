'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const S=require('../storage'),P=require('../platform'),X=require('../proxy'),{createManager}=require('../index');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gam-security-'));let child;
 try{
  const notes=path.join(root,'.google_account_notes.json');
  await fs.writeFile(notes,'\uFEFF'+JSON.stringify({version:1,notes:{1:'utf16'},types:{}}),'utf16le');assert.equal((await S.notes(root)).notes[1],'utf16');
  await fs.writeFile(notes,'broken');await assert.rejects(()=>S.notes(root));assert.equal(await fs.readFile(notes,'utf8'),'broken');
  await fs.writeFile(notes,JSON.stringify({version:1,notes:{1:'first'},types:{}}));
  await fs.mkdir(path.join(root,'outside'));await fs.symlink(path.join(root,'outside'),path.join(root,'profile_2'),'junction');
  await assert.rejects(()=>S.safe(path.join(root,'profile_2','Default','Preferences')),/LINK_PATH_REFUSED/);
  await fs.unlink(path.join(root,'profile_2'));
  // Lock contention with a second real Node process, not just a same-process handle.
  const script="const S=require(process.argv[1]);S.locked(process.argv[2],async()=>{process.stdout.write('ready\\n');await new Promise(r=>process.stdin.once('data',r));}).catch(()=>process.exitCode=1);";
  child=spawn(process.execPath,['-e',script,path.join(__dirname,'../storage.js'),root],{stdio:['pipe','pipe','pipe']});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
  await assert.rejects(()=>S.locked(root,async()=>{}),/BUSY_LOCK/);
  child.stdin.end('release');await new Promise(r=>child.once('close',r));child=null;
  await S.locked(root,async()=>{});
  const outlets=Array.from({length:50},(_,i)=>({enable:true,mode:'direct',remark:'octopus-top'+i,target:'g'+i,port:7000+i}));
  const duplicate=structuredClone(outlets);duplicate[1].port=duplicate[0].port;assert.throws(()=>X.outlets({outlets:duplicate}),/DUPLICATE_OUTLET/);
  const bad=structuredClone(outlets);bad[0].port=65536;assert.throws(()=>X.outlets({outlets:bad}),/INVALID_OUTLET/);
  const narrow=async(m,u)=>{if(u==='/outlets')return{outlets};const i=Number(u.slice('/groups/g'.length));return{proxies:i===0?['A','B']:i===1?['A']:['unique'+i]};};
  const unique=await X.plan(narrow,{bindings:{1:{target:'g0',node:'A'}}},false);assert.equal(X.duplicates(unique.bindings).length,0);assert.equal(unique.bindings[1].node,'B');assert.equal(unique.bindings[2].node,'A');
  const repeated=await X.plan(async(m,u)=>u==='/outlets'?{outlets}:{proxies:['octopus_top-自动','only-node']},{bindings:{}},false);
  assert.equal(X.duplicates(repeated.bindings)[0].length,50);assert.equal(repeated.bindings[1].node,'only-node');
  assert.throws(()=>X.nodes({proxies:['DIRECT','REJECT','PASS','octopus_top-自动']}),/EMPTY_GROUP/);
  P.assertVisible([]);assert.throws(()=>P.assertVisible([{name:'chrome.exe',commandLine:null}]),/PROCESS_VISIBILITY_INCOMPLETE/);
  await assert.rejects(()=>P.terminate([{pid:28452,name:'chrome.exe',created:'x'}]),/UNSAFE_PROCESS_TARGET/);
  const chrome=path.join(root,'chrome.exe');await fs.writeFile(chrome,'fixture');
  let rows=[],launches=0,puts=0;
  const config={root,chrome,proxyHost:'127.0.0.1',proxyPort:1,allowed:['launch','proxy_login','set_note'],approval:'local-policy',httpTimeoutMs:50,operationTimeoutMs:1000};
  const platform={snapshot:async()=>rows,terminate:async()=>{},launch:async()=>{launches++;return{pid:9000};}};
  const denied=createManager({config,platform,approve:async()=>S.fail('USER_DENIED')});assert.equal((await denied({command:'set_note',profile:1,note:'no'})).details.code,'USER_DENIED');assert.equal((await S.notes(root)).notes[1],'first');
  const app=createManager({config,platform,approve:async()=>{},audit:async()=>{},reachable:async()=>S.fail('PROXY_PORT_UNAVAILABLE'),request:async(m,u)=>{
   if(m==='PUT'){puts++;return{ok:true};}return u==='/outlets'?{outlets}:{proxies:['only-node'],now:'only-node'};
  }});
  await S.atomic(path.join(root,'.google_proxy_bindings.json'),repeated);
  assert.equal((await app({command:'proxy_login',profile:1})).details.code,'PROXY_PORT_UNAVAILABLE');assert.equal(launches,0);assert.equal(puts,0);
  // Missing startup visibility must not be reported as a successful launch.
  assert.equal((await app({command:'launch',profile:1})).details.code,'LAUNCH_NOT_VERIFIED');assert.equal(launches,1);
  const {argumentsFor}=require('../index');
  for(const url of ['file:///C:/x','javascript:alert(1)','https://user:pass@example.com','--load-extension=x','https://example.com/\n'])assert.throws(()=>argumentsFor({command:'launch',profile:1,url}),/INVALID_URL/);
  assert.equal(argumentsFor({command:'find_and_launch',mode:'direct',url:'https://example.com'}).url,'https://example.com/');
  const profileDir=path.join(root,'profile_1');
  rows=[{pid:9991,ppid:0,name:'chrome.exe',created:'fixture',commandLine:'chrome.exe --user-data-dir="'+profileDir+'" --no-proxy-server'}];
  const forces=[];
  const closing=createManager({config:{...config,allowed:['close','close_all_managed_profiles']},platform:{snapshot:async()=>rows,terminate:async(t,o)=>{forces.push(o.force);if(o.force)rows=[];}},approve:async()=>{},audit:async()=>{}});
  assert.equal((await closing({command:'close',profile:1,confirm:true})).details.code,'CLOSE_REQUIRES_FORCE');
  const partial=await closing({command:'close_all_managed_profiles',confirm:true});assert.equal(partial.details.complete,false);
  assert.equal((await closing({command:'close',profile:1,confirm:true,force:true})).status,'success');assert.deepEqual(forces,[false,false,true]);
  const beforeCorrupt='{"version":';await fs.writeFile(notes,beforeCorrupt);
  assert.equal((await app({command:'set_note',profile:1,note:'never'})).status,'error');assert.equal(await fs.readFile(notes,'utf8'),beforeCorrupt);
  console.log('PASS: UTF16/corrupt state, junction rejection, cross-process lock, duplicate/invalid ports, exhausted pools, process visibility, protected PID, denied approval, no proxy fallback, startup verification');
 }finally{if(child){child.stdin.end('release');await new Promise(r=>child.once('close',r));}await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
