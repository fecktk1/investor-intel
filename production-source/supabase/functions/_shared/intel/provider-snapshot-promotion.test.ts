import { detectMaterialSnapshotPromotions } from './provider-snapshot-promotion.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

Deno.test('G2 promotes material cached price and TVL shifts deterministically', () => {
  const candidates = detectMaterialSnapshotPromotions({
    priceRows: [
      { canonical_asset_key: 'SOL', chain: 'solana', price_usd: 150, ts: '2026-06-16T10:00:00Z' },
      { canonical_asset_key: 'SOL', chain: 'solana', price_usd: 100, ts: '2026-06-12T10:00:00Z' },
    ],
    protocolTvlRows: [
      { protocol_slug: 'marinade', protocol_name: 'Marinade', chain: 'solana', tvl_usd: 1_300_000_000, ts: '2026-06-16T10:00:00Z' },
      { protocol_slug: 'marinade', protocol_name: 'Marinade', chain: 'solana', tvl_usd: 1_000_000_000, ts: '2026-06-12T10:00:00Z' },
    ],
  })
  assert(candidates.some((c) => c.kind === 'asset_price_shift' && c.promoteEventMemory), 'price shift promoted')
  assert(candidates.some((c) => c.kind === 'protocol_tvl_shift' && c.entityRefs.includes('marinade')), 'protocol TVL shift promoted')
  assert(candidates.every((c) => c.rawHash && c.promotionScore >= 0.72), 'candidates have deterministic hashes and scores')
})

Deno.test('G2 ignores sub-material cached snapshot movement', () => {
  const candidates = detectMaterialSnapshotPromotions({
    priceRows: [
      { canonical_asset_key: 'BTC', chain: 'bitcoin', price_usd: 106_000, ts: '2026-06-16T10:00:00Z' },
      { canonical_asset_key: 'BTC', chain: 'bitcoin', price_usd: 100_000, ts: '2026-06-12T10:00:00Z' },
    ],
  })
  assert(candidates.length === 0, '6% move stays below materiality threshold')
})

Deno.test('G2 keeps large transfer promotions tenant scoped', () => {
  const candidates = detectMaterialSnapshotPromotions({
    largeTransferRows: [{
      org_id: 'org1',
      user_id: 'user1',
      chain: 'solana',
      canonical_asset_key: 'SOL',
      symbol: 'SOL',
      usd_value: 250_000,
      threshold_usd: 100_000,
      direction: 'out',
      observed_at: '2026-06-16T10:00:00Z',
      fetched_at: '2026-06-16T10:01:00Z',
    }],
  })
  assert(candidates.length === 1, 'large transfer promoted')
  assert(candidates[0].visibility === 'org_private', 'private flow remains org private')
  assert(candidates[0].promoteEventMemory === false, 'private flow is not inserted into public event memory')
  assert(candidates[0].payload.private_user_scope === true, 'embedding payload marks private user scope')
})
