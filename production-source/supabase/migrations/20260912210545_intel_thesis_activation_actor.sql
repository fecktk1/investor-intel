-- Future explicit thesis activation is a user action, not a market observation.
-- Preserve all original activity, words, evaluation receipts, grants and checks.
SET lock_timeout='5s';
SET statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('app_private.intel_capture_thesis_activity()'::regprocedure))<>'bbe581ed6de9670320e81152822503cb'
 OR md5(pg_get_functiondef('public.intel_accept_thesis_condition(uuid,uuid,uuid,jsonb)'::regprocedure))<>'56a40401d5ed108bace47c61352b546c'
 THEN RAISE EXCEPTION 'unreviewed_thesis_activation_definition'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.intel_accept_thesis_condition(p_org uuid, p_user uuid, p_rule uuid, p_expected jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r intel_thesis_rules;t intel_theses;a intel_alert_rules;c jsonb;prior_actor text;BEGIN
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=p_org AND user_id=p_user) OR NOT can_access_intel(p_user,p_org) THEN RAISE EXCEPTION 'forbidden';END IF;
 SELECT * INTO r FROM intel_thesis_rules WHERE id=p_rule AND org_id=p_org AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'thesis_condition_not_found';END IF;
 SELECT * INTO t FROM intel_theses WHERE id=r.thesis_id AND org_id=p_org AND user_id=p_user;
 IF NOT FOUND OR t.subject_canonical_key IS NULL THEN RAISE EXCEPTION 'thesis_condition_identity_required';END IF;
 c:=app_private.intel_thesis_condition_config(to_jsonb(r));
 IF c IS DISTINCT FROM app_private.intel_thesis_condition_config(p_expected) THEN RAISE EXCEPTION 'thesis_condition_changed';END IF;
 IF r.comparator NOT IN ('>','>=','<','<=','=','!=','gt','gte','lt','lte','eq','neq') OR r.comparator IS NULL OR r.threshold IS NULL OR r.threshold::text IN ('NaN','Infinity','-Infinity') OR abs(r.threshold)>1e18
 OR nullif(btrim(r.metric),'') IS NULL OR nullif(btrim(r.threshold_unit),'') IS NULL OR nullif(btrim(r.time_window),'') IS NULL THEN RAISE EXCEPTION 'thesis_condition_explicit_unit_period_required';END IF;
 IF r.alert_rule_id IS NOT NULL THEN
  SELECT * INTO a FROM intel_alert_rules WHERE id=r.alert_rule_id AND org_id=p_org AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'thesis_condition_alert_unavailable';END IF;
  IF a.trigger_type='thesis_condition' AND a.is_active AND a.config->'condition'=c AND r.status='active' THEN RETURN jsonb_build_object('alert_rule',to_jsonb(a));END IF;
  UPDATE intel_alert_rules SET trigger_type='thesis_condition',config=jsonb_build_object('thesis_id',t.id,'thesis_rule_id',r.id,'asset',t.subject_canonical_key,'condition',c,'title',r.description,'delivery','in_app','repeat','once'),is_active=true WHERE id=a.id RETURNING * INTO a;
 ELSE
  INSERT INTO intel_alert_rules(org_id,user_id,entity_id,trigger_type,config,is_active,cooldown_minutes) VALUES(p_org,p_user,t.entity_id,'thesis_condition',jsonb_build_object('thesis_id',t.id,'thesis_rule_id',r.id,'asset',t.subject_canonical_key,'condition',c,'title',r.description,'delivery','in_app','repeat','once'),true,15) RETURNING * INTO a;
 END IF;
 -- The authenticated endpoint has already verified this owner and organization.
 -- Scope the attribution to this one rule update, without impersonating auth.uid().
 prior_actor:=current_setting('app.intel_user_condition_activation',true);
 PERFORM set_config('app.intel_user_condition_activation',p_org::text||':'||p_user::text||':'||p_rule::text,true);
 UPDATE intel_thesis_rules SET alert_rule_id=a.id,status='active',evaluation_state='{}' WHERE id=r.id;
 PERFORM set_config('app.intel_user_condition_activation',coalesce(prior_actor,''),true);
 RETURN jsonb_build_object('alert_rule',to_jsonb(a));
END $function$
;
CREATE OR REPLACE FUNCTION app_private.intel_capture_thesis_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  j jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  prev jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  p jsonb; tr jsonb; keys text[]; text_keys text[] := '{}'; k text;
  delta jsonb := '{}'; words jsonb := '{}'; kind text; tid uuid; trid uuid;
  entity uuid; canonical text; title text;
  linked jsonb; link_side text; source_context jsonb := '{}';
  at_time timestamptz := statement_timestamp(); actor text := CASE WHEN auth.uid() IS NULL THEN 'engine' ELSE 'user' END;
  operation text := COALESCE(NULLIF(current_setting('app.intel_activity_operation',true),''), txid_current()::text);
