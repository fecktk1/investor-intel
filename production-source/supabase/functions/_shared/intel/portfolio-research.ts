import {representationPromptState} from './representation-review.ts'
import {computeTotals} from '../investor-portfolio/holdings.ts'
import {computePortfolioRisk} from '../investor-portfolio/risk.ts'
import {portfolioQuoteStatus} from './portfolio-quote.ts'
import type {PortfolioHolding} from '../investor-portfolio/types.ts'

export const PORTFOLIO_RESEARCH_VERSION='portfolio-research-5'
type Row=Record<string,any>
const number=(v:unknown):number|null=>v!=null&&v!==''&&Number.isFinite(Number(v))?Number(v):null
const text=(v:unknown,n=300)=>typeof v==='string'?v.slice(0,n):''
const cmc=(v:unknown)=>typeof v==='string'&&/^(coinmarketcap|cmc)(:|$)/i.test(v)
const fields=['summary','what_changed','contributors','signal_exposure','risks','news_that_matters'] as const

export function portfolioResearchHolding(r:Row,now:number):PortfolioHolding {
 const market=r.market_context&&typeof r.market_context==='object'?r.market_context:{}
 const exact=!!r.canonical_asset_key&&market.canonicalAssetKey===r.canonical_asset_key
 // Legacy symbol-joined signal/price contexts cannot establish an asset's identity.
 const identityUnverified=r.price_source==='exchange_profile'&&!exact
 const context=exact?market:{}
 const value=identityUnverified?null:number(r.current_value)
 const status=portfolioQuoteStatus({...r,current_value:value,market_context:context},now)
 return {
  assetSymbol:text(r.asset_symbol,80),normalizedSymbol:r.normalized_symbol,canonicalAssetKey:r.canonical_asset_key,
  contractAddress:r.contract_address,mintOrContract:r.mint_or_contract,chain:r.chain,assetClass:r.asset_class||'token',
  name:text(r.name),logoUrl:r.logo_url,verified:r.verified,decimals:r.decimals,supportLevel:r.support_level,
  provider:r.provider,providerNetwork:r.provider_network,costBasisStatus:r.cost_basis_status,
  quantity:number(r.quantity)??0,averageCost:number(r.average_cost),costBasisUsd:number(r.cost_basis_usd),
  currentPrice:identityUnverified?null:number(r.current_price),currentValue:value,priceSource:r.price_source,
  priceStatus:status,lastPricedAt:r.last_priced_at,unrealizedPnl:identityUnverified?null:number(r.unrealized_pnl),
  unrealizedPnlPct:identityUnverified?null:number(r.unrealized_pnl_pct),realizedPnl:number(r.realized_pnl),
  dayPnl:identityUnverified?null:number(r.day_pnl),dayPnlPct:identityUnverified?null:number(r.day_pnl_pct),
  allocationPct:null,pnlState:r.pnl_state||'incomplete_history',reconciliationStatus:r.reconciliation_status,
  marketContext:{...context,...(identityUnverified?{identityUnverified:true}:{})},isDust:!!r.is_dust,isClosed:!!r.is_closed,
 }
}

