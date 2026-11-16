import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseDocument, planOperations } from '../lib/core.js';
import { readSource, sourceURL, sshArguments } from '../lib/transport.js';
import { Synchronizer } from '../lib/synchronizer.js';

const profile = { api:'openai-completions', baseURL:'https://example.com/v1', models:[{id:'model',contextWindow:131072}] };
const json = providers => JSON.stringify({version:1,providers});
const options = {enabled:true,url:'https://example.com/models.json',targetEntryId:'llm-pi-ai',intervalSeconds:300,timeoutSeconds:1,maxBytes:1024,mode:'merge',preserveLocalAuth:true};
const row = providers => ({ns:'llm-pi-ai',value:{providers},base:{providers:{}},revision:4});
const directory = [{provider:'openai',declared:false,settingsNs:'llm-pi-ai'}, {provider:'custom',declared:true,settingsNs:'llm-pi-ai'}];

test('rejects non-JSON, executable patch data, invalid root, and prototype properties', () => {
  for (const input of ['!!js foo', '{}','{"version":1,"providers":{"__proto__":{}}}',json({custom:{...profile,apiKey:'secret'}})]) assert.throws(()=>parseDocument(input));
});
test('checks model IDs, capacities, endpoint and credential references', () => {
  for (const extra of [{models:[{id:'a'},{id:'a'}]},{models:[{id:'a',maxTokens:1.5}]},{baseURL:'file:///x'},{apiKeyEnv:'bad ref'},{headers:{Authorization:'secret'}}]) assert.throws(()=>parseDocument(json({custom:{...profile,...extra}})));
  assert.equal(parseDocument('\uFEFF'+json({custom:profile})).providers.custom.api,profile.api);
});
test('preserves local API-key references, transport headers, unrelated providers, and defaults', () => {
  const current={...profile,apiKeyEnv:'LOCAL_KEY',headers:{'x-local':'yes'},defaultMaxTokens:128000};
  const ops=planOperations(parseDocument(json({custom:{...profile,apiKeyEnv:'REMOTE_KEY',displayName:'new'}})),row({custom:current,other:profile}),directory,options);
  assert.equal(ops.length,1); assert.equal(ops[0].value.apiKeyEnv,'LOCAL_KEY');
  assert.equal(ops[0].value.headers['x-local'],'yes'); assert.equal(ops[0].value.defaultMaxTokens,128000);
  assert.deepEqual(planOperations(parseDocument(json({custom:profile})),row({custom:current}),directory,options),[]);
});
test('allows new custom routes but refuses built-in routes and adapter collisions', () => {
  assert.equal(planOperations(parseDocument(json({newRoute:profile})),row({}),directory,options).length,1);
  assert.throws(()=>planOperations(parseDocument(json({openai:profile})),row({}),directory,options),{code:'BUILTIN_PROVIDER'});
  assert.throws(()=>planOperations(parseDocument(json({x:profile})),row({}),[{provider:'x',declared:true,settingsNs:'other'}],options),{code:'PROVIDER_CONFLICT'});
});
test('optional replacement removes only custom routes and guards empty/inherited data', () => {
  const doc=parseDocument(json({newRoute:profile}));
  assert.deepEqual(planOperations(doc,row({custom:profile,openai:profile}),directory,{...options,mode:'replace-custom'}).map(x=>x.op),['set','unset']);
  assert.throws(()=>planOperations(parseDocument(json({})),row({custom:profile}),directory,options),{code:'EMPTY_DOCUMENT'});
  const inherited=row({custom:profile});inherited.base.providers.custom=profile;
  assert.throws(()=>planOperations(doc,inherited,directory,{...options,mode:'replace-custom'}),{code:'INHERITED_PROVIDER'});
});
test('per-device provider overrides retain a local endpoint', () => {
  const ops=planOperations(parseDocument(json({custom:profile})),row({}),directory,{...options,overrides:{custom:{baseURL:'http://127.0.0.1:9999/v1'}}});
  assert.equal(ops[0].value.baseURL,'http://127.0.0.1:9999/v1');
});
test('native Settings optional undefined fields are removed before an in-process write', () => {
  const descriptor=row({custom:{...profile,modelOverrides:undefined,compat:undefined,headers:undefined}});
  const ops=planOperations(parseDocument(json({custom:{...profile,displayName:'updated'}})),descriptor,directory,options);
  assert.equal(Object.hasOwn(ops[0].value,'modelOverrides'),false);
  assert.equal(Object.hasOwn(ops[0].value,'compat'),false);
  assert.deepEqual(JSON.parse(JSON.stringify(ops)),ops);
});

