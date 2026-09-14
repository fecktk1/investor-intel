import {validateChartLayout,isUuid} from './chart-workspace-contract.ts'
import {CHART_ANALYSIS_VERSION} from './chart-analysis.ts'
import {verifyChartCapture,chartCapturePolicy,chartRetentionDeadline,chartPricesReadable} from './chart-capture-proof.ts'
import {digest,stableJson} from './investigation-evidence.ts'
import {chartImage} from './chart-image.ts'
import {projectSnapshotPrices,snapshotExportAllowed} from './chart-snapshot-prices.ts'
import {replayBars} from './chart-replay-projection.ts'
type Actor={orgId:string;userId:string}
const read=async(query:any)=>{const {data,error}=await query;if(error)throw new Error('chart_snapshot_storage_unavailable');return data}
export async function buildChartSnapshot(input:any,secret:string,env:(key:string)=>string|undefined,now=Date.now()) {
 const layout=validateChartLayout(input.layout),ids=input.includeDrawingIds??[]
 if(layout.replay&&layout.replay.at>now)throw new Error('invalid_chart_replay')
 if(layout.replay&&ids.length)throw new Error('invalid_replay_snapshot_annotations')
 if(!Array.isArray(ids)||ids.length>200||ids.some(id=>!isUuid(id)||!layout.drawings.some(d=>d.id===id))||new Set(ids).size!==ids.length)throw new Error('invalid_snapshot_annotations')
 if(typeof input.title!=='string'||!input.title.trim()||input.title.length>120)throw new Error('invalid_snapshot_title')
 const captureOne=async(asset:string,capture:any)=>{
  const verified=await verifyChartCapture(capture?.proof,capture?.bars,asset,secret,now),policy=chartCapturePolicy(verified.source.provider,env)
  const replay=layout.replay,bars=replayBars(verified.bars,replay)
  const deadline=chartRetentionDeadline({source:verified.source,createdAt:now},env),retain=policy.retain&&deadline>now
  return {asset,createdAt:now,capturedAt:verified.capturedAt,source:verified.source,sourceHash:verified.hash,barCount:bars.length,
   ...(replay?{sourceBarCount:verified.bars.length,replaySeriesHash:await digest(stableJson(bars))}:{}),
   firstObservation:bars[0]?.t,lastObservation:bars.at(-1)?.t,bars:retain?bars:null,
   policy:{retain,export:retain&&policy.export,retainUntil:retain?deadline:null,productShare:retain&&verified.source.provider==='coinmarketcap'&&env('INTEL_CHART_CMC_PRODUCT_SHARING')==='true'},
   gaps:[...retain?[]:['The original price capture is reference-only. Your selected notes and its source fingerprint remain saved.'],...replay?[`Replay checkpoint through ${new Date(replay.at).toISOString()}. ${replay.knownOnly?'Only source bars recorded by that time are included.':'Historical candles may include later source corrections.'} This checkpoint was saved later and does not establish when the idea was first authored.`,...bars.length?[]:['No eligible completed source observations were available for this replay cutoff.']]:[]]}
 }
 let comparisonSeries:any[]|undefined
 if(layout.comparison){
  const captures=input.capture?.series
  if(!Array.isArray(captures)||captures.length!==layout.comparison.assets.length||captures.some((c,i)=>c?.asset!==layout.comparison!.assets[i].asset))throw new Error('invalid_snapshot_comparison_capture')
  comparisonSeries=await Promise.all(captures.map(c=>captureOne(c.asset,c)))
 }
 const primary=comparisonSeries?.[0]??await captureOne(layout.asset,input.capture)
 const selected={...layout,drawings:layout.replay?[]:layout.drawings.filter(d=>ids.includes(d.id)),visibility:{}}
 const snapshot={...primary,schemaVersion:1,calculationVersion:CHART_ANALYSIS_VERSION,title:input.title.trim(),layout:selected,
  ...(comparisonSeries?{capturedAt:now,bars:null,comparisonSeries,comparisonVersion:'close-aligned-1',gaps:[]}: {})}
 if(new TextEncoder().encode(JSON.stringify(snapshot)).length>1400000)throw new Error('chart_snapshot_size_limit')
 return {...snapshot,hash:await digest(stableJson(snapshot))}
}
export async function chartSnapshotService(db:any,actor:Actor,input:any,{secret,env,now=Date.now()}:{secret:string;env:(key:string)=>string|undefined;now?:number}) {
 const owned=(full=false)=>db.from('intel_chart_snapshots').select(full?'id,asset,title,state,created_at':'id,asset,title,created_at').eq('org_id',actor.orgId).eq('user_id',actor.userId)
 if(input.operation==='snapshot_list'){
  const page=input.page??0;if(!Number.isInteger(page)||page<0||page>100)throw new Error('invalid_snapshot_page')
  const rows=await read(owned().order('created_at',{ascending:false}).order('id',{ascending:false}).range(page*20,page*20+20));return {snapshots:(rows||[]).slice(0,20),hasMore:(rows||[]).length>20}
 }
 if(input.operation==='snapshot_save'){
  if(!isUuid(input.operationId))throw new Error('invalid_snapshot_operation')
  const previous=await read(db.from('intel_chart_snapshot_operations').select('snapshot_id').eq('org_id',actor.orgId).eq('user_id',actor.userId).eq('operation_id',input.operationId).maybeSingle())
  if(previous){if(!previous.snapshot_id)throw new Error('chart_snapshot_deleted');return {id:previous.snapshot_id}}
  const snapshot=await buildChartSnapshot(input,secret,env,now)
  const result=await read(db.rpc('intel_save_chart_snapshot',{p_org:actor.orgId,p_user:actor.userId,p_operation:input.operationId,p_snapshot:snapshot}))
  return {id:result}
 }
 if(!isUuid(input.id))throw new Error('invalid_snapshot_id')
 if(input.operation==='snapshot_delete')return {deleted:await read(db.rpc('intel_delete_chart_snapshot',{p_org:actor.orgId,p_user:actor.userId,p_id:input.id}))}
 const row=await read(owned(true).eq('id',input.id).maybeSingle());if(!row)throw new Error('chart_snapshot_not_found')
 if(input.operation==='snapshot_get'){
  return {snapshot:{...row,...projectSnapshotPrices(row.state,env,now)}}
 }
 if(input.operation==='snapshot_export'){
  if(!snapshotExportAllowed(row.state,env,now))throw new Error('chart_snapshot_export_unavailable')
  return {image:chartImage(row.state,input.includeDrawingIds??[])}
 }
 throw new Error('invalid_chart_operation')
}
