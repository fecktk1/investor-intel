-- Investor Intel: four more surfaces move behind Starter, plus two database backstops.
--
-- WHY THESE FOUR
--
-- 20260916114500 drew the line once: a surface stays free when serving it to one
-- more member costs nothing extra, because a scheduled job already did the work
-- for everybody. A surface is sold when the asking member's request is what
-- causes the spend. The four surfaces added here were left off that first pass
-- and all four sit firmly on the spending side.
--
--   agent_access   Minting or approving an agent token opens per-member on demand
--                  reads and writes through intel-agent-api, so the token is a
--                  standing licence to spend rather than a one time action.
--   wallet_watch   A wallet read is a fresh provider request for the asking
--                  member: nothing precomputed answers "what is in this wallet
--                  right now".
--   thesis_journal intel-thesis drafts, critiques and evaluates for the asking
--                  member on demand, spending model tokens and evidence pack
--                  assembly per thesis.
--   comment_king   intel-comment calls the model for the asking member, one
--                  draft per request.
--
-- Every row is cost_basis 'per_member_on_demand', which the table's existing
-- CHECK constraint requires of any non free min_tier, and every row is inserted
-- ON CONFLICT DO NOTHING for the reason 20260916114500 already gives: the split
-- lives in rows, so a replay must never snap an operator's edit back to this file.
--
-- THE TWO BACKSTOPS, AND WHY ONLY TWO
--
-- The edge functions are the primary gate: intel-agent-api, intel-thesis,
-- intel-comment and intel-generate all call requireIntelSurface before the first
-- line of work that spends anything. Two of the four surfaces can also be
-- reached by a member writing a row directly through PostgREST, which no edge
-- function sees, so those two get a trigger that asks the same question in SQL:
--
--   * thesis_journal  A new BEFORE INSERT trigger on intel_theses and
--                     intel_trades, both of which carry org_id and both of which
--                     RLS lets a member INSERT into directly.
--   * wallet_watch    The existing watchlist limit trigger gains one check, so
--                     a free member cannot add a wallet row and then have the
--                     rest of the product read it for them.
--
-- agent_access and comment_king need no trigger: neither has a member writable
-- table that starts the spend. Token rows are written only by the service role
-- inside intel-agent-api, and a comment draft is a model call with no row a
-- member could insert to trigger it.
--
-- Both backstops are deliberately blind to service role and cron callers. A
-- trigger that fired on those would break the capture and refresh jobs, which is
-- exactly the mistake requireIntelSurface avoids by returning early for
-- actor.isService. auth.uid() IS NULL is that same test in SQL: no session, no
-- member action, no gate. The org's product_mode is checked next so nothing here
-- touches a content or realty workspace.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- SECTION 1: the four catalogue rows.
INSERT INTO public.intel_surface_tiers (surface, min_tier, cost_basis, reason) VALUES
  ('agent_access',   'starter', 'per_member_on_demand',
   'Minting or approving an agent token opens per-member on-demand reads and writes through intel-agent-api.'),
  ('wallet_watch',   'starter', 'per_member_on_demand',
   'A wallet read is a fresh provider request for the asking member.'),
  ('thesis_journal', 'starter', 'per_member_on_demand',
   'intel-thesis drafts, critiques and evaluates for the asking member on demand.'),
  ('comment_king',   'starter', 'per_member_on_demand',
   'intel-comment calls the model for the asking member.')
-- DO NOTHING, matching the 12 rows 20260916114500 seeded. Moving a surface
-- between tiers stays a reviewed migration that UPDATEs the row it means to move.
ON CONFLICT (surface) DO NOTHING;