const defaultSchema = {uid:1,refs:{
  1:{type:'object',dict:{providers:2}},2:{type:'dict',inner:3},
  3:{type:'object',dict:{models:4}},4:{type:'array',inner:5},
  5:{type:'object',dict:{compat:6}},
  6:{type:'object',meta:{default:{}},dict:{chatTemplateKwargs:7,chatTemplateArgs:7,supportsStore:8}},
  7:{type:'dict',meta:{default:{}},inner:9},8:{type:'boolean'},9:{type:'any'},
}};
test('new models expand native literal defaults once and do not repeat writes on the next poll', () => {
  const remote={...profile,models:[{id:'new-model'}]};
  const descriptor={...row({}),schema:defaultSchema};
  const first=planOperations(parseDocument(json({custom:remote})),descriptor,directory,options);
  assert.equal(first.length,1);
  assert.deepEqual(first[0].value.models[0].compat,{chatTemplateKwargs:{},chatTemplateArgs:{}});
  const persisted={...row({custom:first[0].value}),schema:defaultSchema};
  assert.deepEqual(planOperations(parseDocument(json({custom:remote})),persisted,directory,options),[]);
});
test('native defaults retain explicit model options and array replacement removes omitted non-default fields', () => {
  const current={...profile,models:[{id:'new-model',contextWindow:1234,compat:{supportsStore:true,chatTemplateArgs:{},chatTemplateKwargs:{}}}]};
  const remote={...profile,models:[{id:'new-model',compat:{supportsStore:false}}]};
  const ops=planOperations(parseDocument(json({custom:remote})),{...row({custom:current}),schema:defaultSchema},directory,options);
  assert.equal(ops[0].value.models[0].compat.supportsStore,false);
  assert.equal(Object.hasOwn(ops[0].value.models[0],'contextWindow'),false);
});
async function server(t, handler) {
  const app=http.createServer(handler);app.listen(0,'127.0.0.1');await new Promise(resolve=>app.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{app.closeAllConnections();app.close(resolve);}));
  return `http://127.0.0.1:${app.address().port}/models.json`;
}
test('HTTP body and ETag cache preserve JSON on 304', async t => {
  const url=await server(t,(req,res)=>{if(req.headers['if-none-match']==='"v1"'){res.writeHead(304);res.end();}else{res.setHeader('ETag','"v1"');res.end(json({custom:profile}));}});
  const a=await readSource({...options,url});const b=await readSource({...options,url},a);
  assert.equal(a.etag,'"v1"');assert.equal(b,a);
});
test('HTTP rejects error statuses, overlarge chunked bodies and deadlines', async t => {
  for (const [handler,code] of [
    [(req,res)=>{res.writeHead(503);res.end('secret body');},'HTTP_FAILED'],
    [(req,res)=>{res.writeHead(200);res.write('a'.repeat(1500));res.end();},'TOO_LARGE'],
    [()=>{},'TIMEOUT'],
  ]) {
    const url=await server(t,handler);
    await assert.rejects(readSource({...options,url,timeoutSeconds:.05}),{code});
  }
});
test('does not leak credentials through a cross-origin redirect', async t => {
  let leaked=false;const destination=await server(t,(req,res)=>{leaked=!!req.headers.authorization;res.end('{}');});
  const url=await server(t,(req,res)=>{res.writeHead(302,{Location:destination});res.end();});
  await assert.rejects(readSource({...options,url},undefined,{Authorization:'Basic secret'}),{code:'REDIRECT'});
  assert.equal(leaked,false);
});
test('WebDAV aliases normalize and inline passwords are refused', () => {
  assert.equal(sourceURL('webdavs://example.com/dav/file').protocol,'https:');
  assert.throws(()=>sourceURL('https://user:password@example.com/file'));
});
test('SSH uses argument arrays, strict host checks and safely quoted POSIX paths', () => {
  const args=sshArguments(new URL("ssh://alice@host:2222/a%27b%20%24(x).json"),10);
  assert.ok(args.includes('-oStrictHostKeyChecking=yes'));
  assert.ok(args.includes('-p'));assert.equal(args.at(-1),"cat -- '/a'\\''b $(x).json'");
  assert.throws(()=>sshArguments(new URL('ssh://host/a%0Ab'),10));
});
test('Windows SSH encodes a fixed read operation without exposing a path to the login shell', () => {
  const args=sshArguments(new URL('ssh://build-host/D:/share/a%27b.json'),20,'powershell');
  const script=Buffer.from(args.at(-1).split(' ').at(-1),'base64').toString('utf16le');
  assert.match(script,/D:\\share\\a''b.json/);assert.match(script,/ReadAllText/);
});
test('SSH stdout is bounded and child output never enters failures', async () => {
  const spawn=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};queueMicrotask(()=>child.stdout.write('x'.repeat(2048)));return child;};
  await assert.rejects(readSource({...options,url:'ssh://host/x'},undefined,{},undefined,{spawn}),{code:'TOO_LARGE'});
});
function harness(read) {
  let descriptor=row({custom:{...profile,apiKeyEnv:'LOCAL_KEY'}});let writes=0;
  const settings={writable:true,describe:()=>[descriptor],mutate:async(ns,ops,revision)=>{assert.equal(revision,descriptor.revision);writes++;for(const op of ops)descriptor.value.providers[op.path[1]]=op.value;descriptor.revision++;}};
  const sync=new Synchronizer({settings,llm:{listConfigurableProviders:()=>directory},getOptions:()=>options,resolveCredential:async()=>undefined,read});
  return {sync,settings,get writes(){return writes;},get descriptor(){return descriptor;}};
}
test('malformed documents and native rejection keep the previous configuration', async () => {
  const a=harness(async()=>({text:'<html>not JSON</html>'}));const before=structuredClone(a.descriptor);
  await a.sync.sync();await a.sync.close();assert.equal(a.writes,0);assert.deepEqual(a.descriptor,before);assert.equal(a.sync.state.lastError.code,'INVALID_DOCUMENT');
  const b=harness(async()=>({text:json({custom:{...profile,displayName:'new'}})}));b.settings.mutate=async()=>{throw new Error('private diagnostic');};
  await b.sync.sync();await b.sync.close();assert.equal(b.sync.state.lastError.code,'REJECTED');assert.doesNotMatch(b.sync.state.lastError.message,/private/);
});
test('successful updates are atomic and unchanged polls do not write again', async () => {
  const a=harness(async()=>({text:json({custom:{...profile,displayName:'new'}})}));
  await a.sync.sync();assert.equal(a.writes,1);await a.sync.sync();assert.equal(a.writes,1);await a.sync.close();
  assert.equal(a.sync.state.lastError,null);assert.ok(a.sync.state.lastSuccess);assert.equal(a.descriptor.value.providers.custom.apiKeyEnv,'LOCAL_KEY');
});
test('overlapping manual/automatic synchronization shares one fetch', async () => {
  let release;let calls=0;const a=harness(async()=>{calls++;await new Promise(resolve=>release=resolve);return {text:json({custom:profile})};});
  const first=a.sync.sync();const second=a.sync.sync();assert.equal(first,second);release();await first;await a.sync.close();assert.equal(calls,1);
});
test('disposal discards a late response and prevents persistence', async () => {
  let release;const a=harness(async()=>{await new Promise(resolve=>release=resolve);return {text:json({custom:{...profile,displayName:'new'}})};});
  const pending=a.sync.sync();const closed=a.sync.close();release();await Promise.all([pending,closed]);assert.equal(a.writes,0);
});
