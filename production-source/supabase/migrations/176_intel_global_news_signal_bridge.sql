-- ============================================================
-- 176: Investor Intel — Signal Layer → global-news bridge fields
-- ============================================================
-- The Railway worker now mirrors each entity-tagged Signal Layer item into the
-- shared intel_global_news corpus (HYBRID — it ADDS to, never replaces, the
-- Gemini-grounded chain-news + legacy crons). That makes the seeded default
-- sources visible on the asset/chain pages + Market Pulse and feeds them into
-- Gemini/Grok curation, while Gemini grounding/verification stays intact.
--
-- These columns let the read surfaces rank by source authority and badge the
-- category. Additive + idempotent; legacy crons leave them NULL.
-- ============================================================

ALTER TABLE intel_global_news
  ADD COLUMN IF NOT EXISTS source_quality  int,
  ADD COLUMN IF NOT EXISTS authority_level text,
  ADD COLUMN IF NOT EXISTS news_category   text;

-- listGlobalNews now does a strict chain match via array-overlap on a specific
-- chain/asset view — back it with a GIN index.
CREATE INDEX IF NOT EXISTS intel_global_news_chains_gin ON intel_global_news USING gin (chains);
-- Authority-aware ranking on the read path.
CREATE INDEX IF NOT EXISTS intel_global_news_quality_idx ON intel_global_news(source_quality DESC NULLS LAST, created_at DESC);

-- ── one-time backfill: mirror EXISTING entity-tagged signals into the corpus ──
-- So seeded-source content shows immediately on apply instead of waiting for the
-- next crawl cycle. Idempotent (ON CONFLICT DO NOTHING); the worker bridges new
-- items going forward.
INSERT INTO intel_global_news (
  global_source_id, chains, entity_symbol, title, url, summary, source_name, sentiment,
  relevance, source_quality, authority_level, news_category, published_at, tags, raw, dedup_key)
SELECT NULL, s.chains,
       (CASE WHEN COALESCE(array_length(s.tokens, 1), 0) > 0 THEN s.tokens[1] ELSE NULL END),
       left(s.title, 280), COALESCE(s.canonical_url, ri.original_url), left(COALESCE(s.short_summary, ''), 800),
       s.source_name, s.signal_bias, s.importance_score, s.source_quality, s.authority_level, s.news_category,
       s.published_at, ARRAY['signal_layer']::text[] || COALESCE(s.chains, '{}'),
       jsonb_build_object('via', 'signal_layer_backfill', 'signal_id', s.id), ri.dedup_key
FROM signals s
JOIN signal_raw_items ri ON ri.id = s.raw_item_id
WHERE (COALESCE(array_length(s.chains, 1), 0) > 0 OR COALESCE(array_length(s.tokens, 1), 0) > 0)
  AND ri.dedup_key IS NOT NULL
ON CONFLICT (dedup_key) DO NOTHING;
