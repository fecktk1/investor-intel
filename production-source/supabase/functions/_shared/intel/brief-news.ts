/** Daily context uses publication time, not the time a crawler revisited a story.
 * Historical news stays in the archive and is never promoted as today's event. */
export async function readBriefNews(db:any, now:Date, limit=20) {
  const size=Math.max(1,Math.min(20,limit)), since=new Date(now.getTime()-48*3600_000).toISOString()
  const {data,error}=await db.from('intel_curated_news')
    .select('id,cluster_hash,cleaned_title,title,why_it_matters,summary,signal,tokens,final_score,should_surface,published_at,stale_after,primary_url,source_type,source_count,supporting_sources')
    .eq('should_surface',true).gte('published_at',since).lte('published_at',now.toISOString()).gt('stale_after',now.toISOString())
    .order('published_at',{ascending:false}).order('final_score',{ascending:false}).order('id').limit(60)
  if(error)throw error
  if(!Array.isArray(data))throw Error('brief_news_read_failed')
  const seen=new Set<string>(), rows:any[]=[]
  for(const row of data || []) {
    const published=Date.parse(row.published_at),expires=Date.parse(row.stale_after)
    if(!Number.isFinite(published)||published<Date.parse(since)||published>now.getTime()||!Number.isFinite(expires)||expires<=now.getTime())continue
    const title=String(row.cleaned_title||row.title||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()
    const keys=[row.primary_url&&`url:${row.primary_url}`,title&&`title:${title}`,row.cluster_hash&&`cluster:${row.cluster_hash}`].filter(Boolean)
    if(!keys.length||keys.some(key=>seen.has(key)))continue
    keys.forEach(key=>seen.add(key));rows.push(row)
    if(rows.length===size)break
  }
  return rows
}
