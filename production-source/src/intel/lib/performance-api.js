const read=async query=>{const {data,error}=await query;if(error)throw Error(error.message||'Performance review could not be loaded.');if(data==null)throw Error('Performance review response was incomplete.');return data}
export async function readPerformanceLedger(supabase,orgId,cursor=null){
 const result=await read(supabase.rpc('intel_thesis_performance_ledger',{p_org:orgId,p_before_at:cursor?.at??null,p_before_id:cursor?.id??null,p_limit:30}))
 if(!Array.isArray(result.rows)||!result.summary)throw Error('Performance ledger response was incomplete.')
 return result
}
export async function savePerformanceReview(supabase,orgId,thesisId,review,operationId){
 return read(supabase.rpc('intel_save_performance_review',{p_org:orgId,p_thesis:thesisId,p_review:review,p_operation:operationId}))
}
export async function readPerformanceHistory(supabase,orgId,userId,thesisId,page=0){
 if(!Number.isInteger(page)||page<0||page>1000)throw Error('Invalid review page')
 const rows=await read(supabase.from('intel_thesis_reviews').select('id,note,created_at,performance_evaluation').eq('org_id',orgId).eq('user_id',userId).eq('thesis_id',thesisId).not('performance_evaluation','is',null).order('created_at',{ascending:false}).order('id',{ascending:false}).range(page*20,page*20+20))
 if(!Array.isArray(rows))throw Error('Review history response was incomplete.')
 return {rows:rows.slice(0,20),hasMore:rows.length>20,page}
}
