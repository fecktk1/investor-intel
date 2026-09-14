const text=value=>typeof value==='string'&&value.length<=160?value:null
/** Market metadata is display context only. It never creates a holding, cost
 * basis or transaction. Accept it only for the exact requested chart identity. */
export function portfolioMarketDisplay(response,ref){
 if(!ref||response?.entity?.ref!==ref)return null
 return {entity:{symbol:text(response.entity.symbol),name:text(response.entity.name)},overview:response.overview||null}
}
export function portfolioAssetDisplay(holding,events,key,chartIdentity,market){
 const leg=(events||[]).flatMap(e=>e.lineItems||[]).find(l=>l.canonical_asset_key===key)
 return {symbol:String(holding?.asset_symbol||holding?.normalized_symbol||leg?.symbol||market?.entity?.symbol||'').toUpperCase(),
  name:holding?.name||leg?.name||market?.entity?.name||null,logo:holding?.logo_url||leg?.logo_url||market?.overview?.image_url||null,
  chain:holding?.chain||leg?.chain||chartIdentity?.chain||null}
}
