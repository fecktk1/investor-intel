// Tick precision follows the visible value range. Narrow movements must not
// collapse into identical compact labels; tooltip values retain cents.
export function portfolioAxisFormatter(values){
 const finite=values.filter(Number.isFinite),low=Math.min(...finite),high=Math.max(...finite)
 const span=finite.length?high-low:0,step=span>0?span/4:1
 const precision=Math.max(0,Math.min(8,Math.ceil(-Math.log10(step))))
 const maximum=finite.length?Math.max(Math.abs(low),Math.abs(high)):0
 const unit=maximum>=1e12?1e12:maximum>=1e9?1e9:maximum>=1e6?1e6:1
 const compact=unit>1&&step>=unit/1000
 const digits=compact?Math.max(0,Math.min(3,Math.ceil(Math.log10(unit/step)))):precision
 const format=new Intl.NumberFormat('en-US',{maximumFractionDigits:digits})
 return value=>!Number.isFinite(value)?'':`${value<0?'-':''}$${format.format(Math.abs(value)/(compact?unit:1))}${compact?unit===1e12?'T':unit===1e9?'B':'M':''}`
}
export const portfolioTooltipUsd=value=>!Number.isFinite(value)?'':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(value)
export function portfolioDateTicks(rows,limit=5){
 const days=[...new Map(rows.filter(r=>Number.isFinite(r.t)).map(r=>[new Date(r.t).toISOString().slice(0,10),r.t])).values()].sort((a,b)=>a-b)
 if(days.length<=limit)return days
 return Array.from({length:limit},(_,i)=>days[Math.round(i*(days.length-1)/(limit-1))])
}
