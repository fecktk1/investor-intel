import { assertEquals as eq, assert, assertAlmostEquals as near } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  tokenCoverageState, assetCoverageState, coverageChanges, concentration, chainShare, issuerGroupKey,
  normalizeIssuerName, resolveExpectedTicker, tickerCountsAsPresent, EXPECTED_RWA_TICKERS, EXPECTED_TICKER_STATES,
  type CoverageSnapshotRow, type RemovalEvidence,
} from './rwa-coverage.ts'
import { normalizeName } from './capture-rwa-underlyings.ts'

Deno.test('token state: no price is listed_only, no or zero volume is priced_not_traded, else tradeable', () => {
  eq(tokenCoverageState({ price: null, volume24h: 1000 }), 'listed_only')
  eq(tokenCoverageState({ price: 0, volume24h: 1000 }), 'listed_only')
  eq(tokenCoverageState({ price: 1, volume24h: null }), 'priced_not_traded')
  eq(tokenCoverageState({ price: 1, volume24h: 0 }), 'priced_not_traded')
  eq(tokenCoverageState({ price: 1, volume24h: 5 }), 'tradeable')
})

Deno.test('asset state is its best token; no tokens is no_tokens_reported', () => {
  eq(assetCoverageState([]), 'no_tokens_reported')
  eq(assetCoverageState(['listed_only', 'priced_not_traded']), 'priced_not_traded')
  eq(assetCoverageState(['listed_only', 'tradeable', 'priced_not_traded']), 'tradeable')
  eq(assetCoverageState(['listed_only']), 'listed_only')
})

const row = (rwaId: string, state: CoverageSnapshotRow['state']): CoverageSnapshotRow => ({ rwaId, state, symbol: `S${rwaId}`, name: null, assetType: 'stock' })
const noEvidence: RemovalEvidence = { mapCompleteToday: false, mapRunAt: null, lastSeenAt: new Map() }

Deno.test('first run (no previous snapshot) produces no events at all', () => {
  eq(coverageChanges(null, [row('1', 'tradeable'), row('2', 'listed_only')], noEvidence), [])
  eq(coverageChanges([], [row('1', 'tradeable')], noEvidence), [])
})

Deno.test('listed, became_tradeable and shelved between two answered snapshots', () => {
  const prev = [row('1', 'priced_not_traded'), row('2', 'tradeable'), row('3', 'tradeable')]
  const today = [row('1', 'tradeable'), row('2', 'listed_only'), row('3', 'tradeable'), row('4', 'no_tokens_reported')]
  const events = coverageChanges(prev, today, noEvidence)
  eq(events.map((e) => `${e.rwaId}:${e.kind}:${e.fromState}->${e.toState}`).sort(), [
    '1:became_tradeable:priced_not_traded->tradeable',
    '2:shelved:tradeable->listed_only',
    '4:listed:null->no_tokens_reported',
  ])
})

Deno.test('not_returned on either side never produces a shelving, a listing or a removal', () => {
  const prev = [row('1', 'tradeable'), row('2', 'not_returned'), row('3', 'tradeable')]
  const today = [row('1', 'not_returned'), row('2', 'tradeable'), row('5', 'not_returned')]
  const evidence: RemovalEvidence = { mapCompleteToday: true, mapRunAt: '2026-09-22T03:11:00.000Z', lastSeenAt: new Map([['3', '2026-09-21T03:11:00.000Z']]) }
  const events = coverageChanges(prev, today, evidence)
  // Only asset 3 (answered yesterday, missing today, map stopped seeing it) is removed.
  eq(events.map((e) => `${e.rwaId}:${e.kind}`), ['3:removed'])
})

Deno.test('removed needs a complete map run today AND last_seen before that run', () => {
  const prev = [row('7', 'tradeable')]
  const run = '2026-09-22T03:11:00.000Z'
  const stale = new Map([['7', '2026-09-21T03:11:00.000Z']])
  eq(coverageChanges(prev, [], { mapCompleteToday: true, mapRunAt: run, lastSeenAt: stale }).map((e) => e.kind), ['removed'])
  // Truncated / missing count row: silence.
  eq(coverageChanges(prev, [], { mapCompleteToday: false, mapRunAt: run, lastSeenAt: stale }), [])
  // Seen by today's map run: it is still in the universe, so no removal.
  eq(coverageChanges(prev, [], { mapCompleteToday: true, mapRunAt: run, lastSeenAt: new Map([['7', run]]) }), [])
  // No map row read for it at all: silence.
  eq(coverageChanges(prev, [], { mapCompleteToday: true, mapRunAt: run, lastSeenAt: new Map() }), [])
})

Deno.test('issuer grouping: id first, else the normalised name, else excluded', () => {
  eq(issuerGroupKey('42', 'Whatever'), '42')
  eq(issuerGroupKey(null, 'Acme Ltd.'), 'name:acmeltd')
  eq(issuerGroupKey('', 'ACME LTD'), 'name:acmeltd')
  eq(issuerGroupKey(null, null), null)
  for (const v of ['Nvidia Corp.', 'BlackRock, Inc.', '', null, 'Ondo  Finance']) eq(normalizeIssuerName(v), normalizeName(v))
})

