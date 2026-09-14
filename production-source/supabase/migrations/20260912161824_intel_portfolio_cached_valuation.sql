-- Abort atomically if any reviewed production consumer changed.
DO $guard$ BEGIN
IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='intel_asset_portfolio_context') IS DISTINCT FROM '3b339135400c6e89c11e3d5feeb5d4dd' THEN RAISE EXCEPTION 'Live definition changed: intel_asset_portfolio_context'; END IF;
IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='intel_desk_positions') IS DISTINCT FROM 'f6f8d854351ce46b34a8468959c3c7c7' THEN RAISE EXCEPTION 'Live definition changed: intel_desk_positions'; END IF;
IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='intel_portfolio_overview') IS DISTINCT FROM '7be3337397113c9dc5dfcfcafbc9a7b4' THEN RAISE EXCEPTION 'Live definition changed: intel_portfolio_overview'; END IF;
IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='intel_portfolio_page') IS DISTINCT FROM 'dbca74cf7b6f14d20eb8c872f7b6beb3' THEN RAISE EXCEPTION 'Live definition changed: intel_portfolio_page'; END IF;
IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='intel_portfolio_research_facts') IS DISTINCT FROM '578261ba533272b780516825b44b9380' THEN RAISE EXCEPTION 'Live definition changed: intel_portfolio_research_facts'; END IF;
END;$guard$;
-- Read-only valuation of an authorized book from the shared CMC catalog.
-- The canonical-to-provider association is recorded by the existing verified
-- pricing pipeline. Symbols never participate in this join. No ledger writes,
-- provider requests, balance sync, historical snapshot or research mutations.
CREATE FUNCTION public.intel_portfolio_valued_holdings(p_org_id uuid,p_portfolio_id uuid)
RETURNS SETOF public.investor_portfolio_holdings
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.investor_portfolios p
  WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid()
   AND p.org_id IN(SELECT public.intel_portfolio_org_ids())) THEN
  RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501'; END IF;
 RETURN QUERY
 WITH scoped AS MATERIALIZED (
  SELECT h FROM public.investor_portfolio_holdings h
  WHERE h.portfolio_id=p_portfolio_id AND h.org_id=p_org_id AND h.user_id=auth.uid()
 ), candidates AS MATERIALIZED (
  SELECT s.h,m.current_price AS price,m.change_24h_pct AS change,m.as_of,m.last_refreshed_at,m.market_cap
  FROM scoped s LEFT JOIN public.market_assets m
   ON m.source_provider='coinmarketcap' AND m.provider_id=(s.h).market_context->>'priceProviderId'
   AND (s.h).market_context->>'priceProvider'='coinmarketcap'
   AND (s.h).market_context->>'canonicalAssetKey'=(s.h).canonical_asset_key
   AND NOT coalesce((s.h).is_closed,false)
   AND (s.h).quantity IS NOT NULL AND (s.h).quantity::text NOT IN('NaN','Infinity','-Infinity')
   AND m.current_price>=0 AND m.current_price::text NOT IN('NaN','Infinity','-Infinity')
   AND m.as_of BETWEEN statement_timestamp()-interval '5 minutes' AND statement_timestamp()+interval '30 seconds'
   AND m.last_refreshed_at BETWEEN statement_timestamp()-interval '5 minutes' AND statement_timestamp()+interval '30 seconds'
   AND ((s.h).last_priced_at IS NULL OR m.as_of>=(s.h).last_priced_at)
 ), values AS MATERIALIZED (
  SELECT *,CASE WHEN price IS NOT NULL THEN (h).quantity*price END AS value,
   CASE WHEN change::text NOT IN('NaN','Infinity','-Infinity') THEN change END AS change_pct FROM candidates
 ), totals AS MATERIALIZED (SELECT coalesce(sum(CASE WHEN price IS NULL THEN (h).current_value ELSE value END) FILTER(WHERE NOT coalesce((h).is_closed,false)),0) AS value FROM values)
 SELECT
  (v.h).id AS id,
  (v.h).org_id AS org_id,
  (v.h).user_id AS user_id,
  (v.h).portfolio_id AS portfolio_id,
  (v.h).asset_symbol AS asset_symbol,
  (v.h).normalized_symbol AS normalized_symbol,
  (v.h).canonical_asset_id AS canonical_asset_id,
  (v.h).contract_address AS contract_address,
  (v.h).chain AS chain,
  (v.h).asset_class AS asset_class,
  (v.h).quantity AS quantity,
  (v.h).average_cost AS average_cost,
  (v.h).cost_basis_usd AS cost_basis_usd,
  CASE WHEN v.price IS NULL THEN (v.h).current_price ELSE v.price END AS current_price,
  CASE WHEN v.price IS NULL THEN (v.h).current_value ELSE v.value END AS current_value,
  CASE WHEN v.price IS NULL THEN (v.h).price_source ELSE 'coinmarketcap'::text END AS price_source,
  CASE WHEN v.price IS NULL THEN (v.h).price_status ELSE 'priced'::text END AS price_status,
  CASE WHEN v.price IS NULL THEN (v.h).last_priced_at ELSE v.as_of END AS last_priced_at,
  CASE WHEN v.price IS NULL THEN (v.h).unrealized_pnl ELSE CASE WHEN (v.h).cost_basis_usd IS NOT NULL THEN v.value-(v.h).cost_basis_usd END END AS unrealized_pnl,
  CASE WHEN v.price IS NULL THEN (v.h).unrealized_pnl_pct ELSE CASE WHEN (v.h).cost_basis_usd>0 THEN (v.value-(v.h).cost_basis_usd)/(v.h).cost_basis_usd*100 END END AS unrealized_pnl_pct,
  (v.h).realized_pnl AS realized_pnl,
  CASE WHEN v.price IS NULL THEN (v.h).day_pnl ELSE CASE WHEN v.change_pct > -100 THEN v.value-v.value/(1+v.change_pct/100) END END AS day_pnl,
  CASE WHEN v.price IS NULL THEN (v.h).day_pnl_pct ELSE v.change_pct END AS day_pnl_pct,
  CASE WHEN t.value>0 THEN (CASE WHEN v.price IS NULL THEN (v.h).current_value ELSE v.value END)/t.value*100 END AS allocation_pct,
  CASE WHEN v.price IS NULL THEN (v.h).pnl_state ELSE CASE WHEN (v.h).pnl_state='unpriced_or_stale' THEN CASE WHEN (v.h).cost_basis_usd IS NULL OR (v.h).cost_basis_status IN('incomplete','partial','none','unknown') THEN 'incomplete_history' ELSE 'estimate' END ELSE (v.h).pnl_state END END AS pnl_state,
  (v.h).reconciliation_status AS reconciliation_status,
  CASE WHEN v.price IS NULL THEN (v.h).market_context ELSE coalesce((v.h).market_context,'{}')||jsonb_build_object('priceExpiresAt',v.last_refreshed_at+interval '5 minutes','priceSourceRef','coinmarketcap:listings:'||((v.h).market_context->>'priceProviderId'),'marketCap',v.market_cap) END AS market_context,
  CASE WHEN v.price IS NULL THEN (v.h).is_dust ELSE v.value<1 END AS is_dust,
  (v.h).updated_at AS updated_at,
  (v.h).canonical_asset_key AS canonical_asset_key,
  (v.h).source_id AS source_id,
  (v.h).wallet_address AS wallet_address,
  (v.h).mint_or_contract AS mint_or_contract,
  (v.h).decimals AS decimals,
  (v.h).name AS name,
  (v.h).logo_url AS logo_url,
  (v.h).verified AS verified,
  (v.h).support_level AS support_level,
  (v.h).provider AS provider,
  (v.h).provider_network AS provider_network,
  (v.h).provider_confidence AS provider_confidence,
  (v.h).cost_basis_status AS cost_basis_status,
  (v.h).last_synced_at AS last_synced_at,
  (v.h).is_closed AS is_closed
 FROM values v CROSS JOIN totals t;
