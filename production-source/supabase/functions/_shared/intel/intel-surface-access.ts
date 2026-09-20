// Investor Intel — the per-surface entitlement gate.
//
// requireIntelAccess answers "may this account use Investor Intel at all".
// This module asks the narrower question that the free access level needs:
// "may this account use THIS surface". The two are layered, never swapped.
// intel_surface_allowed (migration 20260916114500) calls can_access_intel
// itself and can only narrow its answer, so adding a gate here can never open
// something that was closed before.
//
// THE SECURITY PROPERTY THIS FILE EXISTS TO HOLD
//
// The gate is SERVER SIDE and it runs BEFORE the withheld reading is produced.
// A locked surface must never send the real data and hide it in the browser:
// that is a data leak wearing a visual. So every caller places
// requireIntelSurface ahead of the work that costs money, and the refusal body
// below carries nothing but the error code and the surface name. There is no
// field on it that could hold a price, a holding, a series or a synthesis.
//
// Cron and service callers are not members and have no tier. They are let
// through, exactly as requireOrgMember already lets them through, because the
// scheduled work that FILLS the free surfaces runs on that path.

import { OrgAuthzError, type OrgActor } from '../org-authz.ts'

/** The catalogue, mirrored from intel_surface_tiers for typing and for the
 * refusal body. SQL remains the authority: a surface that is missing from the
 * table is refused there whatever this list says. */
export const INTEL_SURFACES = [
  // Precomputed once by a scheduled job and shared by every reader.
  'market_boards',
  'market_regime',
  'capture_views',
  'chart_workstation',
  'narratives_read',
  'watchlist',
  // Shared through the provider response cache AND capped by a dedicated daily
  // platform budget, which is why it is free without being precomputed. See
  // migration 20260920143000 and ./rwa-free-read.ts.
  'rwa_research',
  // Spends a provider credit, a model token or recurring evaluation per member.
  'research_on_demand',
  'investigation',
  'portfolio_valuation',
  'ai_generation',
  'market_history',
  'alert_evaluation',
  'agent_access',
  'wallet_watch',
  'thesis_journal',
  'comment_king',
] as const
export type IntelSurface = typeof INTEL_SURFACES[number]

/** A member who may use Investor Intel but not this part of it. Distinct from
 * OrgAuthzError so the product can render the locked surface rather than an
 * error banner, and so it can never be confused with a failed authorisation. */
export class IntelSurfaceLockedError extends Error {
  readonly status = 403
  readonly surface: string
  constructor(surface: string) {
    super('intel_surface_locked')
    this.name = 'IntelSurfaceLockedError'
    this.surface = surface
  }
}

/**
 * Refuse unless this member's tier reaches this surface.
 *
 * Call it immediately after requireIntelAccess and BEFORE the first line of
 * work that spends anything. Throws IntelSurfaceLockedError (403) when the tier
 * is short, and OrgAuthzError (503) when the decision itself could not be read:
 * an unreadable entitlement is never an accidental allow.
 */
export async function requireIntelSurface(
  // deno-lint-ignore no-explicit-any
  db: any,
  actor: OrgActor,
  surface: IntelSurface,
): Promise<void> {
  // A cron or service call has no member tier to check. This is the path the
  // capture and refresh jobs run on, which is what fills the free surfaces.
  if (actor.isService) return
  if (!actor.orgId) throw new OrgAuthzError('Forbidden.', 403)
  const { data, error } = await db.rpc('intel_surface_allowed', {
    p_user: actor.userId,
    p_org: actor.orgId,
    p_surface: surface,
  })
  if (error) throw new OrgAuthzError('Access verification unavailable.', 503)
  if (data !== true) throw new IntelSurfaceLockedError(surface)
}

/**
 * Does this member hold this surface? The same question requireIntelSurface
 * asks, answered without throwing.
 *
 * FOR CHOOSING A ROUTE, NEVER FOR OPENING ONE. The gate above stays the only
 * refusal: this exists so a handler that has already been admitted to a free
 * surface can ask whether the member ALSO holds the paid one, and take the
 * cheaper, bounded path when they do not.
 *
 * It fails CLOSED, unlike the client label: an unreadable decision answers
 * false, which routes the read onto the budgeted lane rather than the paid one.
 * The worst case of being wrong here is a member being served from the shared
 * cache when they were entitled to a live call, never the reverse.
 */
export async function intelSurfaceAllowed(
  // deno-lint-ignore no-explicit-any
  db: any,
  actor: OrgActor,
  surface: IntelSurface,
): Promise<boolean> {
  // A cron or service caller has no tier and runs the lanes that fill the free
  // surfaces, so it keeps the unbounded path, exactly as requireIntelSurface
  // lets it through.
  if (actor.isService) return true
  if (!actor.orgId) return false
  try {
    const { data, error } = await db.rpc('intel_surface_allowed', {
      p_user: actor.userId,
      p_org: actor.orgId,
      p_surface: surface,
    })
    return !error && data === true
  } catch { return false }
}

/**
 * Map a surface lock to its response, or return null so the caller falls
 * through to its existing handling.
 *
 * The body is the whole contract: an error code and the name of the surface
 * that was locked. Nothing that was withheld appears in it, and there is no
 * sample, preview or truncated form of the reading. The product renders its
 * locked state from this code plus the catalogue it already holds.
 */
export function surfaceLockedResponse(e: unknown, corsHeaders: Record<string, string>): Response | null {
  if (!(e instanceof IntelSurfaceLockedError)) return null
  return new Response(JSON.stringify({ error: 'intel_surface_locked', surface: e.surface }), {
    status: e.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  })
}
