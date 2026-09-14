import {assertEquals as eq} from 'jsr:@std/assert'
import {evaluateThesisConditions} from './thesis-conditions.ts'
const now=Date.parse('2026-09-11T15:00:00Z'),rule={id:'rule',metric:'price_change',comparator:'<=',threshold:0,threshold_unit:'%',time_window:'24h',rule_kind:'invalidation',description:'Original rule'}
const observation={id:'obs',subject:'market:coinmarketcap:1',metric:'price_change',unit:'%',periodSeconds:86400,value:0,provider:'coinmarketcap',sourceRef:'shared:one',observedAt:new Date(now-60000).toISOString(),recordedAt:new Date(now-30000).toISOString(),expiresAt:new Date(now+60000).toISOString()}
const evaluate=(r:typeof rule & {source_metric?:string}=rule,observations:any[]=[observation])=>evaluateThesisConditions([r],{market_summary:{retained_observations:observations}},'native:bitcoin',now)[0]
Deno.test('structured condition preserves valid zero, original provider identity and reference-only receipt',()=>{const result=evaluate();eq(result.met,true);eq(result.observation?.subject,'market:coinmarketcap:1');eq(result.observation?.id,'obs');eq('value' in result.observation!,false);eq(result.rule.description,'Original rule')})
Deno.test('structured condition uses the existing strict comparator without price-percent fallback',()=>{eq(evaluate({...rule,comparator:'<'}).met,false);eq(evaluate({...rule,threshold_unit:'USD'}).met,null);eq(evaluate({...rule,time_window:'1h'}).met,null);eq(evaluate({...rule,time_window:'current'}).met,null)})
Deno.test('legacy missing unit or period requires interpretation instead of automatic activation',()=>{eq(evaluate({...rule,threshold_unit:''}).met,null);eq(evaluate({...rule,time_window:''}).met,null)})
Deno.test('wrong asset, stale, future-known, expired and absent expiry evidence cannot trigger',()=>{for(const patch of [{subject:'market:coinmarketcap:1027'},{observedAt:new Date(now-3600000).toISOString()},{recordedAt:new Date(now+1).toISOString()},{expiresAt:new Date(now-1).toISOString()},{expiresAt:null}])eq(evaluate(rule,[{...observation,...patch}]).met,null)})
Deno.test('equal-time conflicting evidence is unknown, not selected opportunistically',()=>{eq(evaluate(rule,[observation,{...observation,id:'other',provider:'other',value:1}]).met,null)})
Deno.test('a venue condition cannot select a newer contract on another venue',()=>{
 const r={...rule,metric:'open_interest',threshold_unit:'USD',time_window:'current',source_metric:'venue:coinmarketcap:A:one'},one={...observation,id:'one',metric:'open_interest',unit:'USD',periodSeconds:null,value:0,metadata:{venueId:'A',contractId:'one',compatibleQuote:true}},other={...one,id:'two',value:100,observedAt:new Date(now-30000).toISOString(),metadata:{venueId:'B',contractId:'two',compatibleQuote:true}}
 eq(evaluate(r,[one,other]).met,true);eq(evaluate({...r,source_metric:'venue:coinmarketcap:missing:one'},[one,other]).met,null)
})
Deno.test('funding conditions require the exact confirmed interval and unit, including valid zero',()=>{
 const r={...rule,metric:'funding_rate',time_window:'28800s',source_metric:'venue:coinmarketcap:A:one'},o={...observation,id:'one',metric:'open_interest',unit:'USD',periodSeconds:null,value:100,metadata:{venueId:'A',contractId:'one',compatibleQuote:true,fundingRateRaw:0,fundingUnit:'ratio',fundingPeriodSeconds:28800}}
 eq(evaluate(r,[o]).met,true);eq(evaluate({...r,time_window:'1h'},[o]).met,null)
 eq(evaluate(r,[{...o,metadata:{...o.metadata,fundingUnit:'unknown'}}]).met,null)
 eq(evaluate({...r,comparator:'gte',threshold:.1},[{...o,metadata:{...o.metadata,fundingRateRaw:.001}}]).met,true)
})
Deno.test('liquidation condition windows and populations remain distinct',()=>{
 const r={...rule,metric:'liquidations_4h',time_window:'4h',threshold_unit:'USD',source_metric:'liquidation:coinmarketcap:asset'},o={...observation,metric:'liquidations_4h',unit:'USD',periodSeconds:14400,metadata:{}}
 eq(evaluate(r,[o]).met,true);eq(evaluate({...r,source_metric:'liquidation:coinmarketcap:123'},[o]).met,null);eq(evaluate({...r,time_window:'24h'},[o]).met,null)
})
Deno.test('best-level depth needs a known-at clock and exact side; zero cannot imply execution',()=>{
 const depth={subject:'market:coingecko:bitcoin',currency:'USD',verifiedQuote:true,venue:'coinbase',pair:'BTC-USD',side:'sell',sourceRef:'depth:original',observedAt:observation.observedAt,recordedAt:observation.recordedAt,expiresAt:observation.expiresAt,levels:[{price:10,quantity:0}]},r={...rule,metric:'depth_notional',time_window:'current',threshold_unit:'USD',source_metric:'depth:coinbase:BTC-USD:sell'}
 const run=(d:any,rr=r)=>evaluateThesisConditions([rr],{liquidity_state:{venue_depth:{quotes:[d]}}},'native:bitcoin',now)[0]
 eq(run(depth).met,true);eq('value' in run(depth).observation!,false);eq(run({...depth,recordedAt:null}).met,null);eq(run(depth,{...r,source_metric:'depth:coinbase:BTC-USD:buy'}).met,null);eq(run({...depth,subject:'market:coingecko:ethereum'}).met,null)
})
Deno.test('legacy CMC funding fields cannot imply confirmed percent units in alerts',()=>{
 const r={...rule,metric:'funding_rate',time_window:'8h',source_metric:'venue:coinmarketcap:A:one'}
 const o={...observation,metric:'open_interest',unit:'USD',periodSeconds:null,value:100,metadata:{venueId:'A',contractId:'one',compatibleQuote:true,fundingRatePercent:0,fundingPeriodSeconds:28800}}
 eq(evaluate(r,[o]).met,null)
 eq(evaluate(r,[{...o,metadata:{...o.metadata,fundingUnit:'percent'}}]).met,true)
})
Deno.test('condition receipts retain the selector from the actual observation without licensed numeric values',()=>{
 const r={...rule,metric:'open_interest',threshold_unit:'USD',time_window:'current',source_metric:'venue:coinmarketcap:270:47150'}
 const o={...observation,metric:'open_interest',unit:'USD',periodSeconds:null,metadata:{venueId:'270',contractId:'47150',compatibleQuote:true}}
 const receipt=evaluate(r,[o]).observation!
 eq(Reflect.get(receipt,'sourceMetric'),'venue:coinmarketcap:270:47150')
 eq('value' in receipt,false);eq('metadata' in receipt,false)
 eq(evaluate({...r,source_metric:'venue:coinmarketcap:270:different'},[o]).observation,null)
})
Deno.test('ordinary price receipts do not invent a venue selector',()=>{
 eq(Reflect.get(evaluate().observation!,'sourceMetric'),null)
})
