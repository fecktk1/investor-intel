import {CMC_CAPABILITIES,planAllows} from './cmc-capabilities.ts'
import type {CmcOperatingSettings} from './cmc-operating-settings.ts'

// Scheduling floors are separate from freshness TTLs. A ten-minute refresh
// policy must never label a ten-minute-old two-minute observation as fresh.
const floors:Record<string,number>={
 category:3600,derivativePairs:300,exchangeDerivativePairs:300,
 liquidations:600,liquidationAssets:600,liquidationExchanges:600,
 dexToken:600,dexPools:900,dexLiquidityEvents:600,dexSwaps:600,
 dexHolderCount:3600,dexHolderHistory:86400,dexSecurity:86400,
 dexTrending:900,dexNew:900,dexMeme:900,dexGainers:900,
 globalHistory:3600,cmc100History:3600,cmc20History:3600,
}
export function connectedDemandEnabled(settings:CmcOperatingSettings,env:(key:string)=>string|undefined){
 const flags=[settings.CMC_CONNECTED_DEMAND_ENABLED,env('CMC_CONNECTED_DEMAND_ENABLED')]
 return flags.includes('true')&&!flags.some(v=>v!=null&&['false','0','off'].includes(v.toLowerCase()))
}
export function cmcDemandPolicy(name:string,params:Record<string,unknown>,plan:string,connected=false){
 const spec=CMC_CAPABILITIES[name]
 if(!spec||!planAllows(plan,spec.tier)||(!connected&&spec.demand===false))return null
 // A saved time window or pagination cursor is not a live subscription. Users
 // can explicitly request it again; the worker never walks or renews it.
 if(params.lastId||params.nextPageIndex||params.time_start||params.time_end||Number(params.start??1)>1)return null
 return {cadenceSeconds:Math.max(spec.ttl,connected?(floors[name]||0):0),
   demandSeconds:connected?180:1800,feature:spec.feature,selectedView:connected}
}
export function selectedCmcReadPolicy(names:string[],params:Record<string,unknown>,plan:string,connected:boolean){
 const eligible=connected&&names.length>0&&names.every(name=>cmcDemandPolicy(name,params,plan,true))
 return {enabled:Boolean(eligible),cacheReadSeconds:eligible?60:null,providerRefreshSeconds:eligible?Math.max(...names.map(name=>cmcDemandPolicy(name,params,plan,true)!.cadenceSeconds)):null}
}
