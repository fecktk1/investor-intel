// Investor Intel — Portfolio Tracker client API.
//
// READ-ONLY product. Portfolio rows are written under the user's per-user RLS
// (org_id = your org AND user_id = you). Pricing/holdings/backfill happen in the
// portfolio-sync edge function + worker; AI in intel-portfolio. Mirrors the
// watchlist-api.js conventions: (supabase, orgId, ...), throw on error,
// invoke() for edge calls.

import { loadMarketContextBySymbols } from './markets-api'
import { getAuthenticatedAccessToken } from '../../lib/supabase'
export { loadMarketContextBySymbols }

const clean = (s) => String(s || '').trim()

// ─── Portfolios ──────────────────────────────────────────────────────────────

export async function listPortfolios(supabase, orgId) {
  const { data, error } = await supabase.from('investor_portfolios')
    .select('*').eq('org_id', orgId).order('is_default', { ascending: false }).order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

export async function getPortfolio(supabase, orgId, portfolioId) {
  const [{ data: p, error: pe }, { data: holdings }, { data: sources }] = await Promise.all([
    supabase.from('investor_portfolios').select('*').eq('id', portfolioId).maybeSingle(),
    supabase.from('investor_portfolio_holdings').select('*').eq('portfolio_id', portfolioId).order('current_value', { ascending: false, nullsFirst: false }),
    supabase.from('investor_portfolio_sources').select('*').eq('portfolio_id', portfolioId).order('created_at', { ascending: true }),
  ])
  if (pe) throw pe
  return { portfolio: p, holdings: holdings || [], sources: sources || [] }
}

export async function createPortfolio(supabase, orgId, userId, { name = 'My Portfolio', baseCurrency = 'USD', isDefault = false } = {}) {
  const { data, error } = await supabase.from('investor_portfolios')
    .insert({ org_id: orgId, user_id: userId, name, base_currency: baseCurrency, is_default: isDefault })
    .select('*').single()
  if (error) throw error
  return data
}

export async function ensureDefaultPortfolio(supabase, orgId, userId) {
  const { data: existing } = await supabase.from('investor_portfolios')
    .select('*').eq('org_id', orgId).eq('user_id', userId).eq('is_default', true).maybeSingle()
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
  const { error } = await supabase.from('investor_portfolio_memory').delete().eq('portfolio_id', portfolioId)
  if (error) throw error
}

// ─── Holdings & snapshots ────────────────────────────────────────────────────

export async function getHoldings(supabase, orgId, portfolioId) {
  const { data, error } = await supabase.from('investor_portfolio_holdings')
    .select('*').eq('portfolio_id', portfolioId).order('current_value', { ascending: false, nullsFirst: false })
  if (error) throw error
  return data || []
}

export async function getSnapshots(supabase, orgId, portfolioId, { limit = 365 } = {}) {
  const { data, error } = await supabase.from('investor_portfolio_snapshots')
    .select('snapshot_date, total_value_usd, day_pnl_usd, unrealized_pnl_usd, realized_pnl_usd')
    .eq('portfolio_id', portfolioId).order('snapshot_date', { ascending: true }).limit(limit)
  if (error) throw error
  // Keep the P&L columns (already selected) instead of collapsing to {t,value},
  // so the chart can plot realized/unrealized P&L. `value` stays for back-compat.
  return (data || []).map((s) => ({
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

// Unified activity feed: synced grouped transactions (one row per signature/hash,
// with line items) + manual flat entries — disjoint sets, so a manual entry shows
// once and is counted once for cost basis (the grouped tables hold synced data).
export async function listActivity(supabase, orgId, portfolioId, { limit = 200 } = {}) {
  const [groupedRes, manualRes] = await Promise.all([
    supabase.from('investor_portfolio_tx')
      .select('id, chain, tx_hash, signature, block_time, type, subtype, title, summary, protocol, counterparty, status, confidence, classification_status, original_type, fee_asset, fee_amount, fee_usd, line_items:investor_portfolio_tx_line_items(canonical_asset_key, chain, mint_or_contract, symbol, name, decimals, direction, amount, price_usd_at_tx, value_usd_at_tx, price_source_at_tx, logo_url, verified)')
      .eq('portfolio_id', portfolioId).eq('is_display_mirror', false)
      .order('block_time', { ascending: false, nullsFirst: false }).limit(limit),
    supabase.from('investor_portfolio_transactions')
      .select('*, source:investor_portfolio_sources!inner(provider, source_type)')
      .eq('portfolio_id', portfolioId).eq('source.source_type', 'manual')
      .order('timestamp', { ascending: false, nullsFirst: false }).limit(limit),
  ])
  // grouped tables may not exist pre-migration — degrade to manual-only
  const grouped = groupedRes.error ? [] : (groupedRes.data || [])
  const manual = manualRes.error ? [] : (manualRes.data || [])
  const items = []
  for (const g of grouped) {
    items.push({
      id: g.id, kind: 'grouped', isManual: false, chain: g.chain, txRef: g.tx_hash || g.signature || null,
      type: g.type, subtype: g.subtype, title: g.title, summary: g.summary, protocol: g.protocol,
      counterparty: g.counterparty, status: g.status, confidence: g.confidence,
      classification_status: g.classification_status, timestamp: g.block_time, lineItems: g.line_items || [],
      feeAsset: g.fee_asset, feeAmount: g.fee_amount, feeUsd: g.fee_usd,
    })
  }
  for (const m of manual) {
    items.push({
      id: m.id, kind: 'manual', isManual: true, chain: m.chain, txRef: m.external_tx_hash || m.external_tx_signature || null,
      type: m.transaction_type, subtype: null, title: manualTitle(m), summary: null, protocol: null,
      counterparty: null, status: 'success', confidence: m.confidence_score,
      classification_status: m.classification_status, timestamp: m.timestamp,
      feeAsset: m.fee_currency, feeAmount: m.fee_amount, feeUsd: String(m.fee_currency || 'USD').toUpperCase() === 'USD' ? m.fee_amount : null,
      lineItems: [{ canonical_asset_key: m.canonical_asset_key, chain: m.chain, mint_or_contract: m.contract_address, symbol: m.asset_symbol, name: null, decimals: null, direction: m.direction, amount: m.quantity, price_usd_at_tx: m.price_per_unit, value_usd_at_tx: m.total_value, price_source_at_tx: 'manual', logo_url: null, verified: false }],
    })
  }
  items.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
  return items.slice(0, limit)
}

async function ensureManualSource(supabase, orgId, userId, portfolioId) {
  const { data: existing } = await supabase.from('investor_portfolio_sources')
    .select('id').eq('portfolio_id', portfolioId).eq('source_type', 'manual').maybeSingle()
  if (existing) return existing.id
  const { data, error } = await supabase.from('investor_portfolio_sources')
    .insert({ org_id: orgId, user_id: userId, portfolio_id: portfolioId, source_type: 'manual', provider: 'manual', label: 'Manual entries', holdings_sync_supported: false, transaction_sync_supported: false })
    .select('id').single()
  if (error) throw error
  return data.id
}

export async function addTransaction(supabase, orgId, userId, portfolioId, tx) {
  const sourceId = await ensureManualSource(supabase, orgId, userId, portfolioId)
  const symbol = clean(tx.symbol).toUpperCase().replace(/^\$/, '')
  const qty = tx.quantity === '' || tx.quantity == null ? null : Number(tx.quantity)
  const price = tx.pricePerUnit === '' || tx.pricePerUnit == null ? null : Number(tx.pricePerUnit)
  const inferredDirection = ['buy', 'transfer_in', 'airdrop', 'staking_reward', 'deposit'].includes(tx.transactionType) ? 'in'
    : ['sell', 'transfer_out', 'withdrawal', 'fee'].includes(tx.transactionType) ? 'out' : null
  const direction = tx.transactionType === 'swap' ? tx.direction : (tx.direction || inferredDirection)
  if (tx.transactionType === 'swap' && !direction) throw new Error('Choose whether this swap leg is the asset sent or received.')
  const row = {
    org_id: orgId, user_id: userId, portfolio_id: portfolioId, source_id: sourceId,
    transaction_type: tx.transactionType, original_transaction_type: tx.transactionType,
    classification_status: 'confirmed', confidence_score: 1, direction,
    asset_symbol: symbol, normalized_symbol: symbol || null, contract_address: tx.contractAddress || null,
    chain: tx.chain || null, quantity: qty, price_per_unit: price, quote_currency: tx.currency || 'USD',
    total_value: qty != null && price != null ? qty * price : null,
    fee_amount: tx.fees === '' || tx.fees == null ? null : Number(tx.fees), fee_currency: tx.feeCurrency || tx.currency || 'USD',
    timestamp: tx.datetime ? new Date(tx.datetime).toISOString() : new Date().toISOString(),
    notes: tx.notes || null, tags: tx.tags || [], raw_metadata: { source: tx.source || null, networkFee: tx.transactionType === 'fee' },
  }
  const { data, error } = await supabase.from('investor_portfolio_transactions').insert(row).select('*').single()
  if (error) throw error
  await recompute(supabase, orgId, portfolioId)
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
  return data
}

// Light recompute from existing data (after manual txn edits) — no wallet fetch.
async function recompute(supabase, orgId, portfolioId) {
  try { await invokePortfolioSync(supabase, { orgId, portfolioId, mode: 'recompute' }) }
  catch { /* non-blocking; UI re-fetches holdings regardless */ }
}

export async function getPortfolioIntel(supabase, orgId, portfolioId) {
  const { data, error } = await supabase.functions.invoke('intel-portfolio', { body: { orgId, portfolioId } })
  if (error) throw new Error(error.message || 'intel_failed')
  if (data?.error) throw new Error(data.error)
  return data
}

export async function hydrateHoldingsContext(supabase, holdings) {
  const syms = (holdings || []).map((h) => h.normalized_symbol || h.asset_symbol).filter(Boolean)
  if (!syms.length) return {}
  try { return await loadMarketContextBySymbols(supabase, syms) } catch { return {} }
}

// Benchmark series for the performance chart (BTC/ETH/SOL via the markets layer).
export async function getBenchmarkSeries(supabase, symbols = ['BTC', 'ETH', 'SOL']) {
  // Best-effort: rollups give recent % change; full historical series is a follow-up.
  try {
    const { data } = await supabase.from('exchange_market_rollups')
      .select('normalized_symbol, timeframe, price_change_pct').in('normalized_symbol', symbols).eq('timeframe', '30d')
    const out = {}
    for (const r of (data || [])) out[r.normalized_symbol] = r.price_change_pct
    return out
  } catch { return {} }
}

// ─── CSV export (client-side; no backend, reduces lock-in) ───────────────────

function toCsv(rows, columns) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
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
  { key: 'current_price', label: 'Price' }, { key: 'current_value', label: 'Value' }, { key: 'allocation_pct', label: 'Allocation %' },
  { key: 'average_cost', label: 'Avg Cost' }, { key: 'cost_basis_usd', label: 'Cost Basis' }, { key: 'cost_basis_status', label: 'Cost Basis Status' },
  { key: 'unrealized_pnl', label: 'Unrealized P&L' }, { key: 'realized_pnl', label: 'Realized P&L' },
  { key: 'price_status', label: 'Price Status' }, { key: 'pnl_state', label: 'P&L State' },
]
// CSV for the unified activity feed (grouped + manual). One row per transaction,
// assets flattened into a single column.
export const ACTIVITY_CSV_COLUMNS = [
  { get: (r) => r.timestamp, label: 'Date' },
  { key: 'type', label: 'Type' },
  { key: 'title', label: 'Title' },
  { key: 'chain', label: 'Chain' },
  { get: (r) => (r.lineItems || []).map((li) => `${li.direction === 'in' ? '+' : '-'}${li.amount ?? ''} ${li.symbol || li.name || ''}`.trim()).join(' | '), label: 'Assets' },
  { key: 'protocol', label: 'Protocol' },
  { key: 'classification_status', label: 'Classification' },
  { key: 'txRef', label: 'Tx' },
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
