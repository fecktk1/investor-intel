// Investor Intel: RWA universe coverage, pure helpers.
//
// No database, no network, no clock. Everything here is a function of its
// arguments, so the capture lane (capture-rwa-coverage.ts), the read views
// (capture-rwa-coverage-read.ts) and the tests all share one definition of:
//
//   * what a token's coverage state is, and what an asset's is,
//   * which change between two daily snapshots is an event and which is not,
//   * the concentration arithmetic (HHI, effective number, top-5 share),
//   * the chain-share rule (deployment counts everywhere, value only where a
//     token lives on exactly one chain),
//   * the expected-ticker watch (BUIDL, BENJI, OUSG, USYC).
//
// HONESTY RULES THIS FILE KEEPS:
//   * A token with no reported weight is EXCLUDED from a concentration figure
//     and counted as excluded. It is never weighted as zero.
//   * A symbol seen under a different name is `symbol_seen_name_differs` and is
//     NEVER counted as present. A ticker is not an identity.
//   * An asset the provider did not return (a failed batch, or an id the
//     response left out) is `not_returned`. It is never read as "no tokens",
//     and it never produces a removal or a shelving event.

export const COVERAGE_TOKEN_STATES = ['tradeable', 'priced_not_traded', 'listed_only'] as const
export type CoverageTokenState = typeof COVERAGE_TOKEN_STATES[number]

export const COVERAGE_ASSET_STATES = ['tradeable', 'priced_not_traded', 'listed_only', 'no_tokens_reported', 'not_returned'] as const
export type CoverageAssetState = typeof COVERAGE_ASSET_STATES[number]

export const COVERAGE_CHANGE_KINDS = ['listed', 'removed', 'became_tradeable', 'shelved'] as const
export type CoverageChangeKind = typeof COVERAGE_CHANGE_KINDS[number]

/** Best first. An asset takes the state of its best token. */
const TOKEN_RANK: Record<CoverageTokenState, number> = { tradeable: 0, priced_not_traded: 1, listed_only: 2 }

const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }

/** One token's state, from the three figures the quotes endpoint reports.
 *
 *   price null            listed_only        the provider lists it and prices nothing
 *   volume null or 0      priced_not_traded  a price with no reported trading behind it
 *   otherwise             tradeable          a price AND reported 24h volume
 *
 * `tradeable` means "reported trading", not "you can buy it": a permissioned
 * fund token can carry volume between whitelisted holders only. */
export function tokenCoverageState(token: { price?: unknown; volume24h?: unknown }): CoverageTokenState {
  const price = num(token?.price)
  if (price == null || price <= 0) return 'listed_only'
  const volume = num(token?.volume24h)
  if (volume == null || volume <= 0) return 'priced_not_traded'
  return 'tradeable'
}

/** An asset's state is its BEST token's state; an asset whose tokens array is
 * empty is `no_tokens_reported`. `not_returned` is set by the lane, never here:
 * this function only ever sees an asset the provider did answer for. */
export function assetCoverageState(tokenStates: CoverageTokenState[]): Exclude<CoverageAssetState, 'not_returned'> {
  if (!tokenStates.length) return 'no_tokens_reported'
  return [...tokenStates].sort((a, b) => TOKEN_RANK[a] - TOKEN_RANK[b])[0]
}

// ─── The daily diff ──────────────────────────────────────────────────────────

export interface CoverageSnapshotRow {
  rwaId: string
  state: CoverageAssetState
  symbol?: string | null
  name?: string | null
  assetType?: string | null
}

export interface CoverageChange {
  rwaId: string
  kind: CoverageChangeKind
  fromState: CoverageAssetState | null
  toState: CoverageAssetState | null
  symbol: string | null
  name: string | null
  assetType: string | null
}

export interface RemovalEvidence {
  /** Whether the asset map's own count row for today exists and says the
   * enumeration finished (truncated === false). A truncated or missing count
   * means the map may simply not have reached the asset. */
  mapCompleteToday: boolean
  /** Today's map run, as an ISO instant (the `all` count row's captured_at). */
  mapRunAt: string | null
  /** rwa_id -> the map row's last_seen_at, for every previously-present asset
   * that is missing from today. Absent key = no map row at all. */
  lastSeenAt: Map<string, string | null>
}

