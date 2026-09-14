import {getChain,birdeyeChainForApp} from '../chains.ts'
import {birdeyeGet,type BirdeyeContext} from '../birdeye-client.ts'
import {normalizeBars} from './chart-analysis.ts'

const WINDOWS:Record<string,number>={'1H':7,'4H':30,'1D':180,'1W':365}
export function birdeyeChartRequest(chain:string,address:string,timeframe:string,now=Date.now()) {
  const network=getChain(chain),providerChain=birdeyeChainForApp(chain)
  if(!network||!providerChain||!WINDOWS[timeframe]||typeof address!=='string'||!address||address.length>200||!Number.isFinite(now))throw Error('invalid_chart_identity')
  if(network.evmChainId!=null&&!/^0x[0-9a-f]{40}$/i.test(address))throw Error('invalid_chart_identity')
  if(network.evmChainId==null&&!/^[A-Za-z0-9_:+.\-]+$/.test(address))throw Error('invalid_chart_identity')
  const normalized=network.evmChainId!=null?address.toLowerCase():address,end=Math.floor(now/120000)*120
  const params=new URLSearchParams({address:normalized,type:timeframe,currency:'usd',chart_type:'price',time_from:String(end-WINDOWS[timeframe]*86400),time_to:String(end)})
  return {chain,address:normalized,providerChain,timeframe,path:'/defi/ohlcv?'+params.toString()}
}
const empty=(reason:string)=>({candles:[],state:'unavailable',reason,fetchedAt:null,refreshed:false})
function cachedResult(row:any) {
  if(!row||!Array.isArray(row.candles))return empty('cache_unavailable')
  const candles=normalizeBars(row.candles,1000).bars.filter(b=>b.o!=null)
  return {candles,state:row.state,reason:row.reason??null,fetchedAt:row.fetchedAt??null,refreshed:false}
}

/** Shared market-only cache and distributed lease; auth belongs to the caller. */
export async function sharedBirdeyeChart(admin:any,chain:string,address:string,timeframe:string,context:BirdeyeContext={},request=birdeyeGet,now=Date.now()) {
  const plan=birdeyeChartRequest(chain,address,timeframe,now),params={p_chain:plan.chain,p_address:plan.address,p_timeframe:plan.timeframe}
  const claim=await admin.rpc('intel_birdeye_chart_claim',params)
  if(claim.error||!claim.data)return empty('cache_unavailable')
  if(claim.data.claimed!==true)return cachedResult(claim.data)
  if(typeof claim.data.leaseId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claim.data.leaseId))return empty('cache_unavailable')
  let candles:any[]|null=null,error:string|null=null
  try{
    const result=await request(plan.path,{chain:plan.providerChain,ctx:{...context,supabase:admin,strictBudget:true},tokenAddress:plan.address})
    if(!result)error='provider_unavailable'
    else if(!result.ok)error=result.status===401||result.status===403?'access_denied':result.status===429?'rate_limited':result.status===404?'missing_coverage':'provider_unavailable'
    else{
      const items=result.data?.data?.items
      if(!Array.isArray(items)||items.length>1000)error='malformed_response'
      else {
        candles=normalizeBars(items.map((i:any)=>({t:Number(i.unixTime??i.time)*1000,o:i.o,h:i.h,l:i.l,c:i.c,v:i.v})),1000).bars.filter(b=>b.o!=null)
        if(items.length&&!candles.length){candles=null;error='malformed_response'}
      }
    }
  }catch{error='provider_unavailable'}
  const saved=await admin.rpc('intel_birdeye_chart_finish',{...params,p_lease_id:claim.data.leaseId,p_candles:candles,p_error:error})
  if(saved.error||saved.data?.applied!==true)return {...cachedResult(claim.data),state:claim.data.candles?.length?'stale':'unavailable',reason:'cache_unavailable'}
  return {...cachedResult(saved.data),refreshed:!error}
}
