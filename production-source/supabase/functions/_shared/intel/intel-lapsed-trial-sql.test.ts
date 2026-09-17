// The lapsed-trial fallback is defined in SQL, so its safety properties are
// asserted against the migration text the way intel-free-tier-sql.test.ts
// asserts the free tier's. What matters is not that the statements exist but
// that the ones which could narrow an ACTIVE trial, downgrade a paying
// workspace, catch a holder, or delete a member's rows are absent.

import { assert, assertEquals } from 'jsr:@std/assert@1'

const sql = await Deno.readTextFile(
  new URL('../../../migrations/20260917073500_intel_lapsed_trial_free_fallback.sql', import.meta.url),
)

/** The body of one CREATE OR REPLACE FUNCTION, up to the next one. */
function functionBody(name: string): string {
  // The open paren is part of the marker on purpose: without it, intel_limit
  // would match intel_limit_for and the two ladders would test as one.
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`
  const start = sql.indexOf(marker)
  assert(start !== -1, `missing function ${name}`)
  const next = sql.indexOf('CREATE OR REPLACE FUNCTION public.', start + marker.length)
  return sql.slice(start, next === -1 ? sql.length : next)
}

Deno.test('the migration takes the lock timeout every migration in this set takes', () => {
  assert(sql.includes("SET LOCAL lock_timeout = '5s'"), 'a long lock on orgs is never worth a deploy')
})

Deno.test('the lapse is read from the deadline, never from an absent tier', () => {
  const body = functionBody('intel_trial_lapsed')
  // THE property this whole migration turns on. intel_tier_rank reads a NULL
  // tier as 'trial' and ranks it at the top, which is the only reason a
  // workspace in its first seven days has the product at all. Keying the
  // fallback off the absence instead of the deadline would narrow every one of
  // them to the six free surfaces.
  assert(body.includes('IF v_trial IS NULL OR v_trial > now() THEN RETURN false; END IF;'),
    'a trial whose deadline has not passed is never lapsed')
  assert(!sql.includes('CREATE OR REPLACE FUNCTION public.intel_tier_rank'),
    'intel_tier_rank keeps the definition an active trial depends on')
  assert(!sql.includes("WHEN 'trial'"), 'nothing here re-ranks the trial tier')
})

Deno.test('nothing that was bought, held or outside Investor Intel is caught', () => {
  const body = functionBody('intel_trial_lapsed')
  assert(body.includes("IF v_stored IN ('starter', 'pro', 'elite') THEN RETURN false; END IF;"),
    'a paid tier is excluded by name, so no paying workspace is downgraded')
  assert(body.includes("IF v_mode IS DISTINCT FROM 'intel' THEN RETURN false; END IF;"),
    'a workspace that is not Investor Intel has no Investor Intel tier to fall to')
  assert(body.includes("public.sparq_is_holder_workspace(p_org, 'intel')") && body.includes('RETURN false'),
    'a holder workspace is entitled through its holding, not a trial')
  assert(body.includes("RETURN v_status = 'expired';"),
    "'grace' still has time left and 'deleted' is not a lapse")
})

Deno.test('the product gate widens only for a workspace that actually lapsed', () => {
  const body = functionBody('can_access_intel')
  assert(body.includes("IF v_mode = 'intel' AND v_status = 'expired' THEN"),
    'the new branch is reached only from the expired state it exists to rescue')
  assert(body.includes('IF public.intel_trial_lapsed(p_org, v_status) THEN RETURN true; END IF;'),
    'and only when the lapse test says so')
  // The answer it had before must survive underneath the new branch.
  assert(body.includes("RETURN (v_mode = 'intel' AND v_status NOT IN ('expired','deleted')) OR sparq_intel_access(p_user, p_org);"),
    'the previous decision is preserved verbatim as the fallthrough')
  assert(body.includes("IF sparq_is_holder_workspace(p_org, 'intel') THEN RETURN sparq_intel_access(p_user, p_org); END IF;"),
    'the holder branch still answers first, exactly as it did')
})

Deno.test('the gate, the label and the volume ladder all read one tier', () => {
  // Three readers that could otherwise tell one workspace three different
  // stories about what it is.
  assert(functionBody('intel_surface_allowed').includes('v_tier := public.intel_effective_tier(p_org);'),
    'the per surface gate reads the effective tier')
  assert(functionBody('intel_account_access').includes("v_tier := coalesce(public.intel_effective_tier(p_org), 'trial');"),
    'the label the product renders reads the same tier')
  assert(functionBody('intel_limit_for').includes("v_tier := coalesce(public.intel_effective_tier(p_org), 'trial');"),
    'the per org volume ladder reads the same tier')
  assert(functionBody('intel_limit').includes("v_tier := coalesce(public.intel_effective_tier(v_org), 'trial');"),
    'the caller volume ladder reads the same tier')
  // No caller may go back to reading the raw column, or the fallback would be
  // invisible to it.
  assert(!sql.includes("coalesce(plan_overrides->>'intel_tier'"),
    'no reader falls back to the stored tier behind intel_effective_tier')
})

Deno.test('the per key override still wins over the tier ladder', () => {
  for (const fn of ['intel_limit_for', 'intel_limit']) {
    const body = functionBody(fn)
    const override = body.indexOf('IF v_over ? p_key THEN')
    const ladder = body.indexOf('intel_plan_limits')
    assert(override !== -1 && ladder !== -1 && override < ladder,
      `${fn} must answer an explicit per workspace override before it reads any ladder`)
  }
})

Deno.test('nothing is deleted, dropped or rewritten', () => {
  for (const statement of ['DROP FUNCTION', 'DROP TABLE', 'DROP POLICY', 'DELETE FROM', 'UPDATE public.orgs', 'UPDATE orgs', 'cron.schedule']) {
    assertEquals(sql.includes(statement), false, `${statement} has no business in this migration`)
  }
  // It changes what the existing readers answer, and touches no row of member
  // data on its way past.
  assertEquals(sql.includes('INSERT INTO'), false, 'nothing is seeded here')
})

Deno.test('the two new readers are closed to anonymous and to signed-in callers', () => {
  // Both take an org id and would otherwise answer the billing posture of any
  // workspace to anyone who could name one. Every caller that needs them is a
  // SECURITY DEFINER function, which executes as the owner.
  for (const fn of ['public.intel_trial_lapsed(uuid, text)', 'public.intel_effective_tier(uuid)']) {
    assert(sql.includes(`REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated`), `${fn} must be revoked`)
    assert(sql.includes(`GRANT EXECUTE ON FUNCTION ${fn} TO service_role`), `${fn} is service role only`)
  }
})

Deno.test('compute_org_payment_status keeps its definition', () => {
  // Every non Intel consumer of the payment status reads it, so the fallback
  // is expressed beside it rather than inside it.
  assert(!sql.includes('FUNCTION public.compute_org_payment_status('),
    'the shared payment status must not be redefined by an Investor Intel change')
})
