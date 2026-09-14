import {assertEquals,assert} from 'jsr:@std/assert'
import {representationReview,representationPromptState} from './representation-review.ts'
import {budgetEvidencePrompt} from './evidence-prompt-budget.ts'
import {projectThesisRecordedEvidence} from './thesis-recorded-evidence.ts'
import {compactAssetEvidencePackForPrompt} from './asset-evidence-pack.ts'
import {portfolioResearchPromptFacts} from './portfolio-research.ts'
const now=Date.parse('2026-09-12T06:00:00Z'),polygon='eip155:137:0xa7e22972a19dd924afeedf3db28033b146801081'
Deno.test('issuer deployment review matches exact networks and tokens, never ticker or CMC ID',()=>{
 const r=representationReview(polygon,now)!
 assertEquals(r.network,'Polygon');assertEquals(r.effectiveDate,'2026-08-07');assertEquals(r.effectiveTime,null)
 assertEquals(representationReview(polygon.replace(':137:',':1:'),now),null)
 assertEquals(representationReview('XAUM',now),null);assertEquals(representationReview('market:coinmarketcap:34212',now),null)
 assertEquals(representationReview('eip155:137/erc20:0xA7E22972a19dd924aFeEDf3Db28033B146801081',now),r)
 assertEquals(representationReview('eip155:137:0x59c734c8753B596607cb8a72F1f51965c75417CC',now),null)
 assertEquals(representationReview('eip155:177:0x2577217c86ae2E8a5f70Abb663B9231E5d47D15a',now)?.network,'HashKey Chain')
 assertEquals(representationReview('tron:TDfX64Ariz5usffBJjtDbiMuCXVpKiDCEb',now)?.network,'Tron')
 assertEquals(representationReview('tron:tdfx64ariz5usffbjjtdbimucxvpKidceb',now),null)
})
Deno.test('review clocks do not backdate knowledge or turn expired review into clearance',()=>{
 assertEquals(representationReview(polygon,Date.parse('2026-09-12T05:02:36Z')),null)
 const original=representationReview(polygon,now)!,saved=JSON.stringify(original)
 const expired=representationReview(polygon,Date.parse('2026-09-20T00:00:00Z'))!
 assertEquals(expired.status,'review_expired');assertEquals(expired.sourceRef,original.sourceRef);assertEquals(expired.summary,original.summary)
 assertEquals(JSON.stringify(original),saved);assertEquals(representationReview(polygon,NaN),null)
})
Deno.test('human notice stays in the named thesis version while AI sees a reference and explicit restriction',()=>{
 const review=representationReview(polygon,now)!,row={content_hash:'original-version',pack:{representation_state:review}}
 assertEquals(projectThesisRecordedEvidence(row,false).specialist.representation_state,review)
 const prompt=budgetEvidencePrompt('original-version',{canonical_key:polygon},row.pack,5000)!
 assertEquals(prompt.pack.representation_state,representationPromptState(review))
 assert(!JSON.stringify(prompt).includes(review.summary));assertEquals(prompt.content_hash,'original-version')
 assertEquals(row.pack.representation_state.summary,review.summary)
})
Deno.test('full and bounded asset prompts and portfolio prompts keep review content out without mutating the artifact',()=>{
 const review=representationReview(polygon,now)!,pack={representation_state:review,market_summary:{current_price:0}}
 const result:any={pack,contentHash:'saved',subject:{},contextPack:{content_hash:'saved',blocks:[],policy:{}}}
 for(const budget of [100000,1500]){
  const prompt=compactAssetEvidencePackForPrompt(result,budget)!
  assert(!JSON.stringify(prompt).includes(review.summary));assertEquals((prompt.pack as any).representation_state.status,'restricted')
 }
 const facts={marketEvidence:[{canonicalAssetKey:polygon,representation_state:review}],rwaExposure:{rows:[{representationReview:review,valueUsd:0}]},holdings:[{quantity:0,value:0}]}
 const filtered=portfolioResearchPromptFacts(facts)
 assert(!JSON.stringify(filtered).includes(review.summary));assertEquals(filtered.holdings,facts.holdings)
 assertEquals(pack.representation_state,review);assertEquals(facts.marketEvidence[0].representation_state,review)
})
