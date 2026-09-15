import {assertEquals as eq,assertAlmostEquals as near,assertThrows} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {normalizeBars,regularBarGrid,barsAt,sma,ema,rsi,calculateStudy,calculateStudies,studyLookbackBars,LOOKBACK_LADDER,MAX_LOOKBACK_BARS,type Bar,STUDY_CATALOG} from './chart-analysis.ts'
const start=Date.parse('2026-09-07T00:00:00Z'),day=86400000
const bars=(values:number[],volumes?:number[]):Bar[]=>values.map((c,i)=>({t:start+i*day,o:c,h:c,l:c,c,v:volumes?.[i]??1}))
const calc=(type:string,values:number[],params:Record<string,unknown>={},volumes?:number[])=>calculateStudy(bars(values,volumes),{id:'test',type,params})
const values=(result:ReturnType<typeof calculateStudy>,series=0)=>result.series[series].points.map(p=>p.value)
Deno.test('chart normalization preserves real OHLC and downgrades malformed bars without inventing candles',()=>{
 const out=normalizeBars([{t:start,o:9,h:11,l:8,c:10,v:0},{t:start+day,c:11},{t:start+2*day,o:10,h:9,l:8,c:12},{t:start+3*day,c:null},{t:start+4*day,c:0}])
 eq(out.bars.length,3);eq(out.bars[0].o,9);eq(out.bars[0].v,0);eq(out.bars[1].o,null);eq(out.bars[2].h,null);eq(out.ohlc,false);eq(out.volume,false);eq(out.rejected,2)
})
Deno.test('chart grids retain gaps as whitespace and reject irregular spacing or excessive expansion',()=>{
 const rows=bars([1,2,3,4]);eq(regularBarGrid([rows[0],rows[1],rows[3]])?.points.map(p=>p.bar?.c??null),[1,2,null,4])
 eq(regularBarGrid([{...rows[0]},{...rows[1],t:rows[1].t+1000},rows[2]]),null)
 eq(regularBarGrid([rows[0],{...rows[1],t:start+6000*day}],day),null)
})
Deno.test('replay excludes unfinished bars and delayed revisions when originally-known mode is requested',()=>{
 const rows=bars([1,2,3]).map(b=>({...b,recordedAt:b.t+2*day}))
 eq(barsAt(rows,start+day,day).map(b=>b.c),[1]);eq(barsAt(rows,start+day,day,{knownOnly:true}),[])
 eq(barsAt(rows,start+2*day,day,{knownOnly:true}).map(b=>b.c),[1])
})
Deno.test('SMA and EMA warm up from complete seeds and reset across explicit missing observations',()=>{
 eq(sma([1,2,3,4,5],3),[null,null,2,3,4]);eq(ema([1,2,3,4,5],3),[null,null,2,3,4])
 eq(ema([1,2,null,4,6,8],2),[null,1.5,null,null,5,7]);eq(sma([1,null,3,4],2),[null,null,null,3.5])
})
Deno.test('DEMA on a linear ramp removes lag only after both EMA seeds exist',()=>{const result=calc('dema',[1,2,3,4,5,6,7],{period:3});eq(result.warmup,5);eq(values(result),[5,6,7])})
Deno.test('Bollinger uses population deviation with an independently computed three-price window',()=>{
 const result=calc('bollinger',[1,2,3],{period:3,multiplier:2});eq(values(result),[2]);near(values(result,1)[0],2+2*Math.sqrt(2/3));near(values(result,2)[0],2-2*Math.sqrt(2/3))
})
Deno.test('Wilder RSI handles gains, losses and flat markets without division by zero',()=>{
 const result=rsi([100,102,101,105,105],2);eq(result.slice(0,2),[null,null]);near(result[2]!,200/3);near(result[3]!,100-100/11);near(result[4]!,result[3]!)
 eq(rsi([1,2,3,4],2),[null,null,100,100]);eq(rsi([4,3,2,1],2),[null,null,0,0]);eq(rsi([2,2,2,2],2),[null,null,50,50])
})
Deno.test('ATR includes gaps from the previous close and uses Wilder smoothing',()=>{
 const rows=bars([10,11,15]).map((b,i)=>({...b,h:[11,12,16][i],l:[9,10,14][i]}))
 eq(values(calculateStudy(rows,{id:'atr',type:'atr',params:{period:2}})),[2,3.5])
})
Deno.test('MACD independently seeded line signal and histogram match a linear ramp',()=>{
 const result=calc('macd',[1,2,3,4,5],{fast:2,slow:3,signal:2});values(result).forEach(v=>near(v,0.5));values(result,1).forEach(v=>near(v,0.5));values(result,2).forEach(v=>near(v,0));eq(result.warmup,4)
 assertThrows(()=>calc('macd',[1,2],{fast:26,slow:12}))
})
Deno.test('Stochastic RSI uses defined neutral flat ranges and complete smoothed windows',()=>{const result=calc('stoch_rsi',[1,1,1,1,1,1,1],{period:2,stochastic:2,k:2,d:2});eq(result.warmup,6);eq(values(result,1),[50,50])})
Deno.test('OBV distinguishes unchanged closes and does not replace missing volume with zero',()=>{
 eq(values(calc('obv',[10,11,11,9],{},[100,20,50,7])),[0,20,20,13])
 const rows=bars([1,2]);rows[1].v=null;eq(calculateStudy(rows,{id:'obv',type:'obv'}).series,[])
})
Deno.test('overlapping volume snapshots survive normalization and cannot enter candle-volume studies',()=>{
 const rows=normalizeBars(bars([10,11,12],[2,3,4]).map(b=>({...b,volumeKind:'snapshot',volumeUnit:'USD'}))).bars
 eq(rows[0].volumeKind,'snapshot');eq(rows[0].volumeUnit,'USD')
 for(const type of ['obv','vwap','vwrsi']){const result=calculateStudy(rows,{id:type,type});eq(result.series,[]);eq(result.reason,'Requires non-overlapping candle volume. This source supplies volume snapshots.')}
 eq(calculateStudy(rows,{id:'sma',type:'sma',params:{period:2}}).series[0].points.length,2)
 const daily=rows.map(b=>({...b,volumeKind:'period' as const}))
 eq(calculateStudy(daily,{id:'vwap',type:'vwap'}).reason,'Requires volume in asset units. This source supplies USD volume.')
 eq(calculateStudy(daily,{id:'obv',type:'obv'}).series[0].points.length,3)
})
Deno.test('anchored VWAP uses weighted variance and zero volume produces no fabricated price',()=>{
 const result=calc('vwap',[10,20],{anchor:start,multiplier:2},[1,3]);near(values(result)[1],17.5);near(values(result,1)[1],17.5+2*Math.sqrt(18.75))
 eq(values(calc('vwap',[10,20],{anchor:start},[0,0])),[]);eq(values(calc('vwap',[10,20],{anchor:start+day},[1,3])),[20])
 eq(values(calc('vwap',[10,20],{},[1,3])),[10,20])
})
Deno.test('volume-weighted RSI respects the changed-volume denominator',()=>{const result=calc('vwrsi',[10,12,11],{period:2},[1,2,1]);near(values(result)[0],80)})
Deno.test('previous-week levels require the whole completed week and cannot leak current-week extrema',()=>{
 const input=bars([1,2,3,4,5,6,7,99,100]);const result=calculateStudy(input,{id:'weekly',type:'weekly'})
 eq(values(result),[7,7]);eq(values(result,1),[1,1]);eq(values(calculateStudy(input.slice(1),{id:'weekly',type:'weekly'})),[])
 eq(values(calculateStudy(input.filter((_b,i)=>i!==3),{id:'weekly',type:'weekly'})),[])
})
Deno.test('Ichimoku cloud contains only previously computed values and exposes no backward Chikou leak',()=>{
 const result=calc('ichimoku',[1,2,3,4,5,6,7],{tenkan:2,kijun:3,span:4,shift:2})
 eq(values(result,0),[1.5,2.5,3.5,4.5,5.5,6.5]);eq(values(result,3),[2.5,3.5]);eq(result.series.some(s=>s.name==='Chikou'),false)
})
Deno.test('every exposed study is prefix-stable when new bars arrive',()=>{
 const input=bars(Array.from({length:240},(_,i)=>100+i/10+Math.sin(i)*3)),prefix=input.slice(0,200),cutoff=prefix.at(-1)!.t
 for(const type of Object.keys(STUDY_CATALOG)){
  const full=calculateStudy(input,{id:type,type}),past=calculateStudy(prefix,{id:type,type})
  for(let i=0;i<past.series.length;i++)eq(full.series[i].points.filter(p=>p.t<=cutoff),past.series[i].points,type)
 }
})
Deno.test('parameter and computation budgets reject invalid or excessive work',()=>{
 assertThrows(()=>calc('rsi',[1,2],{period:NaN}));assertThrows(()=>calc('bollinger',[1,2],{multiplier:-1}));assertThrows(()=>calc('unknown',[1]))
 assertThrows(()=>calculateStudies([],Array.from({length:21},(_,i)=>({id:String(i),type:'sma'}))))
})

