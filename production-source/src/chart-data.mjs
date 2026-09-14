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
