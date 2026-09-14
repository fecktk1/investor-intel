-- Select the provider before the query-local identity projection.
-- All columns, identity rules, enrichment and private screening remain intact.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $migration$
DECLARE previous_definition text;
BEGIN
 PERFORM pg_catalog.set_config('search_path','',true);
 previous_definition:=pg_catalog.pg_get_viewdef('public.intel_market_screen_source_rows'::regclass,true);
 IF pg_catalog.md5(previous_definition)<>'060d27c3f1e984272fdd35c5ce599436' THEN
  RAISE EXCEPTION 'Markets source view differs from the reviewed definition';
 END IF;
 IF NOT COALESCE((SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_catalog.pg_class WHERE oid='public.intel_market_screen_source_rows'::regclass),false) THEN
  RAISE EXCEPTION 'Markets source view must remain SECURITY INVOKER';
 END IF;
 EXECUTE $view$CREATE OR REPLACE VIEW public.intel_market_screen_source_rows WITH(security_invoker=true) AS
SELECT providers.id AS source_provider,
r.provider_id,
r.provider_slug,
r.symbol,
r.name,
r.normalized_symbol,
r.primary_chain,
r.market_cap_rank,
r.current_price,
r.market_cap,
r.fdv,
r.circulating_supply,
r.total_supply,
r.max_supply,
r.volume_24h,
r.change_1h_pct,
r.change_24h_pct,
r.change_7d_pct,
r.categories,
r.platforms,
r.image_url,
r.cached_image_url,
r.image_source,
r.image_fallback_type,
r.image_last_checked_at,
r.image_verified_at,
r.image_error_count,
r.source_url,
r.source_label,
r.attribution_label,
r.confidence,
r.last_refreshed_at,
r.as_of,
r.created_at,
r.updated_at,
r.derived,
r.quote_batch_ids,
r.profile_providers,
r.latest_price,
r.latest_volume_quote_24h,
r.signal_direction,
r.signal_strength,
r.signal_confidence,
r.enrichment_confidence,
r.cex,
r.dex,
r.spread,
r.available_count,
r.matched_signal_direction,
r.unusual_volume,
r.volume_ratio,
r.vol_up_price_flat,
r.price_up_liquidity_weak,
r.multi_exchange_strength,
r.thin_liquidity,
r.spread_caution,
r.mover_score,
r.flags
FROM (VALUES ('coinmarketcap'::text), ('coingecko'::text)) providers(id)
CROSS JOIN LATERAL (
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
           FROM LATERAL ( SELECT m.source_provider,
                    m.provider_id,
                    m.provider_slug,
                    m.symbol,
                    m.name,
                    m.normalized_symbol,
                    m.primary_chain,
                    m.market_cap_rank,
                    m.current_price,
                    m.market_cap,
                    m.fdv,
                    m.circulating_supply,
                    m.total_supply,
                    m.max_supply,
                    m.volume_24h,
                    m.change_1h_pct,
                    m.change_24h_pct,
                    m.change_7d_pct,
                    m.categories,
                    m.platforms,
                    m.image_url,
                    m.cached_image_url,
                    m.image_source,
                    m.image_fallback_type,
                    m.image_last_checked_at,
                    m.image_verified_at,
                    m.image_error_count,
                    m.source_url,
                    m.source_label,
                    m.attribution_label,
                    m.confidence,
                    m.last_refreshed_at,
                    m.as_of,
                    m.created_at,
                    m.updated_at,
                    m.derived,
                    m.quote_batch_ids,
                    m.in_current_catalog
                   FROM public.market_assets m
                  WHERE m.source_provider = providers.id AND m.in_current_catalog
                  ORDER BY m.market_cap_rank, m.provider_id
                 LIMIT 1000) a
        ), identities AS MATERIALIZED (
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
                    WHEN a.normalized_symbol =
                    CASE (a.source_provider || ':'::text) || a.provider_id
                        WHEN 'coinmarketcap:1'::text THEN 'BTC'::text
                        WHEN 'coingecko:bitcoin'::text THEN 'BTC'::text
                        WHEN 'coinmarketcap:1027'::text THEN 'ETH'::text
                        WHEN 'coingecko:ethereum'::text THEN 'ETH'::text
                        WHEN 'coinmarketcap:5426'::text THEN 'SOL'::text
                        WHEN 'coingecko:solana'::text THEN 'SOL'::text
                        WHEN 'coinmarketcap:1839'::text THEN 'BNB'::text
                        WHEN 'coingecko:binancecoin'::text THEN 'BNB'::text
                        WHEN 'coinmarketcap:5805'::text THEN 'AVAX'::text
                        WHEN 'coingecko:avalanche-2'::text THEN 'AVAX'::text
                        ELSE NULL::text
                    END THEN 'high'::text
                    WHEN (EXISTS ( SELECT 1
                       FROM public.exchange_asset_mappings m
                      WHERE m.is_active AND m.normalized_symbol = a.normalized_symbol AND (m.canonical_asset_id = ((a.source_provider || ':'::text) || a.provider_id) OR m.canonical_asset_id = a.provider_id AND NOT (EXISTS ( SELECT 1
                               FROM public.market_assets other
                              WHERE other.provider_id = a.provider_id AND other.source_provider <> a.source_provider)) OR m.chain IS NOT NULL AND m.contract_address IS NOT NULL AND (EXISTS ( SELECT 1
                               FROM jsonb_each_text(COALESCE(a.platforms, '{}'::jsonb)) platform(key, value)
                              WHERE public.intel_market_chain(platform.key) = public.intel_market_chain(m.chain) AND public.intel_market_address(platform.value) = public.intel_market_address(m.contract_address)))))) THEN 'high'::text
                    WHEN (a.normalized_symbol <> ALL (ARRAY['WBTC'::text, 'WETH'::text, 'WBETH'::text, 'WEETH'::text, 'CBBTC'::text])) AND (( SELECT count(*) AS count
                       FROM public.market_assets other
                      WHERE other.normalized_symbol = a.normalized_symbol)) = 1 THEN 'medium'::text
                    ELSE 'low'::text
                END AS enrichment_confidence
           FROM canonical a
             LEFT JOIN public.exchange_latest_asset_profiles p ON p.normalized_symbol = a.normalized_symbol
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
                   FROM public.exchange_latest_tickers t_1
                  WHERE t_1.normalized_symbol = a.normalized_symbol AND (a.enrichment_confidence = ANY (ARRAY['high'::text, 'medium'::text]))) t ON true
             LEFT JOIN public.exchange_latest_market_signals sig ON sig.normalized_symbol = a.normalized_symbol
             LEFT JOIN public.exchange_latest_cross_market_spreads s ON a.enrichment_confidence = 'high'::text AND s.normalized_symbol = a.normalized_symbol AND s.as_of >= (now() - '00:03:00'::interval) AND s.as_of <= (now() + '00:00:30'::interval) AND s.confidence_score >= 70::double precision AND s.confidence_score <= 100::double precision AND s.lowest_ask_price > 0::double precision AND s.lowest_ask_price < 'Infinity'::double precision AND s.highest_bid_price > 0::double precision AND s.highest_bid_price < 'Infinity'::double precision AND s.buy_provider IS NOT NULL AND s.sell_provider IS NOT NULL AND s.buy_provider <> s.sell_provider AND s.estimated_net_spread_pct IS NOT NULL AND (s.estimated_net_spread_pct <> ALL (ARRAY['Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision])) AND NOT (EXISTS ( SELECT 1
                   FROM jsonb_array_elements_text(COALESCE(s.caution_flags, '[]'::jsonb)) f_1(value)
                  WHERE f_1.value ~* 'stale|depeg|normalization assumed|low liquidity'::text))
             LEFT JOIN LATERAL ( SELECT candidates.dex
                   FROM jsonb_each_text(COALESCE(a.platforms, '{}'::jsonb)) platform(key, value)
                     CROSS JOIN LATERAL ( SELECT jsonb_build_object('liquidityUsd', m.liquidity_usd, 'volume24hUsd', m.volume_24h_usd, 'priceUsd', m.price_usd, 'marketCap', m.market_cap, 'fdv', m.fdv, 'pairAddress', m.pair_address, 'sourceUrl', m.source_url, 'fetchedAt', m.as_of, 'chain', public.intel_market_chain(m.chain)) AS dex,
                            m.as_of AS observed,
                            0 AS priority
                           FROM public.memecoin_latest_tokens m
                          WHERE public.intel_market_chain(m.chain) = public.intel_market_chain(platform.key) AND public.intel_market_address(m.token_address) = public.intel_market_address(platform.value)
                        UNION ALL
                         SELECT jsonb_build_object('liquidityUsd', x.liquidity_usd, 'volume24hUsd', x.volume_24h, 'priceUsd', x.price_usd, 'marketCap', x.market_cap, 'fdv', x.fdv, 'pairAddress', x.pair_address, 'sourceUrl', x.source_ref, 'fetchedAt', x.fetched_at, 'chain', public.intel_market_chain(x.chain)) AS jsonb_build_object,
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
                                   FROM public.dex_pair_snapshots x_1
                                  WHERE public.intel_market_chain(x_1.chain) = public.intel_market_chain(platform.key) AND public.intel_market_address(x_1.token_address) = public.intel_market_address(platform.value)
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
   FROM flags f
) r$view$;
END $migration$;
