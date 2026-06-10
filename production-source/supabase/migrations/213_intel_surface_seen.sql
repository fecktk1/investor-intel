-- ============================================================
-- 213: Investor Intel — per-user/per-surface "last seen" + what_changed
-- ============================================================
-- Generalizes the alert read_at flag across surfaces so every page can show
-- "what changed since your last visit". The ONLY user-scoped addition in the
-- signal backbone. Scoped to the acting user within their org (mirrors mig 195).
--
-- mark_surface_seen()  — one tiny upsert, called on page mount/unmount (debounced).
-- what_changed()       — deterministic change summary since last_seen, assembled
--                        from EXISTING stored data only (alert events, followed
--                        narrative stage moves, watchlist/holding signal flips).
--                        No new data calls; no AI.
-- ============================================================

CREATE TABLE IF NOT EXISTS intel_surface_seen (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES orgs(id)     ON DELETE CASCADE,
  surface      text NOT NULL,                 -- market_pulse|news|watchlist|portfolio|narratives|alerts|wallets|brief|saved|thesis
  subject_key  text NOT NULL DEFAULT '',      -- '' = whole surface; or "asset:{canonical_id}" for a row (canonical, never a symbol)
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id, surface, subject_key)
);
CREATE INDEX IF NOT EXISTS iss_seen_user ON intel_surface_seen(user_id, surface);

ALTER TABLE intel_surface_seen ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_surface_seen_rw ON intel_surface_seen;
CREATE POLICY intel_surface_seen_rw ON intel_surface_seen FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND org_id = get_my_org_id());

-- ── mark a surface (or row) seen ─────────────────────────────
CREATE OR REPLACE FUNCTION mark_surface_seen(p_surface text, p_subject_key text DEFAULT '')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  v_org := get_my_org_id();
  IF v_org IS NULL THEN RETURN; END IF;
  INSERT INTO intel_surface_seen (user_id, org_id, surface, subject_key, last_seen_at)
    VALUES (auth.uid(), v_org, p_surface, COALESCE(p_subject_key, ''), now())
  ON CONFLICT (user_id, org_id, surface, subject_key) DO UPDATE SET last_seen_at = now();
END $$;

-- ── deterministic "what changed since last visit" ────────────
-- Returns a jsonb array of {kind, subject, summary, severity, ref, at}. Uses the
-- caller's last_seen for p_surface when p_since is NULL. Reads only stored data.
CREATE OR REPLACE FUNCTION what_changed(p_surface text, p_since timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid; v_since timestamptz; v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  v_org := get_my_org_id();
  IF v_org IS NULL THEN RETURN '[]'::jsonb; END IF;
  v_since := COALESCE(
    p_since,
    (SELECT last_seen_at FROM intel_surface_seen WHERE user_id = auth.uid() AND surface = p_surface AND subject_key = ''),
    now() - interval '7 days'
  );

  WITH
  wl AS (
    SELECT COALESCE(array_agg(DISTINCT lower(e.canonical_ref_key)) FILTER (WHERE e.canonical_ref_key IS NOT NULL), '{}') AS keys
    FROM watchlist_items wi JOIN entities e ON e.id = wi.entity_id
    WHERE wi.org_id = v_org AND e.entity_kind = 'asset'
  ),
  hk AS (
    SELECT COALESCE(array_agg(DISTINCT lower(h.canonical_asset_id)) FILTER (WHERE h.canonical_asset_id IS NOT NULL), '{}') AS keys
    FROM investor_portfolios p JOIN investor_portfolio_holdings h ON h.portfolio_id = p.id
    WHERE p.org_id = v_org AND p.user_id = auth.uid()
  ),
  fol AS (
    SELECT COALESCE(array_agg(t.slug), '{}') AS slugs
    FROM user_followed_narratives f JOIN narrative_taxonomy t ON t.id = f.narrative_id
    WHERE f.user_id = auth.uid()
  ),
  alerts AS (
    SELECT jsonb_build_object(
             'kind','alert',
             'subject', COALESCE(ev.payload->>'symbol', ev.payload->>'name', 'Alert'),
             'summary', COALESCE(ev.payload->>'reason', ev.payload->>'trigger_type', 'An alert fired'),
             'severity','medium', 'ref', NULL, 'at', ev.fired_at) AS j, ev.fired_at AS at
    FROM intel_alert_events ev WHERE ev.org_id = v_org AND ev.fired_at > v_since
    ORDER BY ev.fired_at DESC LIMIT 10
  ),
  narr AS (
    SELECT jsonb_build_object(
             'kind','narrative', 'subject', t.name,
             'summary', concat('Narrative moved ', COALESCE(s.prev_stage,'—'), ' → ', s.lifecycle_stage),
             'severity','medium', 'ref', t.slug, 'at', s.stage_changed_at) AS j, s.stage_changed_at AS at
    FROM narrative_state s JOIN narrative_taxonomy t ON t.id = s.narrative_id
    CROSS JOIN fol
    WHERE s.stage_changed_at > v_since
      AND s.prev_stage IS DISTINCT FROM s.lifecycle_stage
      AND array_length(fol.slugs,1) IS NOT NULL AND t.slug = ANY(fol.slugs)
    ORDER BY s.stage_changed_at DESC LIMIT 10
  ),
  sig AS (
    SELECT jsonb_build_object(
             'kind','signal', 'subject', COALESCE(s.display_symbol, s.subject_id),
             'summary', CASE
                 WHEN (s.score_delta->>'prev_direction') IS NOT NULL AND s.score_delta->>'prev_direction' <> s.direction
                 THEN concat('Signal flipped ', s.score_delta->>'prev_direction', ' → ', s.direction)
                 ELSE concat('Signal updated (', s.direction, ')') END,
             'severity', CASE
                 WHEN (s.score_delta->>'prev_direction') IS NOT NULL AND s.score_delta->>'prev_direction' <> s.direction
                 THEN 'high' ELSE 'medium' END,
             'ref', s.subject_id, 'at', s.generated_at) AS j, s.generated_at AS at
    FROM intel_signal_state s CROSS JOIN wl CROSS JOIN hk
    WHERE s.subject_type = 'asset' AND s.generated_at > v_since
      AND ( (array_length(wl.keys,1) IS NOT NULL AND lower(s.subject_id) = ANY(wl.keys))
            OR (array_length(hk.keys,1) IS NOT NULL AND lower(s.subject_id) = ANY(hk.keys)) )
      AND ( ((s.score_delta->>'prev_direction') IS NOT NULL AND s.score_delta->>'prev_direction' <> s.direction)
            OR abs(COALESCE((s.score_delta->>'d_global_score')::numeric, 0)) >= 0.12 )
    ORDER BY s.generated_at DESC LIMIT 12
  )
  SELECT COALESCE(jsonb_agg(x.j ORDER BY x.at DESC), '[]'::jsonb) INTO v_out
  FROM ( SELECT j, at FROM alerts
         UNION ALL SELECT j, at FROM narr
         UNION ALL SELECT j, at FROM sig ) x;
  RETURN v_out;
END $$;

DO $$ BEGIN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION mark_surface_seen(text,text) FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION mark_surface_seen(text,text) TO authenticated, service_role';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION what_changed(text,timestamptz) FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION what_changed(text,timestamptz) TO authenticated, service_role';
END $$;
