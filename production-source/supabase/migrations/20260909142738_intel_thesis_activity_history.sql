-- Durable, personal research history. Market data is deliberately not copied.
-- Existing thesis/trade tables and their sharing/deletion behavior remain intact.
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;

-- Optional explicit references to already-recorded portfolio events. Entry and
-- exit are separate so a roundtrip never attaches both notes to one execution.
ALTER TABLE public.intel_trades
  ADD COLUMN entry_portfolio_event_kind text CHECK (entry_portfolio_event_kind IN ('grouped','manual')),
  ADD COLUMN entry_portfolio_event_id uuid,
  ADD COLUMN exit_portfolio_event_kind text CHECK (exit_portfolio_event_kind IN ('grouped','manual')),
  ADD COLUMN exit_portfolio_event_id uuid,
  ADD CONSTRAINT intel_trade_entry_link_complete CHECK ((entry_portfolio_event_kind IS NULL)=(entry_portfolio_event_id IS NULL)),
  ADD CONSTRAINT intel_trade_exit_link_complete CHECK ((exit_portfolio_event_kind IS NULL)=(exit_portfolio_event_id IS NULL));

CREATE TABLE public.intel_thesis_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  thesis_id uuid REFERENCES public.intel_theses(id) ON DELETE CASCADE,
  trade_id uuid REFERENCES public.intel_trades(id) ON DELETE CASCADE,
  entity_id uuid REFERENCES public.entities(id) ON DELETE SET NULL,
  canonical_key text,
  identity_keys text[] NOT NULL DEFAULT '{}',
  event_kind text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'engine', 'historical')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  operation_id text NOT NULL,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  title_snapshot text,
  text_snapshot jsonb NOT NULL DEFAULT '{}',
  changes jsonb NOT NULL DEFAULT '{}',
  source_visibility text NOT NULL DEFAULT 'private' CHECK (source_visibility IN ('private','org','shared')),
  linked_source_ref jsonb,
  historical_completeness text NOT NULL DEFAULT 'complete'
    CHECK (historical_completeness IN ('complete', 'timestamp_only', 'recorded_snapshot')),
  CONSTRAINT intel_activity_parent CHECK (thesis_id IS NOT NULL OR trade_id IS NOT NULL)
);
CREATE INDEX intel_activity_asset_window ON public.intel_thesis_activity(org_id,user_id,entity_id,occurred_at DESC,id DESC);
CREATE INDEX intel_activity_key_window ON public.intel_thesis_activity(org_id,user_id,canonical_key,occurred_at DESC,id DESC);
CREATE INDEX intel_activity_identity_keys ON public.intel_thesis_activity USING gin(identity_keys);
CREATE INDEX intel_activity_thesis_window ON public.intel_thesis_activity(thesis_id,occurred_at DESC,id DESC);
CREATE INDEX intel_activity_trade ON public.intel_thesis_activity(trade_id);
CREATE UNIQUE INDEX intel_activity_historical_source ON public.intel_thesis_activity(source_table,source_id,event_kind)
  WHERE actor_kind = 'historical';
ALTER TABLE public.intel_thesis_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_thesis_activity FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.intel_thesis_activity TO authenticated;
GRANT ALL ON public.intel_thesis_activity TO service_role;
CREATE POLICY intel_activity_read ON public.intel_thesis_activity FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = intel_thesis_activity.org_id AND m.user_id = (SELECT auth.uid()))
  AND (user_id = (SELECT auth.uid()) OR (trade_id IS NULL AND source_visibility = 'org' AND EXISTS (
    SELECT 1 FROM public.intel_theses t WHERE t.id = thesis_id AND t.org_id = intel_thesis_activity.org_id AND t.visibility = 'org'
  )))
);

