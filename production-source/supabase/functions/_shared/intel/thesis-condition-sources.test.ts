import {assertEquals as eq,assertRejects} from 'jsr:@std/assert@1'
import {CONDITION_SOURCE_REASONS,conditionSourceReason,loadHistoryConditionObservations,loadRegimeConditionObservations,loadThesisConditionSources} from './thesis-condition-sources.ts'
import {conditionSource} from './condition-source.ts'
import {evaluateThesisConditions} from './thesis-conditions.ts'

const NOW=Date.parse('2026-09-15T12:00:00Z'),DAY=86400000,HOUR=3600000
const SUBJECT='market:coinmarketcap:1027',iso=(offset:number)=>new Date(NOW+offset).toISOString()
const series=[100,120,90,60,80,110,130,125,120,118,121,119].map((price,i)=>({t:NOW-(11-i)*DAY,price}))
const quote=(t:number,price:number)=>({timestamp:new Date(t).toISOString(),quote:{USD:{price,volume_24h:1,market_cap:2,timestamp:new Date(t).toISOString()}}})
const payload=(id:string,points:{t:number;price:number}[])=>({data:{[id]:{id:Number(id),name:'Ethereum',symbol:'ETH',quotes:points.map(p=>quote(p.t,p.price))}},status:{error_code:0}})
const cacheRow=(over:Record<string,unknown>={})=>({capability:'history',request_params:{id:'1027',interval:'daily',count:'90'},
 response_json:payload('1027',series),observed_at:iso(0),fetched_at:iso(-10*60000),expires_at:iso(HOUR),...over})
const regimeRow=(over:Record<string,unknown>={})=>({provider:'coinmarketcap',captured_at:iso(-10*60000),source_observed_at:iso(-15*60000),
 fear_greed_value:28,fear_greed_class:'Fear',altcoin_season_index:41,btc_dominance:57.5,...over})

// One fake per query, recording what was actually asked for.
// deno-lint-ignore no-explicit-any
function db(reply:(table:string,calls:any[][])=>{data:any;error?:any}){
 // deno-lint-ignore no-explicit-any
 const calls:any[][]=[]
 return {calls,from(table:string){
  // deno-lint-ignore no-explicit-any
  const own:any[][]=[];calls.push(['from',table])
  // deno-lint-ignore no-explicit-any
  const q:any={limit:async(n:number)=>{own.push(['limit',n]);calls.push(['limit',n]);const r=reply(table,own);return {data:r.data,error:r.error??null}}}
  // deno-lint-ignore no-explicit-any
  for(const method of ['select','eq','gt','gte','lte','order'])q[method]=(...args:any[])=>{own.push([method,...args]);calls.push([method,...args]);return q}
  return q}}
}

