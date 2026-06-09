-- ============================================================
-- 160: Investor Intel — reusable SHARED analysis artifacts
-- ============================================================
-- Expensive multi-model analysis is generated ONCE per public evidence package
-- and reused across ALL users (keyed by artifact_type + entity_ref +
-- evidence_hash + contract/guardrail versions). Contains only PUBLIC/global
-- analysis — no private holdings, private thesis text, private custom-source
-- identity, or workspace data — so it is safe to read platform-wide. Private/
-- workspace-specific analysis stays in org-scoped research_artifacts (unchanged).
-- Read by any authenticated user; written by service-role (intel-generate).
-- ============================================================

CREATE TABLE IF NOT EXISTS intel_shared_artifacts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_type        text NOT NULL,
  entity_ref           text NOT NULL DEFAULT '',     -- canonical_ref_key, or '' for market-wide
  evidence_hash        text NOT NULL,
  source_set_hash      text,
  contract_version     text NOT NULL,
  guardrail_version    text NOT NULL,
  models               text[] NOT NULL DEFAULT '{}',  -- providers used (grok/openai/gemini)
  consensus            text,
  structured           jsonb NOT NULL,
  confidence           text,
  net_signal           text,
  sources              jsonb NOT NULL DEFAULT '[]',
  data_freshness       jsonb NOT NULL DEFAULT '{}',
  validation_status    text,
  model_meta           jsonb,                          -- internal: per-provider status/usage (admin/debug)
  raw_candidate_count  int,
  final_evidence_count int,
  created_at           timestamptz NOT NULL DEFAULT now(),
  stale_after          timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS intel_shared_key
  ON intel_shared_artifacts (artifact_type, entity_ref, evidence_hash, contract_version, guardrail_version);
CREATE INDEX IF NOT EXISTS intel_shared_lookup ON intel_shared_artifacts (artifact_type, entity_ref, created_at DESC);

ALTER TABLE intel_shared_artifacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_shared_read ON intel_shared_artifacts;
CREATE POLICY intel_shared_read ON intel_shared_artifacts FOR SELECT USING (auth.uid() IS NOT NULL);
-- writes are service-role only (intel-generate); no client write policy.
