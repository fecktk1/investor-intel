-- ============================================================
-- 164: Investor Intel — AI-curated Notable News store (shared)
-- ============================================================
-- The curation cron (intel-curate-news) dedupes raw corpus into candidate
-- clusters, cheap-prefilters obvious garbage, then has Gemini + Grok BATCH-score
-- them for importance / relevance / credibility / should_surface. The
-- deterministic adjudicator merges those into one curated row per cluster.
-- Market Pulse reads should_surface=true rows ranked by final_score. Raw
-- ingestion (intel_global_news / news_items) is untouched — this is additive.
-- GLOBAL + shared (no org_id, no private context). Read by any authed user;
-- written service-role. AI evals + suppress reasons kept for admin/debug.
-- ============================================================

CREATE TABLE IF NOT EXISTS intel_curated_news (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_hash         text NOT NULL UNIQUE,
  title                text NOT NULL,
  cleaned_title        text,
  summary              text,
  why_it_matters       text,
  crypto_impact        text,
  watch_next           text,
  chains               text[] NOT NULL DEFAULT '{}',
  tokens               text[] NOT NULL DEFAULT '{}',
  sectors              text[] NOT NULL DEFAULT '{}',
  narratives           text[] NOT NULL DEFAULT '{}',
  signal               text,
  confidence           text,
  importance_score     int,
  relevance_score      int,
  novelty_score        int,
  credibility_score    int,
  market_impact_score  int,
  social_chatter_score int,
  final_score          int,
  source_count         int NOT NULL DEFAULT 1,
  source_categories    text[] NOT NULL DEFAULT '{}',
  supporting_sources   jsonb NOT NULL DEFAULT '[]',
  source_type          text,
  primary_url          text,
  published_at         timestamptz,
  gemini_eval          jsonb,
  grok_eval            jsonb,
  should_surface       boolean NOT NULL DEFAULT false,
  reason_to_suppress   text,
  detected_at          timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  stale_after          timestamptz
);
CREATE INDEX IF NOT EXISTS curated_surface ON intel_curated_news(final_score DESC) WHERE should_surface = true;
CREATE INDEX IF NOT EXISTS curated_chains ON intel_curated_news USING gin (chains);
CREATE INDEX IF NOT EXISTS curated_tokens ON intel_curated_news USING gin (tokens);
CREATE INDEX IF NOT EXISTS curated_created ON intel_curated_news(created_at DESC);

ALTER TABLE intel_curated_news ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_curated_read ON intel_curated_news;
CREATE POLICY intel_curated_read ON intel_curated_news FOR SELECT USING (auth.uid() IS NOT NULL);
-- writes service-role only (intel-curate-news).
