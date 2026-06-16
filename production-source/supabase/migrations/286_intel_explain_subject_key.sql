-- ============================================================
-- 286: Investor Intel — asset-scope the "explain" similarity reuse
-- ============================================================
-- The Markets "AI explanation" reuses a recent answer via similarRecentExplain
-- (HMAC norm-hash + Jaccard shingles over the question). Market-page explains are
-- stored with entity_id IS NULL, so ALL of them were pooled together; the question
-- template differs only by the asset symbol, so shingle similarity (>= 0.8) matched
-- ACROSS assets and a stored ZEC answer was served on every asset page.
--
-- explain_subject_key pins each explain artifact to its asset (canonical key /
-- provider id / symbol). similarRecentExplain now filters candidates by it, so reuse
-- can only ever happen within the SAME asset. NULL key => fungible educational
-- "explain" (e.g. "what is liquidity") which keeps the old entity_id-null behaviour.
--
-- Additive + idempotent (mirrors 215_intel_reuse_delta.sql). intel-generate strips
-- the column on insert when this migration hasn't been applied yet, so a
-- function-first deploy degrades to "no reuse" instead of hard-failing.
-- ============================================================

ALTER TABLE research_artifacts ADD COLUMN IF NOT EXISTS explain_subject_key text;

CREATE INDEX IF NOT EXISTS ra_org_explain_subject
  ON research_artifacts(org_id, artifact_type, explain_subject_key, created_at DESC)
  WHERE artifact_type = 'explain' AND explain_subject_key IS NOT NULL;
