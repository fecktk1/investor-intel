-- Investor Intel — liquidation cascade and watchlist attention alerts.
--
-- CMC plan proposals 13 (liquidation cascade alerts) and 23 (watchlist attention
-- alerts). Both read ONLY the Stage 2 capture tables that are already being
-- filled; neither adds a table, a column, a provider call or a credit.
--
-- Additive only. Two new arms of the SAME market-alert evaluator, and the two
-- trigger types joining the bridge's allow-list. Every existing trigger keeps
-- its metric, unit, period, freshness window, clock rules, comparator, receipt
-- and state transition unchanged.
--
-- `liquidation_cascade` — metric `liquidation_cascade_ratio`, unit 'x'. The
-- value is the newest five-minute capture's liquidation total for the rule's
-- window divided by the SAME window's seven-day average from the retained
-- captures. It is a ratio, so it carries the window it describes as its period
-- (3600 for '1h', 14400 for '4h') and it may be a valid zero: nothing was
-- liquidated in that window. `threshold_pct` holds the multiple (1.5 to 20) and
-- the plain level comparator, `value >= multiple`, is the firing test; the
-- crossing and sustained machinery stays available unchanged. Freshness is the
-- ordinary twenty minutes: the capture cadence is five minutes.
--
-- `attention_entry` — metric `attention_persistence_hours`, unit 'hours'. The
-- value is how many CONSECUTIVE hourly captures of the named provider list, up
-- to and including the newest capture, still contained the asset. It is a count
-- of captures, not a rate, so it has no rolling period, and zero (absent from
-- the list) is a recorded observation rather than a missing one. `threshold_pct`
-- holds the required hours (1 to 24) and `value >= hours` is the firing test.
-- Freshness is 90 minutes: one hourly capture plus the slack to run it.
--
-- Neither trigger is in the bridge's private-owner list, so a firing is a shared
-- market fact with no private owner — the same treatment `metadata_notice` has.
--
-- ROLLBACK: re-create both functions from 20260915004720_market_asset_facts.sql
-- (the `-- SECTION: metadata notice alert evaluation` body, and the bridge with
-- its anchor list ending `'narrative_heat','metadata_notice')`).

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: liquidation and attention alert bridge
-- The two trigger types join the ones the market path may bridge. Patched the
-- way 20260911213014 and 20260915004720 patched it, against the LIVE definition,
-- so no earlier change is reverted and the edit is refused if the reviewed text
-- moved.
DO $bridge$ DECLARE original text;changed text;BEGIN
 original:=pg_get_functiondef('public.intel_emit_bridged_alert(uuid,uuid,integer,text,text,text,text,numeric,jsonb)'::regprocedure);
 changed:=replace(original,
  'NOT IN(''wallet_activity'',''holder_shift'',''unlock'',''supply_shock'',''metadata_migration'',''price_move'',''volume_spike'',''liquidity_drop'',''narrative_heat'',''metadata_notice'')',
  'NOT IN(''wallet_activity'',''holder_shift'',''unlock'',''supply_shock'',''metadata_migration'',''price_move'',''volume_spike'',''liquidity_drop'',''narrative_heat'',''metadata_notice'',''liquidation_cascade'',''attention_entry'')');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_bridge_definition';END IF;
 EXECUTE changed;
END $bridge$;

