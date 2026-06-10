-- ============================================================
-- 228: Investor Intel — long-memory read RPCs (comparisons + year-in-review)
-- ============================================================
-- Read-time intelligence over the rollups (226) + event memory (225). Powers:
--   Daily Brief prior-year/QoQ comparisons, Explain "memory context", Narrative
--   Radar longer history, Market Pulse story-cluster evidence drilldown, and
--   "what drove this asset/chain over the last year". All deterministic, no AI.
-- Aggregate/identity-stripped data → authenticated read.
-- ============================================================

-- Current month vs prior-year-same-month + previous quarter, for a subject.
CREATE OR REPLACE FUNCTION intel_rollup_compare(p_subject_type text, p_subject_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE this_m date := date_trunc('month', now())::date; v jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'forbidden'; END IF;
  WITH cur AS (SELECT * FROM intel_rollups WHERE subject_type=p_subject_type AND subject_id=upper(p_subject_id) AND period_kind='month' AND period_start=this_m),
       py  AS (SELECT * FROM intel_rollups WHERE subject_type=p_subject_type AND subject_id=upper(p_subject_id) AND period_kind='month' AND period_start=(this_m - interval '12 months')::date),
       pm  AS (SELECT * FROM intel_rollups WHERE subject_type=p_subject_type AND subject_id=upper(p_subject_id) AND period_kind='month' AND period_start=(this_m - interval '1 month')::date)
  SELECT jsonb_build_object(
    'subject_type', p_subject_type, 'subject_id', upper(p_subject_id),
    'current_month', (SELECT to_jsonb(cur.*) FROM cur),
    'prior_year_month', (SELECT to_jsonb(py.*) FROM py),
    'previous_month', (SELECT to_jsonb(pm.*) FROM pm),
    'mom_source_delta', (SELECT c.source_count FROM cur c) - (SELECT p.source_count FROM pm p),
    'yoy_source_delta', (SELECT c.source_count FROM cur c) - (SELECT y.source_count FROM py y)
  ) INTO v;
  RETURN v;
END $$;

-- Events touching a subject over a window (asset/chain/narrative/category/macro).
CREATE OR REPLACE FUNCTION intel_events_for(p_subject_type text, p_subject_id text, p_months int DEFAULT 15)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE col text; v jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'forbidden'; END IF;
  col := CASE p_subject_type WHEN 'asset' THEN 'assets' WHEN 'chain' THEN 'chains'
              WHEN 'narrative' THEN 'narratives' WHEN 'category' THEN 'categories'
              WHEN 'macro' THEN 'macro_topics' ELSE 'assets' END;
  EXECUTE format($q$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('event_type', event_type, 'title', title, 'summary', summary,
      'occurred_at', occurred_at, 'importance', importance_score) ORDER BY occurred_at DESC), '[]'::jsonb)
    FROM intel_event_memory
    WHERE %L = ANY(%I) AND occurred_at > now() - make_interval(months => %s)
  $q$, CASE WHEN p_subject_type IN ('chain','category','macro') THEN lower(p_subject_id) ELSE upper(p_subject_id) END, col, GREATEST(1, LEAST(p_months, 36))) INTO v;
  RETURN jsonb_build_object('subject_type', p_subject_type, 'subject_id', p_subject_id, 'events', v);
END $$;

-- "What drove this asset over the last year": monthly rollup series + signal mix
-- + the major events that touched it. One call powers the asset-page drilldown.
CREATE OR REPLACE FUNCTION intel_asset_year_in_review(p_symbol text, p_months int DEFAULT 15)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE sym text := upper(p_symbol); v jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT jsonb_build_object(
    'symbol', sym, 'window_months', p_months,
    'monthly', COALESCE((SELECT jsonb_agg(jsonb_build_object('month', period_start, 'source_count', source_count,
        'bullish', bullish_count, 'bearish', bearish_count, 'mixed', mixed_count,
        'avg_importance', avg_gemini_importance, 'engagement_total', engagement_total) ORDER BY period_start)
      FROM intel_rollups WHERE subject_type='asset' AND subject_id=sym AND period_kind='month'
        AND period_start > (date_trunc('month', now()) - make_interval(months => GREATEST(1, LEAST(p_months,36))))::date), '[]'::jsonb),
    'top_narratives', COALESCE((SELECT jsonb_agg(DISTINCT n) FROM intel_rollups, unnest(top_narratives) n
      WHERE subject_type='asset' AND subject_id=sym AND period_kind='month'), '[]'::jsonb),
    'events', (SELECT (intel_events_for('asset', sym, p_months))->'events'),
    'coverage_note', 'Built from surviving curated-news rollups + event memory; periods before retention/backfill may be partial.'
  ) INTO v;
  RETURN v;
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['intel_rollup_compare(text,text)','intel_events_for(text,text,int)','intel_asset_year_in_review(text,int)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;
END $$;
