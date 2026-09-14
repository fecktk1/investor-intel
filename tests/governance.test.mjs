import test from 'node:test'
import assert from 'node:assert/strict'
import { unlinkSync, existsSync } from 'node:fs'
import { createResearchService } from '../server/governance.mjs'
const account=()=>Response.json({data:{plan:{credit_limit_monthly:15000,rate_limit_minute:50},usage:{current_month:{credits_used:826}}}})
const quote=(credits=1)=>Response.json({data:[{id:1027,symbol:'ETH',quote:[{id:2781,price:100,last_updated:'2026-09-09T12:00:00Z'}]}],status:{credit_count:credits,error_code:0}})
test('OHLCV uses one governed daily request, retains provider fields and shares its cache',async()=>{
  let clock=Date.now();const urls=[]
  const s=createResearchService({mode:'live',plan:'startup',key:'synthetic-secret',now:()=>clock,fetcher:async url=>{
    urls.push(url);return url.includes('/key/info')?account():Response.json({data:{1027:{id:1027,quotes:[{time_close:'2026-09-08T23:59:59.999Z',quote:{USD:{open:99,high:110,low:90,close:100,volume:12500}}},{time_close:'2026-09-09T23:59:59.999Z',quote:{USD:{open:100,high:111,low:95,close:108,volume:15000}}}]}},status:{credit_count:1,error_code:0}})
  }})
  try{
    const input={id:1027,count:90,interval:'daily',time_period:'daily'}
    const first=await s.read('ohlcv',input)
    assert.equal(first.state,'fresh');assert.equal(first.data.rows[0].quotes[1].quote.USD.close,108)
    assert.equal(first.provenance.observedAt,'2026-09-09T23:59:59.999Z')
    const url=new URL(urls[1]);assert.equal(url.pathname,'/v2/cryptocurrency/ohlcv/historical');assert.equal(url.searchParams.get('convert'),'USD');assert.equal(url.searchParams.get('time_period'),'daily')
    clock+=3000;assert.deepEqual(await s.read('ohlcv',input),first);assert.equal(urls.length,2)
    assert.equal(s.usage()[0].used,1);assert.equal(s.usage()[0].reserved,0)
    await assert.rejects(()=>s.read('ohlcv',{...input,interval:'4h'}),/history_requires_daily_interval/)
    assert.equal(urls.length,2)
  }finally{s.close()}
})
test('OHLCV fixture has zero network calls and unsupported live access stays unavailable',async()=>{
  let calls=0;const fetcher=async()=>{calls++;throw Error('Unexpected network')}
  const fixture=createResearchService({fetcher}),basic=createResearchService({mode:'live',plan:'basic',key:'synthetic-secret',fetcher})
  try{const result=await fixture.read('ohlcv',{id:1027});assert.equal(result.fixture,true);assert.ok(result.data.rows[0].quotes[0].quote.USD.high>0);assert.equal((await basic.read('ohlcv',{id:1027})).state,'unavailable');assert.equal(calls,0)}finally{fixture.close();basic.close()}
})
test('all three fixture workflows are labeled and make zero calls',async()=>{let calls=0;const s=createResearchService({fetcher:()=>{calls++;throw Error('No fixture network')}});try{for(const name of ['quotes','history','rwaList','rwaInfo','rwaQuotes','issuers','issuer','derivativeExchanges','derivativePairs','liquidations']){const params={quotes:{id:1027},history:{id:1027},rwaInfo:{rwa_id:1},rwaQuotes:{rwa_id:1},issuer:{issuer_id:'a'.repeat(24)},derivativePairs:{crypto_id:1027}}[name]||{};const result=await s.read(name,params);assert.equal(result.fixture,true);assert.ok(result.data.rows.length>0)}assert.equal(calls,0)}finally{s.close()}})
test('request bounds reject unknown, unbounded and symbolic asset identity',async()=>{const s=createResearchService();try{await assert.rejects(()=>s.read('arbitrary'),/unsupported/);await assert.rejects(()=>s.read('rwaList',{limit:101}),/maximum_rows/);await assert.rejects(()=>s.read('quotes',{symbol:'ETH'}),/stable_identifier/);await assert.rejects(()=>s.read('quotes',{id:1,url:'https://evil.invalid'}),/invalid_parameter/)}finally{s.close()}})
test('live calls reserve/reconcile actual credits and cache stable ID requests',async()=>{let calls=0,clock=Date.now();const s=createResearchService({mode:'live',key:'synthetic-secret',now:()=>clock,fetcher:async url=>{calls++;return url.includes('/key/info')?account():quote(2)}});try{const first=await s.read('quotes',{id:1027});assert.equal(first.fixture,false);assert.equal(first.data.rows[0].quote.price,100);assert.equal(s.usage()[0].used,2);clock+=3000;await s.read('quotes',{id:1027});assert.equal(calls,2);assert.equal(s.usage()[0].reserved,0)}finally{s.close()}})
test('account verification failure cannot fetch market data',async()=>{let calls=0;const s=createResearchService({mode:'live',key:'synthetic-secret',fetcher:async()=>{calls++;return Response.json({error:'unavailable'},{status:503})}});try{assert.equal((await s.read('quotes',{id:1027})).state,'unavailable');assert.equal(calls,1);assert.equal(s.usage().length,0)}finally{s.close()}})
test('the credit ceiling survives closing and reopening the local database',async()=>{const filename=new URL(`budget-${crypto.randomUUID()}.sqlite`,import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');let s;const opts={filename,mode:'live',key:'synthetic-secret',creditLimit:1,fetcher:async url=>url.includes('/key/info')?account():quote()};try{s=createResearchService(opts);assert.equal((await s.read('quotes',{id:1027})).state,'fresh');s.close();s=createResearchService(opts);assert.match((await s.read('quotes',{id:1})).reason,/ceiling/);assert.equal(s.usage()[0].used,1)}finally{s?.close();for(const suffix of ['','-wal','-shm'])if(existsSync(filename+suffix))unlinkSync(filename+suffix)}})
