import {assertAlmostEquals,assertEquals as eq} from 'jsr:@std/assert@1'
import {distanceFromHigh,maxDrawdown,normalizePricePoints,percentileRank,realizedVolatility,timeUnderWaterDays} from './risk-metrics.ts'

const DAY=86400000,HOUR=3600000,T0=Date.parse('2026-08-15T00:00:00Z')
const daily=(prices:number[],start=T0)=>prices.map((price,i)=>({t:start+i*DAY,price}))
const hourly=(prices:number[],start=T0)=>prices.map((price,i)=>({t:start+i*HOUR,price}))

Deno.test('realised volatility is the annualised deviation of log returns at the series own interval',()=>{
 // Five daily closes alternating +1% / -1%: four returns of +-ln(1.01), zero mean.
 const series=daily([100,101,100,101,100])
 const v=realizedVolatility(series)
 assertAlmostEquals(v.pct!,21.9509500757,1e-8)
 eq(v.samples,4);eq(v.intervalSeconds,86400);eq(v.windowDays,30)
 // The same shaped move sampled hourly is a far larger annualised figure, and
 // the sample count says why the two are not the same evidence.
 const perHour=realizedVolatility(hourly([100,101,100,101,100]))
 eq(perHour.intervalSeconds,3600);eq(perHour.samples,4)
 assertAlmostEquals(perHour.pct!,21.9509500757*Math.sqrt(24),1e-8)
})
Deno.test('a flat series is zero volatility, a valid answer, not a missing one',()=>{
 const flat=realizedVolatility(daily([100,100,100,100]))
 eq(flat.pct,0);eq(flat.samples,3);eq(flat.intervalSeconds,86400)
 eq(maxDrawdown(daily([100,100,100,100])),{pct:0,peakT:T0,troughT:T0,recoveredT:T0,daysUnderWater:0})
 eq(timeUnderWaterDays(daily([100,100,100,100])),0)
 // A series that only rises has no drawdown either.
 eq(maxDrawdown(daily([100,110,120,130])).pct,0)
})
Deno.test('fewer than three usable points leaves every component null instead of zero',()=>{
 for(const series of [[],daily([100]),daily([100,90]),[{t:T0,price:0},{t:T0+DAY,price:-5},{t:T0+2*DAY,price:Number.NaN}]]){
  const v=realizedVolatility(series as any)
  eq([v.pct,v.intervalSeconds],[null,null]);eq(v.samples,0)
  eq(maxDrawdown(series as any),{pct:null,peakT:null,troughT:null,recoveredT:null,daysUnderWater:null})
  eq(distanceFromHigh(series as any,T0+10*DAY),{high:null,highT:null,pct:null,daysSince:null})
  eq(timeUnderWaterDays(series as any),null)
 }
 eq(realizedVolatility(null),{pct:null,samples:0,intervalSeconds:null,windowDays:30})
 eq(realizedVolatility(daily([100,100,100]),{windowDays:0}).windowDays,30)
})
Deno.test('the deepest decline reports its own peak, trough, recovery and time under water',()=>{
 // 100 → 120 peak → 60 trough → back above 120 on the seventh day.
 const series=daily([100,120,90,60,80,110,130,125])
 const d=maxDrawdown(series)
 eq(d.pct,-50);eq(d.peakT,T0+DAY);eq(d.troughT,T0+3*DAY);eq(d.recoveredT,T0+6*DAY)
 eq(d.daysUnderWater,5)
 // Still under water: recovery is null and the clock runs to the last point.
 const open=maxDrawdown(daily([100,120,90,60,80,110]))
 eq(open.recoveredT,null);eq(open.daysUnderWater,4)
 // Total time below a previous peak counts every interval, not just the worst.
 eq(timeUnderWaterDays(series),5)
 eq(timeUnderWaterDays(daily([100,120,110,130,120])),2)
})
Deno.test('distance from high measures the last high of the window and the days since it',()=>{
 const now=T0+6*DAY
 const d=distanceFromHigh(daily([100,120,90,60,80,90]),now)
 eq(d.high,120);eq(d.highT,T0+DAY);eq(d.pct,-25);eq(d.daysSince,5)
 // A series sitting at its high is zero days since, not the age of the series.
 const atHigh=distanceFromHigh(daily([100,90,100,130]),T0+3*DAY)
 eq(atHigh.high,130);eq(atHigh.pct,0);eq(atHigh.daysSince,0)
 // A repeated high is dated by the most recent time it was reached.
 eq(distanceFromHigh(daily([130,100,130,120]),T0+3*DAY).highT,T0+2*DAY)
 eq(distanceFromHigh(daily([100,110,120]),Number.NaN).daysSince,null)
})
Deno.test('points are deduplicated, ordered and screened before any measure is taken',()=>{
 const messy=[{t:T0+DAY,price:110},{t:T0,price:100},{t:T0+DAY,price:999},{t:T0+2*DAY,price:0},{t:Number.NaN,price:5},{t:T0+3*DAY,price:120}]
 eq(normalizePricePoints(messy),[{t:T0,price:100},{t:T0+DAY,price:110},{t:T0+3*DAY,price:120}])
 eq(normalizePricePoints(null),[])
 eq(realizedVolatility(messy).samples,2)
})
Deno.test('percentile rank places a value inside its comparison sample, ties counted once',()=>{
 eq(percentileRank(50,[10,20,30,40]),100)
 eq(percentileRank(5,[10,20,30,40]),0)
 eq(percentileRank(25,[10,20,30,40]),50)
 eq(percentileRank(20,[10,20,30,40]),37.5)
 eq(percentileRank(1,[1,1,1]),50)
 eq(percentileRank(1,[]),null);eq(percentileRank(null,[1,2]),null);eq(percentileRank('x',[1,2]),null)
})
