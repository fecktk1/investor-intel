import { budgetEvidencePrompt } from './evidence-prompt-budget.ts'
import {projectThesisRecordedEvidence} from './thesis-recorded-evidence.ts'
Deno.test('T09 large packs preserve specialist citations in a bounded prompt without rewriting source evidence', () => {
  const record = { id: 'oi-1', sourceRef: 'original-derivative-source', observedAt: '2026-09-11T10:00:00Z', recordedAt: '2026-09-11T10:01:00Z', metric: 'open_interest', value: 0, unit: 'USD' }
  const pack = { market_summary: { current_price: 0, field_evidence: { current_price: { value: 0, as_of: record.observedAt, source_ref: 'quote' } } }, derivatives_state: { observations: Array.from({ length: 200 }, (_, i) => ({ ...record, id: `oi-${i}` })) }, holder_state: { records: [{ holderCount: 0, sourceRef: 'holder-record', observedAt: null, computed_at: record.recordedAt }] }, news_state: { stories: [{ summary: 'Original words '.repeat(3000) }] } }
  const before = JSON.stringify(pack), result = budgetEvidencePrompt('version-1', { canonical_key: 'asset' }, pack, 9000)
  if (!result || JSON.stringify(result).length > 9000) throw new Error('Prompt budget exceeded')
  if (result.content_hash !== 'version-1' || result.pack.derivatives_state.observations[0].sourceRef !== record.sourceRef || result.pack.holder_state.records[0].holderCount !== 0) throw new Error('Specialist evidence lost')
  if (!result.prompt_omitted_sections.includes('news_state') || !result.pack.derivatives_state.observations_omitted_count) throw new Error('Omissions hidden')
  if (JSON.stringify(pack) !== before) throw new Error('Original evidence mutated')
})
Deno.test('new source comparisons keep complete citations or declare omission; shared baseline projection excludes private book context',()=>{
 const benchmark={status:'available',comparisons:[{rows:[{source:'original baseline',value:0},{source:'original ending',value:1}]}]},rwa={status:'available',versions:[{id:'original rwa',document:{issuerId:'verified'}}]},security={status:'available',versions:[{id:'original security',document:{hit:false,level:0}}]}
 const pack={market_summary:{field_evidence:{}},benchmark_state:benchmark,rwa_state:rwa,security_state:security,private_portfolio:{notes:'private trade words'}}
 const projected=projectThesisRecordedEvidence({content_hash:'version-one',pack},true)
 if(JSON.stringify(projected).includes('private trade words')||JSON.stringify(projected.specialist.benchmark_state)!==JSON.stringify(benchmark))throw Error('Baseline boundary or original evidence violated')
 const denied=projectThesisRecordedEvidence({content_hash:'version-one',pack},false)
 if(['rwa_state','security_state','benchmark_state'].some(k=>(denied.specialist as any)[k].status!=='restricted'))throw Error('Current source rights not applied')
 const budgeted=budgetEvidencePrompt('v',{},pack,9000)
 if(JSON.stringify(budgeted.pack.benchmark_state)!==JSON.stringify(benchmark))throw Error('Comparison citations altered')
 const large={...pack,benchmark_state:{...benchmark,sourceWords:'exact'.repeat(3000)}}
 const limited=budgetEvidencePrompt('v',{},large,3000)
 if(!limited.prompt_omitted_sections.includes('benchmark_state')||limited.pack.benchmark_state)throw Error('A comparison was weakened instead of explicitly omitted')
})
