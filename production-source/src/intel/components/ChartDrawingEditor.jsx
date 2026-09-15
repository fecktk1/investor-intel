import React,{useEffect,useRef} from 'react'
import {useTranslation} from 'react-i18next'
import {drawingAnchorCount,DRAWING_DASHES} from '../../../supabase/functions/_shared/intel/chart-workspace-contract'
import {drawingToolLabel} from '../lib/chart-drawing-tools'

const stamp=t=>Number.isFinite(t)?new Date(t).toISOString().slice(0,23):''
const FIB=[0,0.236,0.382,0.5,0.618,0.786,1]

// The coordinate and note editor for one drawing. Deferred: the chart opens
// without it and it loads the first time a member edits a drawing by hand.
export default function ChartDrawingEditor({editor,tools,error,onChange,onClose,onApply}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const dialog=useRef(null)
 useEffect(()=>{if(dialog.current&&!dialog.current.open)dialog.current.showModal()},[])
 return <dialog ref={dialog} className="intel-chart-study-dialog" aria-labelledby="chart-drawing-title" onCancel={event=>{event.preventDefault();onClose()}}>
  <div className="intel-investigation-analysis-heading"><h2 id="chart-drawing-title">{t('chart.draw.editor_title',{defaultValue:'Drawing coordinates and notes'})}</h2><button type="button" onClick={onClose}>{t('chart.draw.close',{defaultValue:'Close'})}</button></div>
  <label>{t('chart.draw.tool',{defaultValue:'Tool'})}<select value={editor.tool} onChange={event=>{
   const next=event.target.value
   onChange(d=>{
    const count=drawingAnchorCount(next),base=d.anchors[0],second=d.anchors[1]||base
    return {...d,tool:next,anchors:count===1?[base]:count===3?[base,second,second]:[base,second],
     ...(next==='fibonacci'&&!d.ratios?{ratios:FIB}:{}),...(next==='tweet'&&d.url==null?{url:''}:{})}
   })
  }}>{tools.map(id=><option key={id} value={id}>{drawingToolLabel(t,id)}</option>)}</select></label>
  {editor.tool==='tweet'&&<label>{t('chart.draw.tweet_url',{defaultValue:'Address of the post on X'})}<input type="url" inputMode="url" maxLength={500} placeholder="https://x.com/name/status/1234567890" value={editor.url||''} onChange={event=>onChange(d=>({...d,url:event.target.value}))}/></label>}
  {editor.anchors.map((anchor,i)=><div key={i} className="intel-drawing-anchor-fields">
   <label>{t('chart.draw.anchor_time',{defaultValue:'Anchor {{index}} time (UTC)',index:i+1})}<input type="datetime-local" step="0.001" value={stamp(anchor.t)} onChange={event=>onChange(d=>({...d,anchors:d.anchors.map((a,j)=>j===i?{...a,t:Date.parse(`${event.target.value}Z`)}:a)}))}/></label>
   <label>{t('chart.draw.anchor_price',{defaultValue:'Anchor {{index}} price',index:i+1})}<input type="number" min="0" step="any" value={Number.isFinite(anchor.price)?anchor.price:''} onChange={event=>onChange(d=>({...d,anchors:d.anchors.map((a,j)=>j===i?{...a,price:Number(event.target.value)}:a)}))}/></label>
  </div>)}
  <label>{t('chart.draw.note',{defaultValue:'Your annotation'})}<textarea className="textarea" rows={3} maxLength={2000} value={editor.text} onChange={event=>onChange(d=>({...d,text:event.target.value}))}/></label>
  {editor.tool==='fibonacci'&&<label>{t('chart.draw.ratios',{defaultValue:'Retracement ratios, separated by commas'})}<input value={Array.isArray(editor.ratios)?editor.ratios.join(', '):editor.ratios||''} onChange={event=>onChange(d=>({...d,ratios:event.target.value}))}/></label>}
  <div className="intel-study-parameters">
   <label>{t('chart.draw.color',{defaultValue:'Color'})}<input type="color" value={editor.color} onChange={event=>onChange(d=>({...d,color:event.target.value}))}/></label>
   <label>{t('chart.draw.width',{defaultValue:'Width'})}<input type="number" min="1" max="5" value={editor.width} onChange={event=>onChange(d=>({...d,width:Number(event.target.value)}))}/></label>
   <label>{t('chart.draw.dash',{defaultValue:'Line'})}<select value={editor.dash||'solid'} onChange={event=>onChange(d=>({...d,dash:event.target.value}))}>{DRAWING_DASHES.map(value=><option key={value} value={value}>{t(`chart.draw.dash_${value}`,{defaultValue:value})}</option>)}</select></label>
  </div>
  {error&&<p role="alert">{error}</p>}
  <button className="btn btn--primary" type="button" onClick={onApply}>{t('chart.draw.apply',{defaultValue:'Apply drawing'})}</button>
  <p className="intel-analysis-caption">{t('chart.draw.anchor_caption',{defaultValue:'Coordinates stay attached to their time and price when you resize or zoom. Save the layout to keep them across visits.'})}</p>
 </dialog>
}
