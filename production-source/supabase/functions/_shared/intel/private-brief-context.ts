// Owner predicates are mandatory even when the caller uses a service client.
// Context is a bounded research sample; truncation is made visible in the brief.
// deno-lint-ignore no-explicit-any
export async function loadPrivateBriefContext(db: any, orgId: string, userId: string, portfolioId?: string | null) {
  if (!orgId || !userId) throw new Error('Personal brief identity required')
  let portfolioQuery = db.from('investor_portfolios').select('id,name,is_default').eq('org_id', orgId).eq('user_id', userId)
  if (portfolioId) portfolioQuery = portfolioQuery.eq('id', portfolioId)
  const portfolioResult = await portfolioQuery.order('is_default', { ascending: false, nullsFirst: false }).order('created_at').order('id').limit(1).maybeSingle()
  if (portfolioResult.error) throw portfolioResult.error
  const portfolio = portfolioResult.data
  if (portfolioId && !portfolio) throw new Error('Selected portfolio is not available in this workspace')
  const [watch, holdings, flow] = await Promise.all([
    db.from('watchlist_items').select('id,entity:entities(id,canonical_ref_key,display_symbol,chain_namespace,chain_id,contract_address,provider_ids),watchlist:watchlists!inner(user_id,org_id)')
      .eq('org_id', orgId).eq('watchlist.org_id', orgId).eq('watchlist.user_id', userId).order('created_at', { ascending: false }).order('id').limit(201),
    portfolio ? db.from('investor_portfolio_holdings').select('id,canonical_asset_key,chain,contract_address,quantity,is_closed,cost_basis_status,price_status,normalized_symbol,asset_symbol,current_value,day_pnl,day_pnl_pct,portfolio:investor_portfolios!inner(user_id,org_id)')
      .eq('org_id', orgId).eq('user_id', userId).eq('portfolio.org_id', orgId).eq('portfolio.user_id', userId)
      .eq('portfolio_id', portfolio.id).eq('is_closed', false).gt('quantity', 0)
      .order('current_value', { ascending: false, nullsFirst: false }).order('id').limit(201) : Promise.resolve({ data: [], error: null }),
    db.from('large_transfer_events').select('chain,canonical_asset_key,symbol,amount,usd_value,threshold_usd,direction,label,observed_at,fetched_at')
      .eq('org_id', orgId).eq('user_id', userId).order('observed_at', { ascending: false }).limit(9),
  ])
  // Errors must not turn private account data into a misleading empty portfolio.
  for (const result of [watch, holdings, flow]) if (result.error) throw result.error
  return {
    portfolio: portfolio ? { id: portfolio.id, name: portfolio.name } : null,
    // Stable identity travels with the display label into evidence assembly.
    watchlistAssets: (watch.data || []).slice(0, 200).map((row: any) => row.entity).filter(Boolean),
    // deno-lint-ignore no-explicit-any
    watchlistSymbols: (watch.data || []).slice(0, 200).map((row: any) => row.entity?.display_symbol).filter(Boolean),
    // deno-lint-ignore no-explicit-any
    holdings: (holdings.data || []).slice(0, 200).map((h: any) => ({ canonicalKey: h.canonical_asset_key, chain: h.chain, tokenAddress: h.contract_address, quantity: h.quantity, costBasisStatus: h.cost_basis_status, priceStatus: h.price_status, symbol: h.normalized_symbol || h.asset_symbol, value: h.current_value, dayPnl: h.day_pnl, dayPnlPct: h.day_pnl_pct })),
    flowHighlights: (flow.data || []).slice(0, 8),
    coverage: { watchlist_truncated: (watch.data?.length || 0) > 200, holdings_truncated: (holdings.data?.length || 0) > 200, flows_truncated: (flow.data?.length || 0) > 8 },
  }
}
