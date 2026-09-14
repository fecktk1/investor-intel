-- Preserve each partial exit and original review within the existing journal.
-- These records do not write holdings, portfolio transactions or balance history.
ALTER TABLE public.intel_trades ADD COLUMN last_exit_at timestamptz,
 ADD COLUMN exited_fraction numeric NOT NULL DEFAULT 0 CHECK (exited_fraction>=0 AND exited_fraction<=1);
ALTER TABLE public.intel_trade_reviews ADD COLUMN exit_snapshot jsonb;
ALTER TABLE app_private.intel_activity_operations ADD COLUMN result_snapshot jsonb;
COMMENT ON COLUMN public.intel_trade_reviews.exit_snapshot IS 'Saved journal calculation and linked event at this exit; private, removed with its review.';

-- Legacy writers still pass through the parent/owner guard. This additional
-- boundary checks exact asset identity and the real occurrence time of links.
CREATE FUNCTION app_private.intel_validate_trade_execution_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE side text; kind text; ref uuid; leg record; e public.entities; aliases text[]; j jsonb:=to_jsonb(NEW); old_j jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN old_j:=to_jsonb(OLD); END IF;
 SELECT * INTO e FROM public.entities WHERE id=NEW.entity_id AND org_id=NEW.org_id;
 aliases:=app_private.intel_entity_identity_aliases(e,NEW.subject_canonical_key);
 -- Verified native provider identities, never a ticker comparison.
 aliases:=array_append(aliases,CASE NEW.subject_canonical_key
  WHEN 'market:coingecko:bitcoin' THEN 'bip122:native:BTC' WHEN 'market:coinmarketcap:1' THEN 'bip122:native:BTC'
  WHEN 'market:coingecko:ethereum' THEN 'eip155:1:native' WHEN 'market:coinmarketcap:1027' THEN 'eip155:1:native'
  WHEN 'market:coingecko:solana' THEN 'solana:native:SOL' WHEN 'market:coinmarketcap:5426' THEN 'solana:native:SOL'
  WHEN 'market:coingecko:binancecoin' THEN 'eip155:56:native' WHEN 'market:coinmarketcap:1839' THEN 'eip155:56:native'
  WHEN 'market:coingecko:avalanche-2' THEN 'eip155:43114:native' WHEN 'market:coinmarketcap:5805' THEN 'eip155:43114:native' END);
 aliases:=array_remove(aliases,NULL);
 FOREACH side IN ARRAY ARRAY['entry','exit'] LOOP
  kind:=j->>(side||'_portfolio_event_kind'); ref:=NULLIF(j->>(side||'_portfolio_event_id'),'')::uuid;
  IF ref IS NULL THEN CONTINUE; END IF;
  IF TG_OP='UPDATE' AND j->(side||'_portfolio_event_id') IS NOT DISTINCT FROM old_j->(side||'_portfolio_event_id')
   AND j->(side||'_portfolio_event_kind') IS NOT DISTINCT FROM old_j->(side||'_portfolio_event_kind')
   AND NEW.portfolio_id IS NOT DISTINCT FROM OLD.portfolio_id AND NEW.subject_canonical_key IS NOT DISTINCT FROM OLD.subject_canonical_key
   AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id THEN CONTINUE; END IF;
  IF kind='manual' THEN
   SELECT x.canonical_asset_key AS key,x.chain,x.asset_symbol AS symbol,x.timestamp AS happened_at,x.transaction_type AS type,
    CASE WHEN upper(x.quote_currency)='USD' THEN x.price_per_unit END AS price,x.quantity INTO leg
    FROM public.investor_portfolio_transactions x JOIN public.investor_portfolio_sources s ON s.id=x.source_id AND s.source_type='manual'
    WHERE x.id=ref AND x.org_id=NEW.org_id AND x.user_id=NEW.user_id AND x.portfolio_id=NEW.portfolio_id;
  ELSIF kind='grouped' THEN
   SELECT l.canonical_asset_key AS key,g.chain,l.symbol,g.block_time AS happened_at,g.type,
    CASE WHEN l.price_source_at_tx NOT IN ('current_price_estimate','zero_value_unpriced') THEN l.price_usd_at_tx END AS price,NULL::numeric AS quantity INTO leg
    FROM public.investor_portfolio_tx g JOIN public.investor_portfolio_tx_line_items l ON l.tx_id=g.id
    JOIN public.investor_portfolio_sources s ON s.id=g.source_id AND s.source_type<>'manual'
    WHERE g.id=ref AND g.org_id=NEW.org_id AND g.user_id=NEW.user_id AND g.portfolio_id=NEW.portfolio_id
     AND l.org_id=NEW.org_id AND l.user_id=NEW.user_id AND l.portfolio_id=NEW.portfolio_id
     AND l.canonical_asset_key=ANY(aliases) AND g.status='success' AND NOT g.is_display_mirror
    ORDER BY l.leg_index,l.id LIMIT 1;
  ELSE RAISE EXCEPTION 'Invalid recorded execution link' USING ERRCODE='42501'; END IF;
  IF NOT FOUND OR leg.key IS NULL OR NOT leg.key=ANY(aliases) OR leg.happened_at IS NULL OR leg.type NOT IN ('buy','sell','swap') THEN
   RAISE EXCEPTION 'Link a completed purchase, sale or swap for this exact asset' USING ERRCODE='42501';
  END IF;
  NEW.chain:=leg.chain; NEW.symbol:=leg.symbol;
  IF side='entry' THEN
   NEW.opened_at:=leg.happened_at;
   IF leg.price IS NOT NULL AND NEW.entry_price IS DISTINCT FROM leg.price THEN RAISE EXCEPTION 'Linked entry price must match the recorded transaction'; END IF;
  ELSIF NEW.last_exit_at IS NOT NULL AND NEW.last_exit_at<>leg.happened_at THEN
   RAISE EXCEPTION 'Linked exit time must match the recorded transaction';
  ELSIF NEW.closed_at IS NOT NULL AND NEW.closed_at<>leg.happened_at THEN
   RAISE EXCEPTION 'Linked exit time must match the recorded transaction';
  END IF;
  IF side='exit' THEN
   IF leg.price IS NOT NULL AND NEW.exit_price IS DISTINCT FROM leg.price THEN RAISE EXCEPTION 'Linked exit price must match the recorded transaction'; END IF;
   IF TG_OP='UPDATE' AND leg.quantity IS NOT NULL AND NEW.entry_price>0 AND NEW.size_usd>0
    AND abs(leg.quantity-(NEW.size_usd/NEW.entry_price)*(NEW.exited_fraction-OLD.exited_fraction))>greatest(0.000000001,abs(leg.quantity)*0.000001)
    THEN RAISE EXCEPTION 'Exit portion must match the linked transaction quantity'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_validate_trade_execution_link() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zz_intel_trade_execution_link BEFORE INSERT OR UPDATE ON public.intel_trades
 FOR EACH ROW EXECUTE FUNCTION app_private.intel_validate_trade_execution_link();

