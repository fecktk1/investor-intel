import {chartAnchor,isUuid} from './chart-workspace-contract.ts'
import {resolveChartShare,validChartShareToken} from './chart-share-service.ts'
export async function chartReviewService(db:any,viewer:string|null,input:any,env:(key:string)=>string|undefined) {
 if(!isUuid(viewer)||!validChartShareToken(input.token))throw new Error('chart_review_unavailable')
 const read=async(query:any)=>{const {data,error}=await query;if(error)throw new Error(/^chart_review_/.test(error.message)?error.message:'chart_review_storage_unavailable');return data}
 if(input.operation==='review_owned'){
  const page=input.page??0;if(!Number.isInteger(page)||page<0||page>200)throw new Error('chart_review_invalid_page')
  const result=await read(db.rpc('intel_chart_owned_comments',{p_token:input.token,p_user:viewer,p_page:page}))
  return {...result,rows:result.rows.slice(0,5)}
 }
 if(input.operation==='review_delete'){
  if(!isUuid(input.id)||!Number.isInteger(input.revision)||input.revision<1)throw new Error('chart_review_invalid_comment')
  return {deleted:await read(db.rpc('intel_delete_chart_comment',{p_token:input.token,p_user:viewer,p_id:input.id,p_revision:input.revision}))}
 }
 // The shared conversation still requires current source and audience access.
 // Cleanup above exposes only the acting author's own text, never chart prices.
 const {snapshot}=await resolveChartShare(db,input.token,viewer,env)
 if(!['owner','org'].includes(snapshot.audience))throw new Error('chart_review_unavailable')
 if(input.operation==='review_list'){
  const page=input.page??0;if(!Number.isInteger(page)||page<0||page>200)throw new Error('chart_review_invalid_page')
  return read(db.rpc('intel_chart_review_page',{p_token:input.token,p_user:viewer,p_page:page}))
 }
 if(input.operation==='review_save'){
  if(!isUuid(input.operationId)||input.id!=null&&!isUuid(input.id)||!Number.isInteger(input.revision)||input.revision<0||typeof input.text!=='string'||!input.text.trim()||input.text.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text))throw new Error('chart_review_invalid_comment')
  const anchor=chartAnchor(input.anchor)
  const assets=snapshot.layout.comparison?.assets
  if(assets&&!assets.some(a=>a.asset===input.anchor?.asset)||!assets&&input.anchor?.asset!=null&&input.anchor.asset!==snapshot.layout.asset)throw new Error('chart_review_asset_mismatch')
  if(anchor.t<snapshot.layout.range.from||anchor.t>snapshot.layout.range.to)throw new Error('chart_review_anchor_outside_snapshot')
  return read(db.rpc('intel_save_chart_comment',{p_token:input.token,p_user:viewer,p_id:input.id??null,p_revision:input.revision,p_operation:input.operationId,p_anchor:assets?{...anchor,asset:input.anchor.asset}:anchor,p_text:input.text}))
 }
 throw new Error('chart_review_invalid_operation')
}
