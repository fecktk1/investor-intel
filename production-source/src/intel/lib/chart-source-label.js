// Display names for the price-series sources a chart can be drawn from.
//
// `coinmarketcap` and `coinmarketcap_kline` are DIFFERENT SOURCES and are named
// differently on purpose: the first is the listed-asset OHLCV series keyed by a
// CoinMarketCap id, the second is the contract k-line aggregate keyed by a
// contract address and covering every pool on the chain. `chartSeriesResponse`
// carries the value through as `source.provider`, and `bestProvider` on a market
// detail carries the same string. A reader who cannot tell the two apart cannot
// tell what the candles are of.
//
// An unknown provider is returned verbatim — inventing a prettier name for a
// source we do not recognise would be inventing a fact.
export const CHART_PROVIDER_LABELS = {
  coinmarketcap: 'CoinMarketCap',
  coinmarketcap_kline: 'CoinMarketCap k-line',
  coingecko: 'CoinGecko',
  geckoterminal: 'GeckoTerminal',
  birdeye: 'Birdeye',
}

export const chartProviderLabel = provider => CHART_PROVIDER_LABELS[provider] || provider || null