export function portfolioResearchFacts(snapshot:Row,now=Date.now()) {
 if(snapshot.holdingsTruncated||!Array.isArray(snapshot.holdings)||snapshot.holdings.length>5000)throw new Error('portfolio_analysis_limit')
 const holdings=snapshot.holdings.map((r:Row)=>portfolioResearchHolding(r,now))
 const totals=computeTotals(holdings),open=holdings.filter((h:PortfolioHolding)=>!h.isClosed)
 const risk=computePortfolioRisk(open,totals)
 const selected=[...open].sort((a,b)=>(b.currentValue??-1)-(a.currentValue??-1)||String(a.canonicalAssetKey).localeCompare(String(b.canonicalAssetKey))).slice(0,25)
 const activity=(Array.isArray(snapshot.activity)?snapshot.activity:[]).slice(0,20).map((r:Row)=>({
  id:r.id,kind:r.kind,canonicalAssetKey:r.canonical_asset_key||null,timestamp:r.timestamp||null,
  type:r.manual_pair_classification||r.transaction_type||r.type,direction:r.direction,status:r.status,
  classification:r.classification_status,groupId:r.manual_group_id||null,
  title:text(r.title),notes:text(r.notes,1000),notesTruncated:typeof r.notes==='string'&&r.notes.length>1000,provider:text(r.provider,100),chain:r.chain,
  symbol:text(r.asset_symbol,80),quantity:number(r.quantity),price:number(r.price_per_unit),currency:r.quote_currency,
  fee:number(r.fee_amount),feeCurrency:r.fee_currency||r.fee_asset,feeUsd:number(r.fee_usd),
  transactionRef:r.external_tx_hash||r.external_tx_signature||r.tx_hash||r.signature||null,
 }))
 const metrics={
  currency:'USD',pricedSubtotal:totals.totalValueUsd,totalValue:open.some(h=>h.currentValue==null)?null:totals.totalValueUsd,
  openPositions:open.length,closedPositions:holdings.length-open.length,
  dayPnlPct:totals.dayPnlPct,unrealizedPnl:totals.unrealizedPnlUsd,realizedPnl:totals.realizedPnlUsd,
  unpriced:totals.unpricedCount,stale:totals.staleCount,incompleteHistory:totals.incompleteHistory,
 }
 const facts={metrics,historicalPerformance:null as Row|null,marketEvidence:[] as Row[],marketEvidenceCoverage:null as Row|null,rwaExposure:null as Row|null,benchmarkExposure:[] as Row[],narrativeExposure:null as Row|null,risk:{score:risk.score,band:risk.band,drivers:risk.factors.filter(f=>f.effect==='risk').slice(0,5)},
  coverage:{holdingsIncluded:selected.length,totalOpenHoldings:open.length,holdingsOmitted:Math.max(0,open.length-selected.length),activityHasMore:!!snapshot.activityHasMore,
   incompleteCostBasis:open.filter(h=>['incomplete','partial','unknown','none'].includes(h.costBasisStatus||'unknown')).length,
   identityUnverified:open.filter(h=>(h.marketContext as Row).identityUnverified).length,
   balanceOnlyChains:[...new Set(open.filter(h=>h.supportLevel==='balance_only').map(h=>h.chain))],
   betaHistoryChains:[...new Set(open.filter(h=>h.supportLevel==='beta_history').map(h=>h.chain))]},
  holdings:selected.map(h=>({canonicalAssetKey:h.canonicalAssetKey,symbol:h.assetSymbol,name:h.name,chain:h.chain,quantity:h.quantity,
   value:h.currentValue,price:h.currentPrice,allocationPct:h.allocationPct,priceStatus:h.priceStatus,priceSource:h.priceSource,observedAt:h.lastPricedAt,
   averageCost:h.averageCost,costBasis:h.costBasisUsd,costBasisStatus:h.costBasisStatus,realizedPnl:h.realizedPnl,unrealizedPnl:h.unrealizedPnl,
   supportLevel:h.supportLevel,verified:h.verified,signal:(h.marketContext as Row)?.signalDirection||null})),activity}
 const hasCmc=holdings.some(h=>cmc(h.priceSource)||cmc((h.marketContext as Row).priceProvider))
 return {holdings,open,totals,risk,facts,hasCmc}
}

export function deterministicPortfolioResearch(input:ReturnType<typeof portfolioResearchFacts>,reason='') {
 const {facts,risk}=input,m=facts.metrics
 const money=(n:number|null)=>n==null?'unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n)
 const value=m.totalValue==null?`Priced subtotal ${money(m.pricedSubtotal)}; total value is unavailable because ${m.unpriced} positions lack a verified price.`:`Portfolio value ${money(m.totalValue)}.`
 return {
  summary:`${m.openPositions?value:'No open positions.'} Recorded realized P&L ${money(m.realizedPnl)} across open and closed positions.${m.incompleteHistory?' Some transaction history or cost basis is incomplete.':''}`,
  what_changed:reason||'Recent activity is shown from recorded events. A current balance is not evidence of a new transaction.',
  contributors:facts.holdings.slice(0,3).map(h=>`${h.symbol||h.canonicalAssetKey}: quantity ${h.quantity}, value ${money(h.value)} (${h.priceStatus}).`).join(' '),
  signal_exposure:'Signals use only a matching canonical holding context. Missing signals are unavailable.',
  risks:m.openPositions?risk.summary:'Current-position risk is unavailable without open positions.',
  news_that_matters:'No current portfolio-specific news was included in this evidence read.',confidence:'low',
 }
}

