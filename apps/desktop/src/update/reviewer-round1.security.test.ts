/**
 * Probes from the first cross-model review (round 1), kept so its findings stay fixed. Adapted to
 * the fixes: the app verifies into a private directory (verifyFromZip) and only the helper,
 * under the install lock, writes the shared staged path; skipping is decided from the helper's
 * recorded progress; skips are build numbers.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import { parsePublicKey, verifyMinisign } from './minisign.ts';
import { PRIMARY_PUBLIC_KEY } from './keys.ts';
import { checkForUpdate } from './check.ts';
import { decide } from './policy.ts';
import { downloadVerified, fetchLatestRelease, expectedAssetUrl } from './github.ts';
import { afterCheck, EMPTY_STATE, nextCheckAt, parseState, withSkipped } from './state.ts';
import { manifest, comment, COMMIT, TEAM } from './testing/fixtures.ts';
import { classifyOutcome, bundlesFor, helperDeps, parseProgress, summarizeResult, type UpdateJob, type HelperEffects } from './helperCore.ts';
import { verifyFromZip } from './macos.ts';
import { runInstall } from '../install/engine.ts';
import { realFileOps, realSqliteOps, acquireLock, lockHolder } from '../install/lib.ts';
import { isInstallerPid } from '../install/mac.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'updater-probe-'));
const running = { version:'1.2.0', channel:'release' as const, build:400, schemaVersion:20, platform:'darwin' as const, arch:'arm64', osVersion:'15.0' };
const opts = {tag:'v1.3.0', teamId:TEAM, skipped:[], dbSchema:20};
const kp = generateKeyPairSync('ed25519');
const id = randomBytes(8);
const pub = parsePublicKey(Buffer.concat([Buffer.from('Ed'), id, Buffer.from(kp.publicKey.export({format:'jwk'}).x!, 'base64url')]).toString('base64'));
function sig(data:Buffer, text:string, key=kp.privateKey, keyId=id, alg='ED') {
  const s=sign(null, alg==='ED'?createHash('blake2b512').update(data).digest():data, key);
  return ['untrusted comment: review',Buffer.concat([Buffer.from(alg),keyId,s]).toString('base64'),'trusted comment: '+text,sign(null,Buffer.concat([s,Buffer.from(text)]),key).toString('base64'),''].join('\n');
}
async function check(m=manifest(), over:any={}, data=Buffer.from(JSON.stringify(m)), signature=sig(data,comment(m))) {
  const tag=over.tag??'v1.3.0';
  const files:any={'apollo-update.json':data,'apollo-update.json.minisig':signature};
  const assets=[...m.assets.map(a=>({name:a.name,size:a.size,digest:'sha256:'+a.sha256})),...Object.keys(files).map(name=>({name,size:files[name].length}))].map(a=>({...a,browser_download_url:expectedAssetUrl(tag,a.name),...over.asset}));
  return checkForUpdate({keys:{configured:true,keys:[pub],notes:[]}, running, teamId:TEAM, skipped:[],dbSchema:20,now:0,fetchFn:async url=>url.includes('api.github.com')?Response.json({tag_name:tag,html_url:'javascript:alert(1)',draft:false,prerelease:false,assets}):new Response(files[decodeURIComponent(url.split('/').at(-1)!)]),...over.deps});
}

describe('independent signature and policy probes',()=>{
  it('rejects forged embedded key id, changed comment, spliced global signature, and legacy Ed',async()=>{
    const data=Buffer.from(JSON.stringify(manifest()));
    const embeddedId=Buffer.from(PRIMARY_PUBLIC_KEY,'base64').subarray(2,10);
    expect(verifyMinisign(data,sig(data,comment(manifest()),kp.privateKey,embeddedId),[parsePublicKey(PRIMARY_PUBLIC_KEY)]).ok).toBe(false);
    const good=sig(data,comment(manifest()));
    expect(verifyMinisign(data,good.replace('build=500','build=501'),[pub]).ok).toBe(false);
    const lines=good.split('\n');
    const otherComment=comment(manifest({build:501}));
    lines[2]='trusted comment: '+otherComment;
    lines[3]=sign(null,Buffer.concat([Buffer.from(lines[1]!, 'base64').subarray(10),Buffer.from(otherComment)]),kp.privateKey).toString('base64');
    expect(verifyMinisign(Buffer.from(data.toString().replace('"build":500','"build":501')),lines.join('\n'),[pub]).ok).toBe(false);
    expect(verifyMinisign(data,sig(data,comment(manifest()),kp.privateKey,id,'Ed'),[pub]).ok).toBe(false);
    const bad=Buffer.from('{not JSON');
    const result=await check(manifest(),{},bad,sig(bad,'x',generateKeyPairSync('ed25519').privateKey));
    expect(result).toMatchObject({kind:'refused',reason:expect.stringContaining('signature does not match')});
  });
  it('rejects all policy boundary cases and metadata disagreement',async()=>{
    for(const build of [399,400]) expect(decide(manifest({build}),running,opts).kind).toBe('up-to-date');
    for(const m of [manifest({schemaVersion:19}),manifest({channel:'nightly'}),manifest({assets:[...manifest().assets,{...manifest().assets[0]!,name:'other.zip'}]})]) expect(decide(m,running,opts).kind).toBe('refuse');
    expect(decide(manifest(),running,{...opts,dbSchema:21}).kind).toBe('refuse');
    expect((await check(manifest(),{tag:'v1.3.0-extra'})).kind).toBe('refused');
    for(const codeSigning of [{kind:'adhoc'},{kind:'unsigned'},{kind:'developer-id',team:'ZZZZZZZZZZ'}]) {
      const m=manifest(); const a={...m.assets[0]!,codeSigning} as any;
      if(codeSigning.kind==='adhoc') a.name='Apollo-1.3.0-arm64-adhoc.zip';
      expect((await check({...m,assets:[a]})).kind).toBe('refused');
    }
    const m=manifest();expect((await check({...m,assets:[{...m.assets[0]!,name:'wrong.zip'}]})).kind).toBe('refused');
    for(const asset of [{size:999},{digest:'sha256:'+'0'.repeat(64)}]) expect((await check(m,{asset})).kind).toBe('refused');
  });
});

describe('real HTTP download failures',()=>{
  it('rejects overflow, hash mismatch, stalled body, connection reset and non-200',async()=>{
    const server=createServer((req,res)=>{
      if(req.url==='/status') {res.writeHead(503);res.end();return;}
      res.writeHead(200);res.flushHeaders();
      if(req.url==='/stall') {res.write('x');return;}
      if(req.url==='/reset') {res.write('x');setTimeout(()=>res.destroy(),10);return;}
      res.end('abc');
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const url='http://127.0.0.1:'+(server.address() as any).port;
    const run=(path:string,size=3,sha256='0'.repeat(64))=>downloadVerified({fetchFn:fetch,url:url+path,path:join(temp(),'asset'),expected:{size,sha256},stallMs:60});
    try {
      await expect(run('/overflow',2)).rejects.toThrow(/larger/);
      await expect(run('/hash')).rejects.toThrow(/SHA-256/);
      await expect(run('/stall')).rejects.toThrow();
      await expect(run('/reset')).rejects.toThrow();
      await expect(run('/status')).rejects.toThrow(/503/);
    } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });
});

function world() {
  const base=temp();const bundles=bundlesFor(join(base,'Apollo.app'));
  const info={commit:COMMIT,dirty:false,branch:null,builtAt:'now',schemaVersion:20,version:'1.3.0',bundleVersion:'500',channel:'release' as const};
  const write=(bundle:string,buildInfo=info)=>{mkdirSync(join(bundle,'Contents/Resources'),{recursive:true});writeFileSync(join(bundle,'Contents/Resources/build-info.json'),JSON.stringify(buildInfo));};
  const source=join(base,'userData/updates/work/probe/unpacked/Apollo.app');
  write(bundles.target,{...info,commit:'f'.repeat(40),bundleVersion:'400',version:'1.2.0'});write(source);
  const job:UpdateJob={format:1,id:'probe',createdAt:0,version:'1.3.0',build:500,commit:COMMIT,schemaVersion:20,bundles,source,progressPath:join(base,'userData/updates/progress.json'),dataDir:join(base,'data'),resultPath:join(base,'userData/updates/result.json'),logPath:join(base,'helper.log'),teamId:TEAM,waitTimeoutMs:60000};
  mkdirSync(job.dataDir);let t=0;let alive=true;let quits=0;const launches:string[]=[];
  const fx:HelperEffects={files:realFileOps,sqlite:realSqliteOps,now:()=>t,sleep:async ms=>{t+=ms},log:()=>{},apollo:()=>alive?[{pid:2,kind:'installed'}]:[],requestQuit:()=>{quits++;alive=false},kill:()=>{alive=false},isInstaller:()=>false,busy:()=>[],launch:async(_,strategy)=>{alive=true;launches.push(JSON.parse(readFileSync(join(bundles.target,'Contents/Resources/build-info.json'),'utf8')).version);return {strategy,command:'fake',args:[],status:0,signal:null,stderr:'',error:null,pid:2,spawned:true}},healthy:async()=>true,holdSignals:()=>{},copyBundle:async(from,to)=>{cpSync(from,to,{recursive:true})},checkSignature:async()=>null,pid:1};
  const progress=()=>parseProgress(existsSync(job.progressPath)?readFileSync(job.progressPath,'utf8'):null,job.id);
  return {job,fx,info,write,launches,quits:()=>quits,progress};
}

describe('apply and permanent skip probes',()=>{
  it('rejects build-info mismatch before quitting and launches once on each side of rollback',async()=>{
    const w=world();w.write(w.job.source,{...w.info,bundleVersion:'499'});
    expect((await runInstall(helperDeps(w.job,w.fx))).status).toBe('failed');expect(w.quits()).toBe(0);
    const r=world();const result=await runInstall(helperDeps(r.job,{...r.fx,healthy:async()=>JSON.parse(readFileSync(join(r.job.bundles.target,'Contents/Resources/build-info.json'),'utf8')).version==='1.2.0'}));
    expect(result.status).toBe('rolled-back');expect(r.launches).toEqual(['1.3.0','1.2.0']);
    expect(classifyOutcome(r.job,summarizeResult(result),r.progress(),400,false)).toMatchObject({skip:true});
  });
  it('does not permanently skip if removing the previous bundle fails before any swap',async()=>{
    const w=world();const files={...realFileOps,remove:(path:string)=>{if(path===w.job.bundles.previous)throw new Error('EACCES before first rename');realFileOps.remove(path)}};
    const result=await runInstall(helperDeps(w.job,{...w.fx,files}));
    expect(['failed','rolled-back']).toContain(result.status);
    expect(JSON.parse(readFileSync(join(w.job.bundles.target,'Contents/Resources/build-info.json'),'utf8')).bundleVersion).toBe('400');
    expect(classifyOutcome(w.job,summarizeResult(result),w.progress(),400,false)).toMatchObject({skip:false});
  });
  it('does not skip after helper termination at swap entry before any bundle move',async()=>{
    const w=world();let atSwap:any=null;
    const files={...realFileOps,remove:(path:string)=>{if(path===w.job.bundles.previous){atSwap=JSON.parse(readFileSync(w.job.resultPath,'utf8'));throw new Error('simulated interruption before first move');}realFileOps.remove(path)}};
    await runInstall(helperDeps(w.job,{...w.fx,files}));
    expect(atSwap).toMatchObject({status:'running',stage:'swap',build:{commit:COMMIT}});
    expect(classifyOutcome(w.job,summarizeResult(atSwap),w.progress(),400,false)).toMatchObject({skip:false});
  });
  it('keeps every failed build permanently skipped after 51 failures',()=>{
    let s=EMPTY_STATE;for(let build=500;build<=550;build++)s=withSkipped(s,build,running.build);
    expect(decide(manifest(),running,{...opts,skipped:parseState(JSON.stringify(s)).skipped}).kind).toBe('skipped');
  });
  it('staging must respect an already-held installer lock',async()=>{
    const w=world();const lock=join(w.job.dataDir,'install-app.lock');w.write(w.job.bundles.staged);
    expect(acquireLock(lock,{pid:123,startedAt:'now'},()=>true).ok).toBe(true);
    const original=readFileSync(join(w.job.bundles.staged,'Contents/Resources/build-info.json'),'utf8');
    const job={...w.job,commit:'b'.repeat(40)};
    const work=temp();
    const exec=async(cmd:string,args:readonly string[])=>{
      if(cmd.endsWith('ditto')&&args[0]==='-x')w.write(join(args[3]!, 'Apollo.app'),{...w.info,commit:job.commit});
      else if(cmd.endsWith('plutil'))return {status:0,stdout:args[1]==='CFBundleIdentifier'?'dev.apollo.desktop':'500',stderr:''};
      else if(cmd.endsWith('ditto'))cpSync(args[0]!,args[1]!,{recursive:true});
      return {status:0,stdout:'',stderr:''};
    };
    await verifyFromZip({zip:'fake',workDir:work,job,exec,files:realFileOps});
    expect(lockHolder(lock,()=>true)?.state).toBe('alive');
    expect(readFileSync(join(job.bundles.staged,'Contents/Resources/build-info.json'),'utf8')).toBe(original);
  });
  it('a live installer must never swap a different bundle staged outside its lock',async()=>{
    const w=world();let release!:()=>void;let entered!:()=>void;
    const held=new Promise<void>(r=>release=r);const reached=new Promise<void>(r=>entered=r);let first=true;
    const fx={...w.fx,busy:()=>first?['working']:[],sleep:async(ms:number)=>{if(first){entered();await held;first=false;}await w.fx.sleep(ms)}};
    const install=runInstall(helperDeps(w.job,fx));await reached;
    const work=temp();const replacement={...w.job,commit:'b'.repeat(40)};
    const exec=async(cmd:string,args:readonly string[])=>{
      if(cmd.endsWith('ditto')&&args[0]==='-x')w.write(join(args[3]!, 'Apollo.app'),{...w.info,commit:replacement.commit});
      else if(cmd.endsWith('plutil'))return {status:0,stdout:args[1]==='CFBundleIdentifier'?'dev.apollo.desktop':'500',stderr:''};
      else if(cmd.endsWith('ditto'))cpSync(args[0]!,args[1]!,{recursive:true});
      return {status:0,stdout:'',stderr:''};
    };
    await verifyFromZip({zip:'fake',workDir:work,job:replacement,exec,files:realFileOps});release();
    const result=await install;expect(result.status).toBe('ok');expect(result.build?.commit).toBe(COMMIT);
    expect(JSON.parse(readFileSync(join(w.job.bundles.target,'Contents/Resources/build-info.json'),'utf8')).commit).toBe(result.build?.commit);
  });
  it('wrong bundle id and plist version are rejected during staging',async()=>{
    for(const [id,version] of [['other.bundle','500'],['dev.apollo.desktop','499']]){
      const w=world();const work=temp();const exec=async(cmd:string,args:readonly string[])=>{
        if(cmd.endsWith('ditto')&&args[0]==='-x')w.write(join(args[3]!, 'Apollo.app'));
        return {status:0,stdout:cmd.endsWith('plutil')?(args[1]==='CFBundleIdentifier'?id!:version!):'',stderr:''};
      };
      await expect(verifyFromZip({zip:'fake',workDir:work,job:w.job,exec,files:realFileOps})).rejects.toThrow();expect(w.quits()).toBe(0);
    }
  });
  it('recognizes a live updater helper as lock owner',async()=>{
    const dir=join(temp(),'apollo-update-helper');mkdirSync(dir);const script=join(dir,'sleep.js');writeFileSync(script,'setInterval(()=>{},1000)');
    const child=spawn(process.execPath,[script],{stdio:'ignore'});await once(child,'spawn');
    try {expect(isInstallerPid(child.pid!)).toBe(true);const lock=join(temp(),'lock');acquireLock(lock,{pid:child.pid!,startedAt:'now'},isInstallerPid);expect(acquireLock(lock,{pid:123,startedAt:'later'},isInstallerPid).ok).toBe(false);}finally {child.kill();await once(child,'exit');}
  });
});

describe('state and scheduling probes',()=>{
  it('handles missing, malformed, truncated and huge skipped state',()=>{
    for(const s of [null,'','{','null','[]','{"skipped":[null,3,"x"]}']) expect(()=>parseState(s)).not.toThrow();
    const huge=JSON.stringify({skipped:Array.from({length:100000},(_,build)=>({build,version:'v',at:'',why:''}))});
    // Build 0 is not a build number (manifests start at 1): kept are 1..99999.
    expect(parseState(huge).skipped).toHaveLength(99999);
  });
  it('does not crash on damaged typed fields',()=>{
    expect(()=>parseState('{"skipped":[{"build":500,"version":{"toString":null}}]}')).not.toThrow();
  });
  it('backs off 403 and 429 without a busy loop',async()=>{
    for(const status of [403,429]){
      const result=await fetchLatestRelease(async()=>new Response('',{status,headers:{'x-ratelimit-remaining':'0'}}),1000);
      expect(result.kind).toBe('rate-limited');
      if(result.kind==='rate-limited')expect(nextCheckAt(afterCheck(EMPTY_STATE,result,1000),1000,0,false)).toBe(3601000);
    }
  });
});
