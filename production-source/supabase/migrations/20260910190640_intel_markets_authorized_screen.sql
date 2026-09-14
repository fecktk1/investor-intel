-- The edge verifies the signed-in caller; this invoker function independently
-- verifies membership and Investor Intel access before any workspace read.
-- Only service_role may call it. Public market scans avoid repeating per-row
-- RLS work across the full universe; watchlist predicates stay on the verified org.
-- The original authenticated RPC remains intact for compatibility.
CREATE OR REPLACE FUNCTION public.intel_markets_screen_for_user(p_org_id uuid,p_user_id uuid,p_query jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_page int; v_limit int; v_sort text; v_search text; v_chain text; v_category text;
 v_signal text; v_cap text; v_exchange text; v_view text; v_watch boolean;
 v_order text; v_result jsonb;
BEGIN
 IF p_user_id IS NULL OR p_org_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE user_id=p_user_id AND org_id=p_org_id)
  OR NOT COALESCE(public.can_access_intel(p_user_id,p_org_id),false) THEN
  RAISE EXCEPTION 'Investor Intel workspace access required' USING ERRCODE='42501';
 END IF;
 v_page:=COALESCE((p_query->>'page')::int,0); v_limit:=COALESCE((p_query->>'limit')::int,50);
 v_sort:=COALESCE(p_query->>'sort','market_cap'); v_search:=btrim(COALESCE(p_query->>'search',''));
 v_chain:=public.intel_market_chain(NULLIF(p_query->>'chain','')); v_category:=NULLIF(p_query->>'category','');
 v_signal:=NULLIF(p_query->>'signalDirection',''); v_cap:=NULLIF(p_query->>'marketCapAvailability','');
 v_exchange:=NULLIF(p_query->>'exchangeAvailability',''); v_view:=NULLIF(p_query->>'view','');
 v_watch:=COALESCE((p_query->>'watchlistOnly')::boolean,false);
 v_order:=CASE v_sort WHEN 'market_cap' THEN 'market_cap DESC NULLS LAST' WHEN 'volume' THEN 'volume_24h DESC NULLS LAST'
  WHEN 'gainers' THEN 'change_24h_pct DESC NULLS LAST' WHEN 'losers' THEN 'change_24h_pct ASC NULLS LAST'
  WHEN 'change_1h' THEN 'change_1h_pct DESC NULLS LAST' WHEN 'change_24h' THEN 'change_24h_pct DESC NULLS LAST'
  WHEN 'change_7d' THEN 'change_7d_pct DESC NULLS LAST' WHEN 'exchange_availability' THEN 'available_count DESC,market_cap DESC NULLS LAST'
  WHEN 'arbitrage' THEN '(cex->>''arbPct'')::float8 DESC NULLS LAST,market_cap DESC NULLS LAST'
  WHEN 'recently_updated' THEN 'last_refreshed_at DESC NULLS LAST'
  WHEN 'unusual_volume' THEN 'volume_ratio DESC NULLS LAST,volume_24h DESC NULLS LAST'
  WHEN 'multi_exchange_strength' THEN 'available_count DESC,change_24h_pct DESC NULLS LAST' END;
 IF v_page NOT BETWEEN 0 AND 2000 OR v_limit NOT BETWEEN 1 AND 100 OR v_order IS NULL OR length(v_search)>160
  OR length(COALESCE(v_category,''))>160 OR length(COALESCE(v_chain,''))>80
  OR v_signal NOT IN ('bullish','bearish','caution','neutral','mixed','unclear')
  OR v_cap NOT IN ('available','unavailable') OR v_exchange NOT IN ('available','unknown','none')
  OR v_view NOT IN ('unusual_volume','vol_up_price_flat','price_up_liq_weak','multi_exchange','thin_liquidity') THEN
  RAISE EXCEPTION 'Invalid markets query' USING ERRCODE='22023';
 END IF;
 EXECUTE format($query$
 WITH base AS MATERIALIZED (
  SELECT r.*,EXISTS(SELECT 1 FROM public.watchlist_items wi JOIN public.entities e ON e.id=wi.entity_id
   WHERE wi.org_id=$1 AND (e.provider_ids->>r.source_provider=r.provider_id OR
    (e.contract_address IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_each_text(COALESCE(r.platforms,'{}')) p
     WHERE public.intel_market_address(p.value)=public.intel_market_address(e.contract_address)
      AND (public.intel_market_chain(p.key)=public.intel_market_chain(e.chain_id) OR
        (e.chain_namespace='eip155' AND public.canonical_asset_key(public.intel_market_chain(p.key),NULL,p.value)
          ='eip155:'||e.chain_id||':'||public.intel_market_address(e.contract_address)) OR
        (e.chain_namespace='solana' AND public.intel_market_chain(p.key)='solana')))) OR
    e.canonical_ref_key=CASE r.source_provider||':'||r.provider_id
     WHEN 'coingecko:bitcoin' THEN 'native:bitcoin' WHEN 'coinmarketcap:1' THEN 'native:bitcoin'
     WHEN 'coingecko:ethereum' THEN 'native:ethereum' WHEN 'coinmarketcap:1027' THEN 'native:ethereum'
     WHEN 'coingecko:solana' THEN 'native:solana' WHEN 'coinmarketcap:5426' THEN 'native:solana'
     WHEN 'coingecko:binancecoin' THEN 'native:bnb' WHEN 'coinmarketcap:1839' THEN 'native:bnb'
     WHEN 'coingecko:avalanche-2' THEN 'native:avalanche' WHEN 'coinmarketcap:5805' THEN 'native:avalanche' END)) AS on_watchlist
  FROM public.intel_market_screen_rows r
 ), filtered AS (
  SELECT * FROM base r WHERE
   ($2='' OR strpos(lower(r.symbol),lower($2))>0 OR strpos(lower(COALESCE(r.name,'')),lower($2))>0
    OR EXISTS(SELECT 1 FROM jsonb_each_text(COALESCE(r.platforms,'{}')) p WHERE public.intel_market_address(p.value)=public.intel_market_address($2)))
   AND ($3 IS NULL OR public.intel_market_chain(r.primary_chain)=$3 OR EXISTS(SELECT 1 FROM jsonb_object_keys(COALESCE(r.platforms,'{}')) p WHERE public.intel_market_chain(p)=$3))
   AND ($4 IS NULL OR r.categories ? $4) AND ($5 IS NULL OR r.matched_signal_direction=$5)
   AND (NOT $6 OR r.on_watchlist)
   AND ($7 IS NULL OR ($7='available' AND r.market_cap IS NOT NULL) OR ($7='unavailable' AND r.market_cap IS NULL))
   AND ($8 IS NULL OR ($8='available' AND r.available_count>0) OR ($8 IN ('unknown','none') AND r.available_count=0))
   AND ($9 IS NULL OR CASE $9 WHEN 'unusual_volume' THEN r.unusual_volume WHEN 'vol_up_price_flat' THEN r.vol_up_price_flat
    WHEN 'price_up_liq_weak' THEN r.price_up_liquidity_weak WHEN 'multi_exchange' THEN r.multi_exchange_strength WHEN 'thin_liquidity' THEN r.thin_liquidity END)
 ), page_rows AS (SELECT * FROM filtered ORDER BY %s,source_provider,provider_id LIMIT $10 OFFSET $11),
 categories AS (SELECT DISTINCT jsonb_array_elements_text(COALESCE(categories,'[]')) AS category FROM base),
 category_rows AS (SELECT c.category,b.*,row_number() OVER(PARTITION BY c.category ORDER BY b.mover_score DESC,b.source_provider,b.provider_id) AS position,
   count(*) OVER(PARTITION BY c.category) AS members FROM base b CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(b.categories,'[]')) c(category)),
 category_leaders AS (SELECT category,jsonb_agg(to_jsonb(c) ORDER BY position) FILTER(WHERE position<=3) AS leaders,max(mover_score) AS score
   FROM category_rows c WHERE members>=3 GROUP BY category ORDER BY max(mover_score) DESC,category LIMIT 8),
 summary AS (SELECT count(*) AS tracked,count(market_cap) AS cap_count,count(*) FILTER(WHERE available_count>0) AS cex_count,
  count(*) FILTER(WHERE change_24h_pct>0) AS up,count(*) FILTER(WHERE change_24h_pct<0) AS down,
  sum(volume_24h) AS volume,sum(market_cap) AS cap,max(as_of) AS updated,
  count(*) FILTER(WHERE matched_signal_direction='bullish') AS bullish,count(*) FILTER(WHERE matched_signal_direction='bearish') AS bearish,
  count(*) FILTER(WHERE matched_signal_direction='caution') AS caution,count(*) FILTER(WHERE matched_signal_direction='neutral') AS neutral,
  count(*) FILTER(WHERE unusual_volume) AS unusual,count(*) FILTER(WHERE vol_up_price_flat) AS flat,
  count(*) FILTER(WHERE price_up_liquidity_weak) AS weak,count(*) FILTER(WHERE multi_exchange_strength) AS multi,
  count(*) FILTER(WHERE thin_liquidity) AS thin FROM base)
 SELECT jsonb_build_object('records',COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM page_rows p),'[]'),
  'total',(SELECT count(*) FROM filtered),'page',$12,'limit',$10,
  'snapshot',(SELECT jsonb_build_object('universeLimit',1000,'universeTotal',(SELECT count(*) FROM public.market_assets),
    'universeTruncated',(SELECT count(*) FROM public.market_assets)>s.tracked,'enrichmentIncomplete',false,
    'trackedAssets',s.tracked,'marketCapUnavailableCount',s.tracked-s.cap_count,'up24h',s.up,'down24h',s.down,'trackedVolumeQuote24h',s.volume,'trackedMarketCap',s.cap,
    'marketCapCoveragePct',CASE WHEN s.tracked>0 THEN round(100.0*s.cap_count/s.tracked) ELSE 0 END,
    'cexCoveragePct',CASE WHEN s.tracked>0 THEN round(100.0*s.cex_count/s.tracked) ELSE 0 END,
    'signalCounts',jsonb_build_object('bullish',s.bullish,'bearish',s.bearish,'caution',s.caution,'neutral',s.neutral),'lastUpdated',s.updated) FROM summary s),
  'topGainers',COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM(SELECT * FROM base WHERE change_24h_pct>0 ORDER BY mover_score DESC,source_provider,provider_id LIMIT 10)g),'[]'),
  'topLosers',COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM(SELECT * FROM base WHERE change_24h_pct<0 ORDER BY mover_score DESC,source_provider,provider_id LIMIT 10)g),'[]'),
  'topByMarketCap',COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM(SELECT * FROM base WHERE market_cap IS NOT NULL ORDER BY market_cap DESC,source_provider,provider_id LIMIT 20)g),'[]'),
  'watchlistMovers',COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM(SELECT * FROM base WHERE on_watchlist AND change_24h_pct IS NOT NULL ORDER BY abs(change_24h_pct) DESC,source_provider,provider_id LIMIT 10)g),'[]'),
  'availableCategories',COALESCE((SELECT jsonb_agg(category ORDER BY category) FROM categories),'[]'),
  'categoryLeaders',COALESCE((SELECT jsonb_agg(jsonb_build_object('category',category,'leaders',leaders) ORDER BY score DESC,category) FROM category_leaders),'[]'),
  'derivedCounts',(SELECT jsonb_build_object('unusual_volume',unusual,'vol_up_price_flat',flat,'price_up_liq_weak',weak,'multi_exchange',multi,'thin_liquidity',thin) FROM summary),
  'crossExchangeSpreads',COALESCE((SELECT jsonb_agg(g.spread) FROM(SELECT DISTINCT ON(normalized_symbol) normalized_symbol,spread FROM base WHERE spread IS NOT NULL ORDER BY normalized_symbol LIMIT 200)g),'[]'),
  'chainHeatmap',COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM(SELECT * FROM public.exchange_latest_chain_rollups ORDER BY chain LIMIT 100)c),'[]'),
  'providerStatus',COALESCE((SELECT jsonb_agg(jsonb_build_object('provider',provider,'degraded',COALESCE(banned_until>now() OR rate_limited_until>now() OR consecutive_failures>=3,false),'last_ok_at',last_ok_at)) FROM public.exchange_market_providers),'[]')
 )
 $query$,v_order) INTO v_result USING p_org_id,v_search,v_chain,v_category,v_signal,v_watch,v_cap,v_exchange,v_view,v_limit,v_page*v_limit,v_page;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.intel_markets_screen_for_user(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_markets_screen_for_user(uuid,uuid,jsonb) TO service_role;
