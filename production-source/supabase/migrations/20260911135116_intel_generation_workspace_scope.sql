-- Explicit workspace variants retain the legacy RPCs for existing callers.
-- A user's metadata-selected Content Forge org must not govern Intel research.
SET lock_timeout='5s';
SET statement_timeout='60s';
CREATE FUNCTION public.intel_generation_allowed(p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_kill boolean; v_cap numeric; v_used numeric:=0; v_over jsonb; v_mode text;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org_id AND user_id=auth.uid()) THEN
  RETURN jsonb_build_object('allowed',false,'reason','workspace_unavailable');
 END IF;
 SELECT kill_switch,default_cost_cap_usd INTO v_kill,v_cap FROM public.intel_global_config WHERE id=1;
 IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','configuration_unavailable'); END IF;
 IF coalesce(v_kill,false) THEN RETURN jsonb_build_object('allowed',false,'reason','kill_switch'); END IF;
 SELECT product_mode,plan_overrides INTO v_mode,v_over FROM public.orgs WHERE id=p_org_id;
 IF v_mode IS DISTINCT FROM 'intel' THEN RETURN jsonb_build_object('allowed',false,'reason','not_intel'); END IF;
 IF v_over ? 'intel_cost_cap_usd' THEN v_cap:=nullif(v_over->>'intel_cost_cap_usd','')::numeric; END IF;
 SELECT coalesce(sum(est_cost_usd),0) INTO v_used FROM public.ai_usage
 WHERE org_id=p_org_id AND surface='investor_intel' AND created_at>=date_trunc('month',now());
 IF v_cap IS NOT NULL AND v_used>=v_cap THEN RETURN jsonb_build_object('allowed',false,'reason','cost_cap','used',v_used,'cap',v_cap); END IF;
 RETURN jsonb_build_object('allowed',true,'used',v_used,'cap',v_cap);
END $$;

CREATE FUNCTION public.intel_rate_check(p_limit_key text,p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_lim numeric;v_used int:=0;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org_id AND user_id=auth.uid()) THEN
  RETURN jsonb_build_object('allowed',false,'reason','workspace_unavailable');
 END IF;
 IF p_limit_key NOT IN ('breakdowns_per_day','explain_per_day','comparisons_per_day','briefs_per_day','comment_king_per_day','news_refreshes_per_day') OR p_limit_key IS NULL THEN
  RETURN jsonb_build_object('allowed',false,'reason','invalid_limit');
 END IF;
 v_lim:=public.authorize_intel_limit(auth.uid(),p_org_id,p_limit_key);
 IF v_lim IS NULL THEN RETURN jsonb_build_object('allowed',true); END IF;
 SELECT count(*) INTO v_used FROM public.intel_ai_events WHERE org_id=p_org_id AND created_at>=date_trunc('day',now())
 AND (metadata->>'cache') IS DISTINCT FROM 'hit' AND (
  (p_limit_key='breakdowns_per_day' AND event_type IN ('token_breakdown','risk_panel','wallet_summary','narrative_report','defi_report','execution_report')) OR
  (p_limit_key='explain_per_day' AND event_type='explain') OR
  (p_limit_key='comparisons_per_day' AND event_type='token_comparison') OR
  (p_limit_key='briefs_per_day' AND event_type='daily_brief') OR
  (p_limit_key='comment_king_per_day' AND event_type='comment_king') OR
  (p_limit_key='news_refreshes_per_day' AND event_type='news_fetch'));
 RETURN jsonb_build_object('allowed',v_used<v_lim,'used',v_used,'limit',v_lim);
END $$;

CREATE FUNCTION public.intel_force_refresh_allowed(p_artifact_type text,p_entity_ref text,p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_lim numeric;v_used int;v_last timestamptz;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org_id AND user_id=auth.uid()) THEN
  RETURN jsonb_build_object('allowed',false,'reason','workspace_unavailable');
 END IF;
 v_lim:=public.authorize_intel_limit(auth.uid(),p_org_id,'force_refresh_per_day');
 SELECT count(*) INTO v_used FROM public.intel_force_refresh_log WHERE org_id=p_org_id AND created_at>=date_trunc('day',now());
 IF v_lim IS NOT NULL AND v_used>=v_lim THEN RETURN jsonb_build_object('allowed',false,'reason','force_refresh_per_day','used',v_used,'limit',v_lim); END IF;
 SELECT max(created_at) INTO v_last FROM public.intel_force_refresh_log WHERE org_id=p_org_id AND artifact_type=p_artifact_type AND coalesce(entity_ref,'')=coalesce(p_entity_ref,'');
 IF v_last>now()-interval '30 minutes' THEN RETURN jsonb_build_object('allowed',false,'reason','cooldown','used',v_used,'limit',v_lim,'cooldown_until',v_last+interval '30 minutes'); END IF;
 RETURN jsonb_build_object('allowed',true,'used',v_used,'limit',v_lim);
END $$;

REVOKE ALL ON FUNCTION public.intel_generation_allowed(uuid),public.intel_rate_check(text,uuid),public.intel_force_refresh_allowed(text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_generation_allowed(uuid),public.intel_rate_check(text,uuid),public.intel_force_refresh_allowed(text,text,uuid) TO authenticated;

-- Existing private-owner restrictive policy still applies to every operation.
-- Keep each legacy policy, adding only membership-based access to Intel orgs.
CREATE POLICY intel_selected_workspace_read ON public.research_artifacts FOR SELECT TO authenticated USING (
 EXISTS(SELECT 1 FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id WHERE m.org_id=research_artifacts.org_id AND m.user_id=(SELECT auth.uid()) AND o.product_mode='intel'));
CREATE POLICY intel_selected_workspace_insert ON public.research_artifacts FOR INSERT TO authenticated WITH CHECK (
 EXISTS(SELECT 1 FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id WHERE m.org_id=research_artifacts.org_id AND m.user_id=(SELECT auth.uid()) AND m.role::text IN ('owner','admin','editor') AND o.product_mode='intel'));
CREATE POLICY intel_selected_workspace_update ON public.research_artifacts FOR UPDATE TO authenticated USING (
 EXISTS(SELECT 1 FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id WHERE m.org_id=research_artifacts.org_id AND m.user_id=(SELECT auth.uid()) AND m.role::text IN ('owner','admin','editor') AND o.product_mode='intel')) WITH CHECK (
 EXISTS(SELECT 1 FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id WHERE m.org_id=research_artifacts.org_id AND m.user_id=(SELECT auth.uid()) AND m.role::text IN ('owner','admin','editor') AND o.product_mode='intel'));
CREATE POLICY intel_selected_workspace_delete ON public.research_artifacts FOR DELETE TO authenticated USING (
 EXISTS(SELECT 1 FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id WHERE m.org_id=research_artifacts.org_id AND m.user_id=(SELECT auth.uid()) AND m.role::text IN ('owner','admin') AND o.product_mode='intel'));
CREATE POLICY intel_selected_workspace_entity_read ON public.entities FOR SELECT TO authenticated USING (
 EXISTS(SELECT 1 FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id WHERE m.org_id=entities.org_id AND m.user_id=(SELECT auth.uid()) AND o.product_mode='intel'));
