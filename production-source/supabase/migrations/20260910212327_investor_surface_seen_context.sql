-- Personal reading baselines are exact user + organization + surface snapshots.
-- Keep the original RPCs as compatible wrappers; a first visit has no invented history.
CREATE INDEX IF NOT EXISTS iss_seen_user_org_surface
  ON public.intel_surface_seen(user_id, org_id, surface, subject_key);
DROP POLICY IF EXISTS intel_surface_seen_rw ON public.intel_surface_seen;
CREATE POLICY intel_surface_seen_rw ON public.intel_surface_seen FOR ALL
  USING (user_id = (SELECT auth.uid()) AND org_id IN (SELECT public.intel_portfolio_org_ids()))
  WITH CHECK (user_id = (SELECT auth.uid()) AND org_id IN (SELECT public.intel_portfolio_org_ids()));

CREATE OR REPLACE FUNCTION public.intel_mark_surface_seen(
  p_org_id uuid, p_surface text, p_subject_key text DEFAULT '',
  p_observed_at timestamptz DEFAULT NULL, p_user_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_seen timestamptz := COALESCE(p_observed_at, now());
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501'; END IF;
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.intel_portfolio_org_ids())
     OR (p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid()) THEN
    RAISE EXCEPTION 'Workspace changed' USING ERRCODE = '42501';
  END IF;
  IF p_surface IS NULL OR length(p_surface) NOT BETWEEN 1 AND 80
     OR length(COALESCE(p_subject_key, '')) > 512 OR v_seen > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'Invalid reading baseline' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.intel_surface_seen(user_id, org_id, surface, subject_key, last_seen_at)
  VALUES (auth.uid(), p_org_id, p_surface, COALESCE(p_subject_key, ''), LEAST(v_seen, now()))
  ON CONFLICT (user_id, org_id, surface, subject_key) DO UPDATE
    SET last_seen_at = GREATEST(intel_surface_seen.last_seen_at, EXCLUDED.last_seen_at);
END $$;

