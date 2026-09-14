-- One private analysis per owned portfolio. No holdings or authored words enter
-- shared market caches. Generation leases are reserved only by the Edge service.
CREATE TABLE public.intel_portfolio_research_cache (
 portfolio_id uuid PRIMARY KEY REFERENCES public.investor_portfolios(id) ON DELETE CASCADE,
 org_id uuid NOT NULL, user_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 operation_id uuid NOT NULL, lease_until timestamptz NOT NULL,
 artifact jsonb CHECK (artifact IS NULL OR (jsonb_typeof(artifact)='object' AND octet_length(artifact::text)<=100000)),
 generated_at timestamptz, expires_at timestamptz,
 CHECK ((artifact IS NULL) = (generated_at IS NULL))
);
ALTER TABLE public.intel_portfolio_research_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY private_research_read ON public.intel_portfolio_research_cache FOR SELECT TO authenticated
 USING (user_id=(SELECT auth.uid()) AND org_id IN (SELECT public.intel_portfolio_org_ids())
 AND EXISTS(SELECT 1 FROM public.investor_portfolios p WHERE p.id=intel_portfolio_research_cache.portfolio_id AND p.org_id=intel_portfolio_research_cache.org_id AND p.user_id=(SELECT auth.uid())));
CREATE POLICY private_research_delete ON public.intel_portfolio_research_cache FOR DELETE TO authenticated
 USING (user_id=(SELECT auth.uid()) AND org_id IN (SELECT public.intel_portfolio_org_ids()));
REVOKE ALL ON public.intel_portfolio_research_cache FROM anon, authenticated;
GRANT SELECT,DELETE ON public.intel_portfolio_research_cache TO authenticated;
GRANT ALL ON public.intel_portfolio_research_cache TO service_role;

CREATE FUNCTION public.intel_claim_portfolio_research(p_org_id uuid,p_user_id uuid,p_portfolio_id uuid,p_fingerprint text,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v public.intel_portfolio_research_cache; v_now timestamptz:=clock_timestamp();
BEGIN
 IF p_operation_id IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$' OR p_fingerprint IS NULL THEN RAISE EXCEPTION 'Invalid research operation' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.investor_portfolios p JOIN public.org_members m ON m.org_id=p.org_id AND m.user_id=p.user_id
  WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=p_user_id) THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO public.intel_portfolio_research_cache(portfolio_id,org_id,user_id,fingerprint,operation_id,lease_until)
 VALUES(p_portfolio_id,p_org_id,p_user_id,p_fingerprint,p_operation_id,v_now+interval '90 seconds')
 ON CONFLICT(portfolio_id) DO UPDATE SET fingerprint=excluded.fingerprint,operation_id=excluded.operation_id,lease_until=excluded.lease_until,artifact=NULL,generated_at=NULL,expires_at=NULL
 WHERE intel_portfolio_research_cache.org_id=p_org_id AND intel_portfolio_research_cache.user_id=p_user_id
 AND intel_portfolio_research_cache.lease_until<=v_now
 AND NOT (intel_portfolio_research_cache.fingerprint=p_fingerprint AND intel_portfolio_research_cache.artifact IS NOT NULL AND coalesce(intel_portfolio_research_cache.expires_at>v_now,false));
 SELECT * INTO v FROM public.intel_portfolio_research_cache c WHERE c.portfolio_id=p_portfolio_id AND c.org_id=p_org_id AND c.user_id=p_user_id;
 IF v.fingerprint=p_fingerprint AND v.artifact IS NOT NULL AND v.expires_at>v_now THEN
  RETURN jsonb_build_object('state','hit','artifact',v.artifact,'generatedAt',v.generated_at);
 END IF;
 RETURN jsonb_build_object('state',CASE WHEN v.operation_id=p_operation_id AND v.fingerprint=p_fingerprint THEN 'claimed' ELSE 'busy' END);
