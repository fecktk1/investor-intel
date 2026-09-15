/** The brand share image: the chart on screen, composed onto a near-black
 * ground with gold accents and the TheContentForge wordmark at the foot.
 *
 * The chart pixels arrive as the renderer's own screenshot, so the image
 * carries what the owner is actually looking at, indicator panes included.
 * Drawings live in a separate SVG overlay on screen; that markup is rasterized
 * and drawn back at the same origin, so an annotated chart shares annotated.
 * The plot watermark keeps the on-screen rule (38% of the plot, capped at the
 * same 300px it is capped at on screen, at the same opacity) rather than
 * inventing a second brand mark for the export.
 *
 * Nothing here reaches the network. The screenshot is a canvas, the overlay is
 * serialized markup and the wordmark is a same-origin file, so the composed
 * canvas is never tainted and always encodes.
 *
 * `createCanvas` and `loadImage` are injectable so the composition can be
 * measured, and previewed, without a rasterizer. Nothing else is imported
 * here on purpose: this module has to run unchanged in the browser, in the
 * jsdom suite and under plain node. */

export const SHARE_IMAGE_COLORS={ground:'#0B0D0F',plot:'#14171C',gold:'#DFA647',text:'#EEF0F3',muted:'#A7AFBC',line:'#2A3038',up:'#6CC6A2',down:'#E89A9D'}

// Two posting shapes, both at 2x device pixels. Every number is a design pixel
// in the size's own frame; nothing is a ratio of anything else, so a header
// that reads well at 1600 wide cannot drift when the portrait frame changes.
const LAYOUTS={
 landscape:{width:1600,height:900,margin:72,
  eyebrow:{y:98,size:19,tracking:5},name:{y:162,size:46},symbol:{size:28,gap:18},
  price:{y:152,size:44,align:'right'},change:{y:190,size:23,align:'right',gap:0},
  rule:{y:214},meta:{y:250,size:19},plot:{y:280,bottom:770},wordmark:{y:798,height:30}},
 portrait:{width:1080,height:1350,margin:70,
  eyebrow:{y:114,size:20,tracking:5},name:{y:182,size:48},symbol:{size:28,gap:16},
  price:{y:252,size:44,align:'left'},change:{y:252,size:23,align:'left',gap:22},
  rule:{y:288},meta:{y:324,size:19},plot:{y:356,bottom:1212},wordmark:{y:1244,height:32}},
}

export const SHARE_IMAGE_SIZES=Object.keys(LAYOUTS)

/** The resolved frame for one size: every band, plus the plot rectangle the
 * chart is fitted into. Pure, so layout is assertable without a canvas. */
