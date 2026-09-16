import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  INTEL_SURFACES, IntelSurfaceLockedError, requireIntelSurface, surfaceLockedResponse,
} from './intel-surface-access.ts'
import { OrgAuthzError, type OrgActor } from '../org-authz.ts'

/** The tier ladder the migration seeds, mirrored so the fake can answer the
 * same question SQL answers. free is 0; trial ranks with elite so no existing
 * workspace is narrowed. */
const RANK: Record<string, number> = { free: 0, starter: 1, pro: 2, elite: 3, trial: 3 }
const MIN_TIER: Record<string, string> = {
  market_boards: 'free', market_regime: 'free', capture_views: 'free',
  chart_workstation: 'free', narratives_read: 'free', watchlist: 'free',
  research_on_demand: 'starter', investigation: 'starter', portfolio_valuation: 'starter',
  ai_generation: 'starter', market_history: 'starter', alert_evaluation: 'starter',
  agent_access: 'starter', wallet_watch: 'starter', thesis_journal: 'starter',
  comment_king: 'starter',
}

const FREE_SURFACES = INTEL_SURFACES.filter((s) => MIN_TIER[s] === 'free')
const PAID_SURFACES = INTEL_SURFACES.filter((s) => MIN_TIER[s] !== 'free')

/** Stands in for intel_surface_allowed. `fail` makes the decision unreadable;
 * `productAccess:false` is an account that cannot use Investor Intel at all. */
function fakeDb(tier: string, opts: { fail?: boolean; productAccess?: boolean } = {}) {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    // deno-lint-ignore no-explicit-any
    rpc(name: string, args: Record<string, unknown>): Promise<any> {
      calls.push({ name, ...args })
      if (name !== 'intel_surface_allowed') return Promise.resolve({ data: null, error: { message: 'unexpected_rpc' } })
      if (opts.fail) return Promise.resolve({ data: null, error: { message: 'decision_unavailable' } })
      if (opts.productAccess === false) return Promise.resolve({ data: false, error: null })
      const min = MIN_TIER[String(args.p_surface)]
      if (min === undefined) return Promise.resolve({ data: false, error: null })
      return Promise.resolve({ data: RANK[tier] >= RANK[min], error: null })
    },
  }
}

const member = (over: Partial<OrgActor> = {}): OrgActor =>
  ({ userId: 'member', orgId: 'org', isSuperAdmin: false, isService: false, ...over })

const CORS = { 'Access-Control-Allow-Origin': '*' }

async function refusal(db: ReturnType<typeof fakeDb>, actor: OrgActor, surface: string) {
  try {
    // deno-lint-ignore no-explicit-any
    await requireIntelSurface(db, actor, surface as any)
    return null
  } catch (e) { return e }
}

Deno.test('a free member reads every surface that was already computed once for everyone', async () => {
  const db = fakeDb('free')
  for (const surface of FREE_SURFACES) {
    assertEquals(await refusal(db, member(), surface), null, `${surface} costs nothing extra to serve`)
  }
  assert(FREE_SURFACES.length >= 6, 'the free side of the split is not empty')
})

Deno.test('a free member is refused a surface that spends on their behalf, and the refusal carries none of the withheld reading', async () => {
  const db = fakeDb('free')
  for (const surface of PAID_SURFACES) {
    const error = await refusal(db, member(), surface)
    assert(error instanceof IntelSurfaceLockedError, `${surface} must be locked for a free member`)
    assertEquals((error as IntelSurfaceLockedError).surface, surface)
    assertEquals((error as IntelSurfaceLockedError).status, 403)

    const response = surfaceLockedResponse(error, CORS)!
    assertEquals(response.status, 403)
    assertEquals(response.headers.get('Cache-Control'), 'private, no-store')
    const body = await response.json()
    // The whole contract: a code and the name of the locked surface. No sample,
    // no preview, no truncated series, nothing the client could unhide.
    assertEquals(Object.keys(body).sort(), ['error', 'surface'])
    assertEquals(body, { error: 'intel_surface_locked', surface })
  }
})

Deno.test('the refusal is produced before the reading exists, so nothing was fetched to withhold', async () => {
  const db = fakeDb('free')
  const error = await refusal(db, member(), 'research_on_demand')
  assert(error instanceof IntelSurfaceLockedError)
  // One decision, and it is the only thing that ran.
  assertEquals(db.calls.length, 1)
  assertEquals(db.calls[0].name, 'intel_surface_allowed')
  assertEquals(db.calls[0].p_surface, 'research_on_demand')
  assertEquals(db.calls[0].p_org, 'org')
})

Deno.test('a paying member reaches every surface the catalogue lists, and a trial keeps the access it has today', async () => {
  for (const tier of ['starter', 'pro', 'elite', 'trial']) {
    const db = fakeDb(tier)
    for (const surface of INTEL_SURFACES) {
      assertEquals(await refusal(db, member(), surface), null, `${tier} must keep ${surface}`)
    }
  }
})

Deno.test('a workspace with no recorded tier is treated as a trial rather than as a free member', async () => {
  // intel_limit_for already coalesces a missing intel_tier to 'trial'. The
  // access ladder agrees, so this migration narrows nothing that exists today.
  const db = fakeDb('trial')
  for (const surface of INTEL_SURFACES) {
    assertEquals(await refusal(db, member(), surface), null, surface)
  }
})

Deno.test('an account that cannot use Investor Intel at all is still refused, tier notwithstanding', async () => {
  const db = fakeDb('elite', { productAccess: false })
  const error = await refusal(db, member(), 'market_boards')
  assert(error instanceof IntelSurfaceLockedError, 'the surface gate never widens the product gate')
})

Deno.test('a surface the catalogue does not list is refused rather than assumed free', async () => {
  const db = fakeDb('elite')
  const error = await refusal(db, member(), 'surface_that_does_not_exist')
  assert(error instanceof IntelSurfaceLockedError)
})

Deno.test('an unreadable entitlement is a 503, never an accidental allow', async () => {
  const db = fakeDb('elite', { fail: true })
  const error = await refusal(db, member(), 'research_on_demand')
  assert(error instanceof OrgAuthzError)
  assertEquals((error as OrgAuthzError).status, 503)
  assertEquals(surfaceLockedResponse(error, CORS), null, 'a failed decision is not rendered as a locked surface')
})

Deno.test('a member with no organization is refused without asking the database', async () => {
  const db = fakeDb('elite')
  const error = await refusal(db, member({ orgId: '' }), 'research_on_demand')
  assert(error instanceof OrgAuthzError)
  assertEquals((error as OrgAuthzError).status, 403)
  assertEquals(db.calls.length, 0)
})

Deno.test('the scheduled work that fills the free surfaces is never gated by a member tier', async () => {
  const db = fakeDb('free')
  const service = member({ userId: null, isService: true, isSuperAdmin: true })
  for (const surface of INTEL_SURFACES) {
    assertEquals(await refusal(db, service, surface), null, surface)
  }
  assertEquals(db.calls.length, 0, 'a service caller has no tier to look up')
})

Deno.test('anything that is not a surface lock falls through to the caller existing handling', () => {
  assertEquals(surfaceLockedResponse(new Error('boom'), CORS), null)
  assertEquals(surfaceLockedResponse(new OrgAuthzError('Forbidden.', 403), CORS), null)
  assertEquals(surfaceLockedResponse(null, CORS), null)
})
