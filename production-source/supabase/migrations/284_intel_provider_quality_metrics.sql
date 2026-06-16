-- ============================================================
-- 284: Provider Intelligence Stage E - internal quality metrics
-- ============================================================
-- Internal-only RPC over provider_call_logs and D1 pack tables.
-- No customer-facing UI, docs, or provider behavior changes.
-- ============================================================

CREATE OR REPLACE FUNCTION intel_provider_quality_metrics(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days integer := LEAST(90, GREATEST(1, COALESCE(p_days, 7)));
  v_since timestamptz := now() - (LEAST(90, GREATEST(1, COALESCE(p_days, 7))) || ' days')::interval;
  v_today timestamptz := date_trunc('day', now());
  v_reports numeric;
  v_page_views numeric;
  v_provider_calls numeric;
  v_total_calls numeric;
  v_hit_logs numeric;
  v_total_logs numeric;
BEGIN
  SELECT COUNT(*)::numeric INTO v_reports
  FROM intel_ai_events
  WHERE created_at >= v_since
    AND event_type IN ('token_breakdown','risk_panel','explain','wallet_summary','narrative_report','alert_explanation','token_comparison','defi_report','execution_report','daily_brief','thesis_review','story_card','narrative_brief');

  SELECT COUNT(*)::numeric INTO v_page_views
  FROM intel_ai_events
  WHERE created_at >= v_since
    AND event_type IN ('market_asset_view','markets_view','asset_view','brief_view');

  SELECT COALESCE(SUM(calls), 0)::numeric INTO v_provider_calls
  FROM provider_call_logs
  WHERE ts >= v_since;

  SELECT
    COALESCE(SUM(calls), 0)::numeric,
    COUNT(*)::numeric,
    COUNT(*) FILTER (WHERE cache_status IN ('hit','db_hit','negative_hit','suppressed'))::numeric
  INTO v_total_calls, v_total_logs, v_hit_logs
  FROM provider_call_logs
  WHERE ts >= v_since;

  RETURN jsonb_build_object(
    'window_days', v_days,
    'since', v_since,
    'generated_at', now(),
    'cache_hit_rate', CASE WHEN v_total_logs > 0 THEN ROUND(v_hit_logs / v_total_logs, 4) ELSE NULL END,
    'duplicate_call_suppression', (
      SELECT jsonb_build_object(
        'events', COUNT(*),
        'zero_call_events', COUNT(*) FILTER (WHERE calls = 0),
        'suppression_reasons', COALESCE(jsonb_object_agg(suppression_reason, reason_count) FILTER (WHERE suppression_reason IS NOT NULL), '{}'::jsonb)
      )
      FROM (
        SELECT suppression_reason, COUNT(*) AS reason_count, SUM(calls) AS calls
        FROM provider_call_logs
        WHERE ts >= v_since
          AND (cache_status IN ('hit','db_hit','negative_hit','suppressed') OR suppression_reason IS NOT NULL)
        GROUP BY suppression_reason
      ) s
    ),
    'stale_fallback_count', (
      SELECT COUNT(*)
      FROM provider_call_logs
      WHERE ts >= v_since
        AND (cache_status = 'stale_fallback' OR suppression_reason ILIKE '%stale%')
    ),
    'provider_calls_per_report', CASE WHEN v_reports > 0 THEN ROUND(v_provider_calls / v_reports, 4) ELSE NULL END,
    'provider_calls_per_page_view', CASE WHEN v_page_views > 0 THEN ROUND(v_provider_calls / v_page_views, 4) ELSE NULL END,
    'birdeye_cu', (
      SELECT jsonb_build_object(
        'today', COALESCE(SUM(credits_or_cu) FILTER (WHERE ts >= v_today), 0),
        'daily_average', CASE WHEN v_days > 0 THEN ROUND(COALESCE(SUM(credits_or_cu), 0) / v_days, 4) ELSE 0 END,
        'projected_monthly', CASE WHEN v_days > 0 THEN ROUND((COALESCE(SUM(credits_or_cu), 0) / v_days) * 30, 4) ELSE 0 END
      )
      FROM provider_call_logs
      WHERE ts >= v_since AND provider = 'birdeye'
    ),
    'provider_logs', (
      SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.calls DESC), '[]'::jsonb)
      FROM (
        SELECT
          provider,
          data_type,
          COUNT(*) AS log_rows,
          COALESCE(SUM(calls), 0) AS calls,
          COALESCE(SUM(credits_or_cu), 0) AS credits_or_cu,
          COUNT(*) FILTER (WHERE cache_status IN ('hit','db_hit','negative_hit','suppressed')) AS cache_hits,
          COUNT(*) FILTER (WHERE cache_status IN ('miss','live')) AS live_or_miss,
          COUNT(*) FILTER (WHERE cache_status = 'rate_capped') AS rate_capped,
          COUNT(*) FILTER (WHERE status_code >= 400 OR cache_status = 'error') AS errors,
          ROUND(AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL), 2) AS avg_latency_ms
        FROM provider_call_logs
        WHERE ts >= v_since
        GROUP BY provider, data_type
        ORDER BY calls DESC, log_rows DESC
        LIMIT 80
      ) x
    ),
    'evidence_pack_completeness', (
      SELECT jsonb_build_object(
        'packs', COUNT(*),
        'average_completeness', ROUND(AVG(
          CASE
            WHEN checked_count > 0 THEN used_count::numeric / checked_count::numeric
            ELSE NULL
          END
        ), 4),
        'average_material_gaps', ROUND(AVG(material_count), 4),
        'average_optional_gaps', ROUND(AVG(optional_count), 4),
        'stale_packs', COUNT(*) FILTER (WHERE stale_after <= now())
      )
      FROM (
        SELECT
          stale_after,
          CASE WHEN jsonb_typeof(data_coverage->'used_sources') = 'array' THEN jsonb_array_length(data_coverage->'used_sources') ELSE 0 END AS used_count,
          CASE WHEN jsonb_typeof(data_coverage->'checked_sources') = 'array' THEN jsonb_array_length(data_coverage->'checked_sources') ELSE 0 END AS checked_count,
          CASE WHEN jsonb_typeof(data_coverage->'material_gaps') = 'array' THEN jsonb_array_length(data_coverage->'material_gaps') ELSE 0 END AS material_count,
          CASE WHEN jsonb_typeof(data_coverage->'optional_gaps') = 'array' THEN jsonb_array_length(data_coverage->'optional_gaps') ELSE 0 END AS optional_count
        FROM intelligence_evidence_packs
        WHERE built_at >= v_since
      ) p
    ),
    'report_coverage_score', (
      SELECT ROUND(AVG(
        GREATEST(0, LEAST(1,
          CASE
            WHEN checked_count > 0 THEN (used_count::numeric / checked_count::numeric) - (material_count::numeric * 0.08)
            ELSE 0
          END
        ))
      ), 4)
      FROM (
        SELECT
          CASE WHEN jsonb_typeof(data_coverage->'used_sources') = 'array' THEN jsonb_array_length(data_coverage->'used_sources') ELSE 0 END AS used_count,
          CASE WHEN jsonb_typeof(data_coverage->'checked_sources') = 'array' THEN jsonb_array_length(data_coverage->'checked_sources') ELSE 0 END AS checked_count,
          CASE WHEN jsonb_typeof(data_coverage->'material_gaps') = 'array' THEN jsonb_array_length(data_coverage->'material_gaps') ELSE 0 END AS material_count
        FROM intelligence_evidence_packs
        WHERE built_at >= v_since
      ) p
    ),
    'ai_context_packs', (
      SELECT jsonb_build_object(
        'packs', COUNT(*),
        'average_blocks', ROUND(AVG(CASE WHEN jsonb_typeof(blocks) = 'array' THEN jsonb_array_length(blocks) ELSE 0 END), 4),
        'stale_packs', COUNT(*) FILTER (WHERE stale_after <= now())
      )
      FROM ai_context_packs
      WHERE assembled_at >= v_since
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION intel_provider_quality_metrics(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION intel_provider_quality_metrics(integer) TO service_role;
