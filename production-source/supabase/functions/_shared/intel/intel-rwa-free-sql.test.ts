// The free real-world-asset surface and its daily budget are defined in SQL, so
// their safety properties are asserted against the migration text, exactly as
// ./intel-free-tier-sql.test.ts does for the original split. What matters is not
// that the statements exist but that the ones which could quietly widen access,
// hand out an unbounded budget, or let a member spend the platform's day are
// absent.

import { assert, assertEquals } from 'jsr:@std/assert@1'

const sql = await Deno.readTextFile(
  new URL('../../../migrations/20260920143000_intel_rwa_research_free_surface.sql', import.meta.url),
)

Deno.test('the migration is replay safe and bounds its own locking', () => {
  assert(sql.includes("SET LOCAL lock_timeout = '5s'"), 'a queued DDL lock must not stall readers indefinitely')
  assert(sql.includes('DROP CONSTRAINT IF EXISTS intel_surface_tiers_cost_matches_gate'),
    'the constraint swap is a drop-if-exists then an add, so a replay is a no-op')
  assert(sql.includes('CREATE OR REPLACE FUNCTION public.intel_free_rwa_read_claim'),
    'the claim function is CREATE OR REPLACE')
  // Every seed is DO NOTHING, so a replay never resets an operator's edit. That
  // is the same rule the original catalogue migration states for itself.
  assertEquals(sql.match(/ON CONFLICT[^\n]*DO NOTHING/g)?.length, 3,
    'the surface row, the policy row and the daily row are all DO NOTHING')
  assert(!/ON CONFLICT[^\n]*DO UPDATE/.test(sql), 'nothing here hard-resets a row it did not create')
})

Deno.test('the widened cost basis cannot be used to sell something', () => {
  // The new basis is pinned to free in the same way the other two are pinned.
  assert(sql.includes("(cost_basis = 'shared_budgeted'      AND min_tier = 'free')"),
    'shared_budgeted may only ever be free')
  // And the two existing branches are carried over verbatim, so the widening
  // does not quietly drop a rule while adding one.
  assert(sql.includes("(cost_basis = 'precomputed_shared'   AND min_tier = 'free')"))
  assert(sql.includes("(cost_basis = 'per_member_on_demand' AND min_tier <> 'free')"))
  // There is no branch that lets a paid tier carry a free cost basis, or a free
  // tier carry the on-demand one.
  assert(!sql.includes("cost_basis = 'shared_budgeted'      AND min_tier <> 'free'"))
})

Deno.test('exactly one surface is added, on the free tier, and nothing existing is rewritten', () => {
  assert(sql.includes("('rwa_research', 'free', 'shared_budgeted',"), 'the new surface is free and budgeted')
  const inserts = sql.match(/INSERT INTO public\.intel_surface_tiers/g) || []
  assertEquals(inserts.length, 1, 'one insert, one surface')
  // research_on_demand keeps its row, its tier and its reason: the other three
  // workspaces of the same page must be refused for a free member exactly as
  // they are today.
  assert(!/UPDATE\s+public\.intel_surface_tiers/i.test(sql), 'no existing catalogue row is moved')
  assert(!/DELETE\s+FROM\s+public\.intel_surface_tiers/i.test(sql), 'no existing catalogue row is removed')
  assert(!sql.includes("'research_on_demand'"), 'the paid surface is not touched')
})

Deno.test('the daily cap is data, not a constant in the function', () => {
  assert(sql.includes("'cmc_free_rwa_policy'"), 'the cap lives in its own policy row')
  assert(sql.includes("jsonb_build_object('daily_credit_cap', '200', 'enabled', 'true')"),
    'the conservative default is seeded as a row an operator can UPDATE')
  const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.intel_free_rwa_read_claim'))
  assert(body.includes("v_policy.config->>'daily_credit_cap'"), 'the function reads the cap from the row')
  // No number in the function may stand in for the cap.
  assert(!/v_cap\s*:=\s*\d/.test(body.replace(/v_cap := 0;/g, '')), 'the cap is never hardcoded')
})

