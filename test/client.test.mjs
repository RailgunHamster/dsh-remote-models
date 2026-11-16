import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {Context,Service} from '@deepseek-ai/cordis';

async function moduleDefinition() {
  let descriptor;
  vm.runInNewContext(await fs.readFile(new URL('../lib/client.js',import.meta.url),'utf8'),{
    window:{__ModuleLoader__:{load(value){descriptor=value;}}},
  });
  // This is a service-wiring test, not a React/DOM renderer. The unmounted
  // factory only captures createElement; no component or hook is executed.
  return descriptor.factory(name=>{assert.equal(name,'react');return Object.freeze({});});
}

async function fixture() {
  const ctx=new Context();
  const registrations=[];
  const settings={describe:async()=>({ok:true,value:{namespaces:[]}}),mutate:async()=>({ok:true})};
  // Match the Client assembly: capabilities come from sibling provider fibers,
  // not root provisions which would grant implicit access to descendants.
  await ctx.plugin({apply(provider){
    provider.provide('remote',{[Service.tracker]:{associate:'remote'}});
    provider.provide('remote.settings',settings);
    provider.provide('slots',{inject(_name,callback){return callback();},register(spec,component){registrations.push({spec,component});return()=>{};}});
    provider.provide('locale',{register(){return()=>{};},bind(){return key=>key;}});
    provider.provide('connection',{rpc:{call(){throw new Error('No transport is used during registration');}}});
  }});
  return {ctx,registrations};
}

test('client registers its settings view through the real Cordis typed namespace guard',async()=>{
  const {ctx,registrations}=await fixture();
  const plugin=await moduleDefinition();
  await ctx.plugin(plugin);
  assert.equal(registrations.length,1);
  assert.equal(registrations[0].spec.name,'settings.models.footer');
  assert.equal(typeof registrations[0].component,'function');
});

test('the real Cordis guard reproduces the screenshot error when the typed dependency is omitted',async()=>{
  const {ctx,registrations}=await fixture();
  const plugin=await moduleDefinition();
  plugin.inject=plugin.inject.filter(key=>key!=='remote.settings');
  await assert.rejects(async()=>{await ctx.plugin(plugin);},/cannot get property "remote.settings" without inject/);
  assert.equal(registrations.length,0);
});
