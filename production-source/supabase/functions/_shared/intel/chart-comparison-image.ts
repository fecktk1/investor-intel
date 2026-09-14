import {comparisonTimeline,comparisonWindow,comparisonPriceDomain} from './chart-comparison.ts'
import {validateChartLayout} from './chart-workspace-contract.ts'
const escape=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!))
const n=(v:number)=>Number.isFinite(v)?Number(v.toFixed(3)):0
export function chartComparisonImage(state:any){
 const layout=validateChartLayout(state.layout),comparison=layout.comparison!
 if(!comparison||state.comparisonSeries?.length!==comparison.assets.length)throw new Error('invalid_snapshot_comparison_capture')
 const model=comparisonTimeline(comparison.assets.map(a=>{const s=state.comparisonSeries.find((c:any)=>c.asset===a.asset);return {...a,candles:s?.bars||[],chartSource:s?.source}}),state.createdAt??state.capturedAt)
 const rows=comparisonWindow(model,layout.range),returns=comparison.arrangement==='overlay'||comparison.priceScale==='returns'
 if(!rows.length||model.limited)throw new Error('chart_snapshot_export_empty')
 if(returns&&model.baseline==null)throw new Error('chart_snapshot_export_unaligned')
 const light=layout.theme==='light',bg=light?'#F6F5F1':'#14171C',fg=light?'#202630':'#EEF0F3',muted=light?'#505966':'#A7AFBC',gold=light?'#8B5D12':'#DFA647',colors=[gold,'#5687AF','#398B72','#9274B2'],border=light?'#CBD0D6':'#343B46'
 const width=1400,left=65,right=1335,cols=comparison.arrangement==='overlay'?1:comparison.arrangement==='2x2'?2:model.series.length,plotHeight=comparison.arrangement==='overlay'?420:280,gap=40,pw=(right-left-(cols-1)*gap)/cols
 const clock=(t:number)=>new Date(t).toLocaleString('en-US',{timeZone:layout.timezone,dateStyle:'medium',timeStyle:'short'})
 const text=(x:number,y:number,value:unknown,size=14,color=muted)=>`<text x="${n(x)}" y="${n(y)}" font-size="${size}" fill="${color}">${escape(value)}</text>`
 const body=[text(left,40,'INVESTOR INTEL',17,gold),...((state.title as string).match(/.{1,65}/gu)||['']).map((v,i)=>text(left,80+i*32,v,27,fg))],top=175+Math.max(0,Math.ceil(state.title.length/65)-1)*32
 body.push(text(left,top-48,`${comparison.arrangement==='overlay'?'Return overlay':comparison.arrangement+' charts'} · ${returns?'aligned returns':comparison.priceScale+' prices'} · ${layout.timezone}`),text(left,top-25,`${clock(layout.range.from)} — ${clock(layout.range.to)}`))
 const groups=comparison.arrangement==='overlay'?[model.series]:model.series.map(s=>[s]),suffix=returns?'_return':'',currencies=new Set(model.series.map(s=>s.chartSource?.currency)),shared=returns||comparison.priceScale==='shared'&&currencies.size===1&&model.series.every(s=>s.chartSource?.currency)
 groups.forEach((members,index)=>{
  const x=left+(index%cols)*(pw+gap),y=top+Math.floor(index/cols)*(plotHeight+90),bounds=comparisonPriceDomain(rows,(shared?model.series:members).map(s=>s.key+suffix)),tx=(t:number)=>x+(t-layout.range.from)/(layout.range.to-layout.range.from)*pw,ty=(v:number)=>y+plotHeight-(v-bounds[0])/(bounds[1]-bounds[0])*plotHeight
  body.push(text(x,y-8,members.map(s=>s.label).join(' / '),16,fg))
  for(let i=0;i<=4;i++){const v=bounds[1]-i*(bounds[1]-bounds[0])/4,py=y+i*plotHeight/4;body.push(`<line x1="${n(x)}" x2="${n(x+pw)}" y1="${n(py)}" y2="${n(py)}" stroke="${border}"/>`,text(x+4,py+16,Number(v.toPrecision(5)).toLocaleString('en-US')+(returns?'%':` ${members[0].chartSource.currency}`),11))}
  for(const s of members){let path:string[]=[];let previous:number|null=null;const flush=()=>{if(path.length)body.push(`<polyline points="${path.join(' ')}" fill="none" stroke="${colors[model.series.indexOf(s)]}" stroke-width="2"/>`);path=[]};for(const row of rows){const value=row[s.key+suffix];if(value==null||previous!=null&&s.chartSource?.intervalMs&&row.t-previous>s.chartSource.intervalMs)flush();if(value!=null)path.push(`${n(tx(row.t))},${n(ty(value))}`);previous=row.t}flush()}
  body.push(text(x,y+plotHeight+24,clock(layout.range.from),11),text(Math.max(x,x+pw-175),y+plotHeight+43,clock(layout.range.to),11))
 })
 let bottom=top+Math.ceil(groups.length/cols)*(plotHeight+90)
 const wrap=(v:string)=>v.match(/.{1,145}/gu)||['']
 const lines=[returns?`Common baseline: ${clock(model.baseline!)}; ${model.sharedCount} matching observations. Missing prices remain gaps.`:'Recorded close/observation times; no price or execution time is inferred.',`Captured ${clock(state.createdAt??state.capturedAt)} · calculation ${state.calculationVersion} / close-aligned-1`]
 for(const s of state.comparisonSeries)lines.push(`${comparison.assets.find(a=>a.asset===s.asset)?.label} · ${s.asset} · ${s.source.provider} · ${s.source.currency} · ${s.barCount} original observations · captured ${clock(s.capturedAt)}`,`Series SHA-256 ${s.sourceHash}`,s.source.provider==='coinmarketcap'?'Data provided by CoinMarketCap.com':`Source reference: ${s.source.sourceUrl||'not recorded'}`)
 for(const value of lines)for(const row of wrap(value)){body.push(text(left,bottom,row,13));bottom+=22}
 const height=Math.ceil(bottom+35),svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Investor Intel comparison snapshot"><title>${escape(state.title)}</title><rect width="100%" height="100%" fill="${bg}"/><g font-family="Inter,Arial,sans-serif">${body.join('')}</g></svg>`
 if(new TextEncoder().encode(svg).length>2500000||height>8192)throw new Error('chart_snapshot_export_size_limit')
 return {svg,width,height,annotationCount:0,format:'svg',pngAvailable:true}
}
