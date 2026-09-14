-- Retain legacy threshold semantics; new rules can explicitly choose crossing
-- or sustained observations. Reuse the chart's tested state transition.
CREATE FUNCTION app_private.intel_market_rule_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF TG_OP='UPDATE' AND current_user NOT IN('postgres','service_role') AND (NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.chart_state IS DISTINCT FROM OLD.chart_state) THEN RAISE EXCEPTION 'alert_owner_and_state_are_server_recorded';END IF;
 IF (TG_OP='INSERT' OR NEW.config IS DISTINCT FROM OLD.config) AND (NEW.trigger_type IN('thesis_condition','wallet_activity') OR nullif(NEW.config->>'note','') IS NOT NULL OR (TG_OP='UPDATE' AND OLD.config->>'visibility'='private')) THEN NEW.config:=NEW.config||'{"visibility":"private"}';END IF;
 IF NEW.trigger_type IN('price_move','volume_spike','liquidity_drop') THEN
  IF coalesce(NEW.config->>'condition','legacy_level') NOT IN('legacy_level','crossing','sustained') OR coalesce(NEW.config->>'repeat','rearm') NOT IN('once','rearm') OR coalesce(NEW.config->>'direction','either') NOT IN('up','down','either')
   OR (NEW.config?'hysteresis_pct' AND (jsonb_typeof(NEW.config->'hysteresis_pct')<>'number' OR (NEW.config->>'hysteresis_pct')::numeric NOT BETWEEN 0 AND 50))
   OR (NEW.config->>'condition'='sustained' AND (jsonb_typeof(NEW.config->'sustain_minutes') IS DISTINCT FROM 'number' OR (NEW.config->>'sustain_minutes')::numeric NOT BETWEEN 15 AND 1440 OR (NEW.config->>'sustain_minutes')::numeric<>trunc((NEW.config->>'sustain_minutes')::numeric))) THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 END IF;
 IF length(coalesce(NEW.config->>'note',''))>2000 OR length(coalesce(NEW.config->>'title',''))>120 THEN RAISE EXCEPTION 'alert_text_limit';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_market_rule_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER a_intel_market_rule_guard BEFORE INSERT OR UPDATE ON public.intel_alert_rules FOR EACH ROW EXECUTE FUNCTION app_private.intel_market_rule_guard();
CREATE POLICY intel_personal_alert_rule_boundary ON public.intel_alert_rules AS RESTRICTIVE FOR ALL TO authenticated
 USING((trigger_type NOT IN('thesis_condition','wallet_activity') AND config->>'visibility' IS DISTINCT FROM 'private' AND nullif(config->>'note','') IS NULL) OR (user_id=(select auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_rules.org_id AND m.user_id=(select auth.uid()))))
 WITH CHECK((trigger_type NOT IN('thesis_condition','wallet_activity') AND config->>'visibility' IS DISTINCT FROM 'private' AND nullif(config->>'note','') IS NULL) OR (user_id=(select auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_rules.org_id AND m.user_id=(select auth.uid()))));

DO $$ DECLARE original text;changed text;BEGIN
 original:=pg_get_functiondef('public.intel_emit_bridged_alert(uuid,uuid,integer,text,text,text,text,numeric,jsonb)'::regprocedure);
 changed:=replace(original,'''wallet_activity'',''holder_shift'',''unlock'',''supply_shock'',''metadata_migration''','''wallet_activity'',''holder_shift'',''unlock'',''supply_shock'',''metadata_migration'',''price_move'',''volume_spike'',''liquidity_drop'',''narrative_heat''');
 changed:=replace(changed,'r.trigger_type=''wallet_activity'' THEN r.user_id','r.trigger_type IN(''wallet_activity'',''price_move'',''volume_spike'',''liquidity_drop'',''narrative_heat'') THEN r.user_id');
 changed:=replace(changed,'make_interval(mins=>coalesce(r.cooldown_minutes,720))','make_interval(mins=>coalesce(r.cooldown_minutes,720)*CASE WHEN r.trigger_type IN(''price_move'',''volume_spike'',''liquidity_drop'') AND (SELECT count(*) FROM public.intel_alert_events WHERE rule_id=r.id AND fired_at>clock_timestamp()-interval ''48 hours'')>=4 THEN 2 ELSE 1 END)');
 IF changed=original OR changed NOT LIKE '%''price_move''%' THEN RAISE EXCEPTION 'unexpected_bridge_definition';END IF;EXECUTE changed;
