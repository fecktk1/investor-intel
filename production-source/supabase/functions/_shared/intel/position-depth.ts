import {finite,instant} from './investigation-evidence.ts'
import type {DepthSnapshot} from './investigation-calculations.ts'
/** Reuse stored best-level quantities. Summarized USD depth is never expanded into invented price levels. */
export function positionDepthQuotes(asset:any,verified:boolean,books:any[],tickers:any[],now=Date.now()){
 if(!verified||!asset?.source_provider||!asset?.provider_id)return []
 const subject=`market:${asset.source_provider}:${asset.provider_id}`
 return books.slice(0,8).flatMap(book=>{
  const ticker=tickers.find(t=>t.provider===book.provider&&t.provider_symbol===book.provider_symbol),observed=instant(book.as_of),bid=finite(book.bid_price),ask=finite(book.ask_price)
  if(!ticker||ticker.quote_asset!=='USD'||observed==null||observed>now||now-observed>60000||bid==null||ask==null||bid<=0||ask<bid)return []
  return (['buy','sell'] as const).flatMap(side=>{const price=finite(side==='buy'?book.ask_price:book.bid_price),quantity=finite(side==='buy'?book.ask_qty:book.bid_qty)
   if(price==null||price<=0||quantity==null||quantity<0)return []
   const snapshot:DepthSnapshot={subject,side,observedAt:book.as_of,expiresAt:new Date(observed+60000).toISOString(),currency:'USD',verifiedQuote:true,feeBps:null,levels:[{price,quantity}],sourceRef:`${book.provider}:${book.provider_symbol}:${book.as_of}`}
   return [{...snapshot,recordedAt:instant(book.updated_at)!=null?book.updated_at:null,venue:book.provider,pair:book.provider_symbol,coverage:'Recorded best price and quantity only; deeper levels and fees are unavailable.'}]
  })
 })
}
