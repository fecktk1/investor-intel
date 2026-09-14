import { assembleNarrativeEvidencePack } from './narrative-evidence-pack.ts'

// Assemble before artifact reuse, so changed membership/evidence cannot hit an
// earlier report merely because the requested narrative slug is unchanged.
export async function prepareNarrativeResearch(db: any, slug: string | null, assemble = assembleNarrativeEvidencePack) {
  if (!slug || !/^[a-z0-9][a-z0-9_-]{0,119}$/.test(slug)) throw new Error('invalid_narrative_identity')
  const pack = await assemble(db, slug, {maxAssets:8})
  if (!pack.taxonomy?.id || pack.source_states.narrative_taxonomy === 'error' || !pack.content_hash) throw new Error('narrative_evidence_unavailable')
  return { pack, cacheIdentity: {narrativeEvidenceVersion:7,slug,evidence:pack.content_hash} }
}
