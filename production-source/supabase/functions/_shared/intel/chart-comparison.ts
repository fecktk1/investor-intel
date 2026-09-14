// The viewer and static export share the same close-time join and baseline.
// A return is undefined unless every selected asset has two shared observations.
const epoch=(v:any)=>{if(v==null||v==='')return null;const n=typeof v==='number'?v:/^\d+(\.\d+)?$/.test(String(v))?Number(v):Date.parse(v);return Number.isFinite(n)?n>0&&n<1e12?n*1000:n:null}
export function comparisonTimeline(input:any[]=[],now=Date.now()){
 const series=input.slice(0,4).map((s,i)=>{const prices=new Map<number,number>();for(const b of (s.candles||[]).slice(-4000)){const t=epoch(b.closedAt??(s.chartSource?.timestampMeaning==='open'?null:b.t));if(t!=null&&t<=now&&b.c!=null&&Number.isFinite(Number(b.c))&&Number(b.c)>=0)prices.set(t,Number(b.c))}return {...s,key:`asset_${i}`,data:[...prices].sort((a,b)=>a[0]-b[0]).map(([t,price])=>({t,price}))}})
 const maps:Map<number,number>[]=series.map(s=>new Map(s.data.map((p:any)=>[p.t,p.price])))
 const times:number[]=[...new Set<number>(series.flatMap(s=>s.data.flatMap((p:any,i:number)=>{const step=s.chartSource?.intervalMs,next=s.data[i+1];return Number.isSafeInteger(step)&&step>=1000&&next&&next.t-p.t>step?[p.t,p.t+step]:[p.t]})))].sort((a,b)=>a-b),shared=times.filter(t=>maps.length>=2&&maps.every(m=>m.has(t))),baseline=shared.length>1&&maps.every(m=>m.get(shared[0])!>0)?shared[0]:null
 const data=times.map(t=>Object.fromEntries([['t',t],...series.flatMap((s,i)=>{const price=maps[i].get(t)??null;return [[s.key,price],[`${s.key}_return`,baseline==null||t<baseline||price==null?null:(price/maps[i].get(baseline)!-1)*100]]})]))
 return {series,times,data,baseline,sharedCount:shared.length,limited:input.length>4||input.some(s=>s.candles?.length>4000)}
}
export function comparisonWindow(model:any,range:any){const from=Number.isFinite(range?.from)?range.from:model.times[0],to=Number.isFinite(range?.to)?range.to:model.times.at(-1);return model.data.filter((r:any)=>r.t>=from&&r.t<=to)}
export function comparisonPriceDomain(rows:any[],keys:string[]){const values:number[]=rows.flatMap(row=>keys.map(key=>row[key])).filter(v=>typeof v==='number'&&Number.isFinite(v));if(!values.length)return [0,1];const lo=Math.min(...values),hi=Math.max(...values),pad=Math.max((hi-lo)*.08,Math.abs(hi)*.001,.00000001);return [lo-pad,hi+pad]}
