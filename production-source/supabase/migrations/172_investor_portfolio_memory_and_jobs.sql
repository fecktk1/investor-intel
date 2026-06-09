-- ============================================================
-- 172: Investor Intel — private portfolio memory (pgvector) + worker queue
-- ============================================================
-- investor_portfolio_memory mirrors the public exchange_market_memory (169) RAG
-- pattern, but is PRIVATE: org + user + portfolio scoped, strict per-user RLS.
--
-- HARD PRIVACY INVARIANT: user-specific portfolio facts (holdings, balances,
-- addresses, P&L, cost basis) live ONLY here. They are NEVER written to the
-- global/public exchange_market_memory. The retrieval function is SECURITY
-- INVOKER (NOT DEFINER) so base-table RLS auto-enforces per-user scope — a
-- DEFINER match fn would bypass RLS and leak across users.
--
-- investor_portfolio_sync_jobs is the Railway-worker backfill queue, mirroring
-- wallet_refresh_jobs (074): idempotent enqueue + atomic SECURITY DEFINER claim.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Private portfolio memory ────────────────────────────────
CREATE TABLE IF NOT EXISTS investor_portfolio_memory (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id)               ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  portfolio_id      uuid NOT NULL REFERENCES investor_portfolios(id) ON DELETE CASCADE,
  subject_key       text NOT NULL,                  -- 'portfolio' | 'SOL' | 'risk' | 'change:2026-06-08'
  normalized_symbol text,
  memory_type       text NOT NULL,                  -- portfolio_summary|holding_note|risk_rationale|change_log|contributor|signal_exposure|allocation_change|transaction_summary
  timeframe         text NOT NULL DEFAULT 'daily',
  title             text,
  summary           text NOT NULL,
  facts             jsonb NOT NULL DEFAULT '{}',
  confidence_score  double precision,
  embedding         vector(1536),
  content_hash      text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','degraded','stale')),
  is_active         boolean NOT NULL DEFAULT true,
  as_of             timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, memory_type, subject_key)
);
CREATE INDEX IF NOT EXISTS ipm_embedding ON investor_portfolio_memory
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS ipm_owner ON investor_portfolio_memory(org_id, user_id);
CREATE INDEX IF NOT EXISTS ipm_portfolio ON investor_portfolio_memory(portfolio_id) WHERE is_active;

DROP TRIGGER IF EXISTS trg_investor_portfolio_memory_updated_at ON investor_portfolio_memory;
CREATE TRIGGER trg_investor_portfolio_memory_updated_at BEFORE UPDATE ON investor_portfolio_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE investor_portfolio_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipm_select" ON investor_portfolio_memory;
CREATE POLICY "ipm_select" ON investor_portfolio_memory FOR SELECT
  USING (org_id = get_my_org_id() AND user_id = auth.uid());
DROP POLICY IF EXISTS "ipm_insert" ON investor_portfolio_memory;
CREATE POLICY "ipm_insert" ON investor_portfolio_memory FOR INSERT
  WITH CHECK (org_id = get_my_org_id() AND user_id = auth.uid());
DROP POLICY IF EXISTS "ipm_update" ON investor_portfolio_memory;
CREATE POLICY "ipm_update" ON investor_portfolio_memory FOR UPDATE
  USING (org_id = get_my_org_id() AND user_id = auth.uid())
  WITH CHECK (org_id = get_my_org_id() AND user_id = auth.uid());
DROP POLICY IF EXISTS "ipm_delete" ON investor_portfolio_memory;
CREATE POLICY "ipm_delete" ON investor_portfolio_memory FOR DELETE
  USING (org_id = get_my_org_id() AND user_id = auth.uid());

