import {representationPromptState} from './representation-review.ts'
// Whole records retain their words, identity, units and clocks. Budget pressure
// is recorded as projection loss, never recast as missing source coverage.
function trimArrays(value: any, keep: number): any {
  if (Array.isArray(value)) return value.slice(0, keep).map(v => trimArrays(v, keep))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = trimArrays(child, keep)
    if (Array.isArray(child) && child.length > keep) out[`${key}_omitted_count`] = child.length - keep
  }
  return out
}
function marketProjection(section: any) {
  if (!section || typeof section !== 'object') return section
  const { retained_observations: _duplicate, ...out } = section
  if (out.freshness) { const { observations: _clocks, ...freshness } = out.freshness; out.freshness = freshness }
  return out
}
export function budgetEvidencePrompt(contentHash: string, subject: unknown, pack: Record<string, any>, maxChars: number) {
  const output: any = { content_hash: contentHash, subject, pack: {}, prompt_omitted_sections: [],
    projection_note: 'This is a bounded projection of the named evidence version. Omitted detail is not evidence of absence; original records are unchanged.' }
  const priorities = ['market_summary','representation_state','derivatives_state','cmc_contract_state','holder_state','rwa_state','security_state','benchmark_state','liquidity_state','data_coverage','catalyst_state','news_state','cex_state','dex_state','onchain_state','ecosystem_narrative_state','unlock_state','protocol_state','chain_state','narrative_state','historical_context','flow_state','provider_coverage','source_provenance']
  for (const key of priorities) {
    if (pack[key] == null) continue
    const value = key === 'representation_state' ? representationPromptState(pack[key]) : key === 'market_summary' ? marketProjection(pack[key]) : pack[key]
    // Derived comparisons require their original before/after citations. Keep
    // the complete new specialist section or explicitly declare its omission;
    // generic nested truncation could keep a conclusion but lose its baseline.
    const variants = ['rwa_state','security_state','benchmark_state'].includes(key)?[value]:[value, trimArrays(value, 3), trimArrays(value, 1)]
    let added = false
    for (const variant of variants) {
      output.pack[key] = variant
      // Reserve enough room for every remaining omission label.
      if (JSON.stringify(output).length <= maxChars - 650) { added = true; break }
    }
    if (!added) { delete output.pack[key]; output.prompt_omitted_sections.push(key) }
  }
  return JSON.stringify(output).length <= maxChars ? output : null
}
