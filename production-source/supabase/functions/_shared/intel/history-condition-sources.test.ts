import {assertEquals as eq} from 'jsr:@std/assert@1'
import {conditionMaxAgeSeconds,conditionPeriod,conditionSource,matchesConditionSource} from './condition-source.ts'
import {historyConditionObservations,regimeConditionObservations,venueConditionChoices} from './venue-condition-sources.ts'
import {evaluateThesisConditions} from './thesis-conditions.ts'
import {distanceFromHigh,maxDrawdown,realizedVolatility,timeUnderWaterDays} from './risk-metrics.ts'
import type {AssetHistory} from './asset-history.ts'

const NOW=Date.parse('2026-09-14T12:00:00Z'),DAY=86400000,SUBJECT='market:coinmarketcap:1027'
const series=[100,120,90,60,80,110,130,125,120,118,121,119].map((price,i)=>({t:NOW-(11-i)*DAY,price,volume:null,marketCap:null}))
const history:AssetHistory={points:series,interval:'daily',source:'coinmarketcap',observedAt:new Date(NOW).toISOString(),
 fetchedAt:new Date(NOW).toISOString(),state:'fresh',reason:null,credits:1}
const metrics={volatility30d:realizedVolatility(series),maxDrawdown:maxDrawdown(series),distanceFromHigh:distanceFromHigh(series,NOW),timeUnderWaterDays:timeUnderWaterDays(series)}
const regimeRow={provider:'coinmarketcap',captured_at:new Date(NOW-600000).toISOString(),source_observed_at:new Date(NOW-900000).toISOString(),
 fear_greed_value:28,fear_greed_class:'Fear',altcoin_season_index:41,btc_dominance:57.5,eth_dominance:12,total_market_cap:3.1e12}