-- Keep the source key for deep links and add verified portfolio/provider aliases.
-- No ticker inference: namespaces, chain IDs, native type, contract/mint and
-- stable provider IDs come from the resolved entity at the time of the event.
CREATE OR REPLACE FUNCTION app_private.intel_entity_identity_aliases(e public.entities, p_key text)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE aliases text[] := '{}'; address text; provider_id text; ledger text;
BEGIN
  IF p_key IS NOT NULL THEN aliases := array_append(aliases,p_key); END IF;
  IF e.id IS NOT NULL THEN
    aliases := array_append(aliases,e.canonical_ref_key);
    IF e.entity_kind='asset' THEN
      address := COALESCE(NULLIF(e.contract_address,''),CASE WHEN e.asset_type<>'native' THEN NULLIF(e.asset_id,'') END);
      IF e.chain_namespace='eip155' AND e.chain_id ~ '^[0-9]+$' THEN
        IF e.asset_type='native' THEN ledger := 'eip155:'||e.chain_id||':native';
        ELSIF address ~ '^0x[0-9a-fA-F]{40}$' THEN ledger := 'eip155:'||e.chain_id||':'||lower(address); END IF;
      ELSIF e.chain_namespace IN ('solana','sui','aptos','bip122','tron','injective','stellar','near','ton','xrpl','zcash') THEN
        IF e.asset_type='native' AND NULLIF(e.native_symbol,'') IS NOT NULL THEN ledger := e.chain_namespace||':native:'||upper(e.native_symbol);
        ELSIF e.chain_namespace='solana' AND address='So11111111111111111111111111111111111111112' THEN ledger := 'solana:native:SOL';
        ELSIF NULLIF(address,'') IS NOT NULL THEN ledger := e.chain_namespace||':'||address; END IF;
      END IF;
      IF ledger IS NOT NULL THEN aliases := array_append(aliases,ledger); END IF;
    END IF;
    provider_id := COALESCE(e.provider_ids->>'coingecko',e.provider_ids->>'coingecko_id');
    IF provider_id ~ '^[a-z0-9][a-z0-9_-]*$' THEN aliases := array_append(aliases,'market:coingecko:'||provider_id); END IF;
    provider_id := COALESCE(e.provider_ids->>'coinmarketcap',e.provider_ids->>'cmc',e.provider_ids->>'cmc_id');
    IF provider_id ~ '^[0-9]+$' THEN aliases := array_append(aliases,'market:coinmarketcap:'||provider_id); aliases := array_append(aliases,'market:cmc:'||provider_id); END IF;
  END IF;
  RETURN ARRAY(SELECT DISTINCT key FROM unnest(aliases) key WHERE key IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION app_private.intel_entity_identity_aliases(public.entities,text) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION app_private.intel_activity_identity_keys()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e public.entities;
BEGIN
 SELECT * INTO e FROM public.entities WHERE id=NEW.entity_id AND org_id=NEW.org_id;
 NEW.identity_keys:=app_private.intel_entity_identity_aliases(e,NEW.canonical_key);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_activity_identity_keys() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER intel_activity_identity_keys BEFORE INSERT ON public.intel_thesis_activity FOR EACH ROW EXECUTE FUNCTION app_private.intel_activity_identity_keys();

-- A separate current identity index avoids changing thesis update times during
-- migration. Historical event aliases stay frozen; current lists follow verified
-- entity enrichment and subject edits without ticker matching.
CREATE TABLE app_private.intel_thesis_asset_identity (
 thesis_id uuid PRIMARY KEY REFERENCES public.intel_theses(id) ON DELETE CASCADE,
 identity_keys text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX intel_thesis_asset_identity_lookup ON app_private.intel_thesis_asset_identity USING gin(identity_keys);
ALTER TABLE app_private.intel_thesis_asset_identity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.intel_thesis_asset_identity FROM PUBLIC,anon,authenticated;
INSERT INTO app_private.intel_thesis_asset_identity(thesis_id,identity_keys)
 SELECT t.id,app_private.intel_entity_identity_aliases(e,t.subject_canonical_key)
 FROM public.intel_theses t LEFT JOIN public.entities e ON e.id=t.entity_id AND e.org_id=t.org_id;
CREATE FUNCTION app_private.intel_sync_thesis_asset_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='entities' THEN
   INSERT INTO app_private.intel_thesis_asset_identity(thesis_id,identity_keys)
    SELECT t.id,app_private.intel_entity_identity_aliases(NEW,t.subject_canonical_key) FROM public.intel_theses t WHERE t.entity_id=NEW.id AND t.org_id=NEW.org_id
    ON CONFLICT(thesis_id) DO UPDATE SET identity_keys=EXCLUDED.identity_keys;
 ELSE
   INSERT INTO app_private.intel_thesis_asset_identity(thesis_id,identity_keys)
    SELECT NEW.id,app_private.intel_entity_identity_aliases(e,NEW.subject_canonical_key) FROM (SELECT 1) seed LEFT JOIN public.entities e ON e.id=NEW.entity_id AND e.org_id=NEW.org_id
    ON CONFLICT(thesis_id) DO UPDATE SET identity_keys=EXCLUDED.identity_keys;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_sync_thesis_asset_identity() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_sync_thesis_asset_identity AFTER INSERT OR UPDATE OF entity_id,subject_canonical_key ON public.intel_theses FOR EACH ROW EXECUTE FUNCTION app_private.intel_sync_thesis_asset_identity();
CREATE TRIGGER intel_sync_entity_thesis_identity AFTER UPDATE OF canonical_ref_key,chain_namespace,chain_id,asset_type,asset_id,contract_address,native_symbol,provider_ids ON public.entities FOR EACH ROW EXECUTE FUNCTION app_private.intel_sync_thesis_asset_identity();
CREATE FUNCTION public.intel_list_asset_theses(p_org_id uuid,p_canonical_key text DEFAULT NULL,p_entity_id uuid DEFAULT NULL,p_limit integer DEFAULT 30,p_before_at timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_size integer:=greatest(1,least(coalesce(p_limit,30),100)); v_rows jsonb; v_last jsonb; v_more boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=p_org_id AND m.user_id=auth.uid()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF p_entity_id IS NULL AND NULLIF(p_canonical_key,'') IS NULL THEN RAISE EXCEPTION 'Exact asset identity required'; END IF;
 IF (p_before_at IS NULL) IS DISTINCT FROM (p_before_id IS NULL) THEN RAISE EXCEPTION 'Incomplete cursor'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,id DESC),'[]') INTO v_rows FROM (
   SELECT t.id,t.title,t.stance,t.status,t.conviction,t.quality_score,t.next_review_at,t.needs_user_review,t.subject_canonical_key,t.created_at
   FROM public.intel_theses t JOIN app_private.intel_thesis_asset_identity i ON i.thesis_id=t.id
   WHERE t.org_id=p_org_id AND t.user_id=auth.uid() AND t.status<>'archived'
   AND (CASE WHEN p_entity_id IS NOT NULL THEN t.entity_id=p_entity_id ELSE i.identity_keys @> ARRAY[p_canonical_key] END)
   AND (p_before_at IS NULL OR (t.created_at,t.id)<(p_before_at,p_before_id))
   ORDER BY t.created_at DESC,t.id DESC LIMIT v_size+1
 ) page;
 v_more:=jsonb_array_length(v_rows)>v_size;
 IF v_more THEN v_rows:=v_rows-v_size; v_last:=v_rows->(v_size-1); END IF;
 RETURN jsonb_build_object('rows',v_rows,'next_cursor',CASE WHEN v_more THEN jsonb_build_object('at',v_last->>'created_at','id',v_last->>'id') END);
END $$;
REVOKE ALL ON FUNCTION public.intel_list_asset_theses(uuid,text,uuid,integer,timestamptz,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_list_asset_theses(uuid,text,uuid,integer,timestamptz,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.intel_activity_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN
  -- An entity deletion may clear its FK; the frozen canonical key remains.
  IF NEW.entity_id IS NULL AND OLD.entity_id IS NOT NULL AND (to_jsonb(NEW)-'entity_id')=(to_jsonb(OLD)-'entity_id') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Thesis activity is immutable; record a new action' USING ERRCODE='42501';
END $$;
REVOKE ALL ON FUNCTION app_private.intel_activity_immutable() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER intel_activity_immutable BEFORE UPDATE ON public.intel_thesis_activity FOR EACH ROW EXECUTE FUNCTION app_private.intel_activity_immutable();

-- Idempotency survives a retry or reconnect; deletion of the parent removes it.
CREATE TABLE app_private.intel_activity_operations (
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  thesis_id uuid REFERENCES public.intel_theses(id) ON DELETE CASCADE,
  trade_id uuid REFERENCES public.intel_trades(id) ON DELETE CASCADE,
  request jsonb NOT NULL,
  result_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id,user_id,operation_id)
);
ALTER TABLE app_private.intel_activity_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.intel_activity_operations FROM PUBLIC, anon, authenticated;

-- Enforce parent identity at the write boundary, including older direct-table
-- clients. No client can attach a private child to someone else's shared thesis.
CREATE OR REPLACE FUNCTION app_private.intel_validate_activity_parent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j jsonb := to_jsonb(NEW); p jsonb; e public.entities%ROWTYPE; side text; link_kind text; link_id uuid; valid_link boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    IF NOT (NEW.org_id=OLD.org_id AND NEW.user_id IS NULL AND OLD.user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=OLD.user_id)) THEN
      RAISE EXCEPTION 'Research ownership cannot be reassigned' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF auth.uid() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=NEW.org_id AND m.user_id=auth.uid()) THEN RAISE EXCEPTION 'Organization membership required' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME = 'intel_trade_reviews' THEN
    SELECT to_jsonb(t) INTO p FROM public.intel_trades t WHERE t.id = NEW.trade_id;
  ELSIF TG_TABLE_NAME <> 'intel_theses' AND j->>'thesis_id' IS NOT NULL THEN
    SELECT to_jsonb(t) INTO p FROM public.intel_theses t WHERE t.id = (j->>'thesis_id')::uuid;
  END IF;
  IF (TG_TABLE_NAME = 'intel_trade_reviews' OR (TG_TABLE_NAME <> 'intel_theses' AND j->>'thesis_id' IS NOT NULL))
    AND (p IS NULL OR p->>'org_id' IS DISTINCT FROM j->>'org_id' OR p->>'user_id' IS DISTINCT FROM j->>'user_id') THEN
    RAISE EXCEPTION 'Research parent is not owned by this user and organization' USING ERRCODE = '42501';
  END IF;
  IF j->>'scenario_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.intel_thesis_scenarios s WHERE s.id = (j->>'scenario_id')::uuid
      AND s.thesis_id = (j->>'thesis_id')::uuid AND s.org_id = NEW.org_id AND s.user_id = NEW.user_id
  ) THEN RAISE EXCEPTION 'Invalid scenario parent' USING ERRCODE = '42501'; END IF;
  IF TG_TABLE_NAME IN ('intel_theses','intel_trades') THEN
    IF NEW.entity_id IS NOT NULL THEN
      SELECT * INTO e FROM public.entities WHERE id = NEW.entity_id;
      IF e.id IS NULL THEN RAISE EXCEPTION 'Unknown asset identity'; END IF;
      IF e.org_id IS DISTINCT FROM NEW.org_id THEN RAISE EXCEPTION 'Asset identity belongs to another organization' USING ERRCODE='42501'; END IF;
      -- entity_id is authoritative; avoid conflicting provider/symbol aliases.
      NEW.subject_canonical_key := COALESCE(e.canonical_ref_key, NEW.subject_canonical_key);
    ELSIF TG_TABLE_NAME = 'intel_trades' AND p IS NOT NULL THEN
      NEW.entity_id := NULLIF(p->>'entity_id','')::uuid;
      NEW.subject_canonical_key := p->>'subject_canonical_key';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'intel_theses' THEN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.last_status_at := statement_timestamp();
      IF NEW.status IN ('closed','invalidated') THEN NEW.closed_at := statement_timestamp();
      ELSIF NEW.status <> 'archived' THEN NEW.closed_at := NULL; END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'intel_trades' THEN
    FOREACH side IN ARRAY ARRAY['entry','exit'] LOOP
      link_kind := j->>(side||'_portfolio_event_kind'); link_id := NULLIF(j->>(side||'_portfolio_event_id'),'')::uuid;
      IF link_kind IS NOT NULL AND (TG_OP='INSERT' OR j->(side||'_portfolio_event_kind') IS DISTINCT FROM to_jsonb(OLD)->(side||'_portfolio_event_kind')
        OR j->(side||'_portfolio_event_id') IS DISTINCT FROM to_jsonb(OLD)->(side||'_portfolio_event_id') OR NEW.portfolio_id IS DISTINCT FROM OLD.portfolio_id) THEN
        IF NEW.portfolio_id IS NULL THEN RAISE EXCEPTION 'A linked portfolio event requires its portfolio'; END IF;
        IF link_kind='grouped' THEN
          SELECT EXISTS(SELECT 1 FROM public.investor_portfolio_tx x
            JOIN public.investor_portfolios p ON p.id=x.portfolio_id AND p.org_id=NEW.org_id AND p.user_id=NEW.user_id
            JOIN public.investor_portfolio_sources s ON s.id=x.source_id AND s.portfolio_id=x.portfolio_id AND s.org_id=NEW.org_id AND s.user_id=NEW.user_id AND s.source_type<>'manual'
            WHERE x.id=link_id AND x.org_id=NEW.org_id AND x.user_id=NEW.user_id AND x.portfolio_id=NEW.portfolio_id AND NOT x.is_display_mirror) INTO valid_link;
        ELSIF link_kind='manual' THEN
          SELECT EXISTS(SELECT 1 FROM public.investor_portfolio_transactions x
            JOIN public.investor_portfolios p ON p.id=x.portfolio_id AND p.org_id=NEW.org_id AND p.user_id=NEW.user_id
            JOIN public.investor_portfolio_sources s ON s.id=x.source_id AND s.portfolio_id=x.portfolio_id AND s.org_id=NEW.org_id AND s.user_id=NEW.user_id AND s.source_type='manual'
            WHERE x.id=link_id AND x.org_id=NEW.org_id AND x.user_id=NEW.user_id AND x.portfolio_id=NEW.portfolio_id) INTO valid_link;
        ELSE valid_link := false; END IF;
        IF NOT valid_link THEN RAISE EXCEPTION 'Portfolio event is not owned by this user and portfolio' USING ERRCODE='42501'; END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_validate_activity_parent() FROM PUBLIC, anon, authenticated;

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
    keys := ARRAY['title','bull_thesis','bear_thesis','neutral_thesis','what_would_confirm','what_would_invalidate','key_risks','watched_metrics','sources','stance','conviction','status','time_horizon','review_cadence','next_review_at','benchmark_key','entity_id','subject_canonical_key','portfolio_id','visibility','engine_suggested_status'];
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

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['intel_theses','intel_thesis_reviews','intel_thesis_scenarios','intel_thesis_rules','intel_thesis_evidence','intel_trades','intel_trade_reviews'] LOOP
    EXECUTE format('CREATE TRIGGER intel_activity_parent BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_private.intel_validate_activity_parent()',tab);
    EXECUTE format('CREATE TRIGGER intel_activity_capture AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_private.intel_capture_thesis_activity()',tab);
  END LOOP;
