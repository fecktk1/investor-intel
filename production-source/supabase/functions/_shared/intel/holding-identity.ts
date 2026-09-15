// Investor Intel — contract identity resolution for portfolio holdings
// (CMC plan Stage 4, proposal 25).
//
// A holding that arrived from a wallet sync carries a contract address and a
// chain but no price: 98 open holdings were unpriced on 2026-09-15 (72 base,
// 9 bnb, 8 ethereum, 6 avalanche, 3 optimism). This module turns that book into
// two questions a provider can actually answer, and turns the answers back into
// per-holding facts. It is PURE: no database, no fetch, no clock. The Edge
// Function `intel-portfolio-identity` owns every side effect.
//
// THE HONESTY RULES THIS FILE ENFORCES
//
//   1. Only the four verified CoinMarketCap DEX chains (`CMC_DEX_NETWORKS`:
//      ethereum, base, arbitrum, solana) can be asked. A holding on bnb,
//      avalanche or optimism is reported `unsupported_platform` and is NEVER
//      guessed at, mapped to a "similar" chain, or silently dropped from the
//      counts. Widening the list is a `dexPlatforms` validation exercise
//      (proposal 31), not an edit here.
//   2. A token the provider did not answer about is `not_found_on_provider`.
//      A token it answered about without a price is `price_unavailable`. Absence
//      never becomes the number 0 — a 0 would value a real position at nothing.
//      A provider-STATED zero is a different thing and stays a zero.
//   3. Every count is a real count. A chain with nothing unpriced reports 0,
//      not an absent row.
//   4. A number the provider states is not automatically a price we may write.
//      See the plausibility gate below.
//
// THE PLAUSIBILITY GATE (added 2026-09-15, after the first live run)
// That run priced a Base holding, STREAMGPT, at $3,723,685 a token and valued the
// position at $372.4M, distorting the whole portfolio. A provider aggregate over
// an illiquid pool is arithmetic, not a price at which anything could trade.
// Three refusals now stand between an answer and a write. A refused row keeps its
// identity, reports `price_implausible` with the numbers it was refused on, and
// is NOT written — the holding stays unpriced rather than becoming confidently
// wrong, because an unpriced holding is a known gap and a wrong one is not.
//
//   (a) Reported pool liquidity below $1,000, or absent entirely. Liquidity is
//       read from `dexBatch.liqUsd`, falling back to `dexPriceBatch.l`.
//   (b) quantity x price above the token's own reported market cap
//       (`dexBatch.mcap`, falling back to `dexPriceBatch.mc`): a holding cannot
//       be worth more than the whole token.
//   (c) quantity x price above $1,000,000 for a holding that was UNPRICED before
//       this run. This ceiling is a STAGE 4 GUARD on a first write, not a law of
//       nature — a genuine seven-figure position exists — and it is one constant
//       to move once the gate has a live track record.
//
// Cost, as probed on 2026-09-14 (docs/investor-intel/evidence/
// cmc-cost-probe-2026-09-14.json): one `dexBatch` call and one `dexPriceBatch`
// call each reported `credit_count: 1` for a ONE-address request. Whether a full
// 50-member batch still costs one credit is UNMEASURED, so `estimatedCredits` is
// a floor, never a promise; the transport reconciles the real charge.

import { CMC_DEX_NETWORKS, cmcDexAddress, cmcDexNumber } from '../market-assets/cmc-dex.ts'

/** Provider ceiling for both batch families (`cmcParams` rejects a longer list). */
export const HOLDING_BATCH_MAX = 50
/** Subjects one on-demand run may ask about, before chunking into batches. */
export const HOLDING_RUN_LIMIT_DEFAULT = 50
export const HOLDING_RUN_LIMIT_MAX = 200
/** Only these two states are worth spending a credit on. */
export const RESOLVABLE_PRICE_STATUSES = ['unpriced', 'stale'] as const
/** Plausibility gate (a): a pool this thin does not produce a price, it produces
 * a quotient. Below this, or with no liquidity reported at all, we refuse. */