CREATE OR REPLACE FUNCTION public.intel_close_trade_with_review(p_org_id uuid,p_trade_id uuid,p_trade jsonb,p_review jsonb,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE tr public.intel_trades%ROWTYPE; r public.intel_trade_reviews%ROWTYPE;
 op app_private.intel_activity_operations%ROWTYPE; payload jsonb; exit_at timestamptz; fraction numeric; accumulated numeric;
 entry numeric; price numeric; fee numeric; size numeric; gain numeric; cumulative_gain numeric; pct numeric; multiple numeric; snapshot jsonb; result jsonb;
BEGIN
 IF auth.uid() IS NULL OR p_operation_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=p_org_id AND m.user_id=auth.uid()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_trade) IS DISTINCT FROM 'object' OR jsonb_typeof(p_review) IS DISTINCT FROM 'object' OR octet_length(p_trade::text)+octet_length(p_review::text)>131072 THEN RAISE EXCEPTION 'Invalid trade review'; END IF;
 payload:=jsonb_build_object('action','close_trade','trade_id',p_trade_id,'trade',p_trade,'review',p_review);
 PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_operation_id::text,0));
 SELECT * INTO op FROM app_private.intel_activity_operations WHERE org_id=p_org_id AND user_id=auth.uid() AND operation_id=p_operation_id;
 IF FOUND THEN
  IF op.request IS DISTINCT FROM payload THEN RAISE EXCEPTION 'Idempotency key reused for a different action'; END IF;
  IF op.result_snapshot IS NOT NULL THEN RETURN op.result_snapshot; END IF;
  SELECT * INTO r FROM public.intel_trade_reviews WHERE id=op.result_id;
  SELECT * INTO tr FROM public.intel_trades WHERE id=p_trade_id;
  RETURN jsonb_build_object('trade',to_jsonb(tr),'review',to_jsonb(r));
 END IF;
 SELECT * INTO tr FROM public.intel_trades WHERE id=p_trade_id AND org_id=p_org_id AND user_id=auth.uid() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found' USING ERRCODE='42501'; END IF;
 IF tr.status IN ('closed','cancelled','invalidated') THEN RAISE EXCEPTION 'This journal trade is already closed'; END IF;
 IF NULLIF(p_trade->>'exit_portfolio_event_id','') IS NOT NULL AND EXISTS(SELECT 1 FROM public.intel_trade_reviews review WHERE review.trade_id=tr.id
  AND review.exit_snapshot->'linked_source_ref'->>'id'=p_trade->>'exit_portfolio_event_id'
  AND review.exit_snapshot->'linked_source_ref'->>'kind'=p_trade->>'exit_portfolio_event_kind') THEN RAISE EXCEPTION 'This portfolio execution is already linked to an exit review'; END IF;
 fraction:=COALESCE(NULLIF(p_trade->>'exit_fraction','')::numeric,1-tr.exited_fraction);
 IF fraction::text IN ('NaN','Infinity','-Infinity') OR fraction<=0 OR fraction>1-tr.exited_fraction THEN RAISE EXCEPTION 'Exit portion exceeds the remaining original position'; END IF;
 accumulated:=tr.exited_fraction+fraction;
 IF p_trade->>'status'='partially_closed' AND accumulated>=1 THEN RAISE EXCEPTION 'A partial exit must leave some of the original position open'; END IF;
 IF p_trade->>'status'='closed' AND accumulated<1 THEN RAISE EXCEPTION 'Choose partial exit for less than the remaining position'; END IF;
 exit_at:=COALESCE(NULLIF(p_trade->>'closed_at','')::timestamptz,statement_timestamp());
 IF NOT isfinite(exit_at) OR exit_at>statement_timestamp()+interval '5 minutes' OR exit_at<COALESCE(tr.last_exit_at,tr.opened_at,'-infinity'::timestamptz) THEN RAISE EXCEPTION 'Exit time must follow entry and previous exits and cannot be in the future'; END IF;
 entry:=COALESCE(NULLIF(p_trade->>'entry_price','')::numeric,tr.entry_price,tr.planned_entry);
 price:=NULLIF(p_trade->>'exit_price','')::numeric;
 fee:=COALESCE(NULLIF(p_trade->>'fees_usd','')::numeric,0);
 size:=COALESCE(tr.size_usd,tr.planned_size_usd);
 IF entry::text IN ('NaN','Infinity','-Infinity') OR price::text IN ('NaN','Infinity','-Infinity') OR fee::text IN ('NaN','Infinity','-Infinity') OR entry<=0 OR price<=0 OR fee<0 THEN RAISE EXCEPTION 'Invalid entry, exit price or fees'; END IF;
 IF tr.exited_fraction>0 AND entry IS DISTINCT FROM tr.entry_price THEN RAISE EXCEPTION 'The entry price cannot change after a partial exit'; END IF;
 IF entry IS NOT NULL AND price IS NOT NULL AND size>0 THEN
  gain:=round((CASE WHEN tr.direction='short' THEN entry-price ELSE price-entry END)/entry*size*fraction-fee,8);
  cumulative_gain:=CASE WHEN tr.exited_fraction=0 THEN gain WHEN tr.realized_pnl_usd IS NOT NULL THEN tr.realized_pnl_usd+gain ELSE NULL END;
  pct:=round(cumulative_gain/size*100,8);
  IF tr.planned_stop>0 AND tr.planned_stop<>entry THEN multiple:=round(cumulative_gain/(abs(entry-tr.planned_stop)/entry*size),8); END IF;
 END IF;
 snapshot:=jsonb_build_object('calculation_version','journal-return-2','occurred_at',exit_at,'exit_fraction',fraction,
  'cumulative_fraction',accumulated,'entry_price',entry,'exit_price',price,'fees_usd',fee,'original_size_usd',size,
  'realized_pnl_usd',gain,'cumulative_realized_pnl_usd',cumulative_gain,'currency','USD',
  'linked_source_ref',CASE WHEN NULLIF(p_trade->>'exit_portfolio_event_id','') IS NULL THEN NULL ELSE jsonb_build_object(
   'kind',p_trade->>'exit_portfolio_event_kind','id',p_trade->>'exit_portfolio_event_id','eventKey',(p_trade->>'exit_portfolio_event_kind')||':'||(p_trade->>'exit_portfolio_event_id')) END);
 PERFORM set_config('app.intel_activity_operation',p_operation_id::text,true);
 UPDATE public.intel_trades SET status=CASE WHEN accumulated=1 THEN 'closed' ELSE 'partially_closed' END,
  closed_at=CASE WHEN accumulated=1 THEN exit_at ELSE NULL END,last_exit_at=exit_at,exited_fraction=accumulated,
  portfolio_id=COALESCE(NULLIF(p_trade->>'portfolio_id','')::uuid,portfolio_id),
  exit_portfolio_event_kind=NULLIF(p_trade->>'exit_portfolio_event_kind',''),exit_portfolio_event_id=NULLIF(p_trade->>'exit_portfolio_event_id','')::uuid,
  entry_price=entry,exit_price=price,fees_usd=COALESCE(fees_usd,0)+fee,realized_pnl_usd=cumulative_gain,realized_pnl_pct=pct,r_multiple=multiple
 WHERE id=tr.id RETURNING * INTO tr;
 INSERT INTO public.intel_trade_reviews(org_id,user_id,trade_id,outcome,followed_plan,what_went_well,what_went_wrong,mistakes,lesson,would_take_again,matched_thesis,emotion_tags,exit_snapshot)
 VALUES(p_org_id,auth.uid(),tr.id,NULLIF(p_review->>'outcome',''),NULLIF(p_review->>'followed_plan','')::boolean,NULLIF(p_review->>'what_went_well',''),NULLIF(p_review->>'what_went_wrong',''),
  ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_review->'mistakes','[]'))),NULLIF(p_review->>'lesson',''),NULLIF(p_review->>'would_take_again','')::boolean,NULLIF(p_review->>'matched_thesis','')::boolean,
  ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_review->'emotion_tags','[]'))),snapshot) RETURNING * INTO r;
 result:=jsonb_build_object('trade',to_jsonb(tr),'review',to_jsonb(r));
 INSERT INTO app_private.intel_activity_operations(org_id,user_id,operation_id,thesis_id,trade_id,request,result_id,created_at,result_snapshot)
 VALUES(p_org_id,auth.uid(),p_operation_id,NULL,tr.id,payload,r.id,now(),result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_close_trade_with_review(uuid,uuid,jsonb,jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_close_trade_with_review(uuid,uuid,jsonb,jsonb,uuid) TO authenticated;

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
  linked jsonb; link_side text;
  at_time timestamptz := statement_timestamp(); actor text := CASE WHEN auth.uid() IS NULL THEN 'engine' ELSE 'user' END;
  operation text := COALESCE(NULLIF(current_setting('app.intel_activity_operation',true),''), txid_current()::text);
BEGIN
  IF j->>'user_id' IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=(j->>'user_id')::uuid)
    OR NOT EXISTS(SELECT 1 FROM public.orgs WHERE id=(j->>'org_id')::uuid) THEN RETURN NULL; END IF; -- orphan rows and account/org cascades
  IF TG_OP='DELETE' AND TG_TABLE_NAME IN ('intel_trade_reviews','intel_thesis_reviews') THEN
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
  IF TG_TABLE_NAME='intel_trade_reviews' AND j->'exit_snapshot'->'linked_source_ref' IS NOT NULL AND j->'exit_snapshot'->'linked_source_ref'<>'null'::jsonb THEN
    linked := j->'exit_snapshot'->'linked_source_ref';
  ELSIF link_side IS NOT NULL AND tr->>(link_side||'_portfolio_event_id') IS NOT NULL THEN
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
END $function$
