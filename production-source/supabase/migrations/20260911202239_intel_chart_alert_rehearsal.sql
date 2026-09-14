CREATE FUNCTION app_private.intel_price_crossed(prior numeric,current_value numeric,level numeric,direction text) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT CASE direction WHEN 'above' THEN prior<=level AND current_value>level WHEN 'below' THEN prior>=level AND current_value<level ELSE false END
$$;
REVOKE ALL ON FUNCTION app_private.intel_price_crossed(numeric,numeric,numeric,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_private.intel_price_crossed(numeric,numeric,numeric,text) TO service_role;
-- Extract the already-reviewed identity mapping and share the crossing predicate with rehearsal.
DO $$ DECLARE original text;mapping text;changed text;BEGIN
 original:=pg_get_functiondef('public.intel_evaluate_chart_alerts(integer,uuid,uuid,uuid,boolean)'::regprocedure);
 mapping:=substring(original FROM 'keys:=([\s\S]*?)SELECT obs\.\*');
 IF mapping IS NULL OR mapping NOT LIKE '%intel_issuer_market_keys%' THEN RAISE EXCEPTION 'unexpected_chart_mapping';END IF;
 mapping:=replace(mapping,'r.config->>''asset''','p_asset');
 EXECUTE 'CREATE FUNCTION app_private.intel_chart_alert_market_keys(p_asset text) RETURNS text[] LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='''' AS $body$ DECLARE keys text[];BEGIN keys:='||mapping||'RETURN keys;END $body$';
 changed:=replace(original,'CASE WHEN r.config->>''direction''=''above'' THEN prior_value<=level AND value>level ELSE prior_value>=level AND value<level END','app_private.intel_price_crossed(prior_value,value,level,r.config->>''direction'')');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_chart_crossing';END IF;
 EXECUTE changed;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_chart_alert_market_keys(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_private.intel_chart_alert_market_keys(text) TO service_role;

CREATE FUNCTION public.intel_rehearse_chart_alert(p_org uuid,p_user uuid,p_rule uuid,p_from timestamptz,p_to timestamptz,p_allowed_providers text[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.intel_alert_rules;obs public.intel_market_observations;previous public.intel_market_observations;keys text[];tick timestamptz;last_fire timestamptz;state text;events jsonb:='[]';checked integer:=0;missing integer:=0;baselines integer:=0;observations integer:=0;crossings integer:=0;suppressed integer:=0;first_at timestamptz;last_at timestamptz;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) OR public.can_access_intel(p_user,p_org) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to>now() OR p_from>=p_to OR p_to-p_from>interval '24 hours' THEN RAISE EXCEPTION 'chart_alert_invalid_rehearsal_window';END IF;
 SELECT * INTO r FROM public.intel_alert_rules WHERE id=p_rule AND org_id=p_org AND user_id=p_user AND trigger_type='chart_price';
 IF NOT FOUND THEN RAISE EXCEPTION 'chart_alert_not_found';END IF;
 keys:=app_private.intel_chart_alert_market_keys(r.config->>'asset');
 -- Current scheduled phase :01/:16/:31/:46. Do not inspect future-known revisions.
 tick:=date_bin(interval '15 minutes',p_from,'2000-01-01 00:01:00Z');IF tick<p_from THEN tick:=tick+interval '15 minutes';END IF;
 WHILE tick<=p_to LOOP
  checked:=checked+1;obs:=NULL;
  SELECT o.* INTO obs FROM public.intel_market_observations o WHERE o.subject=ANY(keys) AND o.metric='price' AND o.observed_at BETWEEN tick-interval '5 minutes' AND tick AND o.recorded_at<=tick AND o.retain_until>now()
   AND o.provider=ANY(p_allowed_providers) AND o.observation->>'unit'='USD' AND jsonb_typeof(o.observation->'value')='number'
   AND (o.observation->>'value')::numeric>0 AND (o.observation->>'value')::numeric<=1e18 AND (o.observation->>'expiresAt')::timestamptz>tick
   ORDER BY CASE WHEN o.provider='coinmarketcap' THEN 0 ELSE 1 END,o.observed_at DESC,o.recorded_at DESC,o.id LIMIT 1;
  IF NOT FOUND THEN missing:=missing+1;IF previous.observed_at<tick-interval '20 minutes' THEN previous:=NULL;END IF;
  ELSIF previous.id IS DISTINCT FROM obs.id AND (previous.observed_at IS NULL OR obs.observed_at>previous.observed_at) THEN
   observations:=observations+1;first_at:=coalesce(first_at,obs.observed_at);last_at:=obs.observed_at;
   IF previous.id IS NULL OR obs.observed_at-previous.observed_at>interval '20 minutes' OR previous.provider<>obs.provider OR previous.subject<>obs.subject THEN baselines:=baselines+1;
   ELSIF app_private.intel_price_crossed((previous.observation->>'value')::numeric,(obs.observation->>'value')::numeric,(r.config->>'threshold_usd')::numeric,r.config->>'direction') THEN
    IF last_fire>tick-make_interval(mins=>coalesce(r.cooldown_minutes,720)) THEN suppressed:=suppressed+1;
    ELSE crossings:=crossings+1;last_fire:=tick;
     IF jsonb_array_length(events)<20 THEN events:=events||jsonb_build_array(jsonb_build_object('evaluationAt',tick,'observedAt',obs.observed_at,'knownAt',obs.recorded_at,'source',obs.provider,'observationId',obs.id,'previousObservationId',previous.id,'ruleRevision',r.chart_revision,'config',r.config,'previewOnly',true,'sourceUrl',obs.observation->>'sourceUrl'));END IF;
    END IF;
   END IF;previous:=obs;
  END IF;
  tick:=tick+interval '15 minutes';
 END LOOP;
 RETURN jsonb_build_object('previewOnly',true,'method','sampled_quote_crossing_v1','ruleId',r.id,'ruleRevision',r.chart_revision,'config',r.config,'requestedFrom',p_from,'requestedTo',p_to,'firstObservationAt',first_at,'lastObservationAt',last_at,'checks',checked,'missingChecks',missing,'observations',observations,'baselines',baselines,'crossings',crossings,'cooldownSuppressed',suppressed,'examples',events,'exampleLimit',20,'providerCalls',0,'cadenceMinutes',15,'notice','Rehearses this saved revision using only currently retained observations known at each scheduled check. Gaps establish new baselines. This is neither a sent alert nor a complete historical backtest.');
END $$;
REVOKE ALL ON FUNCTION public.intel_rehearse_chart_alert(uuid,uuid,uuid,timestamptz,timestamptz,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_rehearse_chart_alert(uuid,uuid,uuid,timestamptz,timestamptz,text[]) TO service_role;
