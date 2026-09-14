-- Database-screened cached Markets universe. No provider calls and no second ledger.
-- The established top-1000 universe remains explicit; only the requested page and
-- bounded existing panels leave PostgreSQL. Contract lookup indexes avoid history scans.
CREATE OR REPLACE FUNCTION public.intel_market_chain(p_chain text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
 SELECT CASE lower(p_chain) WHEN 'arbitrum-one' THEN 'arbitrum' WHEN 'binance-smart-chain' THEN 'bnb'
  WHEN 'bsc' THEN 'bnb' WHEN 'polygon-pos' THEN 'polygon' WHEN 'polygon_pos' THEN 'polygon'
  WHEN 'optimistic-ethereum' THEN 'optimism' WHEN 'xdai' THEN 'gnosis' WHEN 'gnosischain' THEN 'gnosis'
  WHEN 'metis-andromeda' THEN 'metis' WHEN 'eth' THEN 'ethereum' WHEN 'avax' THEN 'avalanche'
  WHEN 'sui-network' THEN 'sui' ELSE lower(p_chain) END;
$$;
CREATE OR REPLACE FUNCTION public.intel_market_address(p_address text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
 SELECT CASE WHEN p_address ~* '^0x[0-9a-f]{40}$' THEN lower(p_address) ELSE p_address END;
$$;
CREATE INDEX IF NOT EXISTS intel_dex_contract_read ON public.dex_pair_snapshots
 (public.intel_market_chain(chain),public.intel_market_address(token_address),fetched_at DESC);
CREATE INDEX IF NOT EXISTS intel_meme_contract_read ON public.memecoin_latest_tokens
 (public.intel_market_chain(chain),public.intel_market_address(token_address));
CREATE INDEX IF NOT EXISTS intel_market_categories_read ON public.market_assets USING gin(categories);
CREATE INDEX IF NOT EXISTS intel_market_platforms_read ON public.market_assets USING gin(platforms);
CREATE INDEX IF NOT EXISTS intel_market_rank_identity_read ON public.market_assets(market_cap_rank ASC NULLS LAST,source_provider,provider_id);

-- A public cached-data view; invoker privileges/RLS continue to protect each table.
CREATE OR REPLACE VIEW public.intel_market_screen_rows WITH (security_invoker = true) AS
WITH canonical AS (
 SELECT a.* FROM public.market_assets a ORDER BY market_cap_rank ASC NULLS LAST,source_provider,provider_id LIMIT 1000
), identities AS (
 SELECT a.*,p.providers AS profile_providers,p.latest_price,p.latest_volume_quote_24h,
  p.signal_direction,p.signal_strength,p.signal_confidence,
  CASE WHEN p.normalized_symbol IS NULL THEN 'unknown'
    WHEN EXISTS (SELECT 1 FROM public.exchange_asset_mappings m
      WHERE m.is_active AND m.normalized_symbol=a.normalized_symbol AND (
       m.canonical_asset_id=a.source_provider||':'||a.provider_id OR
       (m.canonical_asset_id=a.provider_id AND NOT EXISTS(SELECT 1 FROM public.market_assets other
         WHERE other.provider_id=a.provider_id AND other.source_provider<>a.source_provider)) OR
       (m.chain IS NOT NULL AND m.contract_address IS NOT NULL AND EXISTS(
         SELECT 1 FROM jsonb_each_text(COALESCE(a.platforms,'{}')) platform
         WHERE public.intel_market_chain(platform.key)=public.intel_market_chain(m.chain)
           AND public.intel_market_address(platform.value)=public.intel_market_address(m.contract_address))))) THEN 'high'
    WHEN a.normalized_symbol NOT IN ('WBTC','WETH','WBETH','WEETH','CBBTC') AND
      (SELECT count(*) FROM public.market_assets other WHERE other.normalized_symbol=a.normalized_symbol)=1 THEN 'medium'
    ELSE 'low' END AS enrichment_confidence
 FROM canonical a LEFT JOIN public.exchange_latest_asset_profiles p ON p.normalized_symbol=a.normalized_symbol
), joined AS (
 SELECT a.*,
  CASE WHEN a.enrichment_confidence IN ('high','medium') THEN jsonb_build_object(
    'availableCount',COALESCE(NULLIF(t.provider_count,0),jsonb_array_length(CASE WHEN jsonb_typeof(a.profile_providers)='array' THEN a.profile_providers ELSE '[]' END),0),
    'providers',CASE WHEN t.provider_count>0 THEN t.providers ELSE CASE WHEN jsonb_typeof(a.profile_providers)='array' THEN a.profile_providers ELSE '[]' END END,
    'bestPrice',COALESCE(t.best_price,a.latest_price),'avgPrice',COALESCE(t.avg_price,a.latest_price),
    'volume24h',COALESCE(t.volume,a.latest_volume_quote_24h),
    'spreadPct',s.estimated_net_spread_pct,'arbPct',s.estimated_net_spread_pct,
    'arbBuy',s.buy_provider,'arbSell',s.sell_provider,
    'signalDirection',a.signal_direction,'signalStrength',a.signal_strength,'signalConfidence',a.signal_confidence,
    'marketContext',CASE WHEN sig.normalized_symbol IS NOT NULL THEN jsonb_build_object(
      'direction',sig.direction,'strength',sig.strength,'confidence',sig.confidence,'title',sig.title,
      'summary',sig.summary,'whyItMatters',sig.why_it_matters,'providerCount',sig.provider_count,
      'confirmingProviders',sig.confirming_providers,'factors',sig.factors,'source','exchange-market') ELSE NULL END
  ) ELSE NULL END AS cex,
  d.dex, CASE WHEN a.enrichment_confidence='high' THEN to_jsonb(s) ELSE NULL END AS spread
 FROM identities a
 LEFT JOIN LATERAL (
  SELECT count(DISTINCT provider) AS provider_count,jsonb_agg(DISTINCT provider) AS providers,
    min(price) FILTER(WHERE price>0) AS best_price,avg(price) FILTER(WHERE price>0) AS avg_price,sum(volume_quote_24h) AS volume
  FROM public.exchange_latest_tickers t WHERE t.normalized_symbol=a.normalized_symbol AND a.enrichment_confidence IN ('high','medium')
 ) t ON true
 LEFT JOIN public.exchange_latest_market_signals sig ON sig.normalized_symbol=a.normalized_symbol
 LEFT JOIN public.exchange_latest_cross_market_spreads s ON a.enrichment_confidence='high' AND s.normalized_symbol=a.normalized_symbol
  AND s.as_of BETWEEN now()-interval '3 minutes' AND now()+interval '30 seconds'
  AND s.confidence_score BETWEEN 70 AND 100
  AND s.lowest_ask_price>0 AND s.lowest_ask_price<'Infinity'::float8
  AND s.highest_bid_price>0 AND s.highest_bid_price<'Infinity'::float8
  AND s.buy_provider IS NOT NULL AND s.sell_provider IS NOT NULL AND s.buy_provider<>s.sell_provider
  AND s.estimated_net_spread_pct IS NOT NULL AND s.estimated_net_spread_pct NOT IN ('Infinity'::float8,'-Infinity'::float8,'NaN'::float8)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(s.caution_flags,'[]')) f
    WHERE f ~* 'stale|depeg|normalization assumed|low liquidity')
 LEFT JOIN LATERAL (
  SELECT candidates.dex FROM jsonb_each_text(COALESCE(a.platforms,'{}')) platform
  CROSS JOIN LATERAL (
   SELECT jsonb_build_object('liquidityUsd',m.liquidity_usd,'volume24hUsd',m.volume_24h_usd,
    'priceUsd',m.price_usd,'marketCap',m.market_cap,'fdv',m.fdv,'pairAddress',m.pair_address,
    'sourceUrl',m.source_url,'fetchedAt',m.as_of,'chain',public.intel_market_chain(m.chain)) AS dex,
    m.as_of AS observed,0 AS priority
   FROM public.memecoin_latest_tokens m
   WHERE public.intel_market_chain(m.chain)=public.intel_market_chain(platform.key)
     AND public.intel_market_address(m.token_address)=public.intel_market_address(platform.value)
   UNION ALL
   SELECT jsonb_build_object('liquidityUsd',x.liquidity_usd,'volume24hUsd',x.volume_24h,
    'priceUsd',x.price_usd,'marketCap',x.market_cap,'fdv',x.fdv,'pairAddress',x.pair_address,
    'sourceUrl',x.source_ref,'fetchedAt',x.fetched_at,'chain',public.intel_market_chain(x.chain)),x.fetched_at,1
   FROM (SELECT * FROM public.dex_pair_snapshots x
     WHERE public.intel_market_chain(x.chain)=public.intel_market_chain(platform.key)
       AND public.intel_market_address(x.token_address)=public.intel_market_address(platform.value)
     ORDER BY x.fetched_at DESC,x.pair_address LIMIT 1) x
  ) candidates
  ORDER BY candidates.observed DESC NULLS LAST,candidates.priority,platform.key LIMIT 1
 ) d ON true
), flags AS (
 SELECT j.*,COALESCE((cex->>'availableCount')::int,0) AS available_count,
  CASE WHEN cex IS NOT NULL THEN signal_direction ELSE NULL END AS matched_signal_direction,
  COALESCE(derived->'unusual_volume'='true'::jsonb,false) AS unusual_volume,
  CASE WHEN jsonb_typeof(derived->'volume_ratio')='number' THEN (derived->>'volume_ratio')::float8 ELSE NULL END AS volume_ratio,
  COALESCE(derived->'vol_up_price_flat'='true'::jsonb,false) AS vol_up_price_flat,
  COALESCE(change_24h_pct>5 AND (dex->>'liquidityUsd')::float8<50000,false) AS price_up_liquidity_weak,
  COALESCE((cex->>'availableCount')::int>=3 AND signal_direction='bullish'
   AND jsonb_array_length(CASE WHEN jsonb_typeof(cex->'marketContext'->'confirmingProviders')='array' THEN cex->'marketContext'->'confirmingProviders' ELSE '[]' END)>=2,false) AS multi_exchange_strength,
  COALESCE((dex->>'liquidityUsd')::float8<25000,false) OR
   (cex IS NOT NULL AND (cex->>'availableCount')::int=1 AND market_cap<20000000) AS thin_liquidity,
  COALESCE(enrichment_confidence='high' AND (cex->>'spreadPct')::float8>=1.5,false) AS spread_caution,
  0.6*LEAST(abs(COALESCE(change_24h_pct,0))/25,1)+0.4*LEAST(log(GREATEST(1,COALESCE(market_cap,1))) / 12,1) AS mover_score
 FROM joined j
)
SELECT f.*,jsonb_build_object('unusualVolume',unusual_volume,'volumeRatio',volume_ratio,'volUpPriceFlat',vol_up_price_flat,
 'priceUpLiquidityWeak',price_up_liquidity_weak,'multiExchangeStrength',multi_exchange_strength,
 'thinLiquidity',COALESCE(thin_liquidity,false),'spreadCaution',spread_caution,
 'cautionFlags',to_jsonb(array_remove(ARRAY[CASE WHEN thin_liquidity THEN 'thin_liquidity' END,
   CASE WHEN price_up_liquidity_weak THEN 'price_up_liquidity_weak' END,CASE WHEN spread_caution THEN 'wide_spread' END],NULL))) AS flags
FROM flags f;
GRANT SELECT ON public.intel_market_screen_rows TO authenticated;

CREATE OR REPLACE FUNCTION public.intel_markets_screen(p_org_id uuid,p_query jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_page int; v_limit int; v_sort text; v_search text; v_chain text; v_category text;
 v_signal text; v_cap text; v_exchange text; v_view text; v_watch boolean;
 v_order text; v_result jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='42501'; END IF;
 IF p_org_id IS NULL OR p_org_id IS DISTINCT FROM public.get_my_org_id() THEN RAISE EXCEPTION 'Workspace changed' USING ERRCODE='42501'; END IF;
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
REVOKE ALL ON FUNCTION public.intel_markets_screen(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_markets_screen(uuid,jsonb) TO authenticated;
