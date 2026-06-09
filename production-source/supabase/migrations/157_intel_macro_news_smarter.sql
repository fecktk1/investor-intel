-- ============================================================
-- 157: Investor Intel — smarter macro news (trust + corroboration + ranking)
-- ============================================================
-- Fixes the noisy macro feed. The old intel_macro_news (migration 147) unioned
-- rss_items.retain_forever (random ORG content/influencer feeds) with broadly
-- tagged corpus rows and sorted by recency — so any post mentioning "fed/cpi/
-- rates" surfaced as "big macro news".
--
-- This version:
--   * DROPS the rss_items firehose entirely.
--   * Keeps only macro-tagged items from the shared corpus.
--   * QUALITY GATE: trusted origin (curated / macro cron) OR corroborated by >=2
--     independent sources covering the same story.
--   * Ranks by IMPORTANCE = origin-trust x relevance x recency x corroboration.
--   * Returns corroboration + importance so the UI can show source support.
-- Intel-only; macro is a shared global read (no org workflows touched).
-- ============================================================

DROP FUNCTION IF EXISTS intel_macro_news(int);

CREATE OR REPLACE FUNCTION intel_macro_news(p_limit int DEFAULT 30)
RETURNS TABLE (
  title text, url text, summary text, source_name text, sentiment text,
  published_at timestamptz, origin text, corroboration int, importance numeric
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH macro AS (
    SELECT gn.title, gn.url, gn.summary, gn.source_name, gn.sentiment, gn.published_at, gn.origin, gn.relevance,
           lower(regexp_replace(COALESCE(NULLIF(gn.entity_symbol, ''), left(gn.title, 64)), '\s+', ' ', 'g')) AS story_key
    FROM intel_global_news gn
    WHERE gn.created_at > now() - interval '10 days'
      AND (gn.origin = 'macro' OR gn.tags && ARRAY['macro','fomc','cpi','ppi','fed','rates','economy','jobs','etf','regulation'])
  ),
  grp AS (
    SELECT story_key, count(*) AS corroboration FROM macro GROUP BY story_key
  ),
  scored AS (
    SELECT m.title, m.url, m.summary, m.source_name, m.sentiment, m.published_at, m.origin, g.corroboration,
           (CASE m.origin WHEN 'curated' THEN 1.0 WHEN 'macro' THEN 0.9 WHEN 'gemini' THEN 0.5 WHEN 'org_rss' THEN 0.35 ELSE 0.5 END)
             * (0.4 + 0.6 * COALESCE(m.relevance, 0.3))
             * exp(- (EXTRACT(EPOCH FROM (now() - COALESCE(m.published_at, now()))) / 3600.0) / 48.0)
             * (1 + 0.15 * least(g.corroboration - 1, 4)) AS importance
    FROM macro m JOIN grp g USING (story_key)
    WHERE m.origin IN ('curated','macro') OR g.corroboration >= 2   -- trusted OR corroborated
  ),
  ranked AS (
    SELECT DISTINCT ON (lower(COALESCE(url, title)))
           title, url, summary, source_name, sentiment, published_at, origin, corroboration, importance
    FROM scored
    ORDER BY lower(COALESCE(url, title)), importance DESC
  )
  SELECT title, url, summary, source_name, sentiment, published_at, origin, corroboration, importance
  FROM ranked
  ORDER BY importance DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(p_limit, 60));
$$;

DO $$ BEGIN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION intel_macro_news(int) FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION intel_macro_news(int) TO authenticated, service_role';
END $$;