/** AI adds qualitative context; all financial numbers remain deterministic.
 * This avoids accepting a plausible number merely because it occurs elsewhere
 * in the prompt. The evidence inspector carries exact values and provenance. */
export function validatePortfolioNarrative(value:unknown):{ok:boolean;structured:Row|null} {
 if(!value||typeof value!=='object'||Array.isArray(value))return {ok:false,structured:null}
 const r=value as Row
 if(fields.some(k=>typeof r[k]!=='string'||r[k].length>1800||/[\p{N}$€£¥]/u.test(r[k]))||!['high','medium','low'].includes(r.confidence))return {ok:false,structured:null}
 return {ok:true,structured:Object.fromEntries([...fields,'confidence'].map(k=>[k,r[k]]))}
}

function stable(value:any):any {
 if(Array.isArray(value))return value.map(stable)
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]))
 return value
}
function marketFingerprint(value:any):any{
 if(Array.isArray(value))return value.map(marketFingerprint)
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='evaluated_at').map(([key,child])=>[key,marketFingerprint(child)]))
 return value
}
export async function portfolioResearchFingerprint(scope:{orgId:string;userId:string;portfolioId:string},input:ReturnType<typeof portfolioResearchFacts>,mode:string) {
  // Include the full book, including omitted prompt rows and closed history.
 // A refreshed observation of identical values does not require another model
 // call. Fresh/stale status remains part of the key; transaction clocks remain exact.
 const narrative=input.facts.narrativeExposure
 const narrativeFingerprint=narrative?{...narrative,positions:narrative.positions.map(({positionObservedAt:_clock,memberships,...p}:Row)=>({...p,memberships:memberships.map(({membershipRecordedAt:_membershipClock,taxonomyRecordedAt:_taxonomyClock,...m}:Row)=>m)}))}:null
 const facts={...input.facts,historicalPerformance:input.facts.historicalPerformance?{version:input.facts.historicalPerformance.version,status:input.facts.historicalPerformance.status}:null,narrativeExposure:narrativeFingerprint,marketEvidence:marketFingerprint(input.facts.marketEvidence),holdings:input.facts.holdings.map(({observedAt:_clock,...h})=>h)}
 const holdings=input.holdings.map(({lastPricedAt:_clock,marketContext,...h})=>{
  const {priceExpiresAt:_expiry,...context}=marketContext as Row;return {...h,marketContext:context}
 }).sort((a,b)=>String(a.canonicalAssetKey).localeCompare(String(b.canonicalAssetKey)))
 const payload=stable({version:PORTFOLIO_RESEARCH_VERSION,scope,mode,facts,holdings})
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)))
 return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')
}

export function portfolioArtifact(input:ReturnType<typeof portfolioResearchFacts>,structured:Row,observedAt:string,model='deterministic') {
 return {artifact_type:'portfolio_intel',confidence:structured.confidence||'low',structured,
  sources:['Recorded holdings and ledger','Cached asset-specific quotes'],observedAt,model,
  evidence:input.facts,risk:{score:input.risk.score,band:input.risk.band,factors:input.risk.factors}}
}

/** Keep the frozen human evidence in the artifact; only references enter AI. */
export function portfolioResearchPromptFacts(facts:Record<string,any>):Record<string,any>{
 return {...facts,historicalPerformance:facts.historicalPerformance?{method:facts.historicalPerformance.method,status:facts.historicalPerformance.status,version:facts.historicalPerformance.version,note:'Historical calculations are displayed deterministically in the evidence inspector. Do not infer performance from unavailable periods.'}:null,marketEvidence:(facts.marketEvidence||[]).map((row:any)=>({...row,representation_state:representationPromptState(row.representation_state)})),
  ...(facts.rwaExposure?{rwaExposure:{...facts.rwaExposure,rows:(facts.rwaExposure.rows||[]).map((row:any)=>({...row,representationReview:representationPromptState(row.representationReview)}))}}:{})}
}