END;$$;
REVOKE ALL ON FUNCTION public.intel_claim_portfolio_research(uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_claim_portfolio_research(uuid,uuid,uuid,text,uuid) TO service_role;

CREATE FUNCTION public.intel_finish_portfolio_research(p_org_id uuid,p_user_id uuid,p_portfolio_id uuid,p_fingerprint text,p_operation_id uuid,p_artifact jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_count integer;
BEGIN
 UPDATE public.intel_portfolio_research_cache c SET artifact=p_artifact,
 generated_at=CASE WHEN p_artifact IS NOT NULL THEN clock_timestamp() END,
 expires_at=CASE WHEN p_artifact IS NOT NULL THEN clock_timestamp()+interval '30 minutes' END,lease_until=clock_timestamp()
 WHERE c.portfolio_id=p_portfolio_id AND c.org_id=p_org_id AND c.user_id=p_user_id AND c.fingerprint=p_fingerprint AND c.operation_id=p_operation_id
 AND c.lease_until>clock_timestamp()
 AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=p_org_id AND m.user_id=p_user_id);
 GET DIAGNOSTICS v_count=ROW_COUNT;RETURN v_count=1;
END;$$;
REVOKE ALL ON FUNCTION public.intel_finish_portfolio_research(uuid,uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_finish_portfolio_research(uuid,uuid,uuid,text,uuid,jsonb) TO service_role;

-- A single statement snapshot keeps totals and closed-position history coherent.
-- The sentinel explicitly reports over-limit portfolios instead of silently
-- inheriting PostgREST's row cap and describing a partial book as complete.
CREATE FUNCTION public.intel_portfolio_research_facts(p_org_id uuid,p_portfolio_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v jsonb;
BEGIN
 IF auth.uid() IS NULL OR p_org_id NOT IN (SELECT public.intel_portfolio_org_ids()) OR NOT EXISTS(
 SELECT 1 FROM public.investor_portfolios p WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid()) THEN
 RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 WITH h AS MATERIALIZED (
  SELECT x.* FROM public.investor_portfolio_holdings x WHERE x.portfolio_id=p_portfolio_id AND x.org_id=p_org_id AND x.user_id=auth.uid()
  ORDER BY x.id LIMIT 5001
 ), sources AS MATERIALIZED (
  SELECT s.id,s.source_type,s.provider FROM public.investor_portfolio_sources s WHERE s.portfolio_id=p_portfolio_id AND s.org_id=p_org_id AND s.user_id=auth.uid()
 ), grouped AS (
  SELECT 'grouped:'||g.id AS key,g.block_time AS occurred,
   (to_jsonb(g)-ARRAY['raw','counterparty','org_id','user_id','portfolio_id'])||jsonb_build_object('kind','grouped','timestamp',g.block_time,'provider',s.provider) AS event
  FROM public.investor_portfolio_tx g JOIN sources s ON s.id=g.source_id AND s.source_type<>'manual'
  WHERE g.portfolio_id=p_portfolio_id AND g.org_id=p_org_id AND g.user_id=auth.uid() AND NOT g.is_display_mirror
  ORDER BY g.block_time DESC NULLS LAST,g.id DESC LIMIT 21
 ), manual AS (
  SELECT 'manual:'||m.id AS key,m.timestamp AS occurred,
   (to_jsonb(m)-ARRAY['raw_metadata','org_id','user_id','portfolio_id','tags'])||jsonb_build_object('kind','manual_leg','provider',s.provider,'status','recorded',
    'manual_group_id',m.raw_metadata->>'manual_group_id','manual_pair_classification',m.raw_metadata->>'manual_pair_classification') AS event
  FROM public.investor_portfolio_transactions m JOIN sources s ON s.id=m.source_id AND s.source_type='manual'
  WHERE m.portfolio_id=p_portfolio_id AND m.org_id=p_org_id AND m.user_id=auth.uid()
  ORDER BY m.timestamp DESC NULLS LAST,m.id DESC LIMIT 21
 ), activity AS MATERIALIZED (
  SELECT * FROM (SELECT * FROM grouped UNION ALL SELECT * FROM manual) x ORDER BY occurred DESC NULLS LAST,key DESC LIMIT 21
 ) SELECT jsonb_build_object(
  'holdings',coalesce((SELECT jsonb_agg(to_jsonb(x)-ARRAY['wallet_address','org_id','user_id','portfolio_id']) FROM (SELECT * FROM h ORDER BY id LIMIT 5000) x),'[]'::jsonb),
  'holdingsTruncated',(SELECT count(*)>5000 FROM h),
  'activity',coalesce((SELECT jsonb_agg(event ORDER BY occurred DESC NULLS LAST,key DESC) FROM (SELECT * FROM activity ORDER BY occurred DESC NULLS LAST,key DESC LIMIT 20) a),'[]'::jsonb),
  'activityHasMore',(SELECT count(*)>20 FROM activity),
  'observedAt',statement_timestamp()
 ) INTO v;RETURN v;
END;$$;
REVOKE ALL ON FUNCTION public.intel_portfolio_research_facts(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_portfolio_research_facts(uuid,uuid) TO authenticated;

-- Editing/deleting private evidence invalidates cached text, including a pending
-- generation lease. A slow old response cannot restore deleted private words.
CREATE FUNCTION app_private.intel_invalidate_portfolio_research() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 DELETE FROM public.intel_portfolio_research_cache c WHERE c.portfolio_id=CASE WHEN TG_OP='DELETE' THEN OLD.portfolio_id ELSE NEW.portfolio_id END;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app_private.intel_invalidate_portfolio_research() FROM PUBLIC,anon,authenticated;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['investor_portfolio_transactions','investor_portfolio_tx','investor_portfolio_holdings','investor_portfolio_sources'] LOOP
  EXECUTE format('CREATE TRIGGER intel_invalidate_research AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_private.intel_invalidate_portfolio_research()',t);
 END LOOP;
END;$$;
CREATE TRIGGER intel_delete_research_memory AFTER DELETE ON public.investor_portfolio_memory FOR EACH ROW EXECUTE FUNCTION app_private.intel_invalidate_portfolio_research();
