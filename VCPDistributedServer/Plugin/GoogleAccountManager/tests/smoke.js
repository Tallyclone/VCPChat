'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {createManager,configuration,argumentsFor}=require('../index');
const S=require('../storage'),P=require('../platform'),X=require('../proxy');
const all=['list','inspect','launch','proxy_login','close','proxy_status','refresh_proxy_bindings','set_note','set_type','find_available_account','find_and_launch','close_all_managed_profiles'];
(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gam-test-'));let server;
  try{
    await fs.mkdir(path.join(root,'scripts'));await fs.writeFile(path.join(root,'scripts','clash_party.token'),'fixture-secret');
    const chrome=path.join(root,'chrome.exe');await fs.writeFile(chrome,'fixture, never executable');
    await fs.mkdir(path.join(root,'profile_1','Default'),{recursive:true});
    await fs.writeFile(path.join(root,'profile_1','Default','Preferences'),JSON.stringify({account_info:[{email:'hint@example.com'}]}));
    await fs.writeFile(path.join(root,'.google_account_notes.json'),'\uFEFF'+JSON.stringify({version:1,notes:{1:'existing'},types:{}}));
    let rows=[],launched=[],terminated=[],puts=[],failGroup=false,malformed=false,slow=false;
    const outlets=Array.from({length:50},(_,i)=>({enable:true,mode:'direct',remark:'octopus-top '+i,target:'group '+i,port:7700+i}));
    const nodes=Array.from({length:60},(_,i)=>'node '+i);
    const current={};
    server=http.createServer((req,res)=>{
      assert.equal(req.headers.authorization,'Bearer fixture-secret');
      if(slow)return;
      if(malformed){res.end('fixture-secret invalid');return;}
      if(req.url==='/outlets'){res.end(JSON.stringify({ok:true,outlets:[...outlets].reverse()}));return;}
      const target=decodeURIComponent(req.url.slice('/groups/'.length));
      if(failGroup&&target==='group 3'){res.statusCode=500;res.end('fixture-secret');return;}
      if(req.method==='GET'){res.end(JSON.stringify({ok:true,proxies:['octopus_top-自动',...nodes],now:current[target]||nodes[0]}));return;}
      let body='';req.on('data',c=>body+=c);req.on('end',()=>{const b=JSON.parse(body);puts.push({target,...b});current[target]=b.name;res.end(JSON.stringify({ok:true}));});
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const config={root,chrome,proxyHost:'127.0.0.1',proxyPort:server.address().port,allowed:all,approval:'local-policy',httpTimeoutMs:150,operationTimeoutMs:10000};
    const platform={snapshot:async()=>rows.map(p=>({...p})),launch:async(exe,args)=>{
      assert.equal(exe,chrome);launched.push(args);const pid=1000+launched.length;
      rows.push({pid,ppid:0,name:'chrome.exe',created:'2026-01-01T00:00:00Z',commandLine:'chrome.exe '+args.map(a=>'"'+a+'"').join(' ')});return{pid};
    },terminate:async targets=>{terminated.push(...targets.map(p=>p.pid));rows=rows.filter(p=>!targets.some(t=>t.pid===p.pid));}};
    const manager=createManager({config,platform,reachable:async()=>{},approve:async()=>{}});
    const ok=async args=>{const r=await manager(args);assert.equal(r.status,'success',JSON.stringify(r));return r.details;};
    const error=async(args,code)=>{const r=await manager(args);assert.equal(r.status,'error');assert.equal(r.details.code,code);assert(!JSON.stringify(r).includes('fixture-secret'));};
    assert.throws(()=>argumentsFor({command:'inspect',profile:true}),/INVALID_PROFILE/);
    for(const value of ['1;whoami','../2',0,51,1.5,'01'])await error({command:'inspect',profile:value},'INVALID_PROFILE');
    await error({command:'launch',profile:1,args:'--load-extension=x'},'UNKNOWN_ARGUMENT');
    await error({command:'launch',profile:1,restart:'false;'},'INVALID_BOOLEAN');
    assert.equal((await ok({command:'list'})).accounts.length,50);
    const first=await ok({command:'inspect',profile:1});assert.equal(first.emailHint,'hint@example.com');assert.equal(first.loginStatus,'unknown');
    assert.equal((await ok({command:'inspect',profile:31})).type,'other');
    await ok({command:'set_note',profile:1,note:'new secret note'});await ok({command:'set_type',profile:31,type:'google'});
    const notes=await S.notes(root);assert.equal(notes.notes[1],'new secret note');assert.equal(notes.types[31],'google');await fs.access(path.join(root,'.google_account_notes.json.bak'));
    const denied=createManager({config:{...config,allowed:['list']},platform});assert.equal((await denied({command:'set_note',profile:1,note:'x'})).details.code,'COMMAND_NOT_ALLOWED');
    rows=[{pid:5,ppid:0,name:'mshta.exe',commandLine:'renamed.hta'}];await error({command:'set_note',profile:1,note:'x'},'HTA_RUNNING');await error({command:'refresh_proxy_bindings'},'HTA_RUNNING');rows=[];
    const blocker=await fs.open(path.join(root,'.google_account_manager.lock'),'wx');await error({command:'set_type',profile:1,type:'other'},'BUSY_LOCK');await blocker.close();await fs.unlink(path.join(root,'.google_account_manager.lock'));
    await ok({command:'refresh_proxy_bindings'});let binding=await S.bindings(root);assert.equal(Object.keys(binding.bindings).length,50);assert.equal(X.duplicates(binding.bindings).length,0);assert.equal(puts.length,0);
    // Preserve a later slot's valid node before allocating an invalid earlier one.
    binding.bindings[1].node='removed';binding.bindings[50].node='node 0';await S.atomic(path.join(root,'.google_proxy_bindings.json'),binding);
    await ok({command:'refresh_proxy_bindings',force:'false'});binding=await S.bindings(root);assert.equal(binding.bindings[50].node,'node 0');assert.notEqual(binding.bindings[1].node,'node 0');
    const before=await fs.readFile(path.join(root,'.google_proxy_bindings.json'),'utf8');failGroup=true;await error({command:'refresh_proxy_bindings',force:true},'PROXY_HTTP_ERROR');assert.equal(await fs.readFile(path.join(root,'.google_proxy_bindings.json'),'utf8'),before);failGroup=false;
    await ok({command:'refresh_proxy_bindings',force:true});await ok({command:'proxy_status',profile:1,live:true});
    await ok({command:'launch',profile:1});assert(launched[0].includes('--no-proxy-server'));const count=launched.length;
    await ok({command:'launch',profile:1});assert.equal(launched.length,count);
    await error({command:'proxy_login',profile:1},'MODE_CONFLICT_RESTART_REQUIRED');assert.equal(puts.length,0);
    await ok({command:'proxy_login',profile:1,restart:true});assert.equal(puts.length,1);assert(terminated.length>0);assert(launched.at(-1).some(x=>x==='--proxy-server=http://127.0.0.1:7700'));
    await ok({command:'proxy_login',profile:1});assert.equal(puts.length,1);
    await error({command:'launch',profile:1},'MODE_CONFLICT_RESTART_REQUIRED');
    await error({command:'close',profile:1},'CONFIRM_REQUIRED');await ok({command:'close',profile:1,confirm:true});
    malformed=true;const prior=launched.length;await error({command:'proxy_login',profile:2},'PROXY_RESPONSE_INVALID');assert.equal(launched.length,prior);malformed=false;
    slow=true;await error({command:'proxy_status',live:true},'PROXY_TIMEOUT');slow=false;
    const picked=await ok({command:'find_available_account',type:'google',initialized:true});assert.equal(picked.account.profile,1);assert.equal(picked.reserved,false);
    await ok({command:'find_and_launch',mode:'direct',type:'other'});
    const concurrent=await Promise.all([manager({command:'find_and_launch',mode:'direct',type:'google'}),manager({command:'find_and_launch',mode:'direct',type:'google'})]);
    const successes=concurrent.filter(x=>x.status==='success');assert(successes.length>=1);
    assert.equal(new Set(successes.map(x=>x.details.profile)).size,successes.length);
    assert(concurrent.filter(x=>x.status==='error').every(x=>x.details.code==='BUSY_LOCK'));
    rows.push({pid:8000,ppid:0,name:'chrome.exe',commandLine:'chrome.exe --user-data-dir="C:/unmanaged"',created:'2026-01-01T00:00:00Z'});
    await ok({command:'close_all_managed_profiles',confirm:true});assert(rows.some(p=>p.pid===8000));assert(!terminated.includes(8000));rows=[];
    assert(P.exact('chrome "--user-data-dir=C:/space name/profile_1"','C:/space name/profile_1'));
    assert(P.exact('chrome --user-data-dir "C:/space name/profile_1"','C:/space name/profile_1'));
    assert(!P.exact('chrome --user-data-dir=C:/x/profile_10','C:/x/profile_1'));
    const sample=[{pid:1,ppid:0,name:'chrome.exe',commandLine:'--user-data-dir=C:/x/profile_1'},{pid:2,ppid:1,name:'chrome.exe',commandLine:'--type=renderer'},{pid:3,ppid:1,name:'node.exe',commandLine:'node'},{pid:4,ppid:1,name:'chrome.exe',commandLine:'--user-data-dir=C:/x/profile_10'}];
    assert.deepEqual(P.selected(sample,'C:/x/profile_1').map(p=>p.pid),[1,2]);
    const audit=await fs.readFile(path.join(root,'.google_account_manager.audit.jsonl'),'utf8');assert(!audit.includes('new secret note'));assert(!audit.includes('fixture-secret'));assert(!audit.includes('hint@example.com'));
    const local=path.join(root,'config.json');await fs.writeFile(local,JSON.stringify({paths:{accountsDir:root,chromePath:chrome},clash:{host:'127.0.0.1',port:config.proxyPort}}));
    const env={GAM_SOURCE_CONFIG:local,GAM_ALLOWED_ROOT:root};assert.equal((await configuration(env)).root,root);
    await assert.rejects(()=>configuration({...env,GAM_ALLOWED_ROOT:path.dirname(root)}),/ROOT_NOT_ALLOWED/);
    // Real child CLI, real configuration and read-only command; fake profile root only.
    const cli=await new Promise((resolve,reject)=>{const cp=spawn(process.execPath,[path.join(__dirname,'../index.js')],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';cp.stdout.on('data',x=>stdout+=x);cp.stderr.on('data',x=>stderr+=x);cp.on('error',reject);cp.on('close',code=>resolve({code,stdout,stderr}));cp.stdin.end(JSON.stringify({command:'proxy_status'}));});
    assert.equal(cli.code,0);assert.equal(cli.stderr,'');assert.equal(cli.stdout.trim().split('\n').length,1);assert.equal(JSON.parse(cli.stdout).status,'success');
    console.log('PASS: 12 commands; policy, HTA, lock, atomic backups, proxy HTTP/failures, session conflicts, exact process tree, redacted audit, CLI envelope');
  } finally {if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
