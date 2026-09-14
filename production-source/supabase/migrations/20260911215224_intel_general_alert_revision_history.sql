-- Reuse the existing alert operation and audit ledgers. No new accounting,
-- provider reads, notification sends, or synthetic historical edits.
CREATE FUNCTION app_private.intel_capture_general_alert_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE before_config jsonb;after_config jsonb;action text;
BEGIN
 IF NEW.trigger_type IN('chart_price','thesis_condition') OR NEW.user_id IS NULL THEN RETURN NEW;END IF;
 after_config:=jsonb_build_object('config',NEW.config,'entity_id',NEW.entity_id,'trigger_type',NEW.trigger_type,'is_active',NEW.is_active,'cooldown_minutes',NEW.cooldown_minutes);
 IF TG_OP='UPDATE' THEN
  before_config:=jsonb_build_object('config',OLD.config,'entity_id',OLD.entity_id,'trigger_type',OLD.trigger_type,'is_active',OLD.is_active,'cooldown_minutes',OLD.cooldown_minutes);
  IF before_config=after_config THEN RETURN NEW;END IF;
 END IF;
 action:=CASE WHEN TG_OP='INSERT' THEN 'created' WHEN OLD.config IS DISTINCT FROM NEW.config OR OLD.entity_id IS DISTINCT FROM NEW.entity_id OR OLD.trigger_type IS DISTINCT FROM NEW.trigger_type OR OLD.cooldown_minutes IS DISTINCT FROM NEW.cooldown_minutes THEN 'edited' WHEN NEW.is_active THEN 'activated' ELSE 'paused' END;
 INSERT INTO public.intel_chart_alert_audit(org_id,user_id,rule_id,revision,action,detail)
 VALUES(NEW.org_id,NEW.user_id,NEW.id,NEW.chart_revision,action,jsonb_build_object('before',before_config,'after',after_config,'actor_id',auth.uid(),'clock_basis','server_recorded','history_origin','captured_action'));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_capture_general_alert_revision() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_capture_general_alert_revision AFTER INSERT OR UPDATE ON public.intel_alert_rules FOR EACH ROW EXECUTE FUNCTION app_private.intel_capture_general_alert_revision();

CREATE FUNCTION app_private.intel_alert_operation_scrub() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN IF NEW.rule_id IS NULL THEN NEW.result:='{"deleted":true}';END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app_private.intel_alert_operation_scrub() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_alert_operation_scrub BEFORE UPDATE ON public.intel_chart_alert_operations FOR EACH ROW EXECUTE FUNCTION app_private.intel_alert_operation_scrub();
UPDATE public.intel_chart_alert_operations SET result='{"deleted":true}' WHERE rule_id IS NULL AND result<>'{"deleted":true}';

