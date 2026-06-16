import { similarRecentExplain } from './intel-context-adapters.ts'
import { jaccard, EXPLAIN_SIMILARITY } from '../core-intel/context-router.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

// Minimal research_artifacts mock: records eq/is filters and applies them to the
// seed (so explain_subject_key / entity_id scoping is exercised). not/gte/order/
// limit are pass-throughs; the builder is awaitable like a PostgREST query.
// deno-lint-ignore no-explicit-any
function makeArtifactDb(rows: any[]) {
  return {
    from() {
      const eqs: Array<[string, unknown]> = []
      const iss: Array<[string, unknown]> = []
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { eqs.push([k, v]); return q },
        is: (k: string, v: unknown) => { iss.push([k, v]); return q },
        not: () => q,
        gte: () => q,
        order: () => q,
        limit: () => q,
        then: (res: (x: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          let data = [...rows]
          for (const [k, v] of eqs) data = data.filter((r) => r?.[k] === v)
          for (const [k, v] of iss) data = data.filter((r) => r?.[k] === v)
          return Promise.resolve({ data, error: null }).then(res, rej)
        },
      }
      return q
    },
  }
}

// Two market explains whose questions differ ONLY by symbol → shingle sets overlap
// far above the 0.8 reuse threshold (this is exactly what caused ZEC to be served
// on every asset page before the fix).
const ETH_SHINGLES = ['explain current', 'current market', 'market read', 'read for', 'for eth', 'why it', 'it is', 'is bullish', 'bullish research', 'research context']
const ZEC_SHINGLES = ['explain current', 'current market', 'market read', 'read for', 'for zec', 'why it', 'it is', 'is bullish', 'bullish research', 'research context']

Deno.test('explain reuse is asset-scoped: a similar-question ZEC artifact is NOT served for an ETH subject', async () => {
  // Sanity: the two questions ARE shingle-similar enough that the OLD (un-scoped)
  // reuse would have matched them — proving the subject filter is what saves us.
  assert(jaccard(ETH_SHINGLES, ZEC_SHINGLES) >= EXPLAIN_SIMILARITY, 'questions are cross-asset similar (>=0.8)')

  const db = makeArtifactDb([
    { id: 'zec1', org_id: 'org1', artifact_type: 'explain', status: 'ready', entity_id: null, explain_subject_key: 'market:coingecko:zcash', question_norm_hash: 'hZEC', question_shingles: ZEC_SHINGLES },
  ])
  const hit = await similarRecentExplain(db, {
    orgId: 'org1',
    entityId: null,
    subjectKey: 'market:coingecko:ethereum',
    hashes: { question_norm_hash: 'hETH', question_shingles: ETH_SHINGLES } as never,
  })
  assert(hit === null, 'ETH subject must not reuse the ZEC artifact')
})

Deno.test('explain reuse still hits within the same asset subject', async () => {
  const db = makeArtifactDb([
    { id: 'eth1', org_id: 'org1', artifact_type: 'explain', status: 'ready', entity_id: null, explain_subject_key: 'market:coingecko:ethereum', question_norm_hash: 'hETH-prev', question_shingles: ETH_SHINGLES, artifact: { structured: { summary: 'ETH read' } } },
  ])
  const hit = await similarRecentExplain(db, {
    orgId: 'org1',
    entityId: null,
    subjectKey: 'market:coingecko:ethereum',
    hashes: { question_norm_hash: 'hETH-now', question_shingles: ETH_SHINGLES } as never,
  })
  assert(hit !== null, 'same-subject similar question reuses the prior ETH artifact')
  assert(hit?.artifact?.explain_subject_key === 'market:coingecko:ethereum', 'reused artifact is the ETH one')
})
