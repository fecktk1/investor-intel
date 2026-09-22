import { assertEquals as eq, assert, assertAlmostEquals as near } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  readRwaCoverage, readRwaUniverseChanges, readRwaConcentration, clampDays,
  RWA_COVERAGE_CAPTURE_VIEWS, RWA_COVERAGE_VIEWS, CATALOGUE_TABLE, DEPLOYMENT_TABLE, CONCENTRATION_FORMULA,
} from './capture-rwa-coverage-read.ts'
import { COVERAGE_ASSET_TABLE, COVERAGE_TOKEN_TABLE, COVERAGE_CHANGE_TABLE } from './capture-rwa-coverage.ts'
import { MAP_COUNT_TABLE } from './capture-rwa-underlyings.ts'
import { fakeDb } from './capture-rwa-coverage.fixtures.ts'

const NOW = Date.parse('2026-09-22T12:00:00.000Z')
const D1 = '2026-09-21', D2 = '2026-09-22'

const asset = (date: string, rwaId: number, state: string, tokens: number | null, extra: Record<string, unknown> = {}) => ({
  provider: 'coinmarketcap', snapshot_date: date, rwa_id: String(rwaId), asset_type: 'stock', coverage_state: state,
  token_count: tokens, priced_count: tokens, traded_count: state === 'tradeable' ? tokens : 0, captured_at: `${date}T03:19:00.000Z`, ...extra,
})
const tok = (date: string, rwaId: number, cryptoId: number, extra: Record<string, unknown> = {}) => ({
  provider: 'coinmarketcap', snapshot_date: date, rwa_id: String(rwaId), crypto_id: String(cryptoId), asset_type: 'stock',
  symbol: `T${cryptoId}`, name: `Token ${cryptoId}`, issuer_id: null, issuer_name: null, market_cap: null, volume_24h: null, token_state: 'tradeable', ...extra,
})

Deno.test('the three views are registered under their names', () => {
  eq(Object.keys(RWA_COVERAGE_CAPTURE_VIEWS), [...RWA_COVERAGE_VIEWS])
})

Deno.test('rwa_coverage: empty tables answer asOf null, and the ticker watch still resolves from the catalogue', async () => {
  const db = fakeDb({ [CATALOGUE_TABLE]: [{ source_provider: 'coingecko', provider_id: 'ousg', symbol: 'OUSG', name: 'Ondo Short-Term U.S. Government Bond Fund', market_cap: 700_000_000, in_current_catalog: true }] })
  const view = await readRwaCoverage(db, {}, NOW)
  eq(view.asOf, null)
  eq(view.headline, null)
  // deno-lint-ignore no-explicit-any
  const watch = view.expected as any
  eq(watch.tickers.find((t: { symbol: string }) => t.symbol === 'OUSG').state, 'present_with_value')
  eq(watch.tickers.find((t: { symbol: string }) => t.symbol === 'BENJI').state, 'absent')
  eq(watch.presentCount, 1)
  eq(watch.inUniverseCount, 0)
})

