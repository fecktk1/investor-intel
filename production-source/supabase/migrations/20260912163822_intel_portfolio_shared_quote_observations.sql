-- Narrow projection from retained public quote evidence, never the raw response
-- cache. That evidence table remains inaccessible to browser roles. Every call
-- verifies current membership, portfolio ownership and the recorded asset map.
CREATE FUNCTION public.intel_portfolio_observation_quote(p_org_id uuid,p_portfolio_id uuid,p_provider_id text)
RETURNS TABLE(price double precision,change_pct double precision,as_of timestamptz,fetched_at timestamptz,expires_at timestamptz,source_ref text,market_cap double precision,export_allowed boolean,ai_allowed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.investor_portfolios p JOIN public.org_members m ON m.org_id=p.org_id AND m.user_id=auth.uid()
  WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid()) THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501'; END IF;
 IF p_provider_id IS NULL OR p_provider_id !~ '^[1-9][0-9]{0,9}$' OR NOT EXISTS(SELECT 1 FROM public.investor_portfolio_holdings h
  WHERE h.portfolio_id=p_portfolio_id AND h.org_id=p_org_id AND h.user_id=auth.uid() AND NOT coalesce(h.is_closed,false)
   AND h.market_context->>'priceProviderId'=p_provider_id AND h.market_context->>'priceProvider'='coinmarketcap'
   AND h.market_context->>'canonicalAssetKey'=h.canonical_asset_key) THEN RETURN; END IF;
 RETURN QUERY
 WITH price AS MATERIALIZED (
  SELECT o.* FROM public.intel_market_observations o
  WHERE o.subject='market:coinmarketcap:'||p_provider_id AND o.provider='coinmarketcap' AND o.metric='price'
   AND o.observed_at BETWEEN statement_timestamp()-interval '5 minutes' AND statement_timestamp()+interval '30 seconds'
   AND o.recorded_at BETWEEN statement_timestamp()-interval '5 minutes' AND statement_timestamp()+interval '30 seconds'
   AND o.retain_until>statement_timestamp() AND o.observation->>'unit'='USD'
   AND jsonb_typeof(o.observation->'value')='number' AND (o.observation->>'value')::numeric>=0
   AND o.observation->>'sourceRef' LIKE 'coinmarketcap:/v3/cryptocurrency/quotes/latest:%'
   AND pg_catalog.pg_input_is_valid(o.observation->>'expiresAt','timestamptz')
  ORDER BY o.observed_at DESC,o.recorded_at DESC,o.id DESC LIMIT 1
 ), related AS MATERIALIZED (
  SELECT o.metric,o.observation FROM public.intel_market_observations o JOIN price p ON o.subject=p.subject AND o.provider=p.provider
   AND o.observed_at=p.observed_at AND o.recorded_at=p.recorded_at AND o.observation->>'sourceRef'=p.observation->>'sourceRef'
  WHERE o.metric IN('price_change','market_cap') AND o.retain_until>statement_timestamp()
   AND jsonb_typeof(o.observation->'value')='number'
  ORDER BY o.id LIMIT 16
 ) SELECT (p.observation->>'value')::double precision,
  (SELECT (o.observation->>'value')::double precision FROM related o WHERE o.metric='price_change' AND o.observation->>'unit'='%' AND o.observation->>'periodSeconds'='86400' LIMIT 1),
  p.observed_at,p.recorded_at,least((p.observation->>'expiresAt')::timestamptz,p.retain_until),p.observation->>'sourceRef',
  (SELECT (o.observation->>'value')::double precision FROM related o WHERE o.metric='market_cap' AND o.observation->>'unit'='USD' LIMIT 1),
  p.observation->'exportAllowed'='true'::jsonb,p.observation->'aiAllowed'='true'::jsonb
 FROM price p;
