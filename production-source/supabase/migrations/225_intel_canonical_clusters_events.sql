-- ============================================================
-- 225: Investor Intel — canonical story clusters + historic event memory
-- ============================================================
-- Extends the EXISTING signal_clusters (mig 154) in place (additive — it is
-- load-bearing for signal_feed, so we do not rewrite it) with canonical identity:
-- root/parent chaining for recurring multi-week stories, cluster confidence,
-- source diversity, evidence hash, surfaced decision, engagement, and the
-- category/macro/asset/chain/narrative facets needed for long-memory queries.
--
-- Adds intel_event_memory: compact, 3-year (optionally permanent) records for
-- major/historic events, promoted DETERMINISTICALLY from stored Gemini/Grok
-- importance + event-type rules. No new AI/provider calls.
-- ============================================================

-- ── 1. Canonical cluster identity (additive on signal_clusters) ───────────────
DO $$ BEGIN
  IF to_regclass('signal_clusters') IS NOT NULL THEN
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS root_cluster_id   uuid;   -- soft self-ref (recurring story root)
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS parent_cluster_id uuid;   -- soft self-ref (chain link)
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS recurrence_count  int NOT NULL DEFAULT 0;
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS cluster_confidence numeric;
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS source_diversity  int;
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS evidence_hash     text;
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS categories        text[] NOT NULL DEFAULT '{}';
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS macro_topics      text[] NOT NULL DEFAULT '{}';
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS related_assets    text[] NOT NULL DEFAULT '{}';
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS event_type        text;   -- deterministic classification
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS surfaced          boolean;
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS surfaced_reason   text;
    ALTER TABLE signal_clusters ADD COLUMN IF NOT EXISTS peak_seen_at      timestamptz;
    CREATE INDEX IF NOT EXISTS signal_clusters_root ON signal_clusters(root_cluster_id) WHERE root_cluster_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS signal_clusters_event ON signal_clusters(event_type) WHERE event_type IS NOT NULL;
    CREATE INDEX IF NOT EXISTS signal_clusters_categories ON signal_clusters USING gin (categories);
  END IF;
END $$;