END $$;

-- Atomic review + BOTH status and conviction/stance changes. No privileged caller
-- can substitute a user id; identity comes from auth.uid and current membership.
CREATE OR REPLACE FUNCTION public.intel_save_thesis_review(p_org_id uuid,p_thesis_id uuid,p_review jsonb,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE th public.intel_theses%ROWTYPE; r public.intel_thesis_reviews%ROWTYPE;
  op app_private.intel_activity_operations%ROWTYPE; payload jsonb; new_status text; new_conv numeric; new_stance text;
BEGIN
  IF auth.uid() IS NULL OR p_operation_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id=p_org_id AND m.user_id=auth.uid()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_review) IS DISTINCT FROM 'object' OR octet_length(p_review::text)>131072 THEN RAISE EXCEPTION 'Invalid review'; END IF;
  payload := jsonb_build_object('action','review','thesis_id',p_thesis_id,'review',p_review);
  PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_operation_id::text,0));
  SELECT * INTO op FROM app_private.intel_activity_operations WHERE org_id=p_org_id AND user_id=auth.uid() AND operation_id=p_operation_id;
  IF FOUND THEN
    IF op.request IS DISTINCT FROM payload THEN RAISE EXCEPTION 'Idempotency key reused for a different action'; END IF;
    SELECT * INTO r FROM public.intel_thesis_reviews WHERE id=op.result_id;
    RETURN to_jsonb(r);
  END IF;
  SELECT * INTO th FROM public.intel_theses WHERE id=p_thesis_id AND org_id=p_org_id AND user_id=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Thesis not found' USING ERRCODE='42501'; END IF;
  new_status := COALESCE(NULLIF(p_review->>'new_status',''),th.status);
  new_conv := COALESCE(NULLIF(p_review->>'new_conviction','')::numeric,th.conviction);
  new_stance := COALESCE(NULLIF(p_review->>'new_stance',''),th.stance);
  IF new_conv NOT BETWEEN 0 AND 1 THEN RAISE EXCEPTION 'Conviction must be between zero and one'; END IF;
  IF new_stance IS NOT NULL AND new_stance NOT IN ('bullish','bearish','neutral','market_neutral') THEN RAISE EXCEPTION 'Invalid stance'; END IF;
  IF p_review->>'snapshot_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.intel_thesis_snapshots s WHERE s.id=(p_review->>'snapshot_id')::uuid AND s.thesis_id=th.id AND s.org_id=p_org_id AND s.user_id=auth.uid()) THEN RAISE EXCEPTION 'Invalid review snapshot' USING ERRCODE='42501'; END IF;
  IF p_review->>'ai_artifact_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.research_artifacts a WHERE a.id=(p_review->>'ai_artifact_id')::uuid AND a.org_id=p_org_id AND (a.user_id=auth.uid() OR a.user_id IS NULL)) THEN RAISE EXCEPTION 'Invalid review artifact' USING ERRCODE='42501'; END IF;
  IF NULLIF(btrim(p_review->>'note'),'') IS NULL AND p_review->>'ai_artifact_id' IS NULL AND p_review->>'snapshot_id' IS NULL AND new_status IS NOT DISTINCT FROM th.status AND new_conv IS NOT DISTINCT FROM th.conviction AND new_stance IS NOT DISTINCT FROM th.stance THEN RAISE EXCEPTION 'Review requires notes or a change'; END IF;
  PERFORM set_config('app.intel_activity_operation',p_operation_id::text,true);
  INSERT INTO public.intel_thesis_reviews(org_id,user_id,thesis_id,visibility,review_kind,prev_status,new_status,prev_conviction,new_conviction,prev_stance,new_stance,note,ai_artifact_id,snapshot_id,evidence_delta)
  VALUES(p_org_id,auth.uid(),th.id,COALESCE(NULLIF(p_review->>'visibility',''),th.visibility),COALESCE(NULLIF(p_review->>'review_kind',''),'manual'),th.status,new_status,th.conviction,new_conv,th.stance,new_stance,NULLIF(p_review->>'note',''),NULLIF(p_review->>'ai_artifact_id','')::uuid,NULLIF(p_review->>'snapshot_id','')::uuid,COALESCE(p_review->'evidence_delta','{}')) RETURNING * INTO r;
  IF r.review_kind <> 'ai_draft' THEN
  UPDATE public.intel_theses SET status=new_status,conviction=new_conv,stance=new_stance,status_source='user',needs_user_review=false,last_reviewed_at=statement_timestamp(),
    last_status_at=CASE WHEN status IS DISTINCT FROM new_status THEN statement_timestamp() ELSE last_status_at END,
    closed_at=CASE WHEN new_status='closed' THEN COALESCE(closed_at,statement_timestamp()) WHEN status='closed' THEN NULL ELSE closed_at END
  WHERE id=th.id;
  END IF;
  INSERT INTO app_private.intel_activity_operations VALUES(p_org_id,auth.uid(),p_operation_id,th.id,NULL,payload,r.id,now());
  RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.intel_save_thesis_review(uuid,uuid,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.intel_save_thesis_review(uuid,uuid,jsonb,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.intel_close_trade_with_review(p_org_id uuid,p_trade_id uuid,p_trade jsonb,p_review jsonb,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE tr public.intel_trades%ROWTYPE; r public.intel_trade_reviews%ROWTYPE;
  op app_private.intel_activity_operations%ROWTYPE; payload jsonb; exit_at timestamptz;
BEGIN
  IF auth.uid() IS NULL OR p_operation_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id=p_org_id AND m.user_id=auth.uid()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_trade) IS DISTINCT FROM 'object' OR jsonb_typeof(p_review) IS DISTINCT FROM 'object' OR octet_length(p_trade::text)+octet_length(p_review::text)>131072 THEN RAISE EXCEPTION 'Invalid trade review'; END IF;
  payload := jsonb_build_object('action','close_trade','trade_id',p_trade_id,'trade',p_trade,'review',p_review);
  PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_operation_id::text,0));
  SELECT * INTO op FROM app_private.intel_activity_operations WHERE org_id=p_org_id AND user_id=auth.uid() AND operation_id=p_operation_id;
  IF FOUND THEN
    IF op.request IS DISTINCT FROM payload THEN RAISE EXCEPTION 'Idempotency key reused for a different action'; END IF;
    SELECT * INTO r FROM public.intel_trade_reviews WHERE id=op.result_id;
    SELECT * INTO tr FROM public.intel_trades WHERE id=p_trade_id;
    RETURN jsonb_build_object('trade',to_jsonb(tr),'review',to_jsonb(r));
  END IF;
  SELECT * INTO tr FROM public.intel_trades WHERE id=p_trade_id AND org_id=p_org_id AND user_id=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found' USING ERRCODE='42501'; END IF;
  exit_at := COALESCE(NULLIF(p_trade->>'closed_at','')::timestamptz,statement_timestamp());
  IF exit_at>statement_timestamp()+interval '5 minutes' OR (tr.opened_at IS NOT NULL AND exit_at<tr.opened_at) THEN RAISE EXCEPTION 'Exit time must follow entry and cannot be in the future'; END IF;
  IF NULLIF(p_trade->>'exit_price','')::numeric <= 0 OR NULLIF(p_trade->>'fees_usd','')::numeric < 0 THEN RAISE EXCEPTION 'Invalid exit price or fees'; END IF;
  PERFORM set_config('app.intel_activity_operation',p_operation_id::text,true);
  UPDATE public.intel_trades SET status='closed',closed_at=exit_at,
    portfolio_id=COALESCE(NULLIF(p_trade->>'portfolio_id','')::uuid,portfolio_id),
    exit_portfolio_event_kind=CASE WHEN p_trade ? 'exit_portfolio_event_kind' THEN NULLIF(p_trade->>'exit_portfolio_event_kind','') ELSE exit_portfolio_event_kind END,
    exit_portfolio_event_id=CASE WHEN p_trade ? 'exit_portfolio_event_id' THEN NULLIF(p_trade->>'exit_portfolio_event_id','')::uuid ELSE exit_portfolio_event_id END,
    entry_price=COALESCE(NULLIF(p_trade->>'entry_price','')::numeric,entry_price), exit_price=NULLIF(p_trade->>'exit_price','')::numeric,
    fees_usd=NULLIF(p_trade->>'fees_usd','')::numeric,realized_pnl_usd=NULLIF(p_trade->>'realized_pnl_usd','')::numeric,
    realized_pnl_pct=NULLIF(p_trade->>'realized_pnl_pct','')::numeric,r_multiple=NULLIF(p_trade->>'r_multiple','')::numeric
  WHERE id=tr.id RETURNING * INTO tr;
  INSERT INTO public.intel_trade_reviews(org_id,user_id,trade_id,outcome,followed_plan,what_went_well,what_went_wrong,mistakes,lesson,would_take_again,matched_thesis,emotion_tags)
  VALUES(p_org_id,auth.uid(),tr.id,NULLIF(p_review->>'outcome',''),NULLIF(p_review->>'followed_plan','')::boolean,NULLIF(p_review->>'what_went_well',''),NULLIF(p_review->>'what_went_wrong',''),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_review->'mistakes','[]'))),NULLIF(p_review->>'lesson',''),NULLIF(p_review->>'would_take_again','')::boolean,NULLIF(p_review->>'matched_thesis','')::boolean,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_review->'emotion_tags','[]')))) RETURNING * INTO r;
  INSERT INTO app_private.intel_activity_operations VALUES(p_org_id,auth.uid(),p_operation_id,NULL,tr.id,payload,r.id,now());
  RETURN jsonb_build_object('trade',to_jsonb(tr),'review',to_jsonb(r));
