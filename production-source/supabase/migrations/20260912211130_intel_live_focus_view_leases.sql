SET lock_timeout='5s';
SET statement_timeout='30s';
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.intel_live_focus_touch(uuid,uuid,text,boolean)'::regprocedure)) <> 'cab23bfa830887ad0b6984415ac10079'
 OR md5(pg_get_functiondef('public.intel_live_focus_plan()'::regprocedure)) <> '470601cbc28b9405d50baa6053d9b527'
 THEN RAISE EXCEPTION 'unreviewed_live_focus_definition'; END IF;
END $$;
ALTER TABLE public.intel_live_focus_demands ADD COLUMN view_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE public.intel_live_focus_demands DROP CONSTRAINT intel_live_focus_demands_pkey,
 ADD PRIMARY KEY(org_id,user_id,subject,view_id);

CREATE FUNCTION public.intel_live_focus_touch(p_org uuid,p_user uuid,p_subject text,p_enabled boolean,p_view uuid)
RETURNS timestamptz LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE until timestamptz;
BEGIN
 IF p_view IS NULL OR p_enabled IS NULL OR p_subject IS NULL OR p_subject !~ '^market:coinmarketcap:[1-9][0-9]{0,11}$' THEN RAISE EXCEPTION 'invalid_live_focus'; END IF;
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
CREATE OR REPLACE FUNCTION public.intel_live_focus_plan()
RETURNS TABLE(subject text,viewers bigint,expires_at timestamptz) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 SELECT d.subject,count(DISTINCT (d.org_id,d.user_id)),max(d.expires_at) FROM public.intel_live_focus_demands d
 JOIN public.org_members m ON m.org_id=d.org_id AND m.user_id=d.user_id
 WHERE d.expires_at>now() AND public.can_access_intel(d.user_id,d.org_id) IS TRUE
 GROUP BY d.subject ORDER BY count(DISTINCT (d.org_id,d.user_id)) DESC,max(d.requested_at) DESC,d.subject LIMIT 10
$$;
