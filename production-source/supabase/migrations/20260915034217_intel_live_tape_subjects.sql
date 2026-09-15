-- Live on-chain tape (CMC plan Stage 4, proposal 28): the shared live-focus
-- lease learns a second subject grammar, `contract:<platform>:<address>`, for
-- the four verified CoinMarketCap DEX platforms. Nothing else changes: the same
-- 45-second lease, the same three-subject and twelve-row per-owner limits, the
-- same membership and entitlement checks, and `intel_live_focus_plan()` keeps
-- its exact shape and ordering so an already-released worker reading this table
-- is unaffected. Contract subjects stay dormant until the owner enables the
-- on-chain channels after the worker release gate (G2).
-- Rollback: docs/investor-intel/live-on-chain-tape.md.
SET lock_timeout='5s';
SET statement_timeout='30s';
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.intel_live_focus_touch(uuid,uuid,text,boolean,uuid)'::regprocedure)) <> '3cda1f1fd3b19244ad6863c102414d18'
 OR md5(pg_get_functiondef('public.intel_live_focus_touch(uuid,uuid,text,boolean)'::regprocedure)) <> '3f78a67cb9bbec73399718099c93e7de'
 OR md5(pg_get_functiondef('public.intel_live_focus_plan()'::regprocedure)) <> '2c6e64095eb2016d83447b18cfcab81f'
 THEN RAISE EXCEPTION 'unreviewed_live_focus_definition'; END IF;
END $$;

-- One grammar, restated identically in the CHECK and in the touch RPC. EVM
-- addresses are lowercase only, so one contract is exactly one subject and one
-- shared subscription; a checksum-cased address is rejected, never silently
-- folded into a second lease.
ALTER TABLE public.intel_live_focus_demands DROP CONSTRAINT intel_live_focus_demands_subject_check,
 ADD CONSTRAINT intel_live_focus_demands_subject_check CHECK(subject ~ '^(market:coinmarketcap:[1-9][0-9]{0,11}|contract:(ethereum|base|arbitrum):0x[0-9a-f]{40}|contract:solana:[1-9A-HJ-NP-Za-km-z]{32,44})$');

CREATE OR REPLACE FUNCTION public.intel_live_focus_touch(p_org uuid,p_user uuid,p_subject text,p_enabled boolean,p_view uuid)
RETURNS timestamptz LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE until timestamptz;
BEGIN
 IF p_view IS NULL OR p_enabled IS NULL OR p_subject IS NULL OR p_subject !~ '^(market:coinmarketcap:[1-9][0-9]{0,11}|contract:(ethereum|base|arbitrum):0x[0-9a-f]{40}|contract:solana:[1-9A-HJ-NP-Za-km-z]{32,44})$' THEN RAISE EXCEPTION 'invalid_live_focus'; END IF;
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=p_org AND user_id=p_user) OR public.can_access_intel(p_user,p_org) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text||':'||p_user::text,0));
 until:=clock_timestamp()+interval '45 seconds';
 DELETE FROM public.intel_live_focus_demands WHERE org_id=p_org AND user_id=p_user AND expires_at<=clock_timestamp();
 IF NOT p_enabled THEN DELETE FROM public.intel_live_focus_demands WHERE org_id=p_org AND user_id=p_user AND subject=p_subject AND view_id=p_view; RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.intel_live_focus_demands WHERE org_id=p_org AND user_id=p_user AND subject=p_subject)
  AND (SELECT count(DISTINCT subject) FROM public.intel_live_focus_demands WHERE org_id=p_org AND user_id=p_user)>=3 THEN RAISE EXCEPTION 'live_focus_asset_limit'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.intel_live_focus_demands WHERE org_id=p_org AND user_id=p_user AND subject=p_subject AND view_id=p_view)
  AND (SELECT count(*) FROM public.intel_live_focus_demands WHERE org_id=p_org AND user_id=p_user)>=12 THEN RAISE EXCEPTION 'live_focus_view_limit'; END IF;
 INSERT INTO public.intel_live_focus_demands(org_id,user_id,subject,view_id,expires_at) VALUES(p_org,p_user,p_subject,p_view,until)
 ON CONFLICT(org_id,user_id,subject,view_id) DO UPDATE SET expires_at=excluded.expires_at,requested_at=clock_timestamp();
 RETURN until;
END $$;
REVOKE ALL ON FUNCTION public.intel_live_focus_touch(uuid,uuid,text,boolean,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_live_focus_touch(uuid,uuid,text,boolean,uuid) TO service_role;

-- Old clients retain one explicitly separate legacy lease. No tab can release
-- another lease and all leases still share the existing server subscription.
CREATE OR REPLACE FUNCTION public.intel_live_focus_touch(p_org uuid,p_user uuid,p_subject text,p_enabled boolean)
RETURNS timestamptz LANGUAGE sql SECURITY INVOKER SET search_path=public AS $$
 SELECT public.intel_live_focus_touch(p_org,p_user,p_subject,p_enabled,'00000000-0000-0000-0000-000000000000'::uuid)
$$;
REVOKE ALL ON FUNCTION public.intel_live_focus_touch(uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_live_focus_touch(uuid,uuid,text,boolean) TO service_role;

-- Restated unchanged: same columns, same viewer counting, same ordering and the
-- same LIMIT 10. A contract subject is planned exactly like a market subject.
CREATE OR REPLACE FUNCTION public.intel_live_focus_plan()
RETURNS TABLE(subject text,viewers bigint,expires_at timestamptz) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 SELECT d.subject,count(DISTINCT (d.org_id,d.user_id)),max(d.expires_at) FROM public.intel_live_focus_demands d
 JOIN public.org_members m ON m.org_id=d.org_id AND m.user_id=d.user_id
 WHERE d.expires_at>now() AND public.can_access_intel(d.user_id,d.org_id) IS TRUE
 GROUP BY d.subject ORDER BY count(DISTINCT (d.org_id,d.user_id)) DESC,max(d.requested_at) DESC,d.subject LIMIT 10
$$;
REVOKE ALL ON FUNCTION public.intel_live_focus_plan() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_live_focus_plan() TO service_role;
