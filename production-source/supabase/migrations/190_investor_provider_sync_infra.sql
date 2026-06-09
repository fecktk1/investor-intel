-- ============================================================
-- 190: Investor Intel — provider sync infra (cursors, job modes, usage logs)
-- ============================================================
-- 1. investor_portfolio_sync_cursors: resumable incremental cursors per
--    (source, chain, provider, cursor_kind). Durable progress is last_block_time
--    / last_signature; the opaque cursor (Alchemy pageKey, Helius paginationToken)
--    is intra-job only (Alchemy pageKey has a 10-min TTL).
-- 2. Extend investor_portfolio_sync_jobs.mode for the new pipeline.
-- 3. provider_api_usage_logs: the production observability gate. NEVER logs API
--    keys; stores wallet_hash + redacted endpoint. Service-role only.
-- ============================================================

-- ── 1. Incremental cursors ───────────────────────────────────
CREATE TABLE IF NOT EXISTS investor_portfolio_sync_cursors (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id)               ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  source_id         uuid NOT NULL REFERENCES investor_portfolio_sources(id) ON DELETE CASCADE,
  chain             text NOT NULL,
  provider          text NOT NULL,             -- 'helius'|'alchemy'|'etherscan'
  cursor_kind       text NOT NULL,             -- 'tx_backfill'|'tx_forward'|'helius_transfers'|'alchemy_transfers_from'|'alchemy_transfers_to'|'etherscan_txlist'|'etherscan_tokentx'
  pagination_token  text,                       -- Helius paginationToken (intra-job)
  page_key          text,                       -- Alchemy pageKey (intra-job, 10-min TTL)
  last_signature    text,                       -- Solana
  last_slot         bigint,
  last_block        bigint,                     -- EVM highest block fully ingested
  last_tx_hash      text,
  last_block_time   bigint,                     -- epoch seconds of newest event seen (durable stop point)
  oldest_block      bigint,                     -- backfill low-water mark
  complete          boolean NOT NULL DEFAULT false,
  extra             jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ipsc_unique ON investor_portfolio_sync_cursors (source_id, chain, provider, cursor_kind);
CREATE INDEX IF NOT EXISTS ipsc_owner ON investor_portfolio_sync_cursors(org_id, user_id);

DROP TRIGGER IF EXISTS trg_ipsc_updated_at ON investor_portfolio_sync_cursors;
CREATE TRIGGER trg_ipsc_updated_at BEFORE UPDATE ON investor_portfolio_sync_cursors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE investor_portfolio_sync_cursors ENABLE ROW LEVEL SECURITY;
-- read-only for the owner (debugging); all writes service-role (the worker)
DROP POLICY IF EXISTS "ipsc_select" ON investor_portfolio_sync_cursors;
CREATE POLICY "ipsc_select" ON investor_portfolio_sync_cursors FOR SELECT
  USING (org_id = get_my_org_id() AND user_id = auth.uid());

-- ── 2. Extend the worker job mode enum (keep legacy 'backfill' for in-flight rows) ──
ALTER TABLE investor_portfolio_sync_jobs
  DROP CONSTRAINT IF EXISTS investor_portfolio_sync_jobs_mode_check;
ALTER TABLE investor_portfolio_sync_jobs
  ADD CONSTRAINT investor_portfolio_sync_jobs_mode_check
  CHECK (mode IN ('backfill','backfill_solana','backfill_evm','metadata','prices','snapshot'));

-- ── 3. Unified provider usage log (observability gate; service-role only) ────
CREATE TABLE IF NOT EXISTS provider_api_usage_logs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                    text NOT NULL,     -- 'helius'|'alchemy'|'etherscan'
  endpoint                    text NOT NULL,     -- method/path, REDACTED (no api-key/url)
  chain                       text,
  source_id                   uuid,
  portfolio_id                uuid,
  org_id                      uuid,
  job_name                    text,
  wallet_hash                 text,              -- salted hash, never the raw address
  request_count               integer NOT NULL DEFAULT 1,
  est_credits_or_cu           double precision,
  cache_status                text,              -- 'hit'|'miss'|'negative'|'suppressed'|'live'
  error_or_suppression_reason text,              -- REDACTED of any url/key
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paul_time     ON provider_api_usage_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS paul_provider ON provider_api_usage_logs(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS paul_org      ON provider_api_usage_logs(org_id, created_at DESC) WHERE org_id IS NOT NULL;

-- Service-role only: RLS on, no policies (no anon/authenticated access).
ALTER TABLE provider_api_usage_logs ENABLE ROW LEVEL SECURITY;