-- SECTION 2: the Thesis Journal backstop.
-- A member can INSERT into intel_theses and intel_trades through PostgREST
-- without intel-thesis ever running, so the tier question is asked again here.
-- SECURITY DEFINER because intel_surface_allowed(uuid,uuid,text) is granted to
-- service_role only: the trigger owner reaches it, the calling member does not,
-- and the member still cannot call it about anybody but themselves because the
-- p_user handed over is auth.uid() and nothing else.
CREATE OR REPLACE FUNCTION public.tg_intel_thesis_surface_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- No session means service role or pg_cron. Those are not member actions and
  -- have no tier to check; gating them would stop the scheduled work.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- Only Investor Intel workspaces have an Investor Intel tier.
  IF (SELECT product_mode FROM orgs WHERE id = NEW.org_id) IS DISTINCT FROM 'intel' THEN RETURN NEW; END IF;
  IF NOT public.intel_surface_allowed(auth.uid(), NEW.org_id, 'thesis_journal') THEN
    RAISE EXCEPTION 'intel_surface_locked:thesis_journal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION public.tg_intel_thesis_surface_gate() IS
  'BEFORE INSERT gate for the Thesis Journal surface. Refuses a member whose Investor Intel tier does not reach thesis_journal, and passes service role and cron writes straight through.';
REVOKE EXECUTE ON FUNCTION public.tg_intel_thesis_surface_gate() FROM PUBLIC, anon;

-- BEFORE INSERT only, matching the limit triggers in 139 and 207: a narrowed
-- tier must never be able to delete or prune a thesis that already exists.
DROP TRIGGER IF EXISTS trg_intel_theses_surface_gate ON public.intel_theses;
CREATE TRIGGER trg_intel_theses_surface_gate
  BEFORE INSERT ON public.intel_theses
  FOR EACH ROW EXECUTE FUNCTION public.tg_intel_thesis_surface_gate();

DROP TRIGGER IF EXISTS trg_intel_trades_surface_gate ON public.intel_trades;
CREATE TRIGGER trg_intel_trades_surface_gate
  BEFORE INSERT ON public.intel_trades
  FOR EACH ROW EXECUTE FUNCTION public.tg_intel_thesis_surface_gate();

-- SECTION 3: the Wallet Watch backstop.
-- This is the LIVE production definition of tg_intel_watchlist_limit with one
-- check added, not a replay of an older migration's copy. Everything it already
-- did is preserved exactly: the product_mode early return, the watchlist_items
-- ceiling, and the tracked_wallets ceiling inside the wallet branch. The new
-- check sits at the top of the wallet branch so a locked member is refused
-- before the count is even taken, and it is skipped when auth.uid() is NULL for
-- the same reason section 2 skips it.
CREATE OR REPLACE FUNCTION public.tg_intel_watchlist_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_lim numeric; v_cnt int;
BEGIN
  IF (SELECT product_mode FROM orgs WHERE id = NEW.org_id) IS DISTINCT FROM 'intel' THEN RETURN NEW; END IF;
  v_lim := authorize_intel_limit(auth.uid(), NEW.org_id, 'watchlist_items');
  IF v_lim IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM watchlist_items WHERE org_id = NEW.org_id;
    IF v_cnt >= v_lim THEN RAISE EXCEPTION 'intel_limit_reached:watchlist_items' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF NEW.item_type = 'wallet' THEN
    IF auth.uid() IS NOT NULL AND NOT public.intel_surface_allowed(auth.uid(), NEW.org_id, 'wallet_watch') THEN
      RAISE EXCEPTION 'intel_surface_locked:wallet_watch' USING ERRCODE = 'check_violation';
    END IF;
    v_lim := authorize_intel_limit(auth.uid(), NEW.org_id, 'tracked_wallets');
    IF v_lim IS NOT NULL THEN
      SELECT count(*) INTO v_cnt FROM watchlist_items WHERE org_id = NEW.org_id AND item_type = 'wallet';
      IF v_cnt >= v_lim THEN RAISE EXCEPTION 'intel_limit_reached:tracked_wallets' USING ERRCODE = 'check_violation'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
COMMENT ON FUNCTION public.tg_intel_watchlist_limit() IS
  'BEFORE INSERT gate for watchlist_items: the watchlist_items and tracked_wallets ceilings, plus the wallet_watch surface check for a signed-in member. Service role and cron writes pass through.';
