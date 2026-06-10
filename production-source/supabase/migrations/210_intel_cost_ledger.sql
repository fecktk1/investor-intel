-- ============================================================
-- 210: Investor Intel — cost / reuse ledger (foundational)
-- ============================================================
-- The authoritative record of every AI/provider-sensitive DECISION, without
-- write-amplifying normal reads. Two tiers (see _shared/core-intel/cost-ledger.ts):
--   * precise rows   — one per event (AI call, reuse, delta, force, provider call,
--                      scheduled job run). bucket_start IS NULL.
--   * bucketed rows  — high-frequency deterministic reads (dashboard/markets renders)
--                      collapse into ONE row per (feature, org_id, hour, status,
--                      allow_reason) via the partial unique index; writers upsert and
--                      increment usage.render_count / provider_calls_avoided.
--
-- org_id NULL = a platform/global run (e.g. the signal producer, daily global
-- synthesis). Global NULL-org rows are visible to super-admins only and must carry
-- NO private data (canonical refs / hashes only). Investor-scoped this release, but
-- generically shaped so a future Intelligence Core can reuse the writer.
-- Read: own org (or super-admin). Write: service-role only.
-- ============================================================

CREATE TABLE IF NOT EXISTS intel_cost_ledger (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  feature               text NOT NULL,          -- asset_breakdown|explain|daily_brief|alerts_eval|signal_producer|dashboard|portfolio|narrative_brief|thesis_review|...
  org_id                uuid REFERENCES orgs(id) ON DELETE CASCADE,   -- NULL = platform/global run
  artifact_type         text,
  model                 text,                   -- NULL when no AI ran
  cache_status          text,                   -- hit|shared_hit|reuse_unchanged|explain_similar|delta|miss|fresh|no_ai
  reuse_kind            text,
  evidence_hash         text,
  source_set_hash       text,
  provider_calls_avoided int NOT NULL DEFAULT 0,
  provider_calls_made    int NOT NULL DEFAULT 0,
  allow_reason          text,                   -- evidence_changed_material|evidence_changed_minor|no_prior_artifact|force_refresh|first_run|n/a_no_ai|fallback|degraded
  est_cost_usd          numeric,
  usage                 jsonb NOT NULL DEFAULT '{}',   -- tokens_in/out, per-provider breakdown; for bucketed rows also render_count
  subject_ref           text,                   -- canonical entity key only (never a raw question/address/holding)
  bucket_start          timestamptz             -- set for bucketed rows (the hour bucket); NULL for precise event rows
);

CREATE INDEX IF NOT EXISTS icl_org_time     ON intel_cost_ledger(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS icl_feature_time ON intel_cost_ledger(feature, created_at DESC);
CREATE INDEX IF NOT EXISTS icl_cache_status ON intel_cost_ledger(cache_status);
CREATE INDEX IF NOT EXISTS icl_evidence     ON intel_cost_ledger(evidence_hash);

-- Bucket-enforcing partial unique index: bucketed writers upsert + increment so a
-- render storm structurally collapses into one row per feature/org/hour/status/reason.
CREATE UNIQUE INDEX IF NOT EXISTS icl_bucket_unique
  ON intel_cost_ledger (feature, org_id, bucket_start, cache_status, allow_reason)
  WHERE bucket_start IS NOT NULL;

ALTER TABLE intel_cost_ledger ENABLE ROW LEVEL SECURITY;
-- Read: own org rows, or super-admin (also the only ones who see global NULL-org rows).
DROP POLICY IF EXISTS intel_cost_ledger_select ON intel_cost_ledger;
CREATE POLICY intel_cost_ledger_select ON intel_cost_ledger FOR SELECT
  USING (org_id = get_my_org_id() OR is_super_admin());
-- Writes are service-role only (edge functions); no client write policy.

-- ── atomic bucketed increment (service-role; the only way bucketed rows are written) ──
-- High-frequency deterministic reads call this so a render storm collapses into ONE
-- row per (feature, org_id, hour, cache_status, allow_reason) — never one row/render.
CREATE OR REPLACE FUNCTION intel_cost_ledger_bump(
  p_feature text, p_org_id uuid, p_bucket_start timestamptz, p_cache_status text, p_allow_reason text,
  p_artifact_type text DEFAULT NULL, p_provider_calls_avoided int DEFAULT 0, p_provider_calls_made int DEFAULT 0,
  p_subject_ref text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO intel_cost_ledger (feature, org_id, bucket_start, cache_status, allow_reason, artifact_type,
                                 provider_calls_avoided, provider_calls_made, subject_ref, usage)
  VALUES (p_feature, p_org_id, p_bucket_start, p_cache_status, p_allow_reason, p_artifact_type,
          COALESCE(p_provider_calls_avoided,0), COALESCE(p_provider_calls_made,0), p_subject_ref,
          jsonb_build_object('render_count', 1))
  ON CONFLICT (feature, org_id, bucket_start, cache_status, allow_reason) WHERE bucket_start IS NOT NULL
  DO UPDATE SET
    provider_calls_avoided = intel_cost_ledger.provider_calls_avoided + EXCLUDED.provider_calls_avoided,
    provider_calls_made    = intel_cost_ledger.provider_calls_made + EXCLUDED.provider_calls_made,
    usage = jsonb_set(COALESCE(intel_cost_ledger.usage, '{}'::jsonb), '{render_count}',
              to_jsonb(COALESCE((intel_cost_ledger.usage->>'render_count')::int, 0) + 1));
END $$;

DO $$ BEGIN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION intel_cost_ledger_bump(text,uuid,timestamptz,text,text,text,int,int,text) FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION intel_cost_ledger_bump(text,uuid,timestamptz,text,text,text,int,int,text) TO service_role';
END $$;
