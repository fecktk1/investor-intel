import React,{useState} from 'react'
import {Link,useLocation,useParams} from 'react-router'
import {useMarketResearch} from '../lib/useMarketResearch'
import {useAssetPortfolioContext} from '../lib/useAssetPortfolioContext'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'
import AssetPortfolioPosition from './AssetPortfolioPosition'
import {representationReview} from '../../../supabase/functions/_shared/intel/representation-review.ts'
function Position({canonicalAssetKey,portfolioId}){
 const context=useAssetPortfolioContext({canonicalAssetKey,portfolioId})
 return <><AssetPortfolioPosition context={context} compact/>{context.portfolioId&&<Link className="intel-text-link" to={`/intel/portfolio/${context.portfolioId}/asset/${encodeURIComponent(canonicalAssetKey)}`}>Position history and chart</Link>}</>
}
export function ResolvedCmcPosition({assetId,portfolioId}){
 const [network,setNetwork]=useState(null),key=`market:coinmarketcap:${assetId}`
 const q=useMarketResearch('assetIdentity',{canonicalKey:key},true),identity=q.result?.identity,choices=identity?.choices||[]
 const selected=choices.find(c=>c.canonicalAssetKey===network)||(choices.length===1?choices[0]:null)
 const canonical=selected?.canonicalAssetKey||(choices.length<=1?identity?.contractSubject:null)
 return <>{q.loading?<p role="status">Reading the verified token networks…</p>:q.error?<p role="alert">Token networks could not be read. Your position has not been evaluated.</p>:<>
  {choices.length>1&&<label>Position network <select className="select" value={selected?.canonicalAssetKey||''} onChange={e=>setNetwork(e.target.value||null)}><option value="">Choose a network</option>{choices.map(c=><option key={c.canonicalAssetKey} value={c.canonicalAssetKey}>{c.label||c.chain||c.canonicalAssetKey}{representationReview(c.canonicalAssetKey)?' · Issuer deployment notice':''}</option>)}</select></label>}
  {canonical?<Position key={canonical} canonicalAssetKey={canonical} portfolioId={portfolioId}/>:<p>{choices.length>1?'Choose the representation you hold. Portfolios and overlapping wallets are not automatically aggregated.':'No verified token network mapping is retained. This is not evidence of an empty position.'}</p>}
 </>}</>
}
/** Reading positions remains explicit and uses the existing authorized ledger.
 * Exchange disclosure balances never enter this private accounting path. */
export default function CmcAssetPosition({assetId,portfolioId}){
 const [open,setOpen]=useState(false),{org}=useProfile(),{user}=useSupabase(),route=useParams(),location=useLocation()
 const explicit=route.portfolioId||portfolioId||new URLSearchParams(location.search).get('portfolio')||undefined
 if(!/^[1-9][0-9]{0,11}$/.test(String(assetId))||!org?.id||!user?.id)return null
 return <details onToggle={e=>{if(e.target===e.currentTarget)setOpen(e.currentTarget.open)}}><summary>Your position and activity in this asset</summary>
  {open&&<ResolvedCmcPosition key={`${user.id}:${org.id}:${assetId}:${explicit||''}`} assetId={assetId} portfolioId={explicit}/>}
 </details>
}
