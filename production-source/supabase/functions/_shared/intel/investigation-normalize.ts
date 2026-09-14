import { CMC_CAPABILITIES, cmcRows } from '../market-assets/cmc-capabilities.ts'
import { digest, finite, instant, stableJson, type Observation } from './investigation-evidence.ts'
import {dexEvidenceRows} from './cmc-dex-evidence.ts'
import {normalizeMarketSourceVersions} from './market-source-versions.ts'
export function cmcSubject(id:unknown) { const n=Number(id);return Number.isSafeInteger(n)&&n>0?`market:coinmarketcap:${n}`:null }
function timestamp(value:unknown) { const t=typeof value==='number'?value<1e12?value*1000:value:instant(value);return t==null?null:new Date(t).toISOString() }
const env=(key:string)=>{try{return (globalThis as any).Deno?.env?.get(key)??(globalThis as any).process?.env?.[key]}catch{return undefined}}
export function cmcHistoryPolicy(now:number, staleUntil:string,readEnv:(key:string)=>string|undefined=env) {
  const allowed=readEnv('CMC_ALLOW_HISTORICAL_RETENTION')==='true'
  const days=Math.max(1,Math.min(365,Number(readEnv('CMC_HISTORY_RETENTION_DAYS'))||30))
  const policyEnd=Date.parse(readEnv('CMC_SOURCE_POLICY_EXPIRES_AT')||''),until=Math.min(now+days*86400000,Number.isFinite(policyEnd)?policyEnd:Infinity)
  return {historical:allowed,retainUntil:allowed?new Date(until).toISOString():staleUntil,aiAllowed:readEnv('CMC_ALLOW_AI_PROCESSING')==='true',exportAllowed:readEnv('CMC_ALLOW_EXPORT')==='true'}
}
/** Schema-specific normalization, called once per successful shared refresh.
 * Never place endpoint status clocks into fields described as market time. */