-- ── 2. Historic event memory (3-year min, optionally permanent) ───────────────
CREATE TABLE IF NOT EXISTS intel_event_memory (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key         text NOT NULL UNIQUE,           -- deterministic dedupe key (type + canonical subject + window)
  event_type        text NOT NULL,                  -- etf_decision|regulatory_action|exploit|exchange_collapse|chain_outage|protocol_launch|court_decision|macro_shock|liquidation_event|token_unlock|stablecoin_depeg|governance|memecoin_mania|other
  title             text NOT NULL,
  summary           text,
  occurred_at       timestamptz NOT NULL,
  importance_score  numeric,                          -- from stored Gemini/Grok importance (reused, not recomputed)
  importance_source text,                             -- gemini|grok|deterministic
  categories        text[] NOT NULL DEFAULT '{}',
  assets            text[] NOT NULL DEFAULT '{}',
  chains            text[] NOT NULL DEFAULT '{}',
  narratives        text[] NOT NULL DEFAULT '{}',
  macro_topics      text[] NOT NULL DEFAULT '{}',
  source_cluster_id uuid,                             -- soft ref (survives cluster prune)
  evidence_hash     text,
  evidence_refs     jsonb NOT NULL DEFAULT '[]',
  confirmed_by_admin boolean NOT NULL DEFAULT false,
  permanent         boolean NOT NULL DEFAULT false,   -- super-admin may pin permanent
  retain_until      timestamptz NOT NULL DEFAULT (now() + interval '3 years'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intel_event_occurred ON intel_event_memory(occurred_at DESC);
CREATE INDEX IF NOT EXISTS intel_event_type ON intel_event_memory(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS intel_event_assets ON intel_event_memory USING gin (assets);
CREATE INDEX IF NOT EXISTS intel_event_chains ON intel_event_memory USING gin (chains);
CREATE INDEX IF NOT EXISTS intel_event_categories ON intel_event_memory USING gin (categories);
ALTER TABLE intel_event_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_event_read ON intel_event_memory;
-- Historic events are public market history (no private data) → authenticated read.
CREATE POLICY intel_event_read ON intel_event_memory FOR SELECT USING (auth.uid() IS NOT NULL);

-- ── 3. Deterministic event promotion (no AI) ─────────────────────────────────
-- Promotes curated-news clusters whose STORED Gemini/Grok importance is high AND
-- whose event-type is major, into compact 3-year event records. Idempotent
-- (event_key UNIQUE). p_min_importance is the floor on already-stored scores.
CREATE OR REPLACE FUNCTION intel_promote_events(p_min_importance numeric DEFAULT 78, p_lookback_days int DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_promoted int := 0;
BEGIN
  WITH cand AS (
    SELECT c.cluster_hash, c.cleaned_title, c.title, c.summary, c.why_it_matters,
           COALESCE(c.published_at, c.created_at) AS occurred_at,
           GREATEST(COALESCE(c.importance_score,0), COALESCE(c.market_impact_score,0)) AS imp,
           c.tokens, c.chains, c.narratives, c.sectors,
           -- deterministic event-type from the curated category + title keywords
           CASE
             WHEN c.title ~* '(ETF).*(approv|deni|reject|delay)|(approv|deni|reject).*ETF' THEN 'etf_decision'
             WHEN c.title ~* 'exploit|hack|drain|stolen|breach' THEN 'exploit'
             WHEN c.title ~* 'bankrupt|insolven|collapse|halts withdrawal|freeze withdrawal' THEN 'exchange_collapse'
             WHEN c.title ~* 'outage|halted|down for|offline|block production' THEN 'chain_outage'
             WHEN c.title ~* 'depeg|de-peg|lost its peg|below \$0\.9' THEN 'stablecoin_depeg'
             WHEN c.title ~* 'liquidat' THEN 'liquidation_event'
             WHEN c.title ~* 'unlock|vesting|cliff' THEN 'token_unlock'
             WHEN c.title ~* 'lawsuit|court|judge|ruling|settlement|verdict|sues|charged' THEN 'court_decision'
             WHEN c.title ~* 'SEC|CFTC|MiCA|sanction|ban|regulat|legislation|bill' THEN 'regulatory_action'
             WHEN c.title ~* 'mainnet|launch|goes live|token generation|TGE' THEN 'protocol_launch'
             WHEN c.title ~* 'rate (cut|hike|decision)|FOMC|CPI|inflation|jobs report' THEN 'macro_shock'
             WHEN c.title ~* 'governance|proposal passed|vote' THEN 'governance'
             ELSE NULL
           END AS etype
    FROM intel_curated_news c
    WHERE COALESCE(c.published_at, c.created_at) > now() - make_interval(days => GREATEST(1, p_lookback_days))
  ),
  promote AS (
    SELECT *, ('evt_' || etype || '_' || cluster_hash) AS event_key FROM cand
    WHERE etype IS NOT NULL AND imp >= p_min_importance
  ),
  ins AS (
    INSERT INTO intel_event_memory (event_key, event_type, title, summary, occurred_at, importance_score, importance_source, categories, assets, chains, narratives)
    SELECT event_key, etype, COALESCE(cleaned_title, title), why_it_matters, occurred_at, imp, 'gemini_grok',
           COALESCE(sectors,'{}'), COALESCE(tokens,'{}'), COALESCE(chains,'{}'), COALESCE(narratives,'{}')
    FROM promote
    ON CONFLICT (event_key) DO UPDATE SET
      importance_score = GREATEST(intel_event_memory.importance_score, EXCLUDED.importance_score),
      updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_promoted FROM ins;
  RETURN jsonb_build_object('promoted', v_promoted, 'min_importance', p_min_importance, 'lookback_days', p_lookback_days);
END $$;

-- ── 4. Cluster inspector (super-admin debug) ─────────────────────────────────
CREATE OR REPLACE FUNCTION intel_cluster_inspect(p_cluster_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT jsonb_build_object(
    'cluster', to_jsonb(c.*),
    'recurrence_chain', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', k.id, 'title', k.main_title, 'last_seen_at', k.last_seen_at) ORDER BY k.last_seen_at)
        FROM signal_clusters k WHERE k.root_cluster_id = COALESCE(c.root_cluster_id, c.id) OR k.id = COALESCE(c.root_cluster_id, c.id)), '[]'::jsonb),
    'member_signals', COALESCE((SELECT jsonb_agg(jsonb_build_object('title', s.title, 'source', s.source_name, 'published_at', s.published_at) ORDER BY s.published_at DESC)
        FROM (SELECT title, source_name, published_at FROM signals WHERE cluster_id = c.id ORDER BY published_at DESC NULLS LAST LIMIT 30) s), '[]'::jsonb),
    'hash_memory', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', h.hash_kind, 'seen_count', h.seen_count, 'first_seen_at', h.first_seen_at))
        FROM intel_hash_memory h WHERE h.cluster_id = c.id), '[]'::jsonb)
  ) INTO v FROM signal_clusters c WHERE c.id = p_cluster_id;
  RETURN v;
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['intel_promote_events(numeric,int)','intel_cluster_inspect(uuid)','intel_hash_memory_upsert(text,text,text,text,text,uuid,text[],text[],text[],text[],timestamptz)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON FUNCTION intel_cluster_inspect(uuid) TO authenticated';  -- self-gated to super-admin
END $$;