const NOT_TRADEABLE: CoverageAssetState[] = ['priced_not_traded', 'listed_only', 'no_tokens_reported']

/** The events between the previous snapshot and today's.
 *
 *   listed            in today (answered), absent from the previous snapshot entirely
 *   removed           in the previous snapshot (answered), absent from today, AND the
 *                     asset map last saw it BEFORE today's map run, AND today's map
 *                     enumeration was complete. Anything short of that is silence.
 *   became_tradeable  answered both days, not tradeable before, tradeable today
 *   shelved           answered both days, tradeable before, not tradeable today
 *
 * No previous snapshot means no events at all: a first run lists nothing, or the
 * whole universe would arrive as "listed today". `not_returned` on either side
 * produces nothing, because we do not know what the provider would have said. */
export function coverageChanges(
  previous: CoverageSnapshotRow[] | null,
  today: CoverageSnapshotRow[],
  evidence: RemovalEvidence,
): CoverageChange[] {
  if (!previous || !previous.length) return []
  const before = new Map(previous.map((row) => [row.rwaId, row]))
  const now = new Map(today.map((row) => [row.rwaId, row]))
  const out: CoverageChange[] = []
  const event = (row: CoverageSnapshotRow, kind: CoverageChangeKind, fromState: CoverageAssetState | null, toState: CoverageAssetState | null) =>
    out.push({ rwaId: row.rwaId, kind, fromState, toState, symbol: row.symbol ?? null, name: row.name ?? null, assetType: row.assetType ?? null })

  for (const row of today) {
    const prior = before.get(row.rwaId)
    if (row.state === 'not_returned') continue
    if (!prior) { event(row, 'listed', null, row.state); continue }
    if (prior.state === 'not_returned') continue
    if (prior.state !== 'tradeable' && row.state === 'tradeable') event(row, 'became_tradeable', prior.state, row.state)
    else if (prior.state === 'tradeable' && NOT_TRADEABLE.includes(row.state)) event(row, 'shelved', prior.state, row.state)
  }

  const mapRunMs = Date.parse(String(evidence.mapRunAt ?? ''))
  if (evidence.mapCompleteToday && Number.isFinite(mapRunMs)) {
    for (const prior of previous) {
      if (now.has(prior.rwaId) || prior.state === 'not_returned') continue
      if (!evidence.lastSeenAt.has(prior.rwaId)) continue
      const seenMs = Date.parse(String(evidence.lastSeenAt.get(prior.rwaId) ?? ''))
      if (!Number.isFinite(seenMs) || seenMs >= mapRunMs) continue
      event(prior, 'removed', prior.state, null)
    }
  }
  return out
}

// ─── Concentration ───────────────────────────────────────────────────────────

/** Case folding plus removal of every non letter-digit character. Identical to
 * `normalizeName` in capture-rwa-underlyings.ts (asserted by test), restated
 * here so this module stays free of that lane's network imports. */
export function normalizeIssuerName(value: unknown): string | null {
  const s = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  return s ? s : null
}

/** The group an issuer's tokens are pooled under: the provider's issuer id, or
 * failing that its normalised issuer name. Null when neither is reported. */
export function issuerGroupKey(issuerId: unknown, issuerName: unknown): string | null {
  const id = String(issuerId ?? '').trim()
  if (id) return id
  const name = normalizeIssuerName(issuerName)
  return name ? `name:${name}` : null
}

export interface ConcentrationInput { group: string | null; weight: number | null; label?: string | null }
export interface ConcentrationGroup { key: string; label: string | null; weight: number; share: number; tokens: number }
export interface Concentration {
  available: boolean
  reason: string | null
  /** Herfindahl-Hirschman index on the 0..10000 scale. */
  hhi: number | null
  /** 1 / sum(s^2): the number of equal-sized issuers that would give this HHI. */
  effectiveIssuers: number | null
  /** Sum of the five largest shares, 0..1. */
  top5Share: number | null
  totalWeight: number
  includedTokens: number
  excludedNoWeight: number
  excludedNoIssuer: number
  groups: ConcentrationGroup[]
}

