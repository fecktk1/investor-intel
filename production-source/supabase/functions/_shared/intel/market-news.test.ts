import { assertEquals } from 'jsr:@std/assert@1'
import { assembleCatalystNewsState } from './market-enrichment.ts'

Deno.test('recent asset evidence excludes old high-score headlines without deleting historical catalysts', async () => {
  const archive = [
    { title: 'June high score', published_at: '2026-06-09T12:00:00Z', final_score: 100 },
    { title: 'Yesterday', published_at: '2026-09-08T12:00:00Z', final_score: 99 },
    { title: 'Today', published_at: '2026-09-09T12:00:00Z', final_score: 50 },
    { title: 'Undated', published_at: null, final_score: 100 },
  ]
  const db = { from(table: string) {
    // This in-memory query evaluates filters/order against a fixed publication
    // history: the highest scored result is deliberately months out of date.
    let data: Record<string, any>[] = table === 'intel_curated_news' ? [...archive] : [{ title: 'Historic catalyst', occurred_at: '2026-01-01T00:00:00Z' }]
    const sort: { key: string; ascending: boolean }[] = []
    let limit = 100
    const query = {
      select: (_s: string) => query, eq: (_k: string, _v: unknown) => query, or: (_s: string) => query,
      gte: (key: string, value: string) => { data = data.filter(row => row[key] != null && row[key] >= value); return query },
      lte: (key: string, value: string) => { data = data.filter(row => row[key] != null && row[key] <= value); return query },
      order: (key: string, opts: { ascending: boolean }) => { sort.push({key, ...opts}); return query },
      limit: (value: number) => { limit=value; return query },
      then: (resolve: (value: { data: Record<string, any>[] }) => unknown) => Promise.resolve({ data: data.sort((a,b) => { for(const {key,ascending} of sort) { const cmp=a[key]===b[key]?0:a[key]>b[key]?1:-1; if(cmp) return ascending?cmp:-cmp } return 0 }).slice(0,limit) }).then(resolve),
    }
    return query
  } }
  const result = await assembleCatalystNewsState(db, { symbol: 'BTC', chain: 'bitcoin' }, Date.parse('2026-09-09T18:00:00Z'))
  assertEquals(result.curated_news.map(row => row.title), ['Today', 'Yesterday'])
  assertEquals(result.catalysts[0].title, 'Historic catalyst')
  assertEquals(result.freshness, '2026-09-09T12:00:00Z')
  assertEquals(archive.length, 4)
})
