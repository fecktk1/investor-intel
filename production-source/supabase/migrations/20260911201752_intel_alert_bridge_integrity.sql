-- No provider requests, schedule changes or external sends. Extend existing ledgers.
ALTER TABLE public.intel_alert_rules ADD COLUMN evaluation_state jsonb NOT NULL DEFAULT '{}';
CREATE FUNCTION public.intel_alert_unlock_candidates(p_asset_keys text[],p_now timestamptz,p_window_days numeric)
RETURNS SETOF public.intel_calendar_versions LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF p_asset_keys IS NULL OR cardinality(p_asset_keys) NOT BETWEEN 1 AND 8 OR p_now IS NULL OR p_now>now()+interval '30 seconds' OR p_window_days IS NULL OR p_window_days NOT BETWEEN 0 AND 90 THEN RAISE EXCEPTION 'invalid_unlock_query';END IF;
 RETURN QUERY WITH candidates AS MATERIALIZED (
  SELECT DISTINCT source_id FROM public.intel_calendar_versions WHERE source_kind='unlock' AND asset_keys && p_asset_keys AND recorded_at<=p_now
 ), latest AS (
  SELECT v.* FROM candidates c CROSS JOIN LATERAL(SELECT * FROM public.intel_calendar_versions v WHERE v.source_kind='unlock' AND v.source_id=c.source_id AND v.recorded_at<=p_now ORDER BY v.recorded_at DESC,v.version DESC LIMIT 1)v
 ) SELECT * FROM latest WHERE asset_keys && p_asset_keys AND event_status='scheduled' AND expires_at>p_now
  AND (scheduled_at BETWEEN p_now AND p_now+p_window_days*interval '1 day' OR (time_precision='date' AND event_date BETWEEN (p_now AT TIME ZONE 'UTC')::date AND ((p_now+p_window_days*interval '1 day') AT TIME ZONE 'UTC')::date))
 ORDER BY coalesce(scheduled_at,event_date::timestamp AT TIME ZONE 'UTC'),source_id LIMIT 101;
