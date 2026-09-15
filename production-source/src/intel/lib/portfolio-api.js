import {portfolioReadingHistoryEnabled} from './portfolio-research-rollout'
// Investor Intel — Portfolio Tracker client API.
//
// READ-ONLY product. Portfolio rows are written under the user's per-user RLS
// (org_id = your org AND user_id = you). Pricing/holdings/backfill happen in the
// portfolio-sync edge function + worker; AI in intel-portfolio. Mirrors the
// watchlist-api.js conventions: (supabase, orgId, ...), throw on error,
// invoke() for edge calls.

import { loadMarketContextBySymbols } from './markets-api'
import { getAuthenticatedAccessToken } from '../../lib/supabase'
import { portfolioEventMarkers } from './portfolio-markers'
import { canonicalPortfolioKey } from './asset-identity'
import { manualAssetIdentity } from './manual-asset'
import { portfolioQuoteStatus } from '../../../supabase/functions/_shared/intel/portfolio-quote.ts'
import { portfolioSyncChangesActivity } from './portfolio-refresh'
import {requirePortfolioOverview,requirePortfolioPage} from './portfolio-response'
export { loadMarketContextBySymbols }

const clean = (s) => String(s || '').trim()
function notifyPortfolioActivity(orgId,portfolioId){
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('intel:portfolio-activity-changed',{detail:{orgId,portfolioId}}))
}

// ─── Portfolios ──────────────────────────────────────────────────────────────

