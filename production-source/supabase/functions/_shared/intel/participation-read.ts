import {CHAINS} from '../chains.ts'
import {finite,instant} from './investigation-evidence.ts'
export const reportedHolderCount=(value:unknown)=>{const n=finite(value);return n!=null&&Number.isSafeInteger(n)&&n>=0?n:null}
/** Older writers stored a derived sample size in raw_response.total as well.
 * Only new captures carrying this explicit basis can establish a reported total. */
export const reportedSnapshotHolderCount=(raw:any)=>raw?.holder_count_basis==='provider_reported_v2'?reportedHolderCount(raw.total):null
export function participationContract(ref:string){
 const evm=/^eip155:([1-9][0-9]*)(?:\/erc20:|:)(0x[a-f0-9]{40})$/i.exec(ref)
 if(evm){const chain=CHAINS.find(c=>c.evmChainId===Number(evm[1]));return chain?{chain:chain.id,address:evm[2].toLowerCase()}:null}
 const sol=/^solana:(?:mainnet\/spl:)?([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(ref)
 return sol?{chain:'solana',address:sol[1]}:null
}
/** Version 1 may have substituted sample size for holder count. Its top1 field
 * is sample-relative in both versions, and must not be compared with top10 supply %. */
export function participationRecord(row:any,subject:string){
 const providers=Array.isArray(row.source_providers)?[...row.source_providers].sort():[]
 const knownVersion=[1,2].includes(Number(row.score_version))
 // This table has no population identifier or original provider observation clock.
 // A matching provider name and scoring version alone cannot establish comparability.
 return {subject,provider:providers.join(',')||'unspecified',observedAt:row.computed_at,population:null,
  holderCount:Number(row.score_version)===2?reportedHolderCount(row.holder_count):null,top1Percent:null,top10Percent:finite(row.top10_pct),
  sampledTop1Percent:knownVersion?finite(row.top1_pct):null,sampledGini:knownVersion?finite(row.gini):null,
  uniqueTraders:null,traderPeriodSeconds:null,sourceRef:`holder_concentration_scores:${row.id||''}`,clockMeaning:'Computed from provider snapshots; original observation clock was not retained.',
  countReason:Number(row.score_version)!==2?'Total withheld: its recorded method does not establish a reported account count.':null}
}
export async function readParticipation(db:any,ref:string,at:number,from=at-90*86400000){
 const identity=participationContract(ref);if(!identity)return []
 let query=db.from('holder_concentration_scores').select('id,canonical_ref_key,top1_pct,top10_pct,gini,holder_count,source_providers,score_version,computed_at').eq('chain',identity.chain)
 // Exact EVM address matching must also find legacy checksum-case rows. Neither
 // address form permits pattern characters. Solana addresses remain case-sensitive.
 query=identity.chain==='solana'?query.eq('token_address',identity.address):query.ilike('token_address',identity.address)
 const {data,error}=await query.gte('computed_at',new Date(from).toISOString()).lte('computed_at',new Date(at).toISOString()).order('computed_at',{ascending:false}).limit(100)
 if(error||!Array.isArray(data))throw new Error('participation_unavailable')
 return data.filter((r:any)=>(instant(r.computed_at)??Infinity)<=at)
}
