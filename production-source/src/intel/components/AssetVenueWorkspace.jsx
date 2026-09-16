import React,{useState} from 'react'
import {useTranslation} from 'react-i18next'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'
import {useMarketResearch} from '../lib/useMarketResearch'
import VenueEvidence from './VenueEvidence'
import AdoptionAttentionEvidence from './AdoptionAttentionEvidence'
import {SecuritySourceHistory,RwaSourceEvidence} from './MarketSourceHistory'
import BenchmarkEvidence from './BenchmarkEvidence'
import {InvestigationTable,time,value} from './InvestigationTable'
import FigureProvenance from './FigureProvenance'
export default function AssetVenueWorkspace({canonicalKey,provenance=null}){const {org}=useProfile(),{user}=useSupabase();return <Workspace key={`${user?.id}:${org?.id}:${canonicalKey}`} canonicalKey={canonicalKey} provenance={provenance}/>}
const VENUE_GROUPS=[['cex','receipt_state.venue_cex','Exchange tickers'],['orderbook','receipt_state.venue_orderbook','Order book depth'],['dex','receipt_state.venue_dex','DEX pool']]
/** Play 7 for the spot venue figures on the asset page (the per-exchange reads,
 * the order book depth and the DEX pool). The asset detail read states one
 * envelope per group; a group the read did not include draws nothing rather
 * than an unfounded claim. These envelopes describe stored figures, so no
 * provider call receipt exists for them and none is drawn. */
export function VenueFigureProvenance({provenance}){
 const {t}=useTranslation('intel',{useSuspense:false})
 const groups=VENUE_GROUPS.filter(([key])=>provenance?.[key]&&typeof provenance[key]==='object')
 if(!groups.length)return null
 return <div className="intel-venue-provenance" aria-label={t('receipt_state.venue_title',{defaultValue:'Where the spot venue figures come from'})}>
  <p className="intel-analysis-caption">{t('receipt_state.venue_title',{defaultValue:'Where the spot venue figures come from'})}</p>
  {groups.map(([key,label,fallback])=><div key={key} data-venue-group={key}><p className="intel-event-meta">{t(label,{defaultValue:fallback})}</p><FigureProvenance envelope={provenance[key]}/></div>)}
 </div>
}
function Workspace({canonicalKey,provenance}){
 const [intent,setIntent]=useState({refresh:false,revision:0}),[selected,setSelected]=useState(null)
 const request=useMarketResearch('venueContext',{canonicalKey,refresh:intent.refresh,requestRevision:intent.revision},!!canonicalKey),result=request.result,derivatives=result?.derivatives
 return <section id="asset-venue-evidence" className="intel-open-section"><div className="intel-holdings-toolbar"><h2>Venues & positioning</h2><button className="btn btn--ghost" disabled={request.loading||!canonicalKey} onClick={()=>{setSelected(null);setIntent(i=>({refresh:true,revision:i.revision+1}))}}>Refresh shared venue evidence</button></div>
  <p className="intel-analysis-caption">Open interest, funding, liquidation windows and recorded spot depth. Initial viewing reads retained data. An explicit refresh uses the shared provider cache and existing account budget.</p>
  <VenueFigureProvenance provenance={provenance}/>
  {request.loading?<p role="status">Loading venue evidence…</p>:request.error?<p role="alert">{request.error} <button className="intel-text-link" onClick={()=>setIntent(i=>({refresh:false,revision:i.revision+1}))}>Retry retained read</button></p>:result?.schemaVersion!==1?<p role="alert">The venue response is incomplete. Retry the evidence read.</p>:<>
   {result.refreshResults?.map((r,i)=><p key={r.capability||i} role={r.state==='error'?'alert':undefined}>{r.capability==='derivativePairs'?'Derivative contracts':r.capability==='liquidationAssets'?'Asset liquidations':'Refresh'}: {r.state}{r.reason?` · ${r.reason}`:''}</p>)}
   {derivatives?.status==='error'&&<p role="alert">{derivatives.reason}</p>}
   <AdoptionAttentionEvidence comparison={result.cmcContract?.attention_comparison}/>
   <RwaSourceEvidence history={result.rwa}/><SecuritySourceHistory history={result.security}/>
   <BenchmarkEvidence evidence={result.benchmark} asset={canonicalKey}/>
   <VenueEvidence observations={derivatives?.observations||[]} subject={result.subject} at={Date.parse(result.evaluatedAt)} depth={result.depth} onSelect={setSelected}/>
   {selected&&<aside className="intel-source-record" aria-label="Selected venue observation"><button className="intel-text-link" onClick={()=>setSelected(null)}>Close observation</button><p>{selected.metric}: {value(selected.value)} {selected.unit}</p><p>Observed {time(selected.observedAt)} · known {time(selected.recordedAt)}</p><p className="break-all">{selected.sourceRef}</p></aside>}
   {!!derivatives?.observations?.length&&<details><summary>Retained observations and coverage ({derivatives.observations.length})</summary><p>{derivatives.coverage} {derivatives.has_more?'More observations exist outside this bounded read.':''}</p><InvestigationTable caption="Retained source records, including older observations" rows={derivatives.observations} columns={[
    ['Metric',o=>o.metric.replaceAll('_',' ')],['Venue / contract',o=>o.metadata?.venue?`${o.metadata.venue} · ${o.metadata.contractId}`:'Asset aggregate'],['Value',o=>`${value(o.value)} ${o.unit}`],['Observed',o=>time(o.observedAt)],['Known',o=>time(o.recordedAt)],['Source',o=><button className="intel-text-link" onClick={()=>setSelected(o)}>{o.provider}</button>],
   ]}/></details>}
  </>}
 </section>
}
