/** Display/research freshness follows each source's documented cadence. Wallet
 * snapshot pricing may be daily; shared CMC/exchange quotes are not daily data. */
export function portfolioQuoteStatus(row:Record<string,any>,now=Date.now()):'priced'|'stale'|'unpriced' {
 const value=row.current_value??row.currentValue,price=row.current_price??row.currentPrice
 if(value==null||!Number.isFinite(Number(value))||price==null||!Number.isFinite(Number(price)))return 'unpriced'
 const observed=Date.parse(row.last_priced_at??row.lastPricedAt??'')
 const source=row.price_source??row.priceSource??''
 const context=row.market_context??row.marketContext??{}
 const declared=row.price_status??row.priceStatus
 if(declared==='stale'||declared==='unpriced'||!Number.isFinite(observed)||observed>now+30000)return 'stale'
 const maxAge=/^(coinmarketcap|cmc)(:|$)/i.test(source)?300000:source==='exchange_profile'?600000:30*3600000
 const expiry=Date.parse(context.priceExpiresAt??'')
 return now-observed>maxAge||(Number.isFinite(expiry)&&expiry<=now)?'stale':'priced'
}
