-- ============================================================
-- 216: Investor Intel — alerts: smarter, not noisier
-- ============================================================
-- Same 15-min evaluation cadence, zero extra polling. Adds:
--   * dedup_key + a partial UNIQUE index — DB-level duplicate suppression
--     (same rule + metric + 5% value band + day fires ONCE).
--   * per-rule cooldown_minutes (NULL → the existing 720-min default), with
--     deterministic auto-escalation for noisy rules in the evaluator.
--   * quality_score / noisy / suggested_config — deterministic noise scoring
--     + one-click threshold tuning, persisted on the rule.
--   * signal_ref / group_id on events — link to the stored Intel Signal (drives
--     the no-AI "why this fired now" / "what confirms or weakens") and group
--     related events from one run into a digest.
-- ============================================================

ALTER TABLE intel_alert_rules ADD COLUMN IF NOT EXISTS cooldown_minutes int;
ALTER TABLE intel_alert_rules ADD COLUMN IF NOT EXISTS quality_score numeric;
ALTER TABLE intel_alert_rules ADD COLUMN IF NOT EXISTS noisy boolean NOT NULL DEFAULT false;
ALTER TABLE intel_alert_rules ADD COLUMN IF NOT EXISTS suggested_config jsonb NOT NULL DEFAULT '{}';
ALTER TABLE intel_alert_rules ADD COLUMN IF NOT EXISTS last_quality_at timestamptz;

ALTER TABLE intel_alert_events ADD COLUMN IF NOT EXISTS dedup_key text;
ALTER TABLE intel_alert_events ADD COLUMN IF NOT EXISTS signal_ref text;       -- intel_signal_state.signal_key
ALTER TABLE intel_alert_events ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE intel_alert_events ADD COLUMN IF NOT EXISTS quality_score numeric;

CREATE UNIQUE INDEX IF NOT EXISTS iae_dedup
  ON intel_alert_events(rule_id, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS iae_group ON intel_alert_events(group_id) WHERE group_id IS NOT NULL;