Deno.test('HHI, effective issuers and top-5 on a hand-computed fixture, with exclusions counted', () => {
  // Weights 50 / 30 / 20 (two tokens of 10 each for C, grouped by normalised name).
  // Shares 0.5, 0.3, 0.2 -> sum of squares 0.25 + 0.09 + 0.04 = 0.38.
  // HHI = 3800, effective issuers = 1 / 0.38 = 2.6315..., top-5 share = 1.
  const result = concentration([
    { group: 'A', weight: 50 },
    { group: 'B', weight: 30 },
    { group: issuerGroupKey(null, 'Cee Co'), weight: 10 },
    { group: issuerGroupKey(null, 'CEE CO.'), weight: 10 },
    { group: 'D', weight: null },          // null weight: excluded, NOT a zero
    { group: null, weight: 999 },          // no issuer: excluded
  ])
  assert(result.available)
  near(result.hhi!, 3800, 1e-9)
  near(result.effectiveIssuers!, 1 / 0.38, 1e-9)
  near(result.top5Share!, 1, 1e-12)
  eq(result.excludedNoWeight, 1)
  eq(result.excludedNoIssuer, 1)
  eq(result.includedTokens, 4)
  eq(result.totalWeight, 100)
  eq(result.groups.map((g) => g.key), ['A', 'B', 'name:ceeco'])
  eq(result.groups[2].tokens, 2)
})

Deno.test('top-5 share uses only the five largest issuers; zero weights are included but add nothing', () => {
  const result = concentration([10, 10, 10, 10, 10, 10, 10, 10, 10, 10].map((w, i) => ({ group: `g${i}`, weight: w })).concat([{ group: 'z', weight: 0 }]))
  near(result.top5Share!, 0.5, 1e-12)
  near(result.hhi!, 1000, 1e-9)
  near(result.effectiveIssuers!, 10, 1e-9)
  eq(result.includedTokens, 11)
})

Deno.test('concentration with nothing weighted says why rather than dividing by zero', () => {
  eq(concentration([{ group: 'a', weight: null }]).reason, 'no_weighted_tokens')
  eq(concentration([{ group: 'a', weight: 0 }]).reason, 'all_weights_zero')
  eq(concentration([{ group: 'a', weight: 0 }]).hhi, null)
})

Deno.test('chain share: deployments per chain for all, value only for single-chain tokens', () => {
  const share = chainShare([
    { cryptoId: '1', weight: 100, chains: ['ethereum'] },
    { cryptoId: '2', weight: 40, chains: ['ethereum', 'solana'] },
    { cryptoId: '3', weight: null, chains: ['solana'] },
    { cryptoId: '4', weight: 7, chains: [] },
  ])
  eq(share.chains, [
    { chain: 'ethereum', deployments: 2, singleChainTokens: 1, singleChainValue: 100 },
    { chain: 'solana', deployments: 2, singleChainTokens: 1, singleChainValue: null },
  ])
  eq(share.multiChainTokens, 1)
  eq(share.multiChainValue, 40)
  eq(share.noDeploymentTokens, 1)
  eq(share.noDeploymentValue, 7)
})

const BUIDL = EXPECTED_RWA_TICKERS.find((t) => t.symbol === 'BUIDL')!

Deno.test('expected tickers: the four funds are watched with an expected name each', () => {
  eq(EXPECTED_RWA_TICKERS.map((t) => t.symbol), ['BUIDL', 'BENJI', 'OUSG', 'USYC'])
  for (const t of EXPECTED_RWA_TICKERS) assert(t.expectedName.length > 5 && t.nameFragments.length > 0)
  eq([...EXPECTED_TICKER_STATES], ['absent', 'present_but_empty', 'present_with_value', 'symbol_seen_name_differs'])
})

Deno.test('expected ticker states: absent, name differs (never present), empty, with value, in universe', () => {
  eq(resolveExpectedTicker(BUIDL, []).state, 'absent')

  const imposter = resolveExpectedTicker(BUIDL, [{ source: 'rwa_coverage', symbol: 'buidl', name: 'Build Token', marketCap: 5_000_000 }])
  eq(imposter.state, 'symbol_seen_name_differs')
  eq(imposter.inRwaUniverse, false)
  eq(tickerCountsAsPresent(imposter.state), false)
  eq(imposter.otherNames, ['Build Token'])

  const empty = resolveExpectedTicker(BUIDL, [{ source: 'market_assets', symbol: 'BUIDL', name: 'BlackRock USD Institutional Digital Liquidity Fund', marketCap: null }])
  eq(empty.state, 'present_but_empty')
  eq(empty.inRwaUniverse, false)
  eq(tickerCountsAsPresent(empty.state), true)

  const valued = resolveExpectedTicker(BUIDL, [
    { source: 'market_assets', symbol: 'BUIDL', name: 'BlackRock USD Institutional Digital Liquidity Fund', marketCap: 0 },
    { source: 'rwa_coverage', symbol: 'BUIDL', name: 'BlackRock BUIDL', marketCap: 2_000_000_000 },
    { source: 'rwa_coverage', symbol: 'BUIDL', name: 'Unrelated', marketCap: 9 },
  ])
  eq(valued.state, 'present_with_value')
  eq(valued.inRwaUniverse, true)
  eq(valued.matched.length, 2)
  eq(valued.otherNames, ['Unrelated'])
})
