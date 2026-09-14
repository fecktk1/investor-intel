/** Versioned, deterministic chart calculations. No provider or personal-data access. */
export const CHART_ANALYSIS_VERSION='chart-3'
export const MAX_CHART_BARS=5000
export type Bar={t:number;o:number|null;h:number|null;l:number|null;c:number;v:number|null;recordedAt?:number;closedAt?:number;volumeKind?:'period'|'snapshot';volumeUnit?:'USD'}
export type Point={t:number;value:number}
type Maybe=number|null
const numeric=(v:unknown):Maybe=>v==null||v===''||typeof v==='boolean'?null:Number.isFinite(Number(v))?Number(v):null
const epoch=(v:unknown):Maybe=>{const n=typeof v==='string'&&!/^\d+(\.\d+)?$/.test(v)?Date.parse(v):numeric(v);return n==null||!Number.isFinite(n)?null:n>0&&n<1e12?n*1000:n}
export function normalizeBars(input:any[],limit=MAX_CHART_BARS) {
 if(!Array.isArray(input)||input.length>MAX_CHART_BARS*2)throw new Error('chart_input_limit')
 if(!Number.isSafeInteger(limit)||limit<1)throw new Error('chart_input_limit')
 const unique=new Map<number,Bar>();let rejected=0
 for(const row of input){
  const t=epoch(row?.t??row?.time),c=numeric(row?.c??row?.close??row?.price)
  if(t==null||t<0||t>4102444800000||c==null||c<=0||(row.closedAt!=null&&(epoch(row.closedAt)==null||epoch(row.closedAt)!<t||epoch(row.closedAt)!>4102444800000))){rejected++;continue}
  const o=numeric(row.o??row.open),h=numeric(row.h??row.high),l=numeric(row.l??row.low),v=numeric(row.v??row.volume)
  const valid=o!=null&&h!=null&&l!=null&&o>0&&l>0&&h>=Math.max(o,c,l)&&l<=Math.min(o,c,h)
  unique.set(t,{t,c,o:valid?o:null,h:valid?h:null,l:valid?l:null,v:v!=null&&v>=0?v:null,
   ...(['period','snapshot'].includes(row.volumeKind)?{volumeKind:row.volumeKind}:{}),...(row.volumeUnit==='USD'?{volumeUnit:'USD' as const}:{}),
   ...(epoch(row.recordedAt)!=null?{recordedAt:epoch(row.recordedAt)!}:{}),...(epoch(row.closedAt)!=null?{closedAt:epoch(row.closedAt)!}:{})})
 }
 const all=[...unique.values()].sort((a,b)=>a.t-b.t),bars=all.slice(-Math.min(MAX_CHART_BARS,Math.max(1,limit)))
 return {bars,rejected,truncated:all.length>bars.length,ohlc:bars.length>0&&bars.every(b=>b.o!=null),volume:bars.length>0&&bars.every(b=>b.v!=null)}
}
export function regularBarGrid(bars:Bar[],intervalMs?:number) {
 if(bars.length<2)return null
 const step=intervalMs??Math.min(...bars.slice(1).map((b,i)=>b.t-bars[i].t))
 if(!Number.isSafeInteger(step)||step<1000)return null
 const start=bars[0].t,end=bars.at(-1)!.t,count=(end-start)/step+1
 if(!Number.isSafeInteger(count)||count>MAX_CHART_BARS||bars.some(b=>(b.t-start)%step!==0))return null
 const byTime=new Map(bars.map(b=>[b.t,b]))
 return {step,start,end,points:Array.from({length:count},(_,i)=>({t:start+i*step,bar:byTime.get(start+i*step)??null}))}
}
export function barsAt(bars:Bar[],cursor:number,intervalMs:number,{knownOnly=false}={}) {
 return bars.filter(b=>(b.closedAt??b.t+intervalMs)<=cursor&&(!knownOnly||b.recordedAt!=null&&b.recordedAt<=cursor))
}
export function period(value:unknown,fallback:number,min=1,max=500) {
 const n=value==null?fallback:Number(value)
 if(!Number.isInteger(n)||n<min||n>max)throw new Error(`period_must_be_${min}_to_${max}`)
 return n
}
export function sma(values:Maybe[],n:number):Maybe[] {
 period(n,n);let total=0,missing=0
 return values.map((v,i)=>{if(v==null)missing++;else total+=v;if(i>=n){const old=values[i-n];if(old==null)missing--;else total-=old}return i>=n-1&&missing===0?total/n:null})
}
export function ema(values:Maybe[],n:number,alpha=2/(n+1)):Maybe[] {
 period(n,n);let last:Maybe=null,seed:number[]=[]
 return values.map(v=>{
  if(v==null){last=null;seed=[];return null}
  if(last==null){seed.push(v);if(seed.length<n)return null;last=seed.reduce((a,b)=>a+b,0)/n}
  else last=last+alpha*(v-last)
  return last
 })
}
export function rsi(values:Maybe[],n:number):Maybe[] {
 const gains=values.map((v,i)=>i===0||v==null||values[i-1]==null?null:Math.max(0,v-values[i-1]!))
 const losses=values.map((v,i)=>i===0||v==null||values[i-1]==null?null:Math.max(0,values[i-1]!-v))
 const up=ema(gains,n,1/n),down=ema(losses,n,1/n)
 return up.map((u,i)=>u==null||down[i]==null?null:u===0&&down[i]===0?50:down[i]===0?100:100-100/(1+u/down[i]!))
}
const combine=(a:Maybe[],b:Maybe[],fn:(x:number,y:number)=>number)=>a.map((v,i)=>v==null||b[i]==null?null:fn(v,b[i]!))
const points=(bars:Bar[],values:Maybe[])=>bars.flatMap((b,i)=>values[i]!=null&&Number.isFinite(values[i])?[{t:b.t,value:values[i]!}]:[])
export type Study={id:string;type:string;params?:Record<string,unknown>}
export type StudyResult={id:string;type:string;pane:string;series:{name:string;points:Point[];kind?:'histogram'}[];warmup:number;reason:string|null;definition:string;coverage?:{resets:number;latestBars:number;intervalMs:number|null}}
export const STUDY_CATALOG:Record<string,{label:string;pane:string;requires:'close'|'ohlc'|'volume'|'ohlcv';defaults:Record<string,number>;definition:string}>={
 sma:{label:'Simple moving average',pane:'price',requires:'close',defaults:{period:50},definition:'Arithmetic mean of the last N closes.'},
 ema:{label:'Exponential moving average',pane:'price',requires:'close',defaults:{period:20},definition:'SMA seed, then alpha = 2 / (N + 1).'},
 dema:{label:'Double exponential average',pane:'price',requires:'close',defaults:{period:43},definition:'2 × EMA(close) − EMA(EMA(close)); both averages use an SMA seed.'},
 bollinger:{label:'Bollinger bands',pane:'price',requires:'close',defaults:{period:20,multiplier:2},definition:'SMA ± multiplier × population standard deviation of N closes.'},
 atr:{label:'Average true range',pane:'atr',requires:'ohlc',defaults:{period:14},definition:'Wilder average of max(high−low, |high−previous close|, |low−previous close|).'},
 rsi:{label:'Relative strength index',pane:'rsi',requires:'close',defaults:{period:14},definition:'Wilder-smoothed close gains and losses; flat windows are 50.'},
 macd:{label:'MACD',pane:'macd',requires:'close',defaults:{fast:12,slow:26,signal:9},definition:'Fast EMA minus slow EMA; signal EMA and difference histogram.'},
 stoch_rsi:{label:'Stochastic RSI',pane:'stoch_rsi',requires:'close',defaults:{period:14,stochastic:14,k:3,d:3},definition:'RSI position within its N-value range; flat ranges are 50; SMA smoothing for K and D.'},
 obv:{label:'On-balance volume',pane:'obv',requires:'volume',defaults:{},definition:'Cumulative volume signed by close direction, starting at zero.'},
 vwap:{label:'VWAP and bands',pane:'price',requires:'ohlcv',defaults:{multiplier:2},definition:'Volume-weighted typical price, reset at 00:00 UTC or an explicit anchor; weighted population-deviation bands. Candle approximation, not trade VWAP.'},
 vwrsi:{label:'Volume-weighted RSI',pane:'vwrsi',requires:'volume',defaults:{period:14},definition:'Rolling sums of positive and negative close changes × volume; zero weighted movement is 50. This is a volume-weighted variant, not Wilder RSI.'},
 weekly:{label:'Previous week high / low',pane:'price',requires:'ohlc',defaults:{},definition:'Completed Monday–Sunday UTC calendar week high and low; no current-week lookahead.'},
 ichimoku:{label:'Ichimoku',pane:'price',requires:'ohlc',defaults:{tenkan:9,kijun:26,span:52,shift:26},definition:'Midpoints of rolling high/low ranges. Cloud shown at its display bar using values computed shift bars earlier. Chikou is omitted during replay to prevent later closes entering earlier bars.'},
}
function calculateStudySegment(bars:Bar[],study:Study,intervalMs?:number):StudyResult {
 const spec=Object.hasOwn(STUDY_CATALOG,study.type)?STUDY_CATALOG[study.type]:null;if(!spec)throw new Error('unknown_study')
 const p={...spec.defaults,...study.params},n=(key='period',min=1)=>period(p[key],spec.defaults[key]??14,min),close=bars.map(b=>b.c)
 const result:StudyResult={id:study.id,type:study.type,pane:spec.pane,series:[],warmup:0,reason:null,definition:spec.definition}
 const missing=(spec.requires.includes('ohlc')&&bars.some(b=>b.o==null||b.h==null||b.l==null))||(spec.requires==='volume'||spec.requires==='ohlcv')&&bars.some(b=>b.v==null)
 if(missing){result.reason=`Requires complete ${spec.requires==='ohlcv'?'OHLC and volume':spec.requires==='ohlc'?'OHLC':'volume'} observations`;return result}
 if((spec.requires==='volume'||spec.requires==='ohlcv')&&bars.some(b=>b.volumeKind==='snapshot')){result.reason='Requires non-overlapping candle volume. This source supplies volume snapshots.';return result}
 if(study.type==='vwap'&&bars.some(b=>b.volumeUnit==='USD')){result.reason='Requires volume in asset units. This source supplies USD volume.';return result}
 const add=(name:string,values:Maybe[],kind?:'histogram')=>{result.series.push({name,points:points(bars,values),kind})}
 if(study.type==='sma'||study.type==='ema'){result.warmup=n();add(spec.label,study.type==='sma'?sma(close,n()):ema(close,n()))}
 else if(study.type==='dema'){const first=ema(close,n());result.warmup=2*n()-1;add('DEMA',combine(first,ema(first,n()),(a,b)=>2*a-b))}
 else if(study.type==='bollinger'){
  const size=n(),mean=sma(close,size),multiplier=Number(p.multiplier);if(!Number.isFinite(multiplier)||multiplier<=0||multiplier>10)throw new Error('invalid_band_multiplier')
  const std=mean.map((m,i)=>m==null?null:Math.sqrt(close.slice(i-size+1,i+1).reduce((sum,c)=>sum+(c-m)**2,0)/size))
  result.warmup=size;add('Middle',mean);add('Upper',combine(mean,std,(m,s)=>m+multiplier*s));add('Lower',combine(mean,std,(m,s)=>m-multiplier*s))
 }else if(study.type==='atr'){
  const tr=bars.map((b,i)=>i===0?b.h!-b.l!:Math.max(b.h!-b.l!,Math.abs(b.h!-bars[i-1].c),Math.abs(b.l!-bars[i-1].c)))
  result.warmup=n();add('ATR',ema(tr,n(),1/n()))
 }else if(study.type==='rsi'){result.warmup=n()+1;add('RSI',rsi(close,n()))}
 else if(study.type==='macd'){
  const fast=n('fast'),slow=n('slow'),signal=n('signal');if(fast>=slow)throw new Error('macd_fast_must_be_below_slow')
  const line=combine(ema(close,fast),ema(close,slow),(a,b)=>a-b),signalLine=ema(line,signal)
  result.warmup=slow+signal-1;add('MACD',line);add('Signal',signalLine);add('Histogram',combine(line,signalLine,(a,b)=>a-b),'histogram')
 }else if(study.type==='stoch_rsi'){
  const relative=rsi(close,n()),window=n('stochastic'),raw=relative.map((v,i)=>{
   const slice=relative.slice(i-window+1,i+1);if(v==null||i<window-1||slice.some(x=>x==null))return null
   const min=Math.min(...slice as number[]),max=Math.max(...slice as number[]);return max===min?50:100*(v-min)/(max-min)
  }),k=sma(raw,n('k'));result.warmup=n()+window+n('k')+n('d')-2;add('K',k);add('D',sma(k,n('d')))
 }else if(study.type==='obv'){
  let value=0;result.warmup=1;add('OBV',bars.map((b,i)=>{if(i)value+=Math.sign(b.c-bars[i-1].c)*b.v!;return value}))
 }else if(study.type==='vwrsi'){
  const gains=bars.map((b,i)=>i?Math.max(0,b.c-bars[i-1].c)*b.v!:null),losses=bars.map((b,i)=>i?Math.max(0,bars[i-1].c-b.c)*b.v!:null)
  result.warmup=n()+1;add('Volume-weighted RSI',combine(sma(gains,n()),sma(losses,n()),(u,d)=>u===0&&d===0?50:d===0?100:100-100/(1+u/d)))
 }else if(study.type==='vwap'){
  const anchor=p.anchor==null?null:epoch(p.anchor),multiplier=Number(p.multiplier)
  if(p.anchor!=null&&anchor==null||!Number.isFinite(multiplier)||multiplier<=0||multiplier>10)throw new Error('invalid_vwap_parameters')
  let volume=0,mean=0,m2=0,day:number|null=null,covered=false;const upper:Maybe[]=[],lower:Maybe[]=[]
  const averages=bars.map(b=>{
   const session=Math.floor(b.t/86400000);if(anchor==null&&session!==day){volume=0;mean=0;m2=0;day=session;covered=b.t===session*86400000}
   if(anchor!=null&&b.t===anchor)covered=true
   if(!covered||anchor!=null&&b.t<anchor){upper.push(null);lower.push(null);return null}
   const price=(b.h!+b.l!+b.c)/3,weight=b.v!,next=volume+weight
   if(next>0&&weight>0){const delta=price-mean;mean+=weight/next*delta;m2+=weight*delta*(price-mean);volume=next}
   const std=volume>0?Math.sqrt(Math.max(0,m2/volume)):null
   upper.push(std==null?null:mean+multiplier*std);lower.push(std==null?null:mean-multiplier*std);return volume>0?mean:null
  });if(!covered)result.reason=anchor==null?'Requires continuous bars from 00:00 UTC for the current session.':'Requires continuous bars from the exact selected anchor.';result.warmup=1;add('VWAP',averages);add('Upper',upper);add('Lower',lower)
 }else if(study.type==='weekly'){
  let week:number|null=null,high=-Infinity,low=Infinity,previousHigh:Maybe=null,previousLow:Maybe=null,firstInWeek=0,lastInWeek=0,count=0;const highs:Maybe[]=[],lows:Maybe[]=[]
  const step=intervalMs??regularBarGrid(bars)?.step??0
  for(const b of bars){const d=new Date(b.t),monday=Math.floor(b.t/86400000)-(d.getUTCDay()+6)%7
   if(week!=null&&monday!==week){
    const complete=step>0&&monday-week===7&&firstInWeek===week*86400000&&lastInWeek+step===(week+7)*86400000&&count*step===7*86400000
    previousHigh=complete?high:null;previousLow=complete?low:null;high=-Infinity;low=Infinity;count=0
   }
   if(count===0)firstInWeek=b.t;lastInWeek=b.t;count++
   week=monday;high=Math.max(high,b.h!);low=Math.min(low,b.l!);highs.push(previousHigh);lows.push(previousLow)
  }add('Previous week high',highs);add('Previous week low',lows);result.warmup=1
 }else if(study.type==='ichimoku'){
  const midpoint=(size:number)=>bars.map((_b,i)=>i<size-1?null:(Math.max(...bars.slice(i-size+1,i+1).map(b=>b.h!))+Math.min(...bars.slice(i-size+1,i+1).map(b=>b.l!)))/2)
  const tenkan=midpoint(n('tenkan')),kijun=midpoint(n('kijun')),spanB=midpoint(n('span')),spanA=combine(tenkan,kijun,(a,b)=>(a+b)/2),shift=n('shift')
  result.warmup=Math.max(n('span'),n('kijun'))+shift;add('Tenkan',tenkan);add('Kijun',kijun);add('Cloud A',bars.map((_b,i)=>i>=shift?spanA[i-shift]:null));add('Cloud B',bars.map((_b,i)=>i>=shift?spanB[i-shift]:null))
 }
 if(!result.reason&&!result.series.some(s=>s.points.length))result.reason=`Needs ${result.warmup} observations to warm up`
 return result
}
/** Calculation state restarts after every missing source period. Historical
 * segments remain inspectable, but cannot seed a later segment. */