Deno.test('invalid far-future clocks and inverted close times cannot enter chart or replay',()=>{const r=normalizeBars([{t:4102444800001,c:100},{t:1788998400000,c:100,closedAt:1788998399999},{t:1788998400000,c:100,closedAt:'invalid'}]);eq(r.bars,[]);eq(r.rejected,3)})

Deno.test('a declared source interval resets EMA and ATR after missing bars without treating them as larger candles',()=>{
 const rows=bars([10,12,100,102]).map((b,i)=>({...b,t:start+[0,1,3,4][i]*day,h:b.c+1,l:b.c-1}))
 const average=calculateStudy(rows,{id:'e',type:'ema',params:{period:2}},{intervalMs:day})
 eq(values(average),[11,101]);eq(average.series[0].points.map(p=>p.t),[start+day,start+4*day]);eq(average.coverage,{resets:1,latestBars:2,intervalMs:day})
 eq(values(calculateStudy(rows,{id:'a',type:'atr',params:{period:2}},{intervalMs:day})),[2.5,2.5])
 const sparse=rows.filter((_b,i)=>i%2===0);eq(values(calculateStudy(sparse,{id:'e',type:'ema',params:{period:2}},{intervalMs:day})),[])
})
Deno.test('every rolling study warms up independently after a timestamp gap and remains prefix stable',()=>{
 const input=bars(Array.from({length:401},(_,i)=>100+i/10+Math.sin(i)*3)).filter((_b,i)=>i!==200)
 for(const type of ['sma','ema','dema','bollinger','atr','rsi','macd','stoch_rsi','obv','vwrsi','ichimoku']){
  const result=calculateStudy(input,{id:type,type},{intervalMs:day}),first=calculateStudy(input.slice(0,200),{id:type,type},{intervalMs:day}),last=calculateStudy(input.slice(200),{id:type,type},{intervalMs:day})
  result.series.forEach((series,i)=>eq(series.points,[...first.series[i].points,...last.series[i].points],type))
 }
})
Deno.test('session VWAP waits for a complete UTC start and resumes only at the next covered session after a gap',()=>{
 const hour=3600000,input=bars([10,20,30,50,60]).map((b,i)=>({...b,t:start+[1,2,24,26,48][i]*hour}))
 const result=calculateStudy(input,{id:'v',type:'vwap'},{intervalMs:hour})
 eq(result.series[0].points,[{t:start+24*hour,value:30},{t:start+48*hour,value:60}])
 const initial=calculateStudy(input.slice(0,2),{id:'v',type:'vwap'},{intervalMs:hour});eq(values(initial),[]);eq(initial.reason,'Requires continuous bars from 00:00 UTC for the current session.')
})
Deno.test('anchored VWAP cannot silently move a missing anchor or restart after a gap',()=>{
 const input=bars([10,20,30,40]).map((b,i)=>({...b,t:start+[0,1,3,4][i]*day}))
 const result=calculateStudy(input,{id:'v',type:'vwap',params:{anchor:start}},{intervalMs:day})
 eq(values(result),[10,15]);eq(result.reason,'Requires continuous bars from the exact selected anchor.')
 eq(values(calculateStudy(input,{id:'v',type:'vwap',params:{anchor:start+day/2}},{intervalMs:day})),[])
 eq(values(calculateStudy(input,{id:'v',type:'vwap',params:{anchor:start-day}},{intervalMs:day})),[])
})
Deno.test('known prior weekly extrema survive a gap in the current week but partial prior weeks stay absent',()=>{
 const input=bars([1,2,3,4,5,6,7,80,90,99]).filter((_b,i)=>i!==8)
 const result=calculateStudy(input,{id:'w',type:'weekly'},{intervalMs:day});eq(values(result),[7,7]);eq(values(result,1),[1,1])
 eq(values(calculateStudy(input.filter((_b,i)=>i!==2),{id:'w',type:'weekly'},{intervalMs:day})),[])
})
Deno.test('a chart asks for exactly the warm-up its studies need, quantized up to the ladder',()=>{
 const need=(type:string,params?:Record<string,unknown>)=>studyLookbackBars([{id:'s',type,...(params?{params}:{})}])
 // Nothing to warm up is no extra history at all, so a plain chart costs nothing.
 eq(studyLookbackBars([]),0);eq(studyLookbackBars([{id:'s',type:'not_a_study'}]),0)
 // The default 50-period average needs 50 closes before the first visible bar.
 eq(need('sma'),60);eq(need('ema'),60);eq(need('bollinger'),60);eq(need('atr'),60)
 eq(need('rsi'),60);eq(need('vwrsi'),60);eq(need('macd'),60);eq(need('stoch_rsi'),60)
 eq(need('obv'),60);eq(need('vwap'),60);eq(need('weekly'),60)
 // DEMA needs two seeds (2 × 43 − 1 = 85) and Ichimoku a span plus its shift (52 + 26 = 78).
 eq(need('dema'),120);eq(need('ichimoku'),120)
 // The whole set takes the largest warm-up, not the sum.
 eq(studyLookbackBars([{id:'a',type:'sma'},{id:'b',type:'ichimoku'},{id:'c',type:'obv'}]),120)
 // The ladder quantizes UP, so nudging a period from 60 to 61 reuses one request
 // rather than refetching the chart.
 eq(need('sma',{period:60}),60);eq(need('sma',{period:61}),120);eq(need('sma',{period:250}),250)
 eq(need('sma',{period:251}),500);eq(need('sma',{period:500}),500)
 // Above the ladder the request is the cap, never an unbounded provider read.
 eq(need('dema',{period:500}),MAX_LOOKBACK_BARS);eq(need('stoch_rsi',{period:500,stochastic:500,k:500,d:500}),1000)
 eq(LOOKBACK_LADDER,[0,60,120,250,500,1000])
 // An invalid period contributes nothing rather than throwing the chart away.
 for(const params of [{period:0},{period:501},{period:'x'},{period:2.5}])eq(need('sma',params),0)
 // The arithmetic is the one the calculation itself reports as its warm-up.
 for(const [type,params] of [['sma',{period:50}],['dema',{period:43}],['macd',{}],['ichimoku',{}],['stoch_rsi',{}],['rsi',{}]] as const){
  const warmup=calculateStudy(bars(Array.from({length:3},(_v,i)=>i+1)),{id:'w',type,params}).warmup
  eq(LOOKBACK_LADDER.find(rung=>rung>=warmup)??MAX_LOOKBACK_BARS,need(type,params),type)
 }
})
Deno.test('study inputs reject reversed and duplicate clocks and invalid declared intervals',()=>{
 const input=bars([1,2]);assertThrows(()=>calculateStudy([...input].reverse(),{id:'s',type:'sma'}));assertThrows(()=>calculateStudy([input[0],input[0]],{id:'s',type:'sma'}))
 assertThrows(()=>calculateStudy(input,{id:'s',type:'sma'},{intervalMs:0}));assertThrows(()=>calculateStudy(input,{id:'s',type:'sma'},{intervalMs:NaN}))
})
