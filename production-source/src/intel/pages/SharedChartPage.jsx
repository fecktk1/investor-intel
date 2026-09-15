import React,{useCallback,useEffect,useState} from 'react'
import {Link,useLocation} from 'react-router'
import {Helmet} from 'react-helmet-async'
import {useSupabase} from '../../lib/useSupabase'
import {useProfile} from '../../lib/profile-context'
import TokenChart from '../components/TokenChart'
import SavedComparisonChart from '../components/SavedComparisonChart'
import {restrictExpiredSharedSnapshot} from '../lib/chart-snapshot-view'
import ChartReviewPanel from '../components/ChartReviewPanel'
import ChartReviewCleanup from '../components/ChartReviewCleanup'
import '../workspace.css'
export default function SharedChartPage(){const {user}=useSupabase(),{org}=useProfile(),{hash}=useLocation();return <SharedBody key={`${user?.id}:${org?.id}:${hash}`} token={hash.slice(1)}/>}
function SharedBody({token}){
 const {supabase,user}=useSupabase(),[snapshot,setSnapshot]=useState(null),[error,setError]=useState(null),[retry,setRetry]=useState(0),[reviews,setReviews]=useState([]),[selectedReview,setSelectedReview]=useState(null),[focusRequest,setFocusRequest]=useState(0)
 const receiveReviews=useCallback(rows=>{setReviews(rows);setSelectedReview(previous=>previous?rows.find(row=>row.id===previous.id)??null:null)},[])
 const [reviewObservation,setReviewObservation]=useState(null)
 useEffect(()=>{
  let alive=true,inFlight=false,expiry,priceExpiry
  const refresh=async()=>{
   if(inFlight||document.visibilityState==='hidden')return
   inFlight=true
   try{
    if(!/^[a-f0-9]{64}$/.test(token))throw new Error('invalid')
    const {data,error:failure}=await supabase.functions.invoke('intel-chart-share',{body:{token}})
    if(failure||!data?.snapshot)throw new Error('unavailable')
    if(alive){data.snapshot=restrictExpiredSharedSnapshot(data.snapshot);setSnapshot(data.snapshot);setError(null);clearTimeout(expiry);clearTimeout(priceExpiry);if(data.snapshot.retainUntil)priceExpiry=setTimeout(()=>setSnapshot(s=>s?restrictExpiredSharedSnapshot(s):s),Math.max(0,Math.min(data.snapshot.retainUntil-Date.now(),2147483647)));const remaining=Date.parse(data.snapshot.expiresAt)-Date.now();if(remaining<=0){setSnapshot(null);setError('This chart link has expired.')}else expiry=setTimeout(()=>{setSnapshot(null);setError('This chart link has expired.')},Math.min(remaining,2147483647))}
   }catch{if(alive){setSnapshot(null);setError('This chart link is unavailable. It may have expired, been revoked, or require a different signed-in account.')}}finally{inFlight=false}
  }
  const visible=()=>{if(document.visibilityState==='visible'){setSnapshot(null);refresh()}}
  refresh();const interval=setInterval(refresh,30000);document.addEventListener('visibilitychange',visible)
  return()=>{alive=false;clearInterval(interval);clearTimeout(expiry);clearTimeout(priceExpiry);document.removeEventListener('visibilitychange',visible)}
 },[supabase,token,retry])
 const reviewAsset=selectedReview?.anchor.asset||snapshot?.layout.asset
 const reviewSource=snapshot?.comparisonSeries?.find(s=>s.asset===reviewAsset)||snapshot
 return <div className="intel-root intel-shared-chart"><Helmet><title>Shared chart · Investor Intel</title><meta name="robots" content="noindex, noarchive"/><meta name="referrer" content="no-referrer"/></Helmet><main>
  <header className="intel-investigation-heading"><Link className="intel-text-link" to="/intel">Investor Intel</Link>{!user&&<Link className="intel-text-link" to={`/login?next=${encodeURIComponent(`/intel/shared-chart#${token}`)}`}>Sign in</Link>}</header>
  {error?<><p role="alert">{error} <button className="intel-text-link" onClick={()=>setRetry(r=>r+1)}>Retry</button></p>{user&&/^[a-f0-9]{64}$/.test(token)&&<ChartReviewCleanup supabase={supabase} token={token}/>}</>:!snapshot?<p role="status">Opening shared chart…</p>:<>
   <h1 className="page-title">{snapshot.title}</h1><p className="intel-analysis-caption">Saved chart · captured {new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.layout.timezone} · calculation {snapshot.calculationVersion}</p>
   {snapshot.layout.comparison&&<SavedComparisonChart state={snapshot} onObservationChange={setReviewObservation}/>}
   {(!snapshot.layout.comparison||selectedReview)&&<section aria-label="Selected review asset">{snapshot.layout.comparison&&<div className="intel-holdings-toolbar"><h2>{snapshot.layout.comparison.assets.find(a=>a.asset===reviewAsset)?.label} · review anchor</h2><button className="intel-text-link" onClick={()=>setSelectedReview(null)}>Close anchor</button></div>}{(reviewSource.bars?.length||reviews.length)?<TokenChart candles={reviewSource.bars||[]} assetKey={reviewAsset} initialLayout={{...snapshot.layout,asset:reviewAsset,comparison:undefined}} replayCursor={selectedReview?null:undefined} timeWindow={snapshot.layout.range} readOnly priceCoverage={{chartSource:reviewSource.source}} markers={reviews.filter(row=>(row.anchor.asset||snapshot.layout.asset)===reviewAsset).map(row=>({id:`review:${row.id}:${row.revision}`,t:row.anchor.t,group:'review',type:'review',label:'Chart review note',action:'Chart review note',title:`${row.author} · written ${new Date(row.createdAt).toLocaleString()}`,note:row.text,actorKind:'user',chartAnchorPrice:row.anchor.price,recordedAt:row.createdAt}))} cursorTime={selectedReview?.anchor.t??null} focusMarkerRequest={focusRequest} focusMarkerId={selectedReview?`review:${selectedReview.id}:${selectedReview.revision}`:null}/>:<p>The price series is unavailable for this snapshot.</p>}</section>}
   {user&&['owner','org'].includes(snapshot.audience)&&<ChartReviewPanel key={token} supabase={supabase} userId={user.id} token={token} snapshot={snapshot} observation={reviewObservation} onSelect={row=>{setSelectedReview(row);setFocusRequest(r=>r+1)}} onRows={receiveReviews}/>}
   {snapshot.gaps?.map((gap,i)=><p role="status" key={i}>{gap}</p>)}
   {snapshot.layout.drawings.length>0&&<section className="intel-investigation-analysis"><h2>Selected research notes</h2><ul className="intel-study-list">{snapshot.layout.drawings.map(d=><li key={d.id}><div><p>{d.tool.replaceAll('_',' ')} · {d.anchors.map(a=>new Date(a.t).toLocaleString()).join(' → ')}</p><blockquote className="whitespace-pre-wrap break-words">{d.text}</blockquote></div></li>)}</ul></section>}
   <p className="intel-analysis-caption">{snapshot.source.provider==='coinmarketcap'?<a className="intel-text-link" href="https://coinmarketcap.com/" target="_blank" rel="noopener noreferrer">Data provided by CoinMarketCap.com</a>:snapshot.source.provider} · {snapshot.source.currency} · {snapshot.barCount} original observations · link expires {new Date(snapshot.expiresAt).toLocaleString()}</p>
   <details className="intel-chart-readings"><summary>Shared view integrity</summary><p className="break-all">SHA-256 {snapshot.hash}</p><p>Original series SHA-256 {snapshot.sourceHash}</p></details>
  </>}
 </main></div>
}
