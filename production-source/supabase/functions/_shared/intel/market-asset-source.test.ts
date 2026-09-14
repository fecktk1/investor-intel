import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {marketCmcIdentity,assetMarketRead,chooseMarketCandles} from './market-asset-source.ts'
const eth={source_provider:'coingecko',provider_id:'ethereum',primary_chain:'taiko',name:'Ethereum',current_price:10,market_cap:1000,image_url:'https://old.example/logo.png'}
const cmc={source_provider:'coinmarketcap',provider_id:'1027',current_price:11,market_cap:2000,volume_24h:500,image_url:'https://s2.coinmarketcap.com/static/img/coins/64x64/1027.png',as_of:'2026-09-10T18:20:00Z'}
Deno.test('CMC mapping requires a provider ID; wrapped ETH and duplicate tickers never become native ETH',()=>{eq(marketCmcIdentity(eth),'1027');eq(marketCmcIdentity({symbol:'ETH',provider_id:'wrapped-ether',source_provider:'coingecko'}),null);eq(marketCmcIdentity({symbol:'ETH'}),null);eq(marketCmcIdentity({source_provider:'coinmarketcap',provider_id:'50000'}),'50000')})
Deno.test('CMC quote, volume, cap, logo and clocks remain one sourced record without changing research identity',()=>{const r=assetMarketRead(eth,cmc);eq(r.price,11);eq(r.marketCap.market_cap,2000);eq(r.marketCap.circulating_supply,null);eq(r.volume24h,500);eq(r.chain,'ethereum');eq(r.quoteProvider,'coinmarketcap');eq(r.asOf,cmc.as_of);eq(r.quoteRefreshSeconds,60);eq(eth.source_provider,'coingecko')})
Deno.test('wrong-ID or missing-price CMC evidence cannot replace an asset quote or retimestamp it',()=>{eq(assetMarketRead(eth,{...cmc,provider_id:'1'}).price,10);eq(assetMarketRead(eth,{...cmc,current_price:null}).quoteProvider,'coingecko');eq(assetMarketRead(eth,{...cmc,current_price:null}).asOf,null)})
Deno.test('CMC candles win before exchange candles and carry real volume unchanged',async()=>{let fallback=0;const data={candles:[{t:1000,o:1,h:3,l:1,c:2,v:20}],source:'coinmarketcap'};eq(await chooseMarketCandles(eth,async id=>{eq(id,'1027');return data},async()=>{fallback++;return {candles:[]}}),data);eq(fallback,0)})
Deno.test('fallback has an explicit reason and source, with no merged synthetic candles',async()=>{const r=await chooseMarketCandles(eth,async()=>({candles:[],sourceReason:'insufficient_entitlement'}),async()=>({candles:[{t:1000,c:2}],bestProvider:'kraken'}));eq(r.candles,[{t:1000,c:2}]);eq(r.fallbackReason,'insufficient_entitlement');eq(r.coverage.includes('kraken'),true)})
Deno.test('CMC-only assets and complete outages retain truthful missing history',async()=>{const r=await chooseMarketCandles({...cmc},async()=>({candles:[],sourceState:'unsupported',sourceReason:'insufficient_entitlement'}),async()=>({candles:[]}));eq(r.sourceState,'unsupported');eq(r.candles,[])})

Deno.test('reviewed USDC legacy ID uses CMC quote and OHLCV without treating a bridged ticker as the issuer asset',async()=>{
 const usdc={source_provider:'coingecko',provider_id:'usd-coin',symbol:'USDC'};eq(marketCmcIdentity(usdc),'3408');
 for(const id of ['bridged-usdc-base','usd-coin-ethereum-bridged','USDC','3408'])eq(marketCmcIdentity({...usdc,provider_id:id}),null);
 const candle={candles:[{t:1000,o:1,h:1.01,l:.99,c:1,v:10}],source:'coinmarketcap'};
 eq(await chooseMarketCandles(usdc,async id=>{eq(id,'3408');return candle},async()=>{throw Error('unexpected fallback')}),candle);
 eq(assetMarketRead(usdc,{source_provider:'coinmarketcap',provider_id:'3408',current_price:.9999}).quoteRefreshSeconds,300);
})
