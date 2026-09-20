// Shared readings for the tokenised-asset depth surfaces.
//
// It lives in lib rather than in the board component because the asset page's
// block needs the same words and must not drag the chart kit onto a route that
// draws no chart.
//
// Every function here formats or explains a figure the capture already stored.
// Nothing here computes a new one: concentration and the exitability sizes are
// derived on the SERVER (capture-rwa-depth-read.ts) so the method lives in one
// place and a client cache can never hold a stale derivation.
import { formatUsd } from './market-format'

export const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** A share of 0 is a measurement; only null is unknown. */
export const pctLabel = value => (num(value) == null ? '—' : `${num(value).toFixed(1)}%`)

/** A liquidity figure of 0 is a real and alarming answer and prints as $0. */
export const usdLabel = value => (num(value) == null ? '—' : formatUsd(num(value)))

/**
 * The one-line reading for a row, as words rather than a state code.
 *
 * `pools_read` gets the exitability sentence, which is the point of the surface.
 * Every other state gets the sentence for itself, and the two "we looked and
 * found nothing" states interpolate the chains that were read: "no pool" without
 * them is not a claim a reader can check.
 */
export function readingText(row, t) {
  const chains = (row?.chainsRead || []).join(', ')
  const notCovered = (row?.chainsNotCovered || []).join(', ')
  if (row?.state === 'pools_read') {
    // A token whose ONLY pools are ones we cannot value has its own sentence. It
    // is not "no pool": there ARE pools, and there is nowhere to sell into.
    if (row?.onlyUnrecognised) {
      return t('rwa_depth.reading_only_unrecognised', {
        count: row?.unrecognisedPoolCount ?? 0, chains,
        defaultValue: 'We read {{chains}} and found {{count}} pools, and the other side of every one of them is a token we cannot value. There is nowhere here to take a known asset out, which is not the same as there being no pool.',
      })
    }
    // A capture taken before the lane recorded the pool legs' addresses. Saying
    // so is the honest answer; guessing from the pair label would be the same
    // defect in a new place, because a token can choose its own symbol.
    if (row?.classification === 'unclassified') {
      return t('rwa_depth.reading_unclassified', {
        chains,
        defaultValue: 'Pools were found on {{chains}}, but this capture predates the record of what is on the other side of each one, so the liquidity beside it is CoinMarketCap\'s figure over all of them. The next daily run separates the pools a seller could actually use.',
      })
    }
    const one = (row?.exitability || []).find(size => size?.pct === 1)
    const five = (row?.exitability || []).find(size => size?.pct === 5)
    if (!one || !five) {
      return t('rwa_depth.reading_pools_no_size', { defaultValue: 'Pools were found, but none of them reported a liquidity figure, so there is no size to compare against.' })
    }
    return t('rwa_depth.reading_exitability', {
      one: usdLabel(one.usd), five: usdLabel(five.usd),
      defaultValue: 'Our calculation: {{one}} is one percent and {{five}} is five percent of the deepest pool. Above that a sale is large relative to that one pool.',
    })
  }
  if (row?.state === 'issuer_redemption_only') {
    return t('rwa_depth.reading_redemption', { chains, defaultValue: 'No public pool on {{chains}}, and the verified contract source shows permissioned transfers. This is redeemed with the issuer rather than traded in a pool.' })
  }
  if (row?.state === 'no_pool_on_read_chains') {
    return t('rwa_depth.reading_no_pool', { chains, defaultValue: 'We read {{chains}} and found no pool. Liquidity on centralised venues is not visible here.' })
  }
  if (row?.state === 'chain_not_covered') {
    return t('rwa_depth.reading_not_covered', { chains: notCovered, defaultValue: 'Deployed on {{chains}}, which CoinMarketCap publishes no DEX pool data for on this plan. Nothing is claimed about its depth.' })
  }
  if (row?.state === 'no_deployment_known') {
    return t('rwa_depth.reading_no_deployment', { defaultValue: 'No contract has been resolved for this token yet, so there is nowhere to read pools from.' })
  }
  if (row?.state === 'provider_unavailable') {
    return t('rwa_depth.reading_unavailable', { defaultValue: 'Every pool read for this token failed. Its depth is unknown, not thin.' })
  }
  return t('rwa_depth.reading_pending', { defaultValue: 'The daily read has not reached this token yet. Pending, not thin.' })
}

/**
 * Points for the liquidity-against-size figure.
 *
 * ONLY tokens with a liquidity reading are plotted, and the ones left out are
 * counted beside the chart: drawing a token with no pool at zero would put it on
 * the axis as though we had measured zero liquidity for it, and a log axis
 * cannot carry a zero anyway. The x axis is the token's OWN market cap from our
 * catalogue, not the underlying asset's tokenised float, so both axes describe
 * the same token.
 */
export function depthPoints(rows = []) {
  return rows
    .filter(row => row?.classification !== 'unclassified')
    .filter(row => (num(row?.countedLiquidityUsd) ?? 0) > 0 && (num(row?.tokenMarketCap) ?? 0) > 0)
    .map(row => ({
      key: row.tokenKey,
      label: String(row.symbol || row.tokenName || row.tokenKey),
      x: num(row.tokenMarketCap), y: num(row.countedLiquidityUsd),
    }))
}

/**
 * The excluded-pool line for one row, or null when nothing was excluded.
 *
 * It is a SENTENCE beside the figures, never a footnote: a reader who sees a
 * smaller liquidity number than CoinMarketCap shows has to be told what is
 * missing from it and why, in the same place.
 */
export function unrecognisedText(row, t) {
  if (row?.classification === 'unclassified') return null
  const count = num(row?.unrecognisedPoolCount) ?? 0
  if (count <= 0) return null
  return t('rwa_depth.unrecognised_summary', {
    count, value: usdLabel(row?.unrecognisedLiquidityUsd),
    defaultValue: '{{count}} more pools hold a reported {{value}} and are not in these figures: the other side of each is a token we cannot value.',
  })
}

/**
 * The exit-size line: the quote legs' OWN reported sizes. Null when the provider
 * reported none, which is common, and an absent figure is never drawn as zero.
 */
export function exitLiquidityText(row, t) {
  const usd = num(row?.exitLiquidityUsd)
  const pools = num(row?.exitLiquidityPools) ?? 0
  if (usd == null || pools <= 0) return null
  return t('rwa_depth.exit_liquidity', {
    value: usdLabel(usd), count: pools,
    defaultValue: '{{value}} of that sits on the quote side of {{count}} pools, which is the side a seller receives. CoinMarketCap reports no size for the quote leg of the others, so this is a floor and not a capacity.',
  })
}

/** The asset page for a row, when CoinMarketCap names the token. A pinned
 * contract with no provider id has no asset page and is printed as plain text. */
export function assetHref(row) {
  if (!row?.cryptoId || !row?.symbol) return null
  return `/intel/markets/${encodeURIComponent(row.symbol)}?${new URLSearchParams({ provider: 'coinmarketcap', id: String(row.cryptoId) })}`
}
