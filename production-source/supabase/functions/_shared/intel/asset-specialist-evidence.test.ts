import { readAssetSpecialistEvidence } from './asset-specialist-evidence.ts'
const now = Date.parse('2026-09-11T12:00:00Z'), address = '0x' + 'a'.repeat(40)
const assert = (v: unknown, why: string) => { if (!v) throw new Error(why) }
function db(data: any, error: any = null) {
  const requests: any[] = []
  return { requests, from(table: string) { const request: any = { table, filters: [], limit: null }; requests.push(request)
    const q: any = {}; for (const m of ['select','eq','in','gte','lte','gt','order','ilike']) q[m] = (...args: any[]) => { request.filters.push([m, ...args]); return q }
    q.limit = (n: number) => { request.limit = n; return Promise.resolve({ data, error }) }; return q
  } }
}
Deno.test('T09 holder evidence uses exact contract records, retains zero and separates the computation clock', async () => {
  const source = db([{ id: 'holder-v2', holder_count: 0, top10_pct: 0, top1_pct: 0, score_version: 2, source_providers: ['alchemy'], computed_at: new Date(now).toISOString() }])
  const result = await readAssetSpecialistEvidence(source, { canonicalKey: `eip155:8453:${address}` }, now)
  const record = result.holders.records[0]
  assert(record.holderCount === 0 && record.top10Percent === 0, 'valid zero facts retained')
  assert(record.observedAt === null && record.computed_at === new Date(now).toISOString(), 'computation is not observation')
  assert(source.requests[0].filters.some((f: any) => f[0] === 'eq' && f[1] === 'chain' && f[2] === 'base'), 'exact network')
  assert(source.requests[0].filters.some((f: any) => f[0] === 'ilike' && f[2] === address), 'exact contract')
  assert(source.requests[0].limit === 100, 'bounded existing history reader')
})
Deno.test('T09 denied, wrong-asset and future derivatives never enter research', async () => {
  const o = { id: 'oi', subject: 'market:coinmarketcap:1', metric: 'open_interest', aiAllowed: true, value: 4, unit: 'USD', observedAt: new Date(now).toISOString(), recordedAt: new Date(now).toISOString() }
  const source = db([{ observation: { ...o, aiAllowed: false } }, { observation: { ...o, subject: 'market:coinmarketcap:1027' } }, { observation: { ...o, recordedAt: '2030-01-01' } }])
  const result = await readAssetSpecialistEvidence(source, { canonicalKey: 'native:bitcoin' }, now)
  assert(result.derivatives.observations.length === 0, 'all ineligible facts withheld')
  assert(source.requests[0].limit === 201, 'read has a hard bound')
})
Deno.test('T09 malformed or failed specialist reads stay errors rather than absence', async () => {
  for (const source of [db(null), db([], { message: 'denied' })]) {
    const result = await readAssetSpecialistEvidence(source, { canonicalKey: 'native:bitcoin' }, now)
    assert(result.derivatives.status === 'error', 'failure is distinct from no observations')
  }
})
