import {regularBarGrid} from '../../../supabase/functions/_shared/intel/chart-analysis'
export function rendererData(bars,mode='candles',intervalMs,timeWindow) {
 let grid=regularBarGrid(bars,intervalMs)
 if(!grid)return null
 // Missing current candles must not remove the period containing new research.
 // Whitespace extends the continuous axis; it is never a price observation.
 if(Number.isFinite(timeWindow?.from)&&Number.isFinite(timeWindow?.to)&&timeWindow.from<=timeWindow.to){
  const start=grid.start+Math.floor((Math.min(grid.start,timeWindow.from)-grid.start)/grid.step)*grid.step
  const end=grid.start+Math.ceil((Math.max(grid.end,timeWindow.to)-grid.start)/grid.step)*grid.step
  const count=(end-start)/grid.step+1
  if(count>10000)return null
  const byTime=new Map(grid.points.map(point=>[point.t,point.bar]))
  grid={...grid,start,end,points:Array.from({length:count},(_,i)=>({t:start+i*grid.step,bar:byTime.get(start+i*grid.step)??null}))}
 }
 return {grid,data:grid.points.map(({t,bar})=>!bar?{time:t/1000}:mode==='line'?{time:t/1000,value:bar.c}:{time:t/1000,open:bar.o,high:bar.h,low:bar.l,close:bar.c})}
}
const equal=(a,b)=>a&&b&&a.time===b.time&&a.value===b.value&&a.open===b.open&&a.high===b.high&&a.low===b.low&&a.close===b.close&&a.color===b.color
/** Historical corrections reset the series; last-bar changes append incrementally. */
export function writeChartSeries(series,previous,next) {
 const incremental=previous.length>0&&next.length>=previous.length&&previous.slice(0,-1).every((p,i)=>equal(p,next[i]))
 if(incremental){for(let i=previous.length-1;i<next.length;i++)if(!equal(previous[i],next[i]))series.update(next[i])}
 else series.setData(next)
 return next
}
export function continuousChartTime(grid,logical) {return grid&&Number.isFinite(logical)?grid.start+logical*grid.step:null}
export function continuousChartLogical(grid,time) {return grid&&Number.isFinite(time)?(time-grid.start)/grid.step:null}

// Follow new personal activity only when the viewport is still at the previous
// requested right edge. A panned or saved historical view retains its times.
export function refreshedChartViewport(range,oldGrid,newGrid,previousWindow,nextWindow,followLatest=true) {
 if(!range||!oldGrid||!newGrid)return null
 let from=continuousChartTime(oldGrid,range.from),to=continuousChartTime(oldGrid,range.to)
 if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to)return null
 const tolerance=Math.max(1,oldGrid.step*0.000001)
 const advance=followLatest&&Number.isFinite(previousWindow?.to)&&Number.isFinite(nextWindow?.to)&&nextWindow.to>previousWindow.to&&Math.abs(to-previousWindow.to)<=tolerance
 if(advance){const delta=nextWindow.to-to;from+=delta;to=nextWindow.to}
 if(!advance&&oldGrid.start===newGrid.start&&oldGrid.step===newGrid.step)return null
 return {from:continuousChartLogical(newGrid,from),to:continuousChartLogical(newGrid,to)}
}

/** One precision across the entire price axis, including values either side of
 * one dollar. Tiny positive prices must never format as zero. */
export function chartPriceFormat(bars){
 const values=bars.flatMap(b=>[b.l??b.c,b.h??b.c]).filter(n=>Number.isFinite(n)&&n>0)
 const low=values.length?Math.min(...values):1,high=values.length?Math.max(...values):1,span=high-low
 const magnitude=(low+high)/2,step=span>0?span/10:magnitude/10000
 const digits=Math.min(16,Math.max(magnitude<10?4:2,Math.ceil(-Math.log10(step))+1))
 // Arbitrary magnitude-derived increments can produce a tick base the renderer
 // rejects. Use a decimal base explicitly to avoid reciprocal rounding too.
 // This is display precision, not an exchange execution increment.
 const tickDigits=Math.min(308,Math.max(digits,Math.ceil(4-Math.log10(magnitude))))
 const base=10**tickDigits,minMove=1/base
 return {type:'custom',base,minMove,formatter:n=>!Number.isFinite(n)?'—':n!==0&&Math.abs(n)<1e-12?n.toExponential(4):n.toLocaleString(undefined,{minimumFractionDigits:Math.min(4,digits),maximumFractionDigits:digits})}
}

/** Give every omitted study value an explicit whitespace slot. */
export function studyRendererData(points,grid) {
 const values=new Map(points.map(p=>[p.t,p.value]))
 return grid.points.map(({t})=>Number.isFinite(values.get(t))?{time:t/1000,value:values.get(t)}:{time:t/1000})
}
