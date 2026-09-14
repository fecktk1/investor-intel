-- Journal access follows current workspace membership. Shared research must not
-- expose the owner's saved portfolio context, chart personal overlays or AI notes.
CREATE OR REPLACE FUNCTION public.intel_portfolio_org_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT m.org_id FROM public.org_members m WHERE m.user_id=(SELECT auth.uid())
$$;
REVOKE ALL ON FUNCTION public.intel_portfolio_org_ids() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_portfolio_org_ids() TO authenticated,service_role;
ALTER POLICY "tj_theses_delete" ON public.intel_theses TO authenticated
 USING (intel_theses.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_theses.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_theses_insert" ON public.intel_theses TO authenticated
 WITH CHECK (intel_theses.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_theses.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_theses_select" ON public.intel_theses TO authenticated
 USING (intel_theses.org_id IN (SELECT public.intel_portfolio_org_ids()) AND (intel_theses.user_id=(SELECT auth.uid()) OR (intel_theses.visibility='org')));
ALTER POLICY "tj_theses_update" ON public.intel_theses TO authenticated
 USING (intel_theses.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_theses.user_id=(SELECT auth.uid())) WITH CHECK (intel_theses.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_theses.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_evidence_delete" ON public.intel_thesis_evidence TO authenticated
 USING (intel_thesis_evidence.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_evidence.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_evidence_insert" ON public.intel_thesis_evidence TO authenticated
 WITH CHECK (intel_thesis_evidence.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_evidence.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_evidence_select" ON public.intel_thesis_evidence TO authenticated
 USING (intel_thesis_evidence.org_id IN (SELECT public.intel_portfolio_org_ids()) AND (intel_thesis_evidence.user_id=(SELECT auth.uid()) OR (intel_thesis_evidence.visibility='org' AND EXISTS(SELECT 1 FROM public.intel_theses t WHERE t.id=intel_thesis_evidence.thesis_id AND t.org_id=intel_thesis_evidence.org_id AND t.user_id=intel_thesis_evidence.user_id AND t.visibility='org'))));
ALTER POLICY "tj_thesis_evidence_update" ON public.intel_thesis_evidence TO authenticated
 USING (intel_thesis_evidence.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_evidence.user_id=(SELECT auth.uid())) WITH CHECK (intel_thesis_evidence.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_evidence.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_reviews_delete" ON public.intel_thesis_reviews TO authenticated
 USING (intel_thesis_reviews.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_reviews.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_reviews_insert" ON public.intel_thesis_reviews TO authenticated
 WITH CHECK (intel_thesis_reviews.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_reviews.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_reviews_select" ON public.intel_thesis_reviews TO authenticated
 USING (intel_thesis_reviews.org_id IN (SELECT public.intel_portfolio_org_ids()) AND (intel_thesis_reviews.user_id=(SELECT auth.uid()) OR (intel_thesis_reviews.visibility='org' AND EXISTS(SELECT 1 FROM public.intel_theses t WHERE t.id=intel_thesis_reviews.thesis_id AND t.org_id=intel_thesis_reviews.org_id AND t.user_id=intel_thesis_reviews.user_id AND t.visibility='org'))));
ALTER POLICY "tj_thesis_reviews_update" ON public.intel_thesis_reviews TO authenticated
 USING (intel_thesis_reviews.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_reviews.user_id=(SELECT auth.uid())) WITH CHECK (intel_thesis_reviews.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_reviews.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_rules_delete" ON public.intel_thesis_rules TO authenticated
 USING (intel_thesis_rules.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_rules.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_rules_insert" ON public.intel_thesis_rules TO authenticated
 WITH CHECK (intel_thesis_rules.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_rules.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_rules_select" ON public.intel_thesis_rules TO authenticated
 USING (intel_thesis_rules.org_id IN (SELECT public.intel_portfolio_org_ids()) AND (intel_thesis_rules.user_id=(SELECT auth.uid()) OR (intel_thesis_rules.visibility='org' AND EXISTS(SELECT 1 FROM public.intel_theses t WHERE t.id=intel_thesis_rules.thesis_id AND t.org_id=intel_thesis_rules.org_id AND t.user_id=intel_thesis_rules.user_id AND t.visibility='org'))));
ALTER POLICY "tj_thesis_rules_update" ON public.intel_thesis_rules TO authenticated
 USING (intel_thesis_rules.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_rules.user_id=(SELECT auth.uid())) WITH CHECK (intel_thesis_rules.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_rules.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_scenarios_delete" ON public.intel_thesis_scenarios TO authenticated
 USING (intel_thesis_scenarios.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_scenarios.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_scenarios_insert" ON public.intel_thesis_scenarios TO authenticated
 WITH CHECK (intel_thesis_scenarios.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_scenarios.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_scenarios_select" ON public.intel_thesis_scenarios TO authenticated
 USING (intel_thesis_scenarios.org_id IN (SELECT public.intel_portfolio_org_ids()) AND (intel_thesis_scenarios.user_id=(SELECT auth.uid()) OR (intel_thesis_scenarios.visibility='org' AND EXISTS(SELECT 1 FROM public.intel_theses t WHERE t.id=intel_thesis_scenarios.thesis_id AND t.org_id=intel_thesis_scenarios.org_id AND t.user_id=intel_thesis_scenarios.user_id AND t.visibility='org'))));
ALTER POLICY "tj_thesis_scenarios_update" ON public.intel_thesis_scenarios TO authenticated
 USING (intel_thesis_scenarios.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_scenarios.user_id=(SELECT auth.uid())) WITH CHECK (intel_thesis_scenarios.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_scenarios.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_snapshots_delete" ON public.intel_thesis_snapshots TO authenticated
 USING (intel_thesis_snapshots.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_snapshots.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_snapshots_insert" ON public.intel_thesis_snapshots TO authenticated
 WITH CHECK (intel_thesis_snapshots.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_snapshots.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_snapshots_select" ON public.intel_thesis_snapshots TO authenticated
 USING (intel_thesis_snapshots.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_snapshots.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_thesis_snapshots_update" ON public.intel_thesis_snapshots TO authenticated
 USING (intel_thesis_snapshots.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_snapshots.user_id=(SELECT auth.uid())) WITH CHECK (intel_thesis_snapshots.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_thesis_snapshots.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_trade_reviews_delete" ON public.intel_trade_reviews TO authenticated
 USING (intel_trade_reviews.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_trade_reviews.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_trade_reviews_insert" ON public.intel_trade_reviews TO authenticated
 WITH CHECK (intel_trade_reviews.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_trade_reviews.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_trade_reviews_select" ON public.intel_trade_reviews TO authenticated
 USING (intel_trade_reviews.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_trade_reviews.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_trade_reviews_update" ON public.intel_trade_reviews TO authenticated
 USING (intel_trade_reviews.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_trade_reviews.user_id=(SELECT auth.uid())) WITH CHECK (intel_trade_reviews.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_trade_reviews.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_trades_delete" ON public.intel_trades TO authenticated
 USING (intel_trades.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_trades.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_trades_insert" ON public.intel_trades TO authenticated
 WITH CHECK (intel_trades.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_trades.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_trades_select" ON public.intel_trades TO authenticated
 USING (intel_trades.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_trades.user_id=(SELECT auth.uid()));
ALTER POLICY "tj_trades_update" ON public.intel_trades TO authenticated
 USING (intel_trades.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_trades.user_id=(SELECT auth.uid())) WITH CHECK (intel_trades.org_id IN (SELECT public.intel_portfolio_org_ids()) AND intel_trades.user_id=(SELECT auth.uid()));

CREATE FUNCTION app_private.intel_validate_journal_portfolio() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.portfolio_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.portfolio_id IS DISTINCT FROM OLD.portfolio_id) AND NOT EXISTS(
  SELECT 1 FROM public.investor_portfolios p WHERE p.id=NEW.portfolio_id AND p.org_id=NEW.org_id AND p.user_id=NEW.user_id
 ) THEN RAISE EXCEPTION 'Portfolio is not owned by this research owner and workspace' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_validate_journal_portfolio() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_journal_portfolio_owner BEFORE INSERT OR UPDATE OF portfolio_id ON public.intel_theses FOR EACH ROW EXECUTE FUNCTION app_private.intel_validate_journal_portfolio();
CREATE TRIGGER intel_journal_portfolio_owner BEFORE INSERT OR UPDATE OF portfolio_id ON public.intel_trades FOR EACH ROW EXECUTE FUNCTION app_private.intel_validate_journal_portfolio();

CREATE FUNCTION public.intel_thesis_snapshot_context(p_org_id uuid,p_thesis_id uuid,p_limit integer DEFAULT 100,p_before_at timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE owns boolean; rows jsonb; baseline jsonb; next_cursor jsonb; size integer:=greatest(1,least(coalesce(p_limit,100),200));
BEGIN
 IF auth.uid() IS NULL OR p_org_id IS NULL OR p_org_id NOT IN(SELECT public.intel_portfolio_org_ids()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT t.user_id=auth.uid() INTO owns FROM public.intel_theses t WHERE t.id=p_thesis_id AND t.org_id=p_org_id AND (t.user_id=auth.uid() OR t.visibility='org');
 IF owns IS NULL THEN RAISE EXCEPTION 'Thesis unavailable' USING ERRCODE='42501'; END IF;
 IF (p_before_at IS NULL)<>(p_before_id IS NULL) THEN RAISE EXCEPTION 'Invalid snapshot cursor' USING ERRCODE='22023'; END IF;
 WITH allowed AS (
   SELECT s.* FROM public.intel_thesis_snapshots s JOIN public.intel_theses t ON t.id=s.thesis_id AND t.org_id=s.org_id AND t.user_id=s.user_id
   WHERE s.thesis_id=p_thesis_id AND s.org_id=p_org_id AND (owns OR s.visibility='org')
 ), safe AS (
   SELECT id,captured_at,snapshot_kind,CASE WHEN owns THEN to_jsonb(s) ELSE
     to_jsonb(s)-ARRAY['portfolio_snapshot','chart_state','ai_summary','source_snapshot_ids','data_coverage'] ||
     jsonb_build_object('portfolio_snapshot','{}'::jsonb,'chart_state','{}'::jsonb,'ai_summary',NULL,'source_snapshot_ids','{}'::jsonb,'data_coverage','{}'::jsonb,'private_context_omitted',true) END AS value
   FROM allowed s
 ), page AS MATERIALIZED (
   SELECT * FROM safe WHERE p_before_at IS NULL OR (captured_at,id)<(p_before_at,p_before_id)
   ORDER BY captured_at DESC,id DESC LIMIT size+1
 ), visible AS (SELECT * FROM page ORDER BY captured_at DESC,id DESC LIMIT size)
 SELECT (SELECT value FROM safe WHERE snapshot_kind='baseline' LIMIT 1),
        coalesce((SELECT jsonb_agg(value ORDER BY captured_at DESC,id DESC) FROM visible),'[]'::jsonb),
        CASE WHEN (SELECT count(*) FROM page)>size THEN (SELECT jsonb_build_object('captured_at',captured_at,'id',id) FROM visible ORDER BY captured_at,id LIMIT 1) END
 INTO baseline,rows,next_cursor;
 RETURN jsonb_build_object('baseline',baseline,'rows',rows,'next_cursor',next_cursor,'private_context_omitted',NOT owns);
END $$;
REVOKE ALL ON FUNCTION public.intel_thesis_snapshot_context(uuid,uuid,integer,timestamptz,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_thesis_snapshot_context(uuid,uuid,integer,timestamptz,uuid) TO authenticated,service_role;
