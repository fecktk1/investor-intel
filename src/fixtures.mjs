// All values and named issuers below are synthetic demonstration data. No CMC
// response, customer record, wallet address or proprietary dataset is included.
export function candles(now=Date.now()) {
  const end=Math.floor(now/3600000)*3600000
  const price=i=>Number((3100+i*2.3+Math.sin(i/11)*95+Math.cos(i/4)*24).toFixed(2))
  return Array.from({length:169},(_,i)=>{const o=price(i-1),c=price(i);const t=end-(168-i)*3600000;return {t,closedAt:t,recordedAt:t,volumeKind:'period',volumeUnit:'USD',o,c,h:Number((Math.max(o,c)+12+Math.abs(Math.sin(i))*9).toFixed(2)),l:Number((Math.min(o,c)-11-Math.abs(Math.cos(i))*8).toFixed(2)),v:Math.round(1000000+Math.abs(Math.sin(i/4))*700000)}})
}
export function fixtureData(capability,params={}) {
  const now=new Date().toISOString(),issuer='a'.repeat(24),selected=Number(params.rwa_id||1)
  const rwa=[{rwa_id:1,name:'Example Treasury Basket',symbol:'DEMO-T',asset_type:'government_security',average_tokenized_price:101.42,tokenized_market_cap:240000000,tokenized_volume_24h:1240000,last_updated:now,issuer_id:issuer},{rwa_id:2,name:'Example Gold Note',symbol:'DEMO-G',asset_type:'commodity',average_tokenized_price:84.31,tokenized_market_cap:56000000,tokenized_volume_24h:820000,last_updated:now,issuer_id:issuer}]
  const rows={
    quotes:[{id:1027,name:'Ethereum',symbol:'ETH',quote:{price:candles().at(-1).c,percent_change_24h:2.4,market_cap:420000000000,last_updated:now}}],
    metadata:[{id:1027,name:'Ethereum',symbol:'ETH',description:'Fictional market values accompany this example research workflow. The asset identity is Ethereum; these prices are not a live quote.'}],
    ohlcv:[{id:1027,quotes:candles().map(c=>({time_close:new Date(c.t).toISOString(),quote:{USD:{open:c.o,high:c.h,low:c.l,close:c.c,volume:c.v}}}))}],
    history:[{id:1027,quotes:candles().map(c=>({timestamp:new Date(c.t).toISOString(),quote:{price:c.c}}))}],
    rwaList:rwa,rwaInfo:[{...rwa.find(r=>r.rwa_id===selected),description:'Synthetic instrument used to demonstrate issuer and underlying-asset research. Redemption rights and availability have not been verified.',tokens:[{name:'Example representation',network:'Demonstration network',token_address:'fixture-only'}]}],
    rwaQuotes:[rwa.find(r=>r.rwa_id===selected)],issuers:[{issuer_id:issuer,name:'Example Asset Issuer',asset_count:2}],issuer:[{issuer_id:issuer,name:'Example Asset Issuer',description:'A fictional issuer. No offering or investment recommendation.',rwa_assets:rwa}],
    derivativeExchanges:[{exchange_id:11,exchange_name:'Example North',quote:{derivative_volume:890000000,open_interest:1200000000}},{exchange_id:22,exchange_name:'Example East',quote:{derivative_volume:610000000,open_interest:830000000}}],
    derivativePairs:[{market_pair:'ETH/USD perpetual',exchange:{exchange_name:'Example North'},quote:{open_interest:340000000},exchangeReportedQuote:{funding_rate:0.0001,index_price:3200}},{market_pair:'ETH/USD perpetual',exchange:{exchange_name:'Example East'},quote:{open_interest:190000000},exchangeReportedQuote:{funding_rate:0.00008,index_price:3200}}],
    liquidations:[{time_period:'24h',total_liquidations:81000000,long_liquidations:57000000,short_liquidations:24000000}],
  }[capability]||[]
  return {version:1,capability,state:'fresh',fixture:true,data:{rows,total:rows.length,hasMore:false},reason:null,provenance:{provider:'fixture',observedAt:now,fetchedAt:now,expiresAt:null,sourceUrl:null}}
}
