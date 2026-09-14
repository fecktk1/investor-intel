-- Chart-linked conditions extend the existing alert ledger. All market reads
-- come from normalized shared observations; this evaluator cannot call a provider.
GRANT USAGE ON SCHEMA app_private TO service_role;
GRANT EXECUTE ON FUNCTION app_private.intel_issuer_market_keys(text) TO service_role;
ALTER TABLE public.intel_alert_rules ADD COLUMN chart_revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.intel_alert_rules ADD COLUMN chart_state jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.intel_alert_events ADD COLUMN private_owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE;
CREATE INDEX intel_chart_alert_pending ON public.intel_alert_rules(last_evaluation_attempt_at NULLS FIRST,id) WHERE trigger_type='chart_price' AND is_active;
CREATE INDEX intel_private_alert_events ON public.intel_alert_events(org_id,private_owner_id,fired_at DESC,id DESC) WHERE private_owner_id IS NOT NULL;

CREATE POLICY chart_alert_owner_boundary ON public.intel_alert_rules AS RESTRICTIVE FOR ALL TO authenticated
 USING(trigger_type<>'chart_price' OR (user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_rules.org_id AND m.user_id=(SELECT auth.uid()))))
 WITH CHECK(trigger_type<>'chart_price' OR (user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_rules.org_id AND m.user_id=(SELECT auth.uid()))));
CREATE POLICY chart_alert_owner_read ON public.intel_alert_rules FOR SELECT TO authenticated
 USING(trigger_type='chart_price' AND user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_rules.org_id AND m.user_id=(SELECT auth.uid())));
CREATE POLICY chart_alert_owner_delete ON public.intel_alert_rules FOR DELETE TO authenticated
 USING(trigger_type='chart_price' AND user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_rules.org_id AND m.user_id=(SELECT auth.uid())));
CREATE POLICY private_alert_owner_boundary ON public.intel_alert_events AS RESTRICTIVE FOR ALL TO authenticated
 USING(private_owner_id IS NULL OR (private_owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_events.org_id AND m.user_id=(SELECT auth.uid()))))
 WITH CHECK(private_owner_id IS NULL OR (private_owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_events.org_id AND m.user_id=(SELECT auth.uid()))));
CREATE POLICY private_alert_owner_read ON public.intel_alert_events FOR SELECT TO authenticated
 USING(private_owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_events.org_id AND m.user_id=(SELECT auth.uid())));

CREATE TABLE public.intel_chart_alert_operations(
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,rule_id uuid REFERENCES public.intel_alert_rules(id) ON DELETE SET NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(org_id,user_id,operation_id));
ALTER TABLE public.intel_chart_alert_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_chart_alert_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_chart_alert_operations TO service_role;
CREATE TABLE public.intel_chart_alert_audit(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,rule_id uuid NOT NULL REFERENCES public.intel_alert_rules(id) ON DELETE CASCADE,
 revision integer NOT NULL,action text NOT NULL,detail jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX intel_chart_alert_audit_owner ON public.intel_chart_alert_audit(org_id,user_id,rule_id,recorded_at DESC,id DESC);
ALTER TABLE public.intel_chart_alert_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_chart_alert_audit FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.intel_chart_alert_audit TO authenticated;
GRANT SELECT,INSERT,DELETE ON public.intel_chart_alert_audit TO service_role;
CREATE POLICY chart_alert_audit_owner ON public.intel_chart_alert_audit FOR SELECT TO authenticated
 USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_chart_alert_audit.org_id AND m.user_id=(SELECT auth.uid())));

-- Prevent client writes bypassing the transactional versioned editor, including
-- changing the trigger type to escape its private boundary. Deletion is retained.
CREATE FUNCTION app_private.intel_chart_alert_write_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='intel_alert_rules' THEN
  IF (NEW.trigger_type='chart_price' OR (TG_OP='UPDATE' AND OLD.trigger_type='chart_price')) AND current_user NOT IN ('postgres','service_role') THEN RAISE EXCEPTION 'chart_alert_use_editor' USING ERRCODE='42501'; END IF;
 ELSE
  IF (NEW.private_owner_id IS NOT NULL OR (TG_OP='UPDATE' AND OLD.private_owner_id IS NOT NULL)
   OR EXISTS(SELECT 1 FROM public.intel_alert_rules WHERE id=NEW.rule_id AND trigger_type='chart_price')) AND current_user NOT IN ('postgres','service_role') THEN RAISE EXCEPTION 'chart_alert_server_event_required' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_chart_alert_write_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_chart_alert_write_guard BEFORE INSERT OR UPDATE ON public.intel_alert_rules FOR EACH ROW EXECUTE FUNCTION app_private.intel_chart_alert_write_guard();
