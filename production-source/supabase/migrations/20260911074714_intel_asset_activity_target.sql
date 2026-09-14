-- Resolve an exact ledger event without downloading intervening history pages.
-- Reuse the existing canonical, source, mirror, fee and leg projection.
CREATE OR REPLACE FUNCTION public.intel_asset_portfolio_event(
 p_org_id uuid,p_portfolio_id uuid,p_asset_key text,p_event_key text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $function$
DECLARE v_id uuid;v_at timestamptz;v_key text;v_page jsonb;v_event jsonb;
BEGIN
 IF auth.uid() IS NULL OR p_org_id IS NULL OR p_org_id NOT IN (SELECT public.intel_portfolio_org_ids())
  OR NOT EXISTS(SELECT 1 FROM public.investor_portfolios WHERE id=p_portfolio_id AND org_id=p_org_id AND user_id=auth.uid()) THEN
  RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';
 END IF;
 IF p_asset_key IS NULL OR length(p_asset_key) NOT BETWEEN 3 AND 256
  OR p_event_key IS NULL OR p_event_key !~ '^(manual|grouped|pair):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RAISE EXCEPTION 'Invalid activity reference' USING ERRCODE='22023';
 END IF;
 v_id:=split_part(p_event_key,':',2)::uuid;
 IF p_event_key LIKE 'grouped:%' THEN
  SELECT block_time,'grouped:'||id::text INTO v_at,v_key FROM public.investor_portfolio_tx
   WHERE id=v_id AND portfolio_id=p_portfolio_id AND org_id=p_org_id AND user_id=auth.uid() AND NOT is_display_mirror;
 ELSE
  SELECT m."timestamp",'manual:'||m.id::text INTO v_at,v_key FROM public.investor_portfolio_transactions m
   WHERE m.portfolio_id=p_portfolio_id AND m.org_id=p_org_id AND m.user_id=auth.uid() AND m.canonical_asset_key=p_asset_key
    AND ((p_event_key LIKE 'manual:%' AND m.id=v_id)
      OR (p_event_key LIKE 'pair:%' AND m.raw_metadata ? 'manual_group_id' AND m.raw_metadata->>'manual_group_id'=v_id::text))
   ORDER BY m.id DESC LIMIT 1;
 END IF;
 IF v_at IS NULL OR NOT isfinite(v_at) THEN RETURN jsonb_build_object('event',NULL);END IF;
 -- A server-derived exclusive upper key includes exactly the target UUID.
 -- No other UUID can extend this fixed-length event key. Checking the result
 -- prevents a wrong asset/source from resolving to a neighboring event.
 v_page:=public.intel_asset_portfolio_context(p_org_id,p_portfolio_id,p_asset_key,v_at,v_at,
   jsonb_build_object('timestamp',v_at,'key',v_key||'~'),1);
 v_event:=v_page->'events'->0;
 IF v_event->>'eventKey' IS DISTINCT FROM v_key THEN v_event:=NULL;END IF;
 RETURN jsonb_build_object('event',v_event);
END;
$function$;
REVOKE ALL ON FUNCTION public.intel_asset_portfolio_event(uuid,uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_asset_portfolio_event(uuid,uuid,text,text) TO authenticated;