Deno.test('rwa_coverage: headline counts, truncation, and a name-differs symbol never counted present', async () => {
  const db = fakeDb({
    [COVERAGE_ASSET_TABLE]: [
      asset(D1, 1, 'tradeable', 1),
      asset(D2, 1, 'tradeable', 2), asset(D2, 2, 'priced_not_traded', 1), asset(D2, 3, 'listed_only', 1),
      asset(D2, 4, 'no_tokens_reported', 0), asset(D2, 5, 'not_returned', null, { not_returned_reason: 'batch_failed:http_500' }),
      asset(D2, 6, 'tradeable', 1, { asset_type: 'etf' }),
    ],
    [COVERAGE_TOKEN_TABLE]: [
      tok(D2, 1, 11, { symbol: 'BUIDL', name: 'BlackRock USD Institutional Digital Liquidity Fund', market_cap: 2e9 }),
      tok(D2, 2, 22, { symbol: 'USYC', name: 'Why You See', market_cap: 5 }),
      tok(D1, 3, 33, { symbol: 'BENJI', name: 'Franklin OnChain U.S. Government Money Fund', market_cap: 1 }), // yesterday: not read
    ],
    [CATALOGUE_TABLE]: [{ source_provider: 'coingecko', provider_id: 'hashnote-usyc', symbol: 'USYC', name: 'Some Other Coin', market_cap: null, in_current_catalog: true }],
    [MAP_COUNT_TABLE]: [{ asset_type: 'all', snapshot_date: D2, asset_count: 7811, with_tokens_count: 791, truncated: false, captured_at: `${D2}T03:11:00.000Z` }],
  })
  const view = await readRwaCoverage(db, {}, NOW)
  eq(view.asOf, D2)
  eq(view.previousSnapshotDate, D1)
  eq(view.headline, { withTokens: 4, noTradeable: 2, notReturned: 1, assets: 6, mapWithTokens: 791, mapTruncated: false, truncated: true })
  // deno-lint-ignore no-explicit-any
  const states = view.states as any
  eq([states.tradeable, states.priced_not_traded, states.listed_only, states.no_tokens_reported, states.not_returned], [2, 1, 1, 1, 1])
  // deno-lint-ignore no-explicit-any
  eq((view.byType as any[]).map((t) => `${t.assetType}:${t.assets}:${t.tradeable}`), ['stock:5:1', 'etf:1:1'])
  // deno-lint-ignore no-explicit-any
  const tickers = new Map((view.expected as any).tickers.map((t: any) => [t.symbol, t]))
  // deno-lint-ignore no-explicit-any
  const buidl = tickers.get('BUIDL') as any, usyc = tickers.get('USYC') as any, benji = tickers.get('BENJI') as any
  eq(buidl.state, 'present_with_value'); eq(buidl.inRwaUniverse, true)
  eq(usyc.state, 'symbol_seen_name_differs'); eq(usyc.inRwaUniverse, false)
  eq(benji.state, 'absent')
  // deno-lint-ignore no-explicit-any
  eq((view.expected as any).presentCount, 1)
})

Deno.test('rwa_universe_changes: not comparable with one snapshot; grouped and bounded by days afterwards', async () => {
  const one = await readRwaUniverseChanges(fakeDb({ [COVERAGE_ASSET_TABLE]: [asset(D2, 1, 'tradeable', 1)] }), { days: 7 }, NOW)
  eq(one.comparable, false)
  eq(one.rows, [])

  const ev = (date: string, rwaId: number, kind: string, from: string | null, to: string | null) => ({
    provider: 'coinmarketcap', snapshot_date: date, previous_snapshot_date: '2026-08-01', rwa_id: String(rwaId), change_kind: kind,
    from_state: from, to_state: to, symbol: `S${rwaId}`, name: null, asset_type: 'stock', detected_at: `${date}T03:19:00.000Z`,
  })
  const db = fakeDb({
    [COVERAGE_ASSET_TABLE]: [asset(D1, 1, 'tradeable', 1), asset(D2, 1, 'tradeable', 1)],
    [COVERAGE_CHANGE_TABLE]: [
      ev(D2, 2, 'listed', null, 'tradeable'), ev(D2, 3, 'shelved', 'tradeable', 'listed_only'),
      ev(D1, 4, 'removed', 'tradeable', null), ev('2026-09-10', 5, 'became_tradeable', 'listed_only', 'tradeable'),
    ],
  })
  const week = await readRwaUniverseChanges(db, { days: 7 }, NOW)
  eq(week.comparable, true)
  // deno-lint-ignore no-explicit-any
  eq((week.rows as any[]).map((r) => `${r.snapshotDate}:${r.kind}`), [`${D2}:listed`, `${D2}:shelved`, `${D1}:removed`])
  eq(week.counts, { listed: 1, removed: 1, became_tradeable: 0, shelved: 1 })
  const month = await readRwaUniverseChanges(db, { days: 90 }, NOW)
  eq(month.days, 30)
  // deno-lint-ignore no-explicit-any
  eq((month.counts as any).became_tradeable, 1)
  eq(clampDays('x'), 7)
  eq(clampDays(0), 7)
})

