/**
 * Controller probes from the first cross-model review (round 1), with electron mocked.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { manifest, comment, makeKey, minisign } from './testing/fixtures.ts';
import { parsePublicKey } from './minisign.ts';
import { expectedAssetUrl } from './github.ts';
const mocks=vi.hoisted(()=>({show:vi.fn(async()=>({response:0})),open:vi.fn(async()=>{}),notice:vi.fn()}));
vi.mock('electron',()=>({dialog:{showMessageBox:mocks.show},shell:{openExternal:mocks.open},Notification:class {static isSupported(){return true}constructor(args:any){mocks.notice(args)}on(){}show(){}}}));
import { Updater } from './controller.ts';
const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
const system=Object.getOwnPropertyDescriptor(process,'getSystemVersion');
afterEach(()=>{Object.defineProperty(process,'platform',platform);if(system)Object.defineProperty(process,'getSystemVersion',system);else delete (process as any).getSystemVersion;vi.unstubAllGlobals();vi.clearAllMocks();vi.useRealTimers()});
function setup(win=false,apiStatus=200,headers:Record<string,string>={}){
 Object.defineProperty(process,'platform',{value:win?'win32':'darwin',configurable:true});Object.defineProperty(process,'getSystemVersion',{value:()=>win?'10.0.22631':'15.0',configurable:true});
 const base=mkdtempSync(join(tmpdir(),'updater-controller-'));mkdirSync(join(base,'res'));mkdirSync(join(base,'data'));
 writeFileSync(join(base,'res/build-info.json'),JSON.stringify({version:'1.2.0',bundleVersion:'400',channel:'release',schemaVersion:20,arch:win?'x64':'arm64'}));
 const m=manifest();const k=makeKey();const data=JSON.stringify(m);const files:any={'apollo-update.json':data,'apollo-update.json.minisig':minisign(Buffer.from(data),k,comment(m))};
 const request=vi.fn(async(url:string)=>url.includes('api.github.com')?(apiStatus===200?Response.json({tag_name:'v1.3.0',html_url:'file:///tmp/untrusted',draft:false,prerelease:false,assets:[...m.assets,...Object.keys(files).map(name=>({name,size:files[name].length}))].map(a=>({...a,browser_download_url:expectedAssetUrl('v1.3.0',a.name)}))}):new Response('',{status:apiStatus,headers})):new Response(files[decodeURIComponent(url.split('/').at(-1)!)]));vi.stubGlobal('fetch',request);
 const updater=new Updater({isPackaged:true,resourcesPath:join(base,'res'),appPath:base,userData:base,dataDir:join(base,'data'),onChange:()=>{},quit:()=>{},busyBots:()=>0,keys:{configured:true,keys:[parsePublicKey(k.publicLine)],notes:[]}});
 return {updater,request,base};
}
it('Windows opens only the known-repository release page even with an injected html_url',async()=>{
 const {updater}=setup(true);await updater.check(true);
 expect(mocks.open).toHaveBeenCalledExactlyOnceWith('https://github.com/LucFauvel/apollo-agent/releases/tag/v1.3.0');
});
it.each([403,429])('background %i is silent and schedules no immediate retries',async(status)=>{
 vi.useFakeTimers();const {updater,request}=setup(false,status,{'x-ratelimit-remaining':'0','retry-after':'3600'});
 await updater.check(false);expect(request).toHaveBeenCalledTimes(1);expect(mocks.show).not.toHaveBeenCalled();expect(mocks.notice).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(3599000);expect(request).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1000);expect(request).toHaveBeenCalledTimes(2);
});
it('background errors and refused manifests remain silent',async()=>{
 const {updater}=setup(false,503);expect((await updater.check(false))?.kind).toBe('error');expect(mocks.show).not.toHaveBeenCalled();expect(mocks.notice).not.toHaveBeenCalled();
});
it('damaged skipped field must not prevent constructing the updater on app startup',()=>{
 const {base}=setup();mkdirSync(join(base,'updates'));writeFileSync(join(base,'updates/state.json'),'{"skipped":[{"build":500,"version":{"toString":null}}]}');
 expect(()=>new Updater({isPackaged:true,resourcesPath:join(base,'res'),appPath:base,userData:base,dataDir:join(base,'data'),onChange:()=>{},quit:()=>{},busyBots:()=>0})).not.toThrow();
});
it('a background signature refusal stays silent',async()=>{
 const {updater,request}=setup();vi.stubGlobal('fetch',async(url:string)=>url.endsWith('/apollo-update.json')?new Response('{bad JSON'):request(url));
 expect((await updater.check(false))?.kind).toBe('refused');expect(mocks.show).not.toHaveBeenCalled();expect(mocks.notice).not.toHaveBeenCalled();
});

it('no hostile state file content keeps the updater from constructing and starting',()=>{
 const {base}=setup();mkdirSync(join(base,'updates'),{recursive:true});
 for(const text of ['{"skipped":{"length":1e9}}','{"__proto__":{"skipped":[1]}}','{"failures":{"valueOf":null},"lastCheckAt":{"toString":null}}','[[[[',`{"skipped":[${'{},'.repeat(500)}1]}`]){
  writeFileSync(join(base,'updates/state.json'),text);
  const u=new Updater({isPackaged:true,resourcesPath:join(base,'res'),appPath:base,userData:base,dataDir:join(base,'data'),onChange:()=>{},quit:()=>{},busyBots:()=>0});
  expect(()=>u.start()).not.toThrow();
 }
});
it('damaged job, result and build-info files never throw out of start',()=>{
 const {base}=setup();mkdirSync(join(base,'updates'),{recursive:true});
 writeFileSync(join(base,'updates/job.json'),'{"format":1,"id":{"toString":null}}');
 writeFileSync(join(base,'res/build-info.json'),'{"version":"1.2.0","schemaVersion":20,"bundleVersion":{"toString":null}}');
 const u=new Updater({isPackaged:true,resourcesPath:join(base,'res'),appPath:base,userData:base,dataDir:join(base,'data'),onChange:()=>{},quit:()=>{},busyBots:()=>0});
 expect(()=>u.start()).not.toThrow();
});
