import {portfolioReadingHistoryEnabled} from './portfolio-research-rollout'
// The RLS policy requires both current membership and ownership of the portfolio.
// This read never claims a generation lease, changes evidence, or calls a provider.
export async function readStoredPortfolioResearch(supabase, {orgId, userId, portfolioId, signal,versionId}) {
  if (!orgId || !userId || !portfolioId) throw new Error('Portfolio scope required')
  const retained=portfolioReadingHistoryEnabled()
  if(versionId&&!retained)throw new Error('Reading history is not enabled')
  let query = supabase.from(retained?'intel_portfolio_reading_versions':'intel_portfolio_research_cache')
    .select(retained?'id,artifact,generated_at,expires_at':'operation_id,artifact,generated_at,expires_at')
    .eq('org_id', orgId).eq('user_id', userId).eq('portfolio_id', portfolioId)
    .order('generated_at',{ascending:false}).limit(1)
  if(retained)query=query.order('id',{ascending:false})
  if(versionId)query=query.eq('id',versionId)
  if (signal) query = query.abortSignal(signal)
  const {data, error} = await query.maybeSingle()
  if (error) throw error
  if (!data) return null
  if (!data.artifact || typeof data.artifact !== 'object' || Array.isArray(data.artifact) || !data.artifact.structured ||
      !Number.isFinite(Date.parse(data.generated_at))) throw new Error('Stored portfolio reading is unavailable')
  return {ok: true, cache: 'saved', artifact: data.artifact, operationId: data.id??data.operation_id,
    generatedAt: data.generated_at, expiresAt: data.expires_at}
}

export async function listPortfolioReadings(supabase,{orgId,userId,portfolioId,before,signal}){
  if(!portfolioReadingHistoryEnabled())throw new Error('Reading history is not enabled')
  if(!orgId||!userId||!portfolioId)throw new Error('Portfolio scope required')
  let query=supabase.from('intel_portfolio_reading_versions').select('id,generated_at,expires_at')
    .eq('org_id',orgId).eq('user_id',userId).eq('portfolio_id',portfolioId)
    .order('generated_at',{ascending:false}).order('id',{ascending:false}).limit(13)
  if(before){
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(before.id)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(before.generated_at)||!Number.isFinite(Date.parse(before.generated_at)))throw new Error('Invalid reading cursor')
    const time=before.generated_at // Preserve PostgreSQL microseconds for exact keyset boundaries.
    query=query.or(`generated_at.lt.${time},and(generated_at.eq.${time},id.lt.${before.id})`)
  }
  if(signal)query=query.abortSignal(signal)
  const {data,error}=await query
  if(error)throw error
  if(!Array.isArray(data))throw new Error('Reading history is unavailable')
  const rows=data.slice(0,12)
  return {rows,hasMore:data.length>12,next:data.length>12?rows.at(-1):null}
}
