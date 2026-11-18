import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectIntentVersion, intents } from '../dist/intent-router.js';

const keys=['H1_V2_HUNTPROXY_PROJECT_ID','H1_V2_HUNTPROXY_EXCHANGE_ID','H1_V2_USERNAME'];
async function withConfig(values,run) {
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try { for(const k of keys) { if(values[k]===undefined) delete process.env[k];else process.env[k]=values[k]; } await run(); }
 finally {for(const k of keys) {if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
}

test('auto prefers V2 when configured; explicit V1 remains available',()=>withConfig({H1_V2_HUNTPROXY_PROJECT_ID:'90',H1_V2_HUNTPROXY_EXCHANGE_ID:'269',H1_V2_USERNAME:'test-user'},async()=>{
 assert.equal(selectIntentVersion(),'v2');
 assert.equal(selectIntentVersion('v1'),'v1');
 assert.equal(selectIntentVersion('v2'),'v2');
}));
test('V1 fallback is limited to completely absent V2 configuration',()=>withConfig({},async()=>{
 assert.equal(selectIntentVersion(),'v1');
 process.env.H1_V2_USERNAME='test-user';
 assert.equal(selectIntentVersion(),'v2','partial config must fail on V2, not use a different account');
 await assert.rejects(intents.get('123'),/Set H1_V2/);
}));
test('V1 fallback never silently drops requested V2-only fields',()=>withConfig({},async()=>{
 for(const fields of [{title:'title'},{impact:'impact'},{severity_rating:'none'},{structured_scope_id:'gid'}]) {
  await assert.rejects(intents.create({program_handle:'example',description:'test',...fields}),/fields were not silently dropped/);
  await assert.rejects(intents.update('123',fields),/No draft\/write was sent/);
 }
}));
test('a reviewed V2 timestamp pins submission to V2 even if configuration disappeared',()=>withConfig({},async()=>{
 await assert.rejects(intents.submit('123',true,'review-version'),/Set H1_V2/);
}));
