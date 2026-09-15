import React,{useState} from 'react'
import {useSupabase} from '../../lib/useSupabase'
import {useProfile} from '../../lib/profile-context'
// Local-only read verification. Uses the normal authenticated app client; no
// credentials, impersonation or private record bodies enter the displayed result.
export default function ScreenVerification(){
 const {supabase}=useSupabase(),{org}=useProfile(),[result,setResult]=useState(null),[busy,setBusy]=useState(false)
 async function run(){setBusy(true);const start=performance.now();try{
  const resolver=await supabase.rpc('get_my_org_id')
  const read=await supabase.rpc('intel_markets_screen',{p_org_id:org.id,p_query:{page:0,limit:50,sort:'market_cap'}})
  setResult({durationMs:Math.round(performance.now()-start),organizationMatches:resolver.data===org.id,resolverError:resolver.error?.code||null,error:read.error?{code:read.error.code,message:read.error.message}:null,total:read.data?.total,rows:read.data?.records?.length})
 }catch(error){setResult({error:String(error.message)})}finally{setBusy(false)}}
 async function deployed(){setBusy(true);const results=[];try{for(const [name,body] of [['first page',{page:0,limit:50}],['warm first page',{page:0,limit:50}],['second page',{page:1,limit:50}],['Bitcoin search',{search:'Bitcoin',limit:50}],['workspace watchlist',{watchlistOnly:true,limit:50}],['legacy Bitcoin URL',{symbol:'BTC',quotesOnly:true}],['legacy Ethereum URL',{symbol:'ETH',quotesOnly:true}],['CMC USDC quote',{sourceProvider:'coinmarketcap',providerId:'3408',quotesOnly:true}],['invalid workspace',{orgId:'00000000-0000-0000-0000-000000000000'}]]){
  const started=performance.now(),read=await supabase.functions.invoke('intel-markets',{body:{orgId:org.id,sort:'market_cap',...body}}),details=read.error?await read.error.context?.json?.().catch(()=>null):null
  results.push({name,durationMs:Math.round(performance.now()-started),status:read.error?.context?.status||200,error:details?.error||read.data?.error||read.error?.message||null,total:read.data?.total,rows:read.data?.rows?.length,sourceProvider:read.data?.sourceProvider,providerId:read.data?.providerId,quoteProvider:read.data?.quoteProvider,price:read.data?.price,asOf:read.data?.asOf,identities:read.data?.rows?.map(r=>`${r.sourceProvider}:${r.providerId}`)})
  setResult(results)
 }}catch(error){setResult([...results,{error:String(error.message)}])}finally{setBusy(false)}}
 async function refreshCatalog(){setBusy(true);const started=performance.now();try{const r=await supabase.functions.invoke('market-assets-refresh',{body:{mode:'broad'}});setResult({durationMs:Math.round(performance.now()-started),status:r.error?.context?.status||200,result:r.data,error:r.error?.message||null})}finally{setBusy(false)}}
 return <section aria-label="Local backend verification"><h2>Local backend verification</h2><button disabled={busy} onClick={refreshCatalog}>Refresh shared market catalogue</button><button disabled={busy} onClick={run}>Verify signed-in screening</button><button disabled={busy} onClick={deployed}>Verify deployed screening</button><pre aria-label="Verification result">{JSON.stringify(result,null,2)}</pre></section>
}