END;$$;
REVOKE ALL ON FUNCTION public.intel_portfolio_observation_quote(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_portfolio_observation_quote(uuid,uuid,text) TO authenticated;

-- Read-only valuation of an authorized book from the shared CMC catalog.
-- The canonical-to-provider association is recorded by the existing verified
-- pricing pipeline. Symbols never participate in this join. No ledger writes,
-- provider requests, balance sync, historical snapshot or research mutations.
CREATE OR REPLACE FUNCTION public.intel_portfolio_valued_holdings(p_org_id uuid,p_portfolio_id uuid)
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
 ), ids AS MATERIALIZED (
  SELECT DISTINCT (h).market_context->>'priceProviderId' id FROM scoped WHERE NOT coalesce((h).is_closed,false)
   AND (h).market_context->>'priceProvider'='coinmarketcap' AND (h).market_context->>'canonicalAssetKey'=(h).canonical_asset_key
 ), quotes AS MATERIALIZED (
  SELECT ids.id,q.* FROM ids CROSS JOIN LATERAL public.intel_portfolio_observation_quote(p_org_id,p_portfolio_id,ids.id) q
 ), candidates AS MATERIALIZED (
  SELECT s.h,m.current_price AS price,m.change_24h_pct AS change,m.as_of,m.last_refreshed_at,m.market_cap,m.expires_at,m.source_ref,m.export_allowed,m.ai_allowed
  FROM scoped s LEFT JOIN LATERAL (
   SELECT * FROM (
    SELECT m.current_price,m.change_24h_pct,m.as_of,m.last_refreshed_at,m.market_cap,m.last_refreshed_at+interval '5 minutes' AS expires_at,
     'coinmarketcap:listings:'||m.provider_id AS source_ref,NULL::boolean AS export_allowed,NULL::boolean AS ai_allowed
    FROM public.market_assets m WHERE m.source_provider='coinmarketcap' AND m.provider_id=(s.h).market_context->>'priceProviderId'
     AND m.current_price>=0 AND m.current_price::text NOT IN('NaN','Infinity','-Infinity')
     AND m.as_of BETWEEN statement_timestamp()-interval '5 minutes' AND statement_timestamp()+interval '30 seconds'
     AND m.last_refreshed_at BETWEEN statement_timestamp()-interval '5 minutes' AND statement_timestamp()+interval '30 seconds'
    UNION ALL SELECT q.price,q.change_pct,q.as_of,q.fetched_at,q.market_cap,q.expires_at,q.source_ref,q.export_allowed,q.ai_allowed
     FROM quotes q WHERE q.id=(s.h).market_context->>'priceProviderId'
   ) q WHERE (s.h).last_priced_at IS NULL OR q.as_of>=(s.h).last_priced_at
   ORDER BY q.as_of DESC,q.last_refreshed_at DESC LIMIT 1
  ) m ON (s.h).market_context->>'priceProvider'='coinmarketcap'
   AND (s.h).market_context->>'canonicalAssetKey'=(s.h).canonical_asset_key
   AND NOT coalesce((s.h).is_closed,false) AND (s.h).quantity IS NOT NULL AND (s.h).quantity::text NOT IN('NaN','Infinity','-Infinity')
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
  CASE WHEN v.price IS NULL THEN (v.h).price_status ELSE CASE WHEN v.expires_at>statement_timestamp() THEN 'priced' ELSE 'stale' END END AS price_status,
  CASE WHEN v.price IS NULL THEN (v.h).last_priced_at ELSE v.as_of END AS last_priced_at,
  CASE WHEN v.price IS NULL THEN (v.h).unrealized_pnl ELSE CASE WHEN (v.h).cost_basis_usd IS NOT NULL THEN v.value-(v.h).cost_basis_usd END END AS unrealized_pnl,
  CASE WHEN v.price IS NULL THEN (v.h).unrealized_pnl_pct ELSE CASE WHEN (v.h).cost_basis_usd>0 THEN (v.value-(v.h).cost_basis_usd)/(v.h).cost_basis_usd*100 END END AS unrealized_pnl_pct,
  (v.h).realized_pnl AS realized_pnl,
  CASE WHEN v.price IS NULL THEN (v.h).day_pnl ELSE CASE WHEN v.change_pct > -100 THEN v.value-v.value/(1+v.change_pct/100) END END AS day_pnl,
  CASE WHEN v.price IS NULL THEN (v.h).day_pnl_pct ELSE v.change_pct END AS day_pnl_pct,
  CASE WHEN t.value>0 THEN (CASE WHEN v.price IS NULL THEN (v.h).current_value ELSE v.value END)/t.value*100 END AS allocation_pct,
  CASE WHEN v.price IS NULL THEN (v.h).pnl_state ELSE CASE WHEN (v.h).pnl_state='unpriced_or_stale' THEN CASE WHEN (v.h).cost_basis_usd IS NULL OR (v.h).cost_basis_status IN('incomplete','partial','none','unknown') THEN 'incomplete_history' ELSE 'estimate' END ELSE (v.h).pnl_state END END AS pnl_state,
  (v.h).reconciliation_status AS reconciliation_status,
  CASE WHEN v.price IS NULL THEN (v.h).market_context ELSE coalesce((v.h).market_context,'{}')||jsonb_build_object('priceExpiresAt',v.expires_at,'priceSourceRef',v.source_ref,'marketCap',v.market_cap,'priceExportAllowed',v.export_allowed,'priceAiAllowed',v.ai_allowed) END AS market_context,
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
  ) SELECT (SELECT count(*) FROM filtered),coalesce((SELECT jsonb_agg(CASE WHEN p_export AND page.market_context->'priceExportAllowed'='false'::jsonb THEN to_jsonb(page)||jsonb_build_object('current_price',NULL,'current_value',NULL,'unrealized_pnl',NULL,'unrealized_pnl_pct',NULL,'day_pnl',NULL,'day_pnl_pct',NULL,'allocation_pct',NULL,'price_status','export_restricted') ELSE to_jsonb(page) END) FROM page),'[]') INTO v_count,v_rows;
 END IF;
 RETURN jsonb_build_object('rows',v_rows,'total',v_count,'page',p_page,'limit',v_limit,'hasMore',(p_page::bigint+1)*v_limit<v_count,'revision',v_revision);
END;$function$
;
