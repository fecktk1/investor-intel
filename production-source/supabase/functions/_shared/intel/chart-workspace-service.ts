import {chartAsset,isUuid,validateChartLayout} from './chart-workspace-contract.ts'
export async function chartWorkspaceService(db:any,actor:{orgId:string;userId:string},body:any) {
 const owned=(details=false)=>db.from('intel_chart_layouts').select(details?'id,asset,title,state,revision,created_at,updated_at':'id,asset,title,revision,created_at,updated_at,purpose:state->>purpose').eq('org_id',actor.orgId).eq('user_id',actor.userId)
 const read=async(query:any)=>{const {data,error}=await query;if(error){if(error.code==='PT409'||error.code==='40001')throw new Error('chart_revision_conflict');if(error.message==='chart_layout_deleted')throw new Error('chart_layout_deleted');throw new Error('chart_storage_unavailable')}return data}
 if(['navigation_visit','navigation_list','navigation_clear'].includes(body.operation)){
  const operation=body.operation.slice(11),page=body.page??0,tab=body.tab??'recent'
  if(!Number.isInteger(page)||page<0||page>100||!['recent','watchlist'].includes(tab))throw new Error('invalid_chart_navigation')
  const result=await read(db.rpc('intel_chart_navigation',{p_org:actor.orgId,p_user:actor.userId,p_operation:operation,p_asset:operation==='visit'?chartAsset(body.asset):null,p_tab:tab,p_page:page}))
  if(operation!=='list')return result
  return {...result,assets:(result?.assets??[]).slice(0,20).map((row:any)=>{let asset:string|null=null;try{asset=chartAsset(row.asset)}catch{}return {asset,name:String(row.name??row.asset).slice(0,240),symbol:row.symbol,logo:row.logo,visitedAt:row.visitedAt}})}
 }
 // The member's own WORKING STATE for one asset: what the chart looked like when
 // they last left it. One row per member per asset, saved automatically, never
 // named and never listed. Both operations sit behind the same membership check
 // as every other operation here, and the asset is validated before it is read.
 if(body.operation==='working_get'||body.operation==='working_save'){
  const asset=chartAsset(body.asset)
  if(body.operation==='working_get'){
   const row=await read(db.from('intel_chart_working_states').select('asset,state,revision,updated_at').eq('org_id',actor.orgId).eq('user_id',actor.userId).eq('asset',asset).maybeSingle())
   return {working:row?{asset:row.asset,state:row.state,revision:row.revision,updatedAt:row.updated_at}:null}
  }
  if(!Number.isInteger(body.revision)||body.revision<0||body.revision>2000000000)throw new Error('invalid_chart_working_revision')
  const state=validateChartLayout(body.state)
  // The row is keyed on the asset, so a state that names another asset would be
  // filed under the wrong chart rather than rejected. It is rejected.
  if(state.asset!==asset)throw new Error('invalid_chart_working_asset')
  return read(db.rpc('intel_save_chart_working_state',{p_org:actor.orgId,p_user:actor.userId,p_asset:asset,p_revision:body.revision,p_state:state}))
 }
 if(body.operation==='list'){
  const page=body.page??0;if(!Number.isInteger(page)||page<0||page>100)throw new Error('invalid_chart_page')
  let query=owned().order('updated_at',{ascending:false}).order('id',{ascending:false}).range(page*20,page*20+20)
  if(body.asset)query=query.eq('asset',chartAsset(body.asset))
  if(body.templates===true)query=query.eq('state->>purpose','study_template')
  if(body.comparisons===true)query=query.not('state->comparison','is',null)
  const rows=await read(query)??[];return {layouts:rows.slice(0,20),hasMore:rows.length>20,page}
 }
 if(body.operation==='get'){
  if(!isUuid(body.id))throw new Error('invalid_chart_id')
  const layout=await read(owned(true).eq('id',body.id).maybeSingle());if(!layout)throw new Error('chart_layout_not_found');return {layout}
 }
 if(body.operation==='save'){
  if(!isUuid(body.operationId)||body.id!=null&&!isUuid(body.id)||!Number.isInteger(body.revision)||body.revision<0||typeof body.title!=='string'||!body.title.trim()||body.title.length>120)throw new Error('invalid_chart_save')
  const layout=validateChartLayout(body.layout)
  return read(db.rpc('intel_save_chart_layout',{p_org:actor.orgId,p_user:actor.userId,p_id:body.id??null,p_revision:body.revision,p_operation:body.operationId,p_title:body.title,p_state:layout}))
 }
 if(body.operation==='delete'){
  if(!isUuid(body.id)||!Number.isInteger(body.revision)||body.revision<1)throw new Error('invalid_chart_delete')
  return {deleted:await read(db.rpc('intel_delete_chart_layout',{p_org:actor.orgId,p_user:actor.userId,p_id:body.id,p_revision:body.revision}))}
 }
 throw new Error('invalid_chart_operation')
}
