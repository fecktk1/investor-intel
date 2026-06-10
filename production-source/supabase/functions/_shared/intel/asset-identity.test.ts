import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { buildAssetResolver } from './asset-identity.ts'

// Minimal awaitable Supabase mock: every chain method returns the builder, and the
// builder is thenable → resolves to the canned result for the table.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAdmin(tables: Record<string, any>) {
  const make = (table: string) => {
    const result = tables[table] ?? { data: [], error: null }
    const b: any = {}
    for (const m of ['select', 'order', 'limit', 'gte', 'gt', 'eq']) b[m] = () => b
    b.then = (res: any) => res(result)
    return b
  }
  return { from: (t: string) => make(t) }
}

const admin = makeAdmin({
  market_assets: {
    data: [
      { source_provider: 'coingecko', provider_id: 'solana', symbol: 'SOL', normalized_symbol: 'SOL', market_cap: 9e10 },
      { source_provider: 'coingecko', provider_id: 'bitcoin', symbol: 'BTC', normalized_symbol: 'BTC', market_cap: 1e12 },
      // cross-chain ticker collision: two assets share symbol AAA; higher mc wins
      { source_provider: 'coingecko', provider_id: 'alpha-big', symbol: 'AAA', normalized_symbol: 'AAA', market_cap: 5e8 },
      { source_provider: 'coingecko', provider_id: 'alpha-small', symbol: 'AAA', normalized_symbol: 'AAA', market_cap: 1e6 },
    ],
    error: null,
  },
})

Deno.test('symbol → canonical coingecko key, with $ and case tolerance', async () => {
  const r = await buildAssetResolver(admin as any)
  assertEquals(r.toCanonicalKey('SOL'), 'cg:solana')
  assertEquals(r.toCanonicalKey('$sol'), 'cg:solana')
  assertEquals(r.toCanonicalKey('  Sol '), 'cg:solana')
})

Deno.test('unknown symbol → sym: fallback', async () => {
  const r = await buildAssetResolver(admin as any)
  assertEquals(r.toCanonicalKey('UNKNOWNXYZ'), 'sym:unknownxyz')
})

Deno.test('already-canonical keys pass through', async () => {
  const r = await buildAssetResolver(admin as any)
  assertEquals(r.toCanonicalKey('cg:bitcoin'), 'cg:bitcoin')
  assertEquals(r.toCanonicalKey('native:solana'), 'native:solana')
})

Deno.test('duplicate ticker resolves to the higher-market-cap asset (distinct keys)', async () => {
  const r = await buildAssetResolver(admin as any)
  assertEquals(r.toCanonicalKey('AAA'), 'cg:alpha-big')
})

Deno.test('displaySymbolFor + keyForChain', async () => {
  const r = await buildAssetResolver(admin as any)
  assertEquals(r.displaySymbolFor('cg:solana'), 'SOL')
  assertEquals(r.displaySymbolFor('sym:doge'), 'DOGE')
  assertEquals(r.displaySymbolFor('native:ethereum'), 'ETHEREUM')
  assertEquals(r.keyForChain('Solana'), 'native:solana')
})
