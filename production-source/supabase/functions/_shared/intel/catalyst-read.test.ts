import { assembleCatalystNewsState } from './market-enrichment.ts'
function db(fail: string[], malformed = false) {
  return { from(table: string) { const q: any = {}; for (const m of ['select','eq','or','gte','lte','order']) q[m] = () => q
    q.limit = () => Promise.resolve({ data: malformed ? null : table === 'intel_curated_news' ? [{ title: 'Recorded catalyst', published_at: '2026-09-11T12:00:00Z' }] : [], error: fail.includes(table) ? { message: 'denied' } : null }); return q } }
}
function assert(value: unknown, message: string) { if (!value) throw new Error(message) }
Deno.test('T05 catalyst failures stay distinct from no retained events', async () => {
  const result = await assembleCatalystNewsState(db(['intel_curated_news','intel_event_memory']), { symbol: 'BTC', chain: null })
  assert(result.status === 'error', 'failed reads must not return missing')
})
Deno.test('T05 catalyst partial failure retains good evidence and names the failed source', async () => {
  const result: any = await assembleCatalystNewsState(db(['intel_event_memory']), { symbol: 'BTC', chain: null })
  assert(result.status === 'partial' && result.curated_news.length === 1, 'one healthy source remains usable with partial status')
  assert(result.failed_sources.includes('intel_event_memory'), 'failed source is disclosed')
})
Deno.test('T05 malformed catalyst reads are errors, not empty lists', async () => {
  const result = await assembleCatalystNewsState(db([], true), { symbol: 'BTC', chain: null })
  assert(result.status === 'error', 'null payload must not imply an empty calendar')
})
