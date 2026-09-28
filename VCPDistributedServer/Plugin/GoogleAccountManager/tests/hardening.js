'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {spawnSync}=require('node:child_process');
const S=require('../storage'),P=require('../platform');
const {createManager,argumentsFor}=require('../index');
function isolated(file,overrides){
  const filename=path.resolve(__dirname,'..',file),module={exports:{}},native=createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,process,Buffer,URL,setTimeout,clearTimeout,require:id=>Object.hasOwn(overrides,id)?overrides[id]:native(id)},{filename});
  return module.exports;
}
(async()=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'gam-hardening-'));
  try{
    for(const profile of ['1\n','1\r',' 1','+1','1e0','0x1',[],{},null,true])assert.throws(()=>argumentsFor({command:'inspect',profile}),/INVALID_PROFILE/);
    assert.equal(P.exact('chrome -- --user-data-dir=C:/safe/profile_1','C:/safe/profile_1'),false);
    assert.equal(P.exact('chrome --user-data-dir="C:/safe/profile_1"','C:/safe/profile_1'),true);
    assert.throws(()=>P.flags('chrome --user-data-dir="C:/unfinished'),/PROCESS_ARGUMENTS_AMBIGUOUS/);

    const state=path.join(root,'state.json');
    await fsp.writeFile(state,'{"value":1}');await fsp.writeFile(state+'.bak','{"value":0}');
    let failDestination=state;
    const broken=isolated('storage.js',{'node:fs/promises':{...fsp,rename:async(a,b)=>{if(b===failDestination)throw Object.assign(Error('fixture'),{code:'EIO'});return fsp.rename(a,b);}}});
    await assert.rejects(()=>broken.atomic(state,{value:2}),/fixture/);
    assert.equal((await S.read(state)).value,1);assert.equal((await S.read(state+'.bak')).value,1);
    assert(!(await fsp.readdir(root)).some(n=>n.includes('.tmp')));
    failDestination=state+'.bak';await fsp.writeFile(state+'.bak','{"value":0}');
    await assert.rejects(()=>broken.atomic(state,{value:2}),/fixture/);
    assert.equal((await S.read(state)).value,1);assert.equal((await S.read(state+'.bak')).value,0);
    await fsp.writeFile(state,'broken');await assert.rejects(()=>S.atomic(state,{value:3}),/INVALID_STATE_JSON/);
    assert.equal(await fsp.readFile(state,'utf8'),'broken');

    const dir=path.join(root,'profile_1');
    let rows=[{pid:900001,ppid:0,created:'2026-01-01T00:00:00Z',name:'chrome.exe',commandLine:'chrome --user-data-dir="'+dir+'"'},
      {pid:900002,ppid:900001,created:'2026-01-01T00:00:01Z',name:'chrome.exe',commandLine:'chrome --type=renderer'}];
    const call=createManager({config:{root,allowed:['close'],approval:'local-policy'},audit:async()=>{},approve:async()=>{},platform:{snapshot:async()=>rows,terminate:async()=>{rows=rows.slice(1);}}});
    assert.equal((await call({command:'close',profile:1,confirm:true})).details.code,'CLOSE_REQUIRES_FORCE');

    // Execute the actual generated PowerShell against functions defined in this
    // disposable child process; no Get-CimInstance/Get-Process/Terminate reaches Windows.
    let captured;
    const mock=isolated('platform.js',{'node:child_process':{spawn:()=>{throw Error('unexpected launch');},execFile:(exe,args,options,cb)=>{captured={script:Buffer.from(args.at(-1),'base64').toString('utf16le'),data:options.env.GAM_DATA};cb(null,'ok');}}});
    const target={pid:900003,ppid:0,name:'chrome.exe',created:'2026-01-01T00:00:00.0000000Z',commandLine:'fixture'};
    for(const force of [false,true]){
      await mock.terminate([target],{force});
      const prelude=`$script:events=[System.Collections.Generic.List[string]]::new();
function Get-CimInstance { param($ClassName,$Filter) [pscustomobject]@{Name='chrome.exe';CreationDate=[DateTime]::Parse('2026-01-01T00:00:00Z').ToUniversalTime();CommandLine='fixture'} }
function Get-Process { param($Id,$ErrorAction) $p=[pscustomobject]@{MainWindowHandle=1};$p|Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value {$script:events.Add('normal');return $true};return $p }
function Invoke-CimMethod { param($InputObject,$MethodName) $script:events.Add('force');return [pscustomobject]@{ReturnValue=0} }
`;
      const source=prelude+captured.script+"\n'events:'+($script:events -join ',')";
      const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{env:{...process.env,GAM_DATA:captured.data},encoding:'utf8',timeout:15000});
      assert.equal(result.status,0,result.stderr);assert(result.stdout.includes(force?'events:normal,force':'events:normal'));
      if(!force)assert(!result.stdout.includes('events:normal,force'));
    }
    console.log('PASS: strict IDs, Windows argument parsing, atomic/backup failure cleanup, corrupt JSON refusal, orphan detection, actual PowerShell normal-before-force with mocked processes');
  }finally{await fsp.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
