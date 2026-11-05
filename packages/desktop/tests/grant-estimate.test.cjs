const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const sourcePath = path.join(__dirname, '../src/grant-estimate.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = new Module(sourcePath); loaded._compile(compiled, sourcePath);
const { grantCycle, grantUseBy, estimateGrants } = loaded.exports;
const now = new Date('2026-11-05T21:00:00Z');
const key = { id: 'key1', provider: 'anthropic', funding: 'grant', renewal: 'monthly', rollover: false, grantBillingDay: 30, budget: 200 };
const report = (amount, asOf = '2026-11-05T20:00:00Z') => ({ data: [{ cost: { amount, currency: 'USD' } }], data_refreshed_at: asOf, has_more: false });
test('billing cycles clamp short months, preserve day 31, and cross years', () => {
  for (const [today, day, start, end] of [
    ['2026-03-05',31,'2026-02-28','2026-03-31'],
    ['2026-02-28',31,'2026-02-28','2026-03-31'],
    ['2024-03-05',31,'2024-02-29','2024-03-31'],
    ['2026-01-05',14,'2025-12-14','2026-01-14'],
    ['2026-11-14',14,'2026-11-14','2026-12-14'],
    ['2026-04-30',31,'2026-04-30','2026-05-31'],
  ]) {
    const cycle = grantCycle(new Date(today+'T00:00:00Z'),day);
    assert.equal(cycle.start.toISOString().slice(0,10),start);
    assert.equal(cycle.end.toISOString().slice(0,10),end);
  }
});
test('eligible org costs are paginated, cents converted, and shared queries reused', async () => {
  const requests = [];
  const estimates = await estimateGrants([key, {...key,id:'key2'}], async path => {
    const url = new URL(path,'https://api.anthropic.com'); requests.push(url);
    assert.equal(url.searchParams.get('starting_at'),'2026-10-30T00:00:00.000Z');
    assert.equal(url.searchParams.get('ending_at'),now.toISOString());
    assert.deepEqual(url.searchParams.getAll('products[]'),['messages_api','message_batches_api','claude_console','managed_agents_api']);
    return url.searchParams.has('page') ? report('1000.000000') : {...report('1658.000000'),has_more:true,next_page:'second'};
  },now);
  assert.equal(requests.length,2);
  assert.equal(estimates.length,2);
  assert.equal(estimates[0].spent,26.58);
  assert.equal(estimates[0].remaining,173.42);
});
test('missing data, invalid currencies, and network failure never imply a full grant', async () => {
  for (const get of [async()=>report('0',null),async()=>({...report('0'),data:[{cost:{amount:'0',currency:'EUR'}}]}),async()=>{throw Error('unavailable');}]) {
    const [estimate] = await estimateGrants([key],get,now);
    assert.equal(estimate.remaining,null);
  }
});
test('overspend is clamped, late enrollment respected, rollover is not inferred', async () => {
  const [estimate] = await estimateGrants([{...key,grantFirstStart:'2026-11-02T00:00:00Z'}],async path=> {
    assert.equal(new URL(path,'https://api.anthropic.com').searchParams.get('starting_at'),'2026-11-02T00:00:00.000Z');
    return report('25000');
  },now);
  assert.equal(estimate.remaining,0);
  assert.deepEqual(await estimateGrants([{...key,rollover:true}],async()=>{throw Error('must not query');},now),[]);
});
test('repeated pagination cursor and reports predating the cycle are unavailable',async()=>{
  for (const response of [{...report('100'),has_more:true,next_page:'same'},report('100','2026-10-01T00:00:00Z')]) {
    const [estimate] = await estimateGrants([key],async()=>response,now);
    assert.equal(estimate.remaining,null);
  }
});

test('use-by target is six hours before expiry, including year boundaries', () => {
  assert.equal(grantUseBy(new Date('2026-12-01T00:00:00Z')), '2026-11-30T18:00:00.000Z');
  assert.equal(grantUseBy(new Date('2027-01-01T00:00:00Z')), '2026-12-31T18:00:00.000Z');
});
