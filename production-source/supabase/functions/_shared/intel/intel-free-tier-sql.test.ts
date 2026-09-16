// The free access level is defined in SQL, so its safety properties are
// asserted against the migration text the way the ForgeNotes row level security
// contracts are (see _shared/forgenotes-rls.test.ts). What matters here is not
// that the statements exist but that the ones which could quietly widen access,
// strand a paying member, or burn somebody's trial are absent.

import { assert, assertEquals } from 'jsr:@std/assert@1'

const sql = await Deno.readTextFile(
  new URL('../../../migrations/20260916114500_intel_free_tier_surface_access.sql', import.meta.url),
)

/** The body of one CREATE OR REPLACE FUNCTION, up to the next one. */
function functionBody(name: string, source: string = sql): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`
  const start = source.indexOf(marker)
  assert(start !== -1, `missing function ${name}`)
  const next = source.indexOf('CREATE OR REPLACE FUNCTION public.', start + marker.length)
  return source.slice(start, next === -1 ? source.length : next)
}

Deno.test('the free tier is seeded with a real zero on every key that spends per member', () => {
  for (const key of [
    'breakdowns_per_day', 'briefs_per_day', 'comparisons_per_day', 'explain_per_day',
    'comment_king_per_day', 'news_refreshes_per_day', 'portfolio_wallets',
    'narrative_follows', 'alerts_active', 'tracked_wallets', 'news_sources',
  ]) {
    assert(sql.includes(`('free','${key}',0)`), `free must be seeded 0 for ${key}`)
  }
  // And a genuine, non-zero allowance on the one key that is only a stored list.
  assert(sql.includes("('free','watchlist_items',10)"), 'a free member keeps a real watchlist')
})

Deno.test('the surface gate narrows the product gate and never widens it', () => {
  const body = functionBody('intel_surface_allowed')
  assert(body.includes('public.can_access_intel(p_user, p_org) IS NOT TRUE THEN RETURN false'),
    'the existing product gate is still asked first, and a false there ends it')
  assert(body.includes('IF NOT FOUND OR v_enabled IS NOT TRUE THEN RETURN false'),
    'an unlisted or disabled surface is refused rather than assumed free')
  assert(body.includes('RETURN public.intel_tier_rank(v_tier) >= public.intel_tier_rank(v_min)'),
    'the decision is a rank comparison against the catalogue minimum')
  // Nothing in the gate may hand back an allow by default.
  assert(!/RETURN true;\s*$/m.test(body.replace(/RETURN public\.intel_tier_rank[^;]*;/g, '')),
    'there is no unconditional allow in the gate')
})

Deno.test('an existing workspace keeps the access it has today because an unrecorded tier ranks at the top', () => {
  const rank = functionBody('intel_tier_rank')
  assert(rank.includes("WHEN 'free'    THEN 0"), 'free is the only narrowed rank')
  assert(rank.includes("WHEN 'trial'   THEN 3"), 'the 7 day trial keeps full product access')
  assert(rank.includes('ELSE 3'), 'an unknown or absent tier ranks at the top, never at the bottom')
  assert(rank.includes("coalesce(nullif(btrim(p_tier), ''), 'trial')"),
    'a missing tier reads as trial, matching what intel_limit_for already does')
})

Deno.test('a free workspace is never payment expired, so the product gate keeps answering true', () => {
  const body = functionBody('start_intel_free')
  // compute_org_payment_status only reports 'expired' when
  // payment_required_since is set and its grace has passed. Leaving both of
  // these NULL is what keeps a free member a member rather than a lapsed one.
  assert(body.includes('trial_ends_at, payment_required_since, payment_grace_days, plan_overrides'),
    'the insert names the payment columns explicitly')
  assert(body.includes('NULL, NULL, 0, jsonb_build_object(\'intel_tier\', \'free\')'),
    'no trial deadline and no payment deadline is recorded for a free workspace')
})

Deno.test('signing up free does not consume the one trial per identity', () => {
  const body = functionBody('start_intel_free')
  assert(!body.includes('intel_trial_guards'),
    'start_intel_free must not write the trial guard, or a free member could never take their trial')
  assert(body.includes("o.product_mode = 'intel'") && body.includes('RETURN v_org'),
    'an existing Investor Intel workspace is handed back rather than duplicated')
})

Deno.test('the catalogue cannot drift from the reason a surface is where it is', () => {
  assert(sql.includes('CONSTRAINT intel_surface_tiers_cost_matches_gate CHECK'),
    'the cost basis and the gate are held consistent by a constraint')
  assert(sql.includes("(cost_basis = 'precomputed_shared'   AND min_tier = 'free')"),
    'work already done for everyone cannot be sold')
  assert(sql.includes("(cost_basis = 'per_member_on_demand' AND min_tier <> 'free')"),
    'work done for one member cannot be given away')
})

Deno.test('the split names the surfaces that spend and the surfaces that do not', () => {
  for (const surface of ['market_boards', 'market_regime', 'capture_views', 'chart_workstation', 'narratives_read', 'watchlist']) {
    assert(sql.includes(`('${surface}',       'free',    'precomputed_shared',`) || sql.includes(`('${surface}',   'free',    'precomputed_shared',`) || sql.includes(`('${surface}',     'free',    'precomputed_shared',`) || sql.includes(`('${surface}',           'free',    'precomputed_shared',`),
      `${surface} must be seeded as free and precomputed`)
  }
  for (const surface of ['research_on_demand', 'investigation', 'portfolio_valuation', 'ai_generation', 'market_history', 'alert_evaluation']) {
    assert(sql.includes(`'${surface}'`) && sql.includes('per_member_on_demand'), `${surface} must be seeded as on demand`)
  }
})

Deno.test('the catalogue is readable by members and writable only by the service role', () => {
  assert(sql.includes('GRANT SELECT ON TABLE public.intel_surface_tiers TO authenticated'),
    'a member may read the price list so the product can label a lock honestly')
  assert(sql.includes('REVOKE ALL ON TABLE public.intel_surface_tiers FROM PUBLIC, anon'),
    'the catalogue is not anonymous')
  assert(sql.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_surface_tiers TO service_role'))
  assert(sql.includes('ALTER TABLE public.intel_surface_tiers ENABLE ROW LEVEL SECURITY'))
})

Deno.test('the entitlement functions are closed to anonymous callers', () => {
  for (const fn of [
    'public.intel_tier_rank(text)',
    'public.intel_surface_allowed(uuid,uuid,text)',
    'public.intel_account_access(uuid)',
    'public.start_intel_free(text)',
  ]) {
    assert(sql.includes(`REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC, anon`), `${fn} must be revoked from anon`)
  }
  // The operator downgrade is service_role only: converting a lapsed trial into
  // a free membership has billing consequences and is nobody's self-service.
  assert(sql.includes('REVOKE EXECUTE ON FUNCTION public.intel_set_free_tier(uuid) FROM PUBLIC, anon, authenticated'))
  assert(sql.includes('GRANT EXECUTE ON FUNCTION public.intel_set_free_tier(uuid) TO service_role'))
})

Deno.test('the operator downgrade refuses a paying workspace and runs on no schedule', () => {
  const body = functionBody('intel_set_free_tier')
  assert(body.includes("status = 'active'") && body.includes('RETURN false'),
    'a workspace with an active subscription is never moved to the free tier')
  assert(!sql.includes('cron.schedule'), 'nothing here converts workspaces automatically')
})

Deno.test('no existing entitlement function is redefined by this migration', () => {
  // The 16 SQL guards that call can_access_intel must keep the definition they
  // were reviewed against. This migration layers beside it, never over it.
  for (const fn of ['can_access_intel', 'compute_org_payment_status', 'intel_limit_for', 'intel_limit', 'start_intel_trial']) {
    assert(!sql.includes(`FUNCTION public.${fn}(`) && !sql.includes(`FUNCTION ${fn}(`),
      `${fn} must not be redefined here`)
  }
  assertEquals(sql.includes('DROP FUNCTION'), false, 'nothing existing is dropped')
})

// The second pass (20260916190000) moves four more surfaces behind Starter and
// adds the two database backstops for the ones a member can reach by writing a
// row directly. Read whitespace-tolerantly: the seed is column-aligned, so the
// gaps between the literals are formatting and must not be part of the contract.
const more = await Deno.readTextFile(
  new URL('../../../migrations/20260916190000_intel_free_tier_more_surfaces.sql', import.meta.url),
)
/** Collapse runs of whitespace so an alignment change cannot fail a test. */
const flat = more.replace(/\s+/g, ' ')

Deno.test('the four added surfaces are seeded behind Starter and priced as on demand', () => {
  for (const surface of ['agent_access', 'wallet_watch', 'thesis_journal', 'comment_king']) {
    assert(flat.includes(`('${surface}', 'starter', 'per_member_on_demand',`),
      `${surface} must be seeded starter and per_member_on_demand`)
  }
  assert(flat.includes('ON CONFLICT (surface) DO NOTHING'),
    'a replay must not snap an operator edit back to this file')
  // Free is the one value the table constraint refuses beside per_member_on_demand,
  // so nothing added here may claim to be precomputed.
  assert(!more.includes('precomputed_shared'), 'none of the four is shared work already done')
})

Deno.test('the Thesis Journal backstop gates a member write without touching cron or service role', () => {
  const body = functionBody('tg_intel_thesis_surface_gate', more)
  assert(body.includes('SECURITY DEFINER'),
    'the three argument oracle is service_role only, so the trigger must own the call')
  assert(body.includes('IF auth.uid() IS NULL THEN RETURN NEW; END IF;'),
    'no session means service role or cron, which have no tier and must not be gated')
  assert(body.includes("IS DISTINCT FROM 'intel' THEN RETURN NEW"),
    'a workspace that is not Investor Intel has no Investor Intel tier')
  assert(body.includes("public.intel_surface_allowed(auth.uid(), NEW.org_id, 'thesis_journal')"),
    'the identity asked about is the caller own, never one the row supplied')
  assert(body.includes("RAISE EXCEPTION 'intel_surface_locked:thesis_journal'"),
    'a locked member is refused with the surface named')
})

Deno.test('both thesis tables are gated, before insert only, and idempotently', () => {
  for (const table of ['public.intel_theses', 'public.intel_trades']) {
    assert(flat.includes(`BEFORE INSERT ON ${table}`), `${table} must be gated on insert`)
  }
  for (const trigger of ['trg_intel_theses_surface_gate', 'trg_intel_trades_surface_gate']) {
    assert(more.includes(`DROP TRIGGER IF EXISTS ${trigger}`), `${trigger} must be created idempotently`)
    assert(more.includes(`CREATE TRIGGER ${trigger}`))
  }
  // AFTER, UPDATE or DELETE would let a narrowed tier prune rows that already
  // exist, which is the one thing every limit trigger in this codebase avoids.
  assert(!/BEFORE (UPDATE|DELETE)|AFTER (INSERT|UPDATE|DELETE)/.test(more),
    'nothing here fires on update or delete')
})

Deno.test('the wallet backstop is added to the limit trigger without dropping what it already enforced', () => {
  const body = functionBody('tg_intel_watchlist_limit', more)
  assert(body.includes("IF NEW.item_type = 'wallet' THEN"), 'the wallet branch is still the wallet branch')
  assert(body.includes("auth.uid() IS NOT NULL AND NOT public.intel_surface_allowed(auth.uid(), NEW.org_id, 'wallet_watch')"),
    'a signed-in member is checked and a cron write is not')
  assert(body.includes("RAISE EXCEPTION 'intel_surface_locked:wallet_watch'"))
  // Everything the live definition already did must survive the replace.
  assert(body.includes("intel_limit_reached:watchlist_items"), 'the watchlist ceiling is preserved')
  assert(body.includes("intel_limit_reached:tracked_wallets"), 'the tracked wallet ceiling is preserved')
  assert(body.includes("authorize_intel_limit(auth.uid(), NEW.org_id, 'watchlist_items')"))
  assert(body.includes("authorize_intel_limit(auth.uid(), NEW.org_id, 'tracked_wallets')"))
  assert(body.includes("IS DISTINCT FROM 'intel' THEN RETURN NEW"), 'the product_mode early return is preserved')
})

Deno.test('the second pass redefines no entitlement function and drops nothing', () => {
  for (const fn of ['can_access_intel', 'intel_surface_allowed', 'intel_tier_rank', 'intel_account_access', 'intel_set_free_tier']) {
    assert(!more.includes(`CREATE OR REPLACE FUNCTION public.${fn}(`), `${fn} must not be redefined here`)
  }
  assertEquals(more.includes('DROP FUNCTION'), false, 'no function is dropped')
  assertEquals(more.includes('DROP TABLE'), false, 'no table is dropped')
})
