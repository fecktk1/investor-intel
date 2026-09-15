// Investor Intel — on-demand indexing.
//
// The first successful resolution of an asset, by anyone, turns it into a shared
// record: a `market_assets` row every user can search and route to, and a quote
// refresh that follows demand for as long as the asset stays in use.
//
// Two steps, both best effort and neither ever throwing:
//
//   1 index   public.intel_upsert_on_demand_asset(p_row) writes the record, but
//             ONLY when no row exists for that (source_provider, provider_id).
//             A catalogue row is never overwritten — the catalogue writer stays
//             the single writer of its own facts.
//   2 demand  the quote cache row that already covers this CoinMarketCap id is
//             stamped as demanded, so the worker's five-second demand lane
//             refreshes it on its next pass. Nothing here spends a credit: the
//             resolver's ladder is the only thing allowed to call a provider.
//             When no cache row exists yet, the planner's on-demand lane
//             (refreshOnDemandQuotes) creates it with one batched call.
//
// The demand stamp is the one place a user id is written, and it is written to
// `market_data_response_cache` — the same columns a foreground view already
// fills, because the worker rechecks that owner's access before it refreshes.
// The demand ledger itself (`market_asset_demand`) stays anonymous: counters and
// timestamps only.

/** Structurally the resolver's AssetIdentity. Declared here so the resolver can
 *  depend on this module without this module depending back on the resolver. */
export type IndexableIdentity = {
  kind: 'cmc' | 'contract'
  provider: string
  providerId: string
  symbol: string | null
  name: string | null
  chain: string | null
  address: string | null
  logoUrl?: string | null
  deployments?: { chain: string | null; address: string; source?: string }[]
}

export type IndexOptions = {
  /** Overrides identity.logoUrl when the caller carries a better one. */
  logoUrl?: string | null
  /** Recorded on the quote cache row only, so the worker can recheck access. */
  orgId?: string | null
  userId?: string | null
}

export type IndexResult = { indexed: boolean; demanded: boolean; reasons: string[] }

/** How many quote cache rows are scanned for one that already covers the id.
 *  Quote requests are grouped into 250-id batches, so the live set is small. */
const CACHE_SCAN_LIMIT = 40
const MAX_PLATFORMS = 24

const text = (value: unknown, max = 160): string | null => {
  const s = typeof value === 'string' ? value.trim() : ''
  return s ? s.slice(0, max) : null
}
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e || 'unknown')).slice(0, 80)

/** { chain: address } for every deployment whose chain is known. */
function platformsFor(identity: IndexableIdentity): Record<string, string> | null {
  const platforms: Record<string, string> = {}
  for (const deployment of identity.deployments || []) {
    const chain = text(deployment?.chain, 40)
    const address = text(deployment?.address, 200)
    if (!chain || !address || platforms[chain]) continue
    platforms[chain] = address
    if (Object.keys(platforms).length >= MAX_PLATFORMS) break
  }
  if (identity.kind === 'contract' && identity.chain && identity.address) {
    platforms[identity.chain] ??= identity.address
  }
  return Object.keys(platforms).length ? platforms : null
}

/** The payload public.intel_upsert_on_demand_asset validates, or null when the
 *  identity is not complete enough to be a record (the RPC would refuse it). */
