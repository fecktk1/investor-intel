-- Private, append-only assessments within the existing journal review stream.
-- No market return, filled trade, historic forecast or win rate is inferred.
ALTER TABLE public.intel_thesis_reviews ADD COLUMN performance_evaluation jsonb;
CREATE INDEX intel_performance_reviews_owner ON public.intel_thesis_reviews(org_id,user_id,thesis_id,created_at DESC,id DESC) WHERE performance_evaluation IS NOT NULL;
CREATE INDEX intel_original_forecast_lookup ON public.intel_thesis_activity(org_id,user_id,thesis_id,occurred_at,id) WHERE event_kind='thesis_created' AND historical_completeness='complete';

CREATE FUNCTION app_private.intel_performance_review_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p jsonb;original public.intel_thesis_activity;prior public.intel_thesis_reviews;from_at timestamptz;to_at timestamptz;declared timestamptz:=now();assessment text;BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.performance_evaluation IS NOT NULL OR NEW.performance_evaluation IS NOT NULL THEN RAISE EXCEPTION 'performance_review_immutable_create_new_version';END IF;RETURN NEW;
 END IF;
 IF NEW.performance_evaluation IS NULL THEN RETURN NEW;END IF;
 IF auth.uid() IS NULL OR NEW.user_id IS DISTINCT FROM auth.uid() OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=NEW.org_id AND user_id=auth.uid()) OR NOT EXISTS(SELECT 1 FROM public.intel_theses WHERE id=NEW.thesis_id AND org_id=NEW.org_id AND user_id=auth.uid()) THEN RAISE EXCEPTION 'performance_review_forbidden';END IF;
 p:=NEW.performance_evaluation;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>20000 THEN RAISE EXCEPTION 'invalid_performance_review';END IF;
 from_at:=(p->>'from')::timestamptz;to_at:=(p->>'to')::timestamptz;assessment:=p->>'assessment';
 IF from_at IS NULL OR to_at IS NULL OR from_at>=to_at OR to_at-from_at>interval '10 years' OR from_at<'2009-01-01'::timestamptz OR assessment IS NULL OR assessment NOT IN ('pending','ambiguous','supported','contradicted','mixed','invalidated') OR (assessment NOT IN ('pending','ambiguous') AND to_at>now()) THEN RAISE EXCEPTION 'invalid_performance_window_or_assessment';END IF;
 IF length(coalesce(NEW.note,''))>8000 OR length(coalesce(p->>'fees_assumption',''))>2000 OR length(coalesce(p->>'slippage_assumption',''))>2000 OR jsonb_typeof(coalesce(p->'evidence_refs','[]'))<>'array' OR jsonb_array_length(coalesce(p->'evidence_refs','[]'))>20 OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p->'evidence_refs','[]')) e WHERE jsonb_typeof(e)<>'string' OR length(e#>>'{}')>500) THEN RAISE EXCEPTION 'invalid_performance_context';END IF;
 SELECT * INTO original FROM public.intel_thesis_activity WHERE org_id=NEW.org_id AND user_id=NEW.user_id AND thesis_id=NEW.thesis_id AND event_kind='thesis_created' AND historical_completeness='complete' ORDER BY occurred_at,id LIMIT 1;
 IF original.id IS NULL AND assessment NOT IN ('pending','ambiguous') THEN RAISE EXCEPTION 'original_forecast_unavailable_keep_assessment_pending_or_ambiguous';END IF;
 IF assessment NOT IN ('pending','ambiguous') AND (from_at<original.occurred_at OR length(btrim(coalesce(NEW.note,'')))<12 OR jsonb_array_length(coalesce(p->'evidence_refs','[]'))=0) THEN RAISE EXCEPTION 'assessment_requires_post_forecast_window_notes_and_evidence';END IF;
 IF nullif(p->>'previous_review_id','') IS NOT NULL THEN
  SELECT * INTO prior FROM public.intel_thesis_reviews WHERE id=(p->>'previous_review_id')::uuid AND org_id=NEW.org_id AND user_id=NEW.user_id AND thesis_id=NEW.thesis_id AND performance_evaluation IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'previous_performance_review_unavailable';END IF;
  IF (prior.performance_evaluation->>'from')::timestamptz IS DISTINCT FROM from_at OR (prior.performance_evaluation->>'to')::timestamptz IS DISTINCT FROM to_at THEN RAISE EXCEPTION 'review_window_changed_create_a_new_window';END IF;
  declared:=(prior.performance_evaluation->>'window_declared_at')::timestamptz;
 END IF;
 NEW.visibility:='private';NEW.review_kind:='manual';NEW.created_at:=now();NEW.updated_at:=now();NEW.prev_status:=NULL;NEW.new_status:=NULL;NEW.prev_conviction:=NULL;NEW.new_conviction:=NULL;NEW.prev_stance:=NULL;NEW.new_stance:=NULL;
 NEW.performance_evaluation:=jsonb_build_object('schema_version',1,'assessment',assessment,'from',from_at,'to',to_at,'window_declared_at',declared,'retrospective_window',from_at<declared,'recorded_at',now(),'previous_review_id',prior.id,
  'original_forecast_available',original.id IS NOT NULL,'original_forecast',CASE WHEN original.id IS NOT NULL THEN jsonb_build_object('activity_id',original.id,'occurred_at',original.occurred_at,'recorded_at',original.recorded_at,'title',original.title_snapshot,'words',original.text_snapshot,'fields',original.changes) END,
  'fees_assumption',coalesce(p->>'fees_assumption','Not assessed'),'slippage_assumption',coalesce(p->>'slippage_assumption','Not assessed'),'evidence_refs',coalesce(p->'evidence_refs','[]'),'basis','user_recorded_assessment_not_realized_pnl');
 RETURN NEW;
END $$;

-- Preserve legacy RPCs while adding explicit selected-org analytics. Existing
-- descriptive fields remain; journal P&L coverage becomes visible.
DO $$ DECLARE original text;changed text;signature text;BEGIN
 FOREACH signature IN ARRAY ARRAY['public.intel_thesis_analytics(timestamptz)','public.intel_trade_analytics(text,text,timestamptz)'] LOOP
  original:=pg_get_functiondef(signature::regprocedure);
  changed:=replace(original,'IF v_org IS NULL OR v_user IS NULL THEN','IF v_org IS NULL OR v_user IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=v_org AND m.user_id=v_user) THEN');
  IF changed=original THEN RAISE EXCEPTION 'unexpected_analytics_scope_guard';END IF;
  EXECUTE changed;
  IF signature LIKE '%intel_thesis_analytics%' THEN
   changed:=replace(changed,'public.intel_thesis_analytics(','public.intel_thesis_analytics_scoped(p_org uuid, ');
  ELSE
   changed:=replace(changed,'public.intel_trade_analytics(','public.intel_trade_analytics_scoped(p_org uuid, ');
   changed:=replace(changed,'upper(COALESCE(symbol,'''')) = upper(COALESCE(p_scope_key,''''))','subject_canonical_key = p_scope_key');
   changed:=replace(changed,'''closed_trades'', (SELECT count(*) FROM c),','''closed_trades'', (SELECT count(*) FROM c), ''priced_closed_trades'',(SELECT count(*) FROM c WHERE realized_pnl_usd IS NOT NULL), ''unpriced_closed_trades'',(SELECT count(*) FROM c WHERE realized_pnl_usd IS NULL),');
   changed:=replace(changed,'/ count(*) * 100','/ NULLIF(count(realized_pnl_usd),0) * 100');
   changed:=replace(changed,'round(COALESCE(sum(realized_pnl_usd),0)::numeric, 2)','round(sum(realized_pnl_usd)::numeric, 2)');
   changed:=replace(changed,'upper(COALESCE(symbol,''?''))','COALESCE(subject_canonical_key,''unresolved:''||id::text)');
  END IF;
  changed:=replace(changed,'v_org uuid := get_my_org_id()','v_org uuid := p_org');
  EXECUTE changed;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.intel_thesis_analytics_scoped(uuid,timestamptz),public.intel_trade_analytics_scoped(uuid,text,text,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_thesis_analytics_scoped(uuid,timestamptz),public.intel_trade_analytics_scoped(uuid,text,text,timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION app_private.intel_performance_review_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_performance_review_guard BEFORE INSERT OR UPDATE ON public.intel_thesis_reviews FOR EACH ROW EXECUTE FUNCTION app_private.intel_performance_review_guard();

CREATE FUNCTION public.intel_save_performance_review(p_org uuid,p_thesis uuid,p_operation uuid,p_review jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op app_private.intel_activity_operations;r public.intel_thesis_reviews;request jsonb;BEGIN
 IF auth.uid() IS NULL OR p_operation IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=auth.uid()) OR NOT EXISTS(SELECT 1 FROM public.intel_theses WHERE id=p_thesis AND org_id=p_org AND user_id=auth.uid()) THEN RAISE EXCEPTION 'performance_review_forbidden';END IF;
 IF jsonb_typeof(p_review) IS DISTINCT FROM 'object' OR octet_length(p_review::text)>25000 THEN RAISE EXCEPTION 'invalid_performance_review';END IF;
 request:=jsonb_build_object('action','performance_review','thesis_id',p_thesis,'review',p_review);
 PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_operation::text,0));
 SELECT * INTO op FROM app_private.intel_activity_operations WHERE org_id=p_org AND user_id=auth.uid() AND operation_id=p_operation;
 IF FOUND THEN
  IF op.request->>'action'='performance_review_deleted' THEN RAISE EXCEPTION 'performance_review_deleted';END IF;
  IF op.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'performance_operation_reused';END IF;
  SELECT * INTO r FROM public.intel_thesis_reviews WHERE id=op.result_id AND org_id=p_org AND user_id=auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'performance_review_deleted';END IF;RETURN to_jsonb(r);
 END IF;
 INSERT INTO public.intel_thesis_reviews(org_id,user_id,thesis_id,note,performance_evaluation) VALUES(p_org,auth.uid(),p_thesis,p_review->>'note',p_review-'note') RETURNING * INTO r;
 INSERT INTO app_private.intel_activity_operations(org_id,user_id,operation_id,thesis_id,request,result_id) VALUES(p_org,auth.uid(),p_operation,p_thesis,request,r.id);
 RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.intel_save_performance_review(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_save_performance_review(uuid,uuid,uuid,jsonb) TO authenticated;

CREATE FUNCTION app_private.intel_performance_review_cleanup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF OLD.performance_evaluation IS NOT NULL THEN
  DELETE FROM public.intel_thesis_activity WHERE source_table='intel_thesis_reviews' AND source_id=OLD.id AND org_id=OLD.org_id AND user_id=OLD.user_id;
  UPDATE app_private.intel_activity_operations SET request='{"action":"performance_review_deleted"}' WHERE result_id=OLD.id AND org_id=OLD.org_id AND user_id=OLD.user_id;
 END IF;RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_performance_review_cleanup() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_performance_review_cleanup AFTER DELETE ON public.intel_thesis_reviews FOR EACH ROW EXECUTE FUNCTION app_private.intel_performance_review_cleanup();

CREATE FUNCTION public.intel_thesis_performance_ledger(p_org uuid,p_before_at timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL,p_limit integer DEFAULT 30) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE rows jsonb;summary jsonb;last_row jsonb;more boolean;BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=auth.uid()) THEN RAISE EXCEPTION 'performance_review_forbidden';END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>50 OR (p_before_at IS NULL)<>(p_before_id IS NULL) THEN RAISE EXCEPTION 'invalid_performance_page';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(page)),'[]') INTO rows FROM (
  SELECT t.id,t.title,t.subject_canonical_key,t.status,t.created_at,original.original_forecast,review.latest_review
  FROM public.intel_theses t
  LEFT JOIN LATERAL(SELECT jsonb_build_object('activity_id',a.id,'occurred_at',a.occurred_at,'recorded_at',a.recorded_at,'title',a.title_snapshot,'words',a.text_snapshot,'fields',a.changes) original_forecast FROM public.intel_thesis_activity a WHERE a.thesis_id=t.id AND a.org_id=p_org AND a.user_id=auth.uid() AND a.event_kind='thesis_created' AND a.historical_completeness='complete' ORDER BY a.occurred_at,a.id LIMIT 1) original ON true
  LEFT JOIN LATERAL(SELECT jsonb_build_object('id',r.id,'note',r.note,'recorded_at',r.created_at,'evaluation',r.performance_evaluation) latest_review FROM public.intel_thesis_reviews r WHERE r.thesis_id=t.id AND r.org_id=p_org AND r.user_id=auth.uid() AND r.performance_evaluation IS NOT NULL ORDER BY r.created_at DESC,r.id DESC LIMIT 1) review ON true
  WHERE t.org_id=p_org AND t.user_id=auth.uid() AND (p_before_at IS NULL OR (t.created_at,t.id)<(p_before_at,p_before_id)) ORDER BY t.created_at DESC,t.id DESC LIMIT p_limit+1
 ) page;
 more:=jsonb_array_length(rows)>p_limit;IF more THEN rows:=rows-p_limit;last_row:=rows->(p_limit-1);END IF;
 SELECT jsonb_build_object('total',coalesce(sum(count),0),'assessments',coalesce(jsonb_object_agg(assessment,count),'{}')) INTO summary FROM (
  SELECT coalesce(r.assessment,'unreviewed') assessment,count(*) count FROM public.intel_theses t
  LEFT JOIN LATERAL(SELECT performance_evaluation->>'assessment' assessment FROM public.intel_thesis_reviews WHERE thesis_id=t.id AND org_id=p_org AND user_id=auth.uid() AND performance_evaluation IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
  WHERE t.org_id=p_org AND t.user_id=auth.uid() GROUP BY coalesce(r.assessment,'unreviewed')
 ) counts;
 RETURN jsonb_build_object('rows',rows,'summary',summary,'next_cursor',CASE WHEN more THEN jsonb_build_object('at',last_row->>'created_at','id',last_row->>'id') END,'basis','All owned theses, including open, closed, archived, pending, ambiguous and unreviewed. Assessments are user recorded and separate from realized portfolio or journal P&L.');
END $$;
REVOKE ALL ON FUNCTION public.intel_thesis_performance_ledger(uuid,timestamptz,uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_thesis_performance_ledger(uuid,timestamptz,uuid,integer) TO authenticated;

DO $$ DECLARE original text;changed text;BEGIN
 original:=pg_get_functiondef('app_private.intel_capture_thesis_activity()'::regprocedure);
 changed:=replace(original,'''prev_stance'',''new_stance'',''note''];','''prev_stance'',''new_stance'',''note'',''performance_evaluation''];');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_performance_activity_capture';END IF;EXECUTE changed;
END $$;
