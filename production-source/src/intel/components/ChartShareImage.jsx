import React,{useEffect,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {fmtPct,fmtPrice} from '../lib/market-format'
import {watermarkNeedsInvert} from '../lib/chart-watermark'

/** The image half of the share flow: a posting image of the chart on screen.
 *
 * A link is the right answer when the reader should verify the prices; it is
 * the wrong answer in a group chat, where nobody opens a link and nobody is
 * signed in. This produces the other artefact: a black and gold image with the
 * chart, its drawings, its watermark and the wordmark, which a person can post
 * anywhere.
 *
 * The compositor is imported on demand rather than with this panel, so the
 * share flow stays a small chunk and the canvas code arrives only for the
 * owner who actually asks for an image.
 *
 * Only the chosen shape drives a recomposition. The capture and the header are
 * read through refs on purpose: they are rebuilt on every render of the panel
 * above, and depending on them would recompose the image forever. */

const spacing=ms=>ms>=86400000?`${Math.round(ms/86400000)}d`:ms>=3600000?`${Math.round(ms/3600000)}h`:`${Math.round(ms/60000)}m`
const clock=(value,timeZone)=>Number.isFinite(value)?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short',timeZone}):null

export default function ChartShareImage({capture,layout=null,source=null}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [size,setSize]=useState('landscape'),[image,setImage]=useState(null),[busy,setBusy]=useState(true),[error,setError]=useState(null),[notice,setNotice]=useState(null)
 const alive=useRef(true),generation=useRef(0),held=useRef(null),latest=useRef(null)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;if(held.current)URL.revokeObjectURL(held.current)}},[])

 const headerFor=frame=>{
  const timezone=layout?.timezone||'UTC'
  const from=clock(layout?.range?.from,timezone),to=clock(layout?.range?.to,timezone)
  const change=Number.isFinite(frame.first)&&frame.first>0&&Number.isFinite(frame.last)?(frame.last/frame.first-1)*100:null
  const currency=source?.currency&&source.currency!=='USD'?source.currency:null
  return {eyebrow:'Investor Intel',name:frame.name||layout?.asset||'',symbol:frame.symbol||'',
   price:Number.isFinite(frame.last)?fmtPrice(frame.last):null,
   change:change==null?null:fmtPct(change),direction:change==null?null:change<0?'down':'up',
   meta:[from&&to?t('chart.share.card_range',{from,to,defaultValue:'{{from}} to {{to}}'}):null,
    frame.interval?t('chart.share.image_candles',{width:spacing(frame.interval),defaultValue:'{{width}} candles'}):null,
    timezone,currency].filter(Boolean).join(' · ')}
 }

 const compose=async target=>{
  const id=++generation.current
  setBusy(true);setError(null);setNotice(null)
  try{
   const frame=capture()
   const {chartShareImageBlob}=await import('../lib/chart-share-image')
   const blob=await chartShareImageBlob({...frame,invert:watermarkNeedsInvert(frame.background),header:headerFor(frame)},{size:target})
   if(!alive.current||generation.current!==id)return
   if(held.current)URL.revokeObjectURL(held.current)
   held.current=URL.createObjectURL(blob)
   setImage({blob,url:held.current,size:target,subject:frame.symbol||frame.name||''})
  }catch(e){
   if(!alive.current||generation.current!==id)return
   setImage(null)
   setError(e.message==='chart_not_ready'
    ? t('chart.share.image_not_ready',{defaultValue:'The chart is still drawing. Close this and open Share again in a moment.'})
    : t('chart.share.image_failed',{defaultValue:'This image could not be composed in this browser. The link below still works.'}))
  }finally{if(alive.current&&generation.current===id)setBusy(false)}
 }
 latest.current=compose
 useEffect(()=>{latest.current(size)},[size])

 const save=async()=>{
  const {chartShareImageName}=await import('../lib/chart-share-image')
  const link=document.createElement('a')
  link.href=image.url;link.download=chartShareImageName(image.subject,image.size);link.click()
 }
 const unsupported=()=>t('chart.share.image_copy_unavailable',{defaultValue:'This browser cannot copy images. Save the image instead.'})
 const copy=async()=>{
  setNotice(null);setError(null)
  if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined'){setError(unsupported());return}
  try{
   await navigator.clipboard.write([new ClipboardItem({'image/png':image.blob})])
   if(alive.current)setNotice(t('chart.share.image_copied',{defaultValue:'Image copied.'}))
  }catch{if(alive.current)setError(unsupported())}
 }
 const send=async()=>{
  const {chartShareImageName}=await import('../lib/chart-share-image')
  const file=new File([image.blob],chartShareImageName(image.subject,image.size),{type:'image/png'})
  if(!navigator.canShare?.({files:[file]}))return
  try{await navigator.share({files:[file]})}catch{/* a cancelled share is not a failure */}
 }
 const shareable=typeof navigator!=='undefined'&&typeof navigator.share==='function'&&typeof navigator.canShare==='function'&&typeof File==='function'

 return <section className="intel-share-image" aria-label={t('chart.share.image_title',{defaultValue:'Share image'})}>
  <h3 className="eyebrow">{t('chart.share.image_title',{defaultValue:'Share image'})}</h3>
  <p className="intel-analysis-caption">{t('chart.share.image_intro',{defaultValue:'A black and gold image of this chart, with your drawings and the watermark, ready to post.'})}</p>
  <div className="intel-investigation-controls" role="group" aria-label={t('chart.share.image_shape',{defaultValue:'Image shape'})}>
   <button type="button" aria-pressed={size==='landscape'} disabled={busy} onClick={()=>setSize('landscape')}>{t('chart.share.image_landscape',{defaultValue:'Landscape'})}</button>
   <button type="button" aria-pressed={size==='portrait'} disabled={busy} onClick={()=>setSize('portrait')}>{t('chart.share.image_portrait',{defaultValue:'Portrait'})}</button>
  </div>
  {busy&&<p role="status">{t('chart.share.image_composing',{defaultValue:'Composing the image…'})}</p>}
  {error&&<p role="alert">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
  {image&&<img className="intel-chart-export-preview" src={image.url} alt={t('chart.share.image_alt',{defaultValue:'Preview of the chart image you are about to share'})}/>}
  {image&&<div className="intel-investigation-controls">
   <button type="button" className="btn btn--primary" onClick={save}>{t('chart.share.image_save',{defaultValue:'Save image'})}</button>
   <button type="button" onClick={copy}>{t('chart.share.image_copy',{defaultValue:'Copy image'})}</button>
   {shareable&&<button type="button" onClick={send}>{t('chart.share.open',{defaultValue:'Share'})}</button>}
  </div>}
 </section>
}