CREATE TRIGGER intel_private_alert_event_write_guard BEFORE INSERT OR UPDATE ON public.intel_alert_events FOR EACH ROW EXECUTE FUNCTION app_private.intel_chart_alert_write_guard();

CREATE FUNCTION public.intel_save_chart_alert(p_org uuid,p_user uuid,p_id uuid,p_revision integer,p_operation uuid,p_config jsonb,p_active boolean,p_cooldown integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE old public.intel_alert_rules;saved public.intel_alert_rules;previous public.intel_chart_alert_operations;result jsonb;action text;level numeric;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) OR public.can_access_intel(p_user,p_org) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF p_operation IS NULL OR p_revision IS NULL OR p_revision<0 OR p_active IS NULL OR p_cooldown IS NULL OR p_cooldown NOT BETWEEN 15 AND 10080
  OR p_config IS NULL OR jsonb_typeof(p_config)<>'object' OR octet_length(p_config::text)>12000
  OR coalesce(length(p_config->>'asset'),0) NOT BETWEEN 1 AND 240 OR coalesce(length(btrim(p_config->>'title')),0) NOT BETWEEN 1 AND 120
  OR jsonb_typeof(p_config->'note') IS DISTINCT FROM 'string' OR length(p_config->>'note')>2000
  OR jsonb_typeof(p_config->'threshold_usd') IS DISTINCT FROM 'number' OR coalesce(p_config->>'direction','') NOT IN ('above','below')
  OR p_config->>'currency' IS DISTINCT FROM 'USD' OR p_config->>'delivery' IS DISTINCT FROM 'in_app'
  OR p_config->>'method' IS DISTINCT FROM 'sampled_quote_crossing_v1' THEN RAISE EXCEPTION 'chart_alert_invalid'; END IF;
 level:=(p_config->>'threshold_usd')::numeric;
 IF level<=0 OR level>1e18 THEN RAISE EXCEPTION 'chart_alert_invalid'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('chart-alert:'||p_org::text||p_user::text||p_operation::text,0));
 SELECT * INTO previous FROM public.intel_chart_alert_operations WHERE org_id=p_org AND user_id=p_user AND operation_id=p_operation;
 IF FOUND THEN IF previous.rule_id IS NULL THEN RAISE EXCEPTION 'chart_alert_deleted'; END IF;RETURN previous.result;END IF;
 IF p_id IS NULL THEN
  IF p_revision<>0 THEN RAISE EXCEPTION 'chart_alert_revision_conflict' USING ERRCODE='40001';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chart-alert-limit:'||p_org::text||p_user::text,0));
  IF (SELECT count(*) FROM public.intel_alert_rules WHERE org_id=p_org AND user_id=p_user AND trigger_type='chart_price')>=100 THEN RAISE EXCEPTION 'chart_alert_limit';END IF;
  INSERT INTO public.intel_alert_rules(org_id,user_id,trigger_type,config,is_active,cooldown_minutes) VALUES(p_org,p_user,'chart_price',p_config,p_active,p_cooldown) RETURNING * INTO saved;
  action:=CASE WHEN p_active THEN 'created_active' ELSE 'draft_created' END;
 ELSE
  SELECT * INTO old FROM public.intel_alert_rules WHERE id=p_id AND org_id=p_org AND user_id=p_user AND trigger_type='chart_price' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'chart_alert_not_found'; END IF;
  IF old.chart_revision<>p_revision THEN RAISE EXCEPTION 'chart_alert_revision_conflict' USING ERRCODE='40001';END IF;
  UPDATE public.intel_alert_rules SET config=p_config,is_active=p_active,cooldown_minutes=p_cooldown,chart_revision=old.chart_revision+1,
   chart_state=CASE WHEN old.config IS DISTINCT FROM p_config OR old.is_active IS DISTINCT FROM p_active THEN '{}'::jsonb ELSE old.chart_state END WHERE id=old.id RETURNING * INTO saved;
  action:=CASE WHEN old.is_active IS DISTINCT FROM p_active THEN CASE WHEN p_active THEN 'activated' ELSE 'paused' END ELSE 'edited' END;
 END IF;
 INSERT INTO public.intel_chart_alert_audit(org_id,user_id,rule_id,revision,action,detail) VALUES(p_org,p_user,saved.id,saved.chart_revision,action,jsonb_build_object('config',p_config,'previousConfig',old.config,'active',p_active,'cooldownMinutes',p_cooldown));
 result:=jsonb_build_object('id',saved.id,'revision',saved.chart_revision,'active',saved.is_active);
 INSERT INTO public.intel_chart_alert_operations(org_id,user_id,operation_id,rule_id,result) VALUES(p_org,p_user,p_operation,saved.id,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_save_chart_alert(uuid,uuid,uuid,integer,uuid,jsonb,boolean,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_save_chart_alert(uuid,uuid,uuid,integer,uuid,jsonb,boolean,integer) TO service_role;

CREATE FUNCTION public.intel_evaluate_chart_alerts(p_limit integer DEFAULT 100,p_rule uuid DEFAULT NULL,p_org uuid DEFAULT NULL,p_user uuid DEFAULT NULL,p_commit boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.intel_alert_rules;o public.intel_market_observations;keys text[];q jsonb;previous jsonb;next_state jsonb;receipt jsonb;event_id uuid;now_at timestamptz:=clock_timestamp();level numeric;value numeric;prior_value numeric;prior_time timestamptz;last_fire timestamptz;crossed boolean;state text;checked integer:=0;fired integer:=0;results jsonb:='[]';
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 400 OR p_commit IS NULL OR ((p_user IS NULL)<>(p_org IS NULL)) OR (NOT p_commit AND (p_rule IS NULL OR p_user IS NULL)) THEN RAISE EXCEPTION 'chart_alert_invalid_evaluation';END IF;
 IF p_user IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) OR public.can_access_intel(p_user,p_org) IS NOT TRUE) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 FOR r IN SELECT a.* FROM public.intel_alert_rules a JOIN public.orgs org ON org.id=a.org_id
  WHERE a.trigger_type='chart_price' AND (NOT p_commit OR a.is_active) AND org.product_mode='intel'
   AND (p_rule IS NULL OR a.id=p_rule) AND (p_user IS NULL OR (a.user_id=p_user AND a.org_id=p_org))
  ORDER BY a.last_evaluation_attempt_at NULLS FIRST,a.id LIMIT p_limit FOR UPDATE OF a SKIP LOCKED
 LOOP
  checked:=checked+1;event_id:=NULL;o:=NULL;q:=NULL;next_state:=r.chart_state;crossed:=false;
  IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=r.org_id AND user_id=r.user_id) OR public.can_access_intel(r.user_id,r.org_id) IS NOT TRUE THEN
   state:='access_unavailable';next_state:='{}';
  ELSE
   keys:=app_private.intel_issuer_market_keys(r.config->>'asset')||CASE
    WHEN r.config->>'asset' IN ('native:bitcoin','bip122:native:BTC','bip122:mainnet/native:btc','market:coingecko:bitcoin') THEN ARRAY['market:coinmarketcap:1','market:coingecko:bitcoin']
    WHEN r.config->>'asset' IN ('native:ethereum','native:base','native:arbitrum','market:coingecko:ethereum','eip155:1:native','eip155:8453:native','eip155:42161:native','eip155:10:native','eip155:59144:native','eip155:534352:native','eip155:324:native','eip155:81457:native','eip155:1/native:eth','eip155:8453/native:eth','eip155:42161/native:eth') THEN ARRAY['market:coinmarketcap:1027','market:coingecko:ethereum']
    WHEN r.config->>'asset' IN ('native:solana','solana:native:SOL','solana:mainnet/native:sol','market:coingecko:solana') THEN ARRAY['market:coinmarketcap:5426','market:coingecko:solana']
    ELSE '{}'::text[] END;
   IF r.config->>'asset' LIKE 'market:coinmarketcap:%' OR r.config->>'asset' LIKE 'market:coingecko:%' THEN keys:=array_append(keys,r.config->>'asset');END IF;
   SELECT obs.* INTO o FROM public.intel_market_observations obs WHERE obs.subject=ANY(keys) AND obs.metric='price'
    AND obs.observed_at<=now_at AND obs.observed_at>=now_at-interval '5 minutes' AND obs.retain_until>now_at
    AND obs.observation->>'unit'='USD' AND jsonb_typeof(obs.observation->'value')='number'
    AND (obs.observation->>'value')::numeric>0 AND (obs.observation->>'value')::numeric<=1e18
    AND (obs.observation->>'expiresAt')::timestamptz>now_at
    ORDER BY CASE WHEN obs.provider='coinmarketcap' THEN 0 ELSE 1 END,obs.observed_at DESC,obs.recorded_at DESC,obs.id LIMIT 1;
   IF NOT FOUND THEN state:='fresh_price_unavailable';
   ELSE
    q:=o.observation;value:=(q->>'value')::numeric;level:=(r.config->>'threshold_usd')::numeric;previous:=r.chart_state;
    prior_time:=NULLIF(previous->>'observedAt','')::timestamptz;prior_value:=NULLIF(previous->>'value','')::numeric;
    IF previous->>'observationId'=o.id OR (prior_time IS NOT NULL AND o.observed_at<=prior_time) THEN state:='unchanged';
    ELSE
     state:='baseline';
     IF prior_time IS NOT NULL AND prior_value IS NOT NULL AND o.observed_at-prior_time<=interval '20 minutes' AND previous->>'provider'=o.provider AND previous->>'subject'=o.subject THEN
      crossed:=CASE WHEN r.config->>'direction'='above' THEN prior_value<=level AND value>level ELSE prior_value>=level AND value<level END;
      state:=CASE WHEN crossed THEN 'crossed' ELSE 'watching' END;
     END IF;
     next_state:=jsonb_build_object('observationId',o.id,'provider',o.provider,'subject',o.subject,'observedAt',o.observed_at,'value',value,'sourceRef',q->>'sourceRef');
     IF crossed THEN
      SELECT max(fired_at) INTO last_fire FROM public.intel_alert_events WHERE rule_id=r.id;
      IF last_fire>now_at-make_interval(mins=>coalesce(r.cooldown_minutes,720)) THEN state:='cooldown';
      ELSIF NOT r.is_active THEN state:='draft_crossing';
      ELSIF p_commit THEN
       -- Persist a source-reference checkpoint, not unrestricted raw chart data.
       receipt:=jsonb_build_object('version',1,'method','sampled_quote_crossing_v1','asset',r.config->>'asset','observedAt',o.observed_at,'recordedAt',now_at,'source',o.provider,'observationId',o.id,'previousObservationId',previous->>'observationId','sourceRef',q->>'sourceRef','sourceUrl',q->>'sourceUrl','seriesRetained',false,'gapNotice','A crossing between sampled quotes; exact crossing time and intraperiod price path are not known.');
       INSERT INTO public.intel_alert_events(org_id,rule_id,private_owner_id,dedup_key,payload) VALUES(r.org_id,r.id,r.user_id,o.id,
        jsonb_build_object('trigger_type','chart_price','ref',r.config->>'asset','title',r.config->>'title','config',r.config,'checkpoint',receipt,'delivery','in_app','why_now','A fresh shared USD quote crossed your saved level. The first observation establishes a baseline.','confirm_or_weaken','Open the asset chart and review the source time; sampled alerts can miss moves between checks.'))
        ON CONFLICT(rule_id,dedup_key) DO NOTHING RETURNING id INTO event_id;
       IF event_id IS NOT NULL THEN fired:=fired+1;INSERT INTO public.intel_chart_alert_audit(org_id,user_id,rule_id,revision,action,detail) VALUES(r.org_id,r.user_id,r.id,r.chart_revision,'crossed',jsonb_build_object('eventId',event_id,'checkpoint',receipt));END IF;
      END IF;
     END IF;
    END IF;
   END IF;
  END IF;
  -- Retain the baseline only while it can establish a contiguous comparison.
  IF state='fresh_price_unavailable' AND coalesce(NULLIF(next_state->>'observedAt','')::timestamptz,'-infinity')<now_at-interval '20 minutes' THEN next_state:='{}';END IF;
  IF p_commit THEN UPDATE public.intel_alert_rules SET last_evaluation_attempt_at=now_at,chart_state=next_state||jsonb_build_object('status',state,'checkedAt',now_at) WHERE id=r.id;END IF;
  results:=results||jsonb_build_array(jsonb_build_object('ruleId',r.id,'state',state,'active',r.is_active,'eventId',event_id,'observedAt',o.observed_at,'source',o.provider,'value',q->'value','threshold',r.config->'threshold_usd','direction',r.config->>'direction'));
 END LOOP;
 RETURN jsonb_build_object('checked',checked,'fired',fired,'dryRun',NOT p_commit,'results',results,'providerCalls',0);
END $$;
REVOKE ALL ON FUNCTION public.intel_evaluate_chart_alerts(integer,uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_evaluate_chart_alerts(integer,uuid,uuid,uuid,boolean) TO service_role;
