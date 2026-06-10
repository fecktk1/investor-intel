-- ============================================================
-- 217: Investor Intel — Thesis Tracker → proactive review
-- ============================================================
-- Deterministic drift state computed by the existing intel-alerts-eval cron (no
-- new cron, no provider calls): compares the thesis baseline + side against the
-- current stored Intel Signal. Neutral language only (supports / weakens /
-- no_effect) — research context, never advice. Alert-rule suggestions parsed
-- deterministically from what_would_confirm / what_would_invalidate are stored in
-- suggested_rules and created ONLY on explicit user accept.
-- ============================================================

ALTER TABLE intel_theses ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE intel_theses ADD COLUMN IF NOT EXISTS drift_state text;            -- supports|weakens|no_effect|unknown
ALTER TABLE intel_theses ADD COLUMN IF NOT EXISTS drift_detail jsonb NOT NULL DEFAULT '{}';
ALTER TABLE intel_theses ADD COLUMN IF NOT EXISTS last_drift_at timestamptz;
ALTER TABLE intel_theses ADD COLUMN IF NOT EXISTS auto_rule_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE intel_theses ADD COLUMN IF NOT EXISTS suggested_rules jsonb NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS it_org_needs_review ON intel_theses(org_id) WHERE needs_review;

-- intel_thesis_links: allow signal/news/narrative links (ref_key text for
-- non-uuid subjects like intel_signal_state.signal_key / narrative slugs).
ALTER TABLE intel_thesis_links ADD COLUMN IF NOT EXISTS ref_key text;
ALTER TABLE intel_thesis_links ALTER COLUMN ref_id DROP NOT NULL;
ALTER TABLE intel_thesis_links DROP CONSTRAINT IF EXISTS intel_thesis_links_link_kind_check;
ALTER TABLE intel_thesis_links ADD CONSTRAINT intel_thesis_links_link_kind_check
  CHECK (link_kind IN ('watchlist_item','research_artifact','signal','news','narrative'));
CREATE UNIQUE INDEX IF NOT EXISTS itl_thesis_kind_key
  ON intel_thesis_links(thesis_id, link_kind, COALESCE(ref_key, ref_id::text));
