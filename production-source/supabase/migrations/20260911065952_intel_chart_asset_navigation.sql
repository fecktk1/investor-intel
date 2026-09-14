-- Reuse personal reading history; never mix this surface with change baselines.
CREATE INDEX IF NOT EXISTS intel_chart_recent_time ON public.intel_surface_seen(user_id,org_id,last_seen_at DESC,subject_key) WHERE surface='chart_recent';
CREATE OR REPLACE FUNCTION public.intel_chart_navigation(p_org uuid,p_user uuid,p_operation text,p_asset text DEFAULT NULL,p_tab text DEFAULT 'recent',p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE rows jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF p_operation IS NULL OR p_operation NOT IN ('visit','list','clear') OR p_tab IS NULL OR p_tab NOT IN ('recent','watchlist') OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 100 THEN RAISE EXCEPTION 'invalid_chart_navigation';END IF;
 IF p_operation<>'clear' AND public.can_access_intel(p_user,p_org) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF p_operation IN ('visit','clear') THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('chart-recent:'||p_org::text||':'||p_user::text,0));
  IF p_operation='clear' THEN
   DELETE FROM public.intel_surface_seen WHERE user_id=p_user AND org_id=p_org AND surface='chart_recent';
   RETURN jsonb_build_object('cleared',true);
  END IF;
  IF p_asset IS NULL OR length(p_asset)>240 OR p_asset !~ '^(market:(coinmarketcap:[1-9][0-9]{0,11}|coingecko:[a-z0-9][a-z0-9-]{0,120})|rwa:coinmarketcap:[1-9][0-9]{0,11}|native:[a-z0-9_-]{1,50}|eip155:[1-9][0-9]*(/native:[a-z0-9]+|/erc20:0x[a-fA-F0-9]{40}|:native|:0x[a-fA-F0-9]{40})|solana:(native:SOL|mainnet/(native:sol|spl:[1-9A-HJ-NP-Za-km-z]{32,44})|[1-9A-HJ-NP-Za-km-z]{32,44})|bip122:(native:BTC|mainnet/native:btc))$' THEN RAISE EXCEPTION 'invalid_chart_asset';END IF;
  INSERT INTO public.intel_surface_seen(user_id,org_id,surface,subject_key,last_seen_at) VALUES(p_user,p_org,'chart_recent',p_asset,clock_timestamp())
   ON CONFLICT(user_id,org_id,surface,subject_key) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at;
  DELETE FROM public.intel_surface_seen WHERE id IN (SELECT id FROM public.intel_surface_seen WHERE user_id=p_user AND org_id=p_org AND surface='chart_recent' ORDER BY last_seen_at DESC,subject_key OFFSET 30);
  DELETE FROM public.intel_surface_seen WHERE user_id=p_user AND org_id=p_org AND surface='chart_recent' AND last_seen_at<clock_timestamp()-interval '90 days';
  RETURN jsonb_build_object('recorded',true);
 END IF;
 WITH candidates AS (
  SELECT s.subject_key asset,s.last_seen_at at,NULL::text label FROM public.intel_surface_seen s WHERE p_tab='recent' AND s.user_id=p_user AND s.org_id=p_org AND s.surface='chart_recent' AND s.last_seen_at>now()-interval '90 days'
  UNION ALL
  SELECT e.canonical_ref_key,wi.created_at,wi.label FROM public.watchlist_items wi JOIN public.watchlists w ON w.id=wi.watchlist_id AND w.org_id=wi.org_id AND w.user_id=p_user
   JOIN public.entities e ON e.id=wi.entity_id AND e.org_id=p_org AND e.entity_kind='asset'
   WHERE p_tab='watchlist' AND wi.org_id=p_org AND wi.item_type='token' AND e.canonical_ref_key IS NOT NULL
 ), distinct_assets AS (SELECT DISTINCT ON(asset) * FROM candidates ORDER BY asset,at DESC), page AS (
  SELECT * FROM distinct_assets ORDER BY at DESC,asset LIMIT 21 OFFSET p_page*20
 ), hydrated AS (
  SELECT page.*,e.display_symbol,
   CASE WHEN page.asset LIKE 'market:%' THEN split_part(page.asset,':',2) WHEN page.asset LIKE 'rwa:coinmarketcap:%' OR page.asset IN ('native:bitcoin','native:ethereum','native:solana','native:bnb','native:avalanche') THEN 'coinmarketcap' END provider,
   CASE WHEN page.asset LIKE 'market:%' OR page.asset LIKE 'rwa:coinmarketcap:%' THEN split_part(page.asset,':',3) ELSE CASE page.asset WHEN 'native:bitcoin' THEN '1' WHEN 'native:ethereum' THEN '1027' WHEN 'native:solana' THEN '5426' WHEN 'native:bnb' THEN '1839' WHEN 'native:avalanche' THEN '5805' END END provider_id
  FROM page LEFT JOIN LATERAL(SELECT display_symbol FROM public.entities WHERE org_id=p_org AND entity_kind='asset' AND canonical_ref_key=page.asset ORDER BY id LIMIT 1)e ON true
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('asset',h.asset,'name',coalesce(nullif(h.label,''),a.name,h.display_symbol,h.asset),'symbol',coalesce(a.symbol,h.display_symbol),'logo',coalesce(a.cached_image_url,a.image_url),'visitedAt',h.at) ORDER BY h.at DESC,h.asset),'[]') INTO rows FROM hydrated h LEFT JOIN public.market_assets a ON a.source_provider=h.provider AND a.provider_id=h.provider_id;
 RETURN jsonb_build_object('assets',rows,'page',p_page,'hasMore',jsonb_array_length(rows)>20);
END $$;
REVOKE ALL ON FUNCTION public.intel_chart_navigation(uuid,uuid,text,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_chart_navigation(uuid,uuid,text,text,text,integer) TO service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_surface_seen TO service_role;
