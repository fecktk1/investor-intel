// Investor Intel — research artifact client API.
import { normalizeAssetEntity } from './asset-identity'

export async function generateArtifact(supabase, params) {
  const { data, error } = await supabase.functions.invoke('intel-generate', { body: params })
  if (error || data?.error) {
    const payload=data||await error?.context?.json?.().catch(()=>null)
    const code=typeof payload?.error==='string'?payload.error.slice(0,500):typeof payload?.code==='string'?payload.code.slice(0,100):null
    const messages={cmc_ai_processing_not_enabled:'AI processing is unavailable for this source under the current permissions.',generation_not_allowed:'Research generation is unavailable for this workspace. Review access in Settings.',rate_limited:'The research generation allowance has been reached. Your saved research remains available.',invalid_comparison_assets:'Choose two to four assets with verified identities.',conflicting_comparison_identity:'An asset identity conflicts with its selected source. Reopen the comparison from Markets.',duplicate_comparison_asset:'Choose different asset identities for the comparison.'}
    const alertMessages={alert_event_required:'Reopen the alert from Alerts to explain its original evidence.',alert_event_unavailable:'This alert is unavailable to your account or has been deleted.',alert_evidence_read_failed:'The original alert evidence could not be loaded. Try again.',alert_evidence_malformed:'The saved alert receipt is incomplete. Review its original details; an explanation cannot be generated.',alert_evidence_too_large:'This receipt exceeds the explanation limit. Its full original details remain available.',alert_evidence_changed:'The alert changed while research was being prepared. Reopen it and try again.'}
    const status=error?.context?.status
    const reason=typeof payload?.reason==='string'?payload.reason.slice(0,100):null
    const cooldownUntil=typeof payload?.cooldown_until==='string'&&payload.cooldown_until.length<=64&&Number.isFinite(Date.parse(payload.cooldown_until))?new Date(payload.cooldown_until).toISOString():null
    const refreshMessage=code==='force_refresh_limited'?(reason==='cooldown'?`This report is in a refresh cooldown${cooldownUntil?` until ${new Date(cooldownUntil).toLocaleString(undefined,{timeZoneName:'short'})}`:''}. Your current report and saved research remain available.`:reason==='force_refresh_per_day'?'The daily research refresh allowance has been reached. Your current report and saved research remain available.':null):null
    const gateMessages={cost_cap:'This workspace has reached its monthly research budget. Your charts and saved research remain available.',kill_switch:'New research generation is temporarily paused. Your charts and saved research remain available.',not_intel:'Select an Investor Intel workspace to generate research.',workspace_unavailable:'This research workspace is unavailable to your account. Select a workspace you can access.',no_org:'Select an Investor Intel workspace to generate research.',governance_unavailable:'Research access could not be verified. Your charts and saved research remain available. Try again shortly.',configuration_unavailable:'Research configuration is temporarily unavailable. Your charts and saved research remain available.'}
    const gateMessage=['generation_not_allowed','rate_limited','force_refresh_limited'].includes(code)&&Object.hasOwn(gateMessages,reason)?gateMessages[reason]:null
    const statusMessage=status===504||code==='WORKER_LIMIT'?'Research took longer than the service allows. Your charts and saved research remain available. Try again shortly.':status===503?'Research generation is temporarily unavailable. Your charts and saved research remain available.':null
    const evidenceMessages={narrative_evidence_unavailable:'The retained narrative evidence could not be verified. Try again; your existing reports remain available.',narrative_input_storage_unavailable:'The original research inputs could not be retained under the current source permissions. No new report was generated; your existing reports remain available.',personal_context_unavailable:'Your selected portfolio and research context could not be loaded. Try again; your existing research remains available.'}
    const failure=new Error(gateMessage||refreshMessage||(Object.hasOwn(evidenceMessages,code)?evidenceMessages[code]:null)||(Object.hasOwn(alertMessages,code)?alertMessages[code]:null)||(Object.hasOwn(messages,code)?messages[code]:null)||statusMessage||code||error?.message||'Research generation failed. Try again.')
    failure.code=code;failure.status=status;failure.reason=reason
    if(code==='force_refresh_limited'&&cooldownUntil)failure.cooldownUntil=cooldownUntil
    for(const key of ['used','cap','limit'])if(typeof payload?.[key]==='number'&&Number.isFinite(payload[key])&&payload[key]>=0)failure[key]=payload[key]
    throw failure
  }
  return data // { artifact, cached?, blocked? }
}

export async function getEntityByRef(supabase, orgId, canonicalRefKey) {
  const { data, error } = await supabase
    .from('entities').select('*').eq('org_id', orgId).eq('canonical_ref_key', canonicalRefKey).maybeSingle()
  if (error) throw error
  return normalizeAssetEntity(data)
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