export async function normalizeCmcInvestigation(name:string,body:any,params:Record<string,string>,fetchedAt:string,expiresAt:string,staleUntil:string,readEnv:(key:string)=>string|undefined=env) {
  const spec=CMC_CAPABILITIES[name], rows=cmcRows(name,body).rows, policy=cmcHistoryPolicy(Date.parse(fetchedAt),staleUntil,readEnv)
  const observations:Observation[]=[]
  const sourceRef=`coinmarketcap:${spec.path}:${stableJson(params)}`
  const derivativeSubject=cmcSubject(body.data?.crypto_id??params.crypto_id)
  const derivativeRows=name==='derivativePairs'?rows.filter(row=>derivativeSubject&&cmcSubject(row.market_pair_base?.crypto_id??row.market_pair_base?.id)===derivativeSubject&&row.market_id!=null).sort((a,b)=>String(a.market_id).localeCompare(String(b.market_id))||stableJson(a).localeCompare(stableJson(b))):[]
  // A response-level fingerprint keeps unchanged contracts attached to a new
  // snapshot when another contract changes. Fetch-only refreshes reuse history.
  const derivativeBatch=derivativeRows.length?await digest(stableJson({sourceRef,rows:derivativeRows,hasMore:body.data?.has_more??null})):null
  async function add(subject:string,metric:string,value:unknown,unit:string,observed:unknown,metadata:Record<string,unknown>={},universe?:string,periodSeconds?:number) {
    const observedAt=timestamp(observed);if(observedAt==null||Date.parse(observedAt)>Date.parse(fetchedAt)+300000)return
    // A quote keeps its identity when a shared batch is projected to one asset.
    // Ranking/category membership remains query-specific because its universe matters.
    const observationSourceRef=name==='quotes'?`coinmarketcap:${spec.path}:${stableJson({...params,id:subject.split(':').at(-1)})}`:
      name==='history'?`coinmarketcap:${spec.path}:${stableJson({id:subject.split(':').at(-1),convert:'USD'})}`:
      ['cmc100History','cmc20History','globalHistory'].includes(name)?`coinmarketcap:${spec.path}:${stableJson({interval:params.interval||'daily'})}`:
      ['dexLiquidityEvents','dexSwaps'].includes(name)?`coinmarketcap:${spec.path}:${stableJson({platform:params.platform,address:params.address,transaction:metadata.transaction,logIndex:metadata.logIndex})}`:
      name==='dexHolderHistory'?`coinmarketcap:${spec.path}:${stableJson({platform:params.platform,tokenAddress:params.tokenAddress,interval:params.interval||'1d'})}`:sourceRef
    const v=finite(value), key=await digest(stableJson({subject,metric,value:v,unit,observedAt,universe,periodSeconds,sourceRef:observationSourceRef,metadata}))
    observations.push({id:`cmc:${key}`,subject,metric,value:v,unit,provider:'coinmarketcap',sourceRef:observationSourceRef,
      sourceUrl:`https://coinmarketcap.com/api/documentation/pro-api-reference/${spec.feature==='rwa'?'real-world-assets':'endpoint-overview'}`,
      observedAt,recordedAt:fetchedAt,expiresAt,periodSeconds:periodSeconds??null,universe:universe??null,
      exportAllowed:policy.exportAllowed,aiAllowed:policy.aiAllowed,metadata})
  }
  if(name.startsWith('dex'))for(const r of dexEvidenceRows(name,body,params)){
    const population=`cmc:dex:${r.metadata.chain}:${r.metadata.contract}`
    const universe=['dexLiquidityEvents','dexSwaps'].includes(name)?`${population}:event:${r.metadata.transaction}:${r.metadata.logIndex}`:name==='dexHolderHistory'?`${population}:interval:${r.metadata.intervalStart}:${r.metadata.intervalEnd}`:population
    await add(r.subject,r.metric,r.value,r.unit,r.observed,r.metadata,universe,r.periodSeconds)
  }
  for(const [index,row] of rows.entries()) {
    const q=row.quote??{}, subject=cmcSubject(row.crypto_id??row.id)
    if(['cmc100History','cmc20History','cmc100','cmc20'].includes(name)){
      const indexId=name.includes('100')?'100':'20'
      await add(`index:coinmarketcap:${indexId}`,'index_level',row.value,'index_points',row.update_time??row.last_update,{name:`CMC ${indexId}`,reportedConstituents:Array.isArray(row.constituents)?row.constituents.length:null,basis:'Provider index level, not a token price'},`cmc:index:${indexId}`)
    }
    if(name==='globalHistory'){
      await add('macro:coinmarketcap:global','total_market_cap',q.total_market_cap,'USD',row.timestamp,{basis:'Covered aggregate market capitalisation'})
      await add('macro:coinmarketcap:global','btc_dominance',row.btc_dominance,'%',row.timestamp)
      await add('macro:coinmarketcap:global','eth_dominance',row.eth_dominance,'%',row.timestamp)
      await add('macro:coinmarketcap:global','volume_24h',q.total_volume_24h,'USD',q.timestamp??row.timestamp,{},undefined,86400)
    }
    if(name==='history'&&subject&&subject===cmcSubject(params.id))for(const point of (Array.isArray(row.quotes)?row.quotes:[]).slice(0,100)){
      const quote=point.quote?.USD??(Array.isArray(point.quote)?point.quote.find((q:any)=>q.symbol==='USD'||q.convert_id===2781):null)
      if(quote)await add(subject,'price',quote.price,'USD',quote.timestamp??point.timestamp,{name:row.name??null,basis:'Historical USD quote at its reported timestamp'})
    }
    if(subject && ['quotes','listings','newListings','trending','mostVisited','gainers','category'].includes(name)) {
      for(const [metric,field,unit,period] of [['price','price','USD',undefined],['market_cap','market_cap','USD',undefined],['volume_24h','volume_24h','USD',86400],['tvl','tvl','USD',undefined]] as const)
        await add(subject,metric,q[field],unit,q.last_updated??row.last_updated,{name:row.name??null},undefined,period)
      for(const [field,period]of [['percent_change_1h',3600],['percent_change_24h',86400],['percent_change_7d',604800]] as const)
        if(q[field]!=null)await add(subject,'price_change',q[field],'%',q.last_updated??row.last_updated,{name:row.name??null},undefined,period)
      if(q.volume_change_24h!=null)await add(subject,'volume_change',q.volume_change_24h,'%',q.last_updated??row.last_updated,{name:row.name??null},undefined,86400)
      if(['trending','mostVisited'].includes(name)) await add(subject,name==='trending'?'attention_rank':'visits_rank',Number(params.start??1)+index,'rank',body.status?.timestamp,{name:row.name??null,timeMeaning:'Rank position in the provider response snapshot'},`cmc:${name}:${params.time_period??'24h'}`)
    }
    if(name==='liquidationAssets' && subject) for(const [period,suffix] of [[3600,'1h'],[14400,'4h'],[86400,'24h']] as const)
      await add(subject,`liquidations_${suffix}`,q[`total_liquidations_${suffix}`],'USD',q.last_updated,{},'covered_derivatives',period)
    if(name==='derivativePairs') {
      const asset=cmcSubject(body.data?.crypto_id??params.crypto_id), base=cmcSubject(row.market_pair_base?.crypto_id??row.market_pair_base?.id)
      // A requested asset must be the contract base. Quote-leg appearances are
      // different exposure and cannot enter the covered-OI denominator.
      if(!asset||base!==asset||row.market_id==null)continue
      const quotedUsd=q.convert_symbol==='USD'||q.symbol==='USD'||Number(q.convert_id)===2781
      const reported=row.exchangeReportedQuote??{}
      await add(asset,'open_interest',quotedUsd?q.open_interest:null,'USD',q.last_updated,{contractId:String(row.market_id),venueId:String(row.exchange?.exchange_id??row.exchange?.id??''),venue:row.exchange?.name??row.exchange?.exchange_name??'Unknown venue',
        compatibleQuote:quotedUsd,excluded:row.outlier_detected===true||(Array.isArray(row.exclusions)?row.exclusions.length>0:!!row.exclusions),
        batchId:derivativeBatch,batchContractCount:derivativeRows.length,batchHasMore:typeof body.data?.has_more==='boolean'?body.data.has_more:null,
        fundingRateRaw:finite(reported.funding_rate),fundingPeriodSeconds:finite(reported.funding_interval_seconds),fundingUnit:'unknown',fundingUnitNote:'Provider-reported value; percent versus fraction and interval require explicit source confirmation'},`contract:${row.market_id}`)
    }
    if(name==='rwaQuotes' && Number.isSafeInteger(Number(row.rwa_id))) {
      const asset=`rwa:coinmarketcap:${row.rwa_id}`
      await add(asset,'tokenized_value',q.tokenized_market_cap??row.tokenized_market_cap,'USD',q.last_updated??row.last_updated,{name:row.name})
      await add(asset,'tokenized_price',q.average_tokenized_price??row.average_tokenized_price,'USD',q.last_updated??row.last_updated,{name:row.name,basis:'Average tokenized price, not underlying NAV'})
    }
  }
  const sourceRows=await normalizeMarketSourceVersions(name,body,params,{fetchedAt,expiresAt,observedAt:null,sourceUrl:`https://coinmarketcap.com/api/documentation/pro-api-reference/endpoint-overview`},policy)
  return {observations,rows:observations.map(o=>({...o,retainUntil:policy.retainUntil})),sourceRows,policy}
}
