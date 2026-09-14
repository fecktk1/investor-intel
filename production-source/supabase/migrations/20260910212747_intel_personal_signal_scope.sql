CREATE OR REPLACE FUNCTION public.signal_feed_v2(p_org_id uuid, p_subject_type text DEFAULT NULL::text, p_chains text[] DEFAULT NULL::text[], p_limit integer DEFAULT 60)
 RETURNS TABLE(signal_key text, signal_type text, subject_type text, subject_id text, display_symbol text, chain text, related_assets jsonb, related_narratives jsonb, direction text, confidence text, source_count integer, source_diversity integer, severity numeric, freshness numeric, market_impact numeric, why_it_matters text, what_to_watch_next text, evidence_refs jsonb, headlines jsonb, ai_artifact_ref text, metrics jsonb, score_delta jsonb, global_score numeric, generated_at timestamp with time zone, stale_after timestamp with time zone, on_watchlist boolean, affects_holding boolean, relevance_score numeric, final_rank numeric, reasons text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_org_id IS NULL OR p_org_id NOT IN (SELECT public.intel_portfolio_org_ids()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>200 OR coalesce(array_length(p_chains,1),0)>40 THEN RAISE EXCEPTION 'invalid_signal_query' USING ERRCODE='22023'; END IF;
  RETURN QUERY
  WITH
  identity AS MATERIALIZED (
    SELECT e.id,app_private.intel_entity_identity_aliases(e,e.canonical_ref_key) keys FROM public.entities e WHERE e.org_id=p_org_id AND e.entity_kind='asset'
  ), wl AS (
    SELECT coalesce(array_agg(DISTINCT k),'{}') keys FROM watchlist_items wi
    JOIN watchlists w ON w.id=wi.watchlist_id AND w.org_id=wi.org_id AND w.user_id=auth.uid()
    JOIN identity e ON e.id=wi.entity_id CROSS JOIN LATERAL unnest(e.keys) k WHERE wi.org_id=p_org_id
  ), hold AS (
    SELECT k.key,least(1,greatest(0,coalesce(max(h.allocation_pct),0)/100.0)) weight
    FROM investor_portfolios p JOIN investor_portfolio_holdings h ON h.portfolio_id=p.id AND h.org_id=p.org_id AND h.user_id=p.user_id
    CROSS JOIN LATERAL unnest(ARRAY[h.canonical_asset_key] ||
      ARRAY(SELECT unnest(e.keys) FROM identity e WHERE h.canonical_asset_key=ANY(e.keys)) ||
      CASE WHEN h.canonical_asset_key IN ('eip155:1:native','eip155:8453:native','eip155:42161:native','eip155:10:native','eip155:59144:native','eip155:534352:native','eip155:324:native','eip155:81457:native') THEN ARRAY['market:coingecko:ethereum','market:coinmarketcap:1027']
      WHEN h.canonical_asset_key='bip122:native:BTC' THEN ARRAY['market:coingecko:bitcoin','market:coinmarketcap:1']
      WHEN h.canonical_asset_key='solana:native:SOL' THEN ARRAY['market:coingecko:solana','market:coinmarketcap:5426']
      ELSE '{}'::text[] END) k(key)
    WHERE p.org_id=p_org_id AND p.user_id=auth.uid() AND h.quantity>0 AND NOT coalesce(h.is_closed,false)
    GROUP BY k.key
  ),
  fol AS (   -- followed narrative slugs
    SELECT COALESCE(array_agg(t.slug), '{}') AS slugs
    FROM user_followed_narratives f JOIN narrative_taxonomy t ON t.id = f.narrative_id
    WHERE f.user_id = auth.uid() AND f.org_id=p_org_id
  ),
  prof AS (  -- onboarding selections (single row, empty arrays if no profile)
    SELECT COALESCE((SELECT chains_of_interest FROM intel_user_profiles WHERE org_id = p_org_id AND user_id=auth.uid() LIMIT 1), '{}') AS chains,
           COALESCE((SELECT topics_of_interest FROM intel_user_profiles WHERE org_id = p_org_id AND user_id=auth.uid() LIMIT 1), '{}') AS topics
  )
  SELECT
    s.signal_key, s.signal_type, s.subject_type, s.subject_id, s.display_symbol, s.chain,
    s.related_assets, s.related_narratives, s.direction, s.confidence,
    s.source_count, s.source_diversity, s.severity, s.freshness, s.market_impact,
    s.why_it_matters, s.what_to_watch_next, s.evidence_refs, s.headlines, s.ai_artifact_ref,
    s.metrics, s.score_delta, s.global_score, s.generated_at, s.stale_after,
    m.wl_match AS on_watchlist,
    (hw.w IS NOT NULL) AS affects_holding,
    m.relevance AS relevance_score,
    (COALESCE(s.global_score, 0) + m.relevance) AS final_rank,
    array_remove(ARRAY[
      CASE WHEN m.wl_match THEN 'watchlist match' END,
      CASE WHEN hw.w IS NOT NULL THEN 'affects a holding' END,
      CASE WHEN m.fol_match THEN 'followed narrative' END,
      CASE WHEN m.chain_match THEN 'on a chain you follow' END,
      CASE WHEN m.topic_match THEN 'a topic you follow' END
    ], NULL) AS reasons
  FROM intel_signal_state s
  CROSS JOIN wl CROSS JOIN fol CROSS JOIN prof
  LEFT JOIN LATERAL (
    SELECT MAX(h.weight) AS w FROM hold h
    WHERE h.key = CASE WHEN s.subject_id LIKE 'cg:%' THEN 'market:coingecko:'||substr(s.subject_id,4) WHEN s.subject_id LIKE 'cmc:%' THEN 'market:coinmarketcap:'||substr(s.subject_id,5) ELSE s.subject_id END
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.related_assets)='array' THEN s.related_assets ELSE '[]'::jsonb END) ra WHERE CASE WHEN ra LIKE 'cg:%' THEN 'market:coingecko:'||substr(ra,4) WHEN ra LIKE 'cmc:%' THEN 'market:coinmarketcap:'||substr(ra,5) ELSE ra END=h.key)
  ) hw ON true
  CROSS JOIN LATERAL (
    SELECT
      ( (array_length(wl.keys,1) IS NOT NULL) AND (CASE WHEN s.subject_id LIKE 'cg:%' THEN 'market:coingecko:'||substr(s.subject_id,4) WHEN s.subject_id LIKE 'cmc:%' THEN 'market:coinmarketcap:'||substr(s.subject_id,5) ELSE s.subject_id END = ANY(wl.keys) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.related_assets)='array' THEN s.related_assets ELSE '[]'::jsonb END) ra WHERE CASE WHEN ra LIKE 'cg:%' THEN 'market:coingecko:'||substr(ra,4) WHEN ra LIKE 'cmc:%' THEN 'market:coinmarketcap:'||substr(ra,5) ELSE ra END=ANY(wl.keys))) ) AS wl_match,
      ( (array_length(fol.slugs,1) IS NOT NULL) AND ((s.subject_type = 'narrative' AND s.subject_id = ANY(fol.slugs)) OR s.related_narratives ?| fol.slugs) ) AS fol_match,
      ( (array_length(prof.chains,1) IS NOT NULL) AND s.chain = ANY(prof.chains) ) AS chain_match,
      ( (array_length(prof.topics,1) IS NOT NULL) AND ((s.subject_type = 'narrative' AND s.subject_id = ANY(prof.topics)) OR s.related_narratives ?| prof.topics) ) AS topic_match
  ) b
  CROSS JOIN LATERAL (
    SELECT b.wl_match, b.fol_match, b.chain_match, b.topic_match,
      ( (CASE WHEN b.wl_match THEN 0.30 ELSE 0 END)
      + (CASE WHEN hw.w IS NOT NULL THEN 0.50 * COALESCE(hw.w, 0) ELSE 0 END)
      + (CASE WHEN b.fol_match THEN 0.40 ELSE 0 END)
      + (CASE WHEN b.chain_match THEN 0.10 ELSE 0 END)
      + (CASE WHEN b.topic_match THEN 0.10 ELSE 0 END)
      + 0.15 * (CASE lower(COALESCE(s.confidence,'')) WHEN 'high' THEN 1.0 WHEN 'medium' THEN 0.6 WHEN 'low' THEN 0.3 WHEN 'thin' THEN 0.15 ELSE 0.3 END)
      + 0.10 * (LEAST(s.source_diversity, 3) / 3.0)
      + 0.10 * COALESCE(s.freshness, 0)
      + 0.10 * COALESCE(s.severity, 0)
      + 0.10 * COALESCE(s.market_impact, 0) )::numeric AS relevance
  ) m
  WHERE (s.expires_at IS NULL OR s.expires_at > now())
    AND (p_subject_type IS NULL OR s.subject_type = p_subject_type)
    AND (p_chains IS NULL OR array_length(p_chains,1) IS NULL OR s.chain = ANY(p_chains))
  ORDER BY final_rank DESC NULLS LAST, s.global_score DESC NULLS LAST, s.generated_at DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(p_limit, 200));
END $function$;
REVOKE ALL ON FUNCTION public.signal_feed_v2(uuid,text,text[],integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.signal_feed_v2(uuid,text,text[],integer) TO authenticated;
