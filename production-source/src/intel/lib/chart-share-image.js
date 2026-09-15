/** The brand share image: the chart on screen, composed as a TheContentForge
 * post card.
 *
 * The reference is the brand's own feed: a near-black ground lit from below by
 * a warm forge glow, one large white headline with its key figure in gold, the
 * product inside a thin gold-hairline frame, tracked small caps for captions,
 * and the wordmark (white with "Forge" in gold) at the foot with the site
 * address beneath it.
 *
 * The chart pixels arrive as the renderer's own screenshot, so the image
 * carries what the owner is actually looking at, indicator panes included.
 * Drawings live in a separate SVG overlay on screen; that markup is rasterized
 * and drawn back at the same origin, so an annotated chart shares annotated.
 * The plot watermark keeps the on-screen rule (38% of the plot, capped at the
 * same 300px it is capped at on screen, at the same opacity) rather than
 * inventing a second mark for the export.
 *
 * Nothing here reaches the network. The screenshot is a canvas, the overlay is
 * serialized markup and the brand files are same-origin, so the composed
 * canvas is never tainted and always encodes.
 *
 * `createCanvas` and `loadImage` are injectable so the composition can be
 * measured, and previewed, without a rasterizer. Nothing else is imported
 * here on purpose: this module has to run unchanged in the browser, in the
 * jsdom suite and under plain node. */

export const SHARE_IMAGE_COLORS={
 ground:'#060708',panel:'#0E1013',plot:'#0E1013',
 gold:'#E8A93B',goldDeep:'#C46A12',goldLight:'#FFD24A',
 text:'#F4F1EA',muted:'#8E96A3',faint:'#5C6470',
 hairline:'rgba(232,169,59,0.34)',glow:'rgba(214,121,26,0.30)',halo:'rgba(232,169,59,0.16)',
 up:'#6CC6A2',down:'#E89A9D',
}

// Two posting shapes, both at 2x device pixels. Every number is a design pixel
// in the size's own frame; nothing is a ratio of anything else, so a header
// that reads well at 1600 wide cannot drift when the portrait frame changes.
const LAYOUTS={
 landscape:{width:1600,height:900,margin:80,
  mark:{x:80,y:52,size:40},brand:{x:134,y:80,size:22},brandSub:{y:104,size:15},stamp:{y:82,size:13,tracking:3},
  name:{y:196,size:60},symbol:{size:28,gap:18},price:{y:196,size:54,align:'right'},change:{y:236,size:24,align:'right',gap:0},
  meta:{y:240,size:19},panel:{y:272,bottom:760,radius:20,pad:14},
  rule:{y:800},brandmark:{y:822,height:30},site:{y:882,size:14,tracking:2}},
 portrait:{width:1080,height:1350,margin:64,
  mark:{x:64,y:52,size:40},brand:{x:118,y:80,size:22},brandSub:{y:104,size:15},stamp:{y:82,size:12,tracking:3},
  name:{y:208,size:56},symbol:{size:26,gap:16},price:{y:272,size:48,align:'left'},change:{y:272,size:22,align:'left',gap:18},
  meta:{y:314,size:18},panel:{y:350,bottom:1164,radius:20,pad:14},
  rule:{y:1206},brandmark:{y:1230,height:30},site:{y:1292,size:14,tracking:2}},
}

export const SHARE_IMAGE_SIZES=Object.keys(LAYOUTS)

/** The resolved frame for one size: every band, plus the panel and the plot
 * rectangle the chart is fitted into. Pure, so layout is assertable without a
 * canvas. */
export function chartShareImageLayout(size) {
 const base=LAYOUTS[size]||LAYOUTS.landscape
 const width=base.width-base.margin*2
 const panel={x:base.margin,y:base.panel.y,width,height:base.panel.bottom-base.panel.y,radius:base.panel.radius,pad:base.panel.pad}
 const plot={x:panel.x+panel.pad,y:panel.y+panel.pad,width:panel.width-panel.pad*2,height:panel.height-panel.pad*2}
 return {...base,content:width,panel,plot}
}

/** Contains a source rectangle inside a box, centred, never upscaled past the
 * box. The scale is returned because the drawings overlay must land on the
 * screenshot with exactly the same factor. */
export function chartShareImageFit(width,height,box) {
 const source={width:Number(width)>0?Number(width):box.width,height:Number(height)>0?Number(height):box.height}
 const scale=Math.min(box.width/source.width,box.height/source.height)
 const drawn={width:source.width*scale,height:source.height*scale}
 return {x:box.x+(box.width-drawn.width)/2,y:box.y+(box.height-drawn.height)/2,...drawn,scale}
}

