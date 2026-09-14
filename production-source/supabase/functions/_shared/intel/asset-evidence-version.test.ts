import { readAssetEvidenceVersion } from './asset-evidence-version.ts'
const actor = { orgId: 'org', userId: 'user' }, row = { org_id: 'org', user_id: 'user', subject_canonical_key: 'native:bitcoin', content_hash: 'version-1', pack: { notes: 'Original evidence' } }
const db = (data: any, error: any = null) => ({ from() { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data, error }) }; return q } })
Deno.test('T04 recorded evidence version cannot cross owner, organization, asset or version boundaries', async () => {
  const saved = await readAssetEvidenceVersion(db(row), actor, 'native:bitcoin', 'version-1')
  if (saved.pack.notes !== 'Original evidence') throw new Error('Original evidence changed')
  for (const invalid of [null, { ...row, user_id: 'other' }, { ...row, org_id: 'other' }, { ...row, subject_canonical_key: 'native:ethereum' }, { ...row, content_hash: 'version-2' }]) {
    let failed = false; try { await readAssetEvidenceVersion(db(invalid), actor, 'native:bitcoin', 'version-1') } catch { failed = true }
    if (!failed) throw new Error('Unauthorized version was accepted')
  }
})
Deno.test('T04 evidence read failures are explicit', async () => {
  let message = ''; try { await readAssetEvidenceVersion(db(null, {}), actor, 'native:bitcoin', 'version-1') } catch (e) { message = (e as Error).message }
  if (message !== 'evidence_version_read_failed') throw new Error('Read failure lost')
})
