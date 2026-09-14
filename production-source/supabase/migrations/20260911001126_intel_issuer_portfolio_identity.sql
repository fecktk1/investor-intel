-- Reviewed Circle mainnet addresses and CMC UCID 3408, 2026-09-10.
-- https://developers.circle.com/stablecoins/usdc-contract-addresses
-- No ticker matching and no mapping from user-editable holding metadata.
CREATE OR REPLACE FUNCTION app_private.intel_issuer_market_keys(p_key text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path='' AS $function$
 SELECT CASE WHEN p_key IN ('eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','eip155:42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831','eip155:43114:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e','eip155:10:0x0b2c639c533813f4aa9d7837caf62653d097ff85','eip155:137:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') THEN ARRAY['market:coinmarketcap:3408','market:cmc:3408'] ELSE '{}'::text[] END
$function$;
REVOKE ALL ON FUNCTION app_private.intel_issuer_market_keys(text) FROM PUBLIC,anon,authenticated;

-- Private exposure follows current owned holdings and exact asset identities.
-- Mutable ledger rows are replayable only after their latest stored revision.
CREATE OR REPLACE FUNCTION public.portfolio_exposure(p_portfolio_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_org uuid; v_total numeric; v jsonb;
BEGIN
  SELECT org_id INTO v_org FROM investor_portfolios
    WHERE id = p_portfolio_id AND user_id = auth.uid() AND org_id IN (SELECT public.intel_portfolio_org_ids());
  IF v_org IS NULL THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT COALESCE(sum(current_value), 0) INTO v_total
    FROM investor_portfolio_holdings WHERE portfolio_id = p_portfolio_id AND org_id=v_org AND user_id=auth.uid() AND NOT coalesce(is_closed,false) AND quantity>0 AND current_value IS NOT NULL;

  WITH entity_keys AS MATERIALIZED (
    SELECT e.id,e.display_symbol,e.native_symbol,app_private.intel_entity_identity_aliases(e,e.canonical_ref_key) AS keys
    FROM public.entities e WHERE e.org_id=v_org AND e.entity_kind='asset'
  ), h AS MATERIALIZED (
    SELECT upper(COALESCE(x.normalized_symbol, x.asset_symbol)) AS sym, x.chain,x.canonical_asset_key,
           COALESCE(x.current_value, 0) AS val, x.allocation_pct, x.day_pnl, x.day_pnl_pct, x.market_context, x.is_dust,
           ARRAY(SELECT DISTINCT k FROM (
             SELECT x.canonical_asset_key AS k
             UNION ALL SELECT unnest(app_private.intel_issuer_market_keys(x.canonical_asset_key))
             UNION ALL SELECT unnest(e.keys) FROM entity_keys e WHERE x.canonical_asset_key=ANY(e.keys)
             UNION ALL SELECT 'native:'||x.chain WHERE x.canonical_asset_key LIKE '%:native' OR x.canonical_asset_key LIKE '%:native:%'
             UNION ALL SELECT unnest(CASE
               WHEN x.canonical_asset_key IN ('eip155:1:native','eip155:8453:native','eip155:42161:native','eip155:10:native','eip155:59144:native','eip155:534352:native','eip155:324:native','eip155:81457:native')
                 THEN ARRAY['market:coingecko:ethereum','market:coinmarketcap:1027','market:cmc:1027']
               WHEN x.canonical_asset_key='bip122:native:BTC' THEN ARRAY['market:coingecko:bitcoin','market:coinmarketcap:1','market:cmc:1']
               WHEN x.canonical_asset_key='solana:native:SOL' THEN ARRAY['market:coingecko:solana','market:coinmarketcap:5426','market:cmc:5426']
               WHEN x.canonical_asset_key='eip155:56:native' THEN ARRAY['market:coingecko:binancecoin','market:coinmarketcap:1839','market:cmc:1839']
               ELSE '{}'::text[] END)
           ) a WHERE k IS NOT NULL) AS keys
    FROM public.investor_portfolio_holdings x
    WHERE x.portfolio_id=p_portfolio_id AND x.org_id=v_org AND x.user_id=auth.uid() AND NOT coalesce(x.is_closed,false) AND x.quantity>0
  ),
  chains AS (
    SELECT COALESCE(chain, 'unknown') AS chain, sum(val) AS val
    FROM h WHERE val > 0 GROUP BY COALESCE(chain, 'unknown')
  ),
  narr AS (
    SELECT t.slug, t.name, s.signal_class, s.lifecycle_stage, COALESCE(s.clarity_labels, '[]'::jsonb) AS clarity_labels,
           sum(h.val) AS val, array_agg(DISTINCT h.sym) AS syms
    FROM h
    JOIN narrative_taxonomy t ON t.status IN ('active','surfaced') AND EXISTS (
      SELECT 1 FROM narrative_assets na WHERE na.narrative_id=t.id AND ('market:'||na.asset_provider||':'||na.asset_provider_id)=ANY(h.keys))
    LEFT JOIN narrative_state s ON s.narrative_id = t.id
    WHERE h.val > 0
    GROUP BY t.slug, t.name, s.signal_class, s.lifecycle_stage, s.clarity_labels
  ),
  wl AS (
    SELECT DISTINCT upper(COALESCE(e.display_symbol,e.native_symbol)) AS sym,e.keys
    FROM public.watchlist_items wi
    JOIN public.watchlists w ON w.id=wi.watchlist_id AND w.org_id=wi.org_id AND w.user_id=auth.uid()
    JOIN entity_keys e ON e.id=wi.entity_id
    WHERE wi.org_id=v_org AND COALESCE(e.display_symbol,e.native_symbol) IS NOT NULL
  )
  SELECT jsonb_build_object(
    'total_value_usd', round(v_total::numeric, 2),
    'identity_coverage',jsonb_build_object('matching','canonical_asset_identity','unmapped_research_holdings',(SELECT count(*) FROM h WHERE NOT EXISTS(SELECT 1 FROM unnest(keys) k WHERE k LIKE 'market:%'))),
    'chain_concentration', COALESCE((SELECT jsonb_agg(jsonb_build_object('chain', c.chain, 'value_usd', round(c.val::numeric, 2),
        'pct', CASE WHEN v_total > 0 THEN round((c.val / v_total * 100)::numeric, 1) ELSE NULL END) ORDER BY c.val DESC)
        FROM chains c), '[]'::jsonb),
    'top_chain_pct', (SELECT CASE WHEN v_total > 0 THEN round((max(c.val) / v_total * 100)::numeric, 1) ELSE NULL END FROM chains c),
    'narrative_exposure', COALESCE((SELECT jsonb_agg(jsonb_build_object('slug', n.slug, 'name', n.name,
        'signal_class', n.signal_class, 'lifecycle_stage', n.lifecycle_stage, 'clarity_labels', n.clarity_labels,
        'value_usd', round(n.val::numeric, 2),
        'pct_of_book', CASE WHEN v_total > 0 THEN round((n.val / v_total * 100)::numeric, 1) ELSE NULL END,
        'holdings', n.syms) ORDER BY n.val DESC)
        FROM (SELECT * FROM narr ORDER BY val DESC LIMIT 8) n), '[]'::jsonb),
    'watchlist_vs_holdings', jsonb_build_object(
      'held_and_watched', COALESCE((SELECT jsonb_agg(DISTINCT x.sym) FROM h x JOIN wl w ON w.keys && x.keys WHERE x.val > 0), '[]'::jsonb),
      'held_not_watched', COALESCE((SELECT jsonb_agg(DISTINCT x.sym) FROM h x WHERE x.val > 0 AND NOT EXISTS (SELECT 1 FROM wl w WHERE w.keys && x.keys)), '[]'::jsonb),
      'watched_not_held', COALESCE((SELECT jsonb_agg(DISTINCT w.sym) FROM wl w WHERE NOT EXISTS (SELECT 1 FROM h x WHERE x.keys && w.keys AND x.val > 0)), '[]'::jsonb)
    ),
    -- descriptive only: the biggest single-asset concentration + any stored caution flags
    'highest_risk_holding', (SELECT jsonb_build_object('symbol', x.sym,
        'allocation_pct', round(COALESCE(x.allocation_pct, CASE WHEN v_total > 0 THEN x.val / v_total * 100 ELSE 0 END)::numeric, 1),
        'reasons', (SELECT jsonb_agg(r) FROM (
            SELECT 'largest single-asset concentration in this portfolio' AS r
            UNION ALL
            SELECT 'market data caution: ' || cf.flag FROM (
              SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(x.market_context->'cautionFlags') = 'array' THEN x.market_context->'cautionFlags' ELSE '[]'::jsonb END) AS flag
            ) cf
          ) rr))
        FROM h x WHERE x.val > 0 ORDER BY x.val DESC LIMIT 1),
    'biggest_changed_exposure', (SELECT jsonb_build_object('symbol', x.sym,
        'day_change_usd', round(COALESCE(x.day_pnl, 0)::numeric, 2), 'day_change_pct', round(COALESCE(x.day_pnl_pct, 0)::numeric, 2))
        FROM h x WHERE x.day_pnl IS NOT NULL ORDER BY abs(x.day_pnl) DESC LIMIT 1),
    -- Stored Intel Signals with an exact provider or canonical identity.
    'portfolio_signals', COALESCE((SELECT jsonb_agg(jsonb_build_object('subject', s.display_symbol,
        'direction', s.direction, 'confidence', s.confidence, 'why_it_matters', s.why_it_matters,
        'what_to_watch_next', s.what_to_watch_next, 'generated_at', s.generated_at) ORDER BY s.global_score DESC)
        FROM (SELECT matched.* FROM (SELECT DISTINCT ON (st.signal_key) st.* FROM intel_signal_state st JOIN h ON (CASE WHEN st.subject_id LIKE 'cg:%' THEN 'market:coingecko:'||substr(st.subject_id,4) WHEN st.subject_id LIKE 'cmc:%' THEN 'market:coinmarketcap:'||substr(st.subject_id,5) ELSE st.subject_id END)=ANY(h.keys)
              WHERE st.subject_type = 'asset' AND (st.expires_at IS NULL OR st.expires_at > now()) AND h.val > 0
              ORDER BY st.signal_key, st.generated_at DESC) matched ORDER BY matched.global_score DESC LIMIT 6) s), '[]'::jsonb),
    'portfolio_alerts', COALESCE((SELECT jsonb_agg(jsonb_build_object('fired_at', ev.fired_at, 'payload', ev.payload) ORDER BY ev.fired_at DESC)
        FROM (SELECT e.fired_at,e.payload FROM public.intel_alert_events e
              JOIN public.intel_alert_rules r ON r.id=e.rule_id AND r.org_id=e.org_id AND r.user_id=auth.uid()
              LEFT JOIN entity_keys ek ON ek.id=r.entity_id
              WHERE e.org_id=v_org AND e.fired_at>now()-interval '7 days'
                AND EXISTS(SELECT 1 FROM h WHERE val>0 AND (ek.keys&&h.keys OR coalesce(e.payload->>'canonical_asset_key',e.payload->>'canonical_key',r.config->>'canonical_asset_key')=ANY(h.keys)))
              ORDER BY e.fired_at DESC LIMIT 8) ev), '[]'::jsonb),
    'framing', 'Research context describing this portfolio as it is — not a score, target, or recommendation.'
  ) INTO v;
  RETURN v;
END $function$;

REVOKE ALL ON FUNCTION public.portfolio_exposure(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.portfolio_exposure(uuid) TO authenticated,service_role;

