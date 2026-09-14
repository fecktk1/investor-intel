-- Immutable asset/time indexes for the existing private chart-condition audit.
-- Authored changes use server time; crossings use the referenced quote time.
ALTER TABLE public.intel_chart_alert_audit ADD COLUMN asset text;
ALTER TABLE public.intel_chart_alert_audit ADD COLUMN occurred_at timestamptz;
UPDATE public.intel_chart_alert_audit SET asset=coalesce(detail->'config'->>'asset',detail->'checkpoint'->>'asset'),
 occurred_at=CASE WHEN action='crossed' THEN coalesce((detail->'checkpoint'->>'observedAt')::timestamptz,recorded_at) ELSE recorded_at END;
CREATE FUNCTION app_private.intel_chart_alert_audit_identity() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 NEW.asset:=coalesce(NEW.detail->'config'->>'asset',NEW.detail->'checkpoint'->>'asset');
 NEW.occurred_at:=CASE WHEN NEW.action='crossed' THEN coalesce((NEW.detail->'checkpoint'->>'observedAt')::timestamptz,NEW.recorded_at) ELSE NEW.recorded_at END;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_chart_alert_audit_identity() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_chart_alert_audit_identity BEFORE INSERT ON public.intel_chart_alert_audit FOR EACH ROW EXECUTE FUNCTION app_private.intel_chart_alert_audit_identity();
CREATE INDEX intel_chart_alert_asset_time ON public.intel_chart_alert_audit(org_id,user_id,asset,occurred_at DESC,id DESC);

CREATE FUNCTION public.intel_chart_alert_history(p_org uuid,p_user uuid,p_assets text[],p_from timestamptz,p_to timestamptz,p_cursor jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE rows jsonb;last_row jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) OR public.can_access_intel(p_user,p_org) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF p_assets IS NULL OR cardinality(p_assets) NOT BETWEEN 1 AND 8 OR EXISTS(SELECT 1 FROM unnest(p_assets) a WHERE a IS NULL OR length(a) NOT BETWEEN 1 AND 240)
  OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to<p_from OR p_to-p_from>interval '366 days'
  OR (p_cursor IS NOT NULL AND (jsonb_typeof(p_cursor)<>'object' OR p_cursor->>'at' IS NULL OR p_cursor->>'id' IS NULL)) THEN RAISE EXCEPTION 'chart_alert_invalid_history';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY occurred_at DESC,id DESC),'[]') INTO rows FROM (
  SELECT a.id,a.rule_id,a.asset,a.action,a.revision,a.occurred_at,a.recorded_at,a.detail,
   CASE WHEN a.action='crossed' THEN event.payload->'config' END AS event_config
  FROM public.intel_chart_alert_audit a LEFT JOIN public.intel_alert_events event ON a.action='crossed' AND event.id=(a.detail->>'eventId')::uuid AND event.rule_id=a.rule_id AND event.org_id=p_org AND event.private_owner_id=p_user
  WHERE a.org_id=p_org AND a.user_id=p_user AND a.asset=ANY(p_assets) AND a.occurred_at BETWEEN p_from AND p_to
   AND (p_cursor IS NULL OR (a.occurred_at,a.id)<((p_cursor->>'at')::timestamptz,(p_cursor->>'id')::uuid))
  ORDER BY a.occurred_at DESC,a.id DESC LIMIT 21
 ) page;
 last_row:=rows->19;
 RETURN jsonb_build_object('rows',CASE WHEN jsonb_array_length(rows)>20 THEN rows-20 ELSE rows END,
  'nextCursor',CASE WHEN jsonb_array_length(rows)>20 THEN jsonb_build_object('at',last_row->>'occurred_at','id',last_row->>'id') END);
END $$;
REVOKE ALL ON FUNCTION public.intel_chart_alert_history(uuid,uuid,text[],timestamptz,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_chart_alert_history(uuid,uuid,text[],timestamptz,timestamptz,jsonb) TO service_role;