-- SECTION: liquidation and attention alert evaluation
-- The reviewed 20260915004720 body with the smallest possible addition for two
-- more trigger types. The only changed expressions are the accepted trigger
-- list, the metric, unit, freshness and comparison-basis CASEs, the period test
-- and the two new behaviour guards. Nothing else moves.
CREATE OR REPLACE FUNCTION public.intel_record_market_alert(p_rule uuid,p_org uuid,p_revision integer,p_observation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $market$
DECLARE r intel_alert_rules;e entities;value numeric;level numeric;sample_at timestamptz;known_at timestamptz;expires_at timestamptz;previous jsonb;step jsonb;config jsonb;candidate boolean;outcome text:='evaluated_no_match';metric text;unit text;receipt jsonb;direction text;event_id uuid;freshness interval;BEGIN
 SELECT * INTO r FROM intel_alert_rules WHERE id=p_rule AND org_id=p_org FOR UPDATE;
 IF NOT FOUND OR NOT r.is_active OR r.chart_revision<>p_revision THEN RETURN jsonb_build_object('state','changed');END IF;
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=r.org_id AND user_id=r.user_id) OR NOT can_access_intel(r.user_id,r.org_id) THEN RETURN jsonb_build_object('state','access_unavailable');END IF;
 IF r.trigger_type NOT IN('price_move','volume_spike','liquidity_drop','metadata_notice','liquidation_cascade','attention_entry') OR jsonb_typeof(p_observation)<>'object' OR octet_length(p_observation::text)>8000 THEN RAISE EXCEPTION 'invalid_market_condition';END IF;
 SELECT * INTO e FROM entities WHERE id=r.entity_id AND org_id=r.org_id;
 IF e.id IS NULL OR e.canonical_ref_key IS DISTINCT FROM p_observation->>'subject' THEN RAISE EXCEPTION 'market_condition_identity_changed';END IF;
 value:=(p_observation->>'value')::numeric;level:=CASE WHEN r.trigger_type='liquidity_drop' THEN (r.config->>'min_liquidity_usd')::numeric ELSE (r.config->>'threshold_pct')::numeric END;
 sample_at:=(p_observation->>'sampleAt')::timestamptz;known_at:=(p_observation->>'recordedAt')::timestamptz;expires_at:=(p_observation->>'expiresAt')::timestamptz;
 metric:=CASE r.trigger_type WHEN 'price_move' THEN 'price_change_24h_pct' WHEN 'volume_spike' THEN 'volume_change_24h_pct' WHEN 'metadata_notice' THEN 'metadata_notice' WHEN 'liquidation_cascade' THEN 'liquidation_cascade_ratio' WHEN 'attention_entry' THEN 'attention_persistence_hours' ELSE 'liquidity_usd' END;unit:=CASE r.trigger_type WHEN 'liquidity_drop' THEN 'USD' WHEN 'metadata_notice' THEN 'notice' WHEN 'liquidation_cascade' THEN 'x' WHEN 'attention_entry' THEN 'hours' ELSE '%' END;
 -- A daily metadata pass cannot meet a twenty-minute window, and an hourly
 -- attention capture needs one hour plus the slack to run it; nothing else moves.
 freshness:=CASE r.trigger_type WHEN 'metadata_notice' THEN interval '48 hours' WHEN 'attention_entry' THEN interval '90 minutes' ELSE interval '20 minutes' END;
 -- The notice rule is a presence test. Any other comparator or threshold would
 -- claim a magnitude a presence flag does not carry.
 IF r.trigger_type='metadata_notice' AND (coalesce(r.config->>'condition','legacy_level')<>'legacy_level' OR level IS DISTINCT FROM 1 OR value NOT IN(0,1)) THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 -- A cascade multiple is a ratio against the asset's own seven-day average. Below
 -- 1.5 it is noise and above 20 it is not a threshold anyone can defend; a
 -- negative ratio is not a measurement at all.
 IF r.trigger_type='liquidation_cascade' AND (level<1.5 OR level>20 OR value<0) THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 -- Persistence is a whole number of hourly captures inside the retained day.
 IF r.trigger_type='attention_entry' AND (level<1 OR level>24 OR level<>trunc(level) OR value<0 OR value>24 OR value<>trunc(value)) THEN RAISE EXCEPTION 'market_condition_behavior_invalid';END IF;
 IF value IS NULL OR level IS NULL OR abs(value)>1e18 OR value::text IN('NaN','Infinity','-Infinity') OR level<0 OR level>1e18 OR level::text IN('NaN','Infinity','-Infinity') OR p_observation->>'unit' IS DISTINCT FROM unit OR nullif(p_observation->>'id','') IS NULL OR nullif(p_observation->>'sourceRef','') IS NULL THEN RAISE EXCEPTION 'market_condition_value_invalid';END IF;
 IF sample_at IS NULL OR known_at IS NULL OR expires_at IS NULL OR sample_at>now() OR known_at>now() OR expires_at<=now() OR sample_at<now()-freshness OR known_at<now()-freshness THEN RAISE EXCEPTION 'market_condition_source_expired';END IF;
 -- A cascade ratio states the window it describes; a persistence count has no
 -- rolling window at all and may not claim one. Every other trigger is unchanged.
 IF r.trigger_type='liquidation_cascade' THEN
  IF (p_observation->>'periodSeconds')::integer IS NULL OR (p_observation->>'periodSeconds')::integer NOT IN(3600,14400) THEN RAISE EXCEPTION 'market_condition_period_invalid';END IF;
 ELSIF r.trigger_type='attention_entry' THEN
  IF p_observation->>'periodSeconds' IS NOT NULL THEN RAISE EXCEPTION 'market_condition_period_invalid';END IF;
 ELSIF r.trigger_type NOT IN('liquidity_drop','metadata_notice') AND (p_observation->>'periodSeconds')::integer IS DISTINCT FROM 86400 THEN RAISE EXCEPTION 'market_condition_period_invalid';END IF;
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
 receipt:=jsonb_build_object('rule_revision',p_revision,'config',r.config,'metric',metric,'unit',unit,'observation',p_observation-'value','checkedAt',now(),'method',coalesce(r.config->>'condition','legacy_level'),'comparison_basis',CASE WHEN r.trigger_type='price_move' THEN 'Reported rolling 24-hour price change; not change since activation or entry.' WHEN r.trigger_type='volume_spike' THEN 'Reported rolling 24-hour volume change.' WHEN r.trigger_type='metadata_notice' THEN 'Presence of a provider listing notice at the daily metadata clock; its wording, cause and severity are not evaluated.' WHEN r.trigger_type='liquidation_cascade' THEN 'Reported liquidation total for the stated window against the same window''s seven-day average of retained captures; it is not a measure of positions at risk.' WHEN r.trigger_type='attention_entry' THEN 'Consecutive hourly captures of the named provider list that contained the asset; attention is not a valuation and the list ordering is not published.' ELSE 'Reported absolute liquidity; not executable depth.' END);
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
END $market$;
REVOKE ALL ON FUNCTION public.intel_record_market_alert(uuid,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_market_alert(uuid,uuid,integer,jsonb) TO service_role;