export const MIN_POOL_LIQUIDITY_USD = 1_000
/** Plausibility gate (c): the largest position value this feature will write the
 * FIRST time it prices a holding. A Stage 4 guard, not a law of nature. */
export const MAX_FIRST_PRICE_VALUE_USD = 1_000_000

export interface HoldingIdentityRow {
  id: string
  chain?: string | null
  contract_address?: string | null
  mint_or_contract?: string | null
  asset_symbol?: string | null
  normalized_symbol?: string | null
  name?: string | null
  quantity?: number | string | null
  price_status?: string | null
  is_closed?: boolean | null
}

export interface ChainCoverage {
  chain: string
  /** True when the chain is one of the four verified CMC DEX platforms. */
  supported: boolean
  total: number
  priced: number
  unpriced: number
  stale: number
  /** `price_status` also admits 'estimated'; it is counted, never folded into
   * `priced` (an estimate is not a provider price) and never dropped. */
  estimated: number
  /** Open holdings on a verified chain that carry a usable contract address —
   * the ones a resolve run could ask about, whatever their current status. */
  resolvable: number
  reason: string | null
}

export interface CoverageTotals {
  chains: number
  total: number
  priced: number
  unpriced: number
  stale: number
  estimated: number
  resolvable: number
  /** Open unpriced/stale holdings a run cannot ask about, by cause. */
  unsupported: number
  missingContract: number
}

export interface CoverageReport { chains: ChainCoverage[]; totals: CoverageTotals }

export type SkipReason = 'unsupported_platform' | 'no_contract_address' | 'over_run_limit'
export type AnswerReason = 'priced' | 'price_unavailable' | 'price_implausible' | 'not_found_on_provider' | SkipReason
/** Which refusal tripped, so a reader is told what was wrong and not merely that
 * something was. Order of evaluation is the order listed here. */
export type ImplausibleRule = 'liquidity_unknown' | 'liquidity_below_floor' | 'value_exceeds_market_cap' | 'value_exceeds_first_price_ceiling'

export interface PlannedHolding {
  holdingId: string
  chain: string
  platform: string
  address: string
  quantity: number | null
  symbol: string | null
  name: string | null
  /** The status before this run. A holding that was already priced is held to a
   * lower bar than one this feature is about to price for the first time. */
  priceStatus: string
}

export interface PlanSubject { platform: string; chain: string; address: string; holdingIds: string[] }
export interface SkippedHolding { holdingId: string; chain: string; reason: SkipReason }

export interface HoldingResolutionPlan {
  subjects: PlanSubject[]
  /** One `dexBatch` request per entry: one platform, up to 50 addresses. */
  batchGroups: { platform: string; addresses: string[] }[]
  /** One `dexPriceBatch` request per entry: up to 50 `platform:address` members
   * which may span platforms, because every member states its own chain. */
  priceGroups: { tokens: { platform: string; address: string }[] }[]
  holdings: PlannedHolding[]
  skipped: SkippedHolding[]
  unsupported: { chain: string; count: number }[]
  /** Holdings this run will ask about (planned only, never the skipped ones). */
  requested: number
  limit: number
  /** True when eligible subjects were cut to `limit`. */
  truncated: boolean
  /** Probed FLOOR: 1 credit per batch call. The per-member curve is unmeasured. */
  estimatedCredits: number
}

