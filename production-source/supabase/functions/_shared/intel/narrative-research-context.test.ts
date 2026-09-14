import { assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert'
import { prepareNarrativeResearch } from './narrative-research-context.ts'
Deno.test('narrative report reuse binds the current evidence before any cached artifact can be returned',async()=>{
 const original={taxonomy:{id:'n'},source_states:{narrative_taxonomy:'available'},content_hash:'original-version'},calls:any[]=[]
 const assemble:any=(_db:any,slug:string,options:any)=>{calls.push({slug,options});return Promise.resolve(original)}
 const first=await prepareNarrativeResearch({},'rwa',assemble),same=await prepareNarrativeResearch({},'rwa',assemble)
 assertEquals(first.cacheIdentity,same.cacheIdentity);assertEquals(calls.length,2);assertEquals(calls[0],{slug:'rwa',options:{maxAssets:8}})
 const changed=await prepareNarrativeResearch({},'rwa',async()=>({...original,content_hash:'new-evidence-version'}) as any)
 assertNotEquals(first.cacheIdentity,changed.cacheIdentity);assertEquals(first.pack.content_hash,'original-version')
 assertNotEquals(first.cacheIdentity,(await prepareNarrativeResearch({},'ai-agents',assemble)).cacheIdentity)
})
Deno.test('unresolved narrative identity and failed taxonomy cannot fall through to a generic cached report',async()=>{
 await assertRejects(()=>prepareNarrativeResearch({},'Ticker only'))
 for(const pack of [{taxonomy:null,source_states:{},content_hash:'x'},{taxonomy:{id:'n'},source_states:{narrative_taxonomy:'error'},content_hash:'x'}])await assertRejects(()=>prepareNarrativeResearch({},'rwa',async()=>pack as any))
})
