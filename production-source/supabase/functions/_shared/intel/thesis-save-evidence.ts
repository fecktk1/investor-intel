import { readAssetEvidenceVersion } from './asset-evidence-version.ts'

/** A reviewed version is authoritative even when a newer shared quote exists.
 * Missing or unauthorized versions fail; they never silently become today's evidence. */
export async function thesisSaveEvidence(db:any,actor:{userId:string;orgId:string},subject:any,version:unknown,assemble:(subject:any)=>Promise<any>) {
  if (version == null) return assemble(subject)
  if (typeof version !== 'string' || !subject.canonicalKey) throw new Error('invalid_evidence_version')
  const frozen = await readAssetEvidenceVersion(db,actor,subject.canonicalKey,version)
  if (frozen.pack?.asset?.canonical_key !== subject.canonicalKey) throw new Error('evidence_identity_mismatch')
  return { pack:frozen.pack, subject:frozen.pack.asset, contentHash:frozen.content_hash,
    sourceProvenance:frozen.source_provenance || {}, dataCoverage:frozen.data_coverage || {} }
}

export function thesisPriceSnapshot(pack:any):Record<string,any> {
  const m=pack?.market_summary||{},finite=(v:unknown)=>v==null||v===''?null:Number.isFinite(Number(v))?Number(v):null
  return { ...Object.fromEntries(['current_price','change_24h_pct','change_7d_pct','volume_24h','market_cap','fdv'].map(k=>[k,finite(m[k])])),
    asset:pack?.asset || null, field_evidence:m.field_evidence || {} }
}
