-- ============================================================
-- 218: Investor Intel — intelligence quality audit (super-admin only)
-- ============================================================
-- Read-only diagnostics over the cost ledger + artifacts + alerts: cache hit
-- rate, duplicate AI calls avoided, stale artifacts, signal reuse, alert noise,
-- and per-card ranking/inclusion explanations. is_super_admin() gated — NOT in
-- the customer GitBook.
-- ============================================================

CREATE OR REPLACE FUNCTION intel_admin_quality_audit(p_hours int DEFAULT 24)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_since timestamptz := now() - make_interval(hours => GREATEST(1, LEAST(p_hours, 720))); v jsonb;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT jsonb_build_object(
    'window_hours', p_hours,
    -- cost ledger (precise rows only: bucket_start IS NULL)
    'generation_events', (SELECT count(*) FROM intel_cost_ledger WHERE created_at > v_since AND bucket_start IS NULL AND cache_status IS NOT NULL),
    'cache_hit_rate', (
      SELECT CASE WHEN count(*) = 0 THEN NULL ELSE
        round(count(*) FILTER (WHERE cache_status IN ('hit','shared_hit','reuse_unchanged','explain_similar'))::numeric / count(*), 3) END
      FROM intel_cost_ledger WHERE created_at > v_since AND bucket_start IS NULL
        AND cache_status IN ('hit','shared_hit','reuse_unchanged','explain_similar','delta','fresh','miss')),
    'duplicate_ai_avoided', (SELECT count(*) FROM intel_cost_ledger WHERE created_at > v_since AND bucket_start IS NULL
        AND cache_status IN ('hit','shared_hit','reuse_unchanged','explain_similar')),
    'delta_generations', (SELECT count(*) FROM intel_cost_ledger WHERE created_at > v_since AND bucket_start IS NULL AND cache_status = 'delta'),
    'fresh_generations', (SELECT count(*) FROM intel_cost_ledger WHERE created_at > v_since AND bucket_start IS NULL AND cache_status = 'fresh'),
    'force_refreshes', (SELECT count(*) FROM intel_force_refresh_log WHERE created_at > v_since),
    'by_cache_status', (SELECT COALESCE(jsonb_object_agg(cache_status, n), '{}'::jsonb) FROM (
        SELECT cache_status, count(*) AS n FROM intel_cost_ledger
        WHERE created_at > v_since AND bucket_start IS NULL AND cache_status IS NOT NULL GROUP BY cache_status) x),
    -- render volume (bucketed rows)
    'bucketed_render_count', (SELECT COALESCE(sum((usage->>'render_count')::int), 0) FROM intel_cost_ledger
        WHERE created_at > v_since AND bucket_start IS NOT NULL),
    'provider_calls_made', (SELECT COALESCE(sum(provider_calls_made), 0) FROM intel_cost_ledger WHERE created_at > v_since),
    'provider_calls_avoided', (SELECT COALESCE(sum(provider_calls_avoided), 0) FROM intel_cost_ledger WHERE created_at > v_since),
    -- artifacts
    'stale_artifact_count', (SELECT count(*) FROM research_artifacts WHERE status = 'ready' AND stale_after < now()),
    'artifacts_total', (SELECT count(*) FROM research_artifacts),
    -- signal store
    'signals_active', (SELECT count(*) FROM intel_signal_state WHERE expires_at > now()),
    'signals_snapshots_24h', (SELECT count(*) FROM intel_signal_snapshots WHERE snapshot_at > v_since),
    'signals_referenced_by_alerts', (SELECT count(DISTINCT signal_ref) FROM intel_alert_events WHERE fired_at > v_since AND signal_ref IS NOT NULL),
    -- alert noise
    'alerts_fired', (SELECT count(*) FROM intel_alert_events WHERE fired_at > v_since),
    'alerts_noisy_rules', (SELECT count(*) FROM intel_alert_rules WHERE noisy),
    'alerts_open_rate', (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE
        round(count(*) FILTER (WHERE read_at IS NOT NULL)::numeric / count(*), 3) END
        FROM intel_alert_events WHERE fired_at > v_since)
  ) INTO v;
  RETURN v;
END $$;

-- Why a card ranked / what evidence backed it — the stored package + verdicts.
CREATE OR REPLACE FUNCTION intel_admin_card_ranking(p_artifact_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT jsonb_build_object(
    'artifact_id', a.id, 'artifact_type', a.artifact_type, 'org_id', a.org_id,
    'model', a.model, 'reuse_kind', a.reuse_kind, 'base_artifact_id', a.base_artifact_id,
    'evidence_hash', a.evidence_hash, 'confidence', a.confidence,
    'validation_status', a.validation_status, 'validator_outcome', a.validator_outcome,
    'signal_snapshot', a.signal_snapshot, 'evidence', a.evidence,
    'sources', a.sources, 'missing_context', a.missing_context,
    'created_at', a.created_at, 'stale_after', a.stale_after,
    'ledger_events', COALESCE((SELECT jsonb_agg(jsonb_build_object('created_at', l.created_at, 'cache_status', l.cache_status, 'allow_reason', l.allow_reason, 'model', l.model) ORDER BY l.created_at DESC)
        FROM (SELECT * FROM intel_cost_ledger WHERE evidence_hash = a.evidence_hash AND feature = a.artifact_type ORDER BY created_at DESC LIMIT 10) l), '[]'::jsonb)
  ) INTO v FROM research_artifacts a WHERE a.id = p_artifact_id;
  RETURN v;
END $$;

-- Why a news item was included/excluded — the artifact's evidence list vs the
-- recent corpus (items in the window that did NOT make the package).
CREATE OR REPLACE FUNCTION intel_admin_news_inclusion(p_artifact_id uuid, p_window_days int DEFAULT 14)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb; v_evidence jsonb; v_created timestamptz;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT a.evidence, a.created_at INTO v_evidence, v_created FROM research_artifacts a WHERE a.id = p_artifact_id;
  IF v_created IS NULL THEN RETURN NULL; END IF;
  SELECT jsonb_build_object(
    'included', COALESCE(v_evidence, '[]'::jsonb),
    'excluded_sample', COALESCE((SELECT jsonb_agg(jsonb_build_object('title', g.title, 'source', g.source_name, 'published_at', g.published_at) ORDER BY g.published_at DESC)
        FROM (SELECT title, source_name, published_at FROM intel_global_news
              WHERE created_at BETWEEN v_created - make_interval(days => GREATEST(1, LEAST(p_window_days, 30))) AND v_created
              ORDER BY published_at DESC NULLS LAST LIMIT 25) g), '[]'::jsonb),
    'note', 'included = the ranked evidence stored on the artifact; excluded_sample = recent corpus items in the window that did not make the package (scored lower on recency/trust/corroboration/relevance).'
  ) INTO v;
  RETURN v;
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'intel_admin_quality_audit(int)',
    'intel_admin_card_ranking(uuid)',
    'intel_admin_news_inclusion(uuid,int)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;
END $$;