export async function listPortfolios(supabase, orgId) {
  const { data, error } = await supabase.from('investor_portfolios')
    .select('*').eq('org_id', orgId).order('is_default', { ascending: false }).order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

export async function getPortfolio(supabase, orgId, portfolioId) {
  const {data,error}=await supabase.rpc('intel_portfolio_overview',{p_org_id:orgId,p_portfolio_id:portfolioId})
  if(error)throw error
  requirePortfolioOverview(data,orgId,portfolioId)
  const quote=page=>({...page,rows:(page?.rows||[]).map(h=>({...h,price_status:portfolioQuoteStatus(h)}))})
  const open={...quote(data?.open),hideDust:!!data?.portfolio?.hide_dust},closed=quote(data?.closed)
  return {portfolio:data?.portfolio,summary:data?.summary,open,closed,sourcePage:data?.sources,
    holdings:[...open.rows,...closed.rows],sources:data?.sources?.rows||[]}
}

export async function getPortfolioPage(supabase,orgId,portfolioId,{kind='holdings',view='open',page=0,limit=25,search='',sort='value',hideDust=false,exporting=false,revision=null,signal}={}) {
  const requestedPage=Math.max(0,Math.min(1000000,Math.trunc(Number(page)||0))),requestedLimit=Math.max(1,Math.min(250,Math.trunc(Number(limit)||25)))
  let query=supabase.rpc('intel_portfolio_page',{p_org_id:orgId,p_portfolio_id:portfolioId,p_kind:kind,p_view:view,p_page:requestedPage,p_limit:requestedLimit,p_search:String(search).slice(0,160),p_sort:sort,p_hide_dust:hideDust,p_export:exporting,p_revision:revision})
  if(signal)query=query.abortSignal(signal)
  const {data,error}=await query
  if(error)throw error
  requirePortfolioPage(data,requestedPage,requestedLimit)
  return {...data,rows:(data?.rows||[]).map(row=>kind==='holdings'?{...row,price_status:portfolioQuoteStatus(row)}:row)}
}

// Explicit exports traverse bounded pages and abort if any source row changes.
export async function exportPortfolioHoldings(supabase,orgId,portfolioId,{signal,onProgress}={}) {
  let page=0,revision=null,rows=[]
  do {
    if(signal?.aborted)throw new DOMException('Export canceled','AbortError')
    const result=await getPortfolioPage(supabase,orgId,portfolioId,{view:'all',page,limit:250,sort:'id',exporting:true,revision,signal})
    if(!result.revision||result.hasMore&&!result.rows.length)throw Error('The holdings export could not verify its source. Retry the export.')
    revision=result.revision;rows.push(...result.rows);onProgress?.(rows.length,result.total)
    if(!result.hasMore)break
    page++
  }while(true)
  if(signal?.aborted)throw new DOMException('Export canceled','AbortError')
  return rows
}

export async function createPortfolio(supabase, orgId, userId, { name = 'My Portfolio', baseCurrency = 'USD', isDefault = false } = {}) {
  const { data, error } = await supabase.from('investor_portfolios')
    .insert({ org_id: orgId, user_id: userId, name, base_currency: baseCurrency, is_default: isDefault })
    .select('*').single()
  if (error) throw error
  return data
}

export async function ensureDefaultPortfolio(supabase, orgId, userId) {
  const { data: existing,error } = await supabase.from('investor_portfolios')
    .select('*').eq('org_id', orgId).eq('user_id', userId).eq('is_default', true).maybeSingle()
  if(error)throw error
  if (existing) return existing
  return createPortfolio(supabase, orgId, userId, { name: 'My Portfolio', isDefault: true })
}

export async function renamePortfolio(supabase, portfolioId, name) {
  const { error } = await supabase.from('investor_portfolios').update({ name: clean(name) }).eq('id', portfolioId)
  if (error) throw error
}

// Display-only "hide dust" view preference (migration 198). Persisted per
// portfolio so it survives logout/login. RLS already restricts the row to the
// owner (org_id = my org AND user_id = me).
export async function setHideDust(supabase, portfolioId, hideDust) {
  const { error } = await supabase.from('investor_portfolios').update({ hide_dust: !!hideDust }).eq('id', portfolioId)
  if (error) throw error
}

// Cascade removes sources/txns/holdings/snapshots/sync_logs/sync_jobs AND private
// memory (FK ON DELETE CASCADE) — no orphaned portfolio memory is possible.
export async function deletePortfolio(supabase, portfolioId) {
  const { error } = await supabase.from('investor_portfolios').delete().eq('id', portfolioId)
  if (error) throw error
}

export async function clearPortfolioMemory(supabase, portfolioId) {
  const { error } = await (portfolioReadingHistoryEnabled()?supabase.rpc('intel_clear_portfolio_research',{p_portfolio_id:portfolioId}):supabase.from('investor_portfolio_memory').delete().eq('portfolio_id',portfolioId))
  if (error) throw error
}

// ─── Holdings & snapshots ────────────────────────────────────────────────────

// Kept for existing callers; full reads are explicit and paginated, with org scope.
export async function getHoldings(supabase,orgId,portfolioId,options={}) {
  return exportPortfolioHoldings(supabase,orgId,portfolioId,options)
}

// Match only verified representations of one asset, without loading a portfolio
// ledger or merging same-symbol holdings from unrelated networks/contracts.
export async function getPortfolioChoiceHoldings(supabase, orgId, userId, portfolioId, choiceKeys) {
  const keys = [...new Set((choiceKeys || []).map(canonicalPortfolioKey).filter(Boolean))].slice(0, 64)
  if (!orgId || !userId || !portfolioId || !keys.length) return []
  const { data, error } = await supabase.from('investor_portfolio_holdings')
    .select('canonical_asset_key,quantity,is_closed,current_value')
    .eq('org_id', orgId).eq('user_id', userId).eq('portfolio_id', portfolioId)
    .in('canonical_asset_key', keys).limit(keys.length)
  if (error) throw error
  return (data || []).filter(row => keys.includes(row.canonical_asset_key))
}

// Canonical asset + bounded time window. The invoker RPC reads current holdings
// and existing ledger records; it neither syncs wallets nor creates transactions.
export async function getAssetPortfolioContext(supabase, orgId, { portfolioId, canonicalAssetKey, from, to, cursor = null, limit = 200 } = {}) {
  const fromTime = typeof from === 'number' ? from : Date.parse(from)
  const toTime = typeof to === 'number' ? to : Date.parse(to)
  if (!orgId || !portfolioId || !canonicalAssetKey || !Number.isFinite(fromTime) || !Number.isFinite(toTime)
    || fromTime > toTime || toTime - fromTime > 366 * 86400000) throw new Error('Invalid asset or chart range')
  const { data, error } = await supabase.rpc('intel_asset_portfolio_context', {
    p_org_id: orgId, p_portfolio_id: portfolioId, p_asset_key: canonicalAssetKey,
    p_from: new Date(fromTime).toISOString(), p_to: new Date(toTime).toISOString(),
    p_cursor: cursor, p_limit: Math.max(1, Math.min(500, Math.trunc(Number(limit) || 200))),
  })
  if (error) throw error
  return { ...data, holding:data?.holding?{...data.holding,price_status:portfolioQuoteStatus(data.holding)}:null, events: data?.events || [], markers: portfolioEventMarkers(data?.events, { portfolioId, canonicalAssetKey }) }
}

export async function getAssetPortfolioHolding(supabase,orgId,{portfolioId,canonicalAssetKey,signal}={}){
 if(!orgId||!portfolioId||!canonicalAssetKey)throw Error('Portfolio scope required')
 let query=supabase.rpc('intel_asset_portfolio_holding',{p_org_id:orgId,p_portfolio_id:portfolioId,p_asset_key:canonicalAssetKey})
 if(signal)query=query.abortSignal(signal)
 const {data,error}=await query
 if(error)throw error
 if(!data||!Object.hasOwn(data,'holding'))throw Error('Position is unavailable')
 return data.holding?{...data.holding,price_status:portfolioQuoteStatus(data.holding)}:null
}

export async function getAssetPortfolioEvent(supabase,orgId,{portfolioId,canonicalAssetKey,eventKey,signal}={}){
 if(!orgId||!portfolioId||!canonicalAssetKey||!/^(manual|grouped|pair):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(eventKey||''))throw Error('Invalid activity reference')
 const request=supabase.rpc('intel_asset_portfolio_event',{p_org_id:orgId,p_portfolio_id:portfolioId,p_asset_key:canonicalAssetKey,p_event_key:eventKey})
 const {data,error}=await (signal?request.abortSignal(signal):request)
 if(error)throw error
 return portfolioEventMarkers(data?.event?[data.event]:[],{portfolioId,canonicalAssetKey})[0]||null
}

export async function getSnapshots(supabase, orgId, portfolioId, { limit = 365, before = null } = {}) {
  let query = supabase.from('investor_portfolio_snapshots')
    .select('snapshot_date, total_value_usd, day_pnl_usd, unrealized_pnl_usd, realized_pnl_usd')
    .eq('org_id', orgId).eq('portfolio_id', portfolioId).order('snapshot_date', { ascending: false }).limit(Math.max(1, Math.min(365, Math.trunc(Number(limit) || 365))))
  if (before) query = query.lt('snapshot_date', new Date(before).toISOString().slice(0, 10))
  const { data, error } = await query
  if (error) throw error
  // Keep the P&L columns (already selected) instead of collapsing to {t,value},
  // so the chart can plot realized/unrealized P&L. `value` stays for back-compat.
  return [...(data || [])].reverse().map((s) => ({
    t: new Date(s.snapshot_date).getTime(),
    value: s.total_value_usd,
    dayPnl: s.day_pnl_usd,
    unrealizedPnl: s.unrealized_pnl_usd,
    realizedPnl: s.realized_pnl_usd,
  }))
}

// ─── Transactions ────────────────────────────────────────────────────────────

export async function listTransactions(supabase, orgId, portfolioId, { type, chain, search, limit = 500 } = {}) {
  let q = supabase.from('investor_portfolio_transactions')
    .select('*, source:investor_portfolio_sources(provider, source_type)')
    .eq('portfolio_id', portfolioId).order('timestamp', { ascending: false, nullsFirst: false }).limit(limit)
  if (type) q = q.eq('transaction_type', type)
  if (chain) q = q.eq('chain', chain)
  if (search) q = q.ilike('asset_symbol', `%${clean(search)}%`)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

function manualTitle(m) {
  const sym = m.asset_symbol || 'asset'
  const t = m.transaction_type
  if (t === 'buy') return `Bought ${sym}`
  if (t === 'sell') return `Sold ${sym}`
  if (t === 'swap') return `Swapped ${sym}`
  if (t === 'transfer_in' || t === 'deposit') return `Received ${sym}`
  if (t === 'transfer_out' || t === 'withdrawal') return `Sent ${sym}`
  return `${t.replace(/_/g, ' ')} ${sym}`
}

// Legacy callers still receive one bounded window; the workspace uses cursors.
export async function listActivity(supabase,orgId,portfolioId,{limit=100}={}) {
 return (await getActivityPage(supabase,orgId,portfolioId,{limit})).rows
}

export function normalizeActivity(grouped=[],manual=[]) {
  const items = []
  for (const g of grouped) {
    items.push({
      id: g.id, eventKey: `grouped:${g.id}`, lineItemCount:g.line_item_count??g.line_items?.length??0, source:g.provider, recordedAt:g.created_at, kind: 'grouped', isManual: false, chain: g.chain, txRef: g.tx_hash || g.signature || null,
      type: g.type, subtype: g.subtype, title: g.title, summary: g.summary, notes: g.notes, protocol: g.protocol,
      counterparty: g.counterparty, status: g.status, confidence: g.confidence,
      classification_status: g.classification_status, timestamp: g.block_time, lineItems: g.line_items || [],
      feeAsset: g.fee_asset, feeAmount: g.fee_amount, feeUsd: g.fee_usd,
    })
  }
  for (const m of manual) {
    const isUsd = String(m.quote_currency || '').toUpperCase() === 'USD'
    items.push({
      id: m.id, eventKey:m.event_key||`manual:${m.id}`, source:m.raw_metadata?.source||m.source?.provider||'manual', recordedAt:m.created_at, kind: 'manual', isManual: true, chain: m.chain, txRef: m.external_tx_hash || m.external_tx_signature || null,
      type: m.transaction_type, subtype: null, title: manualTitle(m), summary: null, notes: m.notes, protocol: null,
      counterparty: null, status: 'success', confidence: m.confidence_score,
      classification_status: m.classification_status, timestamp: m.timestamp,
      feeAsset: m.fee_currency, feeAmount: m.fee_amount, feeUsd: String(m.fee_currency || '').toUpperCase() === 'USD' ? m.fee_amount : null,
      lineItems: [{ canonical_asset_key: m.canonical_asset_key, chain: m.chain, mint_or_contract: m.contract_address, symbol: m.asset_symbol, name: null, decimals: null, direction: m.direction, amount: m.quantity, price_usd_at_tx: isUsd ? m.price_per_unit : null, value_usd_at_tx: isUsd ? m.total_value : null, recorded_price: m.price_per_unit, recorded_value: m.total_value, quote_currency: m.quote_currency, price_source_at_tx: 'manual', logo_url: null, verified: false }],
    })
  }
  const groups=new Map()
  for(const row of manual){if(row.raw_metadata?.manual_group_id){const id=row.raw_metadata.manual_group_id;groups.set(id,[...(groups.get(id)||[]),row.id])}}
  for(const [groupId,ids] of groups){
    const legs=items.filter(item=>item.isManual&&ids.includes(item.id))
    if(legs.length!==2)throw new Error('A paired swap is incomplete. Refresh activity before changing this record.')
    const sent=legs.find(item=>item.lineItems[0]?.direction==='out')||legs[0],received=legs.find(item=>item.lineItems[0]?.direction==='in')||legs[1]
    const classification=manual.find(row=>row.id===sent.id)?.raw_metadata?.manual_pair_classification||'swap'
    const title=classification==='swap'?'Swapped '+sent.lineItems[0]?.symbol+' for '+received.lineItems[0]?.symbol:classification==='buy'?'Bought '+received.lineItems[0]?.symbol+' with '+sent.lineItems[0]?.symbol:classification==='sell'?'Sold '+sent.lineItems[0]?.symbol+' for '+received.lineItems[0]?.symbol:classification.replaceAll('_',' ')+' · '+sent.lineItems[0]?.symbol+' → '+received.lineItems[0]?.symbol
    const combined={...sent,eventKey:`pair:${groupId}`,lineItemCount:2,type:classification,manualGroupId:groupId,transactionIds:ids,title,lineItems:[...sent.lineItems,...received.lineItems],feeAmount:sent.feeAmount,feeUsd:sent.feeUsd}
    for(const item of legs)items.splice(items.indexOf(item),1)
    items.push(combined)
  }
  items.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
  return items
}


export async function getActivityPage(supabase,orgId,portfolioId,{limit=25,cursor=null,direction='older',search='',type=null,status=null,exporting=false,revision=null,signal}={}) {
 const query=supabase.rpc('intel_portfolio_activity_page',{p_org_id:orgId,p_portfolio_id:portfolioId,p_limit:Math.max(1,Math.min(100,Math.trunc(Number(limit)||25))),p_cursor:cursor,p_direction:direction,p_search:String(search).slice(0,160),p_type:type||null,p_status:status||null,p_export:exporting,p_revision:revision})
 const {data,error}=await(signal&&query.abortSignal?query.abortSignal(signal):query)
 if(error)throw error
 if(!data||!Array.isArray(data.order))throw Error('Activity could not be verified. Reload this portfolio.')
 const byKey=new Map(normalizeActivity(data.grouped||[],data.manual||[]).map(item=>[item.eventKey,item]))
 const rows=data.order.map(key=>{const row=byKey.get(key);if(!row)throw Error('An activity record is incomplete. Reload this portfolio.');return row})
 return {...data,rows}
}

export async function getActivityLegs(supabase,orgId,portfolioId,txId,{page=0,limit=50,revision=null,signal}={}) {
 const query=supabase.rpc('intel_portfolio_activity_legs',{p_org_id:orgId,p_portfolio_id:portfolioId,p_tx_id:txId,p_page:page,p_limit:Math.max(1,Math.min(100,Math.trunc(Number(limit)||50))),p_revision:revision})
 const {data,error}=await(signal&&query.abortSignal?query.abortSignal(signal):query)
 if(error)throw error
 if(!data||!Array.isArray(data.rows)||!data.revision)throw Error('Transaction legs could not be verified.')
 return data
}

export async function exportPortfolioActivity(supabase,orgId,portfolioId,{signal,onProgress}={}) {
 const output=[],seen=new Set();let cursor=null,revision=null
 const canceled=()=>{if(signal?.aborted)throw Error('Export canceled.')}
 for(;;){
  canceled();const result=await getActivityPage(supabase,orgId,portfolioId,{limit:100,cursor,exporting:true,revision,signal});canceled()
  if(!result.revision||revision&&result.revision!==revision)throw Error('Activity changed during export. Start the export again.')
  revision=result.revision
  for(const row of result.rows){
   if(seen.has(row.eventKey))throw Error('Repeated activity during export. Start the export again.');seen.add(row.eventKey)
   if(row.kind==='grouped'&&row.lineItemCount>row.lineItems.length){
    let page=0,legRevision=null;const all=[]
    for(;;){canceled();const legs=await getActivityLegs(supabase,orgId,portfolioId,row.id,{page,limit:100,revision:legRevision,signal});canceled();if(legRevision&&legs.revision!==legRevision)throw Error('Transaction legs changed during export.');legRevision=legs.revision;all.push(...legs.rows);if(!legs.hasMore)break;if(!legs.rows.length)throw Error('Transaction legs could not be verified.');page++}
    if(all.length!==row.lineItemCount)throw Error('Activity changed during export. Start the export again.');row.lineItems=all
   }
   output.push(row)
  }
  onProgress?.(output.length,result.total)
  if(!result.hasOlder)break
  if(!result.rows.length||!result.olderCursor||JSON.stringify(cursor)===JSON.stringify(result.olderCursor))throw Error('Activity export could not verify the next page.')
  cursor=result.olderCursor
 }
 // Detect a change to an earlier page or to the last group while legs loaded.
 canceled();await getActivityPage(supabase,orgId,portfolioId,{limit:1,exporting:true,revision,signal});canceled()
 return output
}

async function ensureManualSource(supabase, orgId, userId, portfolioId) {
  const { data: existing, error: readError } = await supabase.from('investor_portfolio_sources')
    .select('id').eq('portfolio_id', portfolioId).eq('source_type', 'manual').maybeSingle()
  if (readError) throw readError
  if (existing) return existing.id
  const { data, error } = await supabase.from('investor_portfolio_sources')
    .insert({ org_id: orgId, user_id: userId, portfolio_id: portfolioId, source_type: 'manual', provider: 'manual', label: 'Manual entries', holdings_sync_supported: false, transaction_sync_supported: false })
    .select('id').single()
  if (error?.code === '23505') {
    const retry = await supabase.from('investor_portfolio_sources').select('id').eq('portfolio_id', portfolioId).eq('source_type', 'manual').maybeSingle()
    if (retry.data) return retry.data.id
  }
  if (error) throw error
  return data.id
}

// Both legs use the existing accounting ledger; the database commits them together.
export async function addManualSwap(supabase,orgId,userId,portfolioId,tx) {
  const leg=value=>{
    const identity=manualAssetIdentity(value),quantity=Number(value.quantity),price=Number(value.pricePerUnit)
    if(!identity.symbol||value.quantity===''||!Number.isFinite(quantity)||quantity<=0)throw new Error('Quantity must be greater than zero for both assets.')
    if(value.pricePerUnit===''||value.pricePerUnit==null||!Number.isFinite(price)||price<0||!Number.isFinite(quantity*price))throw new Error('Enter a non-negative USD price for both assets.')
    return {symbol:identity.symbol,contractAddress:identity.contractAddress,assetKind:identity.kind,chain:value.chain,quantity,pricePerUnit:price}
  }
  const sent=leg(tx),received=leg(tx.received||{}),fee=tx.fees===''||tx.fees==null?null:Number(tx.fees)
  if(fee!=null&&(!Number.isFinite(fee)||fee<0))throw new Error('Fees must be zero or greater.')
  if(!tx.datetime||!Number.isFinite(Date.parse(tx.datetime)))throw new Error('Enter a valid effective date and time.')
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tx.operationId||''))throw new Error('Invalid transaction operation')
  const {data,error}=await supabase.rpc('intel_record_manual_swap',{p_org_id:orgId,p_portfolio_id:portfolioId,p_operation_id:tx.operationId,p_effective_at:new Date(tx.datetime).toISOString(),p_sent:sent,p_received:received,p_fee_usd:fee,p_notes:tx.notes||null,p_source:tx.source||null})
  if(error)throw error
  try{await recompute(supabase,orgId,portfolioId)}catch(error){return {...data,recomputeError:error.message}}
  return data
}

