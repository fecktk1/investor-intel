import {chartSourceShareAllowed,validChartShareToken} from './chart-share-service.ts'
/** A crawler gets permission status only, never chart prices or authored text. */
export async function chartLinkPreview(db:any,token:unknown,env:(key:string)=>string|undefined,now=Date.now()){
 if(!validChartShareToken(token))throw Error('chart_share_unavailable')
 const {data,error}=await db.rpc('intel_resolve_chart_share',{p_token:token,p_viewer:null})
 if(error)throw Error('chart_share_storage_unavailable')
 if(!data||!['public','unlisted'].includes(data.audience)||!chartSourceShareAllowed(data.snapshot,env,now))throw Error('chart_share_unavailable')
 return {preview:{version:1,available:true,kind:'brand',audience:data.audience}}
}
