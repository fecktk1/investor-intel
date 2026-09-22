import { assert, assertEquals as eq, assertMatch, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  canonicalRequestBody, demoEntryPath, demoFunctionSlug, demoSnapshotCanonical, demoSnapshotKey, DEMO_KEY_PATTERN,
} from './demo-snapshot-key.ts'

Deno.test('org fields are removed, keys sorted at every depth, undefined dropped', () => {
  eq(canonicalRequestBody({ view: 'rwa_coverage', orgId: 'org-1', op: 'read' }), '{"op":"read","view":"rwa_coverage"}')
  eq(canonicalRequestBody({ org_id: 'x', b: { z: 1, a: undefined, m: [3, undefined, 1] }, a: 2 }), '{"a":2,"b":{"m":[3,null,1],"z":1}}')
  // An org field NESTED inside params is data, not the caller's workspace.
  eq(canonicalRequestBody({ params: { orgId: 'kept' } }), '{"params":{"orgId":"kept"}}')
})

Deno.test('a JSON string body and the object it encodes give the same key', () => {
  const body = { orgId: 'o', capability: 'rwaList', params: { start: 1, limit: 25 } }
  eq(demoSnapshotKey('intel-research', JSON.stringify(body)), demoSnapshotKey('intel-research', body))
})

Deno.test('plain decimal strings and numbers are the same parameter; other strings are not', () => {
  eq(demoSnapshotKey('intel-capture', { view: 'rwa_wrapper_history', rwaId: '1017', days: 90 }),
    demoSnapshotKey('intel-capture', { view: 'rwa_wrapper_history', rwaId: 1017, days: '90' }))
  assertNotEquals(demoSnapshotKey('x', { id: '007' }), demoSnapshotKey('x', { id: 7 }))
  assertNotEquals(demoSnapshotKey('x', { range: '30d' }), demoSnapshotKey('x', { range: '90d' }))
})

Deno.test('key order and org never change the key; the function and the view do', () => {
  const a = demoSnapshotKey('intel-capture', { op: 'read', view: 'rank_map', limit: 25, orgId: 'a' })
  const b = demoSnapshotKey('intel-capture', { limit: 25, view: 'rank_map', op: 'read', orgId: 'b' })
  eq(a, b)
  assertNotEquals(a, demoSnapshotKey('intel-capture', { op: 'read', view: 'rank_map', limit: 50 }))
  assertNotEquals(a, demoSnapshotKey('intel-research', { op: 'read', view: 'rank_map', limit: 25 }))
})

Deno.test('keys are file safe and entry paths are dated', () => {
  const key = demoSnapshotKey('Intel Capture!', { a: 1 })
  assertMatch(key, DEMO_KEY_PATTERN)
  eq(demoFunctionSlug('intel-capture'), 'intel-capture')
  eq(demoEntryPath('2026-09-23', key), `snapshots/2026-09-23/${key}.json`)
  assert(demoSnapshotCanonical('intel-capture', {}).startsWith('intel-capture\n'))
})

Deno.test('the real request shapes the app sends produce the keys the builder plans', async () => {
  const { staticCaptureRequests } = await import('./demo-snapshot-plan.ts')
  const planned = new Set(staticCaptureRequests(Date.parse('2026-09-23T04:13:00Z')).map((r) => demoSnapshotKey(r.fn, r.body)))
  // capture-api.js readCaptureView: { ...params, op: 'read', view } + orgId.
  const captureBody = (view: string, params: Record<string, unknown>) => ({ ...params, op: 'read', view, orgId: '00000000-0000-4000-8000-00000000d3e1' })
  for (const [view, params] of [
    ['rwa_coverage', {}], ['rank_map', { limit: 25 }], ['rwa_universe_changes', { days: 7 }], ['venue_share', { days: 90, kind: 'derivatives' }],
    ['exchange_reserves', { days: 30 }], ['rwa_wrappers', {}], ['rwa_wrapper_history', { days: 90 }], ['fx', {}],
    ['capture_receipts', { lanes: ['rwa_wrappers', 'rwa'] }], ['categories', { days: 7, top: 30 }], ['airdrops', { status: 'all', days: 90 }],
    ['new_listings', { days: 7, status: 'all' }], ['meme_graduation', { days: 7 }], ['regime', { range: '30d' }], ['unusual_moves', { limit: 25 }],
  ] as [string, Record<string, unknown>][]) {
    // supabase-js sends the body as a JSON string.
    assert(planned.has(demoSnapshotKey('intel-capture', JSON.stringify(captureBody(view, params)))), `${view} ${JSON.stringify(params)} not planned`)
  }
})