END $$;
CREATE FUNCTION public.intel_record_market_alert(p_rule uuid,p_org uuid,p_revision integer,p_observation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r intel_alert_rules;e entities;value numeric;level numeric;sample_at timestamptz;known_at timestamptz;expires_at timestamptz;previous jsonb;step jsonb;config jsonb;candidate boolean;outcome text:='evaluated_no_match';metric text;unit text;receipt jsonb;direction text;event_id uuid;BEGIN
 SELECT * INTO r FROM intel_alert_rules WHERE id=p_rule AND org_id=p_org FOR UPDATE;
 IF NOT FOUND OR NOT r.is_active OR r.chart_revision<>p_revision THEN RETURN jsonb_build_object('state','changed');END IF;
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=r.org_id AND user_id=r.user_id) OR NOT can_access_intel(r.user_id,r.org_id) THEN RETURN jsonb_build_object('state','access_unavailable');END IF;
 IF r.trigger_type NOT IN('price_move','volume_spike','liquidity_drop') OR jsonb_typeof(p_observation)<>'object' OR octet_length(p_observation::text)>8000 THEN RAISE EXCEPTION 'invalid_market_condition';END IF;
 SELECT * INTO e FROM entities WHERE id=r.entity_id AND org_id=r.org_id;
 IF e.id IS NULL OR e.canonical_ref_key IS DISTINCT FROM p_observation->>'subject' THEN RAISE EXCEPTION 'market_condition_identity_changed';END IF;
 value:=(p_observation->>'value')::numeric;level:=CASE WHEN r.trigger_type='liquidity_drop' THEN (r.config->>'min_liquidity_usd')::numeric ELSE (r.config->>'threshold_pct')::numeric END;
 sample_at:=(p_observation->>'sampleAt')::timestamptz;known_at:=(p_observation->>'recordedAt')::timestamptz;expires_at:=(p_observation->>'expiresAt')::timestamptz;
 metric:=CASE r.trigger_type WHEN 'price_move' THEN 'price_change_24h_pct' WHEN 'volume_spike' THEN 'volume_change_24h_pct' ELSE 'liquidity_usd' END;unit:=CASE WHEN r.trigger_type='liquidity_drop' THEN 'USD' ELSE '%' END;
 IF value IS NULL OR level IS NULL OR abs(value)>1e18 OR value::text IN('NaN','Infinity','-Infinity') OR level<0 OR level>1e18 OR level::text IN('NaN','Infinity','-Infinity') OR p_observation->>'unit' IS DISTINCT FROM unit OR nullif(p_observation->>'id','') IS NULL OR nullif(p_observation->>'sourceRef','') IS NULL THEN RAISE EXCEPTION 'market_condition_value_invalid';END IF;
 IF sample_at IS NULL OR known_at IS NULL OR expires_at IS NULL OR sample_at>now() OR known_at>now() OR expires_at<=now() OR sample_at<now()-interval '20 minutes' OR known_at<now()-interval '20 minutes' THEN RAISE EXCEPTION 'market_condition_source_expired';END IF;
 IF r.trigger_type<>'liquidity_drop' AND (p_observation->>'periodSeconds')::integer IS DISTINCT FROM 86400 THEN RAISE EXCEPTION 'market_condition_period_invalid';END IF;
 IF p_observation->>'clockBasis'='provider_observation' THEN
  IF (p_observation->>'observedAt')::timestamptz IS DISTINCT FROM sample_at THEN RAISE EXCEPTION 'market_condition_clock_invalid';END IF;
 ELSIF p_observation->>'clockBasis'='cache_capture' THEN
  IF p_observation->>'observedAt' IS NOT NULL OR sample_at<>known_at THEN RAISE EXCEPTION 'market_condition_clock_invalid';END IF;
 ELSE RAISE EXCEPTION 'market_condition_clock_invalid';END IF;
 previous:=CASE WHEN r.chart_state->>'revision'=p_revision::text THEN coalesce(r.chart_state->'sample','{}') ELSE '{}' END;
 IF previous->>'observationId'=p_observation->>'id' THEN RETURN jsonb_build_object('state','same_observation');END IF;
 IF nullif(previous->>'observedAt','')::timestamptz>=sample_at THEN RETURN jsonb_build_object('state','older_observation_ignored');END IF;
 direction:=coalesce(r.config->>'direction','either');
 IF direction NOT IN('up','down','either') THEN RAISE EXCEPTION 'market_condition_direction_invalid';END IF;
 IF r.trigger_type='price_move' THEN value:=CASE direction WHEN 'down' THEN -value WHEN 'either' THEN abs(value) ELSE value END;END IF;
 config:=jsonb_build_object('threshold_usd',level,'direction',CASE WHEN r.trigger_type='liquidity_drop' THEN 'below' ELSE 'above' END,'hysteresis_pct',coalesce(r.config->'hysteresis_pct','0'),'sustain_minutes',CASE WHEN r.config->>'condition'='sustained' THEN coalesce(r.config->'sustain_minutes','15') ELSE '0'::jsonb END);
 IF jsonb_typeof(config->'hysteresis_pct')<>'number' OR (config->>'hysteresis_pct')::numeric NOT BETWEEN 0 AND 50 OR jsonb_typeof(config->'sustain_minutes')<>'number' OR (config->>'sustain_minutes')::numeric<>trunc((config->>'sustain_minutes')::numeric) OR (config->>'sustain_minutes')::integer NOT BETWEEN 0 AND 1440 OR (r.config->>'condition'='sustained' AND (config->>'sustain_minutes')::integer<15) THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 IF coalesce(r.config->>'condition','legacy_level') NOT IN('legacy_level','crossing','sustained') OR coalesce(r.config->>'repeat','rearm') NOT IN('rearm','once') THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 step:=app_private.intel_condition_step(previous,jsonb_build_object('observationId',p_observation->>'id','observedAt',sample_at,'value',value,'provider',p_observation->>'provider','subject',p_observation->>'subject'||':'||metric||':'||(p_observation->>'clockBasis')),config);
 candidate:=CASE WHEN coalesce(r.config->>'condition','legacy_level')='legacy_level' THEN CASE WHEN r.trigger_type='liquidity_drop' THEN value>=0 AND value<level ELSE value>=level END ELSE (step->>'candidate')::boolean END;
 receipt:=jsonb_build_object('rule_revision',p_revision,'config',r.config,'metric',metric,'unit',unit,'observation',p_observation-'value','checkedAt',now(),'method',coalesce(r.config->>'condition','legacy_level'),'comparison_basis',CASE WHEN r.trigger_type='price_move' THEN 'Reported rolling 24-hour price change; not change since activation or entry.' WHEN r.trigger_type='volume_spike' THEN 'Reported rolling 24-hour volume change.' ELSE 'Reported absolute liquidity; not executable depth.' END);
 IF candidate THEN
  outcome:=public.intel_emit_bridged_alert(r.id,r.org_id,r.chart_revision,p_observation->>'provider','retained_market_observation',p_observation->>'id',metric,(p_observation->>'value')::numeric,jsonb_build_object('checkpoint',receipt,'ref',e.canonical_ref_key,'symbol',e.display_symbol,'threshold',level,'unit',unit,'source_observed_at',p_observation->'observedAt','known_at',p_observation->'recordedAt','provider_source_ref',p_observation->>'sourceRef','expires_at',p_observation->'expiresAt','coverage',p_observation->>'coverage','why_now','The recorded condition matched a compatible retained sample. Review its source clock and coverage.'));
 END IF;
 IF NOT candidate THEN outcome:=step->>'state';END IF;
 UPDATE intel_alert_rules SET chart_state=jsonb_build_object('revision',p_revision,'sample',step->'next'),evaluation_state=receipt||jsonb_build_object('status',outcome),last_evaluation_attempt_at=now() WHERE id=r.id;
 IF outcome='fired' AND r.config->>'repeat'='once' THEN
  UPDATE intel_alert_rules SET is_active=false WHERE id=r.id;
  -- Preserve the firing receipt even if a legacy activation guard increments the
  -- paused state revision. The receipt retains the exact evaluated rule version.
  UPDATE intel_alert_rules SET evaluation_state=receipt||jsonb_build_object('status','fired') WHERE id=r.id;
 END IF;
 SELECT id INTO event_id FROM intel_alert_events WHERE rule_id=r.id AND dedup_key='retained_market_observation:'||(p_observation->>'id')||':revision:'||p_revision;
 RETURN jsonb_build_object('state',outcome,'eventId',event_id,'checkpoint',receipt);
