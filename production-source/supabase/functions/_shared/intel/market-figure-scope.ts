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

// ─── Non-CMC figures and the typed provenance envelope (Play 7) ──────────────
//
// The sentences above cover figures that became an investigation Observation
// through the CoinMarketCap normalizer. Figures on the market surfaces also come
// from Birdeye, public DEX sources, centralized exchange tickers, CoinGecko, the
// stored market catalogue, the capture tables and the curated news desk. Each of
// those carries a scope sentence here too, and a stable `scopeKey` so the app can
// render the sentence in the reader's language rather than only in English.

/** Freshness of a figure against the refresh limit that applies to it.
 *  'fresh'        a provider call answered this read.
 *  'cached'       a stored or shared copy answered it, inside its refresh limit.
 *  'stale'        a stored copy answered it, past its refresh limit.
 *  'unavailable'  nothing usable answered it.
 * `null` is allowed on an envelope and means the source reported no clock that
 * could be measured, which is different from any of the four states. */
export type FigureFreshness='fresh'|'cached'|'stale'|'unavailable'
export const FIGURE_FRESHNESS:readonly FigureFreshness[]=['fresh','cached','stale','unavailable']

const SOURCE_SCOPE:Record<string,string>={
 birdeye_price:'Birdeye on-chain USD figures at the time our shared cache captured them. Not an executable price and not a provider observation time.',
 birdeye_ohlcv:'Birdeye on-chain candles for this contract from a shared cache. Pool prices, not a fill anyone received.',
 dex_pool:'Figures for one DEX pool at its snapshot time. Not the depth available to a trade and not every pool for this token.',
 dex_ohlcv:'Candles for one DEX pool as a public source published them. Not every pool for this token and not an execution record.',
 exchange_ticker:'Latest ticker figures reported by covered centralized exchanges. Reported by venues, not independently verified, and not every venue.',
 exchange_ohlcv:'Candles from one covered centralized exchange pair. Reported by that venue and not the price on any other venue.',
 coingecko_price:'CoinGecko aggregated USD quote at its reported time. Not an executable price and not the quote of any one venue.',
 coingecko_ohlc:'CoinGecko observations at the provider spacing. Volume is not included and the spacing is not a candle width.',
 cmc_ohlcv:'CoinMarketCap completed OHLCV periods for this asset. Asset-level market data, not the price of any one pool or venue.',
 market_catalogue:'Stored market catalogue figures at their last refresh. Rankings, filters and counts describe that stored snapshot, not the market at this moment.',
 capture_record:'A recorded capture of provider figures at the stated capture time. Reading it made no new provider call and it is not a reading of the market now.',
 news_curated:'Stories selected and summarised by automated review inside their review window. A summary is not the source article and not a verified claim.',
 news_stored:'Stories recorded from followed and global sources, clustered and ranked by rules. A ranking is not a judgement of accuracy.',
 signals_stored:'Signals generated from stored sources and ranked for you when this view was read. A signal is a research prompt, not a recommendation.',
}
export const SOURCE_SCOPE_KEYS=Object.freeze(Object.keys(SOURCE_SCOPE))
/** The scope sentence for a non-CMC figure. An unknown key gets the generic
 * sentence rather than an invented one. */
export function sourceFigureScope(scopeKey:string):string {
 return SOURCE_SCOPE[scopeKey]??GENERIC
}

/** Age against a refresh limit. No clock gives null (unmeasurable), a clock in
 * the future is treated as unmeasurable rather than as fresh, and the limit is
 * the one the SOURCE is refreshed on, so 'stale' means overdue, not merely old. */
export function ageFreshness(fetchedAt:unknown,refreshSeconds:number|null|undefined,now=Date.now()):FigureFreshness|null {
 const at=typeof fetchedAt==='string'||typeof fetchedAt==='number'?Date.parse(String(fetchedAt)):NaN
 if(!Number.isFinite(at)||at>now+30_000)return null
 if(refreshSeconds==null||!Number.isFinite(Number(refreshSeconds))||Number(refreshSeconds)<=0)return null
 return now-at<=Number(refreshSeconds)*1000?'cached':'stale'
}

/** A figure served from a live read or from a stored copy. */
export interface MarketFigureEnvelope {kind:'live'|'stored';source:string;fetchedAt:string|null;freshness:FigureFreshness|null;scope:string;scopeKey:string|null}
/** Curated content inside its review window. */
export interface CuratedFigureEnvelope {kind:'curated';source:string;fetchedAt:string|null;staleAfter:string;freshness:'cached';scope:string;scopeKey:string|null}
/** Curated content past its review window, or with no window at all. A separate
 * kind, never a flag on the curated one, so a reader that only knows how to draw
 * 'curated' cannot draw this as current by forgetting to check a boolean. */
export interface StaleCuratedFigureEnvelope {kind:'curated_stale';source:string;fetchedAt:string|null;staleAfter:string|null;freshness:'stale';scope:string;scopeKey:string|null}
export type FigureEnvelope=MarketFigureEnvelope|CuratedFigureEnvelope|StaleCuratedFigureEnvelope

const isoOrNull=(value:unknown):string|null=>{
 if(value==null||value==='')return null
 const at=Date.parse(String(value));return Number.isFinite(at)?new Date(at).toISOString():null
}
/** A non-CMC scopeKey resolves to its sentence; anything else is taken as an
 * already-written sentence (a CMC figureScope/capabilityScope result). */
function scopeOf(scope:string):{scope:string;scopeKey:string|null} {
 return Object.hasOwn(SOURCE_SCOPE,scope)?{scope:SOURCE_SCOPE[scope],scopeKey:scope}:{scope:scope||GENERIC,scopeKey:null}
}
export function figureEnvelope(kind:'live'|'stored',source:string,fetchedAt:unknown,freshness:FigureFreshness|null,scope:string):MarketFigureEnvelope {
 return {kind,source,fetchedAt:isoOrNull(fetchedAt),freshness:freshness&&FIGURE_FRESHNESS.includes(freshness)?freshness:null,...scopeOf(scope)}
}
/** Curated content is 'curated' only while its review window is still open at
 * `now`. A missing, unreadable or passed window is 'curated_stale'. */
export function curatedEnvelope(source:string,fetchedAt:unknown,staleAfter:unknown,scope:string,now=Date.now()):CuratedFigureEnvelope|StaleCuratedFigureEnvelope {
 const until=isoOrNull(staleAfter),base={source,fetchedAt:isoOrNull(fetchedAt),...scopeOf(scope)}
 return until&&Date.parse(until)>now?{kind:'curated',...base,staleAfter:until,freshness:'cached'}:{kind:'curated_stale',...base,staleAfter:until,freshness:'stale'}
}