export interface HoldingAnswer {
  holdingId: string
  chain: string
  platform: string
  address: string
  matched: boolean
  symbol: string | null
  name: string | null
  cmcDexPrice: number | null
  /** Which call carried the price, so a reader can tell a price batch answer
   * from the price embedded in the identity batch. Null when there is no price. */
  priceFrom: 'dexPriceBatch' | 'dexBatch' | null
  quantity: number | null
  /** quantity x price. Present for a priced row; null when there is no price.
   * For a REFUSED row this is null — the value was never accepted — and the
   * number that was refused lives in `implausible.impliedValue`. */
  value: number | null
  /** Pool liquidity and market cap as the provider reported them, for any matched
   * row, so a reader can see what the gate saw. Null means the provider said
   * nothing, which is itself a refusal under gate (a). */
  liquidityUsd: number | null
  marketCapUsd: number | null
  /** Only on a `price_implausible` row: exactly what was refused, and why. */
  implausible: { price: number; liquidityUsd: number | null; marketCapUsd: number | null; impliedValue: number | null; rule: ImplausibleRule } | null
  reason: AnswerReason
}

/** A chain label as the book stores it: lower-case, trimmed, never empty. */
export function normalizeChain(value: unknown): string {
  const chain = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return chain || 'unknown'
}

/** The verified CMC DEX platform for a chain label. Accepts both spellings the
 * codebase uses: the platform name the holdings table stores ('base') and the
 * CAIP-style key entities store ('eip155:8453'). Anything else is null, which
 * is what makes bnb/avalanche/optimism `unsupported_platform` rather than a guess. */
export function cmcPlatformForChain(value: unknown): string | null {
  const chain = normalizeChain(value)
  const network = CMC_DEX_NETWORKS.find((n) => n.platform === chain || n.chain === chain)
  return network ? network.platform : null
}

/** The contract the holding is actually about. Wallet syncs fill one of the two
 * columns depending on the adapter; neither is preferred over a non-empty other. */
