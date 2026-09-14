-- Preserve the central entitlement decision, including FORGE Holder Access.
-- Organization membership and can_access_intel are still checked for every rule.
CREATE OR REPLACE FUNCTION public.intel_evaluate_chart_alerts(p_limit integer DEFAULT 100,p_rule uuid DEFAULT NULL,p_org uuid DEFAULT NULL,p_user uuid DEFAULT NULL,p_commit boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.intel_alert_rules;o public.intel_market_observations;keys text[];q jsonb;previous jsonb;next_state jsonb;receipt jsonb;event_id uuid;now_at timestamptz:=clock_timestamp();level numeric;value numeric;prior_value numeric;prior_time timestamptz;last_fire timestamptz;crossed boolean;state text;checked integer:=0;fired integer:=0;results jsonb:='[]';
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 400 OR p_commit IS NULL OR ((p_user IS NULL)<>(p_org IS NULL)) OR (NOT p_commit AND (p_rule IS NULL OR p_user IS NULL)) THEN RAISE EXCEPTION 'chart_alert_invalid_evaluation';END IF;
 IF p_user IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) OR public.can_access_intel(p_user,p_org) IS NOT TRUE) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 FOR r IN SELECT a.* FROM public.intel_alert_rules a JOIN public.orgs org ON org.id=a.org_id
  WHERE a.trigger_type='chart_price' AND (NOT p_commit OR a.is_active)
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
