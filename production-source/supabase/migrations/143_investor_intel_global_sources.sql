-- ============================================================
-- 143: Investor Intel — global curated sources + shared news corpus
-- ============================================================
-- Super-admins curate high-quality sources per chain. A single scheduled
-- crawl populates ONE shared corpus (intel_global_news) that every workspace
-- reads — so users don't each re-pull the same feeds. User-added sources
-- (tracked_sources) remain additive and count against the per-tier
-- `news_sources` (custom) limit; global sources are unlimited + uncounted.
-- ============================================================

-- Global curated sources (GLOBAL — no org_id; super-admin managed).
CREATE TABLE IF NOT EXISTS intel_global_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type     text NOT NULL CHECK (source_type IN ('x_account','rss')),
  value           text NOT NULL,             -- handle (no @) | feed url
  chains          text[] NOT NULL DEFAULT '{}',  -- which launch chains it covers ({} = all)
  label           text,
  active          boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  created_by      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, value)
);
CREATE INDEX IF NOT EXISTS igs_active ON intel_global_sources(active);

-- Shared news corpus (GLOBAL — read by every authenticated user).
CREATE TABLE IF NOT EXISTS intel_global_news (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_source_id uuid REFERENCES intel_global_sources(id) ON DELETE SET NULL,
  chains           text[] NOT NULL DEFAULT '{}',
  entity_symbol    text,                       -- matched token symbol (optional)
  title            text NOT NULL,
  url              text,
  summary          text,
  source_name      text,
  author           text,
  sentiment        text CHECK (sentiment IS NULL OR sentiment IN ('bullish','bearish','neutral','mixed')),
  relevance        numeric,
  tags             text[] NOT NULL DEFAULT '{}',
  published_at     timestamptz,
  raw              jsonb NOT NULL DEFAULT '{}',
  dedup_key        text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ign_published ON intel_global_news(published_at DESC);
CREATE INDEX IF NOT EXISTS ign_chains ON intel_global_news USING gin (chains);
CREATE INDEX IF NOT EXISTS ign_symbol ON intel_global_news(entity_symbol, published_at DESC);

ALTER TABLE intel_global_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_global_news    ENABLE ROW LEVEL SECURITY;
-- Any authenticated user may read the curated layer; writes are service-role/RPC only.
DROP POLICY IF EXISTS intel_global_sources_read ON intel_global_sources;
CREATE POLICY intel_global_sources_read ON intel_global_sources FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS intel_global_news_read ON intel_global_news;
CREATE POLICY intel_global_news_read ON intel_global_news FOR SELECT USING (auth.uid() IS NOT NULL);

-- ── super-admin management RPCs ──
CREATE OR REPLACE FUNCTION intel_admin_add_global_source(p_source_type text, p_value text, p_chains text[] DEFAULT '{}', p_label text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  INSERT INTO intel_global_sources (source_type, value, chains, label, created_by)
    VALUES (p_source_type, regexp_replace(btrim(p_value), '^@', ''), coalesce(p_chains, '{}'), p_label, auth.uid())
    ON CONFLICT (source_type, value) DO UPDATE SET active = true, chains = EXCLUDED.chains, label = COALESCE(EXCLUDED.label, intel_global_sources.label)
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION intel_admin_remove_global_source(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  DELETE FROM intel_global_sources WHERE id = p_id;
END $$;

CREATE OR REPLACE FUNCTION intel_admin_list_global_sources()
RETURNS SETOF intel_global_sources LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY SELECT * FROM intel_global_sources ORDER BY created_at DESC;
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['intel_admin_add_global_source(text,text,text[],text)','intel_admin_remove_global_source(uuid)','intel_admin_list_global_sources()'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;
END $$;
