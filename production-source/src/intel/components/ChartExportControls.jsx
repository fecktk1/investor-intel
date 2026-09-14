import React,{useEffect,useId,useRef,useState} from 'react'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
export async function chartPng(svg,width,height){
 if(width>4096||height>8192||width*height>12000000)throw new Error('This chart is too tall for PNG. Download the SVG to preserve all selected notes.')
 const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}))
 try{
  const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Image rendering failed. Download the SVG instead.'));image.src=url})
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image rendering is unavailable. Download the SVG instead.')
  ctx.drawImage(image,0,0);return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('PNG encoding failed. Download the SVG instead.')),'image/png'))
 }finally{URL.revokeObjectURL(url)}
}
export default function ChartExportControls({context,snapshot}){
 const [open,setOpen]=useState(false),[selected,setSelected]=useState([]),[preview,setPreview]=useState(null),[url,setUrl]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(null),[notice,setNotice]=useState(null)
 const exportAllowed=snapshot.availability?.export===true
 const modal=useRef(null),trigger=useRef(null),alive=useRef(true),revision=useRef(0),heading=useId()
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 useEffect(()=>{if(open)modal.current?.showModal()},[open])
 useEffect(()=>{if(!preview){setUrl(null);return}const next=URL.createObjectURL(new Blob([preview.svg],{type:'image/svg+xml;charset=utf-8'}));setUrl(next);return()=>URL.revokeObjectURL(next)},[preview])
 const close=()=>{revision.current++;setOpen(false);setPreview(null);setBusy(false);trigger.current?.focus()}
 useEffect(()=>{if(!exportAllowed){revision.current++;setOpen(false);setPreview(null);setBusy(false)}},[exportAllowed])
 const render=async()=>{if(!exportAllowed)return;const current=++revision.current;setBusy(true);setError(null);setNotice(null);setPreview(null);try{const r=await requestChartWorkspace(context,{operation:'snapshot_export',id:snapshot.id,includeDrawingIds:selected});if(alive.current&&revision.current===current)setPreview(r.image)}catch(e){if(alive.current&&revision.current===current)setError(e.message)}finally{if(alive.current&&revision.current===current)setBusy(false)}}
 const download=async(format,copy=false)=>{
  const current=revision.current;setBusy(true);setError(null)
  try{const blob=format==='png'?await chartPng(preview.svg,preview.width,preview.height):new Blob([preview.svg],{type:'image/svg+xml;charset=utf-8'});if(!alive.current||revision.current!==current)return
   if(copy){if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw new Error('Image copying is unavailable. Download the PNG instead.');await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);if(alive.current)setNotice('Chart image copied.')}
   else{const href=URL.createObjectURL(blob),link=document.createElement('a');link.href=href;link.download=`investor-intel-chart.${format}`;link.click();setTimeout(()=>URL.revokeObjectURL(href),1000)}
  }catch(e){if(alive.current&&revision.current===current)setError(e.message)}finally{if(alive.current&&revision.current===current)setBusy(false)}
 }
 return <><button ref={trigger} type="button" className="intel-text-link" disabled={!exportAllowed} title={exportAllowed?undefined:snapshot.availability?.exportReason||'Image export is unavailable for this saved capture.'} onClick={()=>{setOpen(true);setSelected([]);setError(null);setNotice(null)}}>Export image</button>{!exportAllowed&&<span className="intel-analysis-caption">{snapshot.availability?.exportReason||'Image export is unavailable for this saved capture.'}</span>}{open&&<dialog ref={modal} className="intel-chart-study-dialog intel-chart-export-dialog" aria-labelledby={heading} onCancel={e=>{e.preventDefault();close()}}>
  <div className="intel-investigation-analysis-heading"><h2 id={heading}>Preview your chart image</h2><button type="button" onClick={close}>Close</button></div>
  <p className="intel-analysis-caption">Export this saved chart with its source, capture time and calculation version. The image fits the saved time range; it does not include your current portfolio.</p>
  <fieldset className="intel-snapshot-annotations"><legend>Annotations to include</legend>{snapshot.state.layout.drawings.map(d=><label key={d.id}><input type="checkbox" checked={selected.includes(d.id)} disabled={busy} onChange={e=>{revision.current++;setPreview(null);setSelected(ids=>e.target.checked?[...ids,d.id]:ids.filter(id=>id!==d.id))}}/><span>{d.text||d.tool.replaceAll('_',' ')}</span></label>)}{snapshot.state.layout.drawings.length===0&&<p>No annotations in this snapshot.</p>}</fieldset>
  <button type="button" disabled={busy} onClick={render}>{busy?'Preparing image…':'Preview image'}</button>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {preview&&<><p className="intel-analysis-caption">{preview.annotationCount} selected annotations · {preview.width} × {preview.height} · full notes included below the chart</p>{url&&<img className="intel-chart-export-preview" alt="Your chart export preview" src={url}/>}<div className="intel-investigation-controls"><button type="button" disabled={busy} onClick={()=>download('svg')}>Download SVG</button><button type="button" disabled={busy||!preview.pngAvailable} onClick={()=>download('png')}>Download PNG</button><button type="button" disabled={busy||!preview.pngAvailable} onClick={()=>download('png',true)}>Copy image</button></div>{!preview.pngAvailable&&<p>This image is too tall for PNG. SVG preserves the complete notes.</p>}</>}
 </dialog>}</>
}