END $$;
REVOKE ALL ON FUNCTION public.intel_close_trade_with_review(uuid,uuid,jsonb,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.intel_close_trade_with_review(uuid,uuid,jsonb,jsonb,uuid) TO authenticated;

-- Bounded canonical reader. Explicit thesis viewing may include existing org
-- sharing; the default asset overlay is always the caller's own history.
CREATE OR REPLACE FUNCTION public.intel_asset_thesis_activity(p_org_id uuid,p_entity_id uuid DEFAULT NULL,p_canonical_key text DEFAULT NULL,
  p_thesis_id uuid DEFAULT NULL,p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL,p_limit integer DEFAULT 200,
  p_before_at timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE items jsonb; next_item jsonb; n integer := LEAST(GREATEST(COALESCE(p_limit,200),1),500);
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id=p_org_id AND m.user_id=auth.uid()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  IF p_entity_id IS NULL AND NULLIF(p_canonical_key,'') IS NULL AND p_thesis_id IS NULL THEN RAISE EXCEPTION 'Canonical asset identity or thesis required'; END IF;
  IF p_from>p_to OR (p_before_at IS NULL)<>(p_before_id IS NULL) THEN RAISE EXCEPTION 'Invalid time window or cursor'; END IF;
  WITH bounded AS (
    SELECT a.* FROM public.intel_thesis_activity a WHERE a.org_id=p_org_id
      AND (p_thesis_id IS NOT NULL OR a.user_id=auth.uid())
      AND (p_thesis_id IS NULL OR a.thesis_id=p_thesis_id)
      AND (p_entity_id IS NULL OR a.entity_id=p_entity_id)
      AND (p_entity_id IS NOT NULL OR p_canonical_key IS NULL OR a.identity_keys @> ARRAY[p_canonical_key])
      AND (p_from IS NULL OR a.occurred_at>=p_from) AND (p_to IS NULL OR a.occurred_at<=p_to)
      AND (p_before_at IS NULL OR (a.occurred_at,a.id)<(p_before_at,p_before_id))
    ORDER BY a.occurred_at DESC,a.id DESC LIMIT n+1
  ) SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.occurred_at DESC,b.id DESC),'[]') INTO items FROM bounded b;
  IF jsonb_array_length(items)>n THEN
    next_item := items->(n-1); items := items - n;
  END IF;
  RETURN jsonb_build_object('events',items,'next_cursor',CASE WHEN next_item IS NULL THEN NULL ELSE jsonb_build_object('occurred_at',next_item->'occurred_at','id',next_item->'id') END,
    'historical_coverage','Older rows preserve only verifiable timestamps; historical wording is not reconstructed.');
