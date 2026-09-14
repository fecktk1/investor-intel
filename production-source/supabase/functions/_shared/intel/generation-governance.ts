/** The caller remains a user client; the database validates membership again. */
export async function generationDecision(db:any,name:string,orgId:string,params:Record<string,unknown>={}) {
 try {
  const {data,error}=await db.rpc(name,{...params,p_org_id:orgId})
  if(error || !data || typeof data.allowed!=='boolean') return {allowed:false,reason:'governance_unavailable'}
  return data
 } catch {return {allowed:false,reason:'governance_unavailable'}}
}