Deno.test('derived history and regime metrics carry their own scoped source labels',()=>{
 const projected=historyConditionObservations(history,metrics,SUBJECT,NOW)
 eq(projected.map(o=>[o.metric,o.unit,o.periodSeconds,conditionSource(o)]),[
  ['realized_volatility_30d','%',2592000,'history:coinmarketcap:realized_volatility_30d'],
  ['drawdown_pct','%',null,'history:coinmarketcap:drawdown_pct'],
  ['days_since_high','days',null,'history:coinmarketcap:days_since_high'],
 ])
 eq(regimeConditionObservations(regimeRow,NOW).map(o=>[o.metric,o.unit,o.subject,conditionSource(o)]),[
  ['regime_fear_greed','index','macro:coinmarketcap:regime','regime:coinmarketcap:regime_fear_greed'],
  ['regime_altcoin_season','index','macro:coinmarketcap:regime','regime:coinmarketcap:regime_altcoin_season'],
  ['regime_btc_dominance','%','macro:coinmarketcap:regime','regime:coinmarketcap:regime_btc_dominance'],
 ])
 // The scope is the identity, not the metric name: another subject or provider is not this source.
 const one=projected[1]
 eq(conditionSource({...one,subject:'market:coingecko:ethereum'}),null)
 eq(conditionSource({...one,subject:'macro:coinmarketcap:regime'}),null)
 eq(conditionSource({...one,provider:'coingecko'}),null)
 eq(conditionSource({...regimeConditionObservations(regimeRow,NOW)[0],subject:SUBJECT}),null)
})
Deno.test('a derived condition must match the unit, window and sign of the measure it names',()=>{
 const [volatility,drawdown,daysSince]=historyConditionObservations(history,metrics,SUBJECT,NOW)
 eq(matchesConditionSource(volatility,'history:coinmarketcap:realized_volatility_30d','realized_volatility_30d'),true)
 eq(matchesConditionSource({...volatility,unit:'USD'},'history:coinmarketcap:realized_volatility_30d','realized_volatility_30d'),false)
 eq(matchesConditionSource({...volatility,periodSeconds:86400},'history:coinmarketcap:realized_volatility_30d','realized_volatility_30d'),false)
 eq(matchesConditionSource({...volatility,value:-1},'history:coinmarketcap:realized_volatility_30d','realized_volatility_30d'),false)
 eq(matchesConditionSource(drawdown,'history:coinmarketcap:drawdown_pct','drawdown_pct'),true)
 eq(matchesConditionSource({...drawdown,value:5},'history:coinmarketcap:drawdown_pct','drawdown_pct'),false)
 eq(matchesConditionSource(drawdown,'history:coinmarketcap:days_since_high','drawdown_pct'),false)
 eq(matchesConditionSource(daysSince,'history:coinmarketcap:days_since_high','days_since_high'),true)
 eq(matchesConditionSource({...daysSince,unit:'%'},'history:coinmarketcap:days_since_high','days_since_high'),false)
 const [fearGreed]=regimeConditionObservations(regimeRow,NOW)
 eq(matchesConditionSource(fearGreed,'regime:coinmarketcap:regime_fear_greed','regime_fear_greed'),true)
 eq(matchesConditionSource({...fearGreed,periodSeconds:86400},'regime:coinmarketcap:regime_fear_greed','regime_fear_greed'),false)
 eq(matchesConditionSource({...fearGreed,unit:'%'},'regime:coinmarketcap:regime_fear_greed','regime_fear_greed'),false)
 // An ordinary metric cannot borrow a derived label to look scoped.
 eq(matchesConditionSource({metric:'price',unit:'USD'},'history:coinmarketcap:drawdown_pct','price'),false)
 eq(matchesConditionSource({metric:'price',unit:'USD'},'regime:coinmarketcap:regime_fear_greed','price'),false)
})
Deno.test('derived measures are selectable conditions with their own labels',()=>{
 const choices=venueConditionChoices([...historyConditionObservations(history,metrics,SUBJECT,NOW),...regimeConditionObservations(regimeRow,NOW)],null,NOW)
 eq(choices.map(c=>c.label),[
  'CMC · 30-day realised volatility (% / 2592000s)',
  'CMC · Altcoin season index (index)',
  'CMC · BTC dominance (%)',
  'CMC · Days since high (days)',
  'CMC · Drawdown from high (%)',
  'CMC · Fear and greed (index)',
 ])
 eq(choices.map(c=>c.sourceMetric).sort(),['history:coinmarketcap:days_since_high','history:coinmarketcap:drawdown_pct','history:coinmarketcap:realized_volatility_30d',
  'regime:coinmarketcap:regime_altcoin_season','regime:coinmarketcap:regime_btc_dominance','regime:coinmarketcap:regime_fear_greed'])
 // A daily history window and an hourly regime capture stay known past a live quote's age.
 eq([conditionMaxAgeSeconds('realized_volatility_30d'),conditionMaxAgeSeconds('regime_btc_dominance'),conditionMaxAgeSeconds('price')],[172800,7200,1200])
 eq(conditionPeriod('30d'),2592000)
})
Deno.test('projections are dated by the newest point, known from now and expire with the cached history',()=>{
 const [volatility,drawdown,daysSince]=historyConditionObservations(history,metrics,SUBJECT,NOW)
 eq(volatility.observedAt,new Date(NOW).toISOString())
 eq(volatility.recordedAt,new Date(NOW).toISOString())
 eq(volatility.expiresAt,new Date(NOW+3600000).toISOString())
 eq(volatility.provider,'coinmarketcap');eq(volatility.exportAllowed,false)
 eq(drawdown.value,-50);eq(daysSince.value,5)
 eq(volatility.metadata?.samples,metrics.volatility30d.samples)
 eq(drawdown.metadata?.troughT,metrics.maxDrawdown.peakT!+2*DAY)
 // Nothing is projected without usable history, without metrics, or for a non-CMC subject.
 eq(historyConditionObservations({...history,state:'unavailable',points:[]},metrics,SUBJECT,NOW),[])
 eq(historyConditionObservations(history,metrics,'market:coingecko:ethereum',NOW),[])
 eq(historyConditionObservations(history,{volatility30d:null,maxDrawdown:null,distanceFromHigh:null,timeUnderWaterDays:null},SUBJECT,NOW),[])
 eq(historyConditionObservations(null,metrics,SUBJECT,NOW),[])
 // A capture the caller has not yet observed cannot be projected backwards.
 eq(regimeConditionObservations({...regimeRow,source_observed_at:new Date(NOW+1000).toISOString()},NOW),[])
 eq(regimeConditionObservations({provider:'coinmarketcap',captured_at:new Date(NOW-1000).toISOString()},NOW),[])
 eq(regimeConditionObservations(null,NOW),[])
 eq(regimeConditionObservations({captured_at:new Date(NOW-1000).toISOString(),btc_dominance:57.5},NOW)[0].observedAt,new Date(NOW-1000).toISOString())
})
Deno.test('the existing evaluator can use a supplied derived observation without any new wiring',()=>{
 const observations=historyConditionObservations(history,metrics,SUBJECT,NOW)
 const rule={id:'r1',metric:'drawdown_pct',comparator:'<=',threshold:-40,threshold_unit:'%',time_window:'current',rule_kind:'invalidation',description:'Deep drawdown',source_metric:'history:coinmarketcap:drawdown_pct'}
 const run=(r:Record<string,unknown>)=>evaluateThesisConditions([r],{market_summary:{retained_observations:observations}},SUBJECT,NOW)[0]
 eq(run(rule).met,true)
 eq(run({...rule,threshold:-60}).met,false)
 eq(run({...rule,source_metric:'history:coinmarketcap:days_since_high'}).met,null)
 eq(run({...rule,threshold_unit:'USD'}).met,null)
 eq(run({...rule,metric:'realized_volatility_30d',comparator:'gte',threshold:10,time_window:'30d',source_metric:'history:coinmarketcap:realized_volatility_30d'}).met,true)
 eq(run({...rule,metric:'realized_volatility_30d',comparator:'gte',threshold:10,time_window:'24h',source_metric:'history:coinmarketcap:realized_volatility_30d'}).met,null)
 eq(Reflect.get(run(rule).observation!,'sourceMetric'),'history:coinmarketcap:drawdown_pct')
 eq('value' in run(rule).observation!,false)
})