END $$;
REVOKE ALL ON FUNCTION public.intel_asset_thesis_activity(uuid,uuid,text,uuid,timestamptz,timestamptz,integer,timestamptz,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.intel_asset_thesis_activity(uuid,uuid,text,uuid,timestamptz,timestamptz,integer,timestamptz,uuid) TO authenticated;

-- Honest idempotent backfill: mutable present-day text is never portrayed as
-- something the user wrote at creation. New activity is complete from rollout.
INSERT INTO public.intel_thesis_activity(org_id,user_id,thesis_id,entity_id,canonical_key,event_kind,actor_kind,occurred_at,operation_id,source_table,source_id,historical_completeness)
SELECT t.org_id,t.user_id,t.id,t.entity_id,COALESCE(e.canonical_ref_key,t.subject_canonical_key),'thesis_created','historical',t.created_at,'legacy:thesis:'||t.id,'intel_theses',t.id,'timestamp_only'
FROM public.intel_theses t LEFT JOIN public.entities e ON e.id=t.entity_id WHERE t.user_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO public.intel_thesis_activity(org_id,user_id,thesis_id,entity_id,canonical_key,event_kind,actor_kind,occurred_at,operation_id,source_table,source_id,historical_completeness)
SELECT r.org_id,r.user_id,t.id,t.entity_id,COALESCE(e.canonical_ref_key,t.subject_canonical_key),'thesis_reviewed','historical',r.created_at,'legacy:review:'||r.id,'intel_thesis_reviews',r.id,'timestamp_only'
FROM public.intel_thesis_reviews r JOIN public.intel_theses t ON t.id=r.thesis_id AND t.org_id=r.org_id AND t.user_id=r.user_id
LEFT JOIN public.entities e ON e.id=t.entity_id ON CONFLICT DO NOTHING;
INSERT INTO public.intel_thesis_activity(org_id,user_id,thesis_id,trade_id,entity_id,canonical_key,event_kind,actor_kind,occurred_at,operation_id,source_table,source_id,historical_completeness)
SELECT tr.org_id,tr.user_id,tr.thesis_id,tr.id,COALESCE(tr.entity_id,t.entity_id),COALESCE(e.canonical_ref_key,tr.subject_canonical_key,t.subject_canonical_key),x.kind,'historical',x.at_time,'legacy:'||x.kind||':'||tr.id,'intel_trades',tr.id,'timestamp_only'
FROM public.intel_trades tr LEFT JOIN public.intel_theses t ON t.id=tr.thesis_id AND t.org_id=tr.org_id AND t.user_id=tr.user_id
LEFT JOIN public.entities e ON e.id=COALESCE(tr.entity_id,t.entity_id)
CROSS JOIN LATERAL (VALUES('trade_entered',tr.opened_at),('trade_exited',tr.closed_at)) x(kind,at_time)
WHERE x.at_time IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO public.intel_thesis_activity(org_id,user_id,thesis_id,entity_id,canonical_key,event_kind,actor_kind,occurred_at,operation_id,source_table,source_id,historical_completeness)
SELECT r.org_id,r.user_id,t.id,t.entity_id,COALESCE(e.canonical_ref_key,t.subject_canonical_key),CASE WHEN r.rule_kind='invalidation' THEN 'rule_invalidated' ELSE 'rule_confirmed' END,'historical',r.triggered_at,'legacy:rule:'||r.id,'intel_thesis_rules',r.id,'timestamp_only'
FROM public.intel_thesis_rules r JOIN public.intel_theses t ON t.id=r.thesis_id AND t.org_id=r.org_id AND t.user_id=r.user_id
LEFT JOIN public.entities e ON e.id=t.entity_id WHERE r.triggered_at IS NOT NULL ON CONFLICT DO NOTHING;
