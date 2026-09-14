-- Authored reasoning belongs to the existing private journal and its deletion/history rules.
-- No historical backfill: previously unsaved words cannot be reconstructed.
ALTER TABLE public.intel_theses ADD COLUMN authored_draft jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE OR REPLACE FUNCTION app_private.intel_valid_authored_draft(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_typeof(value)='object' AND octet_length(value::text)<=131072
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(value)='object' THEN value ELSE '{}'::jsonb END) e
     WHERE e.key<>ALL(ARRAY['statement','why_now','whats_missing','supports','weakens','proves_wrong','opposing'])
       OR jsonb_typeof(e.value)<>'string' OR length(e.value #>> '{}')>16000)
$$;
REVOKE ALL ON FUNCTION app_private.intel_valid_authored_draft(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.intel_valid_authored_draft(jsonb) TO authenticated,service_role;
ALTER TABLE public.intel_theses ADD CONSTRAINT intel_authored_draft_valid CHECK(app_private.intel_valid_authored_draft(authored_draft));
COMMENT ON COLUMN public.intel_theses.authored_draft IS 'Verbatim authored builder fields; material changes captured in the existing thesis activity stream.';

CREATE OR REPLACE FUNCTION public.create_thesis_with_baseline(payload jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := get_my_org_id();
  v_user uuid := auth.uid();
  v_vis text := COALESCE(NULLIF(payload->>'visibility',''), 'private');
  v_key text := NULLIF(payload->>'idempotency_key','');
  v_thesis uuid;
  e jsonb;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF COALESCE(NULLIF(payload->>'title',''), '') = '' THEN RAISE EXCEPTION 'title required'; END IF;

  -- Serialize identical create operations before reading, including concurrent retries.
  IF v_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_user::text || ':' || v_key, 0)); END IF;
  -- idempotency: a retried create returns the existing thesis, no duplicate
  IF v_key IS NOT NULL THEN
    SELECT id INTO v_thesis FROM intel_theses
      WHERE org_id = v_org AND user_id = v_user AND idempotency_key = v_key;
    IF v_thesis IS NOT NULL THEN RETURN v_thesis; END IF;
  END IF;

  INSERT INTO intel_theses (
    org_id, user_id, entity_id, subject_kind, subject_canonical_key, portfolio_id,
    title, thesis_type, stance, conviction, time_horizon, review_cadence, benchmark_key,
    visibility, status, status_source, next_review_at, ai_summary, authored_draft,
    bull_thesis, bear_thesis, neutral_thesis, what_would_confirm, what_would_invalidate,
    watched_metrics, key_risks, sources, idempotency_key
  ) VALUES (
    v_org, v_user,
    NULLIF(payload->>'entity_id','')::uuid,
    NULLIF(payload->>'subject_kind',''),
    NULLIF(payload->>'subject_canonical_key',''),
    NULLIF(payload->>'portfolio_id','')::uuid,
    payload->>'title',
    COALESCE(NULLIF(payload->>'thesis_type',''), 'asset'),
    NULLIF(payload->>'stance',''),
    NULLIF(payload->>'conviction','')::numeric,
    NULLIF(payload->>'time_horizon',''),
    NULLIF(payload->>'review_cadence',''),
    NULLIF(payload->>'benchmark_key',''),
    v_vis,
    COALESCE(NULLIF(payload->>'status',''), 'active'),
    'user',
    NULLIF(payload->>'next_review_at','')::timestamptz,
    NULLIF(payload->>'ai_summary',''),
    COALESCE(payload->'authored_draft', '{}'::jsonb),
    NULLIF(payload->>'bull_thesis',''),
    NULLIF(payload->>'bear_thesis',''),
    NULLIF(payload->>'neutral_thesis',''),
    NULLIF(payload->>'what_would_confirm',''),
    NULLIF(payload->>'what_would_invalidate',''),
    COALESCE(payload->'watched_metrics', '[]'::jsonb),
    COALESCE(payload->'key_risks', '[]'::jsonb),
    COALESCE(payload->'sources', '[]'::jsonb),
    v_key
  ) RETURNING id INTO v_thesis;

  -- scenarios
  IF jsonb_typeof(payload->'scenarios') = 'array' THEN
    INSERT INTO intel_thesis_scenarios (org_id, user_id, thesis_id, visibility, kind, narrative,
      probability, price_target, target_basis, assumptions, required_evidence, risks, trigger_text, ordinal)
    SELECT v_org, v_user, v_thesis, v_vis,
      s->>'kind', NULLIF(s->>'narrative',''),
      NULLIF(s->>'probability','')::numeric, NULLIF(s->>'price_target','')::numeric, NULLIF(s->>'target_basis',''),
      COALESCE(s->'assumptions','[]'::jsonb), COALESCE(s->'required_evidence','[]'::jsonb), COALESCE(s->'risks','[]'::jsonb),
      NULLIF(s->>'trigger_text',''), COALESCE(NULLIF(s->>'ordinal','')::int, 0)
    FROM jsonb_array_elements(payload->'scenarios') s
    WHERE s->>'kind' IN ('bull','base','bear');
  END IF;

  -- rules
  IF jsonb_typeof(payload->'rules') = 'array' THEN
    INSERT INTO intel_thesis_rules (org_id, user_id, thesis_id, visibility, rule_kind, description,
      metric, comparator, threshold, threshold_unit, time_window, source_metric, origin)
    SELECT v_org, v_user, v_thesis, v_vis,
      r->>'rule_kind', COALESCE(NULLIF(r->>'description',''), 'rule'),
      NULLIF(r->>'metric',''), NULLIF(r->>'comparator',''), NULLIF(r->>'threshold','')::numeric,
      NULLIF(r->>'threshold_unit',''), NULLIF(r->>'time_window',''), NULLIF(r->>'source_metric',''),
      COALESCE(NULLIF(r->>'origin',''), 'user')
    FROM jsonb_array_elements(payload->'rules') r
    WHERE r->>'rule_kind' IN ('confirmation','invalidation');
  END IF;

  -- baseline evidence (frozen, is_baseline = true)
  IF jsonb_typeof(payload->'evidence') = 'array' THEN
    FOR e IN SELECT * FROM jsonb_array_elements(payload->'evidence') LOOP
      INSERT INTO intel_thesis_evidence (org_id, user_id, thesis_id, visibility, source_table, source_ref,
        event_type, event_at, event_snapshot, user_label, ai_label, impact, impact_source, is_baseline, weight)
      VALUES (v_org, v_user, v_thesis, v_vis,
        COALESCE(NULLIF(e->>'source_table',''), 'manual'),
        COALESCE(NULLIF(e->>'source_ref',''), gen_random_uuid()::text),
        NULLIF(e->>'event_type',''), NULLIF(e->>'event_at','')::timestamptz,
        COALESCE(e->'event_snapshot','{}'::jsonb),
        NULLIF(e->>'user_label',''), NULLIF(e->>'ai_label',''), NULLIF(e->>'impact',''),
        COALESCE(NULLIF(e->>'impact_source',''), 'user'), true, NULLIF(e->>'weight','')::numeric)
      ON CONFLICT (thesis_id, source_table, source_ref) WHERE source_ref IS NOT NULL DO NOTHING;
    END LOOP;
  END IF;

  -- immutable baseline snapshot
  IF payload ? 'baseline' THEN
    INSERT INTO intel_thesis_snapshots (org_id, user_id, thesis_id, visibility, snapshot_kind,
      price_snapshot, benchmark_snapshot, liquidity_snapshot, fundamentals_snapshot, portfolio_snapshot,
      evidence_snapshot, chart_state, ai_summary, context_pack_hash, source_snapshot_ids, data_coverage)
    VALUES (v_org, v_user, v_thesis, v_vis, 'baseline',
      COALESCE(payload#>'{baseline,price_snapshot}','{}'::jsonb),
      COALESCE(payload#>'{baseline,benchmark_snapshot}','{}'::jsonb),
      COALESCE(payload#>'{baseline,liquidity_snapshot}','{}'::jsonb),
      COALESCE(payload#>'{baseline,fundamentals_snapshot}','{}'::jsonb),
      COALESCE(payload#>'{baseline,portfolio_snapshot}','{}'::jsonb),
      COALESCE(payload#>'{baseline,evidence_snapshot}','[]'::jsonb),
      COALESCE(payload#>'{baseline,chart_state}','{}'::jsonb),
      NULLIF(payload#>>'{baseline,ai_summary}',''),
      NULLIF(payload#>>'{baseline,context_pack_hash}',''),
      COALESCE(payload#>'{baseline,source_snapshot_ids}','{}'::jsonb),
      COALESCE(payload#>'{baseline,data_coverage}','{}'::jsonb))
    ON CONFLICT (thesis_id) WHERE snapshot_kind = 'baseline' DO NOTHING;
  END IF;

  RETURN v_thesis;
END $$;


REVOKE ALL ON FUNCTION public.create_thesis_with_baseline(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_thesis_with_baseline(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.intel_capture_thesis_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  j jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  prev jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  p jsonb; tr jsonb; keys text[]; text_keys text[] := '{}'; k text;
  delta jsonb := '{}'; words jsonb := '{}'; kind text; tid uuid; trid uuid;
  entity uuid; canonical text; title text;
  linked jsonb; link_side text;
  at_time timestamptz := statement_timestamp(); actor text := CASE WHEN auth.uid() IS NULL THEN 'engine' ELSE 'user' END;
  operation text := COALESCE(NULLIF(current_setting('app.intel_activity_operation',true),''), txid_current()::text);
BEGIN
  IF j->>'user_id' IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=(j->>'user_id')::uuid)
    OR NOT EXISTS(SELECT 1 FROM public.orgs WHERE id=(j->>'org_id')::uuid) THEN RETURN NULL; END IF; -- orphan rows and account/org cascades
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
      keys := ARRAY['thesis_id','entity_id','subject_canonical_key','symbol','chain','direction','trade_type','setup','status','planned_entry','planned_stop','target1','target2','target3','planned_size_usd','planned_size_pct','risk_amount','max_portfolio_risk','time_stop','invalidation_reason','pre_notes','rationale','emotion','checklist','entry_price','exit_price','fees_usd','size_usd','opened_at','closed_at','tags','entry_portfolio_event_kind','entry_portfolio_event_id','exit_portfolio_event_kind','exit_portfolio_event_id'];
      text_keys := ARRAY['setup','pre_notes','rationale','invalidation_reason'];
      kind := CASE WHEN TG_OP = 'INSERT' THEN 'trade_planned' ELSE 'trade_updated' END;
      IF j->>'closed_at' IS NOT NULL AND j->'closed_at' IS DISTINCT FROM prev->'closed_at' THEN
        kind := 'trade_exited'; at_time := (j->>'closed_at')::timestamptz;
      ELSIF j->>'opened_at' IS NOT NULL AND j->'opened_at' IS DISTINCT FROM prev->'opened_at' THEN
        kind := 'trade_entered'; at_time := (j->>'opened_at')::timestamptz;
      ELSIF j->'status' IS DISTINCT FROM prev->'status' AND j->>'status' = 'partially_closed' THEN kind := 'trade_partial_exit';
      ELSIF j->'status' IS DISTINCT FROM prev->'status' AND j->>'status' = 'cancelled' THEN kind := 'trade_cancelled'; END IF;
    ELSE
      trid := (j->>'trade_id')::uuid;
      SELECT to_jsonb(t) INTO tr FROM public.intel_trades t WHERE t.id = trid;
      IF tr IS NULL THEN RETURN NULL; END IF; -- parent cascade
      keys := ARRAY['outcome','followed_plan','what_went_well','what_went_wrong','mistakes','lesson','would_take_again','matched_thesis','emotion_tags'];
      text_keys := ARRAY['what_went_well','what_went_wrong','lesson']; kind := 'trade_reviewed';
      IF TG_OP = 'UPDATE' THEN kind := 'trade_review_updated'; END IF;
      -- The review belongs to the recorded exit operation, retaining recorded_at.
      IF NULLIF(current_setting('app.intel_activity_operation',true),'') IS NOT NULL AND tr->>'closed_at' IS NOT NULL THEN at_time := (tr->>'closed_at')::timestamptz; END IF;
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
      keys := ARRAY['review_kind','prev_status','new_status','prev_conviction','new_conviction','prev_stance','new_stance','note'];
      text_keys := ARRAY['note']; kind := CASE WHEN TG_OP = 'INSERT' THEN 'thesis_reviewed' ELSE 'thesis_review_updated' END;
      IF j->>'review_kind' = 'ai_draft' THEN actor := 'engine'; END IF;
    WHEN 'intel_thesis_scenarios' THEN
      keys := ARRAY['kind','narrative','probability','price_target','target_basis','assumptions','required_evidence','risks','trigger_text'];
      text_keys := ARRAY['narrative','trigger_text']; kind := 'scenario_changed';
    WHEN 'intel_thesis_rules' THEN
      keys := ARRAY['rule_kind','description','metric','comparator','threshold','threshold_unit','time_window','source_metric','status','triggered_at','origin'];
      text_keys := ARRAY['description']; kind := 'rule_changed';
      IF j->>'status' = 'triggered' AND j->'status' IS DISTINCT FROM prev->'status' THEN
        kind := CASE WHEN j->>'rule_kind' = 'invalidation' THEN 'rule_invalidated' ELSE 'rule_confirmed' END;
        at_time := COALESCE((j->>'triggered_at')::timestamptz,at_time); actor := 'engine';
      END IF;
    WHEN 'intel_thesis_evidence' THEN
      keys := ARRAY['source_table','source_ref','scenario_id','user_label','impact','impact_source','weight','is_baseline'];
      kind := 'evidence_changed';
      IF j->>'impact_source' IN ('engine','ai_coach') THEN actor := 'engine'; END IF;
    END CASE;
  END IF;
  IF TG_OP = 'DELETE' THEN kind := replace(TG_TABLE_NAME,'intel_','') || '_removed'; END IF;
  FOREACH k IN ARRAY keys LOOP
    IF TG_OP <> 'UPDATE' OR j->k IS DISTINCT FROM prev->k THEN
      delta := delta || jsonb_build_object(k,jsonb_build_object('before',CASE WHEN TG_OP='INSERT' THEN NULL ELSE CASE WHEN TG_OP='DELETE' THEN j->k ELSE prev->k END END,'after',CASE WHEN TG_OP='DELETE' THEN NULL ELSE j->k END));
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
  IF link_side IS NOT NULL AND tr->>(link_side||'_portfolio_event_id') IS NOT NULL THEN
    linked := jsonb_build_object('kind',tr->>(link_side||'_portfolio_event_kind'),'id',tr->>(link_side||'_portfolio_event_id'),'eventKey',(tr->>(link_side||'_portfolio_event_kind'))||':'||(tr->>(link_side||'_portfolio_event_id')));
  END IF;
  INSERT INTO public.intel_thesis_activity(org_id,user_id,thesis_id,trade_id,entity_id,canonical_key,event_kind,actor_kind,occurred_at,operation_id,source_table,source_id,title_snapshot,text_snapshot,changes,source_visibility,linked_source_ref)
  VALUES ((j->>'org_id')::uuid,(j->>'user_id')::uuid,tid,trid,entity,canonical,kind,actor,at_time,operation,TG_TABLE_NAME,(j->>'id')::uuid,title,words,delta,COALESCE(j->>'visibility','private'),linked);
  IF TG_TABLE_NAME='intel_trades' AND kind='trade_exited' AND j->>'opened_at' IS NOT NULL AND j->'opened_at' IS DISTINCT FROM prev->'opened_at' THEN
    linked := CASE WHEN tr->>'entry_portfolio_event_id' IS NULL THEN NULL ELSE jsonb_build_object('kind',tr->>'entry_portfolio_event_kind','id',tr->>'entry_portfolio_event_id','eventKey',(tr->>'entry_portfolio_event_kind')||':'||(tr->>'entry_portfolio_event_id')) END;
    INSERT INTO public.intel_thesis_activity(org_id,user_id,thesis_id,trade_id,entity_id,canonical_key,event_kind,actor_kind,occurred_at,operation_id,source_table,source_id,title_snapshot,text_snapshot,changes,linked_source_ref)
    VALUES ((j->>'org_id')::uuid,(j->>'user_id')::uuid,tid,trid,entity,canonical,'trade_entered',actor,(j->>'opened_at')::timestamptz,operation,TG_TABLE_NAME,(j->>'id')::uuid,title,words,delta,linked);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_capture_thesis_activity() FROM PUBLIC, anon, authenticated;

