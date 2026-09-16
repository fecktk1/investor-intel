/** One provenance envelope for every imported CMC figure.
 *
 * A scope string says what a figure does NOT mean. The sentences already existed
 * before this module, but they were optional and scattered across nine different
 * metadata keys (scope, basis, population, timeMeaning, coverage, note,
 * clockMeaning, ratioUnitNote, fundingUnitNote), so most imported figures carried
 * none at all. `withFigureScope` makes exactly one REQUIRED at the single choke
 * point where a CMC figure becomes an Observation.
 *
 * A row that already states its limits under ANY of those nine keys keeps that
 * exact existing wording: this never overwrites, re-words or duplicates a sentence
 * the producing module already chose. Only a row that states nothing is given the
 * sentence for its metric, so the wording below is reused verbatim from
 * cmc-dex-evidence.ts and investigation-normalize.ts wherever those files already
 * say it, and is newly written only for metrics that had no sentence anywhere. */
export const FIGURE_SCOPE_KEYS=['scope','basis','population','timeMeaning','coverage','note','clockMeaning','ratioUnitNote','fundingUnitNote'] as const
/** Keyed by the metric names normalizeCmcInvestigation actually emits. Metrics
 * absent here are the ones whose producer already supplies one of the nine keys
 * (dex price, holder_count, holder_tag_count, liquidity_event_usd, swap_event_usd,
 * index_level, total_market_cap, tokenized_price, open_interest, the rank metrics
 * and the history price), so they never reach this map. */
const SCOPE:Record<string,string>={
 price:'Provider-aggregated USD quote at its reported time. Not an executable price and not the quote of any one venue.',
 market_cap:'Provider-reported capitalisation derived from circulating supply. Not a valuation and not the cost of acquiring the asset.',
 volume_24h:'Provider-aggregated reported trading volume for the stated period. Venue self-reporting is not independently verified.',
 volume_change:'Provider-reported change in reported volume over the stated period. Venue self-reporting is not independently verified.',
 tvl:'Provider-reported total value locked. Not an audited balance and not a claim on any part of it.',
 price_change:'Provider-reported price change over the stated period. Past movement is not a forecast.',
 btc_dominance:'Share of the provider-covered market capitalisation. Coverage is the provider universe, not every asset that exists.',
 eth_dominance:'Share of the provider-covered market capitalisation. Coverage is the provider universe, not every asset that exists.',
 tokenized_value:'Provider-reported tokenized market value. Not underlying net asset value and not a redemption right.',
}
/** Liquidation metrics are per window (liquidations_1h/_4h/_24h) and share one sentence. */
const LIQUIDATIONS='Provider-reported liquidation flow across covered derivatives venues for the stated period. Not your positions and not an exhaustive market total.'
export function figureScope(metric:string):string {
 if(metric.startsWith('liquidations_'))return LIQUIDATIONS
 return SCOPE[metric]??GENERIC
}
const GENERIC='Provider-reported figure recorded as its source stated it. Retrieval identifies the response reviewed, not an independent verification of the value.'
/** The capability-level companion to figureScope: what a whole RESPONSE does not
 * mean. The call receipt shows this, because there the reader is looking at one
 * response rather than one figure. Keyed by the registry `feature` so a newly
 * registered capability is covered on the day it is added, with no second list to
 * keep in step. */
const FEATURE_SCOPE:Record<string,string>={
 market:'Provider-aggregated market figures. Not executable prices and not the quotes of any one venue.',
 metadata:'Provider reference data: identity and listing details only, with no market value implied.',
 history:'Provider-reported past observations at their own timestamps. Past movement is not a forecast.',
 regime:'Provider-computed market-wide indicators over its covered universe, not over every asset that exists.',
 rwa:'Provider-reported tokenized asset figures. Not underlying net asset value, ownership rights or a redemption entitlement.',
 structure:'Provider-reported venue and derivatives structure. Reported by venues, not independently verified, and not executable depth.',
 attention:'Provider attention and ranking signals. A rank is a position in the provider response, not an endorsement or a quality score.',
}
export function capabilityScope(feature:string|undefined|null):string {
 return (feature&&FEATURE_SCOPE[feature])||GENERIC
}
/** Returns metadata that is guaranteed to state the figure's limits. An existing
 * sentence under any of the nine keys wins; otherwise `scope` is added. */
export function withFigureScope<T extends Record<string,unknown>>(metric:string,metadata:T):T&{scope?:string} {
 return FIGURE_SCOPE_KEYS.some(k=>typeof metadata[k]==='string'&&(metadata[k] as string).trim().length>0)?metadata:{...metadata,scope:figureScope(metric)}
}
