import {digest,evidenceFingerprint,instant,makeResearchReceipt,safeSourceUrl,stableJson,validateReceipt,type Observation} from './investigation-evidence.ts'
import {BENCHMARKS} from './benchmark-comparison.ts'
/** Existing receipt contract, expanded source references for a series. The
 * content hash covers every original record hash; the existing materiality
 * fingerprint keeps its documented latest-evidence semantics. */
export async function makeBenchmarkReceipt(input:{subject:string;marketSubject:string;benchmark:'100'|'20';question:string;decision?:string;cursor:number;observations:Observation[];gaps?:string[]},now:number){
 const spec=BENCHMARKS[input.benchmark];if(!spec)throw Error('invalid_benchmark')
 const known=[...new Map(input.observations.filter(o=>o.provider==='coinmarketcap'&&((o.subject===input.marketSubject&&o.metric==='price'&&o.unit==='USD')||(o.subject===spec.subject&&o.metric==='index_level'&&o.unit==='index_points'))&&instant(o.observedAt)!=null&&instant(o.observedAt)!<=input.cursor&&instant(o.recordedAt)!=null&&instant(o.recordedAt)!<=input.cursor).map(o=>[o.id,{...o,sourceUrl:safeSourceUrl(o.sourceUrl)}])).values()].sort((a,b)=>a.id.localeCompare(b.id))
 if(known.length>40)throw Error('benchmark_receipt_limit')
 const base=await makeResearchReceipt({...input,lens:'benchmark',observations:known,gaps:[...(input.gaps||[]),'Benchmark series references retain original source times. Raw source values remain subject to export permission. Materiality fingerprint uses latest evidence; content hash covers the complete retained reference set.']},now)
 const {contentHash:_,...body}=base
 const receipt={...body,observationRefs:await Promise.all(known.map(async o=>({id:o.id,provider:o.provider,sourceRef:o.sourceRef,sourceUrl:o.sourceUrl,observedAt:o.observedAt,unit:o.unit,metric:o.metric,periodSeconds:o.periodSeconds??null,hash:await digest(stableJson(o))}))),observations:known.filter(o=>o.exportAllowed===true),fingerprint:await evidenceFingerprint(known,input.cursor)}
 return validateReceipt({...receipt,contentHash:await digest(stableJson(receipt))})
}
