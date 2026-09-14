-- Future briefs are personal. Historical org rows are preserved verbatim;
-- their possible mixed-owner portfolio context requires a separate owner review.
CREATE TABLE public.intel_personal_briefs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 brief_type text NOT NULL, period_date date NOT NULL,
 artifact_id uuid REFERENCES public.research_artifacts(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'ready' CHECK(status IN ('pending','ready','failed')),
 assembled jsonb NOT NULL DEFAULT '{}', change_fingerprint text, synthesis_artifact_ref text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,user_id,brief_type,period_date)
);
CREATE INDEX intel_personal_briefs_history ON public.intel_personal_briefs(org_id,user_id,period_date DESC,id DESC);
CREATE INDEX intel_briefs_history ON public.intel_briefs(org_id,period_date DESC,id DESC);
CREATE INDEX intel_alert_rules_history ON public.intel_alert_rules(org_id,created_at DESC,id DESC);
CREATE INDEX intel_alert_events_history ON public.intel_alert_events(org_id,fired_at DESC,id DESC);
ALTER TABLE public.intel_alert_rules ADD COLUMN last_evaluation_attempt_at timestamptz;
CREATE INDEX intel_alert_rules_evaluation_queue ON public.intel_alert_rules(trigger_type,last_evaluation_attempt_at ASC NULLS FIRST,id) WHERE is_active;
ALTER TABLE public.intel_personal_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY intel_personal_briefs_owner ON public.intel_personal_briefs FOR SELECT TO authenticated USING (
 user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_personal_briefs.org_id AND m.user_id=(SELECT auth.uid()))
);
REVOKE ALL ON public.intel_personal_briefs FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.intel_personal_briefs TO authenticated;
GRANT ALL ON public.intel_personal_briefs TO service_role;

-- The artifact itself and saved snapshots must have the same private boundary.
-- Additive restrictive policies leave generic and historical org sharing intact.
ALTER TABLE public.research_artifacts ADD COLUMN private_owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.saved_research ADD COLUMN private_owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE;
CREATE INDEX research_artifacts_private_owner ON public.research_artifacts(org_id,private_owner_id,cache_key,created_at DESC) WHERE private_owner_id IS NOT NULL;
CREATE POLICY intel_artifact_private_boundary ON public.research_artifacts AS RESTRICTIVE FOR ALL TO authenticated
 USING(private_owner_id IS NULL OR (private_owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=research_artifacts.org_id AND m.user_id=(SELECT auth.uid()))))
 WITH CHECK(private_owner_id IS NULL OR (private_owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=research_artifacts.org_id AND m.user_id=(SELECT auth.uid()))));
CREATE POLICY intel_saved_private_boundary ON public.saved_research AS RESTRICTIVE FOR ALL TO authenticated
 USING(private_owner_id IS NULL OR (private_owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=saved_research.org_id AND m.user_id=(SELECT auth.uid()))))
 WITH CHECK(private_owner_id IS NULL OR (private_owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=saved_research.org_id AND m.user_id=(SELECT auth.uid()))));
CREATE OR REPLACE FUNCTION public.intel_guard_private_artifact() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_owner uuid; v_org uuid;
BEGIN
 IF TG_OP='UPDATE' AND OLD.private_owner_id IS NOT NULL AND
   (NEW.private_owner_id IS DISTINCT FROM OLD.private_owner_id OR NEW.org_id IS DISTINCT FROM OLD.org_id) THEN
   RAISE EXCEPTION 'Private research ownership cannot change' USING ERRCODE='42501';
 END IF;
 IF TG_TABLE_NAME='research_artifacts' THEN
   IF TG_OP='INSERT' AND NEW.artifact_type='daily_brief' THEN
     IF NEW.user_id IS NULL THEN RAISE EXCEPTION 'Personal brief author required' USING ERRCODE='42501'; END IF;
     NEW.private_owner_id:=NEW.user_id;
   END IF;
 ELSIF TG_TABLE_NAME='saved_research' THEN
   IF NEW.artifact_id IS NOT NULL THEN
     SELECT a.private_owner_id,a.org_id INTO v_owner,v_org FROM public.research_artifacts a WHERE a.id=NEW.artifact_id;
     IF v_org IS DISTINCT FROM NEW.org_id OR (v_owner IS NOT NULL AND auth.uid() IS DISTINCT FROM v_owner AND auth.uid() IS NOT NULL) THEN
       RAISE EXCEPTION 'Research artifact is not accessible in this workspace' USING ERRCODE='42501';
     END IF;
     IF v_owner IS NOT NULL THEN NEW.private_owner_id:=v_owner; NEW.user_id:=v_owner; END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.intel_guard_private_artifact() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_private_artifact_guard BEFORE INSERT OR UPDATE ON public.research_artifacts FOR EACH ROW EXECUTE FUNCTION public.intel_guard_private_artifact();
CREATE TRIGGER intel_private_saved_guard BEFORE INSERT OR UPDATE ON public.saved_research FOR EACH ROW EXECUTE FUNCTION public.intel_guard_private_artifact();

CREATE FUNCTION public.intel_save_personal_brief(p_org_id uuid,p_brief_type text,p_period_date date,p_artifact_id uuid,p_status text DEFAULT 'ready')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.intel_personal_briefs;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=p_org_id AND m.user_id=auth.uid()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF p_artifact_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.research_artifacts a WHERE a.id=p_artifact_id AND a.org_id=p_org_id AND a.private_owner_id=auth.uid() AND a.artifact_type='daily_brief') THEN
   RAISE EXCEPTION 'Owned personal brief artifact required' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.intel_personal_briefs(org_id,user_id,brief_type,period_date,artifact_id,status)
 VALUES(p_org_id,auth.uid(),p_brief_type,p_period_date,p_artifact_id,p_status)
 ON CONFLICT(org_id,user_id,brief_type,period_date) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,status=EXCLUDED.status,updated_at=statement_timestamp()
 RETURNING * INTO v_row;
 RETURN to_jsonb(v_row)||jsonb_build_object('scope','personal','artifact',(SELECT to_jsonb(a) FROM public.research_artifacts a WHERE a.id=v_row.artifact_id));
