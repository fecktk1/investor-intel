-- Cover parent deletion and owner cleanup on the existing retry/review ledgers.
SET LOCAL lock_timeout='5s';
CREATE INDEX IF NOT EXISTS intel_chart_alert_operations_rule_ref ON public.intel_chart_alert_operations(rule_id);
CREATE INDEX IF NOT EXISTS intel_chart_alert_operations_user_ref ON public.intel_chart_alert_operations(user_id);
CREATE INDEX IF NOT EXISTS intel_thesis_reviews_artifact_ref ON public.intel_thesis_reviews(ai_artifact_id);
CREATE INDEX IF NOT EXISTS intel_thesis_reviews_snapshot_ref ON public.intel_thesis_reviews(snapshot_id);
CREATE INDEX IF NOT EXISTS intel_thesis_reviews_user_ref ON public.intel_thesis_reviews(user_id);