BEGIN
  IF j->>'user_id' IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=(j->>'user_id')::uuid)
    OR NOT EXISTS(SELECT 1 FROM public.orgs WHERE id=(j->>'org_id')::uuid) THEN RETURN NULL; END IF; -- orphan rows and account/org cascades
  IF TG_OP='DELETE' AND TG_TABLE_NAME IN ('intel_trade_reviews','intel_thesis_reviews','intel_thesis_evidence') THEN
    DELETE FROM public.intel_thesis_activity WHERE source_table=TG_TABLE_NAME AND source_id=(j->>'id')::uuid;
    DELETE FROM app_private.intel_activity_operations WHERE result_id=(j->>'id')::uuid AND org_id=(j->>'org_id')::uuid;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'intel_theses' THEN
    IF TG_OP = 'DELETE' THEN RETURN NULL; END IF; -- the FK cascade erases this person's history
    p := j; tid := (j->>'id')::uuid;
    keys := ARRAY['authored_draft','title','bull_thesis','bear_thesis','neutral_thesis','what_would_confirm','what_would_invalidate','key_risks','watched_metrics','sources','stance','conviction','status','time_horizon','review_cadence','next_review_at','benchmark_key','entity_id','subject_canonical_key','portfolio_id','visibility','engine_suggested_status'];
    text_keys := ARRAY['bull_thesis','bear_thesis','neutral_thesis','what_would_confirm','what_would_invalidate'];
    kind := CASE WHEN TG_OP = 'INSERT' THEN 'thesis_created' ELSE 'thesis_updated' END;
    IF TG_OP = 'UPDATE' AND j->'status' IS DISTINCT FROM prev->'status' THEN
      kind := CASE j->>'status' WHEN 'closed' THEN 'thesis_closed' WHEN 'archived' THEN 'thesis_archived'
        ELSE CASE WHEN prev->>'status' = 'archived' THEN 'thesis_restored' WHEN prev->>'status' = 'closed' THEN 'thesis_reopened' ELSE 'thesis_status_changed' END END;
    END IF;
  ELSIF TG_TABLE_NAME IN ('intel_trades','intel_trade_reviews') THEN
    IF TG_TABLE_NAME = 'intel_trades' THEN
      IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
      tr := j; trid := (j->>'id')::uuid;
      keys := ARRAY['thesis_id','entity_id','subject_canonical_key','symbol','chain','direction','trade_type','setup','status','planned_entry','planned_stop','target1','target2','target3','planned_size_usd','planned_size_pct','risk_amount','max_portfolio_risk','time_stop','invalidation_reason','pre_notes','rationale','emotion','checklist','entry_price','exit_price','fees_usd','size_usd','opened_at','closed_at','tags','entry_portfolio_event_kind','entry_portfolio_event_id','exit_portfolio_event_kind','exit_portfolio_event_id','last_exit_at','exited_fraction'];
      text_keys := ARRAY['setup','pre_notes','rationale','invalidation_reason'];
      kind := CASE WHEN TG_OP = 'INSERT' THEN 'trade_planned' ELSE 'trade_updated' END;
      IF j->>'closed_at' IS NOT NULL AND j->'closed_at' IS DISTINCT FROM prev->'closed_at' THEN
        kind := 'trade_exited'; at_time := (j->>'closed_at')::timestamptz;
      ELSIF j->>'opened_at' IS NOT NULL AND j->'opened_at' IS DISTINCT FROM prev->'opened_at' THEN
        kind := 'trade_entered'; at_time := (j->>'opened_at')::timestamptz;
      ELSIF j->>'status' = 'partially_closed' AND (j->'last_exit_at' IS DISTINCT FROM prev->'last_exit_at' OR j->'exited_fraction' IS DISTINCT FROM prev->'exited_fraction' OR j->'status' IS DISTINCT FROM prev->'status') THEN kind := 'trade_partial_exit'; at_time := COALESCE((j->>'last_exit_at')::timestamptz,at_time);
      ELSIF j->'status' IS DISTINCT FROM prev->'status' AND j->>'status' = 'cancelled' THEN kind := 'trade_cancelled'; END IF;
    ELSE
      trid := (j->>'trade_id')::uuid;
      SELECT to_jsonb(t) INTO tr FROM public.intel_trades t WHERE t.id = trid;
      IF tr IS NULL THEN RETURN NULL; END IF; -- parent cascade
      keys := ARRAY['outcome','followed_plan','what_went_well','what_went_wrong','mistakes','lesson','would_take_again','matched_thesis','emotion_tags','exit_snapshot'];
      text_keys := ARRAY['what_went_well','what_went_wrong','lesson']; kind := 'trade_reviewed';
      IF TG_OP = 'UPDATE' THEN kind := 'trade_review_updated'; END IF;
      -- The review belongs to the recorded exit operation, retaining recorded_at.
      IF TG_OP='INSERT' AND j->'exit_snapshot'->>'occurred_at' IS NOT NULL THEN at_time := (j->'exit_snapshot'->>'occurred_at')::timestamptz;
      ELSIF NULLIF(current_setting('app.intel_activity_operation',true),'') IS NOT NULL AND tr->>'closed_at' IS NOT NULL THEN at_time := (tr->>'closed_at')::timestamptz; END IF;
    END IF;
    tid := NULLIF(tr->>'thesis_id','')::uuid;
    IF tid IS NOT NULL THEN SELECT to_jsonb(t) INTO p FROM public.intel_theses t WHERE t.id = tid; END IF;
    entity := NULLIF(tr->>'entity_id','')::uuid; canonical := tr->>'subject_canonical_key';
  ELSE
    tid := (j->>'thesis_id')::uuid;
    SELECT to_jsonb(t) INTO p FROM public.intel_theses t WHERE t.id = tid;
    IF p IS NULL THEN RETURN NULL; END IF; -- parent cascade
    CASE TG_TABLE_NAME
    WHEN 'intel_thesis_reviews' THEN
      keys := ARRAY['review_kind','prev_status','new_status','prev_conviction','new_conviction','prev_stance','new_stance','note','performance_evaluation'];
      text_keys := ARRAY['note']; kind := CASE WHEN TG_OP = 'INSERT' THEN 'thesis_reviewed' ELSE 'thesis_review_updated' END;
      IF j->>'review_kind' = 'ai_draft' THEN actor := 'engine'; END IF;
    WHEN 'intel_thesis_scenarios' THEN
      keys := ARRAY['kind','narrative','probability','price_target','target_basis','assumptions','required_evidence','risks','trigger_text'];
      text_keys := ARRAY['narrative','trigger_text']; kind := 'scenario_changed';
    WHEN 'intel_thesis_rules' THEN
      keys := ARRAY['rule_kind','description','metric','comparator','threshold','threshold_unit','time_window','source_metric','status','triggered_at','origin'];
      text_keys := ARRAY['description']; kind := 'rule_changed';
      IF TG_OP='UPDATE' AND j->>'status'='active' AND j->'status' IS DISTINCT FROM prev->'status'
        AND current_setting('role',true)='service_role'
        AND current_setting('app.intel_user_condition_activation',true)=j->>'org_id'||':'||(j->>'user_id')||':'||(j->>'id')
      THEN actor:='user'; END IF;
      IF j->>'status' = 'triggered' AND j->'status' IS DISTINCT FROM prev->'status' THEN
        kind := CASE WHEN j->>'rule_kind' = 'invalidation' THEN 'rule_invalidated' ELSE 'rule_confirmed' END; IF j->'evaluation_state'->>'evidence_version' IS NOT NULL THEN delta:=delta||jsonb_build_object('condition_receipt',jsonb_build_object('before',NULL,'after',j->'evaluation_state')); END IF;
        at_time := COALESCE((j->>'triggered_at')::timestamptz,at_time); actor := 'engine';
      END IF;
    WHEN 'intel_thesis_evidence' THEN
      keys := ARRAY['source_table','source_ref','scenario_id','user_label','impact','impact_source','weight','is_baseline','event_type','event_at','event_snapshot'];
      kind := 'evidence_changed'; text_keys := ARRAY['user_label'];
      source_context := jsonb_strip_nulls(jsonb_build_object(
        'title',left(j->'event_snapshot'->>'title',500),
        'summary',left(j->'event_snapshot'->>'summary',2000),
        'summary_truncated',length(j->'event_snapshot'->>'summary')>2000,
        'url',CASE WHEN length(j->'event_snapshot'->>'url')<=2048 THEN j->'event_snapshot'->>'url' END,
        'source',j->'event_snapshot'->>'source','event_type',j->>'event_type','published_at',j->>'event_at'));
      IF j->>'impact_source' IN ('engine','ai_coach') THEN actor := 'engine'; END IF;
    END CASE;
  END IF;
  IF TG_OP = 'DELETE' THEN kind := replace(TG_TABLE_NAME,'intel_','') || '_removed'; END IF;
  FOREACH k IN ARRAY keys LOOP
    IF TG_OP <> 'UPDATE' OR j->k IS DISTINCT FROM prev->k THEN
      IF k='event_snapshot' THEN
        -- Source revisions are identified without copying an arbitrary provider payload.
        delta := delta || jsonb_build_object('source_content',jsonb_build_object('before',CASE WHEN TG_OP='INSERT' THEN NULL ELSE md5((prev->k)::text) END,'after',md5((j->k)::text)));
      ELSE
      delta := delta || jsonb_build_object(k,jsonb_build_object('before',CASE WHEN TG_OP='INSERT' THEN NULL ELSE CASE WHEN TG_OP='DELETE' THEN j->k ELSE prev->k END END,'after',CASE WHEN TG_OP='DELETE' THEN NULL ELSE j->k END));
      END IF;
    END IF;
  END LOOP;
  IF delta = '{}'::jsonb THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'intel_theses' AND delta - 'engine_suggested_status' = '{}'::jsonb THEN kind := 'engine_suggestion'; actor := 'engine'; END IF;
  FOREACH k IN ARRAY text_keys LOOP
    IF NULLIF(j->>k,'') IS NOT NULL THEN words := words || jsonb_build_object(k,j->k); END IF;
  END LOOP;
  IF TG_TABLE_NAME='intel_theses' THEN words := words || COALESCE(j->'authored_draft','{}'::jsonb); END IF;
  entity := COALESCE(entity,NULLIF(p->>'entity_id','')::uuid);
  canonical := COALESCE(canonical,p->>'subject_canonical_key'); title := p->>'title';
  IF entity IS NOT NULL THEN SELECT COALESCE(e.canonical_ref_key,canonical) INTO canonical FROM public.entities e WHERE e.id=entity; END IF;
  link_side := CASE WHEN kind='trade_entered' THEN 'entry' WHEN kind IN ('trade_exited','trade_partial_exit','trade_reviewed','trade_review_updated') THEN 'exit' ELSE NULL END;
  IF TG_TABLE_NAME='intel_trade_reviews' AND j->'exit_snapshot'->'linked_source_ref' IS NOT NULL AND j->'exit_snapshot'->'linked_source_ref'<>'null'::jsonb THEN
    linked := j->'exit_snapshot'->'linked_source_ref';
  ELSIF link_side IS NOT NULL AND tr->>(link_side||'_portfolio_event_id') IS NOT NULL THEN
    linked := jsonb_build_object('kind',tr->>(link_side||'_portfolio_event_kind'),'id',tr->>(link_side||'_portfolio_event_id'),'eventKey',(tr->>(link_side||'_portfolio_event_kind'))||':'||(tr->>(link_side||'_portfolio_event_id')));
  END IF;
  INSERT INTO public.intel_thesis_activity(org_id,user_id,thesis_id,trade_id,entity_id,canonical_key,event_kind,actor_kind,occurred_at,operation_id,source_table,source_id,title_snapshot,text_snapshot,changes,source_visibility,linked_source_ref,source_snapshot)
  VALUES ((j->>'org_id')::uuid,(j->>'user_id')::uuid,tid,trid,entity,canonical,kind,actor,at_time,operation,TG_TABLE_NAME,(j->>'id')::uuid,title,words,delta,COALESCE(j->>'visibility','private'),linked,source_context);
  IF TG_TABLE_NAME='intel_trades' AND kind='trade_exited' AND j->>'opened_at' IS NOT NULL AND j->'opened_at' IS DISTINCT FROM prev->'opened_at' THEN
    linked := CASE WHEN tr->>'entry_portfolio_event_id' IS NULL THEN NULL ELSE jsonb_build_object('kind',tr->>'entry_portfolio_event_kind','id',tr->>'entry_portfolio_event_id','eventKey',(tr->>'entry_portfolio_event_kind')||':'||(tr->>'entry_portfolio_event_id')) END;
    INSERT INTO public.intel_thesis_activity(org_id,user_id,thesis_id,trade_id,entity_id,canonical_key,event_kind,actor_kind,occurred_at,operation_id,source_table,source_id,title_snapshot,text_snapshot,changes,linked_source_ref)
    VALUES ((j->>'org_id')::uuid,(j->>'user_id')::uuid,tid,trid,entity,canonical,'trade_entered',actor,(j->>'opened_at')::timestamptz,operation,TG_TABLE_NAME,(j->>'id')::uuid,title,words,delta,linked);
  END IF;
  RETURN NULL;
END $function$
;
