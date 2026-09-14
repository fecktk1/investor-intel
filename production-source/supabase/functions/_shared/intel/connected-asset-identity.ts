import {researchIdentity,researchCmcId} from './research-identity.ts'
import {canonicalAssetKey} from '../investor-portfolio/canonical.ts'
import {marketIdentityChoices} from './market-read-quality.ts'
/** Reuse the chart's indexed, bounded and freshness-qualified catalog lookup.
 * A client hint or ticker cannot establish the market/contract relationship. */
export async function readConnectedAssetIdentity(db:any,key:string,selected?:string|null){
 const input=researchIdentity({canonicalKey:key}),direct=researchCmcId({canonicalKey:key})
 const base={requested:key,cmcId:direct,marketSubject:direct?`market:coinmarketcap:${direct}`:null,contractSubject:null as string|null,name:null as string|null,imageUrl:null as string|null,choices:[] as ReturnType<typeof marketIdentityChoices>,state:'unavailable',source:null as string|null}
 if(input.chain&&input.tokenAddress){
  const contractSubject=canonicalAssetKey(input.chain,input.tokenAddress)
  if(selected&&canonicalAssetKey(researchIdentity({canonicalKey:selected}).chain,researchIdentity({canonicalKey:selected}).tokenAddress)!==contractSubject)throw Error('invalid_network_identity')
  const response=await db.rpc('intel_cmc_contract_chart_identity',{p_chain:input.chain,p_address:input.tokenAddress})
  if(response.error||!Array.isArray(response.data))throw Error('asset_identity_read_failed')
  const rows=response.data
  if(rows.length!==1||!/^\d{1,12}$/.test(rows[0].provider_id)||Number(rows[0].provider_id)<=0)return {...base,contractSubject,state:rows.length>1?'ambiguous':'unavailable'}
  const row=rows[0]
  return {...base,cmcId:String(row.provider_id),marketSubject:`market:coinmarketcap:${row.provider_id}`,contractSubject,name:row.name,imageUrl:row.image_url,state:'verified',source:'intel_cmc_contract_chart_identity'}
 }
 if(!/^market:(coinmarketcap|coingecko):/.test(key))return {...base,state:direct?'verified':'unsupported'}
 const {data,error}=await db.from('market_assets').select('source_provider,provider_id,name,image_url,platforms').eq('source_provider',input.sourceProvider).eq('provider_id',input.providerId).maybeSingle()
 if(error)throw Error('asset_identity_read_failed')
 if(!data)return base
 const choices=marketIdentityChoices(data),chosen=selected?choices.find(c=>c.canonicalAssetKey===selected):choices.length===1?choices[0]:null
 if(selected&&!chosen)throw Error('invalid_network_identity')
 const contract=chosen?researchIdentity({canonicalKey:chosen.canonicalAssetKey}):null
 return {...base,contractSubject:contract?.tokenAddress?chosen!.canonicalAssetKey:null,name:data.name,imageUrl:data.image_url,choices,state:selected||choices.length===1||direct?'verified':choices.length>1?'selection_required':'unavailable',source:'market_assets'}
}
