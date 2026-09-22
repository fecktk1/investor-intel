// CSV columns for the tokenised-asset depth board.
//
// Handed to `downloadTableCsv` in table-csv.js, which blanks every `cmcRaw`
// column unless the read's `sourcePolicy.exportAllowed` is true. The rule for
// marking a column:
//   cmcRaw: true   a USD figure CoinMarketCap reported: pool liquidity and pool
//                  volume from its DEX endpoints, the token's all-venue volume,
//                  market cap and tokenised value from its RWA endpoints.
//   (unmarked)     identities, states, reasons, counts, timestamps, and every
//                  figure WE derived: concentration and the exit simulator's days
//                  and pool share.
// The 1 and 5 percent sizes are ours, but each is a provider USD figure times a
// constant, so exporting one would export the figure itself: they are cmcRaw.
//
// Every row carries its own capture time and source, so a row read on its own in
// a spreadsheet still says when and where it came from.
import { rowExitScenarios } from './rwa-exit-capacity'

const list = value => (Array.isArray(value) ? value.join('; ') : '')
const size = (row, pct) => (row?.exitability || []).find(entry => entry?.pct === pct)?.usd ?? null
/** The counted figure on a classified row; the provider's own on a row captured
 * before the counter legs were recorded, which `classification` says. */
const liquidity = row => (row?.classification === 'unclassified' ? row?.totalLiquidityUsd : row?.countedLiquidityUsd) ?? null

export const DEPTH_CSV_COLUMNS = [
  { key: 'token_key', label: 'token_key', value: row => row?.tokenKey ?? null },
  { key: 'crypto_id', label: 'cmc_id', value: row => row?.cryptoId ?? null },
  { key: 'symbol', label: 'symbol', value: row => row?.symbol ?? null },
  { key: 'token_name', label: 'token_name', value: row => row?.tokenName ?? null },
  { key: 'rwa_name', label: 'underlying', value: row => row?.rwaName ?? null },
  { key: 'asset_type', label: 'asset_type', value: row => row?.assetType ?? null },
  { key: 'issuer_name', label: 'issuer', value: row => row?.issuerName ?? null },
  { key: 'underlying_value_usd', label: 'underlying_tokenised_value_usd', cmcRaw: true, value: row => row?.underlyingValueUsd ?? null },
  { key: 'token_market_cap', label: 'token_market_cap_usd', cmcRaw: true, value: row => row?.tokenMarketCap ?? null },
  { key: 'depth_state', label: 'depth_state', value: row => row?.state ?? null },
  { key: 'classification', label: 'counter_leg_classification', value: row => row?.classification ?? null },
  { key: 'only_unrecognised', label: 'only_unrecognised_pools', value: row => (row?.onlyUnrecognised ? 'true' : 'false') },
  { key: 'chains_read', label: 'chains_read', value: row => list(row?.chainsRead) },
  { key: 'chains_not_covered', label: 'chains_not_covered', value: row => list(row?.chainsNotCovered) },
  { key: 'counted_pools', label: 'pools_counted', value: row => (row?.classification === 'unclassified' ? row?.poolCount : row?.countedPools) ?? null },
  { key: 'unrecognised_pools', label: 'pools_not_counted', value: row => row?.unrecognisedPoolCount ?? null },
  { key: 'sellable_liquidity_usd', label: 'sellable_liquidity_usd', cmcRaw: true, value: liquidity },
  { key: 'counted_volume_24h_usd', label: 'counted_pool_volume_24h_usd', cmcRaw: true, value: row => row?.countedVolume24hUsd ?? null },
  { key: 'reported_liquidity_usd', label: 'provider_total_liquidity_usd', cmcRaw: true, value: row => row?.totalLiquidityUsd ?? null },
  { key: 'unrecognised_liquidity_usd', label: 'not_counted_liquidity_usd', cmcRaw: true, value: row => row?.unrecognisedLiquidityUsd ?? null },
  { key: 'exit_liquidity_usd', label: 'quote_side_liquidity_usd', cmcRaw: true, value: row => row?.exitLiquidityUsd ?? null },
  { key: 'deepest_pool_pair', label: 'deepest_counted_pair', value: row => row?.deepestPool?.pair ?? null },
  { key: 'deepest_pool_dex', label: 'deepest_counted_dex', value: row => row?.deepestPool?.dex ?? null },
  { key: 'deepest_pool_chain', label: 'deepest_counted_chain', value: row => row?.deepestPool?.chain ?? null },
  { key: 'deepest_pool_address', label: 'deepest_counted_address', value: row => row?.deepestPool?.address ?? null },
  { key: 'deepest_liquidity_usd', label: 'deepest_counted_liquidity_usd', cmcRaw: true, value: row => row?.deepestPool?.liquidityUsd ?? null },
  { key: 'concentration_pct', label: 'share_in_deepest_pct', value: row => row?.concentrationPct ?? null },
  { key: 'size_1pct_usd', label: 'one_pct_of_deepest_usd', cmcRaw: true, value: row => size(row, 1) },
  { key: 'size_5pct_usd', label: 'five_pct_of_deepest_usd', cmcRaw: true, value: row => size(row, 5) },
  { key: 'holder_count', label: 'holder_accounts', value: row => row?.holderCount ?? null },
  { key: 'holder_chain', label: 'holder_chain', value: row => row?.holderChain ?? null },
  { key: 'provider_volume_24h_usd', label: 'all_venue_volume_24h_usd', cmcRaw: true, value: row => row?.providerVolume24hUsd ?? null },
  { key: 'provider_volume_captured_at', label: 'all_venue_volume_captured_at', value: row => row?.providerVolumeCapturedAt ?? null },
  { key: 'captured_at', label: 'captured_at', value: row => row?.capturedAt ?? null },
  { key: 'source', label: 'source', value: () => 'CoinMarketCap' },
]

