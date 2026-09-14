import { evidenceBlock, selectCoachEvidence, validateCoachCitations } from './thesis-coach-evidence.ts'
function assert(v: unknown, message: string) { if (!v) throw new Error(message) }
const card = { source_table: 'intel_curated_news', source_ref: 'original:1', title: 'Recorded release', summary: 'Context '.repeat(30) + 'This was a proposal, not a completed release.', date: '2026-09-11T10:00:00Z', url: 'https://example.com/original', source: 'Publisher', event_type: 'development', materiality: 'medium', sentiment: 'neutral', coverage: 'partial' }
Deno.test('T04 coach retains original qualifying words, source references, links and observation time', () => {
  const output = evidenceBlock([card])
  for (const text of [card.summary, card.source_ref, card.url, card.date]) assert(output.includes(text), `dropped evidence: ${text}`)
})
Deno.test('T04 coach discloses bounded omissions instead of silently dropping selected evidence', () => {
  const output = evidenceBlock(Array.from({ length: 20 }, (_, i) => ({ ...card, source_ref: `ref:${i}` })))
  assert(output.includes('omitted_count'), 'omissions must be explicit')
})
Deno.test('T04 client text cannot replace authorized evidence and unknown selections fail', () => {
  assert(selectCoachEvidence([card], [{ ...card, summary: 'fabricated' }])[0].summary === card.summary, 'server snapshot wins')
  let failed = false
  try { selectCoachEvidence([card], [{ ...card, source_ref: 'someone-elses-record' }]) } catch { failed = true }
  assert(failed, 'unavailable evidence cannot be substituted')
})
Deno.test('T04 citation validation rejects unknown and missing references and retains the evidence version', () => {
  const block = evidenceBlock([card], 14, 'version-1')
  for (const output of [{ summary: 'Unsupported [E2]' }, { summary: 'No citation' }]) {
    let failed = false; try { validateCoachCitations(output, block) } catch { failed = true }
    assert(failed, 'invalid citations must fail before presentation')
  }
  const result = validateCoachCitations({ summary: 'A proposal [E1]' }, block)
  assert(result.evidence_version === 'version-1' && result.source_evidence[0].source_ref === card.source_ref, 'same original version and source attached')
})
Deno.test('T04 a too-large record is omitted whole without cutting its original words', () => {
  const result = JSON.parse(evidenceBlock([{ ...card, summary: 'a'.repeat(19000) }, card], 14, 'v'))
  assert(result.evidence.length === 1 && result.evidence[0].summary === card.summary && result.omitted_count === 1, 'whole-record budget')
})
