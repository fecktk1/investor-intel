-- ============================================================
-- 226: Investor Intel — monthly/quarterly rollups + source reliability
-- ============================================================
-- Deterministic compounding intelligence: per-month / per-quarter aggregates by
-- subject (asset/chain/narrative/category/source/source_type/macro), computed
-- from SURVIVING tables (intel_curated_news + signal layer + validation history)
-- — no AI, no provider calls. Prior-year and QoQ comparisons are derived at read
-- time (227/228). Source reliability surfaces early / noisy / overhyped sources.
-- ============================================================

CREATE TABLE IF NOT EXISTS intel_rollups (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type         text NOT NULL,         -- asset|chain|narrative|category|source|source_type|macro
  subject_id           text NOT NULL,         -- canonical key / slug / category / source id / macro topic
  subject_label        text,
  period_kind          text NOT NULL CHECK (period_kind IN ('month','quarter')),
  period_start         date NOT NULL,
  period_end           date NOT NULL,
  source_count         int NOT NULL DEFAULT 0,
  unique_source_count  int NOT NULL DEFAULT 0,
  source_diversity     int NOT NULL DEFAULT 0,
  avg_gemini_importance numeric,
  avg_grok_validation  numeric,
  validation_count     int NOT NULL DEFAULT 0,
  engagement_total     bigint NOT NULL DEFAULT 0,
  engagement_velocity  numeric,
  bullish_count        int NOT NULL DEFAULT 0,
  bearish_count        int NOT NULL DEFAULT 0,
  mixed_count          int NOT NULL DEFAULT 0,
  neutral_count        int NOT NULL DEFAULT 0,
  top_source_ids       text[] NOT NULL DEFAULT '{}',
  top_narratives       text[] NOT NULL DEFAULT '{}',
  top_related_assets   text[] NOT NULL DEFAULT '{}',
  top_related_chains   text[] NOT NULL DEFAULT '{}',
  first_seen_at        timestamptz,
  peak_seen_at         timestamptz,
  last_seen_at         timestamptz,
  lifecycle_changes    jsonb NOT NULL DEFAULT '[]',
  important_events     jsonb NOT NULL DEFAULT '[]',
  backfilled           boolean NOT NULL DEFAULT false,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, period_kind, period_start)
);
CREATE INDEX IF NOT EXISTS intel_rollups_subject ON intel_rollups(subject_type, subject_id, period_start DESC);
CREATE INDEX IF NOT EXISTS intel_rollups_period ON intel_rollups(period_kind, period_start DESC);
ALTER TABLE intel_rollups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_rollups_read ON intel_rollups;
-- Aggregate, identity-stripped market history → authenticated read (powers
-- Daily Brief comparisons, Explain memory, Narrative history for all users).
CREATE POLICY intel_rollups_read ON intel_rollups FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE TABLE IF NOT EXISTS intel_source_reliability (
  source_id        uuid PRIMARY KEY,           -- soft ref to signal_sources
  source_name      text,
  source_type      text,
  sample_count     int NOT NULL DEFAULT 0,     -- stories attributed
  distinct_clusters int NOT NULL DEFAULT 0,
  early_count      int NOT NULL DEFAULT 0,     -- first source on a story that later grew
  grown_count      int NOT NULL DEFAULT 0,     -- stories that reached >= 3 sources
  early_score      numeric,                    -- early_count / distinct_clusters
  noise_score      numeric,                    -- 1 - grown_count / distinct_clusters
  overhype_score   numeric,                    -- social-heavy, confirmation-light share
  avg_momentum     numeric,
  computed_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE intel_source_reliability ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_source_reliability_read ON intel_source_reliability;
CREATE POLICY intel_source_reliability_read ON intel_source_reliability FOR SELECT USING (is_super_admin());

-- ── Compute rollups for ONE period from intel_curated_news (richest per-story) ─
-- Idempotent (UNIQUE upsert). Aggregates each subject dimension separately.
CREATE OR REPLACE FUNCTION intel_compute_rollups(p_period_kind text, p_period_start date, p_backfilled boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_end date; v_rows int := 0;
BEGIN
  IF p_period_kind = 'month' THEN v_end := (p_period_start + interval '1 month')::date;
  ELSIF p_period_kind = 'quarter' THEN v_end := (p_period_start + interval '3 months')::date;
  ELSE RAISE EXCEPTION 'bad period_kind %', p_period_kind; END IF;

  -- Unnest curated news into (dimension, key) rows once, then aggregate.
  WITH base AS (
    SELECT c.*, COALESCE(c.published_at, c.created_at) AS occurred,
           COALESCE(c.engagement_total, 0) AS eng
    FROM intel_curated_news c
    WHERE COALESCE(c.published_at, c.created_at) >= p_period_start
      AND COALESCE(c.published_at, c.created_at) < v_end
  ),
  dims AS (
    SELECT 'asset'::text AS subject_type, upper(tok) AS subject_id, b.* FROM base b, unnest(COALESCE(b.tokens,'{}')) tok
    UNION ALL SELECT 'chain', lower(ch), b.* FROM base b, unnest(COALESCE(b.chains,'{}')) ch
    UNION ALL SELECT 'narrative', nar, b.* FROM base b, unnest(COALESCE(b.narratives,'{}')) nar
    UNION ALL SELECT 'category', cat, b.* FROM base b, unnest(COALESCE(b.sectors,'{}')) cat
    UNION ALL SELECT 'macro', mt, b.* FROM base b, unnest(COALESCE(b.narratives,'{}')) mt
      WHERE mt IN ('political','geopolitical','finance','regulation','crypto_regulation','macro')
  ),
  agg AS (
    SELECT subject_type, subject_id,
           count(*) AS source_count,
           count(DISTINCT cluster_hash) AS unique_source_count,
           COALESCE(array_length(array_agg(DISTINCT source_type), 1), 0) AS source_diversity,
           avg(NULLIF(importance_score,0)) AS avg_imp,
           avg(NULLIF(credibility_score,0)) AS avg_cred,
           count(*) FILTER (WHERE gemini_eval IS NOT NULL OR grok_eval IS NOT NULL) AS validation_count,
           sum(eng) AS eng_total,
           count(*) FILTER (WHERE signal = 'bullish') AS bull,
           count(*) FILTER (WHERE signal = 'bearish') AS bear,
           count(*) FILTER (WHERE signal = 'mixed') AS mixed,
           count(*) FILTER (WHERE signal = 'neutral' OR signal IS NULL) AS neutral,
           min(occurred) AS first_seen, max(occurred) AS last_seen
    FROM dims
    GROUP BY subject_type, subject_id
    HAVING subject_id IS NOT NULL AND subject_id <> ''
  ),
  up AS (
    INSERT INTO intel_rollups (subject_type, subject_id, subject_label, period_kind, period_start, period_end,
      source_count, unique_source_count, source_diversity, avg_gemini_importance, avg_grok_validation, validation_count,
      engagement_total, bullish_count, bearish_count, mixed_count, neutral_count, first_seen_at, last_seen_at, backfilled, computed_at)
    SELECT subject_type, subject_id, subject_id, p_period_kind, p_period_start, v_end,
      source_count, unique_source_count, source_diversity, round(avg_imp,1), round(avg_cred,1), validation_count,
      eng_total, bull, bear, mixed, neutral, first_seen, last_seen, p_backfilled, now()
    FROM agg
    ON CONFLICT (subject_type, subject_id, period_kind, period_start) DO UPDATE SET
      source_count = EXCLUDED.source_count, unique_source_count = EXCLUDED.unique_source_count,
      source_diversity = EXCLUDED.source_diversity, avg_gemini_importance = EXCLUDED.avg_gemini_importance,
      avg_grok_validation = EXCLUDED.avg_grok_validation, validation_count = EXCLUDED.validation_count,
      engagement_total = EXCLUDED.engagement_total, bullish_count = EXCLUDED.bullish_count,
      bearish_count = EXCLUDED.bearish_count, mixed_count = EXCLUDED.mixed_count, neutral_count = EXCLUDED.neutral_count,
      first_seen_at = LEAST(intel_rollups.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = GREATEST(intel_rollups.last_seen_at, EXCLUDED.last_seen_at),
      backfilled = intel_rollups.backfilled AND EXCLUDED.backfilled, computed_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM up;
  RETURN jsonb_build_object('period_kind', p_period_kind, 'period_start', p_period_start, 'rows', v_rows, 'backfilled', p_backfilled);
END $$;

-- ── Source reliability from the signal layer (deterministic proxies) ──────────
CREATE OR REPLACE FUNCTION intel_compute_source_reliability()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows int := 0;
BEGIN
  WITH src AS (
    SELECT s.id AS source_id, s.name, s.source_type,
           count(*) AS sample_count,
           count(DISTINCT sg.cluster_id) AS distinct_clusters,
           count(DISTINCT sg.cluster_id) FILTER (WHERE cl.item_count >= 3) AS grown,
           count(DISTINCT sg.cluster_id) FILTER (WHERE cl.first_seen_at >= sis.first_seen_at AND cl.item_count >= 3) AS early,
           avg(cl.momentum_score) AS avg_mom
    FROM signal_sources s
    JOIN signal_item_sources sis ON sis.source_id = s.id
    JOIN signals sg ON sg.raw_item_id = sis.raw_item_id
    LEFT JOIN signal_clusters cl ON cl.id = sg.cluster_id
    GROUP BY s.id, s.name, s.source_type
  ),
  up AS (
    INSERT INTO intel_source_reliability (source_id, source_name, source_type, sample_count, distinct_clusters, early_count, grown_count, early_score, noise_score, avg_momentum, computed_at)
    SELECT source_id, name, source_type, sample_count, distinct_clusters, COALESCE(early,0), COALESCE(grown,0),
      CASE WHEN distinct_clusters > 0 THEN round(COALESCE(early,0)::numeric / distinct_clusters, 3) ELSE NULL END,
      CASE WHEN distinct_clusters > 0 THEN round(1 - COALESCE(grown,0)::numeric / distinct_clusters, 3) ELSE NULL END,
      round(COALESCE(avg_mom,0),2), now()
    FROM src
    ON CONFLICT (source_id) DO UPDATE SET
      sample_count = EXCLUDED.sample_count, distinct_clusters = EXCLUDED.distinct_clusters,
      early_count = EXCLUDED.early_count, grown_count = EXCLUDED.grown_count,
      early_score = EXCLUDED.early_score, noise_score = EXCLUDED.noise_score,
      avg_momentum = EXCLUDED.avg_momentum, computed_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM up;
  RETURN jsonb_build_object('sources', v_rows);
END $$;

-- ── Idempotent partial backfill from surviving curated news (marks backfilled) ─
CREATE OR REPLACE FUNCTION intel_backfill_rollups(p_months int DEFAULT 15)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m int; v_total int := 0; r jsonb; v_start date;
BEGIN
  FOR m IN 0..GREATEST(0, LEAST(p_months, 36)) - 1 LOOP
    v_start := date_trunc('month', now() - make_interval(months => m))::date;
    r := intel_compute_rollups('month', v_start, true);
    v_total := v_total + COALESCE((r->>'rows')::int, 0);
  END LOOP;
  -- quarters touching the window
  FOR m IN 0..GREATEST(0, LEAST(p_months, 36)) / 3 LOOP
    v_start := date_trunc('quarter', now() - make_interval(months => m * 3))::date;
    r := intel_compute_rollups('quarter', v_start, true);
  END LOOP;
  PERFORM intel_compute_source_reliability();
  RETURN jsonb_build_object('backfilled_rows', v_total, 'months', p_months, 'note', 'partial — only covers data surviving in intel_curated_news; older pruned history is not reconstructed');
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['intel_compute_rollups(text,date,boolean)','intel_compute_source_reliability()','intel_backfill_rollups(int)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
