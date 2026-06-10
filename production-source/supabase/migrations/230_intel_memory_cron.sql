-- ============================================================
-- 230: Investor Intel — daily long-memory cron (deterministic, no AI/providers)
-- ============================================================
-- Runs the compounding-intelligence maintenance entirely in SQL via pg_cron — no
-- edge function, no model calls. Each step is idempotent (UNIQUE upserts):
--   * roll up the current month + quarter from surviving curated news
--   * recompute source reliability
--   * promote major/historic events from stored Gemini/Grok importance
-- Runs at 05:10 UTC, after the 04:30 portfolio sync, 04:45 snapshot prune, and
-- 05:00 daily brief. NON-destructive. The dry-run prune preview stays on-demand
-- (intel_prune_preview) — no destructive prune is scheduled.
-- ============================================================

SELECT cron.unschedule('intel-memory-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-memory-daily');
SELECT cron.schedule('intel-memory-daily', '10 5 * * *', $$
  SELECT intel_compute_rollups('month',   date_trunc('month', now())::date,   false);
  SELECT intel_compute_rollups('quarter', date_trunc('quarter', now())::date, false);
  SELECT intel_compute_source_reliability();
  SELECT intel_promote_events(78, 35);
$$);
