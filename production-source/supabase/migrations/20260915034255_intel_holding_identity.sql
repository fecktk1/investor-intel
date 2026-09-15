-- ============================================================
-- Investor Intel — contract identity resolution for holdings (CMC plan proposal 25)
-- ============================================================
-- A wallet-synced holding arrives with a contract address and a chain but no
-- price: 98 open holdings were unpriced on 2026-09-15 (72 base, 9 bnb, 8
-- ethereum, 6 avalanche, 3 optimism). The Edge Function `intel-portfolio-identity`
-- asks CoinMarketCap's DEX batch endpoints about the ones that sit on a VERIFIED
-- DEX chain (ethereum, base, arbitrum, solana) and writes back the prices it is
-- given. bnb, avalanche and optimism are NOT verified CMC DEX platforms; those
-- holdings are reported `unsupported_platform` and are never guessed at.
--
-- This migration adds three small things and changes nothing that exists:
--
--   1. `intel_holding_resolution_runs` — the spending ledger that also enforces
--      the rate limit (four resolve runs per organisation per hour).
--   2. A partial index on the open book, so "which of this org's holdings are
--      unpriced" stops being a sequential scan on a table that only grows.
--   3. One `provider_schedule_policy` row, `feature = 'holding_identity'`, so
--      the scheduler can adopt this lane later WITHOUT another migration.
--
-- NO CRON JOB IS CREATED HERE, deliberately. The worker path is behind gate G2
-- and the Edge operation is on demand: a schedule row that no job reads is a
-- statement of intended cadence, not a running job. `app_private.intel_apply_plan_targets`
-- iterates its own fixed feature list, so this row is never rewritten by the
-- nightly plan pass; an operator edit to it stands.
--
-- WHO TRIGGERED A RUN IS NEVER STORED. The ledger has an org and counters and no
-- user column, and the function passes none — the same rule the execution plan's
-- decision 7 states for shared indexing ("only aggregate demand counters are
-- stored, never who searched"). Demand itself goes through the existing
-- `public.intel_record_asset_demand`, which has no actor argument at all.
--
-- Retention: a run row is six small columns and the rate limit caps them at four
-- per organisation per hour (about 35,000 a year for an organisation that runs
-- the button flat out, which is not a growth risk). The nightly
-- `app_private.intel_capture_retention` is therefore NOT restated here — every
-- restatement of that function is a merge hazard for whichever capture lane
-- restated it last, and this table does not need one.
--
-- Cost of one resolve run, probed 2026-09-14 (docs/investor-intel/evidence/
-- cmc-cost-probe-2026-09-14.json): `dexBatch` and `dexPriceBatch` each reported
-- credit_count 1 for a ONE-address request, so a 50-address run is 2 credits by
-- the probed FLOOR. The per-member curve is unmeasured; `cmc_request_reconcile`
-- books the real charge.
--
-- Safe to apply anytime; idempotent.
--
-- Rollback:
--   DROP TABLE public.intel_holding_resolution_runs;
--   DROP INDEX IF EXISTS public.investor_portfolio_holdings_org_price_status_idx;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature = 'holding_identity';
-- Nothing reads these three objects except `intel-portfolio-identity`; dropping
-- them disables the resolve button and leaves every holding exactly as it is.
-- Prices already written stay written: they are provider facts, not a feature flag.
-- ============================================================

-- ── 1. The run ledger, which is also the rate limiter ──
-- One row per paid run. `requested` is claimed BEFORE the provider is called so
-- two simultaneous presses cannot both pass the window check; `priced` and
-- `credits` are completed after. A run that asked about nothing is never
-- recorded, so the ledger is a spending record and not an activity log.
--
-- `credits` is the probed floor the function observed (one per provider call it
-- actually issued — a cached answer costs nothing and is recorded as nothing).
-- `credits > 0` alone would admit numeric 'NaN', which compares greater than
-- every finite value, so the finite bound is asserted as well.
CREATE TABLE IF NOT EXISTS public.intel_holding_resolution_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  ran_at timestamptz NOT NULL DEFAULT now(),
  requested integer NOT NULL DEFAULT 0 CHECK (requested >= 0 AND requested <= 100000),
  priced integer NOT NULL DEFAULT 0 CHECK (priced >= 0 AND priced <= 100000),
  credits numeric NOT NULL DEFAULT 0 CHECK (credits >= 0 AND 1e9 >= credits),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The rate-limit read is "this org's runs since one hour ago, oldest first".
CREATE INDEX IF NOT EXISTS intel_holding_resolution_runs_org_idx
  ON public.intel_holding_resolution_runs (org_id, ran_at DESC);

ALTER TABLE public.intel_holding_resolution_runs ENABLE ROW LEVEL SECURITY;
-- RLS on with no policy: the table is unreachable from the browser in either
-- direction. A member who could INSERT here could mint themselves unlimited
-- runs; a member who could SELECT could read another workspace's spending.
REVOKE ALL ON TABLE public.intel_holding_resolution_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_holding_resolution_runs TO service_role;

COMMENT ON TABLE public.intel_holding_resolution_runs IS
  'Paid contract-identity resolution runs per organisation: the spending ledger and the four-per-hour rate limit for intel-portfolio-identity. Deliberately has NO user column — a run is an organisation''s spending fact, never a record of who pressed the button.';

-- ── 2. The open-book read this feature makes constantly ──
-- "Every open holding of this org, by price status" is the coverage query and
-- the resolve query. The existing indexes on this table are (portfolio_id,
-- current_value), (org_id, user_id), (portfolio_id, canonical_asset_key),
-- (portfolio_id, is_closed, updated_at) and (portfolio_id, is_closed,
-- current_value, id) — all portfolio-first or user-first, none of which serves
-- an org-wide scan filtered by status. The partial predicate matches the
-- function's own filter exactly (a NULL `is_closed` on a legacy row means open).
CREATE INDEX IF NOT EXISTS investor_portfolio_holdings_org_price_status_idx
  ON public.investor_portfolio_holdings (org_id, price_status)
  WHERE is_closed IS NOT TRUE;

-- ── 3. The intended cadence for the lane ──
-- Daily. An existing row wins, so re-running this migration never resets an
-- operator's edit, and `min_plan = 'startup'` records the entitlement fact: every
-- CMC DEX capability is registered `tier:'startup'`, so a Basic key cannot run
-- this lane at all and the gate must fail closed rather than look enabled.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, reason) VALUES
  ('coinmarketcap', 'holding_identity', 86400, true, 'startup', 'contract identity and DEX pricing for unpriced portfolio holdings (on-demand Edge today; worker lane is behind gate G2)')
ON CONFLICT (provider, feature) DO NOTHING;
