// Keyless k-line rows carry a period OPEN in `t` and no close time at all, so
// `closedAt` is DERIVED from the candle width the request pinned. It is an
// assertion about the period we asked for, not a provider fact, and the chart
// coverage sentence says so. A period still in progress is dropped rather than
// drawn as if it had closed.
export function klineBars(result,now=Date.now()) {
  const step=Number(result?.data?.barIntervalMs)
  if(!Number.isFinite(step)||step<=0)return []
  const recordedAt=Date.parse(result?.provenance?.fetchedAt||'')
  return (result?.data?.rows||[]).flatMap(row=>{
    const t=Number(row?.t),closedAt=t+step-1
    const [o,h,l,c]=['o','h','l','c'].map(key=>Number(row?.[key]))
    if(!Number.isFinite(t)||closedAt>now||![o,h,l,c].every(n=>Number.isFinite(n)&&n>0)||h<Math.max(o,c)||l>Math.min(o,c))return []
    const v=row?.v==null?null:Number(row.v)
    return [{t,closedAt,...(Number.isFinite(recordedAt)?{recordedAt}:{}),o,h,l,c,v:Number.isFinite(v)&&v>=0?v:null,volumeKind:'period',volumeUnit:'USD'}]
  }).sort((a,b)=>a.t-b.t)
}

// The provider's candle close time is an observation time, not a trade price.
export function ohlcvBars(result) {
  const rows=result?.data?.rows||[]
  return rows.flatMap(row=>(row.quotes||[]).flatMap(point=>{
    const q=Array.isArray(point.quote)?point.quote.find(q=>q.symbol==='USD'||Number(q.id)===2781):point.quote?.USD||point.quote
    const t=Date.parse(point.time_close||'')
    const number=value=>value==null||value===''?null:Number(value)
    const [o,h,l,c,v]=['open','high','low','close','volume'].map(key=>number(q?.[key]))
    if(!Number.isFinite(t)||![o,h,l,c].every(n=>Number.isFinite(n)&&n>0)||h<Math.max(o,c)||l>Math.min(o,c)||l>h)return []
    const recordedAt=Date.parse(result?.provenance?.fetchedAt||'')
    return [{t,closedAt:t,...(Number.isFinite(recordedAt)?{recordedAt}:{}),o,h,l,c,v:Number.isFinite(v)&&v>=0?v:null,volumeKind:'period',volumeUnit:'USD'}]
  })).sort((a,b)=>a.t-b.t)
}
