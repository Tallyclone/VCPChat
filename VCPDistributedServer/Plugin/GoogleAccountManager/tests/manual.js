'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os');
const {createManager}=require('../index'), M=require('../manual'), S=require('../storage');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gam-manual-'));
 try {
  const chrome=path.join(root,'chrome.exe');await fs.writeFile(chrome,'fixture');
  const outlets=[{port:8901,mode:'direct',target:'Hidden / Group',type:'mixed',remark:'custom'}, {port:8902,mode:'direct',target:'Hidden / Group',type:'socks',remark:'shared'}, {port:8903,mode:'fallback',target:'PARTY-OUTLET-8903'}, {port:8904,mode:'direct',target:'Hidden / Group',enable:false}];
  let now='A',rows=[],puts=[],launches=0,failPut=false;
  const request=async(method,route,body)=>{
   if(route==='/outlets')return{outlets};
   const g={name:'Hidden / Group',type:'Selector',now,proxies:['A','B','Sub']};
   if(route==='/groups')return{groups:[]};
   const name=decodeURIComponent(route.split('?')[0].slice('/groups/'.length));
   if(name==='Sub')return{name:'Sub',type:'URLTest',now:'Leaf',proxies:['Leaf']};
   if(name!=='Hidden / Group')S.fail('PROXY_HTTP_NOT_FOUND');
   if(method==='PUT'){assert(route.endsWith('?close=0'));puts.push(body);if(failPut)S.fail('PROXY_TIMEOUT');now=body.name;}
   return {...g,now};
  };
  const platform={snapshot:async()=>rows,terminate:async targets=>{rows=rows.filter(p=>!targets.some(t=>t.pid===p.pid));},launch:async(exe,args)=>{launches++;const pid=10000+launches;rows.push({pid,ppid:0,created:'2026-01-01',name:'chrome.exe',commandLine:args.map(x=>'"'+x+'"').join(' ')});return{pid};}};
  const allowed=['list_outlets','list_groups','list_nodes','login_with_proxy','restore_auto_binding','inspect','proxy_login','close'];
  const call=createManager({config:{root,chrome,allowed,approval:'local-policy',proxyHost:'127.0.0.1'},platform,request,reachable:async()=>{},audit:async()=>{}});
  const ok=async a=>{const r=await call(a);assert.equal(r.status,'success',JSON.stringify(r));return r.details;};
  const err=async(a,c)=>assert.equal((await call(a)).details.code,c);
  assert.equal((await ok({command:'list_outlets'})).outlets.length,4);
  assert.equal((await ok({command:'list_groups'})).groups.length,0);
  assert.equal((await ok({command:'list_groups',outletPort:'8901'})).groups[0].name,'Hidden / Group');
  assert.deepEqual((await ok({command:'list_nodes',group:'Hidden / Group',keyword:'b'})).proxies,['B','Sub']);
  const login={command:'login_with_proxy',profile:1,outletPort:8901,node:'B'};
  await err({...login,outletPort:'08901'},'INVALID_OUTLET_PORT');
  await err({...login,node:'bad'},'NODE_NOT_IN_GROUP');
  await err({...login,group:'different'},'OUTLET_GROUP_MISMATCH');
  await err({...login,group:'different',reassignOutlet:true},'OUTLET_REASSIGN_UNSUPPORTED_BY_API');
  await err({...login,outletPort:8904},'OUTLET_DISABLED');
  await err({...login,outletPort:8903},'OUTLET_MODE_NOT_MANUALLY_SELECTABLE');
  assert.equal(puts.length,0);assert.equal(launches,0);
  let result=await ok(login);assert.equal(result.bindingSaved,false);assert.equal(puts.length,1);assert.deepEqual((await M.load(root)).bindings,{});
  result=await ok({...login,saveBinding:true});assert(result.alreadyRunning);assert(result.bindingSaved);
  assert.equal((await ok({command:'inspect',profile:1})).binding.source,'manual');
  // HTA/automatic rewrites cannot overwrite the separate manual override.
  await S.atomic(path.join(root,'.google_proxy_bindings.json'),{version:1,rebindStamp:'',bindings:{1:{port:7700,target:'auto',node:'auto',remark:'auto'}}});
  assert.equal((await M.effective(root)).bindings[1].port,8901);
  await ok({command:'close',profile:1,confirm:true});
  await ok({command:'proxy_login',profile:1});assert.equal(puts.length,1);
  await err({...login,profile:2,node:'A'},'PROXY_IN_USE');
  await ok({...login,profile:2,node:'A',allowSharedSwitch:true});assert.equal(now,'A');
  const before=puts.length;await ok({...login,profile:3,node:'A'});assert.equal(puts.length,before);
  rows=[];
  result=await ok({...login,node:'Sub',outletPort:8902});assert.equal(result.mode,'socks5://127.0.0.1:8902');assert.equal(result.selectionChain.chain.length,2);
  rows=[];failPut=true;const launched=launches;await err({...login,node:'B'},'PROXY_SELECTION_UNCERTAIN_NO_LAUNCH');assert.equal(launches,launched);failPut=false;
  result=await ok({command:'restore_auto_binding',profile:1});assert.equal(result.binding.port,7700);assert.equal((await M.effective(root)).bindings[1].target,'auto');
  assert.equal((await ok({command:'restore_auto_binding',profile:2})).needsRefresh,true);
  console.log('PASS: all outlets, hidden groups, membership, unsupported reassignment, temporary/saved/manual priority, restore, shared conflict/override, SOCKS, nested chain, PUT failure without launch');
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