CREATE FUNCTION app_private.intel_alert_receipt_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF current_user NOT IN('postgres','service_role') THEN
  IF TG_TABLE_NAME='intel_alert_rules' THEN
   IF NEW.chart_revision IS DISTINCT FROM OLD.chart_revision THEN RAISE EXCEPTION 'alert_revision_is_server_recorded';END IF;
  ELSIF TG_OP='INSERT' OR (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') THEN RAISE EXCEPTION 'alert_receipt_is_server_recorded';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_alert_receipt_guard() FROM PUBLIC,anon,authenticated;
-- Run before the existing revision increment, so ordinary authored edits work.
CREATE TRIGGER aa_intel_alert_revision_guard BEFORE UPDATE ON public.intel_alert_rules FOR EACH ROW EXECUTE FUNCTION app_private.intel_alert_receipt_guard();
CREATE TRIGGER aa_intel_alert_receipt_guard BEFORE INSERT OR UPDATE ON public.intel_alert_events FOR EACH ROW EXECUTE FUNCTION app_private.intel_alert_receipt_guard();

CREATE FUNCTION public.intel_save_general_alert(p_org uuid,p_user uuid,p_id uuid,p_revision integer,p_operation uuid,p_entity uuid,p_trigger text,p_config jsonb,p_active boolean,p_cooldown integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE prior public.intel_chart_alert_operations;r public.intel_alert_rules;field text;number numeric;request jsonb;response jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) OR public.can_access_intel(p_user,p_org) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden';END IF;
 IF p_operation IS NULL OR p_revision IS NULL OR p_revision<0 OR p_active IS NULL OR p_cooldown IS NULL OR p_cooldown NOT BETWEEN 15 AND 10080 OR p_config IS NULL OR jsonb_typeof(p_config)<>'object' OR octet_length(p_config::text)>8000 OR p_trigger IS NULL OR p_trigger NOT IN('price_move','volume_spike','liquidity_drop','wallet_activity','narrative_heat','holder_shift','unlock','supply_shock','metadata_migration') THEN RAISE EXCEPTION 'chart_alert_general_invalid';END IF;
 IF p_trigger='narrative_heat' THEN
  IF p_entity IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.narrative_taxonomy WHERE slug=p_config->>'slug') THEN RAISE EXCEPTION 'chart_alert_general_identity_invalid';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.entities WHERE id=p_entity AND org_id=p_org AND nullif(canonical_ref_key,'') IS NOT NULL) THEN RAISE EXCEPTION 'chart_alert_general_identity_invalid';END IF;
 END IF;
 IF p_config->>'visibility' IS DISTINCT FROM 'private' OR jsonb_typeof(p_config->'title') IS DISTINCT FROM 'string' OR length(p_config->>'title')>120 OR jsonb_typeof(p_config->'note') IS DISTINCT FROM 'string' OR length(p_config->>'note')>2000 THEN RAISE EXCEPTION 'chart_alert_general_text_invalid';END IF;
 field:=CASE p_trigger WHEN 'liquidity_drop' THEN 'min_liquidity_usd' WHEN 'wallet_activity' THEN 'min_usd' WHEN 'narrative_heat' THEN 'momentum_delta' WHEN 'unlock' THEN 'window_days' WHEN 'metadata_migration' THEN NULL ELSE 'threshold_pct' END;
 IF field IS NOT NULL THEN
  IF jsonb_typeof(p_config->field) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'chart_alert_general_threshold_invalid';END IF;
  number:=(p_config->>field)::numeric;
  IF number<0 OR number>1e18 OR number::text IN('NaN','Infinity','-Infinity') OR p_trigger='unlock' AND number>90 OR p_trigger='narrative_heat' AND number>100 THEN RAISE EXCEPTION 'chart_alert_general_threshold_invalid';END IF;
 END IF;
 request:=jsonb_build_object('kind','general_alert_v1','id',p_id,'revision',p_revision,'entity',p_entity,'trigger',p_trigger,'config',p_config,'active',p_active,'cooldown',p_cooldown);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text||':'||p_user::text||':'||p_operation::text,0));
 SELECT * INTO prior FROM public.intel_chart_alert_operations WHERE org_id=p_org AND user_id=p_user AND operation_id=p_operation;
 IF FOUND THEN
  IF prior.rule_id IS NULL THEN RAISE EXCEPTION 'chart_alert_deleted';END IF;
  IF prior.result->'request' IS DISTINCT FROM request THEN RAISE EXCEPTION 'chart_alert_operation_changed';END IF;
  RETURN prior.result->'response';
 END IF;
 IF p_id IS NULL THEN
  IF p_revision<>0 THEN RAISE EXCEPTION 'chart_alert_revision_conflict';END IF;
  INSERT INTO public.intel_alert_rules(org_id,user_id,entity_id,trigger_type,config,is_active,cooldown_minutes) VALUES(p_org,p_user,p_entity,p_trigger,p_config,p_active,p_cooldown) RETURNING * INTO r;
 ELSE
  SELECT * INTO r FROM public.intel_alert_rules WHERE id=p_id AND org_id=p_org AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'chart_alert_not_found';END IF;
  IF r.chart_revision<>p_revision OR r.trigger_type IN('chart_price','thesis_condition') THEN RAISE EXCEPTION 'chart_alert_revision_conflict';END IF;
  UPDATE public.intel_alert_rules SET entity_id=p_entity,trigger_type=p_trigger,config=p_config,is_active=p_active,cooldown_minutes=p_cooldown WHERE id=p_id RETURNING * INTO r;
 END IF;
 response:=jsonb_build_object('rule',to_jsonb(r));
 INSERT INTO public.intel_chart_alert_operations(org_id,user_id,operation_id,rule_id,result) VALUES(p_org,p_user,p_operation,r.id,jsonb_build_object('request',request,'response',response));
 RETURN response;
END $$;
REVOKE ALL ON FUNCTION public.intel_save_general_alert(uuid,uuid,uuid,integer,uuid,uuid,text,jsonb,boolean,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_save_general_alert(uuid,uuid,uuid,integer,uuid,uuid,text,jsonb,boolean,integer) TO service_role;
