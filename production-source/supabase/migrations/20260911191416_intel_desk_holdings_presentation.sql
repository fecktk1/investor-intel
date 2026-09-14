-- Presentation only. Unknown prices are not dust. Ledger totals are never filtered.
CREATE OR REPLACE FUNCTION public.intel_portfolio_page(p_org_id uuid,p_portfolio_id uuid,p_kind text DEFAULT 'holdings',p_view text DEFAULT 'open',p_page integer DEFAULT 0,p_limit integer DEFAULT 25,p_search text DEFAULT '',p_sort text DEFAULT 'value',p_hide_dust boolean DEFAULT false,p_export boolean DEFAULT false,p_revision text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
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
   SELECT md5(coalesce(string_agg(md5(to_jsonb(h)::text),'' ORDER BY h.id),'')) INTO v_revision FROM public.investor_portfolio_holdings h WHERE h.portfolio_id=p_portfolio_id AND h.org_id=p_org_id AND h.user_id=auth.uid();
   IF p_revision IS NOT NULL AND p_revision IS DISTINCT FROM v_revision THEN RAISE EXCEPTION 'Holdings changed during export. Start the export again.' USING ERRCODE='40001';END IF;
  END IF;
  WITH filtered AS MATERIALIZED (
   SELECT h.* FROM public.investor_portfolio_holdings h WHERE h.portfolio_id=p_portfolio_id AND h.org_id=p_org_id AND h.user_id=auth.uid()
    AND (p_view='all' OR coalesce(h.is_closed,false)=(p_view='closed'))
    AND (v_search='' OR strpos(lower(coalesce(h.asset_symbol,'')||' '||coalesce(h.name,'')||' '||coalesce(h.chain,'')||' '||coalesce(h.canonical_asset_key,'')),lower(v_search))>0)
    AND (NOT coalesce(p_hide_dust,false) OR p_view='closed' OR NOT(coalesce(h.asset_class,'') NOT IN('native','stablecoin') AND (h.current_value IS NOT NULL AND h.current_value>=0 AND h.current_value<1)))
  ), page AS (
   SELECT * FROM filtered ORDER BY CASE WHEN p_sort='value' THEN current_value END DESC NULLS LAST,CASE WHEN p_sort='asset' THEN lower(coalesce(asset_symbol,normalized_symbol,'')) END ASC,CASE WHEN p_sort='pnl' THEN CASE WHEN p_view='closed' THEN realized_pnl ELSE unrealized_pnl END END DESC NULLS LAST,id
   LIMIT v_limit OFFSET p_page::bigint*v_limit
  ) SELECT (SELECT count(*) FROM filtered),coalesce((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]') INTO v_count,v_rows;
 END IF;
 RETURN jsonb_build_object('rows',v_rows,'total',v_count,'page',p_page,'limit',v_limit,'hasMore',(p_page::bigint+1)*v_limit<v_count,'revision',v_revision);
END;$$;
REVOKE ALL ON FUNCTION public.intel_portfolio_page(uuid,uuid,text,text,integer,integer,text,text,boolean,boolean,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_portfolio_page(uuid,uuid,text,text,integer,integer,text,text,boolean,boolean,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.intel_portfolio_overview(p_org_id uuid,p_portfolio_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_portfolio jsonb; v_summary jsonb; v_now timestamptz:=statement_timestamp();
BEGIN
 SELECT to_jsonb(p) INTO v_portfolio FROM public.investor_portfolios p WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid() AND p.org_id IN(SELECT public.intel_portfolio_org_ids());
 IF v_portfolio IS NULL THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 WITH scoped AS MATERIALIZED (
  SELECT h.*,coalesce(h.asset_class,'') NOT IN('native','stablecoin') AND (h.current_value IS NOT NULL AND h.current_value>=0 AND h.current_value<1) AS dust,
   CASE WHEN h.current_value IS NULL OR h.current_price IS NULL OR h.current_value::text IN('NaN','Infinity','-Infinity') OR h.current_price::text IN('NaN','Infinity','-Infinity') THEN 'unpriced'
    WHEN h.price_status IN('unpriced','stale') OR h.last_priced_at IS NULL OR h.last_priced_at>v_now+interval '30 seconds'
      OR h.last_priced_at<v_now-CASE WHEN h.price_source ~* '^(coinmarketcap|cmc)(:|$)' THEN interval '5 minutes' WHEN h.price_source='exchange_profile' THEN interval '10 minutes' ELSE interval '30 hours' END
      OR (CASE WHEN pg_catalog.pg_input_is_valid(h.market_context->>'priceExpiresAt','timestamptz') THEN (h.market_context->>'priceExpiresAt')::timestamptz<=v_now ELSE false END) THEN 'stale' ELSE 'priced' END AS quote_status
  FROM public.investor_portfolio_holdings h WHERE h.portfolio_id=p_portfolio_id AND h.org_id=p_org_id AND h.user_id=auth.uid()
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
END;$$;
REVOKE ALL ON FUNCTION public.intel_portfolio_overview(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_portfolio_overview(uuid,uuid) TO authenticated;
COMMENT ON FUNCTION public.intel_portfolio_overview(uuid,uuid) IS 'Owner-only full-book coverage and existing accounting totals, with bounded first pages; no provider calls.';

CREATE FUNCTION public.intel_desk_positions(p_org_id uuid,p_portfolio_id uuid,p_hide_dust boolean DEFAULT false,p_pinned text[] DEFAULT '{}',p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE portfolio jsonb; result jsonb;
BEGIN
 SELECT jsonb_build_object('id',p.id,'name',p.name,'value',p.total_value_usd,'cost',p.total_cost_usd,'unrealized',p.unrealized_pnl_usd,'realized',p.realized_pnl_usd,'risk',p.risk_score,'incomplete',p.incomplete_history,'observedAt',p.last_snapshot_at) INTO portfolio
 FROM public.investor_portfolios p WHERE p.id=p_portfolio_id AND p.org_id=p_org_id AND p.user_id=auth.uid() AND p.org_id IN(SELECT public.intel_portfolio_org_ids());
 IF portfolio IS NULL THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501'; END IF;
 IF p_page IS NULL OR p_page<0 OR p_page>10000 OR coalesce(cardinality(p_pinned),0)>200 THEN RAISE EXCEPTION 'Invalid desk page' USING ERRCODE='22023'; END IF;
 WITH scoped AS MATERIALIZED (
  SELECT h.id,h.canonical_asset_key,h.asset_symbol,h.name,h.quantity,h.current_value,h.current_price,h.cost_basis_usd,h.unrealized_pnl,h.allocation_pct,h.price_status,h.price_source,h.last_priced_at,h.market_context,h.logo_url,h.pnl_state,h.cost_basis_status,
   coalesce(array_position(p_pinned,h.canonical_asset_key),1000000) pin_order,
   coalesce(h.asset_class,'') NOT IN('native','stablecoin') AND h.current_value IS NOT NULL AND h.current_value>=0 AND h.current_value<1 dust
  FROM public.investor_portfolio_holdings h WHERE h.portfolio_id=p_portfolio_id AND h.org_id=p_org_id AND h.user_id=auth.uid() AND NOT coalesce(h.is_closed,false)
 ), visible AS MATERIALIZED (SELECT * FROM scoped WHERE NOT coalesce(p_hide_dust,false) OR NOT dust OR pin_order<1000000), page AS (
  SELECT * FROM visible ORDER BY pin_order,current_value DESC NULLS LAST,id LIMIT 12 OFFSET p_page*12
 ) SELECT jsonb_build_object('portfolio',portfolio,'rows',coalesce((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'),
  'total',(SELECT count(*) FROM scoped),'hidden',(SELECT count(*) FROM scoped)-(SELECT count(*) FROM visible),'unpriced',(SELECT count(*) FROM scoped WHERE current_value IS NULL),'hasMore',(SELECT count(*) FROM visible)>(p_page+1)*12,'page',p_page)
 INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_desk_positions(uuid,uuid,boolean,text[],integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_desk_positions(uuid,uuid,boolean,text[],integer) TO authenticated;