/** HHI, effective N and top-5 share over `market_cap` weights.
 *
 * A NULL weight is excluded and counted (`excludedNoWeight`); a token with no
 * issuer id and no issuer name is excluded and counted (`excludedNoIssuer`). A
 * weight of exactly 0 is a real report and is included, contributing nothing.
 * When every included weight is zero there is no share to compute, and the
 * result says so rather than dividing by zero. */
export function concentration(rows: ConcentrationInput[], topGroups = 10): Concentration {
  let excludedNoWeight = 0, excludedNoIssuer = 0, included = 0, total = 0
  const groups = new Map<string, { weight: number; tokens: number; label: string | null }>()
  for (const row of rows) {
    const weight = num(row?.weight)
    if (weight == null || weight < 0) { excludedNoWeight += 1; continue }
    if (!row.group) { excludedNoIssuer += 1; continue }
    included += 1
    total += weight
    const g = groups.get(row.group) ?? { weight: 0, tokens: 0, label: row.label ?? null }
    g.weight += weight
    g.tokens += 1
    if (!g.label && row.label) g.label = row.label
    groups.set(row.group, g)
  }
  const base = { totalWeight: total, includedTokens: included, excludedNoWeight, excludedNoIssuer }
  if (!included) return { available: false, reason: 'no_weighted_tokens', hhi: null, effectiveIssuers: null, top5Share: null, groups: [], ...base }
  if (total <= 0) return { available: false, reason: 'all_weights_zero', hhi: null, effectiveIssuers: null, top5Share: null, groups: [], ...base }
  const ranked = [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, weight: g.weight, share: g.weight / total, tokens: g.tokens }))
    .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key))
  const sumSquares = ranked.reduce((sum, g) => sum + g.share * g.share, 0)
  return {
    available: true, reason: null,
    hhi: sumSquares * 10_000,
    effectiveIssuers: sumSquares > 0 ? 1 / sumSquares : null,
    top5Share: ranked.slice(0, 5).reduce((sum, g) => sum + g.share, 0),
    groups: ranked.slice(0, Math.max(0, topGroups)),
    ...base,
  }
}

// ─── Chain share ─────────────────────────────────────────────────────────────

export interface ChainTokenInput { cryptoId: string; weight: number | null; chains: string[] }
export interface ChainShareRow { chain: string; deployments: number; singleChainTokens: number; singleChainValue: number | null }
export interface ChainShare {
  chains: ChainShareRow[]
  /** Tokens that live on two or more chains: counted per chain, but their value
   * is NOT attributable to any one chain and is reported as one lump. */
  multiChainTokens: number
  multiChainValue: number | null
  /** Tokens with no deployment on record at all. */
  noDeploymentTokens: number
  noDeploymentValue: number | null
}

const addValue = (sum: number | null, v: number | null): number | null => (v == null ? sum : (sum ?? 0) + v)

/** Deployment counts per chain for every token, and value per chain ONLY for a
 * token that lives on exactly one chain. A multi-chain token's market cap is a
 * single provider figure with no per-chain split, so dividing it by chain would
 * invent a breakdown nobody published. */
export function chainShare(tokens: ChainTokenInput[]): ChainShare {
  const byChain = new Map<string, ChainShareRow>()
  let multiChainTokens = 0, noDeploymentTokens = 0
  let multiChainValue: number | null = null, noDeploymentValue: number | null = null
  for (const token of tokens) {
    const chains = [...new Set((token.chains || []).filter(Boolean))]
    const weight = num(token.weight)
    if (!chains.length) { noDeploymentTokens += 1; noDeploymentValue = addValue(noDeploymentValue, weight); continue }
    for (const chain of chains) {
      const row = byChain.get(chain) ?? { chain, deployments: 0, singleChainTokens: 0, singleChainValue: null }
      row.deployments += 1
      if (chains.length === 1) { row.singleChainTokens += 1; row.singleChainValue = addValue(row.singleChainValue, weight) }
      byChain.set(chain, row)
    }
    if (chains.length > 1) { multiChainTokens += 1; multiChainValue = addValue(multiChainValue, weight) }
  }
  return {
    chains: [...byChain.values()].sort((a, b) => b.deployments - a.deployments || a.chain.localeCompare(b.chain)),
    multiChainTokens, multiChainValue, noDeploymentTokens, noDeploymentValue,
  }
}

