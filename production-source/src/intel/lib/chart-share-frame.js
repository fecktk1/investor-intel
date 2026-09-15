import {drawingGeometry} from './chart-drawings'
import {DRAWING_DASH_PATTERN} from './chart-drawing-tools'

/** Captures the live chart for the share image.
 *
 * Two things happen here that cannot happen in the compositor, because both
 * need the live renderer: the screenshot, and the portrait resize.
 *
 * A portrait frame's plot slot is nearly square, and the chart on screen is
 * wide. Fitting the wide chart into that slot letterboxed it, so the posted
 * image was a strip of chart floating in black. Instead the chart is resized to
 * the slot's own aspect, repainted synchronously, photographed and restored in
 * the same task, so it fills the slot and the screen never moves: the browser
 * cannot paint between the resize and the restore.
 *
 * Drawings are therefore NOT taken from the on-screen SVG, whose pixels belong
 * to the old height. Their anchors are times and prices, so they are projected
 * again through the workstation's own projection while the chart is at the
 * captured size, which is the only way a trend line still touches the same
 * candles in the image.
 *
 * Everything degrades rather than fails. If the renderer refuses the resize,
 * the chart's real proportions are read back off the screenshot, so the image
 * letterboxes as before instead of stretching the chart to fit. */

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))
const round=value=>Number.isFinite(value)?Number(value.toFixed(2)):0
const dashed=drawing=>{const pattern=DRAWING_DASH_PATTERN[drawing.dash||'solid'];return pattern?` stroke-dasharray="${pattern}"`:''}

/** The drawings as standalone SVG, in the same shapes and colours the drawing
 * surface paints on screen. Returns null when nothing projects, so a chart with
 * no drawings composes without an overlay pass at all. */
export function chartDrawingsSvg(drawings,project,width,height,intervalMs=null) {
 const body=[]
 for(const drawing of drawings||[]){
  const geometry=drawingGeometry(drawing,project,width,height,{intervalMs})
  if(!geometry)continue
  const marker=drawing.tool==='arrow_up'||drawing.tool==='arrow_down'
  for(const polygon of geometry.polygons)body.push(`<polygon points="${polygon.points.map(p=>`${round(p.x)},${round(p.y)}`).join(' ')}" fill="${marker?drawing.color:`${drawing.color}1f`}"/>`)
  for(const line of geometry.lines)body.push(`<line x1="${round(line.x1)}" y1="${round(line.y1)}" x2="${round(line.x2)}" y2="${round(line.y2)}" stroke="${drawing.color}" stroke-width="${drawing.width}"${dashed(drawing)}/>`)
  for(const rect of geometry.rectangles)body.push(`<rect x="${round(rect.x)}" y="${round(rect.y)}" width="${round(rect.width)}" height="${round(rect.height)}" fill="${drawing.color}12" stroke="${drawing.color}" stroke-width="${drawing.width}"${dashed(drawing)}/>`)
  for(const label of geometry.labels){
   const lines=String(label.text??'').split('\n').slice(0,drawing.tool==='text'?3:1)
   body.push(`<text x="${round(label.x)}" y="${round(label.y)}" fill="${drawing.color}" font-size="12">${lines.map((line,i)=>`<tspan x="${round(label.x)}"${i?' dy="15"':''}>${escape(line.slice(0,100))}</tspan>`).join('')}</text>`)
  }
 }
 return body.length?`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter, Arial, sans-serif">${body.join('')}</svg>`:null
}

/** The frame the compositor draws: the screenshot, the projected drawings, the
 * brand mark and the header facts the chart itself knows. `aspect` is the
 * width-to-height ratio the image's plot slot wants; leave it out to capture
 * the chart exactly as it stands. */
export function chartShareFrame({chart,project,element,height,aspect=null,range=null,bars=[],drawings=[],intervalMs=null,background='#14171C',wordmark=null,name='',symbol=''}) {
 const width=element.clientWidth
 const shown=range?bars.filter(bar=>bar.t>=range.from&&bar.t<=range.to):bars
 const target=Number(aspect)>0?Math.max(160,Math.round(width/Number(aspect))):null
 const resize=target&&target!==height&&typeof chart.resize==='function'
 let canvas,plotWidth,plotHeight,overlay=null
 try{
  if(resize)chart.resize(width,target,true)
  canvas=chart.takeScreenshot()
  plotHeight=canvas?.width>0?Math.round(width*canvas.height/canvas.width):height
  plotWidth=chart.timeScale().width()||width
  overlay=chartDrawingsSvg(drawings,project,plotWidth,plotHeight,intervalMs)
 }finally{if(resize)chart.resize(width,height,true)}
 return {chart:{canvas,width,height:plotHeight},
  overlay:overlay?{svg:overlay,width:plotWidth,height:plotHeight}:null,
  background,wordmark,name,symbol,
  first:shown[0]?.o??shown[0]?.c??null,last:shown.at(-1)?.c??null,interval:intervalMs}
}
