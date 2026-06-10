-- ============================================================
-- 211: Investor Intel — reusable normalized Intel Signal layer
-- ============================================================
-- ONE normalized, snapshotted, deterministic signal object that powers Market Pulse,
-- Watchlist, Daily Brief, News, Alerts, Narrative Radar, Portfolio, Explain This,
-- Saved Research, and asset pages. Generated once (by the signal producer inside the
-- existing intel-curate-news cron), stored once, reused everywhere — surfaces never
-- re-derive it and never call AI per surface (richer AI text is referenced via
-- ai_artifact_ref into intel_shared_artifacts).
--
-- Pattern mirrors narrative_snapshots (193): append-only snapshots for history +
-- multi-window deltas, and a denormalized LATEST row (the hot read path) carrying
-- score_delta. All GLOBAL (public market intelligence is identical for everyone —
-- same justification as intel_curated_news / narrative_state). Reads are
-- authenticated; writes are service-role (the producer).
--
-- IDENTITY: subject_id is a CANONICAL entity key (canonical_ref_key / chain:address /
-- coingecko_id / native:{chain}), NEVER a bare symbol. display_symbol is a label only.
-- PRIVACY: only public market intelligence lives here. subject_type wallet/portfolio
-- are allowed by the contract, but this release writes NO private portfolio rows and
-- NO user-linked wallet rows — a wallet row appears only when classified as a public
-- whale/entity signal. Private portfolio/wallet "what changed" stays org/user-scoped.
-- ============================================================

-- ── Append-only history (multi-window deltas + "what changed") ─
CREATE TABLE IF NOT EXISTS intel_signal_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_key      text NOT NULL,                 -- "{subject_type}:{canonical_id}" lowercased
  snapshot_at     timestamptz NOT NULL DEFAULT now(),
  signal_type     text,
  subject_type    text NOT NULL,                 -- asset|chain|narrative|news|macro|protocol|wallet|portfolio
  subject_id      text NOT NULL,                 -- canonical id (never a bare symbol)
  display_symbol  text,                          -- label only
  chain           text,
  direction       text NOT NULL,                 -- bullish|bearish|mixed (never neutralized away)
  confidence      text,                          -- high|medium|low|thin
  source_count    int NOT NULL DEFAULT 0,
  source_diversity int NOT NULL DEFAULT 0,
  severity        numeric NOT NULL DEFAULT 0,    -- 0..1 deterministic
  freshness       numeric NOT NULL DEFAULT 0,    -- 0..1 exp-decay
  market_impact   numeric NOT NULL DEFAULT 0,    -- 0..1
  metrics         jsonb NOT NULL DEFAULT '{}',   -- raw inputs (explainability + change detection)
  score_delta     jsonb NOT NULL DEFAULT '{}'    -- {prev,1h,24h,7d}
);
CREATE INDEX IF NOT EXISTS iss_snap_key_time ON intel_signal_snapshots(signal_key, snapshot_at DESC);

-- ── Denormalized LATEST (one row per signal_key; hot read path) ─
CREATE TABLE IF NOT EXISTS intel_signal_state (
  signal_key         text PRIMARY KEY,
  signal_type        text,
  subject_type       text NOT NULL,
  subject_id         text NOT NULL,              -- canonical id
  display_symbol     text,                       -- label only
  chain              text,
  related_assets     jsonb NOT NULL DEFAULT '[]',   -- canonical asset keys, NOT symbols
  related_narratives jsonb NOT NULL DEFAULT '[]',   -- slugs
  related_wallets    jsonb NOT NULL DEFAULT '[]',   -- public/whale entity keys only
  direction          text NOT NULL,
  confidence         text,
  source_count       int NOT NULL DEFAULT 0,
  source_diversity   int NOT NULL DEFAULT 0,
  severity           numeric NOT NULL DEFAULT 0,
  freshness          numeric NOT NULL DEFAULT 0,
  market_impact      numeric NOT NULL DEFAULT 0,
  why_it_matters     text,
  what_to_watch_next text,
  evidence_refs      jsonb NOT NULL DEFAULT '[]',   -- [{kind,id,title,url}] — public only
  headlines          jsonb NOT NULL DEFAULT '[]',
  ai_artifact_ref    text,                          -- intel_shared_artifacts.entity_ref / evidence_hash
  metrics            jsonb NOT NULL DEFAULT '{}',
  score_delta        jsonb NOT NULL DEFAULT '{}',
  global_score       numeric NOT NULL DEFAULT 0,
  cache_key          text,
  generated_at       timestamptz NOT NULL DEFAULT now(),
  stale_after        timestamptz,
  expires_at         timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS iss_state_subject ON intel_signal_state(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS iss_state_chain   ON intel_signal_state(chain);
CREATE INDEX IF NOT EXISTS iss_state_score   ON intel_signal_state(global_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS iss_state_dir     ON intel_signal_state(direction);
CREATE INDEX IF NOT EXISTS iss_state_fresh   ON intel_signal_state(generated_at DESC);
CREATE INDEX IF NOT EXISTS iss_state_expires ON intel_signal_state(expires_at);
CREATE INDEX IF NOT EXISTS iss_state_assets  ON intel_signal_state USING gin (related_assets);
CREATE INDEX IF NOT EXISTS iss_state_narr    ON intel_signal_state USING gin (related_narratives);

-- updated_at trigger (reuse the shared helper, as narrative_state does)
DROP TRIGGER IF EXISTS trg_intel_signal_state_updated_at ON intel_signal_state;
CREATE TRIGGER trg_intel_signal_state_updated_at BEFORE UPDATE ON intel_signal_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── RLS: global read (authenticated); service-role writes ─────
ALTER TABLE intel_signal_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_signal_state     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS intel_signal_snap_read ON intel_signal_snapshots;
CREATE POLICY intel_signal_snap_read ON intel_signal_snapshots FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS intel_signal_state_read ON intel_signal_state;
CREATE POLICY intel_signal_state_read ON intel_signal_state FOR SELECT USING (auth.uid() IS NOT NULL);
-- writes are service-role only (the producer); no client write policy.