export async function addTransaction(supabase, orgId, userId, portfolioId, tx) {
  if(tx.transactionType==='swap'&&tx.pairedSwap)return addManualSwap(supabase,orgId,userId,portfolioId,tx)
  const operationId = tx.operationId || crypto.randomUUID()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) throw new Error('Invalid transaction operation')
  const symbol = clean(tx.symbol).toUpperCase().replace(/^\$/, '')
  const qty = tx.quantity === '' || tx.quantity == null ? null : Number(tx.quantity)
  const price = tx.pricePerUnit === '' || tx.pricePerUnit == null ? null : Number(tx.pricePerUnit)
  const fee = tx.fees === '' || tx.fees == null ? null : Number(tx.fees)
  if (!symbol) throw new Error('Enter an asset symbol.')
  if (qty == null || !Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be greater than zero. Use the transaction type to record assets sent or received.')
  if ((price != null && (!Number.isFinite(price) || price < 0)) || (['buy', 'sell', 'swap'].includes(tx.transactionType) && price == null)) throw new Error('Enter a non-negative price per unit for this transaction.')
  if (price != null && !Number.isFinite(qty * price)) throw new Error('The transaction value is too large.')
  if (fee != null && (!Number.isFinite(fee) || fee < 0)) throw new Error('Fees must be zero or greater.')
  if (tx.datetime && !Number.isFinite(Date.parse(tx.datetime))) throw new Error('Enter a valid effective date and time.')
  const asset = manualAssetIdentity(tx)
  const inferredDirection = ['buy', 'transfer_in', 'airdrop', 'staking_reward', 'deposit'].includes(tx.transactionType) ? 'in'
    : ['sell', 'transfer_out', 'withdrawal', 'fee'].includes(tx.transactionType) ? 'out' : null
  const direction = tx.transactionType === 'swap' ? tx.direction : (inferredDirection || tx.direction)
  if (tx.transactionType === 'swap' && !['in', 'out'].includes(direction)) throw new Error('Choose whether this swap leg is the asset sent or received.')
  const sourceId = await ensureManualSource(supabase, orgId, userId, portfolioId)
  const row = {
    id: operationId,
    org_id: orgId, user_id: userId, portfolio_id: portfolioId, source_id: sourceId,
    transaction_type: tx.transactionType, original_transaction_type: tx.transactionType,
    classification_status: 'confirmed', confidence_score: 1, direction,
    asset_symbol: symbol, normalized_symbol: symbol || null, contract_address: asset.contractAddress,
    chain: tx.chain || null, quantity: qty, price_per_unit: price, quote_currency: tx.currency || 'USD',
    total_value: qty != null && price != null ? qty * price : null,
    fee_amount: fee, fee_currency: tx.feeCurrency || tx.currency || 'USD',
    timestamp: tx.datetime ? new Date(tx.datetime).toISOString() : new Date().toISOString(),
    notes: tx.notes || null, tags: tx.tags || [], raw_metadata: { source: tx.source || null, networkFee: tx.transactionType === 'fee', manual_operation_id: operationId, manual_asset_kind: asset.kind },
  }
  let { data, error } = await supabase.from('investor_portfolio_transactions').insert(row).select('*').single()
  if (error?.code === '23505') {
    const previous = await supabase.from('investor_portfolio_transactions').select('*').eq('id', operationId).eq('org_id', orgId).eq('user_id', userId).eq('portfolio_id', portfolioId).maybeSingle()
    if (previous.data) {
      const same = Object.keys(row).filter(key => !['timestamp', 'raw_metadata'].includes(key)).every(key => JSON.stringify(previous.data[key]) === JSON.stringify(row[key]))
        && Date.parse(previous.data.timestamp) === Date.parse(row.timestamp)
        && previous.data.raw_metadata?.source === row.raw_metadata.source
      if (!same) throw new Error('This transaction was already saved with different details. Close this form and review its activity before recording another transaction.')
      data = previous.data; error = null
    }
  }
  if (error) throw error
  try { await recompute(supabase, orgId, portfolioId) }
  catch (error) { return { ...data, recomputeError: error.message } }
  return data
}

