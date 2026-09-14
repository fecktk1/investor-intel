import {getChain} from '../chains.ts'
import {loadCmcChart,CHART_WINDOWS} from './cmc-chart.ts'
import {resolveCmcAsset} from './cmc-asset-identity.ts'
import type {MarketAssetsContext} from '../market-assets/types.ts'

export function legacyChartRange(range:string|null,interval:string) {
  const selected=range??({'1H':'7D','4H':'1M','1D':'1M','1W':'1Y'} as Record<string,string>)[interval]
  if(!selected||!CHART_WINDOWS[selected])throw Error('invalid_chart_range')
  return selected
}

/** Query the shared indexed catalogue; no provider request or browser download. */
export async function cmcContractIdentity(admin:any,chain:string,address:string) {
  const network=getChain(chain)
  if(!network||typeof address!=='string'||!address||address.length>200)return {id:null,state:'unavailable',reason:'invalid_contract_identity'}
  const normalized=network.evmChainId!=null?address.toLowerCase():address
  const result=await admin.rpc('intel_cmc_contract_chart_identity',{p_chain:chain,p_address:normalized})
  if(result.error)return {id:null,state:'unavailable',reason:'catalog_unavailable'}
  const rows=Array.isArray(result.data)?result.data:[]
  if(rows.length!==1)return {id:null,state:'unavailable',reason:rows.length?'ambiguous_contract_identity':'missing_contract_coverage'}
  const id=String(rows[0].provider_id||'')
  if(!/^[1-9][0-9]{0,9}$/.test(id))return {id:null,state:'unavailable',reason:'invalid_cmc_identity'}
  return {id,state:'verified',reason:null}
}

export async function loadCmcContractChart(admin:any,chain:string,address:string,ref:string,range:string,interval:string,context:MarketAssetsContext,deps={identity:cmcContractIdentity,chart:loadCmcChart,asset:resolveCmcAsset}) {
  const identity=await deps.identity(admin,chain,address)
  if(!identity.id)return null
  const result=await deps.chart(admin,identity.id,range,interval,Date.now(),undefined,context)
  if(!result.candles.length)return null
  const resolved=await deps.asset(admin,identity.id,undefined,context),asset=resolved.data
  return {...result,timeframe:interval,entity:{symbol:asset?.symbol,name:asset?.name,ref,chain,contract_address:address},
    overview:asset?{price:asset.current_price,market_cap:asset.market_cap,volume_24h_usd:asset.volume_24h,price_change_24h_pct:asset.change_24h_pct,image_url:asset.image_url,source:'coinmarketcap',as_of:asset.as_of}:null,
    coverage:[result.coverage,'CMC asset-level market data; the selected chain and contract match the shared catalogue. This is not a pool execution price.'].filter(Boolean).join(' ')}
}