// ─── The expected-ticker watch ───────────────────────────────────────────────

/** Tokenised funds a reader expects to find in an RWA board. Each carries the
 * fund name we expect and the normalised name fragments that count as a match.
 * A fragment match on the NAME is required: the symbol alone proves nothing. */
export const EXPECTED_RWA_TICKERS = [
  { symbol: 'BUIDL', expectedName: 'BlackRock USD Institutional Digital Liquidity Fund', nameFragments: ['blackrock', 'buidl'] },
  { symbol: 'BENJI', expectedName: 'Franklin OnChain U.S. Government Money Fund', nameFragments: ['franklin', 'benji'] },
  { symbol: 'OUSG', expectedName: 'Ondo Short-Term U.S. Government Bond Fund', nameFragments: ['ondo', 'ousg'] },
  { symbol: 'USYC', expectedName: 'Circle USYC (Hashnote International Short Duration Yield Fund)', nameFragments: ['usyc', 'hashnote'] },
] as const

export const EXPECTED_TICKER_STATES = ['absent', 'present_but_empty', 'present_with_value', 'symbol_seen_name_differs'] as const
export type ExpectedTickerState = typeof EXPECTED_TICKER_STATES[number]

export interface TickerSighting {
  /** 'market_assets' (the catalogue) or 'rwa_coverage' (today's RWA tokens). */
  source: 'market_assets' | 'rwa_coverage'
  sourceProvider?: string | null
  id?: string | null
  symbol: string | null
  name: string | null
  marketCap: number | null
  volume24h?: number | null
}

export interface ExpectedTickerResult {
  symbol: string
  expectedName: string
  state: ExpectedTickerState
  /** True only when a NAME-MATCHED sighting is in today's RWA coverage. */
  inRwaUniverse: boolean
  matched: TickerSighting[]
  /** Names seen under this symbol that did not match. Shown, never counted. */
  otherNames: string[]
}

export function nameMatchesExpected(fragments: readonly string[], name: unknown): boolean {
  const n = normalizeIssuerName(name)
  return !!n && fragments.some((f) => n.includes(f))
}

/** Resolve one expected ticker against everything seen under its symbol.
 *
 *   absent                    no row anywhere carries the symbol
 *   symbol_seen_name_differs  the symbol is seen, but under other names only.
 *                             NEVER counted as present.
 *   present_but_empty         a name-matched row exists and none reports a
 *                             positive market cap
 *   present_with_value        a name-matched row reports a positive market cap */
export function resolveExpectedTicker(
  expected: { symbol: string; expectedName: string; nameFragments: readonly string[] },
  sightings: TickerSighting[],
): ExpectedTickerResult {
  const want = expected.symbol.toUpperCase()
  const bySymbol = sightings.filter((s) => String(s?.symbol ?? '').trim().toUpperCase() === want)
  const matched = bySymbol.filter((s) => nameMatchesExpected(expected.nameFragments, s.name))
  const otherNames = [...new Set(bySymbol.filter((s) => !matched.includes(s)).map((s) => s.name).filter((v): v is string => !!v))]
  let state: ExpectedTickerState
  if (!bySymbol.length) state = 'absent'
  else if (!matched.length) state = 'symbol_seen_name_differs'
  else state = matched.some((s) => (num(s.marketCap) ?? 0) > 0) ? 'present_with_value' : 'present_but_empty'
  return {
    symbol: expected.symbol, expectedName: expected.expectedName, state,
    inRwaUniverse: matched.some((s) => s.source === 'rwa_coverage'),
    matched, otherNames,
  }
}

/** Present means name-matched. `symbol_seen_name_differs` is not present. */
export const tickerCountsAsPresent = (state: ExpectedTickerState): boolean =>
  state === 'present_but_empty' || state === 'present_with_value'
