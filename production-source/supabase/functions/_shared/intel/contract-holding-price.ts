// Investor Intel — pricing a holding whose contract no catalogue lists.
//
// `intel-portfolio-identity` asks CoinMarketCap's DEX batch endpoints about the
// open unpriced holdings that sit on a verified DEX chain. That answers for the
// tokens CoinMarketCap indexes. A token it does not index — which is what a
// member's own Solana mint usually is — came back `not_found_on_provider` and
// the position stayed blank in the book, even though the asset page shows a
// price for exactly that mint seconds later from the free DEX readers.
//
// This is that same read, for holdings: `buildContractMarketAsset`, the one
// contract identity path the asset page uses, cached observation first and then
// the governed free DEX clients inside their own per-contract call budget. No
// CoinMarketCap credit is spent here at all.
//
// It is deliberately the same shape as the CoinMarketCap pass:
//   * the SAME plausibility gate (`implausibleRule`) refuses a price with no
//     liquidity, with liquidity under the floor, worth more than the whole
//     token, or over the first-pricing ceiling. A refused row is not written.
//   * the answering source and the observation time are stored with the price,
//     so the book can always say who said it and when.
//   * every write is undoable by `unprice`, under its own `price_source`.

import { buildContractMarketAsset, type ContractAssetDeps, type ContractMarketAsset } from './contract-market-asset.ts'
import { implausibleRule, type ImplausibleRule } from './holding-identity.ts'
import { CHAIN_PROVIDERS } from '../chains.ts'
import type { DegenCtx } from '../memecoin/http.ts'

/** `investor_portfolio_holdings.price_source` this pass writes, and the value
 *  `unprice` reverses. Distinct from `coinmarketcap_dex` so an undo never
 *  touches a price another path is responsible for. */
export const CONTRACT_DEX_PRICE_SOURCE = 'contract_dex'

/** Contracts one run may read. Each is at most three governed free-DEX calls
 *  inside `CONTRACT_BUDGET_MS`, so a run is bounded in calls and in time. */
export const CONTRACT_PRICE_MAX_CONTRACTS = 12

/** Wall clock one run may spend on this pass. A portfolio recompute must not
 *  wait on the long tail of a large book. */
export const CONTRACT_PRICE_BUDGET_MS = 20_000

export interface ContractPriceRequest {
  holdingId: string
  chain: string
  address: string
  quantity: number | null
  /** True when the holding had no price at all, which tightens the gate. */
  wasUnpriced: boolean
}

export type ContractPriceReason = 'priced' | 'price_unavailable' | 'price_implausible' | 'chain_not_supported' | 'over_run_limit'

export interface ContractPriceAnswer {
  holdingId: string
  chain: string
  address: string
  price: number | null
  value: number | null
  quantity: number | null
  symbol: string | null
  name: string | null
  /** The source that actually answered, as it is credited ('DEX Screener'). */
  sourceLabel: string | null
  /** The provider id behind that label, for `investor_portfolio_holdings.provider`. */
  provider: string | null
  liquidityUsd: number | null
  marketCapUsd: number | null
  observedAt: string | null
  implausible: { price: number; impliedValue: number | null; liquidityUsd: number | null; marketCapUsd: number | null; rule: ImplausibleRule } | null
  reason: ContractPriceReason
}

const num = (value: unknown): number | null => {
  const n = Number(value)
  return value == null || value === '' || !Number.isFinite(n) ? null : n
}

/** The reader that answered, named as it is credited. Taken from the row the
 *  contract identity built, never assumed from the chain. */
function answeringSource(asset: ContractMarketAsset): { provider: string | null; label: string | null } {
  const label = typeof asset?.source_label === 'string' && asset.source_label ? asset.source_label : null
  const available = (asset?.contract?.sources || []).find((source) => source.state === 'available')
  return { provider: available?.provider ?? null, label }
}

/**
 * Price the holdings a catalogue pass could not, contract by contract.
 *
 * Holdings that share a contract share one read: a book with the same mint in
 * two portfolios costs one lookup, not two. Nothing is written here — the caller
 * owns the writes, exactly as it does for the CoinMarketCap pass.
 */