// Editing/reclassifying an imported txn: classification becomes user_corrected and
// is preserved on future syncs. original_transaction_type is never overwritten.
export async function updateTransaction(supabase, orgId, portfolioId, txId, patch) {
  const upd = { ...patch }
  if (patch.transaction_type) { upd.classification_status = 'user_corrected' }
  const { error } = await supabase.from('investor_portfolio_transactions').update(upd).eq('id', txId)
  if (error) throw error
  await recompute(supabase, orgId, portfolioId)
}

export async function deleteTransaction(supabase, orgId, portfolioId, txId) {
  const { error } = await supabase.from('investor_portfolio_transactions').delete().eq('id', txId)
  if (error) throw error
  await recompute(supabase, orgId, portfolioId)
}

export async function deleteSourceTransactions(supabase, orgId, portfolioId, sourceId) {
  const { error } = await supabase.from('investor_portfolio_transactions').delete().eq('source_id', sourceId)
  if (error) throw error
  await recompute(supabase, orgId, portfolioId)
}

// Reclassify an activity item. Manual → flat row (user_corrected). Synced grouped
// → investor_portfolio_tx set user_corrected (preserved on every future re-sync;
// the worker never overwrites a user_corrected row). Then recompute.
export async function reclassifyActivity(supabase, orgId, portfolioId, item, newType) {
  if(item.isManual&&item.manualGroupId){
    const {error}=await supabase.rpc('intel_reclassify_manual_pair',{p_org_id:orgId,p_portfolio_id:portfolioId,p_group_id:item.manualGroupId,p_type:newType})
    if(error)throw error
    await recompute(supabase,orgId,portfolioId);return
  }
  if (item.isManual) { await updateTransaction(supabase, orgId, portfolioId, item.id, { transaction_type: newType }); return }
  const { error } = await supabase.from('investor_portfolio_tx')
    .update({ type: newType, classification_status: 'user_corrected', confidence: 1 }).eq('id', item.id)
  if (error) throw error
  await recompute(supabase, orgId, portfolioId)
}