Deno.test('the claim fails closed on every path, because an unreadable budget is not an unlimited one', () => {
  const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.intel_free_rwa_read_claim'))
  for (const refusal of [
    "'free_rwa_policy_unavailable'",     // no policy row at all
    "'free_rwa_lane_disabled'",          // operator kill switch, no deploy needed
    "'free_rwa_budget_exhausted'",       // a spent day, and a zero or unreadable cap
    "'invalid_budget'",                  // a negative, absurd or missing charge
  ]) {
    assert(body.includes(refusal), `the claim must be able to answer ${refusal}`)
  }
  assert(body.includes('IF v_cap IS NULL OR v_cap <= 0 THEN'), 'a zero or absent cap refuses')
  assert(body.includes('EXCEPTION WHEN others THEN') && body.includes('v_cap := 0;'),
    'an unparseable cap becomes zero, never unlimited')
  assert(body.includes('p_credits > 25'), 'a caller cannot charge an arbitrary amount')
  // The only allow in the function is the last one, after the cap comparison.
  assert(body.includes("IF v_day.credits_used + p_credits > v_cap THEN"), 'the cap is compared before the charge')
  assertEquals(body.match(/'allowed', true/g)?.length, 1, 'there is exactly one allow, and it is the last branch')
})

Deno.test('the charge is taken under a row lock so concurrent readers cannot both pass a spent cap', () => {
  const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.intel_free_rwa_read_claim'))
  assert(body.includes('FOR UPDATE'), 'the daily row is locked before it is read and charged')
  assert(body.includes('SET credits_used = credits_used + p_credits'),
    'the charge is relative to the locked row, never a value read earlier')
  assert(body.includes("date_trunc('day', now() AT TIME ZONE 'UTC')"),
    'the window is a UTC day, so it does not move with a server locale')
})

Deno.test('no member may call the claim, or one signed-in account could burn the whole day', () => {
  assert(sql.includes('REVOKE EXECUTE ON FUNCTION public.intel_free_rwa_read_claim(text, numeric) FROM PUBLIC, anon, authenticated'),
    'the claim is revoked from anon AND from authenticated')
  assert(sql.includes('GRANT EXECUTE ON FUNCTION public.intel_free_rwa_read_claim(text, numeric) TO service_role'),
    'only the service role, which is the Edge Function after it verified a JWT')
  assert(!/GRANT EXECUTE ON FUNCTION public\.intel_free_rwa_read_claim[^\n]*authenticated/.test(sql))
})

/** The migration with its prose removed: `--` commentary and the COMMENT ON
 * bodies. Several of the names the next test forbids are DISCUSSED there on
 * purpose, because that is where the reasoning lives, so the assertion has to
 * look at the statements that actually change something. */
const statements = sql
  .replace(/^\s*--.*$/gm, '')
  .replace(/\s--.*$/gm, '')
  .replace(/COMMENT ON [\s\S]*?;\s*$/gm, '')

Deno.test('the free budget only ever subtracts: it cannot raise the account ceiling', () => {
  // Nothing here touches the monthly credit row, the feature cap row, the rate
  // limiter or the reservation ledger. cmc_request_reserve still runs on every
  // live call and still refuses on the monthly cap, the rwa feature cap and the
  // rate limit, whatever this budget said.
  for (const untouched of ['cmc_credits', 'cmc_feature_credit', 'cmc_request_reserve', 'cmc_request_reconcile',
    'provider_budget_reservations', 'cmc_take_rate', 'market_data_providers', 'cmc_account',
    'cmc_operating_profile', 'market_data_response_cache', 'intel_surface_allowed', 'can_access_intel',
    'intel_tier_rank', 'intel_plan_limits', 'orgs', 'org_members']) {
    assert(!statements.includes(untouched), `${untouched} must not be written by the free lane`)
  }
  assert(!/ALTER TABLE public\.provider_quota_budgets/i.test(statements), 'the ledger keeps its shape')
  // The only rows it writes are its own two data types.
  const writes = statements.match(/(INSERT INTO|UPDATE)\s+(public\.)?provider_quota_budgets/g) || []
  assertEquals(writes.length, 3, 'one policy seed, one daily upsert and one charge')
  for (const type of ['cmc_free_rwa_policy', 'cmc_free_rwa_daily']) assert(statements.includes(type))
})