END $$;
REVOKE ALL ON FUNCTION public.intel_save_personal_brief(uuid,text,date,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_save_personal_brief(uuid,text,date,uuid,text) TO authenticated;

CREATE FUNCTION public.intel_list_briefs(p_org_id uuid,p_limit integer DEFAULT 30,p_before_date date DEFAULT NULL,p_before_id uuid DEFAULT NULL,p_before_scope text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_size integer:=greatest(1,least(coalesce(p_limit,30),100)); v_rows jsonb; v_last jsonb; v_more boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=p_org_id AND m.user_id=auth.uid()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF (p_before_date IS NULL) IS DISTINCT FROM (p_before_id IS NULL) OR (p_before_date IS NULL) IS DISTINCT FROM (p_before_scope IS NULL) THEN RAISE EXCEPTION 'Incomplete cursor'; END IF;
 WITH candidates AS (
   SELECT b.id,b.period_date,'personal'::text scope,to_jsonb(b)||jsonb_build_object('scope','personal','artifact',to_jsonb(a)) body
   FROM public.intel_personal_briefs b LEFT JOIN public.research_artifacts a ON a.id=b.artifact_id
   WHERE b.org_id=p_org_id AND b.user_id=auth.uid()
   UNION ALL
   SELECT b.id,b.period_date,'organization'::text,to_jsonb(b)||jsonb_build_object('scope','organization','artifact',to_jsonb(a))
   FROM public.intel_briefs b LEFT JOIN public.research_artifacts a ON a.id=b.artifact_id WHERE b.org_id=p_org_id
 ), page AS (
   SELECT * FROM candidates WHERE p_before_date IS NULL OR (period_date,id,scope)<(p_before_date,p_before_id,p_before_scope)
   ORDER BY period_date DESC,id DESC,scope DESC LIMIT v_size+1
 ) SELECT coalesce(jsonb_agg(body ORDER BY period_date DESC,id DESC,scope DESC),'[]') INTO v_rows FROM page;
 v_more:=jsonb_array_length(v_rows)>v_size;
 IF v_more THEN v_rows:=v_rows-v_size; v_last:=v_rows->(v_size-1); END IF;
 RETURN jsonb_build_object('rows',v_rows,'next_cursor',CASE WHEN v_more THEN jsonb_build_object('period_date',v_last->>'period_date','id',v_last->>'id','scope',v_last->>'scope') END);
END $$;
REVOKE ALL ON FUNCTION public.intel_list_briefs(uuid,integer,date,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_list_briefs(uuid,integer,date,uuid,text) TO authenticated;

-- Service-only work selection: no fixed leading-org cap. Completed daily rows
-- leave the pending set; failures back off so a broken account cannot starve it.
CREATE TABLE public.intel_brief_attempts (
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 period_date date NOT NULL, attempted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,user_id,period_date)
);
ALTER TABLE public.intel_brief_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_brief_attempts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.intel_brief_attempts TO service_role;
CREATE FUNCTION public.intel_brief_work_batch(p_date date,p_active_since timestamptz,p_limit integer DEFAULT 40)
RETURNS TABLE(org_id uuid,user_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 WITH pending AS (
   SELECT m.org_id,m.user_id FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id
   WHERE o.product_mode='intel'
   AND (o.plan_overrides->>'intel_tier' IN ('starter','pro','elite') OR o.trial_ends_at>now())
   AND (EXISTS(SELECT 1 FROM public.watchlists w WHERE w.org_id=m.org_id AND w.user_id=m.user_id)
     OR EXISTS(SELECT 1 FROM public.investor_portfolios p WHERE p.org_id=m.org_id AND p.user_id=m.user_id)
     OR EXISTS(SELECT 1 FROM public.intel_alert_rules r WHERE r.org_id=m.org_id AND r.user_id=m.user_id AND r.is_active)
     OR EXISTS(SELECT 1 FROM public.intel_ai_events e WHERE e.org_id=m.org_id AND e.user_id=m.user_id AND e.created_at>=p_active_since))
   AND NOT EXISTS(SELECT 1 FROM public.intel_personal_briefs b WHERE b.org_id=m.org_id AND b.user_id=m.user_id AND b.period_date=p_date AND b.brief_type='daily' AND b.status='ready')
   AND NOT EXISTS(SELECT 1 FROM public.intel_brief_attempts a WHERE a.org_id=m.org_id AND a.user_id=m.user_id AND a.period_date=p_date AND a.attempted_at>now()-interval '10 minutes')
   ORDER BY m.org_id,m.user_id LIMIT greatest(1,least(coalesce(p_limit,40),100))
 ), claimed AS (
   INSERT INTO public.intel_brief_attempts(org_id,user_id,period_date) SELECT p.org_id,p.user_id,p_date FROM pending p
   ON CONFLICT(org_id,user_id,period_date) DO UPDATE SET attempted_at=now()
   WHERE intel_brief_attempts.attempted_at<=now()-interval '10 minutes'
   RETURNING intel_brief_attempts.org_id,intel_brief_attempts.user_id
 ) SELECT * FROM claimed
$$;
REVOKE ALL ON FUNCTION public.intel_brief_work_batch(date,timestamptz,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_brief_work_batch(date,timestamptz,integer) TO service_role;
