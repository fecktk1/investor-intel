// Investor Intel — DeFi snapshot cron (service-role).
// Snapshots DeFi metrics for every watched vault/pool into the appropriate table:
//   Solana entities  → kaminoForAddress()  → kamino_vault_snapshots
//   All other chains → defiLlamaForPool()  → defi_pool_snapshots

import { createClient } from 'npm:@supabase/supabase-js@2'
import { kaminoForAddress, defiLlamaForPool } from '../_shared/intel-providers.ts'
import { chainIdFor } from '../_shared/chains.ts'

function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }) }

Deno.serve(async (req) => {
  try {
    if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return json({ error: 'forbidden' }, 401)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data } = await admin
      .from('watchlist_items')
      .select('org_id, entity:entities(asset_id, contract_address, display_symbol, chain_id, chain_namespace), org:orgs!inner(product_mode)')
      .eq('item_type', 'defi')
      .limit(1000)

    const seen = new Set<string>()
    const kaminoRows: any[] = []
    const llamaRows: any[] = []

    for (const w of (data || []).filter((x: any) => x.org?.product_mode === 'intel' && x.entity)) {
      const entity = Array.isArray(w.entity) ? w.entity[0] : w.entity
      const addr = entity?.contract_address || entity?.asset_id
      if (!addr) continue
      const chain = chainIdFor(entity?.chain_namespace, entity?.chain_id) || 'solana'
      const key = `${w.org_id}:${chain}:${addr}`
      if (seen.has(key)) continue
      seen.add(key)

      if (chain === 'solana') {
        const k = await kaminoForAddress(addr)
        if (!k) continue
        kaminoRows.push({
          org_id: w.org_id,
          vault_address: addr,
          vault_name: entity?.display_symbol || null,
          apy: k.apy ?? null,
          tvl_usd: k.tvl_usd ?? null,
          snapshot_at: new Date().toISOString(),
        })
      } else {
        const ll = await defiLlamaForPool(addr, chain)
        if (!ll) continue
        llamaRows.push({
          org_id: w.org_id,
          chain,
          pool_address: addr,
          pool_id: ll.pool_id ?? null,
          protocol: ll.protocol ?? null,
          symbol: ll.symbol ?? null,
          apy: ll.apy ?? null,
          tvl_usd: ll.tvl_usd ?? null,
          provider: 'defillama',
          raw: ll,
          snapshot_at: new Date().toISOString(),
        })
      }
    }

    let inserted = 0
    for (let i = 0; i < kaminoRows.length; i += 100) {
      const { data: d, error } = await admin.from('kamino_vault_snapshots').insert(kaminoRows.slice(i, i + 100)).select('id')
      if (error) throw error
      inserted += d?.length || 0
    }
    for (let i = 0; i < llamaRows.length; i += 100) {
      const { data: d, error } = await admin.from('defi_pool_snapshots').insert(llamaRows.slice(i, i + 100)).select('id')
      if (error) throw error
      inserted += d?.length || 0
    }

    return json({ ok: true, vaults: seen.size, kamino: kaminoRows.length, defillama: llamaRows.length, inserted })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'defi_snapshot_failed' }, 500)
  }
})