export function chartShareImageLayout(size) {
 const base=LAYOUTS[size]||LAYOUTS.landscape
 const width=base.width-base.margin*2
 return {...base,content:width,plot:{x:base.margin,y:base.plot.y,width,height:base.plot.bottom-base.plot.y}}
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
const withFont=(ctx,weight,size)=>{ctx.font=`${weight} ${size}px Inter, Arial, sans-serif`}
const clipText=(ctx,value,max)=>{
 let text=String(value??'')
 if(!text||!(max>0)||ctx.measureText(text).width<=max)return text
 while(text.length>1&&ctx.measureText(`${text}…`).width>max)text=text.slice(0,-1)
 return `${text}…`
}

/** Composes the image and returns the canvas. `frame` carries the captured
 * chart ({canvas,width,height}), the optional drawings overlay ({svg,width,
 * height}), whether the mark has to be inverted for the chart's own theme, the
 * wordmark source and the header strings, which arrive already translated and already formatted by the
 * app's own number formatters. */
export async function composeChartShareImage(frame,options={}) {
 const size=SHARE_IMAGE_SIZES.includes(options.size)?options.size:'landscape'
 const scale=Number(options.scale)>0?Number(options.scale):2
 const layout=chartShareImageLayout(size)
 const canvas=(options.createCanvas||defaultCanvas)(Math.round(layout.width*scale),Math.round(layout.height*scale))
 const load=options.loadImage||defaultImage
 const ctx=canvas.getContext('2d')
 if(!ctx)throw new Error('canvas_unavailable')
 ctx.scale(scale,scale)
 const header=frame.header||{},chart=frame.chart||{},{margin,content}=layout,right=layout.width-margin

 ctx.fillStyle=SHARE_IMAGE_COLORS.ground
 ctx.fillRect(0,0,layout.width,layout.height)

 ctx.textBaseline='alphabetic';ctx.textAlign='left'
 if('letterSpacing' in ctx)ctx.letterSpacing=`${layout.eyebrow.tracking}px`
 withFont(ctx,600,layout.eyebrow.size)
 ctx.fillStyle=SHARE_IMAGE_COLORS.gold
 ctx.fillText(String(header.eyebrow||'Investor Intel').toUpperCase(),margin,layout.eyebrow.y)
 if('letterSpacing' in ctx)ctx.letterSpacing='0px'

 withFont(ctx,700,layout.name.size)
 ctx.fillStyle=SHARE_IMAGE_COLORS.text
 const name=clipText(ctx,header.name,content*0.6)
 ctx.fillText(name,margin,layout.name.y)
 if(header.symbol){
  const after=margin+ctx.measureText(name).width+layout.symbol.gap
  withFont(ctx,600,layout.symbol.size)
  ctx.fillStyle=SHARE_IMAGE_COLORS.gold
  ctx.fillText(String(header.symbol).toUpperCase(),after,layout.name.y)
 }

 if(header.price){
  ctx.textAlign=layout.price.align
  withFont(ctx,700,layout.price.size)
  ctx.fillStyle=SHARE_IMAGE_COLORS.text
  ctx.fillText(header.price,layout.price.align==='right'?right:margin,layout.price.y)
  if(header.change){
   const offset=layout.change.align==='right'?right:margin+ctx.measureText(header.price).width+layout.change.gap
   withFont(ctx,600,layout.change.size)
   ctx.fillStyle=header.direction==='down'?SHARE_IMAGE_COLORS.down:header.direction==='up'?SHARE_IMAGE_COLORS.up:SHARE_IMAGE_COLORS.muted
   ctx.fillText(header.change,offset,layout.change.y)
  }
  ctx.textAlign='left'
 }

 ctx.fillStyle=SHARE_IMAGE_COLORS.gold
 ctx.globalAlpha=0.55
 ctx.fillRect(margin,layout.rule.y,content,1)
 ctx.globalAlpha=1

 withFont(ctx,400,layout.meta.size)
 ctx.fillStyle=SHARE_IMAGE_COLORS.muted
 if(header.meta)ctx.fillText(clipText(ctx,header.meta,content),margin,layout.meta.y)

 ctx.fillStyle=SHARE_IMAGE_COLORS.plot
 ctx.fillRect(layout.plot.x,layout.plot.y,layout.plot.width,layout.plot.height)
 const fit=chartShareImageFit(chart.width,chart.height,layout.plot)
 if(chart.canvas)ctx.drawImage(chart.canvas,fit.x,fit.y,fit.width,fit.height)
 if(frame.overlay?.svg){
  // A drawing layer that cannot rasterize never costs the whole image, but it
  // must never silently produce a chart that looks unannotated either: the
  // caller is told, and says so, through the rejected promise it receives.
  const overlay=await load(overlaySource(frame.overlay))
  ctx.drawImage(overlay,fit.x,fit.y,frame.overlay.width*fit.scale,frame.overlay.height*fit.scale)
 }
 let wordmark=null
 if(frame.wordmark){try{wordmark=await load(frame.wordmark)}catch{wordmark=null}}
 if(wordmark){
  const markWidth=fit.width*Math.min(0.38,300/Math.max(1,Number(chart.width)||1))
  const markHeight=markWidth*(wordmark.height/wordmark.width||0.25)
  ctx.save()
  ctx.globalAlpha=0.07
  if(frame.invert&&'filter' in ctx){ctx.filter='invert(1)';ctx.globalAlpha=0.09}
  ctx.drawImage(wordmark,fit.x+(fit.width-markWidth)/2,fit.y+(fit.height-markHeight)/2,markWidth,markHeight)
  ctx.restore()
 }
 ctx.strokeStyle=SHARE_IMAGE_COLORS.line
 ctx.lineWidth=1
 ctx.strokeRect(layout.plot.x+0.5,layout.plot.y+0.5,layout.plot.width-1,layout.plot.height-1)
 if(wordmark){
  const height=layout.wordmark.height,width=height*(wordmark.width/wordmark.height||4)
  ctx.drawImage(wordmark,(layout.width-width)/2,layout.wordmark.y,width,height)
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
