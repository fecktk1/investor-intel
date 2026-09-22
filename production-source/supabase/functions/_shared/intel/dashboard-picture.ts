import {createDashboardReads} from './dashboard-reads.ts'
import {readBriefNews} from './brief-news.ts'
/** Read exactly the facts displayed by Today's picture. Full evidence packs
 * remain on the legacy grounding/full operations and explicit brief/research.
 * Call only after requireIntelAccess. No asset-pack construction or provider IO. */
export async function readDashboardPicture(db:any,orgId:string,userId:string,now=new Date()){
 if(!orgId||!userId||!Number.isFinite(now.getTime()))throw Error('dashboard_picture_identity_required')
 return await assembleDashboardPicture(db,now,()=>db.from('large_transfer_events').select('chain,canonical_asset_key,symbol,amount,usd_value,threshold_usd,direction,label,observed_at,fetched_at').eq('org_id',orgId).eq('user_id',userId).lte('observed_at',now.toISOString()).order('observed_at',{ascending:false}).limit(9))
}
/** Today's picture for the public demo: the same shared macro and news facts,
 * and the per-member flow highlights answered EMPTY without a query. */
export async function readPublicDashboardPicture(db:any,now=new Date()){
 if(!Number.isFinite(now.getTime()))throw Error('dashboard_picture_clock_required')
 return await assembleDashboardPicture(db,now,()=>Promise.resolve({data:[],error:null}))
}
async function assembleDashboardPicture(db:any,now:Date,flowsRead:()=>PromiseLike<{data:any;error:any}>){
 const batch=createDashboardReads(3)
 const [macro,news,flows]=await Promise.all([
  batch.read('macro',()=>db.from('market_macro_available').select('*').order('as_of',{ascending:false}).limit(2)),
  batch.read('news',async()=>({data:await readBriefNews(db,now,8),error:null})),
  batch.read('flows',flowsRead),
 ])
 const failed=Object.keys(batch.states).filter(k=>batch.states[k].state==='error')
 return {picture:{assembled_at:now.toISOString(),projection:'dashboard-picture-1',macro_rotation:{macro:macro.data||[]},news_that_matters:news.data||[],flow_highlights:(flows.data||[]).slice(0,8),
  context_coverage:{flows_truncated:(flows.data?.length||0)>8},data_coverage:{checked_sources:['market_macro_available','intel_curated_news','large_transfer_events'],unavailable_sources:failed,
   material_gaps:macro.error?['Market context could not be read.']:!macro.data?.length?['No cached market macro context was available.']:[],should_show_warning:!!failed.length,confidence_impact:failed.length?'high':'none'},read_states:batch.states},timing:batch.timing()}
}
