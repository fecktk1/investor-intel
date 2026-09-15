-- Markets screen: explicit sort directions plus the CoinMarketCap market-pair count.
-- Additive only. No authorization, provider, clock, membership or contract change:
-- every existing sort key keeps the direction it already had, and `dir` may only
-- flip the primary expression of a key that does not already name its direction.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- CMC listings already carry num_market_pairs; the catalogue simply stops dropping it.
ALTER TABLE public.market_assets ADD COLUMN IF NOT EXISTS num_market_pairs integer CHECK (num_market_pairs IS NULL OR num_market_pairs >= 0);

-- Unchanged apart from carrying num_market_pairs through the same validated write.
CREATE OR REPLACE FUNCTION public.intel_replace_market_catalog(p_provider text,p_rows jsonb,p_expected_count int)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $catalog$
DECLARE v_count int;v_at timestamptz;v_ids text[];
BEGIN
 IF p_provider IS DISTINCT FROM 'coinmarketcap' OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR p_expected_count IS NULL OR p_expected_count NOT BETWEEN 1 AND 5000 OR jsonb_array_length(p_rows)<>p_expected_count OR octet_length(p_rows::text)>8000000 THEN RAISE EXCEPTION 'Invalid catalogue snapshot' USING ERRCODE='22023';END IF;
 SELECT count(DISTINCT provider_id),min(last_refreshed_at),array_agg(provider_id) INTO v_count,v_at,v_ids FROM jsonb_populate_recordset(NULL::public.market_assets,p_rows);
 IF v_count<>p_expected_count OR EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::public.market_assets,p_rows) x WHERE x.source_provider IS DISTINCT FROM p_provider OR x.provider_id !~ '^[1-9][0-9]{0,9}$' OR nullif(x.symbol,'') IS NULL OR x.last_refreshed_at IS DISTINCT FROM v_at OR x.as_of IS NULL OR x.as_of>now()+interval '30 seconds' OR (x.current_price IS NOT NULL AND NOT(x.current_price>=0 AND x.current_price<'Infinity'::float8))) OR v_at IS NULL OR v_at>now()+interval '30 seconds' OR v_at<now()-interval '1 hour' THEN RAISE EXCEPTION 'Invalid catalogue row' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('intel-market-catalog:'||p_provider,0));
 IF EXISTS(SELECT 1 FROM public.market_assets WHERE source_provider=p_provider AND last_refreshed_at>v_at) THEN RETURN jsonb_build_object('written',0,'superseded',true);END IF;
 INSERT INTO public.market_assets(source_provider,provider_id,provider_slug,symbol,name,normalized_symbol,primary_chain,market_cap_rank,current_price,market_cap,fdv,circulating_supply,total_supply,max_supply,num_market_pairs,volume_24h,change_1h_pct,change_24h_pct,change_7d_pct,categories,platforms,image_url,image_source,image_last_checked_at,image_fallback_type,source_url,source_label,attribution_label,confidence,last_refreshed_at,as_of,updated_at,quote_batch_ids,in_current_catalog)
 SELECT x.source_provider,x.provider_id,x.provider_slug,x.symbol,x.name,x.normalized_symbol,x.primary_chain,x.market_cap_rank,x.current_price,x.market_cap,x.fdv,x.circulating_supply,x.total_supply,x.max_supply,x.num_market_pairs,x.volume_24h,x.change_1h_pct,x.change_24h_pct,x.change_7d_pct,x.categories,x.platforms,x.image_url,x.image_source,x.image_last_checked_at,x.image_fallback_type,x.source_url,x.source_label,x.attribution_label,x.confidence,x.last_refreshed_at,x.as_of,x.updated_at,x.quote_batch_ids,true FROM jsonb_populate_recordset(NULL::public.market_assets,p_rows) x
 ON CONFLICT(source_provider,provider_id) DO UPDATE SET provider_slug=EXCLUDED.provider_slug,symbol=EXCLUDED.symbol,name=EXCLUDED.name,normalized_symbol=EXCLUDED.normalized_symbol,primary_chain=EXCLUDED.primary_chain,market_cap_rank=EXCLUDED.market_cap_rank,current_price=EXCLUDED.current_price,market_cap=EXCLUDED.market_cap,fdv=EXCLUDED.fdv,circulating_supply=EXCLUDED.circulating_supply,total_supply=EXCLUDED.total_supply,max_supply=EXCLUDED.max_supply,num_market_pairs=EXCLUDED.num_market_pairs,volume_24h=EXCLUDED.volume_24h,change_1h_pct=EXCLUDED.change_1h_pct,change_24h_pct=EXCLUDED.change_24h_pct,change_7d_pct=EXCLUDED.change_7d_pct,categories=EXCLUDED.categories,platforms=EXCLUDED.platforms,image_url=EXCLUDED.image_url,image_source=EXCLUDED.image_source,image_last_checked_at=EXCLUDED.image_last_checked_at,image_fallback_type=EXCLUDED.image_fallback_type,source_url=EXCLUDED.source_url,source_label=EXCLUDED.source_label,attribution_label=EXCLUDED.attribution_label,confidence=EXCLUDED.confidence,last_refreshed_at=EXCLUDED.last_refreshed_at,as_of=EXCLUDED.as_of,updated_at=EXCLUDED.updated_at,quote_batch_ids=EXCLUDED.quote_batch_ids,in_current_catalog=true;
 UPDATE public.market_assets SET in_current_catalog=false WHERE source_provider=p_provider AND in_current_catalog AND NOT(provider_id=ANY(v_ids));
 RETURN jsonb_build_object('written',p_expected_count,'superseded',false);
END $catalog$;
REVOKE ALL ON FUNCTION public.intel_replace_market_catalog(text,jsonb,int) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_replace_market_catalog(text,jsonb,int) TO service_role;

