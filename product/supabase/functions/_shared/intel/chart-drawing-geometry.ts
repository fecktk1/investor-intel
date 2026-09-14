import type {ChartDrawing,ChartAnchor} from './chart-workspace-contract.ts'
export function drawingGeometry(drawing:ChartDrawing,project:(anchor:ChartAnchor)=>{x:number;y:number}|null,width:number,height:number) {
 const anchors=drawing.anchors.map(project)
 if(anchors.some(a=>!a||!Number.isFinite(a.x)||!Number.isFinite(a.y)))return null
 const [a,b]=anchors as {x:number;y:number}[],lines:{x1:number;y1:number;x2:number;y2:number}[]=[],rectangles:{x:number;y:number;width:number;height:number}[]=[],labels:{x:number;y:number;text:string}[]=[]
 if(drawing.tool==='horizontal')lines.push({x1:0,y1:a.y,x2:width,y2:a.y})
 else if(drawing.tool==='text')labels.push({x:a.x+6,y:a.y-8,text:drawing.text||'Annotation'})
 else if(drawing.tool==='rectangle'||drawing.tool==='price_range'){
  rectangles.push({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(b.x-a.x),height:Math.abs(b.y-a.y)})
  if(drawing.tool==='price_range'){const change=(drawing.anchors[1].price/drawing.anchors[0].price-1)*100;labels.push({x:Math.min(a.x,b.x)+6,y:Math.min(a.y,b.y)+16,text:`${change>=0?'+':''}${change.toFixed(2)}%`})}
 }else if(drawing.tool==='fibonacci'){
  for(const ratio of drawing.ratios||[]){const value=drawing.anchors[1].price+(drawing.anchors[0].price-drawing.anchors[1].price)*ratio,point=project({t:drawing.anchors[1].t,price:value})
   if(!point)continue
   lines.push({x1:Math.min(a.x,b.x),x2:Math.max(a.x,b.x),y1:point.y,y2:point.y});labels.push({x:Math.max(a.x,b.x)+4,y:point.y-4,text:`${ratio} · ${value.toLocaleString(undefined,{maximumFractionDigits:8})}`})
  }
 }else {
  const rayX=b.x<a.x?0:width
  const end=drawing.tool==='ray'?(a.x===b.x?{x:a.x,y:b.y<a.y?0:height}:{x:rayX,y:a.y+(b.y-a.y)*(rayX-a.x)/(b.x-a.x)}):b
  lines.push({x1:a.x,y1:a.y,x2:end.x,y2:end.y})
  if(drawing.tool==='arrow'){
   const angle=Math.atan2(b.y-a.y,b.x-a.x)
   for(const shift of [-0.5,0.5])lines.push({x1:b.x,y1:b.y,x2:b.x-12*Math.cos(angle+shift),y2:b.y-12*Math.sin(angle+shift)})
  }
 }
 if(drawing.text&&drawing.tool!=='text')labels.push({x:a.x+6,y:a.y-8,text:drawing.text})
 return {anchors,lines,rectangles,labels}
}