Deno.test('rwa_concentration: overall and per-type HHI, exclusions, and chain share from deployments', async () => {
  const db = fakeDb({
    [COVERAGE_TOKEN_TABLE]: [
      tok(D1, 9, 99, { issuer_id: 'old', market_cap: 1e12 }), // yesterday: ignored
      tok(D2, 1, 10, { issuer_id: 'A', issuer_name: 'Alpha', market_cap: 50 }),
      tok(D2, 2, 20, { issuer_id: 'B', issuer_name: 'Beta', market_cap: 30 }),
      tok(D2, 3, 30, { issuer_name: 'Cee Co', market_cap: 10, asset_type: 'etf' }),
      tok(D2, 4, 40, { issuer_name: 'CEE CO.', market_cap: 10, asset_type: 'etf' }),
      tok(D2, 5, 50, { issuer_id: 'D', market_cap: null }),
      tok(D2, 6, 60, { market_cap: 999 }),
    ],
    [DEPLOYMENT_TABLE]: [
      { token_key: 'cmc:10', platform_key: 'ethereum', platform_label: 'Ethereum' },
      { token_key: 'cmc:20', platform_key: 'ethereum', platform_label: 'Ethereum' },
      { token_key: 'cmc:20', platform_key: 'solana', platform_label: 'Solana' },
      { token_key: 'cmc:99', platform_key: 'base', platform_label: 'Base' },
    ],
  })
  const view = await readRwaConcentration(db, {}, NOW)
  eq(view.asOf, D2)
  eq(view.formula, CONCENTRATION_FORMULA)
  // deno-lint-ignore no-explicit-any
  const overall = view.overall as any
  near(overall.hhi, 3800, 1e-9)
  near(overall.effectiveIssuers, 1 / 0.38, 1e-9)
  near(overall.top5Share, 1, 1e-12)
  eq([overall.excludedNoWeight, overall.excludedNoIssuer, overall.includedTokens], [1, 1, 4])
  // deno-lint-ignore no-explicit-any
  const etf = (view.byType as any[]).find((t) => t.assetType === 'etf')
  near(etf.hhi, 10000, 1e-9) // one issuer group after name normalisation
  eq(etf.effectiveIssuers, 1)
  // deno-lint-ignore no-explicit-any
  const chains = view.chains as any
  eq(chains.tokens, 6)
  eq(chains.chains.map((c: { chain: string; deployments: number; singleChainValue: number | null; label: string }) => `${c.label}:${c.deployments}:${c.singleChainValue}`), ['Ethereum:2:50', 'Solana:1:null'])
  eq([chains.multiChainTokens, chains.multiChainValue], [1, 30])
  eq(chains.noDeploymentTokens, 4)
  assert(!chains.chains.some((c: { chain: string }) => c.chain === 'base'))
})

Deno.test('a failed read is a reason on the result, never an exception', async () => {
  const db = fakeDb({ [COVERAGE_TOKEN_TABLE]: [tok(D2, 1, 10, { issuer_id: 'A', market_cap: 1 })] }, { [DEPLOYMENT_TABLE]: 'permission denied' })
  const view = await readRwaConcentration(db, {}, NOW)
  eq(view.chains, null)
  eq(view.reason, 'permission denied')
  const broken = await readRwaCoverage(fakeDb({}, { [COVERAGE_ASSET_TABLE]: 'boom' }), {}, NOW)
  eq(broken.asOf, null)
  eq(broken.reason, 'boom')
})