CREATE OR REPLACE FUNCTION public.intel_what_changed_context(
  p_org_id uuid, p_surface text, p_since timestamptz DEFAULT NULL, p_user_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_since timestamptz; v_observed timestamptz := now(); v_out jsonb; v_first boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501'; END IF;
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.intel_portfolio_org_ids())
     OR (p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid()) THEN
    RAISE EXCEPTION 'Workspace changed' USING ERRCODE = '42501';
  END IF;
  IF p_surface IS NULL OR length(p_surface) NOT BETWEEN 1 AND 80 OR p_since > v_observed THEN
    RAISE EXCEPTION 'Invalid reading baseline' USING ERRCODE = '22023';
  END IF;
  SELECT s.last_seen_at INTO v_since FROM public.intel_surface_seen s
    WHERE s.user_id = auth.uid() AND s.org_id = p_org_id AND s.surface = p_surface AND s.subject_key = '';
  v_first := v_since IS NULL AND p_since IS NULL;
  v_since := COALESCE(p_since, v_since);
  IF v_since IS NULL THEN
    RETURN jsonb_build_object('items', '[]'::jsonb, 'firstVisit', true, 'since', NULL,
      'observedAt', v_observed, 'source', 'stored_activity', 'coverage', 'baseline_pending');
  END IF;

  -- Definer access is needed for exact private identity helpers and nondefault
  -- workspace reads. Every personal source is scoped to the verified actor.
  WITH entity_keys AS MATERIALIZED (
    SELECT e.id,app_private.intel_entity_identity_aliases(e,e.canonical_ref_key) keys
    FROM public.entities e WHERE e.org_id=p_org_id AND e.entity_kind='asset'
  ), wl AS (
    SELECT COALESCE(array_agg(DISTINCT k.key) FILTER (WHERE k.key IS NOT NULL), '{}') AS keys
    FROM public.watchlist_items wi JOIN public.watchlists w ON w.id=wi.watchlist_id AND w.org_id=wi.org_id AND w.user_id=auth.uid()
    JOIN entity_keys e ON e.id=wi.entity_id CROSS JOIN LATERAL unnest(e.keys) k(key)
    WHERE wi.org_id = p_org_id
  ), hk AS (
    SELECT COALESCE(array_agg(DISTINCT k.key) FILTER (WHERE k.key IS NOT NULL), '{}') AS keys
    FROM public.investor_portfolios p JOIN public.investor_portfolio_holdings h ON h.portfolio_id = p.id
    CROSS JOIN LATERAL unnest(ARRAY[h.canonical_asset_key,CASE WHEN h.canonical_asset_id ~ '^(market:|eip155:|solana:|bip122:|native:)' THEN h.canonical_asset_id END] ||
      ARRAY(SELECT unnest(e.keys) FROM entity_keys e WHERE h.canonical_asset_key=ANY(e.keys)) ||
      CASE WHEN h.canonical_asset_key IN ('eip155:1:native','eip155:8453:native','eip155:42161:native','eip155:10:native','eip155:59144:native','eip155:534352:native','eip155:324:native','eip155:81457:native') THEN ARRAY['market:coingecko:ethereum','market:coinmarketcap:1027']
      WHEN h.canonical_asset_key='bip122:native:BTC' THEN ARRAY['market:coingecko:bitcoin','market:coinmarketcap:1']
      WHEN h.canonical_asset_key='solana:native:SOL' THEN ARRAY['market:coingecko:solana','market:coinmarketcap:5426']
      WHEN h.canonical_asset_key='eip155:56:native' THEN ARRAY['market:coingecko:binancecoin','market:coinmarketcap:1839'] ELSE '{}'::text[] END) AS k(key)
    WHERE p.org_id = p_org_id AND p.user_id = auth.uid() AND h.org_id = p_org_id AND h.user_id = auth.uid()
      AND NOT coalesce(h.is_closed,false) AND h.quantity>0
  ), fol AS (
    SELECT COALESCE(array_agg(t.slug), '{}') AS slugs
    FROM public.user_followed_narratives f JOIN public.narrative_taxonomy t ON t.id = f.narrative_id
    WHERE f.user_id = auth.uid() AND f.org_id = p_org_id
  ), alerts AS (
    SELECT jsonb_build_object('kind','alert', 'subject',COALESCE(ev.payload->>'symbol',ev.payload->>'name','Alert'),
      'summary',COALESCE(ev.payload->>'reason',ev.payload->>'trigger_type','An alert fired'),
      'severity','medium','ref',NULL,'at',ev.fired_at) AS j, ev.fired_at AS at
    FROM public.intel_alert_events ev
    JOIN public.intel_alert_rules r ON r.id=ev.rule_id AND r.org_id=ev.org_id AND r.user_id=auth.uid()
    WHERE ev.org_id = p_org_id AND ev.fired_at > v_since AND ev.fired_at <= v_observed
    ORDER BY ev.fired_at DESC LIMIT 10
  ), narr AS (
    SELECT jsonb_build_object('kind','narrative','subject',t.name,
      'summary',concat('Narrative moved ',COALESCE(s.prev_stage,'—'),' → ',s.lifecycle_stage),
      'severity','medium','ref',t.slug,'at',s.stage_changed_at) AS j, s.stage_changed_at AS at
    FROM public.narrative_state s JOIN public.narrative_taxonomy t ON t.id = s.narrative_id CROSS JOIN fol
    WHERE s.stage_changed_at > v_since AND s.stage_changed_at <= v_observed
      AND s.prev_stage IS DISTINCT FROM s.lifecycle_stage AND t.slug = ANY(fol.slugs)
    ORDER BY s.stage_changed_at DESC LIMIT 10
  ), sig AS (
    SELECT jsonb_build_object('kind','signal','subject',COALESCE(s.display_symbol,s.subject_id),
      'summary',CASE WHEN s.score_delta->>'prev_direction' IS NOT NULL AND s.score_delta->>'prev_direction' <> s.direction
        THEN concat('Signal flipped ',s.score_delta->>'prev_direction',' → ',s.direction)
        ELSE concat('Signal updated (',s.direction,')') END,
      'severity',CASE WHEN s.score_delta->>'prev_direction' IS NOT NULL AND s.score_delta->>'prev_direction' <> s.direction
        THEN 'high' ELSE 'medium' END, 'ref',s.subject_id,'at',s.generated_at) AS j, s.generated_at AS at
    FROM public.intel_signal_state s CROSS JOIN wl CROSS JOIN hk
    WHERE s.subject_type = 'asset' AND s.generated_at > v_since AND s.generated_at <= v_observed
      AND (CASE WHEN s.subject_id LIKE 'cg:%' THEN 'market:coingecko:'||substr(s.subject_id,4) WHEN s.subject_id LIKE 'cmc:%' THEN 'market:coinmarketcap:'||substr(s.subject_id,5) ELSE s.subject_id END = ANY(wl.keys)
        OR CASE WHEN s.subject_id LIKE 'cg:%' THEN 'market:coingecko:'||substr(s.subject_id,4) WHEN s.subject_id LIKE 'cmc:%' THEN 'market:coinmarketcap:'||substr(s.subject_id,5) ELSE s.subject_id END = ANY(hk.keys))
      AND ((s.score_delta->>'prev_direction' IS NOT NULL AND s.score_delta->>'prev_direction' <> s.direction)
        OR abs(CASE WHEN s.score_delta->>'d_global_score' ~ '^[-+]?[0-9]+([.][0-9]+)?$'
          THEN (s.score_delta->>'d_global_score')::numeric ELSE 0 END) >= 0.12)
    ORDER BY s.generated_at DESC LIMIT 12
  ) SELECT COALESCE(jsonb_agg(x.j ORDER BY x.at DESC), '[]'::jsonb) INTO v_out
    FROM (SELECT j,at FROM alerts UNION ALL SELECT j,at FROM narr UNION ALL SELECT j,at FROM sig) x;
  RETURN jsonb_build_object('items',v_out,'firstVisit',v_first,'since',v_since,'observedAt',v_observed,
    'source','stored_activity','coverage','latest_stored_changes');
END $$;

CREATE OR REPLACE FUNCTION public.mark_surface_seen(p_surface text, p_subject_key text DEFAULT '')
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT public.intel_mark_surface_seen(public.get_my_org_id(),p_surface,p_subject_key,NULL,auth.uid());
$$;
CREATE OR REPLACE FUNCTION public.what_changed(p_surface text, p_since timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT public.intel_what_changed_context(public.get_my_org_id(),p_surface,p_since,auth.uid())->'items';
$$;
GRANT SELECT, INSERT, UPDATE ON public.intel_surface_seen TO authenticated;
REVOKE ALL ON FUNCTION public.intel_mark_surface_seen(uuid,text,text,timestamptz,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.intel_what_changed_context(uuid,text,timestamptz,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.intel_mark_surface_seen(uuid,text,text,timestamptz,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.intel_what_changed_context(uuid,text,timestamptz,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.mark_surface_seen(text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.what_changed(text,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_surface_seen(text,text),public.what_changed(text,timestamptz) TO authenticated;
