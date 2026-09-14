CREATE TABLE public.intel_live_focus_demands (
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 subject text NOT NULL CHECK(subject ~ '^market:coinmarketcap:[1-9][0-9]{0,11}$'),
 expires_at timestamptz NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,user_id,subject)
);
CREATE INDEX intel_live_focus_expiry ON public.intel_live_focus_demands(expires_at,subject);
ALTER TABLE public.intel_live_focus_demands ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_live_focus ON public.intel_live_focus_demands FOR ALL TO authenticated
 USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_live_focus_demands.org_id AND m.user_id=(SELECT auth.uid())))
 WITH CHECK(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_live_focus_demands.org_id AND m.user_id=(SELECT auth.uid())));
REVOKE ALL ON public.intel_live_focus_demands FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_live_focus_demands TO service_role;

CREATE OR REPLACE FUNCTION public.intel_live_focus_touch(p_org uuid,p_user uuid,p_subject text,p_enabled boolean)
RETURNS timestamptz LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE until timestamptz;
BEGIN
 IF p_enabled IS NULL OR p_subject IS NULL OR p_subject !~ '^market:coinmarketcap:[1-9][0-9]{0,11}$' THEN RAISE EXCEPTION 'invalid_live_focus'; END IF;
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=p_org AND user_id=p_user) OR public.can_access_intel(p_user,p_org) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 -- Per-owner serialization prevents tab races bypassing the three-asset limit.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text||':'||p_user::text,0));
 until:=clock_timestamp()+interval '45 seconds';
 DELETE FROM public.intel_live_focus_demands WHERE org_id=p_org AND user_id=p_user AND expires_at<=clock_timestamp();
 IF NOT p_enabled THEN DELETE FROM public.intel_live_focus_demands WHERE org_id=p_org AND user_id=p_user AND subject=p_subject; RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.intel_live_focus_demands WHERE org_id=p_org AND user_id=p_user AND subject=p_subject)
  AND (SELECT count(*) FROM public.intel_live_focus_demands WHERE org_id=p_org AND user_id=p_user)>=3 THEN RAISE EXCEPTION 'live_focus_asset_limit'; END IF;
 INSERT INTO public.intel_live_focus_demands(org_id,user_id,subject,expires_at) VALUES(p_org,p_user,p_subject,until)
 ON CONFLICT(org_id,user_id,subject) DO UPDATE SET expires_at=excluded.expires_at,requested_at=clock_timestamp();
 RETURN until;
END $$;
REVOKE ALL ON FUNCTION public.intel_live_focus_touch(uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_live_focus_touch(uuid,uuid,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.intel_live_focus_plan()
RETURNS TABLE(subject text,viewers bigint,expires_at timestamptz) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 SELECT d.subject,count(*),max(d.expires_at) FROM public.intel_live_focus_demands d
 JOIN public.org_members m ON m.org_id=d.org_id AND m.user_id=d.user_id
 WHERE d.expires_at>now() AND public.can_access_intel(d.user_id,d.org_id) IS TRUE
 GROUP BY d.subject ORDER BY count(*) DESC,max(d.requested_at) DESC,d.subject LIMIT 10
$$;
REVOKE ALL ON FUNCTION public.intel_live_focus_plan() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_live_focus_plan() TO service_role;