export function holdingAddress(row: HoldingIdentityRow): string | null {
  for (const value of [row.contract_address, row.mint_or_contract]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** Provider canonical form: EVM addresses are lower-cased, base58 mints are not
 * (case is significant in base58). Mirrors `cmcParams`, which does the same. */
export const canonicalAddress = (address: string, platform: string): string =>
  platform === 'solana' ? address : address.toLowerCase()

const isOpen = (row: HoldingIdentityRow): boolean => row.is_closed !== true
const finite = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}
const text = (value: unknown): string | null => {
  const s = typeof value === 'string' ? value.trim() : ''
  return s ? s : null
}

/** A holding that a resolve run could ask the provider about: open, on a
 * verified chain, with an address that is well-formed for that chain. */
function subjectOf(row: HoldingIdentityRow): { platform: string; address: string } | null {
  const platform = cmcPlatformForChain(row.chain)
  if (!platform) return null
  const raw = holdingAddress(row)
  if (!raw || !cmcDexAddress(raw, platform)) return null
  return { platform, address: canonicalAddress(raw, platform) }
}

/**
 * Priced-versus-unpriced coverage of the OPEN book, by chain.
 *
 * Closed holdings are excluded: a closed position is history, not coverage.
 * Chains are ordered by size then name so the answer is stable between runs,
 * and every chain present in the book gets a row even when all of its counts
 * are zero — an absent row would read as "no holdings", not "nothing unpriced".
 */
export function coverageByChain(rows: HoldingIdentityRow[]): CoverageReport {
  const open = (Array.isArray(rows) ? rows : []).filter(isOpen)
  const byChain = new Map<string, ChainCoverage>()
  const totals: CoverageTotals = {
    chains: 0, total: 0, priced: 0, unpriced: 0, stale: 0, estimated: 0,
    resolvable: 0, unsupported: 0, missingContract: 0,
  }

  for (const row of open) {
    const chain = normalizeChain(row.chain)
    const platform = cmcPlatformForChain(chain)
    let entry = byChain.get(chain)
    if (!entry) {
      entry = {
        chain, supported: !!platform, total: 0, priced: 0, unpriced: 0, stale: 0,
        estimated: 0, resolvable: 0,
        reason: platform ? null : 'unsupported_platform',
      }
      byChain.set(chain, entry)
    }
    entry.total++
    totals.total++
    const status = typeof row.price_status === 'string' ? row.price_status : ''
    if (status === 'priced') { entry.priced++; totals.priced++ }
    else if (status === 'stale') { entry.stale++; totals.stale++ }
    else if (status === 'estimated') { entry.estimated++; totals.estimated++ }
    else { entry.unpriced++; totals.unpriced++ }

    const subject = subjectOf(row)
    if (subject) { entry.resolvable++; totals.resolvable++ }
    // Why an unpriced holding cannot be asked about is the actionable fact.
    if (status === 'unpriced' || status === 'stale') {
      if (!platform) totals.unsupported++
      else if (!subject) totals.missingContract++
    }
  }

  const chains = [...byChain.values()].sort((a, b) => b.total - a.total || a.chain.localeCompare(b.chain))
  totals.chains = chains.length
  return { chains, totals }
}

/**
 * Group the open unpriced/stale holdings into the two batch calls.
 *
 * Several holdings (different portfolios, different wallets) can point at the
 * same contract; the provider is asked ONCE per contract and the answer fans
 * back out to every holding that shares it. Subjects are sorted so the same book
 * produces the same request, which is what makes the transport's shared cache
 * key reusable across runs.
 */
export function planHoldingResolution(
  rows: HoldingIdentityRow[],
  options: { limit?: number } = {},
): HoldingResolutionPlan {
  const requestedLimit = finite(options.limit)
  const limit = requestedLimit == null || requestedLimit < 1
    ? HOLDING_RUN_LIMIT_DEFAULT
    : Math.min(Math.floor(requestedLimit), HOLDING_RUN_LIMIT_MAX)

  const eligible = (Array.isArray(rows) ? rows : []).filter((row) =>
    isOpen(row) && (RESOLVABLE_PRICE_STATUSES as readonly string[]).includes(String(row.price_status ?? '')))

  const skipped: SkippedHolding[] = []
  const unsupportedCounts = new Map<string, number>()
  const subjectMap = new Map<string, { subject: PlanSubject; rows: HoldingIdentityRow[] }>()

  for (const row of eligible) {
    const chain = normalizeChain(row.chain)
    const platform = cmcPlatformForChain(chain)
    if (!platform) {
      skipped.push({ holdingId: String(row.id), chain, reason: 'unsupported_platform' })
      unsupportedCounts.set(chain, (unsupportedCounts.get(chain) ?? 0) + 1)
      continue
    }
    const subject = subjectOf(row)
    if (!subject) {
      skipped.push({ holdingId: String(row.id), chain, reason: 'no_contract_address' })
      continue
    }
    const key = `${subject.platform}:${subject.address}`
    const existing = subjectMap.get(key)
    if (existing) { existing.subject.holdingIds.push(String(row.id)); existing.rows.push(row); continue }
    subjectMap.set(key, {
      subject: { platform: subject.platform, chain, address: subject.address, holdingIds: [String(row.id)] },
      rows: [row],
    })
  }

  const ordered = [...subjectMap.values()].sort((a, b) =>
    a.subject.platform.localeCompare(b.subject.platform) || a.subject.address.localeCompare(b.subject.address))
  const kept = ordered.slice(0, limit)
  const cut = ordered.slice(limit)
  for (const entry of cut) {
    for (const row of entry.rows) skipped.push({ holdingId: String(row.id), chain: entry.subject.chain, reason: 'over_run_limit' })
  }

  const holdings: PlannedHolding[] = []
  for (const entry of kept) {
    for (const row of entry.rows) {
      holdings.push({
        holdingId: String(row.id),
        chain: entry.subject.chain,
        platform: entry.subject.platform,
        address: entry.subject.address,
        quantity: finite(row.quantity),
        symbol: text(row.asset_symbol) ?? text(row.normalized_symbol),
        name: text(row.name),
        priceStatus: String(row.price_status ?? ''),
      })
    }
  }

  const subjects = kept.map((entry) => entry.subject)
  const byPlatform = new Map<string, string[]>()
  for (const subject of subjects) {
    const list = byPlatform.get(subject.platform) ?? []
    list.push(subject.address)
    byPlatform.set(subject.platform, list)
  }
  const batchGroups: { platform: string; addresses: string[] }[] = []
  for (const [platform, addresses] of [...byPlatform.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (let i = 0; i < addresses.length; i += HOLDING_BATCH_MAX) {
      batchGroups.push({ platform, addresses: addresses.slice(i, i + HOLDING_BATCH_MAX) })
    }
  }
  const priceGroups: { tokens: { platform: string; address: string }[] }[] = []
  for (let i = 0; i < subjects.length; i += HOLDING_BATCH_MAX) {
    priceGroups.push({ tokens: subjects.slice(i, i + HOLDING_BATCH_MAX).map((s) => ({ platform: s.platform, address: s.address })) })
  }

  return {
    subjects,
    batchGroups,
    priceGroups,
    holdings,
    skipped,
    unsupported: [...unsupportedCounts.entries()].map(([chain, count]) => ({ chain, count }))
      .sort((a, b) => b.count - a.count || a.chain.localeCompare(b.chain)),
    requested: holdings.length,
    limit,
    truncated: cut.length > 0,
    estimatedCredits: batchGroups.length + priceGroups.length,
  }
}

/** `{pid, addr|a, ...}` rows keyed by the canonical `platform:address` they are
 * about. A row whose platform id is not one of the four verified networks, or
 * whose address is not well-formed for it, describes nothing we asked about and
 * is dropped rather than matched by position. */
function indexProviderRows(rows: unknown, addressKey: 'addr' | 'a'): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  if (!Array.isArray(rows)) return out
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const network = CMC_DEX_NETWORKS.find((n) => n.platformId === record.pid)
    if (!network) continue
    const address = record[addressKey]
    if (typeof address !== 'string' || !cmcDexAddress(address, network.platform)) continue
    const key = `${network.platform}:${canonicalAddress(address, network.platform)}`
    if (!out.has(key)) out.set(key, record)
  }
  return out
}