Deno.test('the newest captured regime row becomes the reviewed market-regime observations',async()=>{
 const database=db(()=>({data:[regimeRow()]}))
 const load=await loadRegimeConditionObservations(database,NOW)
 eq(load.reason,null)
 eq(load.observations.map(o=>[o.metric,o.unit,o.subject,conditionSource(o)]),[
  ['regime_fear_greed','index','macro:coinmarketcap:regime','regime:coinmarketcap:regime_fear_greed'],
  ['regime_altcoin_season','index','macro:coinmarketcap:regime','regime:coinmarketcap:regime_altcoin_season'],
  ['regime_btc_dominance','%','macro:coinmarketcap:regime','regime:coinmarketcap:regime_btc_dominance'],
 ])
 eq(load.observations[0].observedAt,iso(-15*60000),'the provider observation time, not the capture time')
 eq(database.calls.some(c=>c[0]==='from'&&c[1]==='intel_regime_snapshots'),true)
 eq(database.calls.some(c=>c[0]==='order'&&c[1]==='captured_at'),true)
 eq(database.calls.some(c=>c[0]==='limit'&&c[1]===1),true)
})
Deno.test('an uncaptured, empty or stale regime is a reason, never a substitute reading',async()=>{
 eq(await loadRegimeConditionObservations(db(()=>({data:[]})),NOW),{observations:[],reason:'regime_not_captured'})
 eq(await loadRegimeConditionObservations(db(()=>({data:[{provider:'coinmarketcap',captured_at:iso(-HOUR)}]})),NOW),{observations:[],reason:'regime_not_captured'})
 const stale=await loadRegimeConditionObservations(db(()=>({data:[regimeRow({captured_at:iso(-3*HOUR),source_observed_at:iso(-3*HOUR)})]})),NOW)
 eq(stale.reason,'regime_capture_stale');eq(stale.observations.length,3)
 await assertRejects(()=>loadRegimeConditionObservations(db(()=>({data:null,error:{message:'private detail'}})),NOW),Error,'regime_read_failed')
})
Deno.test('a cached history window is parsed and measured without any provider call',async()=>{
 const database=db(()=>({data:[cacheRow()]}))
 const load=await loadHistoryConditionObservations(database,'1027',NOW)
 eq(load.reason,null)
 eq(load.observations.map(o=>[o.metric,o.unit,o.periodSeconds,conditionSource(o)]),[
  ['realized_volatility_30d','%',2592000,'history:coinmarketcap:realized_volatility_30d'],
  ['drawdown_pct','%',null,'history:coinmarketcap:drawdown_pct'],
  ['days_since_high','days',null,'history:coinmarketcap:days_since_high'],
 ])
 eq(load.observations[1].value,-50,'the reviewed pure measure, not a re-derivation')
 eq(load.observations[0].subject,SUBJECT)
 eq(database.calls.some(c=>c[0]==='from'&&c[1]==='market_data_response_cache'),true)
 eq(database.calls.some(c=>c[0]==='eq'&&c[1]==='capability'&&c[2]==='history'),true)
 eq(database.calls.some(c=>c[0]==='eq'&&c[1]==='request_params->>id'&&c[2]==='1027'),true)
 // The expiry is filtered in the query AND rechecked here: an expired retained
 // response is not a window anybody still holds.
 eq(database.calls.some(c=>c[0]==='gt'&&c[1]==='expires_at'),true)
 eq(await loadHistoryConditionObservations(db(()=>({data:[cacheRow({expires_at:iso(-1000)})]})),'1027',NOW),{observations:[],reason:'history_not_cached'})
})
Deno.test('the daily window is preferred, and another asset’s retained response is not adopted',async()=>{
 const hourly=cacheRow({request_params:{id:'1027',interval:'hourly',count:'168'},fetched_at:iso(-60000),
  response_json:payload('1027',series.map(p=>({t:p.t,price:p.price*2})))})
 const daily=cacheRow({fetched_at:iso(-30*60000)})
 const chosen=await loadHistoryConditionObservations(db(()=>({data:[hourly,daily]})),'1027',NOW)
 eq(chosen.observations[0].universe,'history:daily','a newer intraday window does not displace the daily one')
 const only=await loadHistoryConditionObservations(db(()=>({data:[hourly]})),'1027',NOW)
 eq(only.observations[0].universe,'history:hourly','without a daily window the retained interval is named honestly')
 // A retained response for a different id carries no point for this asset.
 eq(await loadHistoryConditionObservations(db(()=>({data:[cacheRow({response_json:payload('1',series)})]})),'1027',NOW),
  {observations:[],reason:'history_points_unavailable'})
})
Deno.test('no cached window, no listing and an unreadable cache are each a reason of their own',async()=>{
 eq(await loadHistoryConditionObservations(db(()=>({data:[]})),'1027',NOW),{observations:[],reason:'history_not_cached'})
 eq(await loadHistoryConditionObservations(db(()=>({data:[]})),null,NOW),{observations:[],reason:'no_coinmarketcap_listing'})
 eq(await loadHistoryConditionObservations(db(()=>({data:[]})),'0',NOW),{observations:[],reason:'no_coinmarketcap_listing'})
 await assertRejects(()=>loadHistoryConditionObservations(db(()=>({data:null,error:{message:'private detail'}})),'1027',NOW),Error,'history_read_failed')
 for(const reason of ['history_not_cached','no_coinmarketcap_listing','regime_capture_stale'])eq(typeof conditionSourceReason(reason),'string')
 eq(conditionSourceReason('something_else'),null)
 eq(Object.keys(CONDITION_SOURCE_REASONS).length,7)
})
Deno.test('only the sources the activated rules name are read at all',async()=>{
 const database=db((table)=>({data:table==='intel_regime_snapshots'?[regimeRow()]:[cacheRow()]}))
 const none=await loadThesisConditionSources(database,SUBJECT,[{source_metric:'venue:binance:1:ETHUSDT'}],NOW)
 eq(none,{observations:[],reasons:{}});eq(database.calls.length,0,'a thesis without these conditions costs no read')
 const both=await loadThesisConditionSources(database,SUBJECT,[{source_metric:'regime:coinmarketcap:regime_fear_greed'},{source_metric:'history:coinmarketcap:drawdown_pct'}],NOW)
 eq(both.reasons,{});eq(both.observations.length,6)
 eq(database.calls.filter(c=>c[0]==='from').map(c=>c[1]),['intel_regime_snapshots','market_data_response_cache'])
 // A read failure is recorded as a reason, never swallowed into an empty result.
 const broken=await loadThesisConditionSources(db(()=>({data:null,error:{message:'private detail'}})),SUBJECT,[{source_metric:'regime:coinmarketcap:regime_fear_greed'},{source_metric:'history:coinmarketcap:drawdown_pct'}],NOW)
 eq(broken.reasons,{regime:'regime_read_failed',history:'history_read_failed'})
 eq(JSON.stringify(broken).includes('private detail'),false)
 // An asset with no CMC listing cannot have a history window.
 const native=await loadThesisConditionSources(db(()=>({data:[]})),'eip155:8453:0x'+'a'.repeat(40),[{source_metric:'history:coinmarketcap:drawdown_pct'}],NOW)
 eq(native.reasons,{history:'no_coinmarketcap_listing'})
})
Deno.test('a wired regime or history rule evaluates, and an unavailable source stays unavailable with its reason',async()=>{
 const sources=await loadThesisConditionSources(db((table)=>({data:table==='intel_regime_snapshots'?[regimeRow()]:[cacheRow()]})),SUBJECT,
  [{source_metric:'regime:coinmarketcap:regime_fear_greed'},{source_metric:'history:coinmarketcap:drawdown_pct'}],NOW)
 const fear={id:'r1',metric:'regime_fear_greed',comparator:'<=',threshold:30,threshold_unit:'index',time_window:'current',rule_kind:'invalidation',
  description:'Fear',source_metric:'regime:coinmarketcap:regime_fear_greed'}
 const drawdown={id:'r2',metric:'drawdown_pct',comparator:'<=',threshold:-40,threshold_unit:'%',time_window:'current',rule_kind:'invalidation',
  description:'Deep drawdown',source_metric:'history:coinmarketcap:drawdown_pct'}
 // deno-lint-ignore no-explicit-any
 const run=(rules:any[],external:any)=>evaluateThesisConditions(rules,{},SUBJECT,NOW,external)
 eq(run([fear,drawdown],sources).map(c=>c.met),[true,true])
 eq(run([{...fear,threshold:10}],sources)[0].met,false)
 // The market regime keeps its own subject; it is never restated as this asset's.
 eq(run([fear],sources)[0].observation?.subject,'macro:coinmarketcap:regime')
 eq(run([drawdown],sources)[0].observation?.subject,SUBJECT)
 // Unavailable is unavailable WITH the reason, never a firing and never a silent skip.
 const missing=await loadThesisConditionSources(db(()=>({data:[]})),SUBJECT,[fear,drawdown],NOW)
 const unavailable=run([fear,drawdown],missing)
 eq(unavailable.map(c=>c.met),[null,null])
 eq(unavailable.map(c=>c.reason),['regime_not_captured','history_not_cached'])
 eq(unavailable.every(c=>c.observation===null),true)
 // With no external sources at all the engine keeps its own wording.
 eq(run([fear],{})[0].reason,'No fresh observation in the required unit and period')
 // An ordinary metric may not borrow the market's subject to be read as this asset.
 const borrowed=[{...sources.observations[0],metric:'price',unit:'USD',value:1}]
 eq(run([{...fear,metric:'price',threshold_unit:'USD',comparator:'gte',threshold:0,source_metric:null}],{observations:borrowed})[0].met,null)
})