const defaultCanvas=(width,height)=>{
 if(typeof document==='undefined')throw new Error('canvas_unavailable')
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas
}
const defaultImage=src=>new Promise((resolve,reject)=>{
 const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('image_unavailable'));image.src=src
})
// An overlay serialized from the live document carries its pixel width and
// height but no viewBox, which would rasterize at one size and then stretch.
const overlaySource=overlay=>{
 const markup=/viewBox=/.test(overlay.svg)?overlay.svg:overlay.svg.replace('<svg',`<svg viewBox="0 0 ${overlay.width} ${overlay.height}"`)
 return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
}
const withFont=(ctx,weight,size)=>{ctx.font=`${weight} ${size}px Inter, "Segoe UI", Arial, sans-serif`}
const tracking=(ctx,px)=>{if('letterSpacing' in ctx)ctx.letterSpacing=`${px}px`}
const clipText=(ctx,value,max)=>{
 let text=String(value??'')
 if(!text||!(max>0)||ctx.measureText(text).width<=max)return text
 while(text.length>1&&ctx.measureText(`${text}…`).width>max)text=text.slice(0,-1)
 return `${text}…`
}
const roundedPath=(ctx,x,y,width,height,radius)=>{
 const r=Math.min(radius,width/2,height/2)
 ctx.beginPath()
 ctx.moveTo(x+r,y);ctx.lineTo(x+width-r,y);ctx.arcTo(x+width,y,x+width,y+r,r)
 ctx.lineTo(x+width,y+height-r);ctx.arcTo(x+width,y+height,x+width-r,y+height,r)
 ctx.lineTo(x+r,y+height);ctx.arcTo(x,y+height,x,y+height-r,r)
 ctx.lineTo(x,y+r);ctx.arcTo(x,y,x+r,y,r);ctx.closePath()
}
const load=async(loader,src)=>{if(!src)return null;try{return await loader(src)}catch{return null}}

/** Composes the image and returns the canvas. `frame` carries the captured
 * chart ({canvas,width,height}), the optional drawings overlay ({svg,width,
 * height}), whether the plot mark has to be inverted for the chart's own
 * theme, the brand files (`wordmark` for the plot watermark, `brandmark` for
 * the coloured foot wordmark, `mark` for the top-left symbol) and the header
 * strings, which arrive already translated and already formatted by the app's
 * own number formatters. */
