-- Paired manual swaps reuse the existing ledger and accounting. The operation
-- row only controls retries; authorized deletion removes its saved input text.
CREATE TABLE app_private.intel_manual_swap_operations (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 portfolio_id uuid NOT NULL REFERENCES public.investor_portfolios(id) ON DELETE CASCADE,
 request jsonb, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON app_private.intel_manual_swap_operations FROM PUBLIC,anon,authenticated;
CREATE INDEX ipt_manual_group ON public.investor_portfolio_transactions
 (portfolio_id,org_id,user_id,(raw_metadata->>'manual_group_id'))
 WHERE raw_metadata ? 'manual_group_id';

CREATE OR REPLACE FUNCTION public.intel_record_manual_swap(
 p_org_id uuid,p_portfolio_id uuid,p_operation_id uuid,p_effective_at timestamptz,
 p_sent jsonb,p_received jsonb,p_fee_usd numeric DEFAULT NULL,p_notes text DEFAULT NULL,p_source text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
DECLARE
 v_user uuid:=auth.uid();v_source uuid;v_request jsonb;v_previous app_private.intel_manual_swap_operations;
 v_leg jsonb;v_i integer;v_qty double precision;v_price double precision;v_rows jsonb;v_key text;
BEGIN
 IF v_user IS NULL OR p_org_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org_id AND user_id=v_user) THEN
  RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM public.investor_portfolios WHERE id=p_portfolio_id AND org_id=p_org_id AND user_id=v_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 IF p_operation_id IS NULL OR p_effective_at IS NULL OR NOT isfinite(p_effective_at)
  OR jsonb_typeof(p_sent) IS DISTINCT FROM 'object' OR jsonb_typeof(p_received) IS DISTINCT FROM 'object'
  OR octet_length(p_sent::text)+octet_length(p_received::text)>4096
  OR length(coalesce(p_notes,''))>20000 OR length(coalesce(p_source,''))>200
  OR (p_fee_usd IS NOT NULL AND (p_fee_usd<0 OR p_fee_usd>1e20 OR p_fee_usd::text IN ('NaN','Infinity','-Infinity'))) THEN
  RAISE EXCEPTION 'Invalid swap details' USING ERRCODE='22023';
 END IF;
 v_request:=jsonb_build_object('sent',p_sent,'received',p_received,'effectiveAt',p_effective_at,'feeUsd',p_fee_usd,'notes',p_notes,'source',p_source);
 SELECT * INTO v_previous FROM app_private.intel_manual_swap_operations WHERE id=p_operation_id FOR UPDATE;
 IF FOUND THEN
  IF v_previous.user_id<>v_user OR v_previous.org_id<>p_org_id OR v_previous.portfolio_id<>p_portfolio_id THEN
   RAISE EXCEPTION 'Operation unavailable' USING ERRCODE='42501';
  END IF;
  IF v_previous.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'This swap was deleted. Start a new transaction to record another swap.' USING ERRCODE='22023';END IF;
  IF v_previous.request IS DISTINCT FROM v_request THEN RAISE EXCEPTION 'This swap was already saved with different details. Review its activity before recording another transaction.' USING ERRCODE='22023';END IF;
 ELSE
  INSERT INTO app_private.intel_manual_swap_operations(id,org_id,user_id,portfolio_id,request) VALUES(p_operation_id,p_org_id,v_user,p_portfolio_id,v_request);
  SELECT id INTO v_source FROM public.investor_portfolio_sources WHERE org_id=p_org_id AND user_id=v_user AND portfolio_id=p_portfolio_id AND source_type='manual' ORDER BY created_at LIMIT 1;
  IF v_source IS NULL THEN
   INSERT INTO public.investor_portfolio_sources(org_id,user_id,portfolio_id,source_type,provider,label)
   VALUES(p_org_id,v_user,p_portfolio_id,'manual','manual','Manual entries') RETURNING id INTO v_source;
  END IF;
  FOR v_i IN 0..1 LOOP
   v_leg:=CASE WHEN v_i=0 THEN p_sent ELSE p_received END;
   v_qty:=(v_leg->>'quantity')::double precision;v_price:=(v_leg->>'pricePerUnit')::double precision;
   IF v_qty IS NULL OR v_qty<=0 OR v_qty>1e30 OR v_price IS NULL OR v_price<0 OR v_price>1e20
    OR v_qty::text IN ('NaN','Infinity','-Infinity') OR v_price::text IN ('NaN','Infinity','-Infinity')
    OR length(coalesce(v_leg->>'symbol','')) NOT BETWEEN 1 AND 32
    OR length(coalesce(v_leg->>'contractAddress',''))>240
    OR coalesce(v_leg->>'assetKind','') NOT IN ('native','token') THEN RAISE EXCEPTION 'Invalid swap leg' USING ERRCODE='22023';END IF;
   INSERT INTO public.investor_portfolio_transactions(id,org_id,user_id,portfolio_id,source_id,
    transaction_type,original_transaction_type,classification_status,confidence_score,direction,
    asset_symbol,normalized_symbol,chain,contract_address,quantity,price_per_unit,quote_currency,total_value,
    fee_amount,fee_currency,"timestamp",notes,raw_metadata)
   VALUES(CASE WHEN v_i=0 THEN p_operation_id ELSE gen_random_uuid() END,p_org_id,v_user,p_portfolio_id,v_source,
    'swap','swap','confirmed',1,CASE WHEN v_i=0 THEN 'out' ELSE 'in' END,
    upper(trim(v_leg->>'symbol')),upper(trim(v_leg->>'symbol')),v_leg->>'chain',nullif(v_leg->>'contractAddress',''),v_qty,v_price,'USD',v_qty*v_price,
    CASE WHEN v_i=0 THEN p_fee_usd ELSE NULL END,'USD',p_effective_at,p_notes,
    jsonb_build_object('manual_group_id',p_operation_id,'manual_operation_id',p_operation_id,'manual_asset_kind',v_leg->>'assetKind','source',p_source,'fee_allocation','sent_leg_only'))
   RETURNING canonical_asset_key INTO v_key;
   IF v_key IS NULL THEN RAISE EXCEPTION 'Swap asset identity unavailable' USING ERRCODE='22023';END IF;
  END LOOP;
  IF (SELECT count(DISTINCT canonical_asset_key) FROM public.investor_portfolio_transactions WHERE org_id=p_org_id AND user_id=v_user AND portfolio_id=p_portfolio_id AND raw_metadata->>'manual_group_id'=p_operation_id::text)<>2 THEN
   RAISE EXCEPTION 'A swap must contain two distinct assets. Record a transfer for the same asset.' USING ERRCODE='22023';
  END IF;
 END IF;
 SELECT jsonb_agg(to_jsonb(t) ORDER BY direction DESC,id) INTO v_rows FROM public.investor_portfolio_transactions t
 WHERE org_id=p_org_id AND user_id=v_user AND portfolio_id=p_portfolio_id AND raw_metadata->>'manual_group_id'=p_operation_id::text;
 IF jsonb_array_length(coalesce(v_rows,'[]'::jsonb))<>2 THEN RAISE EXCEPTION 'Swap activity is incomplete' USING ERRCODE='22023';END IF;
 RETURN jsonb_build_object('id',p_operation_id,'rows',v_rows);
END;
$function$;
REVOKE ALL ON FUNCTION public.intel_record_manual_swap(uuid,uuid,uuid,timestamptz,jsonb,jsonb,numeric,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_record_manual_swap(uuid,uuid,uuid,timestamptz,jsonb,jsonb,numeric,text,text) TO authenticated;

-- Deleting either leg through an existing authorized control removes the whole
-- pair transactionally. The tombstone cannot retain private notes or resurrect them.
CREATE OR REPLACE FUNCTION app_private.intel_manual_swap_deleted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
DECLARE v_id uuid;
BEGIN
 IF coalesce(OLD.raw_metadata->>'manual_group_id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN OLD;END IF;
 SELECT id INTO v_id FROM app_private.intel_manual_swap_operations
 WHERE id=(OLD.raw_metadata->>'manual_group_id')::uuid AND user_id=OLD.user_id AND org_id=OLD.org_id AND portfolio_id=OLD.portfolio_id AND deleted_at IS NULL FOR UPDATE;
 IF v_id IS NOT NULL THEN
  UPDATE app_private.intel_manual_swap_operations SET request=NULL,deleted_at=now() WHERE id=v_id;
  DELETE FROM public.investor_portfolio_transactions WHERE portfolio_id=OLD.portfolio_id AND org_id=OLD.org_id AND user_id=OLD.user_id AND raw_metadata->>'manual_group_id'=v_id::text AND id<>OLD.id;
 END IF;
 RETURN OLD;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.intel_manual_swap_deleted() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_manual_swap_deleted AFTER DELETE ON public.investor_portfolio_transactions
 FOR EACH ROW EXECUTE FUNCTION app_private.intel_manual_swap_deleted();

CREATE OR REPLACE FUNCTION public.intel_asset_portfolio_context(p_org_id uuid, p_portfolio_id uuid, p_asset_key text, p_from timestamp with time zone, p_to timestamp with time zone, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 500));
  v_holding jsonb;
  v_events jsonb;
  v_cursor jsonb;
  v_undated boolean;
BEGIN
  IF auth.uid() IS NULL OR p_org_id IS NULL OR p_org_id NOT IN (SELECT public.intel_portfolio_org_ids())
    OR NOT EXISTS (SELECT 1 FROM public.investor_portfolios p
      WHERE p.id = p_portfolio_id AND p.org_id = p_org_id AND p.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_asset_key IS NULL OR length(p_asset_key) NOT BETWEEN 3 AND 256
    OR p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'Invalid asset or chart range' USING ERRCODE = '22023';
  END IF;
  IF p_cursor IS NOT NULL AND (p_cursor->>'timestamp' IS NULL OR p_cursor->>'key' IS NULL) THEN
    RAISE EXCEPTION 'Invalid chart cursor' USING ERRCODE = '22023';
  END IF;

  SELECT to_jsonb(h) INTO v_holding FROM public.investor_portfolio_holdings h
    WHERE h.portfolio_id = p_portfolio_id AND h.canonical_asset_key = p_asset_key
      AND h.org_id = p_org_id AND h.user_id = auth.uid();

  WITH owned_sources AS MATERIALIZED (
    SELECT id, source_type, provider, label FROM public.investor_portfolio_sources
    WHERE portfolio_id = p_portfolio_id AND org_id = p_org_id AND user_id = auth.uid()
  ), grouped AS (
    SELECT 'grouped:' || g.id::text AS event_key, g.block_time AS happened_at,
      jsonb_build_object('id', g.id, 'kind', 'grouped', 'chain', g.chain,
        'txRef', coalesce(g.tx_hash, g.signature), 'timestamp', g.block_time, 'createdAt',g.created_at,'recordedAt',greatest(g.created_at,g.updated_at),
        'type', g.type, 'title', g.title, 'summary', g.summary, 'notes', g.notes,
        'status', g.status, 'classification_status', g.classification_status,
        'confidence', g.confidence, 'protocol', g.protocol, 'counterparty', g.counterparty,
        'sourceId', s.id, 'sourceLabel', s.label, 'provider', s.provider,
        'feeAsset', g.fee_asset, 'feeAmount', g.fee_amount, 'feeUsd', g.fee_usd,
        'feeMatchesAsset', g.fee_asset IS NOT NULL AND g.fee_amount > 0 AND public.canonical_asset_key(g.chain, g.fee_asset, NULL) = p_asset_key,
        'lineItems', coalesce(legs.items, '[]'::jsonb), 'lineItemCount', coalesce(legs.total_count, 0),
        'lineItemsTruncated', coalesce(legs.total_count, 0) > 64) AS event
    FROM public.investor_portfolio_tx g JOIN owned_sources s ON s.id = g.source_id AND s.source_type <> 'manual'
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id', l.id, 'canonical_asset_key', l.canonical_asset_key,
        'chain', l.chain, 'symbol', l.symbol, 'name', l.name, 'direction', l.direction,
        'amount', l.amount, 'price_usd_at_tx', l.price_usd_at_tx,
        'value_usd_at_tx', l.value_usd_at_tx, 'price_source_at_tx', l.price_source_at_tx)
        ORDER BY l.leg_index, l.id) AS items, max(l.total_count) AS total_count
      FROM (SELECT li.*, count(*) OVER () AS total_count
        FROM public.investor_portfolio_tx_line_items li WHERE li.tx_id = g.id
          AND li.portfolio_id = p_portfolio_id AND li.org_id = p_org_id AND li.user_id = auth.uid()
        ORDER BY (li.canonical_asset_key = p_asset_key) DESC, li.leg_index, li.id LIMIT 64) l
    ) legs ON true
    WHERE g.portfolio_id = p_portfolio_id AND g.org_id = p_org_id AND g.user_id = auth.uid()
      AND g.is_display_mirror = false AND g.block_time BETWEEN p_from AND p_to
      AND (EXISTS (SELECT 1 FROM public.investor_portfolio_tx_line_items match_leg WHERE match_leg.tx_id = g.id
        AND match_leg.portfolio_id = p_portfolio_id AND match_leg.org_id = p_org_id AND match_leg.user_id = auth.uid() AND match_leg.canonical_asset_key = p_asset_key)
        OR (g.fee_asset IS NOT NULL AND g.fee_amount > 0 AND public.canonical_asset_key(g.chain, g.fee_asset, NULL) = p_asset_key))
      AND (p_cursor IS NULL OR (g.block_time, 'grouped:' || g.id::text) < ((p_cursor->>'timestamp')::timestamptz, p_cursor->>'key'))
    ORDER BY g.block_time DESC, g.id DESC LIMIT v_limit + 1
  ), manual AS (
    SELECT 'manual:' || m.id::text AS event_key, m."timestamp" AS happened_at,
      jsonb_build_object('id', m.id, 'kind', 'manual', 'chain', m.chain,
        'txRef', coalesce(m.external_tx_hash, m.external_tx_signature), 'timestamp', m."timestamp",'createdAt',m.created_at,'recordedAt',greatest(m.created_at,m.updated_at),
        'type', m.transaction_type, 'notes', m.notes, 'status', 'success', 'manualGroupId',m.raw_metadata->>'manual_group_id',
        'classification_status', m.classification_status, 'confidence', m.confidence_score,
        'sourceId', s.id, 'sourceLabel', s.label, 'provider', s.provider,
        'feeAsset', CASE WHEN m.raw_metadata ? 'manual_group_id' THEN 'USD' ELSE m.fee_currency END,
        'feeAmount', CASE WHEN m.raw_metadata ? 'manual_group_id' THEN (
          SELECT sum(g.fee_amount) FROM public.investor_portfolio_transactions g WHERE g.org_id=p_org_id AND g.user_id=auth.uid() AND g.portfolio_id=p_portfolio_id AND g.raw_metadata->>'manual_group_id'=m.raw_metadata->>'manual_group_id') ELSE m.fee_amount END,
        'feeUsd', CASE WHEN m.raw_metadata ? 'manual_group_id' THEN (
          SELECT sum(g.fee_amount) FROM public.investor_portfolio_transactions g WHERE g.org_id=p_org_id AND g.user_id=auth.uid() AND g.portfolio_id=p_portfolio_id AND g.raw_metadata->>'manual_group_id'=m.raw_metadata->>'manual_group_id') WHEN upper(m.fee_currency)='USD' THEN m.fee_amount END,
        'feeMatchesAsset',false,
        'lineItems',(SELECT jsonb_agg(jsonb_build_object('id',leg.id,'canonical_asset_key',leg.canonical_asset_key,
          'chain',leg.chain,'symbol',leg.asset_symbol,'direction',leg.direction,'amount',leg.quantity,
          'price_usd_at_tx',CASE WHEN upper(leg.quote_currency)='USD' THEN leg.price_per_unit END,
          'value_usd_at_tx',CASE WHEN upper(leg.quote_currency)='USD' THEN leg.total_value END,
          'price_source_at_tx','manual','quote_currency',leg.quote_currency,'recorded_price',leg.price_per_unit,'recorded_value',leg.total_value)
          ORDER BY leg.direction DESC,leg.id)
         FROM (SELECT g.* FROM public.investor_portfolio_transactions g WHERE g.org_id=p_org_id AND g.user_id=auth.uid() AND g.portfolio_id=p_portfolio_id
           AND (g.id=m.id OR (m.raw_metadata ? 'manual_group_id' AND g.raw_metadata->>'manual_group_id'=m.raw_metadata->>'manual_group_id')) LIMIT 2)leg)) AS event
    FROM public.investor_portfolio_transactions m JOIN owned_sources s ON s.id = m.source_id AND s.source_type = 'manual'
    WHERE m.portfolio_id = p_portfolio_id AND m.org_id = p_org_id AND m.user_id = auth.uid()
      AND m.canonical_asset_key = p_asset_key AND m."timestamp" BETWEEN p_from AND p_to
      AND (p_cursor IS NULL OR (m."timestamp", 'manual:' || m.id::text) < ((p_cursor->>'timestamp')::timestamptz, p_cursor->>'key'))
    ORDER BY m."timestamp" DESC, m.id DESC LIMIT v_limit + 1
  ), combined AS (
    SELECT * FROM grouped UNION ALL SELECT * FROM manual
  ), page AS MATERIALIZED (
    SELECT * FROM combined ORDER BY happened_at DESC, event_key DESC LIMIT v_limit + 1
  ), visible AS MATERIALIZED (
    SELECT * FROM page ORDER BY happened_at DESC, event_key DESC LIMIT v_limit
  ) SELECT
      coalesce((SELECT jsonb_agg(event || jsonb_build_object('eventKey', event_key) ORDER BY happened_at DESC, event_key DESC) FROM visible), '[]'::jsonb),
      CASE WHEN (SELECT count(*) FROM page) > v_limit THEN
        (SELECT jsonb_build_object('timestamp', happened_at, 'key', event_key) FROM visible ORDER BY happened_at ASC, event_key ASC LIMIT 1) END
    INTO v_events, v_cursor;

  SELECT EXISTS (
    SELECT 1 FROM public.investor_portfolio_transactions m JOIN public.investor_portfolio_sources s ON s.id = m.source_id
      WHERE m.portfolio_id = p_portfolio_id AND m.org_id = p_org_id AND m.user_id = auth.uid()
        AND s.source_type = 'manual' AND s.user_id = auth.uid() AND s.org_id = p_org_id
        AND m.canonical_asset_key = p_asset_key AND m."timestamp" IS NULL
    UNION ALL
    SELECT 1 FROM public.investor_portfolio_tx g JOIN public.investor_portfolio_sources s ON s.id = g.source_id
      WHERE g.portfolio_id = p_portfolio_id AND g.org_id = p_org_id AND g.user_id = auth.uid()
        AND s.source_type <> 'manual' AND s.user_id = auth.uid() AND s.org_id = p_org_id
        AND NOT g.is_display_mirror AND g.block_time IS NULL
        AND ((g.fee_asset IS NOT NULL AND g.fee_amount > 0 AND public.canonical_asset_key(g.chain, g.fee_asset, NULL) = p_asset_key)
          OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx_line_items l WHERE l.tx_id = g.id
            AND l.portfolio_id = p_portfolio_id AND l.org_id = p_org_id AND l.user_id = auth.uid() AND l.canonical_asset_key = p_asset_key))
  ) INTO v_undated;
  RETURN jsonb_build_object('holding', v_holding, 'events', v_events, 'nextCursor', v_cursor,
    'coverage', jsonb_build_object('from', p_from, 'to', p_to, 'hasUndatedActivity', v_undated,
      'hasMore', v_cursor IS NOT NULL, 'historyStatus', coalesce(v_holding->>'reconciliation_status', 'unknown')));
END;
$function$;
