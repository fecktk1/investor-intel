import { narrativeMemberIdentity } from './narrative-members'

const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null

// Read only the shared catalog for this visible membership page. These are
// display readings, not historical membership returns or a research version.
export async function attachNarrativeMemberMarkets(supabase, members) {
  if (!Array.isArray(members) || members.length > 20) throw new Error('Invalid narrative market page.')
  const groups = new Map()
  for (const row of members) {
    const identity = narrativeMemberIdentity(row)
    if (!identity) continue
    if (!groups.has(identity.sourceProvider)) groups.set(identity.sourceProvider, new Set())
    groups.get(identity.sourceProvider).add(identity.providerId)
  }
  const entries = [...groups], results = await Promise.allSettled(entries.map(async ([provider, ids]) => {
    const { data, error } = await supabase.from('market_assets')
      .select('source_provider,provider_id,name,symbol,cached_image_url,image_url,current_price,change_24h_pct,as_of,last_refreshed_at')
      .eq('source_provider', provider).in('provider_id', [...ids]).limit(ids.size)
    if (error) throw error
    if (!Array.isArray(data) || data.length > ids.size) throw new Error('Member quote response is incomplete.')
    const records = new Map()
    for (const row of data) {
      if (row.source_provider !== provider || !ids.has(row.provider_id) || records.has(row.provider_id)) throw new Error('Member quote identity mismatch.')
      const price = numeric(row.current_price)
      records.set(row.provider_id, {
        name: row.name, imageUrl: row.cached_image_url || row.image_url || null,
        price: price != null && price >= 0 ? price : null, change24hPct: numeric(row.change_24h_pct),
        observedAt: timestamp(row.as_of), retrievedAt: timestamp(row.last_refreshed_at),
      })
    }
    return records
  }))
  return members.map(row => {
    const identity = narrativeMemberIdentity(row), index = identity ? entries.findIndex(([provider]) => provider === identity.sourceProvider) : -1
    if (index < 0) return { ...row, marketState: 'unresolved', market: null }
    const result = results[index]
    if (result.status === 'rejected') return { ...row, marketState: 'error', market: null }
    const market = result.value.get(identity.providerId) || null
    return { ...row, marketState: market ? 'available' : 'missing', market }
  })
}
