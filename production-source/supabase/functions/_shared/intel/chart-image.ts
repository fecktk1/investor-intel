import {normalizeBars,calculateStudies,regularBarGrid,CHART_ANALYSIS_VERSION} from './chart-analysis.ts'
import {validateChartLayout,isUuid} from './chart-workspace-contract.ts'
import {drawingGeometry} from './chart-drawing-geometry.ts'
import {chartComparisonImage} from './chart-comparison-image.ts'
import {replayBars} from './chart-replay-projection.ts'
const escape=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!))
const n=(v:number)=>Number.isFinite(v)?Number(v.toFixed(3)):0
const text=(x:number,y:number,value:unknown,size=15,color='#A7AFBC')=>`<text x="${n(x)}" y="${n(y)}" font-size="${size}" fill="${color}">${escape(value)}</text>`
const line=(x1:number,y1:number,x2:number,y2:number,color='#343B46',width=1)=>`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${color}" stroke-width="${width}"/>`
/** Static, source-verified snapshot export. No browser DOM, external images or URLs. */
export function chartImage(state:any,includeDrawingIds:unknown=[]){
 const layout=validateChartLayout(state.layout),ids=includeDrawingIds
 if(!Array.isArray(ids)||ids.length>200||new Set(ids).size!==ids.length||ids.some(id=>!isUuid(id)||!layout.drawings.some(d=>d.id===id)))throw new Error('invalid_snapshot_annotations')
 if(layout.replay&&ids.length)throw new Error('invalid_replay_snapshot_annotations')
 if(layout.comparison){if(ids.length||layout.studies.length)throw new Error('chart_snapshot_comparison_annotations_unavailable');return chartComparisonImage(state)}
 const normalized=normalizeBars(state.bars),all=replayBars(normalized.bars,layout.replay),bars=all.filter(b=>b.t>=layout.range.from&&b.t<=layout.range.to)
 if(normalized.rejected||normalized.truncated||!bars.length)throw new Error('chart_snapshot_export_empty')
 const drawings=layout.drawings.filter(d=>ids.includes(d.id)),studies=calculateStudies(all,layout.studies,{intervalMs:state.source.intervalMs}),panes=[...new Set(studies.filter(s=>s.pane!=='price'&&!s.reason).map(s=>s.pane))]
 if(panes.length>3)throw new Error('chart_snapshot_export_pane_limit')
 const light=layout.theme==='light',bg=light?'#F6F5F1':'#14171C',fg=light?'#202630':'#EEF0F3',muted=light?'#505966':'#A7AFBC',gold=light?'#8B5D12':'#DFA647',green=light?'#16724D':'#6CC6A2',red=light?'#B23439':'#E89A9D'
 const titleLines=String(state.title).slice(0,120).match(/.{1,65}/gu)||[''],titleOffset=(titleLines.length-1)*34
 const width=1400,left=65,right=1280,top=175+titleOffset,plotHeight=470,plotWidth=right-left,{from,to}=layout.range,base=bars[0].c
 const tx=(t:number)=>left+(t-from)/(to-from)*plotWidth,transform=(v:number)=>layout.scale==='log'?Math.log(v):layout.scale==='percent'?(v/base-1)*100:layout.scale==='indexed'?v/base*100:v
 const observed=(p:{t:number;value:number})=>p.t>=from&&p.t<=to&&Number.isFinite(p.value)&&(layout.scale!=='log'||p.value>0)
 const bounds=bars.flatMap(b=>[transform(b.l??b.c),transform(b.h??b.c)]).concat(studies.filter(s=>s.pane==='price').flatMap(s=>s.series.flatMap(series=>series.points.filter(observed).map(p=>transform(p.value)))))
 const lo=bounds.reduce((a,b)=>Math.min(a,b),Infinity),hi=bounds.reduce((a,b)=>Math.max(a,b),-Infinity),padding=Math.max((hi-lo)*.08,Math.abs(hi)*.005,1e-10),min=lo-padding,max=hi+padding
 const ty=(v:number)=>top+plotHeight-(transform(v)-min)/(max-min)*plotHeight
 const fmt=(v:number)=>v.toLocaleString('en-US',{maximumFractionDigits:Math.abs(v)<1?8:2})
 const clock=(t:number)=>new Date(t).toLocaleString('en-US',{timeZone:layout.timezone,dateStyle:'medium',timeStyle:'short'})
 const body:string[]=[text(left,44,'INVESTOR INTEL',17,gold),...titleLines.map((row,i)=>text(left,86+i*34,row,29,fg)),text(left,116+titleOffset,`${layout.asset} · ${layout.mode} · ${layout.scale} scale · ${state.source.currency}`,15,muted),text(left,143+titleOffset,`${clock(from)} — ${clock(to)} · ${layout.timezone}`,14,muted)]
 for(let i=0;i<=4;i++){const y=top+i*plotHeight/4,v=max-i*(max-min)/4;body.push(line(left,y,right,y),text(right+12,y+5,fmt(layout.scale==='log'?Math.exp(v):v)+(layout.scale==='percent'?'%':''),13,muted))}
 for(let i=0;i<=4;i++){const t=from+(to-from)*i/4;body.push(text(tx(t)-(i===4?155:0),top+plotHeight+25,new Date(t).toLocaleDateString('en-US',{timeZone:layout.timezone,month:'short',day:'numeric'}),13,muted))}
 const grid=regularBarGrid(all,state.source.intervalMs??undefined),barWidth=Math.max(.6,Math.min(14,(grid?.step??(to-from)/bars.length)/(to-from)*plotWidth*.65))
 body.push('<g clip-path="url(#price-clip)">')
 if(layout.mode==='line'||bars.some(b=>b.o==null)){
  // Break at missing observations instead of bridging a known gap.
  let run:string[]=[];for(let i=0;i<bars.length;i++){if(i&&grid&&bars[i].t-bars[i-1].t>grid.step){body.push(`<polyline points="${run.join(' ')}" fill="none" stroke="${gold}" stroke-width="2"/>`);run=[]}run.push(`${n(tx(bars[i].t))},${n(ty(bars[i].c))}`)}body.push(`<polyline points="${run.join(' ')}" fill="none" stroke="${gold}" stroke-width="2"/>`)
 }else for(const b of bars){const x=tx(b.t),color=b.c>=b.o!?green:red;body.push(line(x,ty(b.h!),x,ty(b.l!),color));if(layout.mode==='ohlc')body.push(line(x-barWidth/2,ty(b.o!),x,ty(b.o!),color),line(x,ty(b.c),x+barWidth/2,ty(b.c),color));else body.push(`<rect x="${n(x-barWidth/2)}" y="${n(Math.min(ty(b.o!),ty(b.c)))}" width="${n(barWidth)}" height="${n(Math.max(1,Math.abs(ty(b.o!)-ty(b.c))))}" fill="${color}"/>`)}
 const plotLines=(points:{t:number;value:number}[],y:(v:number)=>number,color:string)=>{const parts:string[][]=[[]],step=state.source.intervalMs??grid?.step;for(let i=0;i<points.length;i++){if(i&&step&&points[i].t-points[i-1].t>step)parts.push([]);parts.at(-1)!.push(`${n(tx(points[i].t))},${n(y(points[i].value))}`)}return parts.map(p=>`<polyline points="${p.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5"/>`).join('')}
 const colors=[gold,'#82ABD2','#B4A0DC',green,red]
 for(const [i,study]of studies.filter(s=>s.pane==='price').entries())for(const [j,series]of study.series.entries())body.push(plotLines(series.points.filter(observed),ty,colors[(i+j)%colors.length]))
 for(const [index,d]of drawings.entries()){
  const geometry=drawingGeometry(d,a=>layout.scale==='log'&&a.price<=0?null:{x:tx(a.t)-left,y:ty(a.price)-top},plotWidth,plotHeight)
  if(!geometry)continue
  for(const s of geometry.lines)body.push(line(left+s.x1,top+s.y1,left+s.x2,top+s.y2,d.color,d.width))
  for(const r of geometry.rectangles)body.push(`<rect x="${n(left+r.x)}" y="${n(top+r.y)}" width="${n(r.width)}" height="${n(r.height)}" fill="${d.color}" fill-opacity=".09" stroke="${d.color}"/>`)
  for(const label of geometry.labels){const caption=d.text.split('\n')[0];body.push(text(left+label.x,top+label.y,d.text&&label.text===d.text?`[${index+1}] ${caption.slice(0,70)}${caption.length>70?'…':''}`:label.text,13,d.color))}
 }
 body.push('</g>')
 let bottom=top+plotHeight+65
 if(layout.volume&&bars.every(b=>b.v!=null)){
  const maxVolume=Math.max(...bars.map(b=>b.v!));body.push(text(left,bottom,`Volume${state.source.volumeUnit?` · ${state.source.volumeUnit}`:''}`,14,muted));bottom+=12
  for(const b of bars)body.push(`<rect x="${n(tx(b.t)-barWidth/2)}" y="${n(bottom+70-(maxVolume?b.v!/maxVolume*70:0))}" width="${n(barWidth)}" height="${n(maxVolume?b.v!/maxVolume*70:0)}" fill="${gold}" fill-opacity=".55"/>`)
  bottom+=100
 }
 for(const pane of panes){
  const rows=studies.filter(s=>s.pane===pane).flatMap(s=>s.series),values=rows.flatMap(s=>s.points.filter(p=>p.t>=from&&p.t<=to).map(p=>p.value)),pmin=values.reduce((a,b)=>Math.min(a,b),0),pmax=['rsi','stoch_rsi','vwrsi'].includes(pane)?100:values.reduce((a,b)=>Math.max(a,b),0),py=(v:number)=>bottom+150-(v-pmin)/(pmax-pmin||1)*115
  body.push(line(left,bottom,right,bottom),text(left,bottom+23,pane.toUpperCase(),14,muted))
  for(const f of [0,.5,1]){const v=pmin+(pmax-pmin)*f;body.push(text(right+12,py(v)+4,fmt(v),12,muted))}
  if(['rsi','stoch_rsi','vwrsi'].includes(pane))for(const level of [30,70])body.push(line(left,py(level),right,py(level)))
  body.push(text(left+170,bottom+23,rows.map((r,i)=>`${i+1}: ${r.name}`).join(' · ').slice(0,140),12,muted))
  for(const [i,series]of rows.entries()){const points=series.points.filter(p=>p.t>=from&&p.t<=to);if(series.kind==='histogram')for(const p of points)body.push(line(tx(p.t),py(0),tx(p.t),py(p.value),p.value>=0?green:red,Math.min(barWidth,5)));else body.push(plotLines(points,py,colors[i%colors.length]))}bottom+=180
 }
 const wrap=(value:string,length=140)=>value.split('\n').flatMap(row=>row.match(new RegExp(`.{1,${length}}`,'gu'))||[''])
 body.push(line(left,bottom,right,bottom));bottom+=28
 for(const [index,d]of drawings.entries()){
  for(const row of wrap(`[${index+1}] ${d.tool.replaceAll('_',' ')} · ${d.anchors.map(a=>`${clock(a.t)} @ ${fmt(a.price)}`).join(' → ')}${d.text?`\n${d.text}`:''}`)){body.push(text(left,bottom,row,14,fg));bottom+=21}bottom+=9
 }
 for(const study of studies){for(const row of wrap(`${study.type}: ${study.reason||study.definition}`)){body.push(text(left,bottom,row,13,muted));bottom+=20}}
 const metadata=[`Source: ${state.source.provider} · ${state.source.currency} · ${grid?`${grid.step/60000} minute observation spacing`:'Irregular observations'} · ${state.source.timestampMeaning||'clock unknown'}`,
  `Captured ${clock(state.capturedAt)} · latest observation ${clock(bars.at(-1)!.t)} · calculation ${CHART_ANALYSIS_VERSION} (capture ${state.calculationVersion}) · static auto-fit export`,
  `Series SHA-256 ${state.sourceHash} (original capture)`,`Source reference: ${state.source.sourceUrl||'not recorded'}`,
  ...layout.replay?[`Replay through ${new Date(layout.replay.at).toISOString()} · recorded-only ${layout.replay.knownOnly} · retrospective checkpoint, saved later`,`Replay subset SHA-256 ${state.replaySeriesHash}`]:[],
  'Only selected annotations are included. No holdings or trade history.']
 for(const value of metadata){for(const row of wrap(value)){body.push(text(left,bottom+20,row,13,muted));bottom+=21}}
 const height=Math.ceil(bottom+50),svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Investor Intel chart snapshot"><title>${escape(state.title)}</title><defs><clipPath id="price-clip"><rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/></clipPath></defs><rect width="100%" height="100%" fill="${bg}"/><g font-family="Inter,Arial,sans-serif">${body.join('')}</g></svg>`
 if(new TextEncoder().encode(svg).length>2500000||height>60000)throw new Error('chart_snapshot_export_size_limit')
 return {svg,width,height,annotationCount:drawings.length,format:'svg',pngAvailable:height<=8192}
}
