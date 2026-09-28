'use strict';
const path = require('node:path');
const S = require('./storage');
const P = require('./platform');
const file = root => path.join(root, '.google_manual_proxy_bindings.json');
function port(value) {
  const n = Number(value);
  if (!['number','string'].includes(typeof value) || String(n) !== String(value) || !Number.isInteger(n) || n < 1 || n > 65535) S.fail('INVALID_OUTLET_PORT');
  return n;
}
async function load(root) {
  const data = await S.read(file(root), {version:1, bindings:{}});
  if (!S.object(data) || data.version !== 1 || !S.object(data.bindings)) S.fail('INVALID_MANUAL_BINDINGS');
  for (const [id,b] of Object.entries(data.bindings)) {
    S.id(id);
    if (!S.object(b) || !S.name(b.target) || !S.name(b.node) || b.source !== 'manual') S.fail('INVALID_MANUAL_BINDINGS');
    port(b.port);
  }
  return data;
}
async function effective(root) {
  const auto = await S.bindings(root), manual = await load(root);
  return {...auto, bindings:{...auto.bindings, ...manual.bindings}};
}
async function save(root, id, binding) {
  const data = await load(root);
  data.bindings[S.id(id)] = {...binding,source:'manual'};
  await S.atomic(file(root), data);
}
async function restore(root, id) {
  const data = await load(root);
  delete data.bindings[S.id(id)];
  await S.atomic(file(root), data);
  const auto = await S.bindings(root);
  return {profile:id, source:'auto', binding:auto.bindings[id] || null, needsRefresh:!auto.bindings[id], runningSessionChanged:false};
}
async function outlets(request) {
  const data = await request('GET','/outlets');
  if (!Array.isArray(data.outlets)) S.fail('INVALID_OUTLETS');
  const result = data.outlets.map(o => {
    if (!S.object(o)) S.fail('INVALID_OUTLETS');
    return {port:port(o.port), enable:o.enable !== false, mode:o.mode, type:o.type || 'mixed', target:o.target || '', targets:Array.isArray(o.targets)?o.targets:[], remark:String(o.remark || '')};
  });
  if (new Set(result.map(o=>o.port)).size !== result.length) S.fail('DUPLICATE_OUTLET');
  return result.sort((a,b)=>a.port-b.port);
}
function group(data) {
  if (!S.object(data) || !S.name(data.name) || !Array.isArray(data.proxies) || data.proxies.some(n=>!S.name(n))) S.fail('INVALID_GROUP');
  return {name:data.name,type:data.type,now:data.now || '',fixed:data.fixed || '',proxies:data.proxies,
    switchable:!/^PARTY-(OUTLET|PROBE)-/.test(data.name) && ['Selector','URLTest','Fallback'].includes(data.type)};
}
async function groups(request) {
  const data = await request('GET','/groups');
  if (!Array.isArray(data.groups)) S.fail('INVALID_GROUPS');
  return data.groups.map(group);
}
async function resolve(request, args) {
  const all = await outlets(request), outlet = all.find(o=>o.port === port(args.outletPort));
  if (!outlet) S.fail('OUTLET_NOT_FOUND');
  if (!outlet.enable) S.fail('OUTLET_DISABLED');
  if (outlet.mode !== 'direct') S.fail('OUTLET_MODE_NOT_MANUALLY_SELECTABLE');
  if (!['mixed','http','socks'].includes(outlet.type)) S.fail('OUTLET_PROTOCOL_UNSUPPORTED');
  if (args.group && args.group !== outlet.target) S.fail(args.reassignOutlet ? 'OUTLET_REASSIGN_UNSUPPORTED_BY_API' : 'OUTLET_GROUP_MISMATCH');
  const target = args.group || outlet.target;
  if (!S.name(target) || !S.name(args.node)) S.fail('INVALID_PROXY_SELECTION');
  // Single-group GET includes hidden groups that /groups omits.
  const detail = group(await request('GET','/groups/'+encodeURIComponent(target)));
  if (!detail.switchable) S.fail('GROUP_NOT_SWITCHABLE');
  if (!detail.proxies.includes(args.node)) S.fail('NODE_NOT_IN_GROUP');
  if (['DIRECT','REJECT','PASS','REJECT-DROP'].includes(args.node)) S.fail('NOT_A_PROXY_NODE');
  return {binding:{port:outlet.port,target,node:args.node,remark:outlet.remark,source:'manual',protocol:outlet.type==='socks'?'socks5':'http'}, group:detail, outlets:all};
}
async function query(request, a) {
  const keyword = (a.keyword || '').toLowerCase();
  if (a.command === 'list_outlets') return {outlets:(await outlets(request)).filter(o=>JSON.stringify(o).toLowerCase().includes(keyword)), reassignOutletSupported:false};
  if (a.command === 'list_groups') {
    if (a.outletPort !== undefined) {
      const o = (await outlets(request)).find(o=>o.port===a.outletPort);
      if (!o) S.fail('OUTLET_NOT_FOUND');
      return {outlet:o, groups:[group(await request('GET','/groups/'+encodeURIComponent(o.target)))], reassignOutletSupported:false};
    }
    return {groups:(await groups(request)).filter(g=>g.name.toLowerCase().includes(keyword)).map(({proxies,...g})=>({...g,nodeCount:proxies.length})), hiddenGroups:'Use list_groups with outletPort or list_nodes with exact group name.'};
  }
  const g = group(await request('GET','/groups/'+encodeURIComponent(a.group)));
  return {...g, proxies:g.proxies.filter(n=>n.toLowerCase().includes(keyword)), memberMayBeGroup:true};
}
async function chain(request, start) {
  const result = [], seen = new Set();
  let current = start;
  for (let i=0;i<16;i++) {
    if (seen.has(current)) S.fail('PROXY_GROUP_CYCLE');
    seen.add(current);
    let g;
    try { g = group(await request('GET','/groups/'+encodeURIComponent(current))); }
    catch(e) {
      if (e.code === 'PROXY_HTTP_NOT_FOUND') return {chain:result,terminal:current,terminalVerified:false};
      throw e;
    }
    result.push({group:g.name,type:g.type,selected:g.now,fixed:g.fixed});
    if (!g.now) return {chain:result,terminal:null,terminalVerified:false};
    current = g.now;
  }
  S.fail('PROXY_CHAIN_TOO_DEEP');
}
async function conflicts(request, rows, dir, binding, all, allow) {
  const routes = [];
  for (const p of rows) {
    if (String(p.name).toLowerCase() !== 'chrome.exe' || P.exact(p.commandLine,dir)) continue;
    const value = P.flag(p.commandLine,'--proxy-server');
    if (!value) continue;
    let u;
    try { u = new URL(value); } catch { S.fail('PROXY_USAGE_UNKNOWN'); }
    if (!['127.0.0.1','localhost','[::1]'].includes(u.hostname)) continue;
    const o = all.find(o=>o.port===Number(u.port));
    if (!o) continue;
    if (!routes.some(x=>x.port===o.port)) routes.push(o);
  }
  const affected = [];
  for (const o of routes) {
    if (o.port===binding.port || o.target===binding.target) { affected.push(o.port); continue; }
    if (o.mode !== 'direct') { if (!allow) S.fail('PROXY_USAGE_UNKNOWN'); affected.push(o.port); continue; }
    const route = await chain(request,o.target);
    if (route.chain.some(g=>g.group===binding.target)) affected.push(o.port);
  }
  if (affected.length && !allow) S.fail('PROXY_IN_USE');
  return affected;
}
module.exports = {port,load,effective,save,restore,outlets,groups,group,resolve,query,chain,conflicts};
