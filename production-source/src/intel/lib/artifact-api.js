// Investor Intel — research artifact client API.

export async function generateArtifact(supabase, params) {
  const { data, error } = await supabase.functions.invoke('intel-generate', { body: params })
  if (error) throw new Error(error.message || 'generate_failed')
  if (data?.error) throw new Error(data.error)
  return data // { artifact, cached?, blocked? }
}

export async function getEntityByRef(supabase, orgId, canonicalRefKey) {
  const { data, error } = await supabase
    .from('entities').select('*').eq('org_id', orgId).eq('canonical_ref_key', canonicalRefKey).maybeSingle()
  if (error) throw error
  return data
}

export async function listArtifacts(supabase, orgId, { artifactType, entityId, limit = 20 } = {}) {
  let q = supabase.from('research_artifacts').select('*').eq('org_id', orgId)
    .order('created_at', { ascending: false }).limit(limit)
  if (artifactType) q = q.eq('artifact_type', artifactType)
  if (entityId) q = q.eq('entity_id', entityId)
  const { data, error } = await q
  if (error) throw error
  return data || []
}