END $$;
REVOKE ALL ON FUNCTION public.intel_record_market_alert(uuid,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_market_alert(uuid,uuid,integer,jsonb) TO service_role;

-- Narrative scores retain their name and calculation clock. A score is not a
-- market observation or mindshare. Read and commit the same locked state.
CREATE FUNCTION public.intel_record_narrative_alert(p_rule uuid,p_org uuid,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r intel_alert_rules;s narrative_state;title text;reason text;outcome text;event_id uuid;checkpoint jsonb;momentum numeric;risk numeric;delta numeric;source_ref text;BEGIN
 SELECT * INTO r FROM intel_alert_rules WHERE id=p_rule AND org_id=p_org FOR UPDATE;
 IF NOT FOUND OR NOT r.is_active OR r.chart_revision<>p_revision OR r.trigger_type<>'narrative_heat' THEN RETURN jsonb_build_object('state','changed');END IF;
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=r.org_id AND user_id=r.user_id) OR NOT can_access_intel(r.user_id,r.org_id) THEN RETURN jsonb_build_object('state','access_unavailable');END IF;
 SELECT st.* INTO s FROM narrative_state st JOIN narrative_taxonomy t ON t.id=st.narrative_id WHERE t.slug=r.config->>'slug' FOR SHARE OF st;
 IF NOT FOUND OR s.scored_at IS NULL OR s.scored_at>now() OR s.scored_at<now()-interval '6 hours' THEN
  PERFORM intel_record_alert_evaluation(r.id,r.org_id,r.chart_revision,'{"status":"evidence_unavailable","reason":"No narrative calculation within the last six hours is available. Its calculation time is distinct from underlying source observation times."}');RETURN jsonb_build_object('state','evidence_unavailable');
 END IF;
 SELECT name INTO title FROM narrative_taxonomy WHERE id=s.narrative_id;
 momentum:=coalesce((r.config->>'momentum_delta')::numeric,10);risk:=coalesce((r.config->>'risk_score')::numeric,65);
 IF momentum NOT BETWEEN 0 AND 100 OR risk NOT BETWEEN 0 AND 100 THEN RAISE EXCEPTION 'narrative_threshold_invalid';END IF;
 delta:=CASE WHEN jsonb_typeof(s.score_delta->'momentum')='number' THEN (s.score_delta->>'momentum')::numeric ELSE NULL END;
 IF coalesce((r.config->>'stage_change')::boolean,true) AND s.prev_stage IS NOT NULL AND s.lifecycle_stage IS NOT NULL AND s.prev_stage<>s.lifecycle_stage AND s.stage_changed_at BETWEEN now()-interval '6 hours' AND now() THEN reason:='stage '||s.prev_stage||' → '||s.lifecycle_stage;
 ELSIF delta>=momentum THEN reason:='momentum '||delta::text||' points';
 ELSIF coalesce((r.config->>'risk_spike')::boolean,true) AND s.risk_score>=risk THEN reason:='risk elevated ('||s.risk_score::text||' points)';END IF;
 checkpoint:=jsonb_build_object('rule_revision',r.chart_revision,'config',r.config,'calculated_at',s.scored_at,'checkedAt',now(),'clock_basis','narrative_calculation','source_observed_at',null,'coverage','Calculation time is known; underlying sources have mixed observation times. No single source freshness is asserted.','momentum_delta',delta,'momentum_score',s.momentum_score,'risk_score',s.risk_score,'stage_changed_at',s.stage_changed_at);
 outcome:=CASE WHEN reason IS NOT NULL THEN 'candidate' WHEN delta IS NULL OR (coalesce((r.config->>'risk_spike')::boolean,true) AND s.risk_score IS NULL) THEN 'evidence_unavailable' ELSE 'evaluated_no_match' END;
 IF reason IS NOT NULL THEN
  source_ref:=s.narrative_id::text||':'||s.scored_at::text;
  outcome:=intel_emit_bridged_alert(r.id,r.org_id,r.chart_revision,'narrative','narrative_state',source_ref,'narrative_condition',NULL,jsonb_build_object('checkpoint',checkpoint,'slug',r.config->>'slug','name',title,'reason',reason,'lifecycle_stage',s.lifecycle_stage,'prev_stage',s.prev_stage,'signal_class',s.signal_class,'momentum',s.momentum_score,'risk',s.risk_score,'calculated_at',s.scored_at));
  SELECT id INTO event_id FROM intel_alert_events WHERE rule_id=r.id AND dedup_key='narrative_state:'||source_ref||':revision:'||r.chart_revision;
 END IF;
 PERFORM intel_record_alert_evaluation(r.id,r.org_id,r.chart_revision,checkpoint||jsonb_build_object('status',outcome,'reason',CASE WHEN outcome='evidence_unavailable' THEN 'A required narrative score is missing; a successful no-match cannot be established.' ELSE reason END));
 RETURN jsonb_build_object('state',outcome,'eventId',event_id,'reason',reason,'snapshot',jsonb_build_object('narrative_id',s.narrative_id,'name',title,'lifecycle_stage',s.lifecycle_stage,'scored_at',s.scored_at));
END $$;
REVOKE ALL ON FUNCTION public.intel_record_narrative_alert(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_narrative_alert(uuid,uuid,integer) TO service_role;

CREATE FUNCTION public.intel_rehearse_market_alert(p_org uuid,p_user uuid,p_rule uuid,p_source_subject text,p_from timestamptz,p_to timestamptz,p_allowed boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r intel_alert_rules;obs intel_market_observations;tick timestamptz;previous jsonb:='{}';step jsonb;behavior jsonb;value numeric;level numeric;candidate boolean;last_fire timestamptz;fires timestamptz[]:='{}';events jsonb:='[]';checked integer:=0;missing integer:=0;baselines integer:=0;observations integer:=0;crossings integer:=0;suppressed integer:=0;first_at timestamptz;last_at timestamptz;BEGIN
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=p_org AND user_id=p_user) OR can_access_intel(p_user,p_org) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden';END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to>now() OR p_from>=p_to OR p_to-p_from>interval '24 hours' THEN RAISE EXCEPTION 'chart_alert_invalid_rehearsal_window';END IF;
 SELECT * INTO r FROM intel_alert_rules WHERE id=p_rule AND org_id=p_org AND user_id=p_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'chart_alert_not_found';END IF;
 IF r.trigger_type<>'price_move' OR p_source_subject IS NULL OR p_source_subject!~'^market:coinmarketcap:[1-9][0-9]{0,11}$' OR p_allowed IS NOT TRUE THEN
  RETURN jsonb_build_object('previewOnly',true,'state','unavailable','ruleRevision',r.chart_revision,'requestedFrom',p_from,'requestedTo',p_to,'examples','[]'::jsonb,'notice','A compatible permitted history is not retained for this trigger/source. The latest response cannot reconstruct past observations or provider knowledge. No historical firing count is asserted.');
 END IF;
 level:=(r.config->>'threshold_pct')::numeric;
 IF level IS NULL OR level NOT BETWEEN 0 AND 1e18 THEN RAISE EXCEPTION 'market_condition_value_invalid';END IF;
 behavior:=jsonb_build_object('threshold_usd',level,'direction','above','hysteresis_pct',coalesce(r.config->'hysteresis_pct','0'),'sustain_minutes',CASE WHEN r.config->>'condition'='sustained' THEN r.config->'sustain_minutes' ELSE '0'::jsonb END);
 tick:=date_bin(interval '15 minutes',p_from,'2000-01-01 00:01:00Z');IF tick<p_from THEN tick:=tick+interval '15 minutes';END IF;
 WHILE tick<=p_to LOOP
  checked:=checked+1;
  SELECT * INTO obs FROM intel_market_observations o WHERE o.subject=p_source_subject AND o.provider='coinmarketcap' AND o.metric='price_change' AND o.observed_at BETWEEN tick-interval '20 minutes' AND tick AND o.recorded_at<=tick AND o.retain_until>now()
   AND o.observation->>'unit'='%' AND o.observation->>'periodSeconds'='86400' AND o.observation->>'aiAllowed'='true' AND jsonb_typeof(o.observation->'value')='number' AND (o.observation->>'expiresAt')::timestamptz>tick
   AND o.observation->>'sourceRef' ~ '^coinmarketcap:/v[0-9]+/cryptocurrency/(quotes|listings)/latest:'
   ORDER BY observed_at DESC,recorded_at DESC,id LIMIT 1;
  IF NOT FOUND THEN missing:=missing+1;
  ELSIF previous->>'observationId' IS DISTINCT FROM obs.id AND (previous->>'observedAt' IS NULL OR (previous->>'observedAt')::timestamptz<obs.observed_at) THEN
   observations:=observations+1;first_at:=coalesce(first_at,obs.observed_at);last_at:=obs.observed_at;
   value:=(obs.observation->>'value')::numeric;value:=CASE coalesce(r.config->>'direction','either') WHEN 'down' THEN -value WHEN 'either' THEN abs(value) ELSE value END;
   step:=app_private.intel_condition_step(previous,jsonb_build_object('observationId',obs.id,'observedAt',obs.observed_at,'value',value,'provider',obs.provider,'subject',obs.subject),behavior);
   IF step->>'state'='baseline' THEN baselines:=baselines+1;END IF;
   candidate:=CASE WHEN coalesce(r.config->>'condition','legacy_level')='legacy_level' THEN value>=level ELSE (step->>'candidate')::boolean END;
   IF candidate AND (r.config->>'repeat' IS DISTINCT FROM 'once' OR crossings=0) THEN
    IF last_fire>tick-make_interval(mins=>coalesce(r.cooldown_minutes,720)*CASE WHEN cardinality(fires)>=4 THEN 2 ELSE 1 END) THEN suppressed:=suppressed+1;
    ELSE
     crossings:=crossings+1;last_fire:=tick;fires:=array_append(fires,tick);
     IF jsonb_array_length(events)<20 THEN events:=events||jsonb_build_array(jsonb_build_object('evaluationAt',tick,'observedAt',obs.observed_at,'knownAt',obs.recorded_at,'source',obs.provider,'observationId',obs.id,'ruleRevision',r.chart_revision,'config',r.config,'metric','price_change_24h_pct','unit','%','previewOnly',true));END IF;
    END IF;
   END IF;
   previous:=step->'next';
  END IF;
  tick:=tick+interval '15 minutes';
 END LOOP;
 RETURN jsonb_build_object('previewOnly',true,'state','evaluated','ruleRevision',r.chart_revision,'requestedFrom',p_from,'requestedTo',p_to,'firstObservationAt',first_at,'lastObservationAt',last_at,'checks',checked,'observations',observations,'missingChecks',missing,'baselines',baselines,'crossings',crossings,'cooldownSuppressed',suppressed,'cadenceMinutes',15,'examples',events,'notice','Reported rolling 24-hour price change, not a change since entry. Only retained observations already known at each check are used. Missing checks can hide crossings. Cooldown starts with no assumed earlier fires; noisy escalation uses only this window. No complete historical backtest is claimed.');
END $$;
REVOKE ALL ON FUNCTION public.intel_rehearse_market_alert(uuid,uuid,uuid,text,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_rehearse_market_alert(uuid,uuid,uuid,text,timestamptz,timestamptz,boolean) TO service_role;