/** A price is a finite, non-negative number. Null, an empty string, NaN and a
 * negative are all absence — and absence is never rendered as 0. */
function providerPrice(row: Record<string, unknown> | undefined): number | null {
  if (!row || row.p == null) return null
  const price = cmcDexNumber(row.p)
  return price != null && price >= 0 ? price : null
}

/** A non-negative finite magnitude, or null. A negative liquidity or market cap
 * is not a small one: it is an unusable answer, and unusable is absent. */
function magnitude(...values: unknown[]): number | null {
  for (const value of values) {
    if (value == null) continue
    const n = cmcDexNumber(value)
    if (n != null && n >= 0) return n
  }
  return null
}

/**
 * The plausibility gate. Returns the rule that refuses this price, or null when
 * the price may be written.
 *
 * Gate (a) runs first and on its own: without liquidity there is no market, and
 * the other two tests would be comparing one provider aggregate against another.
 */
export function implausibleRule(
  price: number,
  impliedValue: number | null,
  liquidityUsd: number | null,
  marketCapUsd: number | null,
  wasUnpriced: boolean,
): ImplausibleRule | null {
  if (liquidityUsd == null) return 'liquidity_unknown'
  if (liquidityUsd < MIN_POOL_LIQUIDITY_USD) return 'liquidity_below_floor'
  if (impliedValue == null) return null
  // A holding cannot be worth more than the whole token. A market cap of 0 is
  // not a ceiling, it is another absence, so it does not refuse on its own.
  if (marketCapUsd != null && marketCapUsd > 0 && impliedValue > marketCapUsd) return 'value_exceeds_market_cap'
  if (wasUnpriced && impliedValue > MAX_FIRST_PRICE_VALUE_USD) return 'value_exceeds_first_price_ceiling'
  return null
}