-- The reviewed provider-scoped projection, gaining num_market_pairs only.
-- CREATE OR REPLACE VIEW can only append columns, so it lands after flags.
DO $migration$
DECLARE scoped_definition text; qualified_definition text;
BEGIN
 -- pg_get_viewdef renders schema qualification from search_path, so the reviewed
 -- definition is pinned under both renderings: '' (how 20260912172537 and
 -- 20260912203009 guard) and 'public' (how the live view was captured on
 -- 2026-09-14 23:05 UTC). PGlite 0.3.14 reproduces both bytes for byte.
 PERFORM pg_catalog.set_config('search_path','',true);
 scoped_definition:=pg_catalog.pg_get_viewdef('public.intel_market_screen_source_rows'::regclass,true);
 PERFORM pg_catalog.set_config('search_path','public',true);
 qualified_definition:=pg_catalog.pg_get_viewdef('public.intel_market_screen_source_rows'::regclass,true);
 PERFORM pg_catalog.set_config('search_path','',true);
 IF pg_catalog.md5(qualified_definition)<>'d4250cc0a8a8ad1faf77216541543fb2'
  OR pg_catalog.md5(scoped_definition)<>'be4ecef9a1f0519a38ba2249d633c4d1' THEN
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
r.flags,
r.num_market_pairs
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
            a.num_market_pairs,
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
                    m.num_market_pairs,
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
            a.num_market_pairs,
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
            a.num_market_pairs,
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
            j.num_market_pairs,
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
    num_market_pairs,
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

-- Same screener, same authorization and same panels; only the ORDER BY is built
-- from a base expression plus a direction, and sort/dir are echoed back.
CREATE OR REPLACE FUNCTION public.intel_markets_screen_for_user(p_org_id uuid, p_user_id uuid, p_query jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE v_page int; v_limit int; v_sort text; v_search text; v_chain text; v_category text;
 v_signal text; v_cap text; v_exchange text; v_view text; v_watch boolean;
 v_order text; v_result jsonb; v_provider text; v_requested text; v_catalog jsonb;
 v_dir text; v_base text; v_tail text; v_direction text;
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
 v_dir:=lower(COALESCE(p_query->>'dir',''));
 -- One base expression per sort key. Only this primary expression takes `dir`.
 v_base:=CASE v_sort WHEN 'market_cap' THEN 'market_cap' WHEN 'volume' THEN 'volume_24h'
  WHEN 'price' THEN 'current_price' WHEN 'fdv' THEN 'fdv' WHEN 'rank' THEN 'market_cap_rank'
  WHEN 'circulating_supply' THEN 'circulating_supply' WHEN 'max_supply' THEN 'max_supply'
  WHEN 'market_pairs' THEN 'num_market_pairs'
  WHEN 'change_1h' THEN 'change_1h_pct' WHEN 'change_24h' THEN 'change_24h_pct' WHEN 'change_7d' THEN 'change_7d_pct'
  WHEN 'gainers' THEN 'change_24h_pct' WHEN 'losers' THEN 'change_24h_pct'
  WHEN 'exchange_availability' THEN 'available_count' WHEN 'arbitrage' THEN '(cex->>''arbPct'')::float8'
  WHEN 'recently_updated' THEN 'last_refreshed_at' WHEN 'unusual_volume' THEN 'volume_ratio'
  WHEN 'multi_exchange_strength' THEN 'available_count' END;
 -- Secondary expressions keep the reviewed direction they already had.
 v_tail:=CASE v_sort WHEN 'exchange_availability' THEN ',market_cap DESC NULLS LAST'
  WHEN 'arbitrage' THEN ',market_cap DESC NULLS LAST' WHEN 'unusual_volume' THEN ',volume_24h DESC NULLS LAST'
  WHEN 'multi_exchange_strength' THEN ',change_24h_pct DESC NULLS LAST' ELSE '' END;
 -- gainers/losers are named directions; an explicit dir never reverses them.
 v_direction:=CASE WHEN v_sort IN ('gainers','losers') OR v_dir='' THEN
   CASE WHEN v_sort IN ('rank','losers') THEN 'asc' ELSE 'desc' END ELSE v_dir END;
 v_order:=CASE WHEN v_base IS NULL OR v_dir NOT IN ('','asc','desc') THEN NULL
  ELSE v_base||' '||upper(v_direction)||' NULLS LAST'||v_tail END;
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
 category_rows AS (SELECT c.category,b.source_provider,b.provider_id,b.mover_score,row_number() OVER(PARTITION BY c.category ORDER BY b.mover_score DESC,b.source_provider,b.provider_id) AS position,
   count(*) OVER(PARTITION BY c.category) AS members FROM base b CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(b.categories,'[]')) c(category)),
 category_top AS MATERIALIZED (SELECT category,max(mover_score) AS score FROM category_rows
   WHERE members>=3 AND position<=3 GROUP BY category ORDER BY max(mover_score) DESC,category LIMIT 8),
 category_leaders AS (SELECT c.category,jsonb_agg(to_jsonb(b)||jsonb_build_object('category',c.category,'position',c.position,'members',c.members) ORDER BY c.position) AS leaders,t.score
   FROM category_top t JOIN category_rows c ON c.category=t.category
   JOIN base b ON b.source_provider=c.source_provider AND b.provider_id=c.provider_id
   WHERE c.members>=3 AND c.position<=3 GROUP BY c.category,t.score),
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
 RETURN v_result||jsonb_build_object('catalog',v_catalog,'sort',v_sort,'dir',v_direction);
END $function$;
REVOKE ALL ON FUNCTION public.intel_markets_screen_for_user(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_markets_screen_for_user(uuid,uuid,jsonb) TO service_role;