export function onDemandAssetRow(identity: IndexableIdentity, options: IndexOptions = {}): Record<string, unknown> | null {
  const symbol = text(identity?.symbol, 64)
  if (!symbol) return null
  const logoUrl = text(options.logoUrl ?? identity.logoUrl, 500)
  const platforms = platformsFor(identity)
  const base = {
    symbol,
    name: text(identity.name),
    ...(logoUrl ? { imageUrl: logoUrl } : {}),
    ...(platforms ? { platforms } : {}),
  }

  if (identity.kind === 'cmc') {
    if (!/^[1-9][0-9]{0,9}$/.test(String(identity.providerId || ''))) return null
    // The primary chain is the identity's own chain, or the first deployment
    // whose chain we carry. Market data is left to the quote lane: an identity
    // resolution never asserts a price.
    const chain = text(identity.chain, 40) || text((identity.deployments || []).find((d) => d?.chain)?.chain, 40)
    return { kind: 'cmc', providerId: String(identity.providerId), ...(chain ? { chain } : {}), ...base }
  }

  const chain = text(identity.chain, 40)
  const address = text(identity.address, 200)
  if (!chain || !address) return null
  return { kind: 'contract', chain, address, providerId: `${chain}:${address}`, ...base }
}

/** Mark the quote snapshot that covers this CoinMarketCap id as demanded, so the
 *  worker's demand lane refreshes it. Returns false — never throws — when there
 *  is nothing to stamp. */
export async function demandQuoteRefresh(
  // deno-lint-ignore no-explicit-any
  admin: any,
  identity: IndexableIdentity,
  options: IndexOptions = {},
): Promise<{ demanded: boolean; reason: string | null }> {
  const id = String(identity?.providerId || '')
  if (identity?.kind !== 'cmc' || !/^[1-9][0-9]{0,9}$/.test(id)) return { demanded: false, reason: 'not_a_quote_asset' }
  if (!admin?.from) return { demanded: false, reason: 'no_database' }
  // planCmcRefresh only considers rows that carry both ids, because it rechecks
  // that member's Intel access before spending anything.
  const orgId = text(options.orgId, 64), userId = text(options.userId, 64)
  if (!orgId || !userId) return { demanded: false, reason: 'demand_owner_unknown' }

  try {
    const { data, error } = await admin.from('market_data_response_cache')
      .select('cache_key,request_params,demanded_at')
      .eq('provider', 'coinmarketcap').eq('capability', 'quotes')
      .order('fetched_at', { ascending: false }).limit(CACHE_SCAN_LIMIT)
    if (error) return { demanded: false, reason: 'cache_unavailable' }
    // A quote request's id parameter is a comma-separated batch; match a member
    // of the list, never a substring of another id.
    // deno-lint-ignore no-explicit-any
    const row = (data || []).find((r: any) => String(r?.request_params?.id ?? '').split(',').includes(id))
    if (!row?.cache_key) return { demanded: false, reason: 'quote_cache_absent' }

    const { error: stampError } = await admin.from('market_data_response_cache')
      .update({ demanded_at: new Date().toISOString(), demand_org_id: orgId, demand_user_id: userId })
      .eq('provider', 'coinmarketcap').eq('cache_key', row.cache_key)
    return stampError ? { demanded: false, reason: 'demand_stamp_failed' } : { demanded: true, reason: null }
  } catch (e) {
    return { demanded: false, reason: `demand_failed:${message(e)}` }
  }
}

/** Create the shared record for a resolved identity and put it on the demand
 *  cadence. Never throws: a failure is a reason, never a failed resolution. */
export async function indexResolvedAsset(
  // deno-lint-ignore no-explicit-any
  admin: any,
  identity: IndexableIdentity,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const reasons: string[] = []
  let indexed = false

  const row = onDemandAssetRow(identity, options)
  if (!admin?.rpc) reasons.push('no_database')
  else if (!row) reasons.push('identity_incomplete')
  else {
    try {
      const { data, error } = await admin.rpc('intel_upsert_on_demand_asset', { p_row: row })
      if (error) reasons.push(`index_failed:${message(error.message || error)}`)
      else {
        indexed = data?.inserted === true
        if (!indexed) reasons.push('already_indexed')
      }
    } catch (e) {
      reasons.push(`index_failed:${message(e)}`)
    }
  }

  const demand = await demandQuoteRefresh(admin, identity, options)
  if (demand.reason) reasons.push(demand.reason)
  return { indexed, demanded: demand.demanded, reasons }
}