/**
 * Fold the two batch answers back onto every holding in the plan, including the
 * ones the plan could not ask about, so the caller gets one row per holding and
 * never has to infer silence.
 *
 * `batchRows` is the bare `data` array of `/v1/dex/tokens/batch-query`
 * (`{pid, addr, n, sym, p, ...}`) and `priceRows` the bare `data` array of
 * `/v1/dex/token/price/batch` (`{pid, a, p, n, sym, ...}`).
 */
export function applyBatchAnswers(
  plan: HoldingResolutionPlan,
  batchRows: unknown,
  priceRows: unknown,
): HoldingAnswer[] {
  const batch = indexProviderRows(batchRows, 'addr')
  const prices = indexProviderRows(priceRows, 'a')
  const answers: HoldingAnswer[] = []

  for (const holding of plan.holdings) {
    const key = `${holding.platform}:${holding.address}`
    const identity = batch.get(key)
    const quote = prices.get(key)
    const matched = !!identity || !!quote
    // The price batch is the price question; the identity batch carries a price
    // of its own, which is used only when the price batch said nothing at all.
    const quotePrice = providerPrice(quote)
    const identityPrice = providerPrice(identity)
    const price = quotePrice ?? identityPrice
    const priceFrom = quotePrice != null ? 'dexPriceBatch' as const : identityPrice != null ? 'dexBatch' as const : null
    // Liquidity and market cap are stated by the identity batch (`liqUsd`,
    // `mcap`) and, for the price batch, by `l` and `mc`. Either source counts;
    // neither is inferred from the other.
    const liquidityUsd = matched ? magnitude(identity?.liqUsd, quote?.l) : null
    const marketCapUsd = matched ? magnitude(identity?.mcap, quote?.mc) : null
    const impliedValue = price != null && holding.quantity != null ? holding.quantity * price : null
    const rule = price == null ? null
      : implausibleRule(price, impliedValue, liquidityUsd, marketCapUsd, holding.priceStatus === 'unpriced')
    answers.push({
      holdingId: holding.holdingId,
      chain: holding.chain,
      platform: holding.platform,
      address: holding.address,
      matched,
      symbol: text(identity?.sym) ?? text(quote?.sym),
      name: text(identity?.n) ?? text(quote?.n),
      cmcDexPrice: price,
      priceFrom,
      quantity: holding.quantity,
      // A refused value is never presented as the holding's value.
      value: rule ? null : impliedValue,
      liquidityUsd,
      marketCapUsd,
      implausible: rule && price != null ? { price, liquidityUsd, marketCapUsd, impliedValue, rule } : null,
      reason: !matched ? 'not_found_on_provider'
        : price == null ? 'price_unavailable'
        : rule ? 'price_implausible'
        : 'priced',
    })
  }

  for (const skip of plan.skipped) {
    answers.push({
      holdingId: skip.holdingId,
      chain: skip.chain,
      platform: cmcPlatformForChain(skip.chain) ?? skip.chain,
      address: '',
      matched: false,
      symbol: null,
      name: null,
      cmcDexPrice: null,
      priceFrom: null,
      quantity: null,
      value: null,
      liquidityUsd: null,
      marketCapUsd: null,
      implausible: null,
      reason: skip.reason,
    })
  }

  return answers
}

/** Counts for the response envelope. Derived here so the Edge Function and its
 * tests cannot drift into two different definitions of "matched". */
export function summarizeAnswers(answers: HoldingAnswer[]): {
  matched: number; priced: number; identityOnly: number; implausible: number; notFound: number; unsupported: number; missingContract: number; overLimit: number
} {
  const count = (reason: AnswerReason) => answers.filter((a) => a.reason === reason).length
  return {
    matched: answers.filter((a) => a.matched).length,
    priced: count('priced'),
    identityOnly: count('price_unavailable'),
    implausible: count('price_implausible'),
    notFound: count('not_found_on_provider'),
    unsupported: count('unsupported_platform'),
    missingContract: count('no_contract_address'),
    overLimit: count('over_run_limit'),
  }
}
