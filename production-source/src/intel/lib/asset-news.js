// Existing shared news corpus plus explicitly linked workspace sources. These
// are news relevance matches, never identity joins for prices or holdings.
export const ASSET_NEWS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const ASSET_NEWS_REFRESH_MS = 5 * 60 * 1000
const clean = value => String(value || '').replace(/[^\p{L}\p{N} :._-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
const date = value => value ? Date.parse(value) : NaN
const inWindow = (row, now) => {
  const time = date(row.published_at)
  return Number.isFinite(time) && time >= now - ASSET_NEWS_WINDOW_MS && time <= now
}
const containsPhrase = (text, phrase) => {
  if (!phrase || phrase.length < 3) return false
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(text)
}
const safeUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null } catch { return null } }
const dedupUrl = value => { try { const url = new URL(value); url.hash = ''; for (const key of [...url.searchParams.keys()]) if (/^(?:amp;)*(?:utm_|ref$|source$|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key); url.searchParams.sort();url.pathname=url.pathname.replace(/\/$/,'')||'/';return url.href } catch { return null } }

export function assetNewsIdentity(input = {}) {
  const chain = /^[a-z0-9-]{1,40}$/.test(input.chain || '') ? input.chain : null
  const symbol = clean(input.symbol), name = clean(input.name)
  const address = /^[a-zA-Z0-9:._/-]{10,150}$/.test(input.address || '') ? input.address : null
  return { key: input.key || null, chain, symbol, name, address, native: input.native === true, entityId: input.entityId || null }
}

export function mergeAssetNews(groups, identity, now = Date.now(), limit = 15) {
  const names = [identity.name, identity.address].filter(Boolean)
  const canonicalTags = [identity.key, identity.native && identity.chain ? `${identity.chain}:native` : null].filter(Boolean).map(s => s.toLowerCase())
  const relevant = row => {
    if (row.workspace) return true // linked by entity_id under the selected org
    const tokens = (row.tokens || []).map(s => String(s).toLowerCase())
    if (tokens.some(token => canonicalTags.includes(token))) return true
    const words = `${row.title || ''} ${row.cleaned_title || ''} ${row.summary || ''}`
    // A long-form asset name or contract reference provides independent context.
    if (names.some(name => name.toLowerCase() !== identity.symbol.toLowerCase() && containsPhrase(words, name))) return true
    // Legacy symbol tags require the selected chain as corroboration. A chain
    // tag alone must not put unrelated Zcash coverage on the Bitcoin page.
    const chainMatch = identity.chain && row.chains?.includes(identity.chain)
    return !!chainMatch && (containsPhrase(words, identity.symbol) || tokens.includes(identity.symbol.toLowerCase()) || String(row.entity_symbol || '').toLowerCase() === identity.symbol.toLowerCase())
  }
  const seenUrls = new Set(), seenTitles = new Set(), rows = []
  for (const row of groups.flat().filter(row => inWindow(row, now) && relevant(row)).sort((a,b) => date(b.published_at) - date(a.published_at))) {
    const title = String(row.cleaned_title || row.title || '').trim()
    if (!title) continue
    const url = safeUrl(row.primary_url || row.url), urlKey = dedupUrl(url), titleKey = title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    if ((urlKey && seenUrls.has(urlKey)) || seenTitles.has(titleKey)) continue
    if (urlKey) seenUrls.add(urlKey)
    seenTitles.add(titleKey)
    rows.push({ ...row, title, url, source_name: row.source_name || (row.curated ? 'Curated coverage' : 'Workspace source'), sentiment: row.signal || row.sentiment })
    if (rows.length >= Math.min(30, Math.max(1, limit))) break
  }
  return rows
}

export async function loadAssetNews(supabase, orgId, input, { now = Date.now(), signal } = {}) {
  const identity = assetNewsIdentity(input)
  if (!identity.key) return { rows: [], checkedAt: new Date(now).toISOString(), partial: false }
  const since = new Date(now - ASSET_NEWS_WINDOW_MS).toISOString(), until = new Date(now).toISOString()
  const bounded = query => {
    const q = query.gte('published_at', since).lte('published_at', until).order('published_at', { ascending: false }).limit(40)
    return signal ? q.abortSignal(signal) : q
  }
  const tags = [...new Set([identity.symbol, identity.name, identity.native && identity.chain ? `${identity.chain}:native` : null].filter(Boolean))]
  const curatedTerms = tags.map(tag => `tokens.cs.{${JSON.stringify(tag)}}`)
  const rawTerms = []
  if (identity.name && identity.name !== identity.symbol) rawTerms.push(`title.ilike.%${identity.name}%`)
  if (identity.symbol) rawTerms.push(`entity_symbol.eq.${JSON.stringify(identity.symbol)}`)
  if (identity.native && identity.chain) { curatedTerms.push(`chains.cs.{${identity.chain}}`); rawTerms.push(`chains.cs.{${identity.chain}}`) }
  if (identity.address) rawTerms.push(`title.ilike.%${identity.address}%`)
  const reads = []
  if (curatedTerms.length) reads.push({ kind: 'curated', query: bounded(supabase.from('intel_curated_news').select('id, title, cleaned_title, summary, why_it_matters, signal, confidence, primary_url, published_at, source_count, chains, tokens').eq('should_surface', true).or(curatedTerms.join(','))) })
  if (rawTerms.length) reads.push({ kind: 'raw', query: bounded(supabase.from('intel_global_news').select('id, title, url, summary, source_name, sentiment, published_at, chains, entity_symbol').or(rawTerms.join(','))) })
  if (orgId && identity.entityId) reads.push({ kind: 'workspace', query: bounded(supabase.from('news_items').select('id, title, url, summary, source_name, sentiment, published_at').eq('org_id', orgId).eq('entity_id', identity.entityId)) })
  const results = await Promise.allSettled(reads.map(async ({ query, kind }) => {
    const { data, error } = await query
    if (error) throw error
    return (data || []).map(row => ({ ...row, curated: kind === 'curated', workspace: kind === 'workspace' }))
  }))
  if (results.length && results.every(result => result.status === 'rejected')) throw new Error('asset_news_unavailable')
  return { rows: mergeAssetNews(results.filter(r => r.status === 'fulfilled').map(r => r.value), identity, now), checkedAt: until, partial: results.some(r => r.status === 'rejected') }
}
