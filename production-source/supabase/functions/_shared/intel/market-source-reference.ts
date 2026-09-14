import {digest,stableJson} from './investigation-evidence.ts'
import {CMC_CAPABILITIES} from '../market-assets/cmc-capabilities.ts'
/** References are durable; source values remain governed by current retention,
 * display, AI and export rights in the existing shared market stores. */
export async function marketSourceReference(capability:string,params:Record<string,string>,body:any,provenance:any){
 const spec=CMC_CAPABILITIES[capability]
 if(!spec||body?.data==null||!Number.isFinite(Date.parse(provenance?.fetchedAt)))throw Error('source_reference_unavailable')
 return {schemaVersion:1,provider:'coinmarketcap',capability,subject:`source:coinmarketcap:${capability}:${await digest(stableJson(params))}`,
  endpoint:spec.path,parameters:params,payloadHash:await digest(stableJson({capability,params,data:body.data})),retrievedAt:provenance.fetchedAt,
  observedAt:provenance.observedAt??null,sourceUrl:provenance.sourceUrl,replay:'references_only',
  timeMeaning:'Source records retain individual observation times. Retrieval identifies the response reviewed, not the occurrence of every field.'}
}
