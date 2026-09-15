import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {readMarketAlertEvidence,marketAlertFailure} from './market-alert-evidence.ts'
const now=Date.parse('2026-09-11T12:00:00Z'),iso=(offset:number)=>new Date(now+offset).toISOString(),address='0x'+'a'.repeat(40),subject=`eip155:8453:${address}`,rule={trigger_type:'liquidity_drop',entity:{canonical_ref_key:subject,display_symbol:'ETH'}}
function db(row:any,error:any=null){const calls:any[]=[];const q:any={maybeSingle:async()=>({data:row,error}),limit:async()=>({data:row,error})};for(const method of ['select','eq','or','gt','gte','lte','order'])q[method]=(...args:any[])=>{calls.push([method,...args]);return q};return {calls,from:(table:string)=>{calls.push(['from',table]);return q}}}
const cached={chain:'base',token_address:address,normalized_response:{liquidity:0,price_change_24h_pct:0},fetched_at:iso(-60000),expires_at:iso(60000)}
Deno.test('exact contract cache preserves zero and distinguishes capture time from unknown provider time',async()=>{const database=db(cached),r=await readMarketAlertEvidence(database,rule,now);eq(r.observation.value,0);eq(r.observation.observedAt,null);eq(r.observation.sampleAt,cached.fetched_at);eq(r.observation.clockBasis,'cache_capture');eq(database.calls.some(c=>c[0]==='eq'&&c[1]==='token_address'&&c[2]===address),true)})
Deno.test('wrong identity, expired, future and missing cached inputs are explicit failures',async()=>{for(const patch of [{chain:'ethereum'},{token_address:'other'},{expires_at:iso(0)},{fetched_at:iso(1)}])await assertRejects(()=>readMarketAlertEvidence(db({...cached,...patch}),rule,now));await assertRejects(()=>readMarketAlertEvidence(db(cached,{message:'private detail'}),rule,now),Error,'source_read_failed');await assertRejects(()=>readMarketAlertEvidence(db(null),rule,now),Error,'coverage_unavailable')})
Deno.test('native CMC price-change evidence uses the original provider timestamp and rolling 24-hour window',async()=>{const database=db([{observation:{id:'cmc-zero',subject:'market:coinmarketcap:1',metric:'price_change',value:0,unit:'%',periodSeconds:86400,provider:'coinmarketcap',sourceRef:'coinmarketcap:/v3/cryptocurrency/listings/latest:{}',observedAt:iso(-120000),recordedAt:iso(-60000),expiresAt:iso(60000),aiAllowed:true}}]);const r=await readMarketAlertEvidence(database,{trigger_type:'price_move',entity:{canonical_ref_key:'native:bitcoin'}},now);eq(r.observation.value,0);eq(r.observation.providerSubject,'market:coinmarketcap:1');eq(r.observation.clockBasis,'provider_observation');eq(r.observation.sampleAt,iso(-120000))})
Deno.test('a ticker or unrelated native hint cannot substitute for a contract',async()=>{await assertRejects(()=>readMarketAlertEvidence(db(cached),{...rule,entity:{canonical_ref_key:'unknown',display_symbol:'ETH',provider_ids:{coinmarketcap:'1027'}}},now),Error,'canonical_identity');await assertRejects(()=>readMarketAlertEvidence(db(cached),{...rule,entity:{canonical_ref_key:'native:bitcoin'}},now),Error,'metric_coverage')})
Deno.test('untrusted database details cannot leak into a recorded status message',()=>{eq(marketAlertFailure(Error('secret database detail')).status,'evaluation_failed');eq(JSON.stringify(marketAlertFailure(Error('secret database detail'))).includes('secret'),false)})
// metadata_notice: presence of a CoinMarketCap listing notice at the DAILY
// metadata clock. The observation id carries the hash, so an unchanged notice
// is the same observation and the database does not fire it again.
const noticeRule={trigger_type:'metadata_notice',entity:{canonical_ref_key:'market:coinmarketcap:1027',display_symbol:'ETH'}}
const hash='b'.repeat(64)
const factsRow=(facts:any,at:number)=>({provider_id:'1027',facts,facts_at:new Date(now+at).toISOString()})
Deno.test('a recorded listing notice is a value of 1 with the metadata clock and a hashed observation id',async()=>{
 const database=db(factsRow({notice:'  Trading suspended pending review.  ',noticeHash:hash},-3600000))
 const r=await readMarketAlertEvidence(database,noticeRule,now)
 eq(r.metric,'metadata_notice');eq(r.unit,'notice');eq(r.observation.value,1);eq(r.observation.unit,'notice');eq(r.observation.periodSeconds,null)
 eq(r.observation.id,`cmc-metadata-notice:1027:${hash}`)
 eq(r.observation.sourceRef,'coinmarketcap:/v2/cryptocurrency/info')
 eq(r.observation.clockBasis,'provider_observation')
 eq(r.observation.observedAt,iso(-3600000));eq(r.observation.sampleAt,iso(-3600000));eq(r.observation.recordedAt,iso(-3600000))
 eq(r.observation.expiresAt,iso(-3600000+48*3600000))
 eq(r.observation.metadata.noticeHash,hash);eq(r.observation.metadata.excerpt,'Trading suspended pending review.')
 eq(database.calls.some(c=>c[0]==='eq'&&c[1]==='provider_id'&&c[2]==='1027'),true)
 eq(database.calls.some(c=>c[0]==='from'&&c[1]==='market_assets'),true)
})
Deno.test('no notice is a value of 0, not a missing observation, and its id differs from a noticed one',async()=>{
 const r=await readMarketAlertEvidence(db(factsRow({notice:null,noticeHash:null},-60000)),noticeRule,now)
 eq(r.observation.value,0);eq(r.observation.id,'cmc-metadata-notice:1027:none');eq(r.observation.metadata.excerpt,null)
 const blank=await readMarketAlertEvidence(db(factsRow({notice:'   ',noticeHash:hash},-60000)),noticeRule,now)
 eq(blank.observation.value,0,'whitespace is not a notice')
})
Deno.test('metadata older than two daily passes, unreadable or uncovered asserts nothing',async()=>{
 await assertRejects(()=>readMarketAlertEvidence(db(factsRow({notice:'x',noticeHash:hash},-48*3600000)),noticeRule,now),Error,'fresh_source_unavailable')
 await assertRejects(()=>readMarketAlertEvidence(db(factsRow({notice:'x',noticeHash:hash},60000)),noticeRule,now),Error,'fresh_source_unavailable')
 await assertRejects(()=>readMarketAlertEvidence(db({provider_id:'1027',facts:{},facts_at:null}),noticeRule,now),Error,'fresh_source_unavailable')
 await assertRejects(()=>readMarketAlertEvidence(db(null),noticeRule,now),Error,'coverage_unavailable')
 await assertRejects(()=>readMarketAlertEvidence(db(factsRow({},-60000),{message:'private detail'}),noticeRule,now),Error,'source_read_failed')
 await assertRejects(()=>readMarketAlertEvidence(db(factsRow({},-60000)),{...noticeRule,entity:{canonical_ref_key:address}},now),Error,'canonical_identity')
})
Deno.test('a malformed recorded hash is not reported as one',async()=>{
 const r=await readMarketAlertEvidence(db(factsRow({notice:'x',noticeHash:'nope'},-60000)),noticeRule,now)
 eq(r.observation.metadata.noticeHash,null);eq(r.observation.id,'cmc-metadata-notice:1027:unhashed')
})
