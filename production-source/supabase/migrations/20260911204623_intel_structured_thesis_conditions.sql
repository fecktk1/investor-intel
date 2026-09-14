ALTER TABLE public.intel_thesis_rules ADD COLUMN evaluation_state jsonb NOT NULL DEFAULT '{}';
CREATE FUNCTION app_private.intel_thesis_condition_config(p_rule jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_object_agg(key,value) FROM jsonb_each(p_rule) WHERE key IN ('id','thesis_id','rule_kind','description','metric','comparator','threshold','threshold_unit','time_window','source_metric')
$$;
REVOKE ALL ON FUNCTION app_private.intel_thesis_condition_config(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_private.intel_thesis_condition_config(jsonb) TO service_role;
CREATE FUNCTION public.intel_accept_thesis_condition(p_org uuid,p_user uuid,p_rule uuid,p_expected jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r intel_thesis_rules;t intel_theses;a intel_alert_rules;c jsonb;BEGIN
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=p_org AND user_id=p_user) OR NOT can_access_intel(p_user,p_org) THEN RAISE EXCEPTION 'forbidden';END IF;
 SELECT * INTO r FROM intel_thesis_rules WHERE id=p_rule AND org_id=p_org AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'thesis_condition_not_found';END IF;
 SELECT * INTO t FROM intel_theses WHERE id=r.thesis_id AND org_id=p_org AND user_id=p_user;
 IF NOT FOUND OR t.subject_canonical_key IS NULL THEN RAISE EXCEPTION 'thesis_condition_identity_required';END IF;
 c:=app_private.intel_thesis_condition_config(to_jsonb(r));
 IF c IS DISTINCT FROM app_private.intel_thesis_condition_config(p_expected) THEN RAISE EXCEPTION 'thesis_condition_changed';END IF;
 IF r.comparator NOT IN ('>','>=','<','<=','=','!=','gt','gte','lt','lte','eq','neq') OR r.comparator IS NULL OR r.threshold IS NULL OR r.threshold::text IN ('NaN','Infinity','-Infinity') OR abs(r.threshold)>1e18
 OR nullif(btrim(r.metric),'') IS NULL OR nullif(btrim(r.threshold_unit),'') IS NULL OR nullif(btrim(r.time_window),'') IS NULL THEN RAISE EXCEPTION 'thesis_condition_explicit_unit_period_required';END IF;
 IF r.alert_rule_id IS NOT NULL THEN
  SELECT * INTO a FROM intel_alert_rules WHERE id=r.alert_rule_id AND org_id=p_org AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'thesis_condition_alert_unavailable';END IF;
  IF a.trigger_type='thesis_condition' AND a.is_active AND a.config->'condition'=c AND r.status='active' THEN RETURN jsonb_build_object('alert_rule',to_jsonb(a));END IF;
  UPDATE intel_alert_rules SET trigger_type='thesis_condition',config=jsonb_build_object('thesis_id',t.id,'thesis_rule_id',r.id,'asset',t.subject_canonical_key,'condition',c,'title',r.description,'delivery','in_app','repeat','once'),is_active=true WHERE id=a.id RETURNING * INTO a;
 ELSE
  INSERT INTO intel_alert_rules(org_id,user_id,entity_id,trigger_type,config,is_active,cooldown_minutes) VALUES(p_org,p_user,t.entity_id,'thesis_condition',jsonb_build_object('thesis_id',t.id,'thesis_rule_id',r.id,'asset',t.subject_canonical_key,'condition',c,'title',r.description,'delivery','in_app','repeat','once'),true,15) RETURNING * INTO a;
 END IF;
 UPDATE intel_thesis_rules SET alert_rule_id=a.id,status='active',evaluation_state='{}' WHERE id=r.id;
 RETURN jsonb_build_object('alert_rule',to_jsonb(a));
END $$;
REVOKE ALL ON FUNCTION public.intel_accept_thesis_condition(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_accept_thesis_condition(uuid,uuid,uuid,jsonb) TO service_role;

CREATE FUNCTION public.intel_record_thesis_condition(p_org uuid,p_user uuid,p_rule uuid,p_expected jsonb,p_met boolean,p_evidence_version text,p_observation jsonb,p_reason text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r intel_thesis_rules;t intel_theses;a intel_alert_rules;c jsonb;event uuid;receipt jsonb;BEGIN
 IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=p_org AND user_id=p_user) OR NOT can_access_intel(p_user,p_org) THEN RAISE EXCEPTION 'forbidden';END IF;
 IF p_evidence_version IS NULL OR length(p_evidence_version)>128 OR length(coalesce(p_reason,''))>500 OR octet_length(coalesce(p_observation,'{}')::text)>8000 THEN RAISE EXCEPTION 'invalid_condition_evidence';END IF;
 SELECT * INTO r FROM intel_thesis_rules WHERE id=p_rule AND org_id=p_org AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'thesis_condition_not_found';END IF;
 SELECT * INTO t FROM intel_theses WHERE id=r.thesis_id AND org_id=p_org AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'thesis_condition_not_found';END IF;
 c:=app_private.intel_thesis_condition_config(to_jsonb(r));
 IF c IS DISTINCT FROM app_private.intel_thesis_condition_config(p_expected) THEN RAISE EXCEPTION 'thesis_condition_changed';END IF;
 SELECT * INTO a FROM intel_alert_rules WHERE id=r.alert_rule_id AND org_id=p_org AND user_id=p_user FOR UPDATE;
 IF NOT FOUND OR a.trigger_type<>'thesis_condition' OR a.config->'condition' IS DISTINCT FROM c OR a.config->>'asset' IS DISTINCT FROM t.subject_canonical_key OR NOT a.is_active OR r.status<>'active' THEN RETURN jsonb_build_object('state','paused_or_changed');END IF;
 -- Only source references and decision metadata persist, never unlicensed raw price history.
 receipt:=jsonb_build_object('evidence_version',p_evidence_version,'condition',c,'observation',p_observation-'value','checkedAt',now(),'met',p_met,'reason',p_reason);
 IF p_met IS TRUE THEN
  IF nullif(p_observation->>'id','') IS NULL OR nullif(p_observation->>'sourceRef','') IS NULL OR (p_observation->>'observedAt')::timestamptz>now() OR (p_observation->>'recordedAt')::timestamptz>now() OR (p_observation->>'observedAt') IS NULL OR (p_observation->>'recordedAt') IS NULL THEN RAISE EXCEPTION 'invalid_condition_observation';END IF;
  INSERT INTO intel_alert_events(org_id,rule_id,private_owner_id,dedup_key,payload)
  VALUES(p_org,a.id,p_user,'thesis:'||r.id||':'||a.chart_revision,jsonb_build_object('trigger_type','thesis_condition','title',r.description,'thesis_id',t.id,'thesis_rule_id',r.id,'rule_revision',a.chart_revision,'config',a.config,'checkpoint',receipt,'why_now','A fresh observation met the explicitly recorded thesis condition. Review the original evidence before changing your conclusion.'))
  ON CONFLICT(rule_id,dedup_key) DO NOTHING RETURNING id INTO event;
  IF event IS NULL THEN RETURN jsonb_build_object('state','duplicate');END IF;
  UPDATE intel_thesis_rules SET status='triggered',triggered_at=now(),triggered_event_id=event,evaluation_state=receipt||jsonb_build_object('status','condition_met') WHERE id=r.id;
  UPDATE intel_alert_rules SET is_active=false,evaluation_state=receipt||jsonb_build_object('status','condition_met') WHERE id=a.id;
  UPDATE intel_theses SET needs_user_review=true WHERE id=t.id;
 ELSE
  UPDATE intel_thesis_rules SET evaluation_state=receipt||jsonb_build_object('status',CASE WHEN p_met IS NULL THEN 'evidence_unavailable' ELSE 'condition_not_met' END) WHERE id=r.id;
 END IF;
 RETURN jsonb_build_object('state',CASE WHEN p_met IS TRUE THEN 'triggered' WHEN p_met IS NULL THEN 'evidence_unavailable' ELSE 'condition_not_met' END,'eventId',event);
END $$;
REVOKE ALL ON FUNCTION public.intel_record_thesis_condition(uuid,uuid,uuid,jsonb,boolean,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_thesis_condition(uuid,uuid,uuid,jsonb,boolean,text,jsonb,text) TO service_role;

CREATE FUNCTION app_private.intel_thesis_condition_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM public.intel_alert_rules WHERE id=OLD.alert_rule_id AND org_id=OLD.org_id AND user_id=OLD.user_id AND trigger_type='thesis_condition' AND config->>'thesis_rule_id'=OLD.id::text;
  RETURN OLD;
 END IF;
 IF auth.uid() IS NOT NULL AND (TG_OP='INSERT' AND NEW.evaluation_state<>'{}' OR TG_OP='UPDATE' AND NEW.evaluation_state IS DISTINCT FROM OLD.evaluation_state) THEN RAISE EXCEPTION 'condition_evaluation_is_server_recorded';END IF;
 IF TG_OP='UPDATE' AND app_private.intel_thesis_condition_config(to_jsonb(NEW)) IS DISTINCT FROM app_private.intel_thesis_condition_config(to_jsonb(OLD)) THEN
  NEW.evaluation_state:='{}';
  UPDATE public.intel_alert_rules SET is_active=false WHERE id=OLD.alert_rule_id AND org_id=OLD.org_id AND user_id=OLD.user_id AND trigger_type='thesis_condition';
  IF NEW.status='active' THEN NEW.status:='proposed';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_thesis_condition_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_thesis_condition_guard BEFORE INSERT OR UPDATE ON public.intel_thesis_rules FOR EACH ROW EXECUTE FUNCTION app_private.intel_thesis_condition_guard();
CREATE TRIGGER intel_thesis_condition_cleanup AFTER DELETE ON public.intel_thesis_rules FOR EACH ROW EXECUTE FUNCTION app_private.intel_thesis_condition_guard();

DO $$ DECLARE original text;changed text;BEGIN
 original:=pg_get_functiondef('app_private.intel_capture_thesis_activity()'::regprocedure);
 changed:=replace(original,'kind := CASE WHEN j->>''rule_kind'' = ''invalidation'' THEN ''rule_invalidated'' ELSE ''rule_confirmed'' END;','kind := CASE WHEN j->>''rule_kind'' = ''invalidation'' THEN ''rule_invalidated'' ELSE ''rule_confirmed'' END; IF j->''evaluation_state''->>''evidence_version'' IS NOT NULL THEN delta:=delta||jsonb_build_object(''condition_receipt'',jsonb_build_object(''before'',NULL,''after'',j->''evaluation_state'')); END IF;');
 IF changed=original THEN RAISE EXCEPTION 'unexpected_thesis_activity_capture';END IF;EXECUTE changed;
END $$;
