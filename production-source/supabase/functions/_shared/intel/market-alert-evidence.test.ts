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

// Capture-table readers. One fake per query, so the two attention reads (the
// list's own clock, and this asset's rows) can answer differently.
function captureDb(reply:(table:string,calls:any[][])=>{data:any;error?:any}){
 const calls:any[][]=[]
 return {calls,from(table:string){const own:any[][]=[];calls.push(['from',table])
  const q:any={limit:async(n:number)=>{own.push(['limit',n]);calls.push(['limit',n]);const r=reply(table,own);return {data:r.data,error:r.error??null}},
   maybeSingle:async()=>{const r=reply(table,own);return {data:r.data,error:r.error??null}}}
  for(const method of ['select','eq','gt','gte','lte','order'])q[method]=(...args:any[])=>{own.push([method,...args]);calls.push([method,...args]);return q}
  return q}}
}
const MARKET='market:coinmarketcap:1027'
const liquidationRule=(config:any={})=>({trigger_type:'liquidation_cascade',config:{multiple:3,window:'1h',...config},entity:{canonical_ref_key:MARKET,display_symbol:'ETH'}})
// A week of five-minute captures, thinned to a manageable fixture: 40 baseline
// rows at 100 each, plus the newest capture the rule is evaluated against.
const liquidations=(current:number,options:{age?:number;baseline?:number;rows?:number;window?:'1h'|'4h'}={})=>{
 const age=options.age??5*60000,baseline=options.baseline??100,count=options.rows??40,column=options.window==='4h'?'liq_4h':'liq_1h'
 const rows=[{provider_id:'1027',symbol:'ETH',captured_at:iso(-age),liq_1h:0,liq_4h:0,[column]:current}]
 for(let i=1;i<=count;i++)rows.push({provider_id:'1027',symbol:'ETH',captured_at:iso(-age-i*300000),liq_1h:0,liq_4h:0,[column]:baseline})
 return rows
}
Deno.test('a liquidation cascade is the newest capture against the same window’s own seven-day average',async()=>{
 const database=captureDb(()=>({data:liquidations(450)}))
 const r=await readMarketAlertEvidence(database,liquidationRule(),now)
 eq(r.metric,'liquidation_cascade_ratio');eq(r.unit,'x')
 eq(r.observation.value,4.5);eq(r.observation.unit,'x');eq(r.observation.periodSeconds,3600)
 eq(r.observation.clockBasis,'provider_observation')
 eq(r.observation.observedAt,iso(-300000));eq(r.observation.sampleAt,iso(-300000));eq(r.observation.recordedAt,iso(-300000))
 eq(r.observation.expiresAt,iso(-300000+15*60000))
 // The id carries the capture clock, so the same capture is the same observation.
 eq(r.observation.id,`cmc-liquidations:1027:1h:${iso(-300000)}`)
 eq((r.observation as any).metadata,{current:450,average:100,samples:40,window:'1h'})
 eq(database.calls.some(c=>c[0]==='from'&&c[1]==='intel_liquidation_snapshots'),true)
 eq(database.calls.some(c=>c[0]==='eq'&&c[1]==='provider_id'&&c[2]==='1027'),true)
})
Deno.test('the four-hour window reads its own column, period and id',async()=>{
 const r=await readMarketAlertEvidence(captureDb(()=>({data:liquidations(600,{window:'4h'})})),liquidationRule({window:'4h'}),now)
 eq(r.observation.value,6);eq(r.observation.periodSeconds,14400)
 eq(r.observation.id,`cmc-liquidations:1027:4h:${iso(-300000)}`);eq((r.observation as any).metadata.window,'4h')
})
Deno.test('nothing liquidated is a valid zero, but a week with no scale is not a ratio',async()=>{
 const quiet=await readMarketAlertEvidence(captureDb(()=>({data:liquidations(0)})),liquidationRule(),now)
 eq(quiet.observation.value,0,'a calm window is a recorded zero, not a missing observation')
 await assertRejects(()=>readMarketAlertEvidence(captureDb(()=>({data:liquidations(0,{baseline:0})})),liquidationRule(),now),Error,'metric_coverage_unavailable')
 // An absent measurement in the newest capture is not a quiet hour either.
 const missing=liquidations(0);(missing[0] as any).liq_1h=null
 await assertRejects(()=>readMarketAlertEvidence(captureDb(()=>({data:missing})),liquidationRule(),now),Error,'metric_coverage_unavailable')
})
Deno.test('a stale capture, a thin baseline and an uncovered asset each assert nothing',async()=>{
 await assertRejects(()=>readMarketAlertEvidence(captureDb(()=>({data:liquidations(450,{age:16*60000})})),liquidationRule(),now),Error,'fresh_source_unavailable')
 await assertRejects(()=>readMarketAlertEvidence(captureDb(()=>({data:liquidations(450,{rows:23})})),liquidationRule(),now),Error,'source_coverage_unavailable')
 await assertRejects(()=>readMarketAlertEvidence(captureDb(()=>({data:[]})),liquidationRule(),now),Error,'source_coverage_unavailable')
 await assertRejects(()=>readMarketAlertEvidence(captureDb(()=>({data:null,error:{message:'private detail'}})),liquidationRule(),now),Error,'source_read_failed')
 await assertRejects(()=>readMarketAlertEvidence(captureDb(()=>({data:liquidations(450)})),{...liquidationRule(),entity:{canonical_ref_key:address}},now),Error,'canonical_identity')
})
Deno.test('a cascade rule recorded outside its accepted range is a rule failure, not a missing source',async()=>{
 for(const config of [{multiple:1.2},{multiple:21},{multiple:'many'},{window:'8h'},{window:'1d'}]){
  await assertRejects(()=>readMarketAlertEvidence(captureDb(()=>({data:liquidations(450)})),liquidationRule(config),now),Error,'alert_rule_config_invalid')
 }
 const status=marketAlertFailure(Error('alert_rule_config_invalid'))
 eq(status.status,'evaluation_failed');eq(status.reason.includes('outside the range'),true)
})

