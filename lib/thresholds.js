import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';

const BASIC='@deepseek-ai/dsh-compaction-basic';
const PRESET='@deepseek-ai/dsh-agent-preset';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const key=row=>row.provider+'\u0000'+row.model;
const basic=row=>row.name===BASIC||(!row.name&&row.id==='compaction-basic');

/** The shared list is authoritative for thresholdRatio only, never other policy fields. */
export function mergeThresholds(config,rules){
  if(config.modelPolicies!==undefined&&!Array.isArray(config.modelPolicies))throw new Error('Dynamic modelPolicies cannot be synchronized');
  const desired=new Map(rules.map(row=>[key(row),row]));
  const policies=[];const seen=new Set();
  for(const policy of config.modelPolicies??[]){
    if(!plain(policy)||typeof policy.provider!=='string'||typeof policy.model!=='string')throw new Error('Invalid local model policy');
    const id=key(policy);if(seen.has(id))throw new Error('Duplicate local model policy');seen.add(id);
    const next={...policy};delete next.thresholdRatio;
    const shared=desired.get(id);if(shared?.thresholdRatio!==null&&shared!==undefined)next.thresholdRatio=shared.thresholdRatio;
    if(Object.keys(next).some(field=>field!=='provider'&&field!=='model'))policies.push(next);
  }
  for(const rule of rules)if(!seen.has(key(rule))&&rule.thresholdRatio!==null)policies.push({...rule});
  const result={...config};
  // Absence and [] both mean no per-model overrides. Preserve absence for idempotence.
  if(policies.length||Object.hasOwn(config,'modelPolicies'))result.modelPolicies=policies;
  for(const policy of policies){
    const threshold=policy.thresholdRatio??result.thresholdRatio??0.8;
    const retained=policy.retainRatio??(policy.retainTokens===undefined?(result.retainTokens===undefined?(result.retainRatio??0.16):undefined):undefined);
    if(retained!==undefined&&retained>=threshold)throw new Error('A shared threshold conflicts with local retention settings');
  }
  return result;
}

function mapRows(rows,rules,targets,path=[]){
  if(!Array.isArray(rows))throw new Error('Dynamic preset plugin lists cannot be synchronized');
  return rows.map((row,index)=>{
    if(!plain(row))return row;
    const current=[...path,index];
    if(basic(row)){
      const config=row.config??{};if(!plain(config)||Object.hasOwn(config,'__jsExpr'))throw new Error('Dynamic compaction config cannot be synchronized');
      const next=rules===undefined?config:mergeThresholds(config,rules);
      targets.push({path:current,config,next});
      return isDeepStrictEqual(config,next)?row:{...row,config:next};
    }
    if(row.group&&Array.isArray(row.config))return {...row,config:mapRows(row.config,rules,targets,[...current,'config'])};
    if(row.name===PRESET&&Array.isArray(row.config?.plugins))return {...row,config:{...row.config,plugins:mapRows(row.config.plugins,rules,targets,[...current,'config','plugins'])}};
    return row;
  });
}

export function rewriteThresholds(row,config,rules){
  const targets=[];let next=config;
  if(basic(row)){
    if(!plain(config)||Object.hasOwn(config,'__jsExpr'))throw new Error('Dynamic compaction config cannot be synchronized');
    next=rules===undefined?config:mergeThresholds(config,rules);targets.push({path:[],config,next});
  }else if(row.name===PRESET){
    if(!plain(config)||!Array.isArray(config.plugins))return {next,targets};
    next={...config,plugins:mapRows(config.plugins,rules,targets,['plugins'])};
  }else if(row.group&&Array.isArray(config))next=mapRows(config,rules,targets);
  return {next,targets};
}

function stripped(config){
  const value={...config};
  if(Array.isArray(value.modelPolicies)){
    value.modelPolicies=value.modelPolicies.map(row=>{const copy={...row};delete copy.thresholdRatio;return copy;})
      .filter(row=>Object.keys(row).some(field=>field!=='provider'&&field!=='model'));
    if(!value.modelPolicies.length)delete value.modelPolicies;
  }
  return value;
}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(plain(value))return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])]));
  return value;
}
export function thresholdFingerprint(config){return createHash('sha256').update(JSON.stringify(canonical(stripped(config)))).digest('hex');}

/** Use the supported profile editor; no patch-file writes and no service monkeypatching. */
export class ModelThresholds {
  constructor(editor){this.editor=editor;}
  inspect(){
    const result=[];
    for(const entry of this.editor.entries()){
      const config=entry.options.config??{};
      const {targets}=rewriteThresholds(entry.options,config,undefined);
      for(const target of targets)result.push({entryId:entry.options.id,path:target.path,
        active:!!entry.fiber,globalFingerprint:thresholdFingerprint(target.config),
        globals:Object.fromEntries(['thresholdRatio','auto','headroomTokens','retainRatio','retainTokens','maxTokens','compactionRetries','maxOverflowRetries'].filter(key=>target.config[key]!==undefined).map(key=>[key,target.config[key]])),
        modelThresholds:(target.config.modelPolicies??[]).filter(row=>row.thresholdRatio!==undefined).map(({provider,model,thresholdRatio})=>({provider,model,thresholdRatio}))});
    }
    return result;
  }
  prepare(doc){
    const configured=doc.modelThresholds!==undefined;
    const plans=[];let targetCount=0;const skipped=[];
    if(configured)for(const entry of this.editor.entries()){
      if(!basic(entry.options)&&entry.options.name!==PRESET&&!entry.options.group)continue;
      const before=structuredClone(entry.options.config??{});
      const {next,targets}=rewriteThresholds(entry.options,before,doc.modelThresholds);
      targetCount+=targets.length;
      if(!targets.length||isDeepStrictEqual(before,next))continue;
      if(!entry.fiber){skipped.push(entry.options.id);continue;}
      for(const target of targets)if(thresholdFingerprint(target.config)!==thresholdFingerprint(target.next))throw new Error('A threshold update would change unrelated compaction settings');
      plans.push({id:entry.options.id,before,next});
    }
    const applied=[];
    return {configured,rules:doc.modelThresholds?.length??0,targetCount,changes:plans.length,skipped,
      commit:async signal=>{
        for(const plan of plans){
          signal?.throwIfAborted();
          const entry=this.editor.entries().find(row=>row.options.id===plan.id);
          if(!entry)throw new Error('Compaction configuration changed during synchronization');
          await this.editor.edit(entry,current=>{
            if(!isDeepStrictEqual(current,plan.before))throw new Error('Compaction configuration changed concurrently');
            return plan.next;
          });
          applied.push(plan);
        }
      },
      rollback:async()=>{
        for(const plan of applied.reverse()){
          const entry=this.editor.entries().find(row=>row.options.id===plan.id);
          if(!entry)throw new Error('Compaction rollback target is unavailable');
          await this.editor.edit(entry,current=>{
            if(!isDeepStrictEqual(current,plan.next))throw new Error('Concurrent compaction changes prevent rollback');
            return plan.before;
          });
        }
      },
    };
  }
}
