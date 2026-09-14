-- Backward-compatible rule semantics; shared by the scheduled evaluator and rehearsal.
CREATE FUNCTION app_private.intel_condition_step(previous jsonb,observation jsonb,config jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE level numeric:=(config->>'threshold_usd')::numeric;value numeric:=(observation->>'value')::numeric;t timestamptz:=(observation->>'observedAt')::timestamptz;prior_at timestamptz:=NULLIF(previous->>'observedAt','')::timestamptz;direction text:=config->>'direction';margin numeric:=level*coalesce((config->>'hysteresis_pct')::numeric,0)/100;duration integer:=coalesce((config->>'sustain_minutes')::integer,0);armed boolean;qualifies boolean;candidate boolean:=false;since timestamptz;state text:='watching';contiguous boolean;next jsonb;
BEGIN
 contiguous:=prior_at IS NOT NULL AND t>prior_at AND t-prior_at<=interval '20 minutes' AND previous->>'provider'=observation->>'provider' AND previous->>'subject'=observation->>'subject';
 qualifies:=CASE direction WHEN 'above' THEN value>level WHEN 'below' THEN value<level ELSE false END;
 armed:=coalesce((previous->>'armed')::boolean,CASE WHEN duration>0 THEN true WHEN direction='above' THEN (previous->>'value')::numeric<=level ELSE (previous->>'value')::numeric>=level END,false);
 since:=NULLIF(previous->>'conditionSince','')::timestamptz;
 IF NOT contiguous THEN
  state:='baseline';since:=CASE WHEN qualifies AND duration>0 THEN t ELSE NULL END;
  armed:=CASE WHEN duration>0 THEN true WHEN direction='above' THEN value<=level-margin ELSE value>=level+margin END;
 ELSE
  IF (CASE direction WHEN 'above' THEN value<=level-margin ELSE value>=level+margin END) THEN armed:=true;END IF;
  IF duration=0 THEN candidate:=armed AND app_private.intel_price_crossed((previous->>'value')::numeric,value,level,direction);
  ELSIF NOT qualifies THEN since:=NULL;
  ELSIF armed THEN since:=coalesce(since,t);candidate:=t-since>=make_interval(mins=>duration);state:='holding';
  END IF;
  IF candidate THEN armed:=false;since:=NULL;state:='crossed';END IF;
 END IF;
 next:=observation||jsonb_build_object('armed',armed,'conditionSince',since);
 RETURN jsonb_build_object('candidate',candidate,'state',state,'next',next);
END $$;
REVOKE ALL ON FUNCTION app_private.intel_condition_step(jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_private.intel_condition_step(jsonb,jsonb,jsonb) TO service_role;

CREATE FUNCTION app_private.intel_condition_config_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF NEW.trigger_type='chart_price' THEN
  IF coalesce(NEW.config->>'repeat','rearm') NOT IN('once','rearm') OR coalesce(NEW.config->>'condition','crossing') NOT IN('crossing','sustained')
   OR (NEW.config?'hysteresis_pct' AND (jsonb_typeof(NEW.config->'hysteresis_pct')<>'number' OR (NEW.config->>'hysteresis_pct')::numeric NOT BETWEEN 0 AND 50))
   OR (NEW.config?'sustain_minutes' AND (jsonb_typeof(NEW.config->'sustain_minutes')<>'number' OR (NEW.config->>'sustain_minutes')::numeric NOT BETWEEN 0 AND 1440 OR (NEW.config->>'sustain_minutes')::numeric<>trunc((NEW.config->>'sustain_minutes')::numeric)))
   OR (coalesce(NEW.config->>'condition','crossing')='sustained' AND coalesce((NEW.config->>'sustain_minutes')::numeric,0)<15)
   OR (coalesce(NEW.config->>'condition','crossing')='crossing' AND coalesce((NEW.config->>'sustain_minutes')::numeric,0)<>0)
  THEN RAISE EXCEPTION 'chart_alert_invalid_behavior';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_condition_config_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_condition_config_guard BEFORE INSERT OR UPDATE OF config ON public.intel_alert_rules FOR EACH ROW EXECUTE FUNCTION app_private.intel_condition_config_guard();

DO $$ DECLARE original text;changed text;step text;BEGIN
 original:=pg_get_functiondef('public.intel_evaluate_chart_alerts(integer,uuid,uuid,uuid,boolean)'::regprocedure);
 step:='app_private.intel_condition_step(previous,jsonb_build_object(''observationId'',o.id,''provider'',o.provider,''subject'',o.subject,''observedAt'',o.observed_at,''value'',value,''sourceRef'',q->>''sourceRef''),r.config)';
 changed:=replace(original,'crossed:=app_private.intel_price_crossed(prior_value,value,level,r.config->>''direction'');','crossed:=('||step||'->>''candidate'')::boolean;');
 changed:=replace(changed,'state:=CASE WHEN crossed THEN ''crossed'' ELSE ''watching'' END;','state:='||step||'->>''state'';');
 changed:=replace(changed,'next_state:=jsonb_build_object(''observationId'',o.id,''provider'',o.provider,''subject'',o.subject,''observedAt'',o.observed_at,''value'',value,''sourceRef'',q->>''sourceRef'');','next_state:='||step||'->''next'';');
 changed:=replace(changed,'SET last_evaluation_attempt_at=now_at,chart_state=','SET is_active=CASE WHEN event_id IS NOT NULL AND r.config->>''repeat''=''once'' THEN false ELSE r.is_active END,last_evaluation_attempt_at=now_at,chart_state=');
 changed:=replace(changed,'''config'',r.config,''checkpoint'',receipt','''config'',r.config,''rule_revision'',r.chart_revision,''checkpoint'',receipt');
 changed:=replace(changed,'''method'',''sampled_quote_crossing_v1''','''method'',coalesce(r.config->>''method'',''sampled_quote_crossing_v1'')');
 changed:=replace(changed,'''A fresh shared USD quote crossed your saved level.''','CASE WHEN r.config->>''condition''=''sustained'' THEN ''Consecutive usable observations remained beyond your saved level for the configured duration.'' ELSE ''A fresh shared USD quote crossed your saved level.'' END');
 changed:=replace(changed,'''A crossing between sampled quotes; exact crossing time and intraperiod price path are not known.''','CASE WHEN r.config->>''condition''=''sustained'' THEN ''Sustained across sampled observations; the path between checks is unknown.'' ELSE ''A crossing between sampled quotes; exact crossing time and intraperiod price path are not known.'' END');
 IF changed=original OR changed LIKE '%crossed:=app_private.intel_price_crossed%' THEN RAISE EXCEPTION 'unexpected_live_condition_body';END IF;EXECUTE changed;
 original:=pg_get_functiondef('public.intel_rehearse_chart_alert(uuid,uuid,uuid,timestamptz,timestamptz,text[])'::regprocedure);
 changed:=replace(original,'DECLARE r public.intel_alert_rules;','DECLARE condition_state jsonb:=''{}'';step jsonb;r public.intel_alert_rules;');
 changed:=replace(changed,'observations:=observations+1;','step:=app_private.intel_condition_step(condition_state,jsonb_build_object(''observationId'',obs.id,''provider'',obs.provider,''subject'',obs.subject,''observedAt'',obs.observed_at,''value'',obs.observation->''value''),r.config);condition_state:=step->''next'';observations:=observations+1;');
 changed:=replace(changed,'app_private.intel_price_crossed((previous.observation->>''value'')::numeric,(obs.observation->>''value'')::numeric,(r.config->>''threshold_usd'')::numeric,r.config->>''direction'')','(step->>''candidate'')::boolean AND (r.config->>''repeat'' IS DISTINCT FROM ''once'' OR crossings=0)');
 changed:=replace(changed,'''method'',''sampled_quote_crossing_v1''','''method'',coalesce(r.config->>''method'',''sampled_quote_crossing_v1'')');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_rehearsal_body';END IF;EXECUTE changed;
 original:=pg_get_functiondef('public.intel_save_chart_alert(uuid,uuid,uuid,integer,uuid,jsonb,boolean,integer)'::regprocedure);
 changed:=replace(original,'p_config->>''method'' IS DISTINCT FROM ''sampled_quote_crossing_v1''','coalesce(p_config->>''method'','''') NOT IN (''sampled_quote_crossing_v1'',''sampled_quote_condition_v2'')');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_alert_editor_body';END IF;EXECUTE changed;
END $$;