-- Retrieval: SECURITY INVOKER (default) so base-table RLS scopes to the caller.
-- Always pass p_portfolio_id; RLS still guarantees the caller owns that portfolio.
CREATE OR REPLACE FUNCTION match_investor_portfolio_memory(
  p_query_embedding vector(1536),
  p_portfolio_id    uuid,
  p_k               int   DEFAULT 6,
  p_min_similarity  float DEFAULT 0.1,
  p_symbol          text  DEFAULT NULL,
  p_memory_type     text  DEFAULT NULL
) RETURNS TABLE (
  id uuid, subject_key text, normalized_symbol text, memory_type text,
  title text, summary text, facts jsonb, confidence_score double precision,
  as_of timestamptz, similarity float
)
LANGUAGE sql STABLE AS $$
  SELECT m.id, m.subject_key, m.normalized_symbol, m.memory_type, m.title, m.summary,
         m.facts, m.confidence_score, m.as_of,
         1 - (m.embedding <=> p_query_embedding) AS similarity
  FROM investor_portfolio_memory m
  WHERE m.is_active = true AND m.embedding IS NOT NULL
    AND m.portfolio_id = p_portfolio_id
    AND (p_symbol IS NULL OR m.normalized_symbol = p_symbol)
    AND (p_memory_type IS NULL OR m.memory_type = p_memory_type)
    AND 1 - (m.embedding <=> p_query_embedding) >= p_min_similarity
  ORDER BY m.embedding <=> p_query_embedding
  LIMIT GREATEST(p_k, 1)
$$;
GRANT EXECUTE ON FUNCTION match_investor_portfolio_memory(vector, uuid, int, float, text, text) TO authenticated, service_role;

-- ── Worker backfill queue ───────────────────────────────────
CREATE TABLE IF NOT EXISTS investor_portfolio_sync_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES orgs(id)               ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  portfolio_id         uuid NOT NULL REFERENCES investor_portfolios(id) ON DELETE CASCADE,
  source_id            uuid NOT NULL REFERENCES investor_portfolio_sources(id) ON DELETE CASCADE,
  mode                 text NOT NULL DEFAULT 'backfill' CHECK (mode IN ('backfill','snapshot')),
  refresh_window_start timestamptz NOT NULL,
  max_signatures       integer,
  status               text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','succeeded','failed','skipped')),
  attempt_count        integer NOT NULL DEFAULT 0,
  max_attempts         integer NOT NULL DEFAULT 3,
  locked_by            text,
  locked_at            timestamptz,
  heartbeat_at         timestamptz,
  started_at           timestamptz,
  finished_at          timestamptz,
  result               jsonb,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- idempotent enqueue: a second "Sync now" in the same window inserts zero rows
CREATE UNIQUE INDEX IF NOT EXISTS ipsj_idem
  ON investor_portfolio_sync_jobs (source_id, refresh_window_start, mode);
CREATE INDEX IF NOT EXISTS ipsj_status
  ON investor_portfolio_sync_jobs (status, created_at) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS ipsj_owner
  ON investor_portfolio_sync_jobs (org_id, user_id, created_at DESC);

ALTER TABLE investor_portfolio_sync_jobs ENABLE ROW LEVEL SECURITY;
-- read-only for the owner (refresh indicator / debugging); all writes service-role
DROP POLICY IF EXISTS "ipsj_select" ON investor_portfolio_sync_jobs;
CREATE POLICY "ipsj_select" ON investor_portfolio_sync_jobs FOR SELECT
  USING (org_id = get_my_org_id() AND user_id = auth.uid());

CREATE OR REPLACE FUNCTION investor_portfolio_sync_jobs_try_claim(
  p_job_id    uuid,
  p_locked_by text
) RETURNS SETOF investor_portfolio_sync_jobs
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  UPDATE investor_portfolio_sync_jobs
  SET status        = 'running',
      locked_by     = p_locked_by,
      locked_at     = now(),
      started_at    = COALESCE(started_at, now()),
      heartbeat_at  = now(),
      attempt_count = attempt_count + 1
  WHERE id = p_job_id AND status = 'queued'
  RETURNING *;
END; $$;
REVOKE ALL ON FUNCTION investor_portfolio_sync_jobs_try_claim(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION investor_portfolio_sync_jobs_try_claim(uuid, text) TO service_role;
