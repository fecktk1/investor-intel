-- ============================================================
-- 147: Investor Intel — cross-org news sharing + DeFi mirror + Macro
-- ============================================================
-- Three additions, all designed to REUSE data the org/content side already
-- captures so retail intel users don't each drain provider APIs:
--   1. `intel_global_news.origin` — provenance tag (curated|gemini|org_rss|macro)
--      so harvested org RSS news is distinguishable in the shared corpus.
--   2. DeFi MIRROR — SECURITY DEFINER RPCs that expose the union of existing
--      kamino_vault_snapshots (public DeFi data, identical for everyone) so
--      intel users see a populated DeFi universe + per-vault history with NO
--      new Kamino calls and zero per-org seeding.
--   3. MACRO — a small GLOBAL economic calendar + indicators store (populated
--      by one shared grounded cron), plus `intel_macro_news()` which aggregates
--      the high-signal macro news every org already retains (rss_items
--      retain_forever) + the curated corpus, deduped.
-- All cross-org reads are read-only public market/news data with NO org_id or
-- PII returned, so SECURITY DEFINER is safe.
-- ============================================================

-- 1. Provenance on the shared corpus ---------------------------------------
ALTER TABLE intel_global_news ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'curated';
CREATE INDEX IF NOT EXISTS ign_origin ON intel_global_news(origin);

-- 2. DeFi mirror RPCs ------------------------------------------------------
-- Latest snapshot per vault across ALL workspaces → a populated "universe"
-- ranked by TVL. No org_id leaves the function.
CREATE OR REPLACE FUNCTION intel_defi_universe(p_limit int DEFAULT 60)
RETURNS TABLE (vault_address text, vault_name text, apy numeric, tvl_usd numeric, token_a text, token_b text, snapshot_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT vault_address, vault_name, apy, tvl_usd, token_a, token_b, snapshot_at
  FROM (
    SELECT DISTINCT ON (vault_address)
           vault_address, vault_name, apy, tvl_usd, token_a, token_b, snapshot_at
    FROM kamino_vault_snapshots
    WHERE snapshot_at > now() - interval '21 days'
    ORDER BY vault_address, snapshot_at DESC
  ) latest
  WHERE tvl_usd IS NOT NULL
  ORDER BY tvl_usd DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$$;

-- Merged TVL/APY history for one vault across ALL workspaces (one point/day).
CREATE OR REPLACE FUNCTION intel_defi_vault_history(p_vault_address text, p_days int DEFAULT 90)
RETURNS TABLE (apy numeric, tvl_usd numeric, snapshot_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT apy, tvl_usd, snapshot_at
  FROM (
    SELECT DISTINCT ON (date_trunc('day', snapshot_at))
           apy, tvl_usd, snapshot_at
    FROM kamino_vault_snapshots
    WHERE vault_address = p_vault_address
      AND snapshot_at > now() - (GREATEST(1, LEAST(p_days, 365)) * interval '1 day')
    ORDER BY date_trunc('day', snapshot_at), snapshot_at DESC
  ) d
  ORDER BY snapshot_at ASC;
$$;

-- 3. Macro store ----------------------------------------------------------
-- GLOBAL economic calendar (no org_id); populated by intel-macro-cron.
CREATE TABLE IF NOT EXISTS intel_macro_calendar (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key    text NOT NULL,           -- fomc|cpi|ppi|pce|nfp|gdp|rate_decision|unemployment|...
  title        text NOT NULL,
  country      text DEFAULT 'US',
  importance   text CHECK (importance IS NULL OR importance IN ('high','medium','low')),
  scheduled_at timestamptz NOT NULL,
  period       text,
  forecast     text,
  previous     text,
  actual       text,
  impact       text,
  source_url   text,
  raw          jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_key, scheduled_at)
);
CREATE INDEX IF NOT EXISTS imc_sched ON intel_macro_calendar(scheduled_at);

-- GLOBAL latest macro indicators (no org_id); one row per metric, upserted.
CREATE TABLE IF NOT EXISTS intel_macro_indicators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key  text NOT NULL UNIQUE,     -- fed_funds_rate|cpi_yoy|core_cpi_yoy|unemployment|us10y|dxy|btc_dominance|fear_greed
  label       text NOT NULL,
  value       text,
  unit        text,
  as_of       date,
  period      text,
  change      text,
  trend       text CHECK (trend IS NULL OR trend IN ('up','down','flat')),
  source_url  text,
  raw         jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE intel_macro_calendar   ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_macro_indicators ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_macro_calendar_read ON intel_macro_calendar;
CREATE POLICY intel_macro_calendar_read   ON intel_macro_calendar   FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS intel_macro_indicators_read ON intel_macro_indicators;
CREATE POLICY intel_macro_indicators_read ON intel_macro_indicators FOR SELECT USING (auth.uid() IS NOT NULL);

-- High-signal macro NEWS = the events every org already retains forever
-- (rss_items.retain_forever) + the curated/grounded macro items, deduped.
CREATE OR REPLACE FUNCTION intel_macro_news(p_limit int DEFAULT 40)
RETURNS TABLE (title text, url text, summary text, source_name text, sentiment text, published_at timestamptz, origin text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH unioned AS (
    SELECT ri.title,
           COALESCE(ri.canonical_url, ri.link)                AS url,
           LEFT(COALESCE(ri.description, ''), 600)            AS summary,
           COALESCE(ri.source, ri.source_domain, 'RSS')       AS source_name,
           NULL::text                                         AS sentiment,
           ri.pub_date                                        AS published_at,
           'org_rss'::text                                    AS origin
    FROM rss_items ri
    WHERE ri.retain_forever = true
      AND ri.pub_date > now() - interval '45 days'
    UNION ALL
    SELECT gn.title, gn.url,
           LEFT(COALESCE(gn.summary, ''), 600)                AS summary,
           gn.source_name, gn.sentiment, gn.published_at, gn.origin
    FROM intel_global_news gn
    WHERE gn.origin = 'macro'
       OR gn.tags && ARRAY['macro','fomc','cpi','fed','rates','economy','jobs']
  )
  SELECT title, url, summary, source_name, sentiment, published_at, origin
  FROM (
    SELECT DISTINCT ON (lower(COALESCE(url, title)))
           title, url, summary, source_name, sentiment, published_at, origin
    FROM unioned
    WHERE title IS NOT NULL
    ORDER BY lower(COALESCE(url, title)), published_at DESC NULLS LAST
  ) d
  ORDER BY published_at DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;

-- Grants: read-only DeFi/macro aggregates → authenticated only (never anon).
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'intel_defi_universe(int)',
    'intel_defi_vault_history(text,int)',
    'intel_macro_news(int)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;
END $$;
