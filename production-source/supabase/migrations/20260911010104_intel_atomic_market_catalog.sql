-- Catalogue membership is a public market snapshot, separate from retained asset records.
ALTER TABLE public.market_assets ADD COLUMN IF NOT EXISTS in_current_catalog boolean NOT NULL DEFAULT true;
-- Existing CMC broad writes used one real server recording time for their full run.
UPDATE public.market_assets a SET in_current_catalog=COALESCE(a.last_refreshed_at=(SELECT max(last_refreshed_at) FROM public.market_assets WHERE source_provider='coinmarketcap'),false) WHERE a.source_provider='coinmarketcap';
CREATE INDEX IF NOT EXISTS intel_market_current_catalog_rank ON public.market_assets(source_provider,in_current_catalog,market_cap_rank,provider_id);
CREATE OR REPLACE FUNCTION public.intel_replace_market_catalog(p_provider text,p_rows jsonb,p_expected_count int)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $catalog$
DECLARE v_count int;v_at timestamptz;v_ids text[];
BEGIN
 IF p_provider IS DISTINCT FROM 'coinmarketcap' OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR p_expected_count IS NULL OR p_expected_count NOT BETWEEN 1 AND 5000 OR jsonb_array_length(p_rows)<>p_expected_count OR octet_length(p_rows::text)>8000000 THEN RAISE EXCEPTION 'Invalid catalogue snapshot' USING ERRCODE='22023';END IF;
 SELECT count(DISTINCT provider_id),min(last_refreshed_at),array_agg(provider_id) INTO v_count,v_at,v_ids FROM jsonb_populate_recordset(NULL::public.market_assets,p_rows);
 IF v_count<>p_expected_count OR EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::public.market_assets,p_rows) x WHERE x.source_provider IS DISTINCT FROM p_provider OR x.provider_id !~ '^[1-9][0-9]{0,9}$' OR nullif(x.symbol,'') IS NULL OR x.last_refreshed_at IS DISTINCT FROM v_at OR x.as_of IS NULL OR x.as_of>now()+interval '30 seconds' OR (x.current_price IS NOT NULL AND NOT(x.current_price>=0 AND x.current_price<'Infinity'::float8))) OR v_at IS NULL OR v_at>now()+interval '30 seconds' OR v_at<now()-interval '1 hour' THEN RAISE EXCEPTION 'Invalid catalogue row' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('intel-market-catalog:'||p_provider,0));
 IF EXISTS(SELECT 1 FROM public.market_assets WHERE source_provider=p_provider AND last_refreshed_at>v_at) THEN RETURN jsonb_build_object('written',0,'superseded',true);END IF;
 INSERT INTO public.market_assets(source_provider,provider_id,provider_slug,symbol,name,normalized_symbol,primary_chain,market_cap_rank,current_price,market_cap,fdv,circulating_supply,total_supply,max_supply,volume_24h,change_1h_pct,change_24h_pct,change_7d_pct,categories,platforms,image_url,image_source,image_last_checked_at,image_fallback_type,source_url,source_label,attribution_label,confidence,last_refreshed_at,as_of,updated_at,quote_batch_ids,in_current_catalog)
 SELECT x.source_provider,x.provider_id,x.provider_slug,x.symbol,x.name,x.normalized_symbol,x.primary_chain,x.market_cap_rank,x.current_price,x.market_cap,x.fdv,x.circulating_supply,x.total_supply,x.max_supply,x.volume_24h,x.change_1h_pct,x.change_24h_pct,x.change_7d_pct,x.categories,x.platforms,x.image_url,x.image_source,x.image_last_checked_at,x.image_fallback_type,x.source_url,x.source_label,x.attribution_label,x.confidence,x.last_refreshed_at,x.as_of,x.updated_at,x.quote_batch_ids,true FROM jsonb_populate_recordset(NULL::public.market_assets,p_rows) x
 ON CONFLICT(source_provider,provider_id) DO UPDATE SET provider_slug=EXCLUDED.provider_slug,symbol=EXCLUDED.symbol,name=EXCLUDED.name,normalized_symbol=EXCLUDED.normalized_symbol,primary_chain=EXCLUDED.primary_chain,market_cap_rank=EXCLUDED.market_cap_rank,current_price=EXCLUDED.current_price,market_cap=EXCLUDED.market_cap,fdv=EXCLUDED.fdv,circulating_supply=EXCLUDED.circulating_supply,total_supply=EXCLUDED.total_supply,max_supply=EXCLUDED.max_supply,volume_24h=EXCLUDED.volume_24h,change_1h_pct=EXCLUDED.change_1h_pct,change_24h_pct=EXCLUDED.change_24h_pct,change_7d_pct=EXCLUDED.change_7d_pct,categories=EXCLUDED.categories,platforms=EXCLUDED.platforms,image_url=EXCLUDED.image_url,image_source=EXCLUDED.image_source,image_last_checked_at=EXCLUDED.image_last_checked_at,image_fallback_type=EXCLUDED.image_fallback_type,source_url=EXCLUDED.source_url,source_label=EXCLUDED.source_label,attribution_label=EXCLUDED.attribution_label,confidence=EXCLUDED.confidence,last_refreshed_at=EXCLUDED.last_refreshed_at,as_of=EXCLUDED.as_of,updated_at=EXCLUDED.updated_at,quote_batch_ids=EXCLUDED.quote_batch_ids,in_current_catalog=true;
 UPDATE public.market_assets SET in_current_catalog=false WHERE source_provider=p_provider AND in_current_catalog AND NOT(provider_id=ANY(v_ids));
 RETURN jsonb_build_object('written',p_expected_count,'superseded',false);