END $$;
REVOKE ALL ON FUNCTION public.intel_alert_unlock_candidates(text[],timestamptz,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_alert_unlock_candidates(text[],timestamptz,numeric) TO service_role;

-- Config/activation changes invalidate an in-flight evaluation. Preserve chart's existing editor.
CREATE FUNCTION app_private.intel_bridge_rule_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF current_user NOT IN('postgres','service_role') AND NEW.evaluation_state IS DISTINCT FROM OLD.evaluation_state THEN RAISE EXCEPTION 'evaluation_is_server_recorded' USING ERRCODE='42501';END IF;
 IF OLD.trigger_type<>'chart_price' AND (NEW.config IS DISTINCT FROM OLD.config OR NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type OR NEW.entity_id IS DISTINCT FROM OLD.entity_id OR NEW.cooldown_minutes IS DISTINCT FROM OLD.cooldown_minutes) THEN NEW.chart_revision:=OLD.chart_revision+1;NEW.evaluation_state:='{}';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_bridge_rule_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_bridge_rule_guard BEFORE UPDATE ON public.intel_alert_rules FOR EACH ROW EXECUTE FUNCTION app_private.intel_bridge_rule_guard();

CREATE FUNCTION public.intel_record_alert_evaluation(p_rule uuid,p_org uuid,p_revision integer,p_state jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE affected integer;
BEGIN
 IF p_state IS NULL OR jsonb_typeof(p_state)<>'object' OR octet_length(p_state::text)>4000 THEN RAISE EXCEPTION 'invalid_evaluation_state';END IF;
 UPDATE public.intel_alert_rules SET evaluation_state=p_state||jsonb_build_object('checkedAt',clock_timestamp(),'revision',p_revision),last_evaluation_attempt_at=clock_timestamp()
 WHERE id=p_rule AND org_id=p_org AND chart_revision=p_revision;
 GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION public.intel_record_alert_evaluation(uuid,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_alert_evaluation(uuid,uuid,integer,jsonb) TO service_role;

CREATE FUNCTION public.intel_emit_bridged_alert(p_rule uuid,p_org uuid,p_revision integer,p_source_system text,p_source_table text,p_source_ref text,p_metric text,p_value numeric,p_payload jsonb)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.intel_alert_rules;e uuid;key text;latest public.intel_calendar_versions;last_fire timestamptz;private_owner uuid;
BEGIN
 IF p_revision IS NULL OR p_source_ref IS NULL OR length(p_source_ref) NOT BETWEEN 1 AND 300 OR p_source_table IS NULL OR length(p_source_table)>100 OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>16000 THEN RAISE EXCEPTION 'invalid_alert_candidate';END IF;
 SELECT * INTO r FROM public.intel_alert_rules WHERE id=p_rule AND org_id=p_org FOR UPDATE;
 IF NOT FOUND OR NOT r.is_active OR r.chart_revision<>p_revision THEN RETURN 'changed';END IF;
 IF r.trigger_type NOT IN('wallet_activity','holder_shift','unlock','supply_shock','metadata_migration') THEN RAISE EXCEPTION 'invalid_bridge_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=r.org_id AND user_id=r.user_id) OR public.can_access_intel(r.user_id,r.org_id) IS NOT TRUE THEN RETURN 'access_unavailable';END IF;
 IF r.trigger_type='unlock' THEN
  SELECT * INTO latest FROM public.intel_calendar_versions WHERE source_kind='unlock' AND source_id=(p_payload->>'calendar_event_id')::uuid ORDER BY recorded_at DESC,version DESC LIMIT 1;
  IF NOT FOUND OR latest.id::text IS DISTINCT FROM p_payload->>'calendar_version' OR latest.event_status<>'scheduled' OR latest.expires_at IS NULL OR latest.expires_at<=clock_timestamp() THEN RETURN 'changed';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.alert_event_unification_map WHERE rule_id=r.id AND source_table=p_source_table AND source_ref=p_source_ref AND intel_alert_event_id IS NOT NULL) THEN RETURN 'duplicate';END IF;
 SELECT max(fired_at) INTO last_fire FROM public.intel_alert_events WHERE rule_id=r.id;
 IF last_fire>clock_timestamp()-make_interval(mins=>coalesce(r.cooldown_minutes,720)) THEN RETURN 'cooldown';END IF;
 key:=p_source_table||':'||p_source_ref||':revision:'||r.chart_revision;
 private_owner:=CASE WHEN r.trigger_type='wallet_activity' THEN r.user_id ELSE NULL END;
 INSERT INTO public.intel_alert_events(org_id,rule_id,private_owner_id,dedup_key,payload) VALUES(r.org_id,r.id,private_owner,key,
  p_payload||jsonb_build_object('trigger_type',r.trigger_type,'metric',p_metric,'value',p_value,'source_system',p_source_system,'source_table',p_source_table,'source_ref',p_source_ref,'rule_revision',r.chart_revision,'config',r.config,'evaluated_at',clock_timestamp(),'delivery','in_app'))
 ON CONFLICT(rule_id,dedup_key) DO NOTHING RETURNING id INTO e;
 IF e IS NULL THEN RETURN 'duplicate';END IF;
 INSERT INTO public.alert_event_unification_map(rule_id,org_id,source_system,source_table,source_ref,dedup_key,intel_alert_event_id)
 VALUES(r.id,r.org_id,p_source_system,p_source_table,p_source_ref,key,e)
 ON CONFLICT(rule_id,source_table,source_ref) DO UPDATE SET intel_alert_event_id=excluded.intel_alert_event_id,dedup_key=excluded.dedup_key WHERE alert_event_unification_map.intel_alert_event_id IS NULL;
 RETURN 'fired';
END $$;
REVOKE ALL ON FUNCTION public.intel_emit_bridged_alert(uuid,uuid,integer,text,text,text,text,numeric,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_emit_bridged_alert(uuid,uuid,integer,text,text,text,text,numeric,jsonb) TO service_role;
