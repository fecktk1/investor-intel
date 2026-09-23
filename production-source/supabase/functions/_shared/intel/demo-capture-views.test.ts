import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  captureCopyPastWindow, DEMO_CAPTURE_VIEWS, DemoViewRefusal, demoViewCadence, isNewerCapture, isNewerScreen, parseDemoView,
  screenCopyPastWindow,
} from './demo-capture-views.ts'
import { staticCaptureRequests, WRAPPER_HISTORY_DAYS } from './demo-snapshot-plan.ts'
import { CAPTURE_READ_VIEWS } from './capture-read-envelope.ts'
import { canonicalRequestBody } from './demo-snapshot-key.ts'

const NOW = Date.parse('2026-09-23T17:51:00.000Z')

// The page's intel-capture body is { ...params, op: 'read', view }: split it the
// way src/intel/demo/demo-fetch.js does before it crosses.
const split = (body: Record<string, unknown>) => {
  const { op: _op, view, orgId: _org, ...params } = body
  return { view, params }
}

Deno.test('every shared capture view the snapshot plans is accepted with the exact parameters its page sends', () => {
  const planned = staticCaptureRequests(NOW).filter((r) => r.fn === 'intel-capture')
  const missing: string[] = []
  for (const request of planned) {
    const { view, params } = split(request.body)
    if (!Object.hasOwn(DEMO_CAPTURE_VIEWS, String(view))) { missing.push(String(view)); continue }
    const parsed = parseDemoView(view, params)
    // Rebuilt, it is still the same request (same canonical body, so the same answer).
    assertEquals(canonicalRequestBody({ ...parsed.params, op: 'read', view: parsed.view }), canonicalRequestBody(request.body))
  }
  assertEquals(missing, [])
  // The per-asset variants the plan enumerates from the stored data.
  for (const days of WRAPPER_HISTORY_DAYS) parseDemoView('rwa_wrapper_history', { rwaId: '1017', days })
  parseDemoView('rwa_wrapper_picks', { rwaId: 1017 })
  assertEquals(parseDemoView('liquidations', { providerIds: [1, '1027', 5426] }).params, { providerIds: ['1', '1027', '5426'] })
})

Deno.test('every refreshable view is a view intel-capture can read', () => {
  for (const view of Object.keys(DEMO_CAPTURE_VIEWS)) assertEquals(CAPTURE_READ_VIEWS.includes(view), true, view)
})

Deno.test('anything off the list is refused before a read', () => {
  const refused = (view: unknown, params: unknown) => assertThrows(() => parseDemoView(view, params), DemoViewRefusal)
  refused('attention', {})                                  // per-asset: read 'capture', tracked only
  refused('rwa_token_depth', { cryptoId: '1' })
  refused('rwa_asset_profile', { rwaId: 1 })
  refused('__proto__', {})
  refused('rank_map', { limit: 5000 })                     // not a value the page offers
  refused('rank_map', { limit: 25, orgId: 'x' })           // an unknown parameter
  refused('venue_share', { days: 30, kind: 'options' })
  refused('liquidations', { providerIds: ['1', '2', '3', '4', '5', '6'] })
  refused('liquidations', { providerIds: ['0x12'] })
  refused('capture_receipts', { lanes: ['rwa_wrappers; drop'] })
  refused('capture_receipts', { lanes: [] })
  refused('regime_at', { date: '2026-13-45' })
  refused('rwa_wrappers', ['not', 'an', 'object'])
  refused('rwa_wrapper_picks', { rwaId: '01' })
})

Deno.test('a snapshot copy is past its window once its lane has had time to capture again', () => {
  // The wrapper lane runs every six hours (02:47, 08:47, 14:47, 20:47 UTC).
  const board = (asOf: string | null, extra: Record<string, unknown> = {}) => ({ view: 'rwa_wrappers', asOf, rows: [], ...extra })
  assertEquals(captureCopyPastWindow('rwa_wrappers', board('2026-09-23T08:00:00.000Z'), NOW), true)
  assertEquals(captureCopyPastWindow('rwa_wrappers', board('2026-09-23T14:00:00.000Z'), NOW), false)
  // Daily lanes stay on the snapshot copy all day.
  assertEquals(captureCopyPastWindow('rwa_coverage', { asOf: '2026-09-23T03:19:00.000Z' }, NOW), false)
  assertEquals(captureCopyPastWindow('rwa_coverage', { asOf: '2026-09-22T03:19:00.000Z' }, NOW), true)
  // Nothing captured when the snapshot was built: a capture may exist now.
  assertEquals(captureCopyPastWindow('rwa_wrappers', board(null), NOW), true)
  // A read that named no subject, a failed body, or a view the demo never refreshes: never.
  assertEquals(captureCopyPastWindow('rwa_wrapper_history', board(null, { reason: 'no_asset_selected' }), NOW), false)
  assertEquals(captureCopyPastWindow('rwa_wrappers', { error: 'capture_unavailable' }, NOW), false)
  assertEquals(captureCopyPastWindow('rwa_asset_logos', { asOf: '2026-01-01T00:00:00.000Z' }, NOW), false)
  // The per-asset reads have cadences too.
  assertEquals(demoViewCadence('rwa_token_depth'), 86_400)
  assertEquals(demoViewCadence('nope'), null)
})

Deno.test('only a strictly newer capture replaces the snapshot copy', () => {
  const stored = { asOf: '2026-09-23T08:00:00.000Z' }
  assertEquals(isNewerCapture({ asOf: '2026-09-23T14:00:00.000Z' }, stored), true)
  assertEquals(isNewerCapture({ asOf: '2026-09-23T08:00:00.000Z' }, stored), false)
  assertEquals(isNewerCapture({ asOf: '2026-09-23T02:00:00.000Z' }, stored), false)
  assertEquals(isNewerCapture({ asOf: null }, stored), false)
  assertEquals(isNewerCapture({ error: 'rate_limited', asOf: '2026-09-23T14:00:00.000Z' }, stored), false)
  assertEquals(isNewerCapture({ asOf: '2026-09-23T14:00:00.000Z' }, { asOf: null }), true)
})

Deno.test('the Markets screen copy is read again once it is older than the catalogue window, and only a newer one answers', () => {
  const screen = (lastUpdated: string | null) => ({ rows: [{ symbol: 'BTC' }], lastUpdated, snapshot: { lastUpdated } })
  assertEquals(screenCopyPastWindow(screen('2026-09-23T04:13:00.000Z'), NOW), true)
  assertEquals(screenCopyPastWindow(screen('2026-09-23T17:45:00.000Z'), NOW), false)
  assertEquals(screenCopyPastWindow({ error: 'market_snapshot_unavailable' }, NOW), false)
  assertEquals(screenCopyPastWindow({ rows: [{ symbol: 'SNAP' }], total: 1 }, NOW), false)
  assertEquals(isNewerScreen(screen('2026-09-23T17:50:00.000Z'), screen('2026-09-23T04:13:00.000Z')), true)
  assertEquals(isNewerScreen(screen('2026-09-23T04:13:00.000Z'), screen('2026-09-23T04:13:00.000Z')), false)
  assertEquals(isNewerScreen({ rows: [], lastUpdated: '2026-09-23T17:50:00.000Z', error: 'x' }, screen(null)), false)
})