END $catalog$;
REVOKE ALL ON FUNCTION public.intel_replace_market_catalog(text,jsonb,int) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_replace_market_catalog(text,jsonb,int) TO service_role;

-- Reviewed native provider IDs bind to the established native exchange feeds.
-- A second catalogue must not make those identities ambiguous. Wrapped assets and same-symbol tokens remain unverified.
-- Legacy readers retain their existing single-source universe.
CREATE OR REPLACE VIEW public.intel_market_screen_rows WITH (security_invoker=true) AS
 WITH canonical AS (
         SELECT a.source_provider,
            a.provider_id,
            a.provider_slug,
            a.symbol,
            a.name,
            a.normalized_symbol,
            a.primary_chain,
            a.market_cap_rank,
            a.current_price,
            a.market_cap,
            a.fdv,
            a.circulating_supply,
            a.total_supply,
            a.max_supply,
            a.volume_24h,
            a.change_1h_pct,
            a.change_24h_pct,
            a.change_7d_pct,
            a.categories,
            a.platforms,
            a.image_url,
            a.cached_image_url,
            a.image_source,
            a.image_fallback_type,
            a.image_last_checked_at,
            a.image_verified_at,
            a.image_error_count,
            a.source_url,
            a.source_label,
            a.attribution_label,
            a.confidence,
            a.last_refreshed_at,
            a.as_of,
            a.created_at,
            a.updated_at,
            a.derived,
            a.quote_batch_ids
           FROM market_assets a
          WHERE a.source_provider = CASE WHEN EXISTS(SELECT 1 FROM public.market_assets cm WHERE cm.source_provider='coingecko') THEN 'coingecko' ELSE 'coinmarketcap' END
          ORDER BY a.market_cap_rank, a.source_provider, a.provider_id
         LIMIT 1000
        ), identities AS (
         SELECT a.source_provider,
            a.provider_id,
            a.provider_slug,
            a.symbol,
            a.name,
            a.normalized_symbol,
            a.primary_chain,
            a.market_cap_rank,
            a.current_price,
            a.market_cap,
            a.fdv,
            a.circulating_supply,
            a.total_supply,
            a.max_supply,
            a.volume_24h,
            a.change_1h_pct,
            a.change_24h_pct,
            a.change_7d_pct,
            a.categories,
            a.platforms,
            a.image_url,
            a.cached_image_url,
            a.image_source,
            a.image_fallback_type,
            a.image_last_checked_at,
            a.image_verified_at,
            a.image_error_count,
            a.source_url,
            a.source_label,
            a.attribution_label,
            a.confidence,
            a.last_refreshed_at,
            a.as_of,
            a.created_at,
            a.updated_at,
            a.derived,
            a.quote_batch_ids,
            p.providers AS profile_providers,
            p.latest_price,
            p.latest_volume_quote_24h,
            p.signal_direction,
            p.signal_strength,
            p.signal_confidence,
                CASE
                    WHEN p.normalized_symbol IS NULL THEN 'unknown'::text
                    WHEN a.normalized_symbol = CASE a.source_provider||':'||a.provider_id
                      WHEN 'coinmarketcap:1' THEN 'BTC' WHEN 'coingecko:bitcoin' THEN 'BTC'
                      WHEN 'coinmarketcap:1027' THEN 'ETH' WHEN 'coingecko:ethereum' THEN 'ETH'
                      WHEN 'coinmarketcap:5426' THEN 'SOL' WHEN 'coingecko:solana' THEN 'SOL'
                      WHEN 'coinmarketcap:1839' THEN 'BNB' WHEN 'coingecko:binancecoin' THEN 'BNB'
                      WHEN 'coinmarketcap:5805' THEN 'AVAX' WHEN 'coingecko:avalanche-2' THEN 'AVAX' END THEN 'high'::text
                    WHEN (EXISTS ( SELECT 1
                       FROM exchange_asset_mappings m
                      WHERE m.is_active AND m.normalized_symbol = a.normalized_symbol AND (m.canonical_asset_id = ((a.source_provider || ':'::text) || a.provider_id) OR m.canonical_asset_id = a.provider_id AND NOT (EXISTS ( SELECT 1
                               FROM market_assets other
                              WHERE other.provider_id = a.provider_id AND other.source_provider <> a.source_provider)) OR m.chain IS NOT NULL AND m.contract_address IS NOT NULL AND (EXISTS ( SELECT 1
                               FROM jsonb_each_text(COALESCE(a.platforms, '{}'::jsonb)) platform(key, value)
                              WHERE intel_market_chain(platform.key) = intel_market_chain(m.chain) AND intel_market_address(platform.value) = intel_market_address(m.contract_address)))))) THEN 'high'::text
                    WHEN (a.normalized_symbol <> ALL (ARRAY['WBTC'::text, 'WETH'::text, 'WBETH'::text, 'WEETH'::text, 'CBBTC'::text])) AND (( SELECT count(*) AS count
                       FROM market_assets other
                      WHERE other.normalized_symbol = a.normalized_symbol)) = 1 THEN 'medium'::text
                    ELSE 'low'::text
                END AS enrichment_confidence
           FROM canonical a
             LEFT JOIN exchange_latest_asset_profiles p ON p.normalized_symbol = a.normalized_symbol
        ), joined AS (
         SELECT a.source_provider,
            a.provider_id,
            a.provider_slug,
            a.symbol,
            a.name,
            a.normalized_symbol,
            a.primary_chain,
            a.market_cap_rank,
            a.current_price,
            a.market_cap,
            a.fdv,
            a.circulating_supply,
            a.total_supply,
            a.max_supply,
            a.volume_24h,
            a.change_1h_pct,
            a.change_24h_pct,
            a.change_7d_pct,
            a.categories,
            a.platforms,
            a.image_url,
            a.cached_image_url,
            a.image_source,
            a.image_fallback_type,
            a.image_last_checked_at,
            a.image_verified_at,
            a.image_error_count,
            a.source_url,
            a.source_label,
            a.attribution_label,
            a.confidence,
            a.last_refreshed_at,
            a.as_of,
            a.created_at,
            a.updated_at,
            a.derived,
            a.quote_batch_ids,
            a.profile_providers,
            a.latest_price,
            a.latest_volume_quote_24h,
            a.signal_direction,
            a.signal_strength,
            a.signal_confidence,
            a.enrichment_confidence,
                CASE
                    WHEN a.enrichment_confidence = ANY (ARRAY['high'::text, 'medium'::text]) THEN jsonb_build_object('availableCount', COALESCE(NULLIF(t.provider_count, 0), jsonb_array_length(
                    CASE
                        WHEN jsonb_typeof(a.profile_providers) = 'array'::text THEN a.profile_providers
                        ELSE '[]'::jsonb
                    END)::bigint, 0::bigint), 'providers',
                    CASE
                        WHEN t.provider_count > 0 THEN t.providers
                        ELSE
                        CASE
                            WHEN jsonb_typeof(a.profile_providers) = 'array'::text THEN a.profile_providers
                            ELSE '[]'::jsonb
                        END
                    END, 'bestPrice', COALESCE(t.best_price, a.latest_price), 'avgPrice', COALESCE(t.avg_price, a.latest_price), 'volume24h', COALESCE(t.volume, a.latest_volume_quote_24h), 'spreadPct', s.estimated_net_spread_pct, 'arbPct', s.estimated_net_spread_pct, 'arbBuy', s.buy_provider, 'arbSell', s.sell_provider, 'signalDirection', a.signal_direction, 'signalStrength', a.signal_strength, 'signalConfidence', a.signal_confidence, 'marketContext',
                    CASE
                        WHEN sig.normalized_symbol IS NOT NULL THEN jsonb_build_object('direction', sig.direction, 'strength', sig.strength, 'confidence', sig.confidence, 'title', sig.title, 'summary', sig.summary, 'whyItMatters', sig.why_it_matters, 'providerCount', sig.provider_count, 'confirmingProviders', sig.confirming_providers, 'factors', sig.factors, 'source', 'exchange-market')
                        ELSE NULL::jsonb
                    END)
                    ELSE NULL::jsonb
                END AS cex,
            d.dex,
                CASE
                    WHEN a.enrichment_confidence = 'high'::text THEN to_jsonb(s.*)
                    ELSE NULL::jsonb
                END AS spread
           FROM identities a
             LEFT JOIN LATERAL ( SELECT count(DISTINCT t_1.provider) AS provider_count,
                    jsonb_agg(DISTINCT t_1.provider) AS providers,
                    min(t_1.price) FILTER (WHERE t_1.price > 0::double precision) AS best_price,
                    avg(t_1.price) FILTER (WHERE t_1.price > 0::double precision) AS avg_price,
                    sum(t_1.volume_quote_24h) AS volume
                   FROM exchange_latest_tickers t_1
                  WHERE t_1.normalized_symbol = a.normalized_symbol AND (a.enrichment_confidence = ANY (ARRAY['high'::text, 'medium'::text]))) t ON true
             LEFT JOIN exchange_latest_market_signals sig ON sig.normalized_symbol = a.normalized_symbol
             LEFT JOIN exchange_latest_cross_market_spreads s ON a.enrichment_confidence = 'high'::text AND s.normalized_symbol = a.normalized_symbol AND s.as_of >= (now() - '00:03:00'::interval) AND s.as_of <= (now() + '00:00:30'::interval) AND s.confidence_score >= 70::double precision AND s.confidence_score <= 100::double precision AND s.lowest_ask_price > 0::double precision AND s.lowest_ask_price < 'Infinity'::double precision AND s.highest_bid_price > 0::double precision AND s.highest_bid_price < 'Infinity'::double precision AND s.buy_provider IS NOT NULL AND s.sell_provider IS NOT NULL AND s.buy_provider <> s.sell_provider AND s.estimated_net_spread_pct IS NOT NULL AND (s.estimated_net_spread_pct <> ALL (ARRAY['Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision])) AND NOT (EXISTS ( SELECT 1
                   FROM jsonb_array_elements_text(COALESCE(s.caution_flags, '[]'::jsonb)) f_1(value)
                  WHERE f_1.value ~* 'stale|depeg|normalization assumed|low liquidity'::text))
             LEFT JOIN LATERAL ( SELECT candidates.dex
                   FROM jsonb_each_text(COALESCE(a.platforms, '{}'::jsonb)) platform(key, value)
                     CROSS JOIN LATERAL ( SELECT jsonb_build_object('liquidityUsd', m.liquidity_usd, 'volume24hUsd', m.volume_24h_usd, 'priceUsd', m.price_usd, 'marketCap', m.market_cap, 'fdv', m.fdv, 'pairAddress', m.pair_address, 'sourceUrl', m.source_url, 'fetchedAt', m.as_of, 'chain', intel_market_chain(m.chain)) AS dex,
                            m.as_of AS observed,
                            0 AS priority
                           FROM memecoin_latest_tokens m
                          WHERE intel_market_chain(m.chain) = intel_market_chain(platform.key) AND intel_market_address(m.token_address) = intel_market_address(platform.value)
                        UNION ALL
                         SELECT jsonb_build_object('liquidityUsd', x.liquidity_usd, 'volume24hUsd', x.volume_24h, 'priceUsd', x.price_usd, 'marketCap', x.market_cap, 'fdv', x.fdv, 'pairAddress', x.pair_address, 'sourceUrl', x.source_ref, 'fetchedAt', x.fetched_at, 'chain', intel_market_chain(x.chain)) AS jsonb_build_object,
                            x.fetched_at,
                            1
                           FROM ( SELECT x_1.id,
                                    x_1.chain,
                                    x_1.token_address,
                                    x_1.pair_address,
                                    x_1.dex_id,
                                    x_1.symbol,
                                    x_1.name,
                                    x_1.price_usd,
                                    x_1.liquidity_usd,
                                    x_1.fdv,
                                    x_1.market_cap,
                                    x_1.volume_24h,
                                    x_1.txns_24h,
                                    x_1.price_change,
                                    x_1.socials,
                                    x_1.links,
                                    x_1.pair_created_at,
                                    x_1.intelligence_ref,
                                    x_1.intelligence_entity_id,
                                    x_1.target_source,
                                    x_1.provider,
                                    x_1.source_ref,
                                    x_1.fetched_at,
                                    x_1.stale_after,
                                    x_1.confidence,
                                    x_1.raw_response,
                                    x_1.snapshot_bucket,
                                    x_1.updated_at
                                   FROM dex_pair_snapshots x_1
                                  WHERE intel_market_chain(x_1.chain) = intel_market_chain(platform.key) AND intel_market_address(x_1.token_address) = intel_market_address(platform.value)
                                  ORDER BY x_1.fetched_at DESC, x_1.pair_address
                                 LIMIT 1) x) candidates
                  ORDER BY candidates.observed DESC NULLS LAST, candidates.priority, platform.key
                 LIMIT 1) d ON true
        ), flags AS (
         SELECT j.source_provider,
            j.provider_id,
            j.provider_slug,
            j.symbol,
            j.name,
            j.normalized_symbol,
            j.primary_chain,
            j.market_cap_rank,
            j.current_price,
            j.market_cap,
            j.fdv,
            j.circulating_supply,
            j.total_supply,
            j.max_supply,
            j.volume_24h,
            j.change_1h_pct,
            j.change_24h_pct,
            j.change_7d_pct,
            j.categories,
            j.platforms,
            j.image_url,
            j.cached_image_url,
            j.image_source,
            j.image_fallback_type,
            j.image_last_checked_at,
            j.image_verified_at,
            j.image_error_count,
            j.source_url,
            j.source_label,
            j.attribution_label,
            j.confidence,
            j.last_refreshed_at,
            j.as_of,
            j.created_at,
            j.updated_at,
            j.derived,
            j.quote_batch_ids,
            j.profile_providers,
            j.latest_price,
            j.latest_volume_quote_24h,
            j.signal_direction,
            j.signal_strength,
            j.signal_confidence,
            j.enrichment_confidence,
            j.cex,
            j.dex,
            j.spread,
            COALESCE((j.cex ->> 'availableCount'::text)::integer, 0) AS available_count,
                CASE
                    WHEN j.cex IS NOT NULL THEN j.signal_direction
                    ELSE NULL::text
                END AS matched_signal_direction,
            COALESCE((j.derived -> 'unusual_volume'::text) = 'true'::jsonb, false) AS unusual_volume,
                CASE
                    WHEN jsonb_typeof(j.derived -> 'volume_ratio'::text) = 'number'::text THEN (j.derived ->> 'volume_ratio'::text)::double precision
                    ELSE NULL::double precision
                END AS volume_ratio,
            COALESCE((j.derived -> 'vol_up_price_flat'::text) = 'true'::jsonb, false) AS vol_up_price_flat,
            COALESCE(j.change_24h_pct > 5::double precision AND ((j.dex ->> 'liquidityUsd'::text)::double precision) < 50000::double precision, false) AS price_up_liquidity_weak,
            COALESCE(((j.cex ->> 'availableCount'::text)::integer) >= 3 AND j.signal_direction = 'bullish'::text AND jsonb_array_length(
                CASE
                    WHEN jsonb_typeof((j.cex -> 'marketContext'::text) -> 'confirmingProviders'::text) = 'array'::text THEN (j.cex -> 'marketContext'::text) -> 'confirmingProviders'::text
                    ELSE '[]'::jsonb
                END) >= 2, false) AS multi_exchange_strength,
            COALESCE(((j.dex ->> 'liquidityUsd'::text)::double precision) < 25000::double precision, false) OR j.cex IS NOT NULL AND ((j.cex ->> 'availableCount'::text)::integer) = 1 AND j.market_cap < 20000000::double precision AS thin_liquidity,
            COALESCE(j.enrichment_confidence = 'high'::text AND ((j.cex ->> 'spreadPct'::text)::double precision) >= 1.5::double precision, false) AS spread_caution,
            0.6::double precision * LEAST(abs(COALESCE(j.change_24h_pct, 0::double precision)) / 25::double precision, 1::double precision) + 0.4::double precision * LEAST(log(GREATEST(1::double precision, COALESCE(j.market_cap, 1::double precision))) / 12::double precision, 1::double precision) AS mover_score
           FROM joined j
        )
 SELECT source_provider,
    provider_id,
    provider_slug,
    symbol,
    name,
    normalized_symbol,
    primary_chain,
    market_cap_rank,
    current_price,
    market_cap,
    fdv,
    circulating_supply,
    total_supply,
    max_supply,
    volume_24h,
    change_1h_pct,
    change_24h_pct,
    change_7d_pct,
    categories,
    platforms,
    image_url,
    cached_image_url,
    image_source,
    image_fallback_type,
    image_last_checked_at,
    image_verified_at,
    image_error_count,
    source_url,
    source_label,
    attribution_label,
    confidence,
    last_refreshed_at,
    as_of,
    created_at,
    updated_at,
    derived,
    quote_batch_ids,
    profile_providers,
    latest_price,
    latest_volume_quote_24h,
    signal_direction,
    signal_strength,
    signal_confidence,
    enrichment_confidence,
    cex,
    dex,
    spread,
    available_count,
    matched_signal_direction,
    unusual_volume,
    volume_ratio,
    vol_up_price_flat,
    price_up_liquidity_weak,
    multi_exchange_strength,
    thin_liquidity,
    spread_caution,
    mover_score,
    jsonb_build_object('unusualVolume', unusual_volume, 'volumeRatio', volume_ratio, 'volUpPriceFlat', vol_up_price_flat, 'priceUpLiquidityWeak', price_up_liquidity_weak, 'multiExchangeStrength', multi_exchange_strength, 'thinLiquidity', COALESCE(thin_liquidity, false), 'spreadCaution', spread_caution, 'cautionFlags', to_jsonb(array_remove(ARRAY[
        CASE
            WHEN thin_liquidity THEN 'thin_liquidity'::text
            ELSE NULL::text
        END,
        CASE
            WHEN price_up_liquidity_weak THEN 'price_up_liquidity_weak'::text
            ELSE NULL::text
        END,
        CASE
            WHEN spread_caution THEN 'wide_spread'::text
            ELSE NULL::text
        END], NULL::text))) AS flags
   FROM flags f;

-- Each catalogue is bounded before enrichment. Provider identity remains explicit.
CREATE OR REPLACE VIEW public.intel_market_screen_source_rows WITH (security_invoker=true) AS
 WITH canonical AS (
         SELECT a.source_provider,
            a.provider_id,
            a.provider_slug,
            a.symbol,
            a.name,
            a.normalized_symbol,
            a.primary_chain,
            a.market_cap_rank,
            a.current_price,
            a.market_cap,
            a.fdv,
            a.circulating_supply,
            a.total_supply,
            a.max_supply,
            a.volume_24h,
            a.change_1h_pct,
            a.change_24h_pct,
            a.change_7d_pct,
            a.categories,
            a.platforms,
            a.image_url,
            a.cached_image_url,
            a.image_source,
            a.image_fallback_type,
            a.image_last_checked_at,
            a.image_verified_at,
            a.image_error_count,
            a.source_url,
            a.source_label,
            a.attribution_label,
            a.confidence,
            a.last_refreshed_at,
            a.as_of,
            a.created_at,
            a.updated_at,
            a.derived,
            a.quote_batch_ids
           FROM (VALUES ('coinmarketcap'::text),('coingecko'::text)) providers(id)
           CROSS JOIN LATERAL (SELECT * FROM public.market_assets m WHERE m.source_provider=providers.id AND m.in_current_catalog ORDER BY m.market_cap_rank ASC NULLS LAST,m.provider_id LIMIT 1000) a
        ), identities AS (
         SELECT a.source_provider,
            a.provider_id,
            a.provider_slug,
            a.symbol,
            a.name,
            a.normalized_symbol,
            a.primary_chain,
            a.market_cap_rank,
            a.current_price,
            a.market_cap,
            a.fdv,
            a.circulating_supply,
            a.total_supply,
            a.max_supply,
            a.volume_24h,
            a.change_1h_pct,
            a.change_24h_pct,
            a.change_7d_pct,
            a.categories,
            a.platforms,
            a.image_url,
            a.cached_image_url,
            a.image_source,
            a.image_fallback_type,
            a.image_last_checked_at,
            a.image_verified_at,
            a.image_error_count,
            a.source_url,
            a.source_label,
            a.attribution_label,
            a.confidence,
            a.last_refreshed_at,
            a.as_of,
            a.created_at,
            a.updated_at,
            a.derived,
            a.quote_batch_ids,
            p.providers AS profile_providers,
            p.latest_price,
            p.latest_volume_quote_24h,
            p.signal_direction,
            p.signal_strength,
            p.signal_confidence,
                CASE
                    WHEN p.normalized_symbol IS NULL THEN 'unknown'::text
                    WHEN a.normalized_symbol = CASE a.source_provider||':'||a.provider_id
                      WHEN 'coinmarketcap:1' THEN 'BTC' WHEN 'coingecko:bitcoin' THEN 'BTC'
                      WHEN 'coinmarketcap:1027' THEN 'ETH' WHEN 'coingecko:ethereum' THEN 'ETH'
                      WHEN 'coinmarketcap:5426' THEN 'SOL' WHEN 'coingecko:solana' THEN 'SOL'
                      WHEN 'coinmarketcap:1839' THEN 'BNB' WHEN 'coingecko:binancecoin' THEN 'BNB'
                      WHEN 'coinmarketcap:5805' THEN 'AVAX' WHEN 'coingecko:avalanche-2' THEN 'AVAX' END THEN 'high'::text
                    WHEN (EXISTS ( SELECT 1
                       FROM exchange_asset_mappings m
                      WHERE m.is_active AND m.normalized_symbol = a.normalized_symbol AND (m.canonical_asset_id = ((a.source_provider || ':'::text) || a.provider_id) OR m.canonical_asset_id = a.provider_id AND NOT (EXISTS ( SELECT 1
                               FROM market_assets other
                              WHERE other.provider_id = a.provider_id AND other.source_provider <> a.source_provider)) OR m.chain IS NOT NULL AND m.contract_address IS NOT NULL AND (EXISTS ( SELECT 1
                               FROM jsonb_each_text(COALESCE(a.platforms, '{}'::jsonb)) platform(key, value)
                              WHERE intel_market_chain(platform.key) = intel_market_chain(m.chain) AND intel_market_address(platform.value) = intel_market_address(m.contract_address)))))) THEN 'high'::text
                    WHEN (a.normalized_symbol <> ALL (ARRAY['WBTC'::text, 'WETH'::text, 'WBETH'::text, 'WEETH'::text, 'CBBTC'::text])) AND (( SELECT count(*) AS count
                       FROM market_assets other
                      WHERE other.normalized_symbol = a.normalized_symbol)) = 1 THEN 'medium'::text
                    ELSE 'low'::text
                END AS enrichment_confidence
           FROM canonical a
             LEFT JOIN exchange_latest_asset_profiles p ON p.normalized_symbol = a.normalized_symbol
        ), joined AS (
         SELECT a.source_provider,
            a.provider_id,
            a.provider_slug,
            a.symbol,
            a.name,
            a.normalized_symbol,
            a.primary_chain,
            a.market_cap_rank,
            a.current_price,
            a.market_cap,
            a.fdv,
            a.circulating_supply,
            a.total_supply,
            a.max_supply,
            a.volume_24h,
            a.change_1h_pct,
            a.change_24h_pct,
            a.change_7d_pct,
            a.categories,
            a.platforms,
            a.image_url,
            a.cached_image_url,
            a.image_source,
            a.image_fallback_type,
            a.image_last_checked_at,
            a.image_verified_at,
            a.image_error_count,
            a.source_url,
            a.source_label,
            a.attribution_label,
            a.confidence,
            a.last_refreshed_at,
            a.as_of,
            a.created_at,
            a.updated_at,
            a.derived,
            a.quote_batch_ids,
            a.profile_providers,
            a.latest_price,
            a.latest_volume_quote_24h,
            a.signal_direction,
            a.signal_strength,
            a.signal_confidence,
            a.enrichment_confidence,
                CASE
                    WHEN a.enrichment_confidence = ANY (ARRAY['high'::text, 'medium'::text]) THEN jsonb_build_object('availableCount', COALESCE(NULLIF(t.provider_count, 0), jsonb_array_length(
                    CASE
                        WHEN jsonb_typeof(a.profile_providers) = 'array'::text THEN a.profile_providers
                        ELSE '[]'::jsonb
                    END)::bigint, 0::bigint), 'providers',
                    CASE
                        WHEN t.provider_count > 0 THEN t.providers
                        ELSE
                        CASE
                            WHEN jsonb_typeof(a.profile_providers) = 'array'::text THEN a.profile_providers
                            ELSE '[]'::jsonb
                        END
                    END, 'bestPrice', COALESCE(t.best_price, a.latest_price), 'avgPrice', COALESCE(t.avg_price, a.latest_price), 'volume24h', COALESCE(t.volume, a.latest_volume_quote_24h), 'spreadPct', s.estimated_net_spread_pct, 'arbPct', s.estimated_net_spread_pct, 'arbBuy', s.buy_provider, 'arbSell', s.sell_provider, 'signalDirection', a.signal_direction, 'signalStrength', a.signal_strength, 'signalConfidence', a.signal_confidence, 'marketContext',
                    CASE
                        WHEN sig.normalized_symbol IS NOT NULL THEN jsonb_build_object('direction', sig.direction, 'strength', sig.strength, 'confidence', sig.confidence, 'title', sig.title, 'summary', sig.summary, 'whyItMatters', sig.why_it_matters, 'providerCount', sig.provider_count, 'confirmingProviders', sig.confirming_providers, 'factors', sig.factors, 'source', 'exchange-market')
                        ELSE NULL::jsonb
                    END)
                    ELSE NULL::jsonb
                END AS cex,
            d.dex,
                CASE
                    WHEN a.enrichment_confidence = 'high'::text THEN to_jsonb(s.*)
                    ELSE NULL::jsonb
                END AS spread
           FROM identities a
             LEFT JOIN LATERAL ( SELECT count(DISTINCT t_1.provider) AS provider_count,
                    jsonb_agg(DISTINCT t_1.provider) AS providers,
                    min(t_1.price) FILTER (WHERE t_1.price > 0::double precision) AS best_price,
                    avg(t_1.price) FILTER (WHERE t_1.price > 0::double precision) AS avg_price,
                    sum(t_1.volume_quote_24h) AS volume
                   FROM exchange_latest_tickers t_1
                  WHERE t_1.normalized_symbol = a.normalized_symbol AND (a.enrichment_confidence = ANY (ARRAY['high'::text, 'medium'::text]))) t ON true
             LEFT JOIN exchange_latest_market_signals sig ON sig.normalized_symbol = a.normalized_symbol
             LEFT JOIN exchange_latest_cross_market_spreads s ON a.enrichment_confidence = 'high'::text AND s.normalized_symbol = a.normalized_symbol AND s.as_of >= (now() - '00:03:00'::interval) AND s.as_of <= (now() + '00:00:30'::interval) AND s.confidence_score >= 70::double precision AND s.confidence_score <= 100::double precision AND s.lowest_ask_price > 0::double precision AND s.lowest_ask_price < 'Infinity'::double precision AND s.highest_bid_price > 0::double precision AND s.highest_bid_price < 'Infinity'::double precision AND s.buy_provider IS NOT NULL AND s.sell_provider IS NOT NULL AND s.buy_provider <> s.sell_provider AND s.estimated_net_spread_pct IS NOT NULL AND (s.estimated_net_spread_pct <> ALL (ARRAY['Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision])) AND NOT (EXISTS ( SELECT 1
                   FROM jsonb_array_elements_text(COALESCE(s.caution_flags, '[]'::jsonb)) f_1(value)
                  WHERE f_1.value ~* 'stale|depeg|normalization assumed|low liquidity'::text))
             LEFT JOIN LATERAL ( SELECT candidates.dex
                   FROM jsonb_each_text(COALESCE(a.platforms, '{}'::jsonb)) platform(key, value)
                     CROSS JOIN LATERAL ( SELECT jsonb_build_object('liquidityUsd', m.liquidity_usd, 'volume24hUsd', m.volume_24h_usd, 'priceUsd', m.price_usd, 'marketCap', m.market_cap, 'fdv', m.fdv, 'pairAddress', m.pair_address, 'sourceUrl', m.source_url, 'fetchedAt', m.as_of, 'chain', intel_market_chain(m.chain)) AS dex,
                            m.as_of AS observed,
                            0 AS priority
                           FROM memecoin_latest_tokens m
                          WHERE intel_market_chain(m.chain) = intel_market_chain(platform.key) AND intel_market_address(m.token_address) = intel_market_address(platform.value)
                        UNION ALL
                         SELECT jsonb_build_object('liquidityUsd', x.liquidity_usd, 'volume24hUsd', x.volume_24h, 'priceUsd', x.price_usd, 'marketCap', x.market_cap, 'fdv', x.fdv, 'pairAddress', x.pair_address, 'sourceUrl', x.source_ref, 'fetchedAt', x.fetched_at, 'chain', intel_market_chain(x.chain)) AS jsonb_build_object,
                            x.fetched_at,
                            1
                           FROM ( SELECT x_1.id,
                                    x_1.chain,
                                    x_1.token_address,
                                    x_1.pair_address,
                                    x_1.dex_id,
                                    x_1.symbol,
                                    x_1.name,
                                    x_1.price_usd,
                                    x_1.liquidity_usd,
                                    x_1.fdv,
                                    x_1.market_cap,
                                    x_1.volume_24h,
                                    x_1.txns_24h,
                                    x_1.price_change,
                                    x_1.socials,
                                    x_1.links,
                                    x_1.pair_created_at,
                                    x_1.intelligence_ref,
                                    x_1.intelligence_entity_id,
                                    x_1.target_source,
                                    x_1.provider,
                                    x_1.source_ref,
                                    x_1.fetched_at,
                                    x_1.stale_after,
                                    x_1.confidence,
                                    x_1.raw_response,
                                    x_1.snapshot_bucket,
                                    x_1.updated_at
                                   FROM dex_pair_snapshots x_1
                                  WHERE intel_market_chain(x_1.chain) = intel_market_chain(platform.key) AND intel_market_address(x_1.token_address) = intel_market_address(platform.value)
                                  ORDER BY x_1.fetched_at DESC, x_1.pair_address
                                 LIMIT 1) x) candidates
                  ORDER BY candidates.observed DESC NULLS LAST, candidates.priority, platform.key
                 LIMIT 1) d ON true
        ), flags AS (
         SELECT j.source_provider,
            j.provider_id,
            j.provider_slug,
            j.symbol,
            j.name,
            j.normalized_symbol,
            j.primary_chain,
            j.market_cap_rank,
            j.current_price,
            j.market_cap,
            j.fdv,
            j.circulating_supply,
            j.total_supply,
            j.max_supply,
            j.volume_24h,
            j.change_1h_pct,
            j.change_24h_pct,
            j.change_7d_pct,
            j.categories,
            j.platforms,
            j.image_url,
            j.cached_image_url,
            j.image_source,
            j.image_fallback_type,
            j.image_last_checked_at,
            j.image_verified_at,
            j.image_error_count,
            j.source_url,
            j.source_label,
            j.attribution_label,
            j.confidence,
            j.last_refreshed_at,
            j.as_of,
            j.created_at,
            j.updated_at,
            j.derived,
            j.quote_batch_ids,
            j.profile_providers,
            j.latest_price,
            j.latest_volume_quote_24h,
            j.signal_direction,
            j.signal_strength,
            j.signal_confidence,
            j.enrichment_confidence,
            j.cex,
            j.dex,
            j.spread,
            COALESCE((j.cex ->> 'availableCount'::text)::integer, 0) AS available_count,
                CASE
                    WHEN j.cex IS NOT NULL THEN j.signal_direction
                    ELSE NULL::text
                END AS matched_signal_direction,
            COALESCE((j.derived -> 'unusual_volume'::text) = 'true'::jsonb, false) AS unusual_volume,
                CASE
                    WHEN jsonb_typeof(j.derived -> 'volume_ratio'::text) = 'number'::text THEN (j.derived ->> 'volume_ratio'::text)::double precision
                    ELSE NULL::double precision
                END AS volume_ratio,
            COALESCE((j.derived -> 'vol_up_price_flat'::text) = 'true'::jsonb, false) AS vol_up_price_flat,
            COALESCE(j.change_24h_pct > 5::double precision AND ((j.dex ->> 'liquidityUsd'::text)::double precision) < 50000::double precision, false) AS price_up_liquidity_weak,
            COALESCE(((j.cex ->> 'availableCount'::text)::integer) >= 3 AND j.signal_direction = 'bullish'::text AND jsonb_array_length(
                CASE
                    WHEN jsonb_typeof((j.cex -> 'marketContext'::text) -> 'confirmingProviders'::text) = 'array'::text THEN (j.cex -> 'marketContext'::text) -> 'confirmingProviders'::text
                    ELSE '[]'::jsonb
                END) >= 2, false) AS multi_exchange_strength,
            COALESCE(((j.dex ->> 'liquidityUsd'::text)::double precision) < 25000::double precision, false) OR j.cex IS NOT NULL AND ((j.cex ->> 'availableCount'::text)::integer) = 1 AND j.market_cap < 20000000::double precision AS thin_liquidity,
            COALESCE(j.enrichment_confidence = 'high'::text AND ((j.cex ->> 'spreadPct'::text)::double precision) >= 1.5::double precision, false) AS spread_caution,
            0.6::double precision * LEAST(abs(COALESCE(j.change_24h_pct, 0::double precision)) / 25::double precision, 1::double precision) + 0.4::double precision * LEAST(log(GREATEST(1::double precision, COALESCE(j.market_cap, 1::double precision))) / 12::double precision, 1::double precision) AS mover_score
           FROM joined j
        )
 SELECT source_provider,
    provider_id,
    provider_slug,
    symbol,
    name,
    normalized_symbol,
    primary_chain,
    market_cap_rank,
    current_price,
    market_cap,
    fdv,
    circulating_supply,
    total_supply,
    max_supply,
    volume_24h,
    change_1h_pct,
    change_24h_pct,
    change_7d_pct,
    categories,
    platforms,
    image_url,
    cached_image_url,
    image_source,
    image_fallback_type,
    image_last_checked_at,
    image_verified_at,
    image_error_count,
    source_url,
    source_label,
    attribution_label,
    confidence,
    last_refreshed_at,
    as_of,
    created_at,
    updated_at,
    derived,
    quote_batch_ids,
    profile_providers,
    latest_price,
    latest_volume_quote_24h,
    signal_direction,
    signal_strength,
    signal_confidence,
    enrichment_confidence,
    cex,
    dex,
    spread,
    available_count,
    matched_signal_direction,
    unusual_volume,
    volume_ratio,
    vol_up_price_flat,
    price_up_liquidity_weak,
    multi_exchange_strength,
    thin_liquidity,
    spread_caution,
    mover_score,
    jsonb_build_object('unusualVolume', unusual_volume, 'volumeRatio', volume_ratio, 'volUpPriceFlat', vol_up_price_flat, 'priceUpLiquidityWeak', price_up_liquidity_weak, 'multiExchangeStrength', multi_exchange_strength, 'thinLiquidity', COALESCE(thin_liquidity, false), 'spreadCaution', spread_caution, 'cautionFlags', to_jsonb(array_remove(ARRAY[
        CASE
            WHEN thin_liquidity THEN 'thin_liquidity'::text
            ELSE NULL::text
        END,
        CASE
            WHEN price_up_liquidity_weak THEN 'price_up_liquidity_weak'::text
            ELSE NULL::text
        END,
        CASE
            WHEN spread_caution THEN 'wide_spread'::text
            ELSE NULL::text
        END], NULL::text))) AS flags
   FROM flags f;
REVOKE ALL ON public.intel_market_screen_source_rows FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.intel_market_screen_source_rows TO service_role;

CREATE OR REPLACE FUNCTION public.intel_markets_screen_for_user(p_org_id uuid,p_user_id uuid,p_query jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_page int; v_limit int; v_sort text; v_search text; v_chain text; v_category text;
 v_signal text; v_cap text; v_exchange text; v_view text; v_watch boolean;
 v_order text; v_result jsonb; v_provider text; v_requested text; v_catalog jsonb;
BEGIN
 IF p_user_id IS NULL OR p_org_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE user_id=p_user_id AND org_id=p_org_id)
  OR NOT COALESCE(public.can_access_intel(p_user_id,p_org_id),false) THEN
  RAISE EXCEPTION 'Investor Intel workspace access required' USING ERRCODE='42501';
 END IF;
 v_requested:=COALESCE(NULLIF(p_query->>'provider',''),'auto');
 IF v_requested NOT IN ('auto','coinmarketcap','coingecko') THEN RAISE EXCEPTION 'Invalid markets provider' USING ERRCODE='22023'; END IF;
 v_provider:=CASE WHEN v_requested<>'auto' THEN v_requested
  WHEN (SELECT count(*) FROM public.market_assets WHERE source_provider='coinmarketcap' AND in_current_catalog AND as_of BETWEEN now()-interval '30 minutes' AND now()+interval '30 seconds')>=1000 THEN 'coinmarketcap'
  WHEN EXISTS(SELECT 1 FROM public.market_assets WHERE source_provider='coingecko') THEN 'coingecko'
  ELSE 'coinmarketcap' END;
 SELECT jsonb_build_object('provider',v_provider,'requested',v_requested,'fallback',v_requested='auto' AND v_provider<>'coinmarketcap',
  'available',COALESCE(jsonb_agg(jsonb_build_object('provider',s.source_provider,'assets',s.assets,'retainedAssets',s.retained_assets,'oldest',s.oldest,'newest',s.newest)),'[]')) INTO v_catalog
  FROM (SELECT source_provider,count(*) FILTER(WHERE in_current_catalog) AS assets,count(*) AS retained_assets,min(as_of) FILTER(WHERE in_current_catalog) AS oldest,max(as_of) FILTER(WHERE in_current_catalog) AS newest FROM public.market_assets WHERE source_provider IN ('coinmarketcap','coingecko') GROUP BY source_provider)s;
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
  FROM public.intel_market_screen_source_rows r WHERE r.source_provider=$13
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
  'snapshot',(SELECT jsonb_build_object('universeLimit',1000,'universeTotal',(SELECT count(*) FROM public.market_assets WHERE source_provider=$13 AND in_current_catalog),
    'universeTruncated',(SELECT count(*) FROM public.market_assets WHERE source_provider=$13 AND in_current_catalog)>s.tracked,'enrichmentIncomplete',false,
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
 $query$,v_order) INTO v_result USING p_org_id,v_search,v_chain,v_category,v_signal,v_watch,v_cap,v_exchange,v_view,v_limit,v_page*v_limit,v_page,v_provider;
 RETURN v_result||jsonb_build_object('catalog',v_catalog);
END $$;
REVOKE ALL ON FUNCTION public.intel_markets_screen_for_user(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_markets_screen_for_user(uuid,uuid,jsonb) TO service_role;
