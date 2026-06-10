-- ============================================================
-- 215: Investor Intel — artifact reuse / delta / force-refresh quota
-- ============================================================
-- Powers the cost-reduction engine in intel-generate:
--   * evidence_hash/source_set_hash denormalized onto org artifacts so the
--     stale-but-unchanged reuse check is ONE indexed query (today a stale row
--     triggers a full multi-model regeneration even when nothing changed).
--   * signal_snapshot — compact Intel Signal state at generation time (drives
--     the materiality verdict + thesis drift).
--   * base_artifact_id + reuse_kind — delta lineage ("this delta updates that
--     full answer"); reuse_kind ∈ fresh|shared_copy|reuse_stale_unchanged|delta.
--   * question_norm_hash + question_shingles — HMAC-hashed similarity keys for
--     Explain This (NEVER raw questions / raw shingles / unsalted hashes).
--   * Force refresh = an EXPENSIVE override: plan-limited per day (trial 2 /
--     starter 5 / pro 20 / elite 50), 30-min per-(entity,type) cooldown, and it
--     still passes the kill switch + monthly cap + per-artifact daily limits.
-- ============================================================

-- ── 1. research_artifacts additive columns ───────────────────
ALTER TABLE research_artifacts ADD COLUMN IF NOT EXISTS evidence_hash      text;
ALTER TABLE research_artifacts ADD COLUMN IF NOT EXISTS source_set_hash    text;
ALTER TABLE research_artifacts ADD COLUMN IF NOT EXISTS signal_snapshot    jsonb NOT NULL DEFAULT '{}';
ALTER TABLE research_artifacts ADD COLUMN IF NOT EXISTS base_artifact_id   uuid REFERENCES research_artifacts(id) ON DELETE SET NULL;
ALTER TABLE research_artifacts ADD COLUMN IF NOT EXISTS reuse_kind         text;
ALTER TABLE research_artifacts ADD COLUMN IF NOT EXISTS question_norm_hash text;
ALTER TABLE research_artifacts ADD COLUMN IF NOT EXISTS question_shingles  jsonb;

CREATE INDEX IF NOT EXISTS ra_org_type_entity_evidence
  ON research_artifacts(org_id, artifact_type, entity_id, evidence_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS ra_org_explain_qhash
  ON research_artifacts(org_id, artifact_type, question_norm_hash, created_at DESC)
  WHERE question_norm_hash IS NOT NULL;

-- ── 2. force-refresh quota ───────────────────────────────────
CREATE TABLE IF NOT EXISTS intel_force_refresh_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  artifact_type text NOT NULL,
  entity_ref    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ifr_org_time ON intel_force_refresh_log(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ifr_org_entity ON intel_force_refresh_log(org_id, artifact_type, entity_ref, created_at DESC);

ALTER TABLE intel_force_refresh_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_force_refresh_select ON intel_force_refresh_log;
CREATE POLICY intel_force_refresh_select ON intel_force_refresh_log FOR SELECT
  USING (org_id = get_my_org_id() OR is_super_admin());
-- writes are service-role only (intel-generate); no client write policy.

-- Per-tier daily force-refresh limits. Elite stays CAPPED (50) — the monthly
-- cost cap still applies regardless.
INSERT INTO intel_plan_limits (tier, key, value) VALUES
  ('trial','force_refresh_per_day',2),
  ('starter','force_refresh_per_day',5),
  ('pro','force_refresh_per_day',20),
  ('elite','force_refresh_per_day',50)
ON CONFLICT (tier, key) DO UPDATE SET value = EXCLUDED.value;

-- Allow check: daily plan quota + a 30-min per-(entity, artifact_type) cooldown
-- (cooldown is NOT plan-gated). Force refresh is never a generation-limit
-- workaround — intel-generate still enforces intel_generation_allowed() and
-- intel_rate_check() after this.
CREATE OR REPLACE FUNCTION intel_force_refresh_allowed(p_artifact_type text, p_entity_ref text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := get_my_org_id(); v_lim numeric; v_used int; v_last timestamptz;
BEGIN
  IF v_org IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'no_org'); END IF;
  v_lim := intel_limit_for(v_org, 'force_refresh_per_day');
  SELECT count(*) INTO v_used FROM intel_force_refresh_log
    WHERE org_id = v_org AND created_at >= date_trunc('day', now());
  IF v_lim IS NOT NULL AND v_used >= v_lim THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'force_refresh_per_day', 'used', v_used, 'limit', v_lim);
  END IF;
  SELECT max(created_at) INTO v_last FROM intel_force_refresh_log
    WHERE org_id = v_org AND artifact_type = p_artifact_type
      AND COALESCE(entity_ref, '') = COALESCE(p_entity_ref, '');
  IF v_last IS NOT NULL AND v_last > now() - interval '30 minutes' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'cooldown', 'used', v_used, 'limit', v_lim,
                              'cooldown_until', v_last + interval '30 minutes');
  END IF;
  RETURN jsonb_build_object('allowed', true, 'used', v_used, 'limit', v_lim);
END $$;

DO $$ BEGIN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION intel_force_refresh_allowed(text,text) FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION intel_force_refresh_allowed(text,text) TO authenticated, service_role';
END $$;