export function calculateStudy(bars:Bar[],study:Study,options:{intervalMs?:number|null}={}):StudyResult {
 if(bars.length>MAX_CHART_BARS)throw Error('study_budget_exceeded')
 if(bars.some((b,i)=>!Number.isFinite(b.t)||i>0&&b.t<=bars[i-1].t))throw Error('invalid_study_times')
 const step=options.intervalMs??regularBarGrid(bars)?.step
 if(step!=null&&(!Number.isSafeInteger(step)||step<1000))throw Error('invalid_study_interval')
 const segments:Bar[][]=[[]]
 for(const b of bars){const group=segments.at(-1)!;if(group.length&&step!=null&&b.t-group.at(-1)!.t!==step)segments.push([]);segments.at(-1)!.push(b)}
 const results=study.type==='weekly'?[calculateStudySegment(bars,study,step)]:segments.map(part=>calculateStudySegment(part,study,step))
 const latest=results.at(-1)!,combined=new Map<string,StudyResult['series'][number]>()
 for(const result of results)for(const series of result.series){const row=combined.get(series.name)||{...series,points:[]};row.points.push(...series.points);combined.set(series.name,row)}
 return {...latest,series:[...combined.values()],coverage:{resets:segments.length-1,latestBars:segments.at(-1)!.length,intervalMs:step??null}}
}
export function calculateStudies(bars:Bar[],studies:Study[],options:{intervalMs?:number|null}={}) {
 if(bars.length>MAX_CHART_BARS||studies.length>20)throw new Error('study_budget_exceeded')
 return studies.map(study=>calculateStudy(bars,study,options))
}
