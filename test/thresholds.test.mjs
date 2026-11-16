import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeThresholds,rewriteThresholds,thresholdFingerprint,ModelThresholds} from '../lib/thresholds.js';
import {parseDocument} from '../lib/core.js';

const route={provider:'personal-a',model:'model-large',thresholdRatio:0.4266};
const doc=rules=>({version:1,providers:{},modelThresholds:rules});
const basic={id:'compaction-basic',name:'@deepseek-ai/dsh-compaction-basic'};
test('threshold documents allow only exact routes and ratios, rejecting duplicate routes and global settings',()=>{
  assert.equal(parseDocument(JSON.stringify(doc([route]))).modelThresholds[0].thresholdRatio,0.4266);
  for(const rules of [[{...route,thresholdRatio:0}],[{...route,thresholdRatio:1}],[{...route,thresholdRatio:'50%'}],[route,route],[{...route,headroomTokens:4}],[{...route,auto:false}]])assert.throws(()=>parseDocument(JSON.stringify(doc(rules))));
  assert.equal(parseDocument(JSON.stringify(doc([{...route,thresholdRatio:null}]))).modelThresholds[0].thresholdRatio,null);
});
test('the authoritative threshold list changes no global setting or other per-model policy fields',()=>{
  const original={thresholdRatio:0.75,auto:false,retainRatio:0.12,headroomTokens:1234,maxTokens:4096,compactionRetries:3,modelPolicies:[
    {...route,thresholdRatio:0.6,headroomTokens:8192,retainTokens:4096},
    {provider:'personal-a',model:'model-old',thresholdRatio:0.372},
    {provider:'other',model:'local',thresholdRatio:0.5,retainTokens:1024},
  ]};
  const next=mergeThresholds(original,[route]);
  assert.equal(next.modelPolicies[0].thresholdRatio,0.4266);
  assert.equal(next.modelPolicies[0].headroomTokens,8192);
  assert.equal(next.modelPolicies[0].retainTokens,4096);
  assert.equal(next.modelPolicies.some(x=>x.model==='model-old'),false);
  assert.deepEqual(next.modelPolicies[1],{provider:'other',model:'local',retainTokens:1024});
  assert.equal(thresholdFingerprint(original),thresholdFingerprint(next));
  assert.deepEqual(mergeThresholds(next,[route]),next);
});
test('empty lists and null ratios inherit unchanged globals while retaining unrelated route parameters',()=>{
  const original={thresholdRatio:0.61,modelPolicies:[{...route,headroomTokens:4096},{provider:'x',model:'x',thresholdRatio:0.5}]};
  assert.deepEqual(mergeThresholds(original,[]),{thresholdRatio:0.61,modelPolicies:[{provider:route.provider,model:route.model,headroomTokens:4096}]});
  assert.deepEqual(mergeThresholds(original,[{...route,thresholdRatio:null}]),mergeThresholds(original,[]));
});
test('equal model IDs on different providers remain independent',()=>{
  const rules=[route,{...route,provider:'another',thresholdRatio:0.7}];
  assert.deepEqual(mergeThresholds({},rules).modelPolicies,rules);
});
test('preset groups preserve persona, expression data, and global compaction settings',()=>{
  const original={id:'test',name:'Test',plugins:[{id:'persona',name:'persona',config:{prefix:'unchanged'}},{id:'agent',group:true,config:[{...basic,config:{thresholdRatio:0.77,retainRatio:0.1}},{id:'tool',config:{script:{__jsExpr:'this remains data'}}}]}]};
  const next=rewriteThresholds({name:'@deepseek-ai/dsh-agent-preset'},original,[route]);
  assert.equal(next.targets.length,1);assert.equal(next.targets[0].next.thresholdRatio,0.77);
  assert.deepEqual(next.next.plugins[0],original.plugins[0]);assert.deepEqual(next.next.plugins[1].config[1],original.plugins[1].config[1]);
  assert.equal(thresholdFingerprint(next.targets[0].config),thresholdFingerprint(next.targets[0].next));
});
function fixture(){
 const entries=[{options:{...basic,config:{thresholdRatio:0.72,modelPolicies:[{...route,thresholdRatio:0.5}]}},fiber:{}}];
 let writes=0;
 const editor={entries:()=>entries,edit:async(entry,change)=>{entry.options.config=structuredClone(change(structuredClone(entry.options.config),{}));writes++;}};
 return {entries,editor,manager:new ModelThresholds(editor),get writes(){return writes;}};
}
test('missing optional document field does not take ownership of compaction settings',async()=>{
 const f=fixture();const plan=f.manager.prepare({version:1,providers:{}});await plan.commit();assert.equal(f.writes,0);assert.equal(plan.configured,false);
});
test('unrelated plugin configurations are not cloned, inspected, or edited',async()=>{
 const f=fixture();f.entries.push({options:{id:'unrelated',name:'another-plugin',config:{callback(){throw new Error('must never execute');}}},fiber:{}});
 const plan=f.manager.prepare(doc([route]));await plan.commit();assert.equal(f.writes,1);
});
test('native editor transaction is idempotent and supports rollback',async()=>{
 const f=fixture();const before=structuredClone(f.entries[0].options.config);
 const first=f.manager.prepare(doc([route]));await first.commit();assert.equal(f.writes,1);
 assert.equal(f.manager.prepare(doc([route])).changes,0);
 await first.rollback();assert.deepEqual(f.entries[0].options.config,before);
});
test('concurrent edits are preserved instead of overwritten on commit or rollback',async()=>{
 const f=fixture();const plan=f.manager.prepare(doc([route]));f.entries[0].options.config.auto=false;
 await assert.rejects(plan.commit(),/concurrently/);assert.equal(f.entries[0].options.config.auto,false);
 const fresh=f.manager.prepare(doc([route]));await fresh.commit();f.entries[0].options.config.auto=true;
 await assert.rejects(fresh.rollback(),/Concurrent/);assert.equal(f.entries[0].options.config.auto,true);
});
test('conflicting local retention is rejected without changing global or route settings',()=>{
 assert.throws(()=>mergeThresholds({retainRatio:0.6},[route]),/retention/);
});