export async function composeChartShareImage(frame,options={}) {
 const size=SHARE_IMAGE_SIZES.includes(options.size)?options.size:'landscape'
 const scale=Number(options.scale)>0?Number(options.scale):2
 const layout=chartShareImageLayout(size)
 const canvas=(options.createCanvas||defaultCanvas)(Math.round(layout.width*scale),Math.round(layout.height*scale))
 const loader=options.loadImage||defaultImage
 const ctx=canvas.getContext('2d')
 if(!ctx)throw new Error('canvas_unavailable')
 ctx.scale(scale,scale)
 const header=frame.header||{},chart=frame.chart||{},{margin,content,panel,plot}=layout,right=layout.width-margin
 const C=SHARE_IMAGE_COLORS

 // Ground and the forge light: one warm glow rising from below the frame, one
 // faint gold cast from the top corner. Painted first so every band sits in it.
 ctx.fillStyle=C.ground
 ctx.fillRect(0,0,layout.width,layout.height)
 if(typeof ctx.createRadialGradient==='function'){
  const ember=ctx.createRadialGradient(layout.width/2,layout.height*1.08,0,layout.width/2,layout.height*1.08,layout.width*0.62)
  ember.addColorStop(0,C.glow);ember.addColorStop(0.55,'rgba(214,121,26,0.08)');ember.addColorStop(1,'rgba(214,121,26,0)')
  ctx.fillStyle=ember;ctx.fillRect(0,0,layout.width,layout.height)
  const cast=ctx.createRadialGradient(0,0,0,0,0,layout.width*0.55)
  cast.addColorStop(0,'rgba(232,169,59,0.10)');cast.addColorStop(1,'rgba(232,169,59,0)')
  ctx.fillStyle=cast;ctx.fillRect(0,0,layout.width,layout.height)
 }

 ctx.textBaseline='alphabetic';ctx.textAlign='left'

 // Top band: the symbol, the product name over the company name, and a tracked
 // caption on the right saying what the card is and when it was made.
 const mark=await load(loader,frame.mark)
 if(mark)ctx.drawImage(mark,layout.mark.x,layout.mark.y,layout.mark.size,layout.mark.size)
 const brandX=mark?layout.brand.x:margin
 withFont(ctx,600,layout.brand.size);ctx.fillStyle=C.text
 ctx.fillText(String(header.eyebrow||'Investor Intel'),brandX,layout.brand.y)
 withFont(ctx,500,layout.brandSub.size);ctx.fillStyle=C.muted
 ctx.fillText(String(header.company||'TheContentForge'),brandX,layout.brandSub.y)
 if(header.stamp){
  ctx.textAlign='right';withFont(ctx,600,layout.stamp.size);tracking(ctx,layout.stamp.tracking);ctx.fillStyle=C.gold
  ctx.fillText(String(header.stamp).toUpperCase(),right,layout.stamp.y)
  tracking(ctx,0);ctx.textAlign='left'
 }

 // Headline: the asset in white with its symbol in gold, the last price large
 // and its change in the move's own colour.
 withFont(ctx,700,layout.name.size);tracking(ctx,-layout.name.size*0.02)
 ctx.fillStyle=C.text
 const nameMax=layout.price.align==='right'?content*0.55:content
 const name=clipText(ctx,header.name,nameMax)
 ctx.fillText(name,margin,layout.name.y)
 const nameWidth=ctx.measureText(name).width
 tracking(ctx,0)
 if(header.symbol){
  withFont(ctx,600,layout.symbol.size);ctx.fillStyle=C.gold
  ctx.fillText(String(header.symbol).toUpperCase(),margin+nameWidth+layout.symbol.gap,layout.name.y)
 }
 if(header.price){
  ctx.textAlign=layout.price.align
  withFont(ctx,700,layout.price.size);tracking(ctx,-layout.price.size*0.02)
  ctx.fillStyle=C.text
  const priceX=layout.price.align==='right'?right:margin
  ctx.fillText(header.price,priceX,layout.price.y)
  const priceWidth=ctx.measureText(header.price).width
  tracking(ctx,0)
  if(header.change){
   ctx.textAlign=layout.change.align
   withFont(ctx,600,layout.change.size)
   ctx.fillStyle=header.direction==='down'?C.down:header.direction==='up'?C.up:C.muted
   const changeX=layout.change.align==='right'?right:margin+priceWidth+layout.change.gap
   ctx.fillText(header.change,changeX,layout.change.y)
  }
  ctx.textAlign='left'
 }
 withFont(ctx,400,layout.meta.size);ctx.fillStyle=C.muted
 if(header.meta)ctx.fillText(clipText(ctx,header.meta,content),margin,layout.meta.y)

 // The frame: a rounded panel with a soft gold halo and a hairline, the chart
 // contained inside it, the drawings on top at the same scale, the plot mark
 // where it sits on screen.
 ctx.save()
 if('shadowColor' in ctx){ctx.shadowColor=C.halo;ctx.shadowBlur=48;ctx.shadowOffsetY=10}
 roundedPath(ctx,panel.x,panel.y,panel.width,panel.height,panel.radius)
 ctx.fillStyle=C.panel;ctx.fill()
 ctx.restore()
 ctx.save()
 roundedPath(ctx,panel.x,panel.y,panel.width,panel.height,panel.radius)
 ctx.clip()
 ctx.fillStyle=C.plot;ctx.fillRect(plot.x,plot.y,plot.width,plot.height)
 const fit=chartShareImageFit(chart.width,chart.height,plot)
 if(chart.canvas)ctx.drawImage(chart.canvas,fit.x,fit.y,fit.width,fit.height)
 if(frame.overlay?.svg){
  // A drawing layer that cannot rasterize never costs the whole image, but it
  // must never silently produce a chart that looks unannotated either: the
  // caller is told, and says so, through the rejected promise it receives.
  const overlay=await loader(overlaySource(frame.overlay))
  ctx.drawImage(overlay,fit.x,fit.y,frame.overlay.width*fit.scale,frame.overlay.height*fit.scale)
 }
 const wordmark=await load(loader,frame.wordmark)
 if(wordmark){
  const markWidth=fit.width*Math.min(0.38,300/Math.max(1,Number(chart.width)||1))
  const markHeight=markWidth*(wordmark.height/wordmark.width||0.25)
  ctx.save()
  ctx.globalAlpha=0.07
  if(frame.invert&&'filter' in ctx){ctx.filter='invert(1)';ctx.globalAlpha=0.09}
  ctx.drawImage(wordmark,fit.x+(fit.width-markWidth)/2,fit.y+(fit.height-markHeight)/2,markWidth,markHeight)
  ctx.restore()
 }
 ctx.restore()
 roundedPath(ctx,panel.x+0.5,panel.y+0.5,panel.width-1,panel.height-1,panel.radius)
 ctx.strokeStyle=C.hairline;ctx.lineWidth=1;ctx.stroke()

 // Foot: a hairline, the coloured wordmark, the site beneath it.
 ctx.fillStyle=C.gold;ctx.globalAlpha=0.35
 ctx.fillRect(margin,layout.rule.y,content,1)
 ctx.globalAlpha=1
 const brandmark=(await load(loader,frame.brandmark))||wordmark
 if(brandmark){
  const height=layout.brandmark.height,width=height*(brandmark.width/brandmark.height||7.2)
  ctx.drawImage(brandmark,(layout.width-width)/2,layout.brandmark.y,width,height)
 }
 if(header.site){
  ctx.textAlign='center';withFont(ctx,500,layout.site.size);tracking(ctx,layout.site.tracking);ctx.fillStyle=C.faint
  ctx.fillText(String(header.site),layout.width/2,layout.site.y)
  tracking(ctx,0);ctx.textAlign='left'
 }
 return canvas
}

/** The composed image as a PNG blob, which is what every delivery path needs:
 * the download, the clipboard item and the shared file. */
export async function chartShareImageBlob(frame,options={}) {
 const canvas=await composeChartShareImage(frame,options)
 if(typeof canvas.toBlob!=='function')throw new Error('canvas_unavailable')
 return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('image_encode_failed')),'image/png'))
}

export function chartShareImageName(subject,size) {
 const slug=String(subject||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')
 return `investor-intel-${slug||'chart'}-${SHARE_IMAGE_SIZES.includes(size)?size:'landscape'}.png`
}
