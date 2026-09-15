import React from 'react'
import {Link} from 'react-router'
import {InvestigationTable,time,value} from './InvestigationTable'
import RepresentationNotice from './RepresentationNotice'
export default function RwaPortfolioExposure({exposure,portfolioId}){
 if(!exposure)return null
 return <details className="my-3"><summary>RWA exposure in this portfolio reading</summary><p>{exposure.method}</p>
  {!!exposure.failed?.length&&<p role="alert">Relationship evidence could not be read for {exposure.failed.length} positions.</p>}
  {!!exposure.ambiguous?.length&&<p>Conflicting relationships were withheld for {exposure.ambiguous.length} positions.</p>}
  {!!exposure.unmapped?.length&&<p>{exposure.unmapped.length} included positions are unclassified in retained RWA coverage.</p>}
  {!!exposure.groups?.length&&<InvestigationTable caption="Verified underlying and issuer subtotals" rows={exposure.groups} columns={[
   ['Underlying / issuer',r=>`${r.underlyingName} · ${r.issuerName||'Unreported'}`],['Positions',r=>r.positions],['Priced subtotal (USD)',r=>value(r.pricedSubtotalUsd)],['Without price',r=>r.unpriced],
  ]}/>}
  {!exposure.rows?.length?<p>No verified RWA relationship was included in this reading. This does not establish zero RWA exposure.</p>:<InvestigationTable caption="Recorded token positions with verified underlying and issuer" rows={exposure.rows} columns={[
   ['Position',r=><Link className="intel-text-link" to={portfolioId?`/intel/portfolio/${portfolioId}/asset/${encodeURIComponent(r.canonicalAssetKey)}`:`/intel/asset/${encodeURIComponent(r.canonicalAssetKey)}`}>{r.name}</Link>],
   ['Underlying / issuer',r=><Link className="intel-text-link" to={`/intel/investigate?asset=rwa%3Acoinmarketcap%3A${r.rwaId}&lens=ownership&token=${r.cryptoId}`}>{r.underlyingName} · {r.issuerName||'Unreported'}</Link>],
   ['Quantity',r=>value(r.quantity)],['Position (USD)',r=>value(r.valueUsd)],['Portfolio share',r=>r.portfolioAllocationPct==null?'Unavailable':`${value(r.portfolioAllocationPct)}%`],
   ['Evidence',r=><><RepresentationNotice record={r.representationReview??null}/><details><summary>{r.priceStatus||'Quote unavailable'} · {r.relationshipStatus} relationship</summary><p>Position price observed {time(r.positionObservedAt)}</p><p>Relationship first recorded {time(r.relationshipVersion?.recordedAt)}; source effective date unreported.</p><p className="break-all">{r.relationshipVersion?.id}</p></details></>],
  ]}/>}
 </details>
}
