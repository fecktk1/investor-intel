const subject=(v:unknown)=>typeof v==='string'&&/^market:coinmarketcap:[1-9][0-9]{0,11}$/.test(v)
/** One indexed server query for the retained original basket. Reopening a
 * historical cursor cannot fetch today's quotes or invent old membership. */
export async function globalCohortPrices(db:any,cohort:any,inputAt:unknown,now=Date.now()){
 const at=inputAt==null?now:typeof inputAt==='number'?inputAt:NaN
 if(!Number.isFinite(at)||at<0||at>now)throw Error('invalid_cohort_time')
 if(!['sector','new_listings'].includes(cohort?.kind)||cohort?.provider!=='coinmarketcap'||!Array.isArray(cohort.members)||!cohort.members.length||cohort.members.length>100||cohort.members.some((m:any)=>!subject(m.subject))||new Set(cohort.members.map((m:any)=>m.subject)).size!==cohort.members.length)throw Error('invalid_cohort_identity')
 if(!Number.isFinite(Date.parse(cohort.created_at))||!Number.isFinite(Date.parse(cohort.retain_until))||Date.parse(cohort.retain_until)<=now)throw Error('cohort_unavailable')
 if(Date.parse(cohort.created_at)>at)return {state:'not_yet_recorded',rows:[],reason:'This original cohort was recorded after the selected knowledge time.'}
 const {data,error}=await db.rpc('intel_global_cohort_quotes',{p_cohort:cohort.id,p_at:new Date(at).toISOString()})
 if(error||!Array.isArray(data))throw Error('cohort_prices_unavailable')
 const members=new Set(cohort.members.map((m:any)=>m.subject))
 if(data.length!==members.size||new Set(data.map(r=>r.subject)).size!==data.length||data.some(r=>!members.has(r.subject)||r.observation!=null&&(r.observation.subject!==r.subject||r.observation.metric!=='price'||r.observation.unit!=='USD'||r.observation.provider!=='coinmarketcap'||!Number.isFinite(Date.parse(r.observation.observedAt))||!Number.isFinite(Date.parse(r.observation.recordedAt))||Date.parse(r.observation.observedAt)>at||Date.parse(r.observation.recordedAt)>at)))throw Error('cohort_prices_incomplete')
 return {state:'retained',rows:data,reason:'Original constituents and retained CMC USD prices known at the selected time. Opening this cohort makes no provider request.'}
}