export async function priceContractHoldings(
  // deno-lint-ignore no-explicit-any
  admin: any,
  requests: ContractPriceRequest[],
  ctx: DegenCtx = {},
  deps: ContractAssetDeps & { build?: typeof buildContractMarketAsset } = {},
): Promise<ContractPriceAnswer[]> {
  const now = deps.now || (() => Date.now())
  const deadline = now() + CONTRACT_PRICE_BUDGET_MS
  const build = deps.build || buildContractMarketAsset
  const answers: ContractPriceAnswer[] = []

  // One group per contract, in the order the holdings arrived, so the run limit
  // cuts the tail of the book rather than an arbitrary slice of it.
  const groups = new Map<string, ContractPriceRequest[]>()
  const unsupported: ContractPriceRequest[] = []
  for (const request of requests) {
    const chain = String(request.chain || '').trim().toLowerCase()
    const address = String(request.address || '').trim()
    if (!chain || !address || !CHAIN_PROVIDERS[chain]?.dexscreener) { unsupported.push(request); continue }
    const key = `${chain}:${address}`
    const group = groups.get(key)
    if (group) group.push(request)
    else groups.set(key, [request])
  }
  for (const request of unsupported) {
    answers.push(blank(request, 'chain_not_supported'))
  }

  let read = 0
  for (const [key, group] of groups) {
    const [chain, address] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    if (read >= CONTRACT_PRICE_MAX_CONTRACTS || now() >= deadline) {
      for (const request of group) answers.push(blank(request, 'over_run_limit'))
      continue
    }
    read += 1
    let asset: ContractMarketAsset | null = null
    try {
      asset = await build(admin, chain, address, { ...ctx, caller: ctx.caller ?? 'holding-contract-price', kind: 'request' }, deps)
    } catch {
      asset = null
    }
    const price = num(asset?.current_price)
    const liquidityUsd = num(asset?.contract?.liquidityUsd)
    const marketCapUsd = num(asset?.market_cap)
    const source = asset ? answeringSource(asset) : { provider: null, label: null }
    const observedAt = typeof asset?.as_of === 'string' ? asset.as_of : null
    const symbol = typeof asset?.symbol === 'string' ? asset.symbol : null
    const name = typeof asset?.name === 'string' ? asset.name : null

    for (const request of group) {
      const quantity = num(request.quantity)
      const base: ContractPriceAnswer = {
        holdingId: request.holdingId, chain, address, price: null, value: null, quantity,
        symbol, name, sourceLabel: source.label, provider: source.provider,
        liquidityUsd, marketCapUsd, observedAt, implausible: null, reason: 'price_unavailable',
      }
      if (price == null || price <= 0) { answers.push(base); continue }
      const impliedValue = quantity == null ? null : quantity * price
      const rule = implausibleRule(price, impliedValue, liquidityUsd, marketCapUsd, request.wasUnpriced)
      if (rule) {
        answers.push({ ...base, reason: 'price_implausible', implausible: { price, impliedValue, liquidityUsd, marketCapUsd, rule } })
        continue
      }
      answers.push({ ...base, price, value: impliedValue, reason: 'priced' })
    }
  }
  return answers
}

function blank(request: ContractPriceRequest, reason: ContractPriceReason): ContractPriceAnswer {
  return {
    holdingId: request.holdingId,
    chain: String(request.chain || '').trim().toLowerCase(),
    address: String(request.address || '').trim(),
    price: null, value: null, quantity: num(request.quantity), symbol: null, name: null,
    sourceLabel: null, provider: null, liquidityUsd: null, marketCapUsd: null,
    observedAt: null, implausible: null, reason,
  }
}

/** What `summarizeAnswers` does for the CoinMarketCap pass, for this one. */
export function summarizeContractPrices(answers: ContractPriceAnswer[]): {
  priced: number; implausible: number; unavailable: number; unsupported: number; deferred: number
} {
  return {
    priced: answers.filter((a) => a.reason === 'priced').length,
    implausible: answers.filter((a) => a.reason === 'price_implausible').length,
    unavailable: answers.filter((a) => a.reason === 'price_unavailable').length,
    unsupported: answers.filter((a) => a.reason === 'chain_not_supported').length,
    deferred: answers.filter((a) => a.reason === 'over_run_limit').length,
  }
}
