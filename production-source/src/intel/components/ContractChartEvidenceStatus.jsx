import React from 'react'
export default function ContractChartEvidenceStatus({evidence}){
 if(!evidence.enabled)return null
 return <div className="intel-analysis-caption" aria-label="Public market chart history">
  {evidence.error?<span role="alert">{evidence.error} <button className="intel-text-link" onClick={evidence.refresh}>Retry market history</button></span>:<span>{evidence.loading?'Reading retained public market events…':`${evidence.markers.length} retained public market events in this window.`} Public swaps and pool activity are separate from your positions.</span>}
  {evidence.hasMore&&<button className="intel-text-link ml-3" disabled={evidence.loading} onClick={evidence.loadMore}>Load more public market events</button>}
  {evidence.rangeLimited&&<span> Public event history is limited to the final 90 days of this range, subject to source retention.</span>}
 </div>
}