// Delete is only offered for MANUAL entries (synced rows would re-appear on the
// next sync; users reclassify those instead).
export async function deleteActivity(supabase, orgId, portfolioId, item) {
  if (!item.isManual) return
  await deleteTransaction(supabase, orgId, portfolioId, item.id)
}

// ─── Sources ─────────────────────────────────────────────────────────────────

export async function listSources(supabase, orgId, portfolioId) {
  const { data, error } = await supabase.from('investor_portfolio_sources')
    .select('*').eq('portfolio_id', portfolioId).order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

export async function addSource(supabase, orgId, userId, portfolioId, { sourceType, provider, address = null, chain = null, verified = false, verifiedAt = null, verificationMethod = null, connected = false, label = null } = {}) {
  const { data, error } = await supabase.from('investor_portfolio_sources')
    .insert({
      org_id: orgId, user_id: userId, portfolio_id: portfolioId, source_type: sourceType, provider,
      address: address ? clean(address) : null, chain, label, connected, verified,
      verified_at: verifiedAt, verification_method: verificationMethod,
    })
    .select('*').single()
  if (error) {
    if (String(error.code) === '23505') { // already added
      const { data: ex } = await supabase.from('investor_portfolio_sources').select('*')
        .eq('portfolio_id', portfolioId).eq('source_type', sourceType).eq('address', clean(address)).maybeSingle()
      if (ex) return ex
    }
    throw error
  }
  return data
}

export async function pauseSource(supabase, sourceId, paused) {
  const { error } = await supabase.from('investor_portfolio_sources')
    .update({ status: paused ? 'paused' : 'active' }).eq('id', sourceId)
  if (error) throw error
}

// Deactivate keeps historical transactions; hard delete cascades them away.
export async function removeSource(supabase, sourceId, { deactivate = false } = {}) {
  if (deactivate) {
    const { error } = await supabase.from('investor_portfolio_sources')
      .update({ is_active: false, status: 'inactive' }).eq('id', sourceId)
    if (error) throw error
    return
  }
  const { error } = await supabase.from('investor_portfolio_sources').delete().eq('id', sourceId)
  if (error) throw error
}

// ─── Edge calls ──────────────────────────────────────────────────────────────

async function invokePortfolioSync(supabase, body) {
  // functions.invoke can fall back to the project's anon key when the Functions
  // client was created before auth hydration. Pass the current user JWT
  // explicitly so the Edge handler can validate the signed-in caller and RLS
  // continues to scope every portfolio read/write to that user.
  const accessToken = getAuthenticatedAccessToken()
  if (!accessToken) throw new Error('unauthorized')
  return supabase.functions.invoke('portfolio-sync', {
    body,
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

export async function syncPortfolio(supabase, orgId, portfolioId, { sourceId = null, mode = 'holdings', force = false } = {}) {
  const { data, error } = await invokePortfolioSync(supabase, { orgId, portfolioId, sourceId, mode, force })
  if (error) {
    let detail = null
    try { detail = await error.context?.clone?.().json() } catch { /* non-JSON gateway response */ }
    throw new Error(detail?.error || error.message || 'sync_failed')
  }
  if (data?.error) throw new Error(data.error)
  if(portfolioSyncChangesActivity(data))notifyPortfolioActivity(orgId,portfolioId)
  return data
}

// Light recompute from existing data (after manual txn edits) — no wallet fetch.
async function recompute(supabase, orgId, portfolioId) {
  try {
    const { data, error } = await invokePortfolioSync(supabase, { orgId, portfolioId, mode: 'recompute' })
    if (error || data?.error) throw new Error('The activity was saved, but holdings could not be recalculated. Use Sync now to refresh wallet balances.')
  } finally { notifyPortfolioActivity(orgId,portfolioId) }
}

export async function getPortfolioIntel(supabase, orgId, portfolioId) {
  const { data, error } = await supabase.functions.invoke('intel-portfolio', { body: { orgId, portfolioId } })
  if (error) throw new Error(error.message || 'intel_failed')
  if (data?.error) throw new Error(data.error)
  return data
}

export async function hydrateHoldingsContext(supabase, holdings) {
  // These contexts were attached by the canonical pricing pipeline. A second
  // ticker lookup can attach another contract's signals and repeats shared reads.
  return Object.fromEntries((holdings||[]).filter(h=>h.canonical_asset_key&&h.market_context?.canonicalAssetKey===h.canonical_asset_key)
    .map(h=>[h.canonical_asset_key,{...h.market_context,direction:h.market_context.signalDirection,strength:h.market_context.signalStrength,confidence:h.market_context.signalConfidence}]))
}

// Benchmark series for the performance chart (BTC/ETH/SOL via the markets layer).
export async function getBenchmarkSeries(supabase, symbols = ['BTC', 'ETH', 'SOL']) {
  // Independent 30-day market context. These scalar rollups have no start
  // valuation and cannot establish an aligned portfolio-relative return.
  const selected=[...new Set(symbols.filter(s=>['BTC','ETH','SOL'].includes(s)))].slice(0,3)
  try {
    const { data,error } = await supabase.from('exchange_market_rollups')
      .select('normalized_symbol, timeframe, price_change_pct, as_of, updated_at').in('normalized_symbol', selected).eq('timeframe', '30d').limit(4)
    if(error||!Array.isArray(data)||data.length>3)throw Error('market_context_read_failed')
    const rows=selected.flatMap(symbol=>{
      const matches=data.filter(r=>r.normalized_symbol===symbol&&r.timeframe==='30d')
      if(matches.length!==1)return []
      const r=matches[0],change=r.price_change_pct
      if(!['number','string'].includes(typeof change)||String(change).trim()===''||!Number.isFinite(Number(change)))return []
      return [{symbol,changePercent:Number(change),observedAt:Number.isFinite(Date.parse(r.as_of))?r.as_of:null,recordedAt:Number.isFinite(Date.parse(r.updated_at))?r.updated_at:null}]
    }),missing=selected.filter(symbol=>!rows.some(r=>r.symbol===symbol))
    return {status:!data.length?'empty':missing.length?'partial':'available',rows,missing}
  } catch { return {status:'error',rows:[],missing:selected} }
}

// ─── CSV export (client-side; no backend, reduces lock-in) ───────────────────

export function toCsv(rows, columns) {
  const esc = (v) => {
    let s = v == null ? '' : String(v)
    // Labels and imported notes are text, never spreadsheet formulas. Preserve
    // signed numeric values as numbers and quote CR as well as LF.
    if (typeof v === 'string' && /^[\s]*[=+@-]/.test(s) && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s.trim())) s = "'" + s
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = columns.map((c) => esc(c.label)).join(',')
  const body = rows.map((r) => columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(',')).join('\n')
  return `${head}\n${body}`
}

export function downloadCsv(filename, rows, columns) {
  const csv = toCsv(rows || [], columns)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const HOLDINGS_CSV_COLUMNS = [
  { key: 'asset_symbol', label: 'Asset' }, { key: 'name', label: 'Name' }, { key: 'chain', label: 'Chain' },
  { key: 'support_level', label: 'Support' }, { key: 'quantity', label: 'Quantity' },
  { get:r=>r.market_context?.priceExportAllowed===false?null:r.current_price, label: 'Price' }, { get:r=>r.market_context?.priceExportAllowed===false?null:r.current_value, label: 'Value' }, { get:r=>r.market_context?.priceExportAllowed===false?null:r.allocation_pct, label: 'Allocation %' },
  { key: 'average_cost', label: 'Avg Cost' }, { key: 'cost_basis_usd', label: 'Cost Basis' }, { key: 'cost_basis_status', label: 'Cost Basis Status' },
  { get:r=>r.market_context?.priceExportAllowed===false?null:r.unrealized_pnl, label: 'Unrealized P&L' }, { key: 'realized_pnl', label: 'Realized P&L' },
  { get:r=>r.market_context?.priceExportAllowed===false?'Source restriction: current quote-derived values omitted':'',label:'Quote export status' },
  { key: 'price_status', label: 'Price Status' }, { key: 'pnl_state', label: 'P&L State' },
  { key: 'canonical_asset_key', label: 'Asset Identity' }, { key: 'is_closed', label: 'Closed Position' },
  { key: 'price_source', label: 'Price Source' }, { key: 'last_priced_at', label: 'Price Observed At' },
]
// CSV for the unified activity feed (grouped + manual). One row per transaction,
// assets flattened into a single column.
export const ACTIVITY_CSV_COLUMNS = [
  { get: (r) => r.timestamp, label: 'Date' },
  { key: 'type', label: 'Type' },
  { key: 'title', label: 'Title' },
  { key: 'chain', label: 'Chain' },
  { get: (r) => (r.lineItems || []).map((li) => `${li.direction === 'in' ? '+' : li.direction === 'out' ? '-' : ''}${li.amount ?? ''} ${li.symbol || li.name || ''}`.trim()).join(' | '), label: 'Assets' },
  { key: 'protocol', label: 'Protocol' },
  { key: 'classification_status', label: 'Classification' },
  { key: 'txRef', label: 'Tx' },
  { key: 'eventKey', label: 'Event ID' }, { key: 'status', label: 'Status' }, { key: 'source', label: 'Source' },
  { key: 'recordedAt', label: 'Recorded at' }, { key: 'notes', label: 'Original notes' },
  { key: 'feeAsset', label: 'Fee asset' }, { key: 'feeAmount', label: 'Fee quantity' }, { key: 'feeUsd', label: 'Fee USD' },
  { get:r=>JSON.stringify(r.lineItems||[]), label:'Recorded legs and price provenance (JSON)' }

]
export const TXN_CSV_COLUMNS = [
  { key: 'timestamp', label: 'Date' }, { key: 'transaction_type', label: 'Type' }, { key: 'asset_symbol', label: 'Asset' },
  { key: 'chain', label: 'Chain' }, { key: 'quantity', label: 'Quantity' }, { key: 'price_per_unit', label: 'Price' },
  { key: 'fee_amount', label: 'Fee' }, { key: 'classification_status', label: 'Classification' },
  { get: (r) => r.source?.provider, label: 'Source' },
]
export const SNAPSHOT_CSV_COLUMNS = [
  { key: 'snapshot_date', label: 'Date' }, { key: 'total_value_usd', label: 'Total Value' },
  { key: 'day_pnl_usd', label: 'Day P&L' }, { key: 'unrealized_pnl_usd', label: 'Unrealized P&L' }, { key: 'realized_pnl_usd', label: 'Realized P&L' },
]
