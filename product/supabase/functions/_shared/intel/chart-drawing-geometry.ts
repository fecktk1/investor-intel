import type {ChartDrawing,ChartAnchor} from './chart-workspace-contract.ts'
export type DrawingGeometryOptions={intervalMs?:number|null}
const number=(v:number)=>v.toLocaleString(undefined,{maximumFractionDigits:8})
// The handle a screen reader and the pointer both target for a marker glyph.
const MARKER=11
export function drawingGeometry(drawing:ChartDrawing,project:(anchor:ChartAnchor)=>{x:number;y:number}|null,width:number,height:number,options:DrawingGeometryOptions={}) {
 const anchors=drawing.anchors.map(project)
 if(anchors.some(a=>!a||!Number.isFinite(a.x)||!Number.isFinite(a.y)))return null
 const [a,b,c]=anchors as {x:number;y:number}[]
 const lines:{x1:number;y1:number;x2:number;y2:number}[]=[],rectangles:{x:number;y:number;width:number;height:number}[]=[],labels:{x:number;y:number;text:string}[]=[],polygons:{points:{x:number;y:number}[]}[]=[]
 // Change, percent and elapsed bars between the two anchors of a measurement.
 let metrics:{change:number;percent:number;bars:number|null}|null=null
 const through=(from:{x:number;y:number},to:{x:number;y:number},x:number)=>from.x===to.x?{x:from.x,y:to.y<from.y?0:height}:{x,y:from.y+(to.y-from.y)*(x-from.x)/(to.x-from.x)}
 if(drawing.tool==='horizontal')lines.push({x1:0,y1:a.y,x2:width,y2:a.y})
 else if(drawing.tool==='horizontal_ray')lines.push({x1:a.x,y1:a.y,x2:width,y2:a.y})
 else if(drawing.tool==='vertical')lines.push({x1:a.x,y1:0,x2:a.x,y2:height})
 else if(drawing.tool==='text')labels.push({x:a.x+6,y:a.y-8,text:drawing.text||'Annotation'})
 else if(drawing.tool==='price_label'){
  const caption=`${number(drawing.anchors[0].price)}`
  rectangles.push({x:a.x,y:a.y-9,width:Math.max(34,caption.length*7+10),height:18})
  labels.push({x:a.x+5,y:a.y+4,text:caption})
 }else if(drawing.tool==='tweet'){
  // The card itself is rendered by the client from the fetched post; an image
  // export keeps the anchor box and the author the address already reveals.
  rectangles.push({x:a.x,y:a.y-14,width:210,height:28})
  labels.push({x:a.x+7,y:a.y+4,text:`@${drawing.url?.split('/')[3]||''}`})
 }else if(drawing.tool==='arrow_up'||drawing.tool==='arrow_down'){
  const up=drawing.tool==='arrow_up',tip=up?a.y-2:a.y+2,base=up?tip+MARKER:tip-MARKER
  polygons.push({points:[{x:a.x,y:tip},{x:a.x-MARKER*0.6,y:base},{x:a.x+MARKER*0.6,y:base}]})
  lines.push({x1:a.x,y1:tip,x2:a.x-MARKER*0.6,y2:base},{x1:a.x-MARKER*0.6,y1:base,x2:a.x+MARKER*0.6,y2:base},{x1:a.x+MARKER*0.6,y1:base,x2:a.x,y2:tip})
 }else if(drawing.tool==='rectangle'||drawing.tool==='price_range'||drawing.tool==='measure'){
  rectangles.push({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(b.x-a.x),height:Math.abs(b.y-a.y)})
  if(drawing.tool!=='rectangle'){
   const [from,to]=drawing.anchors,change=to.price-from.price,percent=(to.price/from.price-1)*100
   const step=options.intervalMs
   metrics={change,percent,bars:step&&step>0?Math.round(Math.abs(to.t-from.t)/step):null}
   labels.push({x:Math.min(a.x,b.x)+6,y:Math.min(a.y,b.y)+16,text:drawing.tool==='price_range'?`${percent>=0?'+':''}${percent.toFixed(2)}%`:`${change>=0?'+':''}${number(change)} · ${percent>=0?'+':''}${percent.toFixed(2)}%`})
  }
 }else if(drawing.tool==='fibonacci'){
  for(const ratio of drawing.ratios||[]){const value=drawing.anchors[1].price+(drawing.anchors[0].price-drawing.anchors[1].price)*ratio,point=project({t:drawing.anchors[1].t,price:value})
   if(!point)continue
   lines.push({x1:Math.min(a.x,b.x),x2:Math.max(a.x,b.x),y1:point.y,y2:point.y});labels.push({x:Math.max(a.x,b.x)+4,y:point.y-4,text:`${ratio} · ${number(value)}`})
  }
 }else if(drawing.tool==='channel'){
  // Anchors one and two carry the base line; anchor three sets the parallel offset.
  const offset=c.y-through(a,b,c.x).y
  const shifted=[{x:a.x,y:a.y+offset},{x:b.x,y:b.y+offset}]
  lines.push({x1:a.x,y1:a.y,x2:b.x,y2:b.y},{x1:shifted[0].x,y1:shifted[0].y,x2:shifted[1].x,y2:shifted[1].y})
  polygons.push({points:[a,b,shifted[1],shifted[0]]})
 }else {
  const forward=b.x<a.x?0:width,backward=b.x<a.x?width:0
  const end=drawing.tool==='ray'||drawing.tool==='extended'?through(a,b,forward):b
  const begin=drawing.tool==='extended'?through(a,b,backward):a
  lines.push({x1:begin.x,y1:begin.y,x2:end.x,y2:end.y})
  if(drawing.tool==='arrow'){
   const angle=Math.atan2(b.y-a.y,b.x-a.x)
   for(const shift of [-0.5,0.5])lines.push({x1:b.x,y1:b.y,x2:b.x-12*Math.cos(angle+shift),y2:b.y-12*Math.sin(angle+shift)})
  }
 }
 if(drawing.text&&drawing.tool!=='text'&&drawing.tool!=='tweet')labels.push({x:a.x+6,y:a.y-8,text:drawing.text})
 return {anchors,lines,rectangles,labels,polygons,metrics}
}
