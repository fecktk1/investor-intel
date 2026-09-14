-- Both SQL evaluators and PostgREST writers use (rule_id,dedup_key) as their
-- conflict target. A partial index cannot satisfy that target without a
-- predicate. The full index preserves NULL-distinct legacy-event behavior.
CREATE UNIQUE INDEX intel_alert_events_dedup_upsert ON public.intel_alert_events(rule_id,dedup_key);
DROP INDEX public.iae_dedup;
ALTER INDEX public.intel_alert_events_dedup_upsert RENAME TO iae_dedup;