const HOUR=3600000
const attentionRule=(config:any={})=>({trigger_type:'attention_entry',config:{list:'trending',hours:3,...config},entity:{canonical_ref_key:MARKET,display_symbol:'ETH'}})
// The first read is the list's own newest capture; the second is this asset's
// rows in that list. `mine` is the offsets, in hours, the asset was present.
const attentionDb=(newestAge:number,mine:number[],options:{duplicate?:boolean}={})=>captureDb((table,calls)=>{
 if(calls.some(c=>c[0]==='eq'&&c[1]==='provider_id')){
  const rows=mine.flatMap(h=>{const row={list:'trending',provider_id:'1027',symbol:'ETH',rank:7,captured_at:iso(-newestAge-h*HOUR)}
   return options.duplicate?[row,{...row,rank:9}]:[row]})
  return {data:rows}
 }
 return {data:newestAge==null?[]:[{list:'trending',captured_at:iso(-newestAge)}]}
})
Deno.test('attention evidence counts consecutive hourly captures ending at the newest capture',async()=>{
 const database=attentionDb(10*60000,[0,1,2,3])
 const r=await readMarketAlertEvidence(database,attentionRule(),now)
 eq(r.metric,'attention_persistence_hours');eq(r.unit,'hours')
 eq(r.observation.value,4);eq(r.observation.unit,'hours');eq(r.observation.periodSeconds,null)
 eq(r.observation.clockBasis,'provider_observation')
 eq(r.observation.observedAt,iso(-10*60000));eq(r.observation.sampleAt,iso(-10*60000))
 eq(r.observation.expiresAt,iso(-10*60000+90*60000))
 // The newest CAPTURE dates the id, so one capture can never fire twice.
 eq(r.observation.id,`cmc-attention:trending:1027:${iso(-10*60000)}`)
 const metadata=(r.observation as any).metadata
 eq(metadata.list,'trending');eq(metadata.requiredHours,3);eq(metadata.rank,7)
 eq(database.calls.some(c=>c[0]==='from'&&c[1]==='intel_attention_snapshots'),true)
 eq(database.calls.some(c=>c[0]==='eq'&&c[1]==='list'&&c[2]==='trending'),true)
})
Deno.test('absence is a recorded zero dated by the list capture, and a gap ends the run',async()=>{
 const absent=await readMarketAlertEvidence(attentionDb(10*60000,[]),attentionRule(),now)
 eq(absent.observation.value,0);eq(absent.observation.observedAt,iso(-10*60000));eq((absent.observation as any).metadata.rank,null)
 // Present an hour ago but not in the newest capture: the run has already ended.
 eq((await readMarketAlertEvidence(attentionDb(10*60000,[1,2,3]),attentionRule(),now)).observation.value,0)
 // A missing capture in the middle is not evidence of continued presence.
 eq((await readMarketAlertEvidence(attentionDb(10*60000,[0,1,3,4]),attentionRule(),now)).observation.value,2)
 // Several time periods of one list are one capture, not several hours.
 eq((await readMarketAlertEvidence(attentionDb(10*60000,[0,1],{duplicate:true}),attentionRule(),now)).observation.value,2)
})
Deno.test('an hourly list that stopped being captured, or was never captured, asserts nothing',async()=>{
 await assertRejects(()=>readMarketAlertEvidence(attentionDb(95*60000,[0,1,2]),attentionRule(),now),Error,'fresh_source_unavailable')
 await assertRejects(()=>readMarketAlertEvidence(captureDb(()=>({data:[]})),attentionRule(),now),Error,'source_coverage_unavailable')
 await assertRejects(()=>readMarketAlertEvidence(captureDb(()=>({data:null,error:{message:'private detail'}})),attentionRule(),now),Error,'source_read_failed')
 await assertRejects(()=>readMarketAlertEvidence(attentionDb(10*60000,[0]),{...attentionRule(),entity:{canonical_ref_key:address}},now),Error,'canonical_identity')
 for(const config of [{list:'whatever'},{list:''},{hours:0},{hours:25},{hours:2.5}]){
  await assertRejects(()=>readMarketAlertEvidence(attentionDb(10*60000,[0]),attentionRule(config),now),Error,'alert_rule_config_invalid')
 }
})
