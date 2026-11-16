import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Synchronizer} from '../lib/synchronizer.js';

test('reconfiguration timers do not inherit a completed HMR transaction',async()=>{
 const transaction=new AsyncLocalStorage();let observed,notify;
 const done=new Promise(resolve=>notify=resolve);
 const sync=new Synchronizer({getOptions:()=>({enabled:true,url:'http://example.invalid',intervalSeconds:300})});
 sync.sync=async()=>{observed=transaction.getStore();notify();};
 try{
  transaction.run(true,()=>sync.reconfigure());
  await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Scheduler did not run')),1000))]);
  assert.equal(observed,undefined);
 }finally{await sync.close();}
});
