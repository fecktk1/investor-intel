-- ============================================================
-- 214: Investor Intel — add intel_signal_snapshots retention to the daily prune
-- ============================================================
-- Reuses the existing narrative-prune-daily job (mig 197) — no new cron. Re-schedule
-- it (unschedule + schedule, same idempotent pattern) with one extra DELETE so the
-- append-only signal snapshots are pruned at 60 days. All other prunes unchanged.
-- ============================================================

SELECT cron.unschedule('narrative-prune-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'narrative-prune-daily');
SELECT cron.schedule('narrative-prune-daily', '45 4 * * *', $$
  DELETE FROM narrative_signal_snapshots WHERE snapshot_at < now() - interval '90 days';
  DELETE FROM narrative_score_snapshots  WHERE snapshot_at < now() - interval '120 days';
  DELETE FROM narrative_interactions     WHERE created_at  < now() - interval '60 days';
  DELETE FROM intel_signal_snapshots     WHERE snapshot_at < now() - interval '60 days';
$$);
