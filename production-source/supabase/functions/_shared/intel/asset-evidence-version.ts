// Caller authenticates current product access before this service-role read.
// All scope dimensions are mandatory; a shared market cache cannot substitute
// for a user's private evidence version.
export async function readAssetEvidenceVersion(db: any, actor: { userId: string; orgId: string }, subject: string, version: string) {
  if (!actor.userId || !actor.orgId || !subject || subject.length > 240 || !/^[a-zA-Z0-9:_-]{1,128}$/.test(version)) throw new Error('invalid_evidence_version')
  const { data, error } = await db.from('intelligence_evidence_packs').select('org_id,user_id,subject_canonical_key,content_hash,pack,source_provenance,data_coverage')
    .eq('org_id', actor.orgId).eq('user_id', actor.userId).eq('subject_canonical_key', subject).eq('content_hash', version).eq('window', 'current').maybeSingle()
  if (error) throw new Error('evidence_version_read_failed')
  if (!data || data.org_id !== actor.orgId || data.user_id !== actor.userId || data.subject_canonical_key !== subject || data.content_hash !== version || !data.pack) throw new Error('evidence_version_unavailable')
  return data
}
