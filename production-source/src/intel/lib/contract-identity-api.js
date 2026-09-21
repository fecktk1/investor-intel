// Investor Intel — name a held contract when nothing else has.
//
// A holding is named by portfolio-sync from our own tables. A contract that
// has never been resolved is in none of them yet, so the row would show only
// the ticker the member typed beside a raw mint. This asks the identity
// endpoint once for those rows; resolving also indexes the contract into the
// shared catalogue, so the next recompute reads the name from our own tables.

/** Never ask for more than one screen of rows in a single request. */
export const MAX_CONTRACT_IDENTITIES = 40

export const contractIdentityKey = (chain, address) => `${chain}:${address}`

/** The holdings a page still cannot name, as { chain, address } pairs. */
export function holdingsNeedingIdentity(holdings) {
  const wanted = new Map()
  for (const holding of holdings || []) {
    if (holding?.name) continue
    const chain = holding?.chain
    const address = holding?.contract_address || holding?.mint_or_contract
    if (!chain || !address) continue
    const key = contractIdentityKey(chain, address)
    if (!wanted.has(key)) wanted.set(key, { chain, address })
    if (wanted.size >= MAX_CONTRACT_IDENTITIES) break
  }
  return [...wanted.values()]
}

export async function loadContractIdentities(supabase, orgId, assets) {
  if (!orgId || !assets?.length) return {}
  const { data, error } = await supabase.functions.invoke('intel-entity-identity', {
    body: { orgId, assets: assets.slice(0, MAX_CONTRACT_IDENTITIES) },
  })
  if (error) {
    const body = await error.context?.json?.().catch(() => null)
    throw new Error(body?.error || error.message || 'entity_identity_failed')
  }
  if (data?.error) throw new Error(data.error)
  return data?.assets || {}
}

/** Merge the answers into the holdings a member is looking at right now, so
 *  the table names them without waiting for the next recompute. */
export function applyContractIdentities(holdings, identities) {
  if (!identities || !Object.keys(identities).length) return holdings
  return (holdings || []).map((holding) => {
    const chain = holding?.chain
    const address = holding?.contract_address || holding?.mint_or_contract
    if (!chain || !address) return holding
    const found = identities[contractIdentityKey(chain, address)]
    if (!found || (!found.name && !found.symbol && !found.imageUrl)) return holding
    return {
      ...holding,
      name: holding.name || found.name || null,
      logo_url: holding.logo_url || found.imageUrl || null,
      asset_symbol: holding.asset_symbol || found.symbol || null,
    }
  })
}