/**
 * The board's columns plus the simulator's, for the inputs on screen when the
 * link was pressed. The inputs are written onto every row so the derived days
 * can be reproduced from the file alone. The days and the pool share are our
 * figures, but together with the inputs on the same row they give the provider
 * volume and liquidity back by simple division, so they are `cmcRaw` too: when
 * export is not allowed they are blank with the figures they came from. The
 * reasons a scenario is unavailable are ours alone and always export.
 */
export function depthCsvColumns(inputs = {}) {
  const scenario = (row, name) => rowExitScenarios(row, inputs)[name]
  return [
    ...DEPTH_CSV_COLUMNS,
    { key: 'sim_position_usd', label: 'sim_position_usd', value: () => inputs.positionUsd ?? null },
    { key: 'sim_participation_pct', label: 'sim_participation_pct', value: () => inputs.participationPct ?? null },
    { key: 'sim_haircut_pct', label: 'sim_haircut_pct', value: () => inputs.haircutPct ?? null },
    { key: 'days_to_exit_recognised_pools', label: 'days_to_exit_recognised_pools', cmcRaw: true, value: row => scenario(row, 'recognised_pools').days },
    { key: 'days_to_exit_recognised_pools_unavailable', label: 'days_to_exit_recognised_pools_unavailable', value: row => scenario(row, 'recognised_pools').unavailable },
    { key: 'days_to_exit_all_venues', label: 'days_to_exit_all_venues', cmcRaw: true, value: row => scenario(row, 'all_venues').days },
    { key: 'days_to_exit_all_venues_unavailable', label: 'days_to_exit_all_venues_unavailable', value: row => { const s = scenario(row, 'all_venues'); return s.volumeReason || s.unavailable } },
    { key: 'position_pct_of_recognised_pools', label: 'size_relative_to_recognised_pools_pct', cmcRaw: true, value: row => scenario(row, 'recognised_pools').positionPctOfPool },
  ]
}
