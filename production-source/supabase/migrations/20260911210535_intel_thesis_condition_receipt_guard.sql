-- Pausing a one-shot condition after a canonical firing is part of that
-- evaluation, not a user edit that erases the evaluation or changes its version.
CREATE OR REPLACE FUNCTION app_private.intel_bridge_rule_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF current_user NOT IN('postgres','service_role') AND NEW.evaluation_state IS DISTINCT FROM OLD.evaluation_state THEN RAISE EXCEPTION 'evaluation_is_server_recorded' USING ERRCODE='42501';END IF;
 IF current_user IN('postgres','service_role') AND OLD.trigger_type='thesis_condition' AND NEW.trigger_type=OLD.trigger_type
 AND OLD.is_active AND NOT NEW.is_active AND NEW.evaluation_state->>'status'='condition_met'
 AND NEW.config IS NOT DISTINCT FROM OLD.config AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id
 AND NEW.cooldown_minutes IS NOT DISTINCT FROM OLD.cooldown_minutes THEN RETURN NEW;END IF;
 IF OLD.trigger_type<>'chart_price' AND (NEW.config IS DISTINCT FROM OLD.config OR NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type OR NEW.entity_id IS DISTINCT FROM OLD.entity_id OR NEW.cooldown_minutes IS DISTINCT FROM OLD.cooldown_minutes) THEN NEW.chart_revision:=OLD.chart_revision+1;NEW.evaluation_state:='{}';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_bridge_rule_guard() FROM PUBLIC,anon,authenticated;

-- Restore only an existing, owned, immutable firing receipt if the old pause
-- guard cleared its rule summary. No words, prices or past firings are inferred.
UPDATE public.intel_alert_rules a SET evaluation_state=e.payload->'checkpoint'||jsonb_build_object('status','condition_met')
FROM public.intel_thesis_rules r JOIN public.intel_alert_events e ON e.id=r.triggered_event_id
WHERE a.id=r.alert_rule_id AND a.trigger_type='thesis_condition' AND NOT a.is_active AND a.evaluation_state='{}'
 AND r.status='triggered' AND r.org_id=a.org_id AND r.user_id=a.user_id
 AND e.rule_id=a.id AND e.org_id=a.org_id AND e.private_owner_id=a.user_id
 AND e.payload->'checkpoint'->>'evidence_version'=r.evaluation_state->>'evidence_version'
 AND e.payload->'checkpoint'->'condition'=a.config->'condition';
