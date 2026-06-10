-- ============================================================
-- 224: Investor Intel / Forge — Long-memory retention foundation
-- ============================================================
-- Goal: let the platform answer "what drove this asset/chain/narrative over the
-- last year" in 12-18 months. This migration adds the retention SCAFFOLDING only
-- — it schedules NO destructive deletes (the guarded dry-run/execute framework
-- lands in 227, destructive OFF by default). Additive + idempotent.
--
-- Operator decisions honored:
--   * 15-month baseline = interval '15 months' (NOT 180 days) for standard
--     source/signal/narrative-derived history.
--   * Critical snapshot tables raised 60/90/120d -> 15 months NOW.
--   * Hash/dedupe/evidence memory retained 3 years (survives row prunes).
--   * retain_forever / evergreen rows are never standard-pruned.
--   * Engagement that is ALREADY fetched is persisted (no new provider calls).
-- ============================================================

-- ── 1. Retention tier + retain_until on long-memory source/derived tables ─────
-- tier vocabulary (decision #15): media | low_value | standard | important |
-- historic | evergreen.  retain_until = computed hard floor; retain_forever =
-- never standard-prune.  All columns nullable/defaulted → safe on populated tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['signal_raw_items','signal_clusters','intel_curated_news','intel_global_news'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS retention_tier text NOT NULL DEFAULT ''standard''', t);
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS retain_until timestamptz', t);
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS retain_forever boolean NOT NULL DEFAULT false', t);
    END IF;
  END LOOP;
END $$;

-- ── 2. Engagement persistence (already-fetched only — NO new calls) ───────────
-- signal_clusters + intel_curated_news gain compact engagement fields populated
-- from data the pipeline already has (trend top_posts, X signal metrics, etc.).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['signal_clusters','intel_curated_news'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS engagement jsonb NOT NULL DEFAULT ''{}''', t);
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS engagement_total bigint', t);
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS engagement_velocity numeric', t);
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS engagement_at timestamptz', t);
    END IF;
  END LOOP;
END $$;

-- ── 3. Hash memory (3-year) — survives row prunes so dedupe never regresses ───
-- Upserted BEFORE any destructive delete (227). Lets us answer "have we seen this
-- story/content before" long after the heavy raw row is gone.
CREATE TABLE IF NOT EXISTS intel_hash_memory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hash_kind     text NOT NULL CHECK (hash_kind IN ('content','title','dedup','story','evidence','angle')),
  hash_value    text NOT NULL,
  canonical_url text,
  title         text,
  source_name   text,
  cluster_id    uuid,                                  -- soft ref to signal_clusters (no FK: survives cluster prune)
  categories    text[] NOT NULL DEFAULT '{}',
  assets        text[] NOT NULL DEFAULT '{}',
  chains        text[] NOT NULL DEFAULT '{}',
  narratives    text[] NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  seen_count    int NOT NULL DEFAULT 1,
  retain_until  timestamptz NOT NULL DEFAULT (now() + interval '3 years'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hash_kind, hash_value)
);
CREATE INDEX IF NOT EXISTS intel_hash_memory_kind ON intel_hash_memory(hash_kind, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS intel_hash_memory_cluster ON intel_hash_memory(cluster_id) WHERE cluster_id IS NOT NULL;
ALTER TABLE intel_hash_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_hash_memory_read ON intel_hash_memory;
CREATE POLICY intel_hash_memory_read ON intel_hash_memory FOR SELECT USING (is_super_admin());
-- writes service-role only.

-- Idempotent upsert helper (used by the producer + the pre-delete prune step).
CREATE OR REPLACE FUNCTION intel_hash_memory_upsert(
  p_kind text, p_value text, p_url text DEFAULT NULL, p_title text DEFAULT NULL, p_source text DEFAULT NULL,
  p_cluster uuid DEFAULT NULL, p_categories text[] DEFAULT '{}', p_assets text[] DEFAULT '{}',
  p_chains text[] DEFAULT '{}', p_narratives text[] DEFAULT '{}', p_seen_at timestamptz DEFAULT now()
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_value IS NULL OR p_value = '' THEN RETURN; END IF;
  INSERT INTO intel_hash_memory (hash_kind, hash_value, canonical_url, title, source_name, cluster_id, categories, assets, chains, narratives, first_seen_at, last_seen_at)
  VALUES (p_kind, p_value, p_url, p_title, p_source, p_cluster, COALESCE(p_categories,'{}'), COALESCE(p_assets,'{}'), COALESCE(p_chains,'{}'), COALESCE(p_narratives,'{}'), p_seen_at, p_seen_at)
  ON CONFLICT (hash_kind, hash_value) DO UPDATE SET
    last_seen_at = GREATEST(intel_hash_memory.last_seen_at, EXCLUDED.last_seen_at),
    seen_count   = intel_hash_memory.seen_count + 1,
    cluster_id   = COALESCE(intel_hash_memory.cluster_id, EXCLUDED.cluster_id),
    categories   = (SELECT COALESCE(array_agg(DISTINCT c), '{}') FROM (SELECT unnest(intel_hash_memory.categories || EXCLUDED.categories) c) z),
    retain_until = GREATEST(intel_hash_memory.retain_until, EXCLUDED.last_seen_at + interval '3 years');
END $$;

-- ── 4. Validation history — reuse stored Gemini/Grok outputs, don't rerun ─────
CREATE TABLE IF NOT EXISTS intel_validation_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind    text NOT NULL,            -- story|cluster|signal|curated_news|narrative|event
  subject_ref     text NOT NULL,            -- cluster_hash / signal_key / slug / event_key
  validator       text NOT NULL,            -- gemini|grok|deterministic
  model           text,
  score           numeric,
  classification  text,                     -- importance/credibility/category/etc
  reason          text,
  prior_state     text,
  new_state       text,
  related_cluster uuid,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  retain_until    timestamptz NOT NULL DEFAULT (now() + interval '15 months')
);
CREATE INDEX IF NOT EXISTS intel_validation_subject ON intel_validation_history(subject_kind, subject_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS intel_validation_validator ON intel_validation_history(validator, created_at DESC);
ALTER TABLE intel_validation_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_validation_read ON intel_validation_history;
CREATE POLICY intel_validation_read ON intel_validation_history FOR SELECT USING (is_super_admin());

-- ── 5. Retention config (per-table tier + flags; destructive OFF by default) ──
CREATE TABLE IF NOT EXISTS intel_retention_config (
  table_name          text PRIMARY KEY,
  tier                text NOT NULL DEFAULT 'standard',
  standard_interval   interval NOT NULL DEFAULT interval '15 months',
  time_column         text NOT NULL DEFAULT 'created_at',
  enabled             boolean NOT NULL DEFAULT true,    -- include in preview
  destructive_enabled boolean NOT NULL DEFAULT false,   -- MUST be flipped per-table to delete
  batch_limit         int NOT NULL DEFAULT 5000,
  hash_memory_kinds   text[] NOT NULL DEFAULT '{}',     -- which hashes to memorize before delete
  notes               text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE intel_retention_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_retention_config_read ON intel_retention_config;
CREATE POLICY intel_retention_config_read ON intel_retention_config FOR SELECT USING (is_super_admin());

INSERT INTO intel_retention_config (table_name, tier, standard_interval, time_column, hash_memory_kinds, notes) VALUES
  ('signal_raw_items',          'standard', interval '15 months', 'fetched_at', ARRAY['content','title','dedup'], 'public raw items; memorize hashes before delete'),
  ('intel_global_news',         'standard', interval '15 months', 'created_at', ARRAY['dedup'], 'global news corpus'),
  ('intel_curated_news',        'standard', interval '15 months', 'created_at', ARRAY['story'], 'AI-curated cards'),
  ('narrative_signal_snapshots','standard', interval '15 months', 'snapshot_at', '{}', 'raised from 90d'),
  ('narrative_score_snapshots', 'standard', interval '15 months', 'snapshot_at', '{}', 'raised from 120d'),
  ('intel_signal_snapshots',    'standard', interval '15 months', 'snapshot_at', '{}', 'raised from 60d'),
  ('birdeye_api_usage_logs',    'low_value', interval '60 days',  'created_at', '{}', 'telemetry; safe to prune'),
  ('exchange_api_usage_logs',   'low_value', interval '60 days',  'created_at', '{}', 'telemetry; safe to prune')
ON CONFLICT (table_name) DO NOTHING;

-- ── 6. Raise critical snapshot retention to 15 months NOW (decision #2) ───────
-- Re-schedule the existing daily prune (mig 197/214) with 15-month windows for
-- the derived-intelligence snapshots. narrative_interactions (behavioral, not
-- intelligence history) stays short. STILL the only scheduled deletes; all
-- guarded by append-only snapshot semantics (no retain_forever rows here).
SELECT cron.unschedule('narrative-prune-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'narrative-prune-daily');
SELECT cron.schedule('narrative-prune-daily', '45 4 * * *', $$
  DELETE FROM narrative_signal_snapshots WHERE snapshot_at < now() - interval '15 months';
  DELETE FROM narrative_score_snapshots  WHERE snapshot_at < now() - interval '15 months';
  DELETE FROM intel_signal_snapshots     WHERE snapshot_at < now() - interval '15 months';
  DELETE FROM narrative_interactions     WHERE created_at  < now() - interval '60 days';
$$);
