-- Owners can acknowledge a private chart alert without permission to alter
-- its original trigger, source checkpoint, author text or recipient.
CREATE OR REPLACE FUNCTION app_private.intel_chart_alert_write_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='intel_alert_rules' THEN
  IF (NEW.trigger_type='chart_price' OR (TG_OP='UPDATE' AND OLD.trigger_type='chart_price'))
   AND current_user NOT IN ('postgres','service_role') THEN
   RAISE EXCEPTION 'chart_alert_use_editor' USING ERRCODE='42501';
  END IF;
 ELSE
  IF TG_OP='UPDATE' AND current_user='authenticated' AND OLD.private_owner_id=auth.uid()
   AND EXISTS(SELECT 1 FROM public.org_members WHERE org_id=OLD.org_id AND user_id=auth.uid())
   AND NEW.read_at IS NOT NULL AND (to_jsonb(NEW)-'read_at')=(to_jsonb(OLD)-'read_at') THEN
   NEW.read_at:=coalesce(OLD.read_at,clock_timestamp());
   RETURN NEW;
  END IF;
  IF (NEW.private_owner_id IS NOT NULL OR (TG_OP='UPDATE' AND OLD.private_owner_id IS NOT NULL)
   OR EXISTS(SELECT 1 FROM public.intel_alert_rules WHERE id=NEW.rule_id AND trigger_type='chart_price'))
   AND current_user NOT IN ('postgres','service_role') THEN
   RAISE EXCEPTION 'chart_alert_server_event_required' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_chart_alert_write_guard() FROM PUBLIC,anon,authenticated;

CREATE POLICY private_alert_owner_acknowledge ON public.intel_alert_events
 FOR UPDATE TO authenticated
 USING(private_owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_events.org_id AND m.user_id=(SELECT auth.uid())))
 WITH CHECK(private_owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_alert_events.org_id AND m.user_id=(SELECT auth.uid())));

CREATE FUNCTION public.intel_mark_chart_alert_read(p_org uuid,p_event uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=auth.uid()) THEN
  RAISE EXCEPTION 'chart_alert_unavailable' USING ERRCODE='42501';
 END IF;
 UPDATE public.intel_alert_events SET read_at=coalesce(read_at,clock_timestamp())
 WHERE id=p_event AND org_id=p_org AND private_owner_id=auth.uid() AND payload->>'trigger_type'='chart_price'
 RETURNING jsonb_build_object('id',id,'readAt',read_at) INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'chart_alert_unavailable' USING ERRCODE='42501';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_mark_chart_alert_read(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_mark_chart_alert_read(uuid,uuid) TO authenticated;
