import {isUuid,validateChartLayout} from './chart-workspace-contract.ts'
import {chartCapturePolicy,chartPricesReadable,chartRetentionDeadline,chartSourceProviders,CHART_SOURCE_POLICY_PREFIX,chartSourcePolicyKey} from './chart-capture-proof.ts'
import {stableJson,digest} from './investigation-evidence.ts'
import {snapshotSeries,projectSnapshotPrices} from './chart-snapshot-prices.ts'
type Env=(name:string)=>string|undefined
type Actor={orgId:string;userId:string}
const read=async(query:any)=>{const {data,error}=await query;if(error)throw new Error(error.message==='chart_share_limit'?'chart_share_limit':'chart_share_storage_unavailable');return data}
const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('')
export const validChartShareToken=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
/** The short-link front door. tcfqr.link resolves any slug through qr-redirect,
 * which copies the stored destination into Location verbatim, so the capability
 * fragment survives the 302 and is never sent to a server. */
export const CHART_SHARE_SHORT_ORIGIN='https://tcfqr.link'
/** An eight character base62 slug, minted by intel_chart_share_short_link. */
export const validChartShareSlug=(value:unknown):value is string=>typeof value==='string'&&/^[0-9A-Za-z]{6,16}$/.test(value)
export const chartShareShortUrl=(slug:unknown):string|null=>validChartShareSlug(slug)?`${CHART_SHARE_SHORT_ORIGIN}/${slug}`:null
export function chartSourceShareAllowed(state:any,env:Env,now=Date.now()):boolean{
 if(state.layout?.comparison){const series=snapshotSeries(state);return series.length===state.layout.comparison.assets.length&&series.every(s=>chartSourceShareAllowed(s,env,now))}
 // Every part of a stitched source (`binance+coinmarketcap`) must allow the
 // share. CoinMarketCap product sharing is its own permission; every other part
 // needs the export permission recorded at capture, still granted, plus sharing.
 const parts=chartSourceProviders(state.source?.provider)
 const allowed=(part:string)=>{
  if(part==='coinmarketcap'&&state.policy?.productShare===true&&env('INTEL_CHART_CMC_PRODUCT_SHARING')==='true')return !!state.bars&&chartPricesReadable(state,env,now)
  const prefix=CHART_SOURCE_POLICY_PREFIX[part]
  const recorded=state.policy?.export===true||(Array.isArray(state.policy?.partExport)&&state.policy.partExport.includes(part))
  return !!prefix&&recorded&&chartCapturePolicy(part,env).export&&env(chartSourcePolicyKey(prefix,'SHARING'))==='true'
 }
 return parts.length>0&&parts.every(allowed)
}
export async function projectChartShare(resolved:any,env:Env,now=Date.now()){
 const original=resolved.snapshot,external=resolved.audience!=='owner'
 if(external&&!chartSourceShareAllowed(original,env,now))throw new Error('chart_share_source_unavailable')
 const layout=validateChartLayout(original.layout),ids=resolved.drawingIds||[],projection=projectSnapshotPrices(original,env,now),retain=projection.availability.prices
 // Build an allowlist projection. Never return ambient positions, author/org IDs,
 // annotation IDs omitted by the owner, or the hash of omitted private text.
 const view={schemaVersion:1,title:original.title,calculationVersion:original.calculationVersion,capturedAt:original.capturedAt,
   layout:{...layout,visibility:{},drawings:layout.replay?[]:layout.drawings.filter(d=>ids.includes(d.id))},source:original.source,sourceHash:original.sourceHash,
   ...(layout.replay?{sourceBarCount:original.sourceBarCount,replaySeriesHash:original.replaySeriesHash}:{}),
  bars:projection.state.bars,retainUntil:projection.availability.retainUntil,barCount:original.barCount,gaps:retain?(original.gaps||[]):['The saved price capture has expired or is unavailable under the current source policy. Selected research notes remain available.'],audience:resolved.audience,expiresAt:resolved.expiresAt,
  ...(layout.comparison?{comparisonVersion:original.comparisonVersion,comparisonSeries:projection.state.comparisonSeries.map((s:any)=>({asset:s.asset,source:s.source,sourceHash:s.sourceHash,capturedAt:s.capturedAt,barCount:s.barCount,bars:s.bars,availability:s.availability,gaps:s.bars?[]:['Saved source prices are unavailable. The original fingerprint remains.']}))}: {})}
 return {...view,hash:await digest(stableJson(view))}
}
export async function resolveChartShare(db:any,shareToken:unknown,verifiedViewer:string|null,env:Env){
 if(!validChartShareToken(shareToken))throw new Error('chart_share_unavailable')
 const resolved=await read(db.rpc('intel_resolve_chart_share',{p_token:shareToken,p_viewer:verifiedViewer}))
 if(!resolved)throw new Error('chart_share_unavailable')
 return {snapshot:await projectChartShare(resolved,env)}
}
export async function chartShareService(db:any,actor:Actor,input:any,env:Env,now=Date.now()){
 const owned=()=>db.from('intel_chart_shares').select('id,token,snapshot_id,audience,drawing_ids,expires_at,revoked_at,created_at,short_slug').eq('org_id',actor.orgId).eq('user_id',actor.userId)
 // The short address is the link a member hands out, so a created or retried
 // share carries it. A mint that cannot answer never loses the share itself:
 // the caller falls back to the full address rather than seeing a failure.
 const withShortLink=async(share:any)=>{
  if(validChartShareSlug(share?.short_slug))return {...share,shortUrl:chartShareShortUrl(share.short_slug)}
  try{
   const {data,error}=await db.rpc('intel_chart_share_short_link',{p_org:actor.orgId,p_user:actor.userId,p_share:share.id})
   if(error||!validChartShareSlug(data))return {...share,shortUrl:null}
   return {...share,short_slug:data,shortUrl:chartShareShortUrl(data)}
  }catch{return {...share,shortUrl:null}}
 }
 if(input.operation==='share_list'){
  if(!isUuid(input.snapshotId))throw new Error('invalid_chart_share_snapshot')
  const page=input.page??0;if(!Number.isInteger(page)||page<0||page>100)throw new Error('invalid_chart_share_page')
  const rows=await read(owned().eq('snapshot_id',input.snapshotId).order('created_at',{ascending:false}).order('id',{ascending:false}).range(page*20,page*20+20))
  return {shares:(rows||[]).slice(0,20).map((row:any)=>({...row,shortUrl:chartShareShortUrl(row.short_slug)})),hasMore:(rows||[]).length>20}
 }
 if(input.operation==='share_revoke'){
  if(!isUuid(input.id))throw new Error('invalid_chart_share_id')
  return {revoked:await read(db.rpc('intel_revoke_chart_share',{p_org:actor.orgId,p_user:actor.userId,p_id:input.id}))}
 }
 if(input.operation!=='share_create'||!isUuid(input.snapshotId)||!isUuid(input.operationId))throw new Error('invalid_chart_share_operation')
 const previous=await read(owned().eq('operation_id',input.operationId).maybeSingle())
 if(previous){if(previous.revoked_at||!previous.snapshot_id||Date.parse(previous.expires_at)<=now)throw new Error('chart_share_unavailable');return {share:await withShortLink(previous)}}
 const audience=input.audience??'owner',ids=input.includeDrawingIds??[],expiresAt=input.expiresAt
 if(!['owner','org','unlisted','public'].includes(audience)||typeof expiresAt!=='number'||!Number.isFinite(expiresAt)||expiresAt<=now||expiresAt>now+30*86400000)throw new Error('invalid_chart_share')
 const row=await read(db.from('intel_chart_snapshots').select('state').eq('org_id',actor.orgId).eq('user_id',actor.userId).eq('id',input.snapshotId).maybeSingle())
 if(!row)throw new Error('chart_share_unavailable')
 if(!Array.isArray(ids)||ids.length>200||new Set(ids).size!==ids.length||ids.some(id=>!isUuid(id)||!row.state.layout.drawings.some((d:any)=>d.id===id)))throw new Error('invalid_snapshot_annotations')
 if(audience!=='owner'&&!chartSourceShareAllowed(row.state,env,now))throw new Error('chart_share_source_unavailable')
 const share=await read(db.rpc('intel_create_chart_share',{p_org:actor.orgId,p_user:actor.userId,p_snapshot:input.snapshotId,p_operation:input.operationId,p_token:token(),p_audience:audience,p_drawings:ids,p_expires:new Date(expiresAt).toISOString()}))
 if(!share||share.revoked_at||!share.snapshot_id||Date.parse(share.expires_at)<=now)throw new Error('chart_share_unavailable')
 return {share:await withShortLink({id:share.id,token:share.token,snapshot_id:share.snapshot_id,audience:share.audience,drawing_ids:share.drawing_ids,expires_at:share.expires_at,revoked_at:share.revoked_at,created_at:share.created_at,short_slug:share.short_slug??null})}
}
