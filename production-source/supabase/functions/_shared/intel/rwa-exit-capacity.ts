// Exit capacity for a tokenised asset, server side.
//
// A PORT, NOT A SECOND METHOD. The method lives in src/intel/lib/rwa-exit-capacity.js,
// which the depth board and the asset page call. Edge Functions are bundled from
// supabase/functions only, so the MCP server cannot import that file; this is the
// same arithmetic and the same unavailable reasons, and mcp-readings.test.ts runs
// both over the same cases and asserts they agree field for field. Change one,
// change the other, or that test fails.
//
//   perDayUsd         = participation x volume24hUsd x (1 - haircut)
//   days              = positionUsd / perDayUsd
//   positionPctOfPool = positionUsd / poolBaseUsd x 100
//   poolBaseUsd       = (exitLiquidityUsd ?? countedLiquidityUsd) x (1 - haircut)
//
// A TURNOVER reading and a SIZE RELATIVE TO RECOGNISED POOLS. Neither models price
// impact, and the second is never called slippage. Missing or zero volume gives
// `days: null` and a reason, never 0 days.

export const EXIT_SCENARIOS=['recognised_pools','all_venues'] as const

export interface ExitEstimate {
 days:number|null
 perDayUsd:number|null
 positionPctOfPool:number|null
 poolBaseUsd:number|null
 poolBasis:'exit_liquidity'|'counted_liquidity'|null
 formula:{positionUsd:number|null;participation:number|null;haircut:number|null;volumeUsd:number|null;perDayUsd?:number;days?:number}
 unavailable:string|null
 poolUnavailable:string|null
}

const num=(value:unknown):number|null => {
 if(value==null||value===''||typeof value==='boolean')return null
 const n=Number(value)
 return Number.isFinite(n)?n:null
}

/** Why a depth row cannot support an on-chain reading at all, or null. */
export function depthGate({state,classification,onlyUnrecognised}:{state?:unknown;classification?:unknown;onlyUnrecognised?:unknown}={}):string|null {
 if(state!=null&&state!=='pools_read')return `state_${state}`
 if(state==null)return 'state_unknown'
 if(classification==='unclassified')return 'counter_legs_unclassified'
 if(onlyUnrecognised)return 'only_unrecognised_pools'
 return null
}

function inputGate(positionUsd:number|null,participation:number|null,haircut:number|null):string|null {
 if(positionUsd==null||positionUsd<=0)return 'invalid_position'
 if(participation==null||participation<=0||participation>1)return 'invalid_participation'
 if(haircut==null||haircut<0||haircut>=1)return 'invalid_haircut'
 return null
}

/** One estimate. `participation` and `haircut` are FRACTIONS (0.1 is ten percent). */
export function exitEstimate({
 positionUsd,participation,haircut=0,volumeUsd,
 exitLiquidityUsd=null,countedLiquidityUsd=null,
 gate=null,gateVolume=true,
}:{
 positionUsd?:unknown;participation?:unknown;haircut?:unknown;volumeUsd?:unknown
 exitLiquidityUsd?:unknown;countedLiquidityUsd?:unknown;gate?:string|null;gateVolume?:boolean
}={}):ExitEstimate {
 const position=num(positionUsd)
 const share=num(participation)
 const cut=num(haircut??0)
 const volume=num(volumeUsd)
 const formula={positionUsd:position,participation:share,haircut:cut,volumeUsd:volume}
 const empty={days:null,perDayUsd:null,positionPctOfPool:null,poolBaseUsd:null,poolBasis:null,formula}

 const bad=inputGate(position,share,cut)
 if(bad)return {...empty,unavailable:bad,poolUnavailable:bad}

 const exitLiq=num(exitLiquidityUsd)
 const counted=num(countedLiquidityUsd)
 const basis:ExitEstimate['poolBasis']=exitLiq!=null&&exitLiq>0?'exit_liquidity':counted!=null&&counted>0?'counted_liquidity':null
 const poolBaseUsd=basis?(basis==='exit_liquidity'?exitLiq!:counted!)*(1-cut!):null
 const poolUnavailable=gate||(basis?null:'no_recognised_pool_size')
 const pool=poolUnavailable
  ?{positionPctOfPool:null,poolBaseUsd:null,poolBasis:null}
  :{positionPctOfPool:(position!/poolBaseUsd!)*100,poolBaseUsd,poolBasis:basis}

 const unavailable=(gateVolume&&gate)
  ||(volume==null?'volume_not_reported':volume<=0?'no_reported_trading':null)
 if(unavailable)return {...empty,...pool,unavailable,poolUnavailable}

 const perDayUsd=share!*volume!*(1-cut!)
 const days=position!/perDayUsd
 return {
  days,perDayUsd,...pool,
  formula:{...formula,perDayUsd,days},
  unavailable:null,poolUnavailable,
 }
}

/** Both scenarios for one depth row. `inputs` are in PERCENT as typed. */
export function rowExitScenarios(row:Record<string,unknown>|null|undefined,inputs:{positionUsd?:unknown;participationPct?:unknown;haircutPct?:unknown}={}) {
 const participation=num(inputs.participationPct)==null?null:num(inputs.participationPct)!/100
 const haircut=num(inputs.haircutPct??0)==null?null:num(inputs.haircutPct??0)!/100
 const gate=depthGate({state:row?.state,classification:row?.classification,onlyUnrecognised:row?.onlyUnrecognised})
 const common={
  positionUsd:inputs.positionUsd,participation,haircut,
  exitLiquidityUsd:row?.exitLiquidityUsd,countedLiquidityUsd:row?.countedLiquidityUsd,gate,
 }
 const allVenues=exitEstimate({...common,volumeUsd:row?.providerVolume24hUsd,gateVolume:false})
 return {
  recognised_pools:exitEstimate({...common,volumeUsd:row?.countedVolume24hUsd}),
  all_venues:{
   ...allVenues,
   volumeReason:allVenues.unavailable==='volume_not_reported'?((row?.providerVolumeReason as string|null|undefined)||null):null,
   volumeCapturedAt:(row?.providerVolumeCapturedAt as string|null|undefined)||null,
  },
 }
}