END;$$;
REVOKE ALL ON FUNCTION public.intel_portfolio_valued_holdings(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_portfolio_valued_holdings(uuid,uuid) TO authenticated;

-- A visible asset refreshes only its position, not its already-paginated history.
CREATE FUNCTION public.intel_asset_portfolio_holding(p_org_id uuid,p_portfolio_id uuid,p_asset_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF p_asset_key IS NULL OR length(p_asset_key) NOT BETWEEN 3 AND 256 THEN
  RAISE EXCEPTION 'Invalid asset' USING ERRCODE='22023'; END IF;
 SELECT to_jsonb(h) INTO result FROM public.intel_portfolio_valued_holdings(p_org_id,p_portfolio_id) h
 WHERE h.canonical_asset_key=p_asset_key;
 RETURN jsonb_build_object('holding',result,'evaluatedAt',statement_timestamp());
END;$$;
REVOKE ALL ON FUNCTION public.intel_asset_portfolio_holding(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_asset_portfolio_holding(uuid,uuid,text) TO authenticated;

-- Quote-sensitive totals follow the existing holdings rollup. Recorded cost,
-- realized proceeds, risk assessment and balance/snapshot clocks stay intact.
CREATE FUNCTION public.intel_portfolio_valued_summary(p_org_id uuid,p_portfolio_id uuid)
RETURNS SETOF public.investor_portfolios
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE p public.investor_portfolios; value double precision; unrealized double precision; daily double precision; stable double precision;
BEGIN
 SELECT * INTO p FROM public.investor_portfolios x WHERE x.id=p_portfolio_id AND x.org_id=p_org_id AND x.user_id=auth.uid()
  AND x.org_id IN(SELECT public.intel_portfolio_org_ids());
 IF p.id IS NULL THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501'; END IF;
 WITH h AS MATERIALIZED (SELECT * FROM public.intel_portfolio_valued_holdings(p_org_id,p_portfolio_id) WHERE NOT coalesce(is_closed,false))
 SELECT coalesce(sum(current_value),0),CASE WHEN count(current_value)>0 AND count(unrealized_pnl) FILTER(WHERE current_value IS NOT NULL)=count(current_value)
  THEN sum(unrealized_pnl) FILTER(WHERE current_value IS NOT NULL) END,sum(day_pnl),coalesce(sum(current_value) FILTER(WHERE asset_class='stablecoin'),0)
 INTO value,unrealized,daily,stable FROM h;
 p.total_value_usd:=value;p.unrealized_pnl_usd:=unrealized;p.day_pnl_usd:=daily;
 p.day_pnl_pct:=CASE WHEN value-daily<>0 THEN daily/(value-daily)*100 END;
 p.stablecoin_pct:=CASE WHEN value>0 THEN stable/value*100 ELSE 0 END;
 RETURN NEXT p;
END;$$;
REVOKE ALL ON FUNCTION public.intel_portfolio_valued_summary(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_portfolio_valued_summary(uuid,uuid) TO authenticated;

-- Existing intel_asset_portfolio_context: retain every authorization, pagination and event clause.
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

  SELECT to_jsonb(h) INTO v_holding FROM public.intel_portfolio_valued_holdings(p_org_id,p_portfolio_id) h
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
$function$
;
-- Existing intel_desk_positions: retain every authorization, pagination and event clause.
CREATE OR REPLACE FUNCTION public.intel_desk_positions(p_org_id uuid, p_portfolio_id uuid, p_hide_dust boolean DEFAULT false, p_pinned text[] DEFAULT '{}'::text[], p_page integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE portfolio jsonb; result jsonb;
BEGIN
 SELECT jsonb_build_object('id',p.id,'name',p.name,'value',p.total_value_usd,'cost',p.total_cost_usd,'unrealized',p.unrealized_pnl_usd,'realized',p.realized_pnl_usd,'risk',p.risk_score,'incomplete',p.incomplete_history,'observedAt',p.last_snapshot_at) INTO portfolio
 FROM public.intel_portfolio_valued_summary(p_org_id,p_portfolio_id) p WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid() AND p.org_id IN(SELECT public.intel_portfolio_org_ids());
 IF portfolio IS NULL THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501'; END IF;
 IF p_page IS NULL OR p_page<0 OR p_page>10000 OR coalesce(cardinality(p_pinned),0)>200 THEN RAISE EXCEPTION 'Invalid desk page' USING ERRCODE='22023'; END IF;
 WITH scoped AS MATERIALIZED (
  SELECT h.id,h.canonical_asset_key,h.asset_symbol,h.name,h.quantity,h.current_value,h.current_price,h.cost_basis_usd,h.unrealized_pnl,h.allocation_pct,h.price_status,h.price_source,h.last_priced_at,h.market_context,h.logo_url,h.pnl_state,h.cost_basis_status,
   coalesce(array_position(p_pinned,h.canonical_asset_key),1000000) pin_order,
   coalesce(h.asset_class,'') NOT IN('native','stablecoin') AND h.current_value IS NOT NULL AND h.current_value>=0 AND h.current_value<1 AND h.current_price IS NOT NULL AND h.current_price::text NOT IN('NaN','Infinity','-Infinity') dust
  FROM public.intel_portfolio_valued_holdings(p_org_id,p_portfolio_id) h WHERE h.portfolio_id=p_portfolio_id AND h.org_id=p_org_id AND h.user_id=auth.uid() AND NOT coalesce(h.is_closed,false)
 ), visible AS MATERIALIZED (SELECT * FROM scoped WHERE NOT coalesce(p_hide_dust,false) OR NOT dust OR pin_order<1000000), page AS (
  SELECT * FROM visible ORDER BY pin_order,current_value DESC NULLS LAST,id LIMIT 12 OFFSET p_page*12
 ) SELECT jsonb_build_object('portfolio',portfolio,'rows',coalesce((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'),
  'total',(SELECT count(*) FROM scoped),'hidden',(SELECT count(*) FROM scoped)-(SELECT count(*) FROM visible),'unpriced',(SELECT count(*) FROM scoped WHERE current_value IS NULL OR current_price IS NULL OR current_value::text IN('NaN','Infinity','-Infinity') OR current_price::text IN('NaN','Infinity','-Infinity')),'hasMore',(SELECT count(*) FROM visible)>(p_page+1)*12,'page',p_page)
 INTO result;
 RETURN result;
END $function$
;
-- Existing intel_portfolio_overview: retain every authorization, pagination and event clause.
CREATE OR REPLACE FUNCTION public.intel_portfolio_overview(p_org_id uuid, p_portfolio_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE v_portfolio jsonb; v_summary jsonb; v_now timestamptz:=statement_timestamp();
BEGIN
 SELECT to_jsonb(p) INTO v_portfolio FROM public.intel_portfolio_valued_summary(p_org_id,p_portfolio_id) p WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid() AND p.org_id IN(SELECT public.intel_portfolio_org_ids());
 IF v_portfolio IS NULL THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 WITH scoped AS MATERIALIZED (
  SELECT h.*,coalesce(h.asset_class,'') NOT IN('native','stablecoin') AND (h.current_value IS NOT NULL AND h.current_value>=0 AND h.current_value<1 AND h.current_price IS NOT NULL AND h.current_price::text NOT IN('NaN','Infinity','-Infinity')) AS dust,
   CASE WHEN h.current_value IS NULL OR h.current_price IS NULL OR h.current_value::text IN('NaN','Infinity','-Infinity') OR h.current_price::text IN('NaN','Infinity','-Infinity') THEN 'unpriced'
    WHEN h.price_status IN('unpriced','stale') OR h.last_priced_at IS NULL OR h.last_priced_at>v_now+interval '30 seconds'
      OR h.last_priced_at<v_now-CASE WHEN h.price_source ~* '^(coinmarketcap|cmc)(:|$)' THEN interval '5 minutes' WHEN h.price_source='exchange_profile' THEN interval '10 minutes' ELSE interval '30 hours' END
      OR (CASE WHEN pg_catalog.pg_input_is_valid(h.market_context->>'priceExpiresAt','timestamptz') THEN (h.market_context->>'priceExpiresAt')::timestamptz<=v_now ELSE false END) THEN 'stale' ELSE 'priced' END AS quote_status
  FROM public.intel_portfolio_valued_holdings(p_org_id,p_portfolio_id) h WHERE h.portfolio_id=p_portfolio_id AND h.org_id=p_org_id AND h.user_id=auth.uid()
 ), chains AS (
  SELECT coalesce(chain,'unknown') label,sum(coalesce(current_value,0)) value FROM scoped WHERE NOT coalesce(is_closed,false) GROUP BY chain ORDER BY value DESC,chain LIMIT 20
 ) SELECT jsonb_build_object('observedAt',v_now,'openCount',count(*) FILTER(WHERE NOT coalesce(is_closed,false)),'closedCount',count(*) FILTER(WHERE coalesce(is_closed,false)),
  'missingValueCount',count(*) FILTER(WHERE NOT coalesce(is_closed,false) AND current_value IS NULL),'dustCount',count(*) FILTER(WHERE NOT coalesce(is_closed,false) AND dust),
  'unpriced',count(*) FILTER(WHERE NOT coalesce(is_closed,false) AND quote_status='unpriced'), 'stale',count(*) FILTER(WHERE NOT coalesce(is_closed,false) AND quote_status='stale'),
  'visibleUnpriced',count(*) FILTER(WHERE NOT coalesce(is_closed,false) AND NOT dust AND quote_status='unpriced'),'visibleStale',count(*) FILTER(WHERE NOT coalesce(is_closed,false) AND NOT dust AND quote_status='stale'),
  'oldestQuote',min(last_priced_at) FILTER(WHERE NOT coalesce(is_closed,false)), 'visibleOldestQuote',min(last_priced_at) FILTER(WHERE NOT coalesce(is_closed,false) AND NOT dust),
  'byChain',coalesce((SELECT jsonb_agg(to_jsonb(chains)) FROM chains),'[]'),'chainCount',count(DISTINCT coalesce(chain,'unknown')) FILTER(WHERE NOT coalesce(is_closed,false))) INTO v_summary FROM scoped;
 RETURN jsonb_build_object('portfolio',v_portfolio,'summary',v_summary,
  'open',public.intel_portfolio_page(p_org_id,p_portfolio_id,'holdings','open',0,25,'','value',coalesce((v_portfolio->>'hide_dust')::boolean,false)),
  'closed',public.intel_portfolio_page(p_org_id,p_portfolio_id,'holdings','closed',0,10),
  'sources',public.intel_portfolio_page(p_org_id,p_portfolio_id,'sources'));
END;$function$
;
-- Existing intel_portfolio_page: retain every authorization, pagination and event clause.
CREATE OR REPLACE FUNCTION public.intel_portfolio_page(p_org_id uuid, p_portfolio_id uuid, p_kind text DEFAULT 'holdings'::text, p_view text DEFAULT 'open'::text, p_page integer DEFAULT 0, p_limit integer DEFAULT 25, p_search text DEFAULT ''::text, p_sort text DEFAULT 'value'::text, p_hide_dust boolean DEFAULT false, p_export boolean DEFAULT false, p_revision text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE v_rows jsonb; v_count bigint; v_revision text; v_limit integer:=greatest(1,least(250,coalesce(p_limit,25))); v_search text:=coalesce(p_search,'');
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.investor_portfolios p WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid() AND p.org_id IN(SELECT public.intel_portfolio_org_ids())) THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 IF p_kind NOT IN ('holdings','sources') OR p_kind IS NULL OR p_view NOT IN ('open','closed','all') OR p_view IS NULL OR p_sort NOT IN ('value','asset','pnl','id') OR p_sort IS NULL OR p_page IS NULL OR p_page<0 OR p_page>1000000 OR length(v_search)>160 THEN RAISE EXCEPTION 'Invalid portfolio page' USING ERRCODE='22023';END IF;
 IF p_kind='sources' THEN
  SELECT count(*) INTO v_count FROM public.investor_portfolio_sources s WHERE s.portfolio_id=p_portfolio_id AND s.org_id=p_org_id AND s.user_id=auth.uid();
  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.created_at,s.id),'[]') INTO v_rows FROM (SELECT * FROM public.investor_portfolio_sources s WHERE s.portfolio_id=p_portfolio_id AND s.org_id=p_org_id AND s.user_id=auth.uid() ORDER BY created_at,id LIMIT v_limit OFFSET p_page::bigint*v_limit) s;
 ELSE
  -- Export pages reject any changed row, including deleted/added rows or notes.
  -- Full-row hashing is only used for an explicit export, never initial rendering.
  IF p_export THEN
   SELECT md5(coalesce(string_agg(md5(to_jsonb(h)::text),'' ORDER BY h.id),'')) INTO v_revision FROM public.intel_portfolio_valued_holdings(p_org_id,p_portfolio_id) h WHERE h.portfolio_id=p_portfolio_id AND h.org_id=p_org_id AND h.user_id=auth.uid();
   IF p_revision IS NOT NULL AND p_revision IS DISTINCT FROM v_revision THEN RAISE EXCEPTION 'Holdings changed during export. Start the export again.' USING ERRCODE='40001';END IF;
  END IF;
  WITH filtered AS MATERIALIZED (
   SELECT h.* FROM public.intel_portfolio_valued_holdings(p_org_id,p_portfolio_id) h WHERE h.portfolio_id=p_portfolio_id AND h.org_id=p_org_id AND h.user_id=auth.uid()
    AND (p_view='all' OR coalesce(h.is_closed,false)=(p_view='closed'))
    AND (v_search='' OR strpos(lower(coalesce(h.asset_symbol,'')||' '||coalesce(h.name,'')||' '||coalesce(h.chain,'')||' '||coalesce(h.canonical_asset_key,'')),lower(v_search))>0)
    AND (NOT coalesce(p_hide_dust,false) OR p_view='closed' OR NOT(coalesce(h.asset_class,'') NOT IN('native','stablecoin') AND (h.current_value IS NOT NULL AND h.current_value>=0 AND h.current_value<1 AND h.current_price IS NOT NULL AND h.current_price::text NOT IN('NaN','Infinity','-Infinity'))))
  ), page AS (
   SELECT * FROM filtered ORDER BY CASE WHEN p_sort='value' THEN current_value END DESC NULLS LAST,CASE WHEN p_sort='asset' THEN lower(coalesce(asset_symbol,normalized_symbol,'')) END ASC,CASE WHEN p_sort='pnl' THEN CASE WHEN p_view='closed' THEN realized_pnl ELSE unrealized_pnl END END DESC NULLS LAST,id
   LIMIT v_limit OFFSET p_page::bigint*v_limit
  ) SELECT (SELECT count(*) FROM filtered),coalesce((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]') INTO v_count,v_rows;
 END IF;
 RETURN jsonb_build_object('rows',v_rows,'total',v_count,'page',p_page,'limit',v_limit,'hasMore',(p_page::bigint+1)*v_limit<v_count,'revision',v_revision);
END;$function$
;
-- Existing intel_portfolio_research_facts: retain every authorization, pagination and event clause.
CREATE OR REPLACE FUNCTION public.intel_portfolio_research_facts(p_org_id uuid, p_portfolio_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE v jsonb;
BEGIN
 IF auth.uid() IS NULL OR p_org_id NOT IN (SELECT public.intel_portfolio_org_ids()) OR NOT EXISTS(
 SELECT 1 FROM public.investor_portfolios p WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid()) THEN
 RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 WITH h AS MATERIALIZED (
  SELECT x.* FROM public.intel_portfolio_valued_holdings(p_org_id,p_portfolio_id) x WHERE x.portfolio_id=p_portfolio_id AND x.org_id=p_org_id AND x.user_id=auth.uid()
  ORDER BY x.id LIMIT 5001
 ), sources AS MATERIALIZED (
  SELECT s.id,s.source_type,s.provider FROM public.investor_portfolio_sources s WHERE s.portfolio_id=p_portfolio_id AND s.org_id=p_org_id AND s.user_id=auth.uid()
 ), grouped AS (
  SELECT 'grouped:'||g.id AS key,g.block_time AS occurred,
   (to_jsonb(g)-ARRAY['raw','counterparty','org_id','user_id','portfolio_id'])||jsonb_build_object('kind','grouped','timestamp',g.block_time,'provider',s.provider) AS event
  FROM public.investor_portfolio_tx g JOIN sources s ON s.id=g.source_id AND s.source_type<>'manual'
  WHERE g.portfolio_id=p_portfolio_id AND g.org_id=p_org_id AND g.user_id=auth.uid() AND NOT g.is_display_mirror
  ORDER BY g.block_time DESC NULLS LAST,g.id DESC LIMIT 21
 ), manual AS (
  SELECT 'manual:'||m.id AS key,m.timestamp AS occurred,
   (to_jsonb(m)-ARRAY['raw_metadata','org_id','user_id','portfolio_id','tags'])||jsonb_build_object('kind','manual_leg','provider',s.provider,'status','recorded',
    'manual_group_id',m.raw_metadata->>'manual_group_id','manual_pair_classification',m.raw_metadata->>'manual_pair_classification') AS event
  FROM public.investor_portfolio_transactions m JOIN sources s ON s.id=m.source_id AND s.source_type='manual'
  WHERE m.portfolio_id=p_portfolio_id AND m.org_id=p_org_id AND m.user_id=auth.uid()
  ORDER BY m.timestamp DESC NULLS LAST,m.id DESC LIMIT 21
 ), activity AS MATERIALIZED (
  SELECT * FROM (SELECT * FROM grouped UNION ALL SELECT * FROM manual) x ORDER BY occurred DESC NULLS LAST,key DESC LIMIT 21
 ) SELECT jsonb_build_object(
  'holdings',coalesce((SELECT jsonb_agg(to_jsonb(x)-ARRAY['wallet_address','org_id','user_id','portfolio_id']) FROM (SELECT * FROM h ORDER BY id LIMIT 5000) x),'[]'::jsonb),
  'holdingsTruncated',(SELECT count(*)>5000 FROM h),
  'activity',coalesce((SELECT jsonb_agg(event ORDER BY occurred DESC NULLS LAST,key DESC) FROM (SELECT * FROM activity ORDER BY occurred DESC NULLS LAST,key DESC LIMIT 20) a),'[]'::jsonb),
  'activityHasMore',(SELECT count(*)>20 FROM activity),
  'observedAt',statement_timestamp()
 ) INTO v;RETURN v;
END;$function$
;
