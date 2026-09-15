import {cmcDexIdentity,cmcDexInteger,validateCmcDexResponse,cmcDexNetwork,CMC_DEX_NETWORKS,isDexDiscovery} from '../market-assets/cmc-dex.ts'
export function dexEvidenceRows(name:string,body:any,params:Record<string,string>) {
  if(isDexDiscovery(name)){
    if(!validateCmcDexResponse(name,body,params))return []
    const d=body.data,rows=name==='dexMeme'?['newCreations','aboutGraduates','graduates'].flatMap(k=>d[k]):d.leaderboardList
    return rows.map((r:any)=>{
      const network=CMC_DEX_NETWORKS.find(n=>n.platformId===r.pid)!,address=network.platform==='solana'?r.addr:r.addr.toLowerCase()
      return {subject:`${network.chain}:${address}`,metric:'price',value:r.p,unit:'USD',observed:cmcDexInteger(r.pt),metadata:{chain:network.platform,contract:address,scope:'CMC DEX token price',name:r.n}}
    })
  }
  const network=cmcDexNetwork(params.platform??params.platformName)
  const identity=network?cmcDexIdentity(`${network.chain}:${params.address??params.tokenAddress}`):null
  if(!identity||!validateCmcDexResponse(name,body,params))return []
  const d=body.data,rows:any[]=[]
  const add=(metric:string,value:unknown,unit:string,observed:unknown,metadata:Record<string,unknown>={},periodSeconds?:number)=>rows.push({subject:identity.subject,metric,value,unit,observed,metadata:{chain:identity.platform,contract:identity.address,...metadata},periodSeconds})
  // Count/security have no observation clock. Display as retrieved source
  // responses; do not make up an event or borrow the token price timestamp.
  if(name==='dexToken')add('price',d.p,'USD',cmcDexInteger(d.pt),{scope:'CMC DEX aggregated token price'})
  if(name==='dexHolderHistory')for(const r of d){
    const start=cmcDexInteger(r.ts),end=cmcDexInteger(r.endTs),count=cmcDexInteger(r.holders)
    if(start==null||end==null||end<start||count==null)continue
    add('holder_count',count,'accounts',end,{intervalStart:start,intervalEnd:end,population:'Provider-reported token holder accounts; not people.'},86400)
  }
  if(name==='dexLiquidityEvents')for(const r of d.lcs){
    if(typeof r.txn!=='string'||r.txn.length>200||r.lgid==null)continue
    add('liquidity_event_usd',r.tu,'USD',cmcDexInteger(r.ts),{eventType:typeof r.tp==='string'?r.tp:'Unclassified',venue:r.en??null,transaction:r.txn,logIndex:String(r.lgid),baseAddress:r.t0a,quoteAddress:r.t1a,baseQuantity:r.a0??null,quoteQuantity:r.a1??null,scope:'Reported pool liquidity activity; not a personal trade or executable order-book depth.'})
  }
  // Probed 2026-09-14: /v1/dex/holders/tag_count carries NO provider clock —
  // neither the rows nor the response say when the classification was computed.
  // `observed` is therefore null and the caller must stamp these rows with the
  // time it captured the response; a row dated by us is our capture time and has
  // to be labelled as such, never presented as a provider observation time.
  // (Rows with a null clock are dropped by normalizeCmcInvestigation until a
  // caller supplies one, which is the safe direction: no invented dates.)
  if(name==='dexHolderTags')for(const r of d.holders){
    const count=cmcDexInteger(r.hc)
    if(typeof r.tag!=='string'||count==null)continue
    add('holder_tag_count',count,'accounts',null,{tag:r.tag,balance:r.tb??null,ratio:r.hr??null,
      ratioUnit:'unknown',ratioUnitNote:'Provider-reported holding ratio; fraction versus percent requires explicit source confirmation.',
      population:'Provider-classified token holder addresses; not people. Undated by the provider: the clock is our capture time.'})
  }
  // dexCandles is deliberately absent. A k-line row is a provider aggregate over
  // a named period, not a fact observed at an instant, and an OHLC close is not
  // the same quantity as the `price` metric this file already records from
  // dexToken and discovery. Admitting a candle close would put two differently
  // dated and differently derived price series under one subject and metric.
  // Candles reach the app through cmcRows('dexCandles') and the chart lane, where
  // cmcObservedAt keeps their own period clock.
  if(name==='dexSwaps')for(const r of d.swaps){
    add('swap_event_usd',r.v,'USD',cmcDexInteger(r.ts),{eventType:r.tp||'Unclassified',venue:r.en??null,transaction:r.tx,logIndex:String(r.lgid),baseAddress:r.t0a,quoteAddress:r.t1a,baseQuantity:r.a0??null,quoteQuantity:r.a1??null,
      basePriceUsd:r.t0pu??null,quotePriceUsd:r.t1pu??null,excluded:r.ex===true,sourceExclusionType:r.txtp??null,
      scope:'Reported public swap; not a personal trade. Provider-reported leg prices are not executable quotes.'})
  }
  return rows
}
