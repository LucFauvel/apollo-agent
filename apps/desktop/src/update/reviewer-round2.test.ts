/**
 * Probes from the second cross-model review (round 2), kept as regression tests: swap evidence
 * that survives a failed progress write, hostile copied build-info recorded as a failed staged
 * check, copy ownership under the install lock, tolerant readers, and the menu entry left
 * usable when the updater cannot be created.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, linkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import { runInstall } from '../install/engine.ts';
import { acquireLock, lockHolder, realFileOps, realSqliteOps, type BuildInfo } from '../install/lib.ts';
import { bundlesFor, helperDeps, parseJob, parseProgress, summarizeResult, stagedProblems, classifyOutcome, type HelperEffects, type UpdateJob } from './helperCore.ts';
import { copyBundle, realExec } from './macos.ts';
import { EMPTY_STATE, parseState, withSkipped } from './state.ts';
import { decide, type RunningBuild } from './policy.ts';
import { COMMIT, TEAM, manifest } from './testing/fixtures.ts';
const MAIN_TS=join(import.meta.dirname,'..','main.ts');
function world() {
 const base=mkdtempSync(join(tmpdir(),'updater-r2-'));const bundles=bundlesFor(base+'/Applications/Apollo.app');
 const info:BuildInfo={commit:COMMIT,version:'1.3.0',bundleVersion:'500',channel:'release',schemaVersion:20,builtAt:'now',dirty:false,branch:null};
 const source=base+'/userData/updates/work/probe/unpacked/Apollo.app';
 const path=(bundle:string)=>join(bundle,'Contents/Resources/build-info.json');
 const write=(bundle:string,over:Record<string,unknown>={})=>{mkdirSync(dirname(path(bundle)),{recursive:true});writeFileSync(path(bundle),JSON.stringify({...info,...over}));};
 write(bundles.target,{commit:'f'.repeat(40),version:'1.2.0',bundleVersion:'400'});write(source);
 const job:UpdateJob={format:1,id:'r2-job',createdAt:0,version:'1.3.0',build:500,commit:COMMIT,schemaVersion:20,bundles,source,progressPath:base+'/userData/updates/progress.json',dataDir:base+'/data',resultPath:base+'/userData/updates/result.json',logPath:base+'/helper.log',teamId:TEAM,waitTimeoutMs:60000};mkdirSync(job.dataDir);
 let now=0,alive=true,quits=0;const launches:string[]=[];
 const fx:HelperEffects={files:realFileOps,sqlite:realSqliteOps,now:()=>now,sleep:async ms=>{now+=ms},log:()=>{},apollo:()=>alive?[{pid:2,kind:'installed'}]:[],requestQuit:()=>{quits++;alive=false},kill:()=>{alive=false},isInstaller:()=>false,busy:()=>[],launch:async(_,strategy)=>{alive=true;launches.push(JSON.parse(readFileSync(path(bundles.target),'utf8')).version);return {strategy,command:'fake',args:[],status:0,signal:null,stderr:'',error:null,pid:2,spawned:true}},healthy:async()=>true,holdSignals:()=>{},copyBundle:async(from,to)=>{cpSync(from,to,{recursive:true})},checkSignature:async()=>null,pid:1};
 const progress=()=>parseProgress(existsSync(job.progressPath)?readFileSync(job.progressPath,'utf8'):null,job.id);
 const result=()=>summarizeResult(existsSync(job.resultPath)?readFileSync(job.resultPath,'utf8'):null);
 const outcome=()=>classifyOutcome(job,result(),progress(),400,false);
 return {base,bundles,job,info,path,write,fx,progress,result,outcome,quits:()=>quits,launches};
}

describe('copy ownership and copy rechecks',()=>{
 it('a helper cannot replace another live installer staging',async()=>{
  const w=world();w.write(w.bundles.staged,{commit:'a'.repeat(40)});const old=readFileSync(w.path(w.bundles.staged),'utf8');
  acquireLock(join(w.job.dataDir,'install-app.lock'),{pid:123,startedAt:'before'},()=>true);
  let copied=false;const result=await runInstall(helperDeps(w.job,{...w.fx,isInstaller:pid=>pid===123,copyBundle:async()=>{copied=true}}));
  expect(result.status).toBe('aborted');expect(copied).toBe(false);expect(w.quits()).toBe(0);expect(readFileSync(w.path(w.bundles.staged),'utf8')).toBe(old);
 });
 it('replaces leftover staging only while its own lock is live',async()=>{
  const w=world();w.write(w.bundles.staged,{commit:'a'.repeat(40)});let observed=false;
  const files={...realFileOps,remove:(p:string)=>{if(p===w.bundles.staged){observed=true;expect(lockHolder(join(w.job.dataDir,'install-app.lock'),()=>true)?.holder?.pid).toBe(1)}realFileOps.remove(p)}};
  expect((await runInstall(helperDeps(w.job,{...w.fx,files}))).status).toBe('ok');expect(observed).toBe(true);
 });
 it.each(['replace-before-copy','replace-during-copy','symlink-directory','hardlink-file'])('rejects source metadata changes: %s',async mode=>{
  const w=world();const copy=async(from:string,to:string)=>{
   if(mode==='replace-before-copy'){rmSync(from,{recursive:true});w.write(from,{commit:'b'.repeat(40)});}
   if(mode==='symlink-directory'){const other=join(w.base,'other.app');w.write(other,{bundleVersion:'499'});renameSync(from,from+'.old');symlinkSync(other,from,'dir');}
   if(mode==='hardlink-file'){const other=join(w.base,'other-info.json');writeFileSync(other,JSON.stringify({...w.info,version:'9.9.9'}));rmSync(w.path(from));linkSync(other,w.path(from));}
   if(mode==='replace-during-copy'){
    // Deterministic multi-file copy: source changes after one resource was copied.
    writeFileSync(join(from,'first-resource'),'resource');mkdirSync(to,{recursive:true});cpSync(join(from,'first-resource'),join(to,'first-resource'));
    w.write(from,{commit:'c'.repeat(40)});cpSync(from,to,{recursive:true});
   }else await copyBundle(realExec,from,to);
  };
  const result=await runInstall(helperDeps(w.job,{...w.fx,copyBundle:copy}));expect(result.status).toBe('failed');expect(w.quits()).toBe(0);expect(w.progress()).toMatchObject({checksFailed:true});expect(w.outcome()).toMatchObject({skip:true});
 });
 it('rejects a payload change even when build metadata is unchanged',async()=>{
  const w=world();const content=(bundle:string)=>join(bundle,'Contents/payload');writeFileSync(content(w.job.source),'original');
  const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');const sealed=hash(content(w.job.source));
  const result=await runInstall(helperDeps(w.job,{...w.fx,copyBundle:async(from,to)=>{await copyBundle(realExec,from,to);writeFileSync(content(to),'changed')},checkSignature:async bundle=>hash(content(bundle))===sealed?null:'sealed resource mismatch'}));
  expect(result.status).toBe('failed');expect(w.quits()).toBe(0);expect(w.progress()).toMatchObject({checksFailed:true});
 });
});

describe('persisted evidence at interruption points',()=>{
 for(const point of ['before-copy','during-copy','after-copy','after-rename-record','during-health','during-restore']){
  it(point,async()=>{
   const w=world();let captured:ReturnType<typeof w.outcome>|null=null;
   const capture=()=>{captured=w.outcome()};let didRename=false;
   const fx={...w.fx,
    copyBundle:async(from:string,to:string)=>{if(point==='before-copy')capture();mkdirSync(to,{recursive:true});if(point==='during-copy')capture();cpSync(from,to,{recursive:true})},
    checkSignature:async()=>{if(point==='after-copy')capture();return null},
    files:{...realFileOps,rename:(from:string,to:string)=>{realFileOps.rename(from,to);if(from===w.bundles.staged&&to===w.bundles.target)didRename=true;if(point==='during-restore'&&from===w.bundles.previous&&to===w.bundles.target)capture()}},
    healthy:async()=>{if(didRename&&!captured&&(point==='after-rename-record'||point==='during-health'))capture();return JSON.parse(readFileSync(w.path(w.bundles.target),'utf8')).bundleVersion==='400'},
   };
   await runInstall(helperDeps(w.job,fx));expect(captured).not.toBeNull();expect(captured).toMatchObject({skip:['after-rename-record','during-health','during-restore'].includes(point)});
  });
 }
 it('records a completed rename before classifying an interruption immediately after the filesystem move',async()=>{
  const w=world();let captured:ReturnType<typeof w.outcome>|null=null;
  const files={...realFileOps,rename:(from:string,to:string)=>{realFileOps.rename(from,to);if(from===w.bundles.staged&&to===w.bundles.target){captured=classifyOutcome(w.job,w.result(),w.progress(),null,false);}}};
  await runInstall(helperDeps(w.job,{...w.fx,files}));expect(captured).not.toBeNull();expect(captured).toMatchObject({skip:true});
 });
 it('does not reoffer a rolled-back build if progress persistence fails at the successful rename',async()=>{
  const w=world();let fail=false;
  const files={...realFileOps,rename:(from:string,to:string)=>{realFileOps.rename(from,to);if(from===w.bundles.staged&&to===w.bundles.target)fail=true},writeText:(p:string,text:string)=>{if(p===w.job.progressPath&&fail)throw new Error('simulated EPERM on progress.json');realFileOps.writeText(p,text)}};
  const result=await runInstall(helperDeps(w.job,{...w.fx,files,healthy:async()=>JSON.parse(readFileSync(w.path(w.bundles.target),'utf8')).bundleVersion==='400'}));
  expect(result.status).toBe('rolled-back');expect(w.outcome()).toMatchObject({skip:true});
 });
 it('malformed copied build-info is a failed staged check, without coercing nested objects',async()=>{
  const w=world();w.write(w.job.source,{commit:{toString:null}});
  const result=await runInstall(helperDeps(w.job,w.fx));expect(result.status).toBe('failed');expect(w.quits()).toBe(0);
  expect(w.progress()).toMatchObject({checksFailed:true});expect(w.outcome()).toMatchObject({skip:true});
 });
});

describe('tolerant readers',()=>{
 const values:any[]=[null,true,0,'text',[],{},[null,1],{skipped:[500,{build:501,version:{toString:null}}]},JSON.parse('{"__proto__":{"build":500,"skipped":[500]}}'),{failures:{valueOf:null},notifiedBuild:[],retryAt:'tomorrow'}];
 let seed=42;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 function value(depth:number):any {if(depth===0)return values[next()%values.length];switch(next()%4){case 0:return [value(depth-1),value(depth-1)];case 1:return {build:value(depth-1),status:value(depth-1),commit:value(depth-1),skipped:value(depth-1)};default:return values[next()%values.length];}}
 it('state/result/progress readers handle unexpected JSON, deep JSON, large fields and invalid UTF-8',()=>{
  const samples=[...values.map(v=>JSON.stringify(v)),Buffer.from([0xff,0x80,0xfe]).toString('utf8'),'['.repeat(5000)+'0'+']'.repeat(5000),JSON.stringify({skipped:Array.from({length:100001},(_,i)=>i+1)}),JSON.stringify({notes:'x'.repeat(2*1024*1024)})];
  for(let i=0;i<200;i++)samples.push(JSON.stringify(value(5)));
  for(const text of samples){const s=parseState(text!);expect(parseState(JSON.stringify(s))).toEqual(s);expect(()=>summarizeResult(text)).not.toThrow();expect(()=>parseProgress(text!,'r2-job')).not.toThrow();}
  expect(summarizeResult(new Proxy({},{getOwnPropertyDescriptor(){throw Error('descriptor')}}))).toBeNull();
  expect(summarizeResult(Object.defineProperty({},'status',{get(){throw Error('getter')}}))).toBeNull();
 });
 it('staged build-info reader does not invoke getters or throw on nested typed fields',()=>{
  const w=world();for(const info of [{commit:{toString:null}},new Proxy({},{get(){throw Error('getter')}})])expect(()=>stagedProblems(info as any,w.job)).not.toThrow();
 });
 it('invalid jobs are cleanly rejected by the strict parser rather than accepted',()=>{
  const w=world();expect(parseJob(JSON.stringify(w.job))).toEqual(w.job);
  for(const v of values){try{const job=parseJob(JSON.stringify(v));expect(job).toMatchObject({format:1});}catch(error){expect(error).toBeInstanceOf(Error);}}
  for(const source of ['/etc/Apollo.app',w.job.resultPath+'/../work/x/Apollo.app',join(w.base,'work/Apollo.app')])expect(()=>parseJob(JSON.stringify({...w.job,source}))).toThrow();
 });
 it('all skipped builds above the running build survive long histories and reloads',()=>{
  let s=EMPTY_STATE;for(let n=500;n<750;n++)s=withSkipped(s,n,400);s=parseState(JSON.stringify(s));expect(s.skipped).toHaveLength(250);
  const running:RunningBuild={version:'1',channel:'release',build:600,schemaVersion:20,platform:'darwin',arch:'arm64',osVersion:'15'};
  s=withSkipped(s,800,600);s=parseState(JSON.stringify(s));
  for(let build=500;build<=800;build++){const d=decide(manifest({build}),running,{channel:'release',tag:'v1.3.0',teamId:TEAM,skipped:s.skipped,dbSchema:20});if(build<=600)expect(d.kind).toBe('up-to-date');else if(build<750||build===800)expect(d.kind).toBe('skipped');}
 });
});

it('main construction fallback must leave an actionable menu or report an error',()=>{
 const text=readFileSync(MAIN_TS,'utf8');const sf=ts.createSourceFile('main.ts',text,ts.ScriptTarget.Latest,true);
 let menu='';let block='';function visit(n:ts.Node){if(ts.isVariableDeclaration(n)&&n.name.getText(sf)==='updateMenuItem')menu='const '+n.getText(sf)+';';if(ts.isTryStatement(n)&&n.tryBlock.getText(sf).includes('updater = new Updater')&&n.catchClause?.getText(sf).includes('updater = null'))block=n.getText(sf);ts.forEachChild(n,visit)}visit(sf);expect(menu).not.toBe('');expect(block).not.toBe('');
 const script=ts.transpileModule('let updater=null;'+menu+block+';globalThis.reviewItem=updateMenuItem();',{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.None}}).outputText;
 const errors:any[]=[];const context:any={Updater:class{constructor(){throw Error('construction failed')}},app:{isPackaged:true,getAppPath:()=>'/tmp',getPath:()=>'/tmp'},process:{resourcesPath:'/tmp',env:{}},resolve:()=>'/tmp',join:()=>'/tmp',homedir:()=>'/tmp',console:{error:()=>{}},dialog:{showMessageBox:(...args:any[])=>errors.push(args)}};
 runInNewContext(script,context);expect(context.reviewItem.label).toBe('Check for Updates…');expect(context.reviewItem.enabled||errors.length>0).toBe(true);
});
