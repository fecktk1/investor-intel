-- ============================================================
-- 171: Investor Intel — Portfolio Tracker core tables
-- ============================================================
-- A first-class, READ-ONLY portfolio tracker for Investor Intel. Holds real
-- holdings, cost basis, P&L, wallet-synced + manual transactions, daily value
-- snapshots, and sync logs. Priced via the Exchange Market Intelligence Layer
-- (exchange_latest_* tables, migrations 167-170) — never a second pricing system.
--
-- PRIVACY MODEL (key deviation from the org-shared watchlist, migration 135):
-- per-user-within-org. Every table carries org_id + user_id and RLS enforces
-- BOTH org_id = get_my_org_id() AND user_id = auth.uid() on ALL verbs, so a
-- teammate in the same org cannot read another user's portfolio. Child tables
-- denormalize org_id + user_id so the policy predicate is JOIN-free (no RLS
-- re-entry). Service-role writers (sync edge fn / worker / cron) set org_id +
-- user_id explicitly from the loaded portfolio row.
--
-- This is the single source of truth for real holdings/P&L. The watchlist's
-- optional manual holdings (watchlist_items.holding_amount/cost_basis_usd,
-- migration 156) stay a separate lightweight exposure note — not migrated here.
--
-- Memory (pgvector) + the worker queue live in 172; the daily snapshot cron in 173.
-- ============================================================

-- ── 1. investor_portfolios ──────────────────────────────────
CREATE TABLE IF NOT EXISTS investor_portfolios (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id)      ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES profiles(id)  ON DELETE CASCADE,
  name               text NOT NULL DEFAULT 'My Portfolio',
  base_currency      text NOT NULL DEFAULT 'USD',
  cost_basis_method  text NOT NULL DEFAULT 'fifo' CHECK (cost_basis_method IN ('fifo','average','manual')),
  is_default         boolean NOT NULL DEFAULT false,
  incomplete_history boolean NOT NULL DEFAULT false,   -- some cost basis / P&L is unknowable
  market_data_available boolean NOT NULL DEFAULT true, -- false when exchange_latest_* is absent
  -- denormalized last-compute caches (refreshed each sync / snapshot)
  total_value_usd    double precision,
  total_cost_usd     double precision,
  unrealized_pnl_usd double precision,
  realized_pnl_usd   double precision,
  day_pnl_usd        double precision,
  day_pnl_pct        double precision,
  stablecoin_pct     double precision,
  risk_score         double precision,                 -- 0..100
  last_synced_at     timestamptz,
  last_snapshot_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ip_one_default ON investor_portfolios(org_id, user_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS ip_owner ON investor_portfolios(org_id, user_id);

-- ── 2. investor_portfolio_sources ───────────────────────────
-- Where holdings/transactions come from. source_type + provider are a two-axis
-- model (original spec). CSV + exchange_readonly are schema-ready values only.
CREATE TABLE IF NOT EXISTS investor_portfolio_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id)               ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  portfolio_id    uuid NOT NULL REFERENCES investor_portfolios(id) ON DELETE CASCADE,
  source_type     text NOT NULL CHECK (source_type IN ('manual','wallet_address','wallet_connect','exchange_readonly','csv')),
  provider        text NOT NULL CHECK (provider IN ('manual','solflare','solana_address','evm_address','binance','coinbase','kraken','kucoin','csv')),
  chain           text,
  address         text,
  label           text,
  -- ownership proof state (rev 13): tracking never requires verification.
  connected       boolean NOT NULL DEFAULT false,   -- wallet_connect adapter session established
  verified        boolean NOT NULL DEFAULT false,   -- ownership proven via signed message
  verified_at     timestamptz,
  verification_method text,                          -- 'solflare_message_signature'
  -- capability + freshness (rev 5)
  holdings_sync_supported     boolean NOT NULL DEFAULT false,
  transaction_sync_supported  boolean NOT NULL DEFAULT false,
  holdings_sync_status        text,                  -- 'ok'|'degraded'|'unsupported_chain'|'error'|null
  transaction_sync_status     text,
  last_holdings_sync_at       timestamptz,
  last_transaction_sync_at    timestamptz,
  sync_confidence  double precision,                 -- 0..1
  stale_after      interval NOT NULL DEFAULT '24 hours',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','inactive','error')),
  is_active       boolean NOT NULL DEFAULT true,
  last_synced_at  timestamptz,
  last_error      text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- one wallet/address per portfolio (COALESCE so nullable chain/address collapse)
CREATE UNIQUE INDEX IF NOT EXISTS ips_unique_source
  ON investor_portfolio_sources (portfolio_id, source_type, COALESCE(chain,''), COALESCE(address,''));
CREATE INDEX IF NOT EXISTS ips_owner ON investor_portfolio_sources(org_id, user_id);
CREATE INDEX IF NOT EXISTS ips_portfolio ON investor_portfolio_sources(portfolio_id) WHERE is_active;

-- ── 3. investor_portfolio_transactions ──────────────────────
CREATE TABLE IF NOT EXISTS investor_portfolio_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id)               ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  portfolio_id    uuid NOT NULL REFERENCES investor_portfolios(id) ON DELETE CASCADE,
  source_id       uuid NOT NULL REFERENCES investor_portfolio_sources(id) ON DELETE CASCADE,
  transaction_type text NOT NULL CHECK (transaction_type IN (
    'buy','sell','transfer_in','transfer_out','swap','fee','airdrop','staking_reward','deposit','withdrawal','unknown')),
  -- imported classification, IMMUTABLE after import; user edits never overwrite this (rev 12)
  original_transaction_type text,
  classification_status text NOT NULL DEFAULT 'confirmed'
    CHECK (classification_status IN ('confirmed','inferred','unclassified','user_corrected')),
  confidence_score double precision,                 -- 0..1
  direction       text CHECK (direction IS NULL OR direction IN ('in','out')),
  asset_symbol    text,
  normalized_symbol text,                            -- mapped uppercase, or NULL if unresolved
  canonical_asset_id text,
  contract_address text,
  chain           text,
  quantity        double precision,                  -- token units (>= 0)
  price_per_unit  double precision,                  -- NULL = unknown; never used as CURRENT price
  quote_currency  text NOT NULL DEFAULT 'USD',
  total_value     double precision,
  fee_amount      double precision,
  fee_currency    text,
  external_tx_signature text,                        -- Solana signature
  external_tx_hash      text,                        -- EVM hash
  "timestamp"     timestamptz,
  notes           text,
  tags            text[] NOT NULL DEFAULT '{}',
  raw_metadata    jsonb NOT NULL DEFAULT '{}',       -- original parsed payload, preserved (rev 12)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- DEDUPE: prevent duplicate imported txns. COALESCE collapses NULL sig/hash/symbol.
-- (Partial/expression unique index can't be PostgREST-upserted: the worker dedupes
--  in code and this index is the race backstop — see worker/src/portfolio-sync-jobs.ts.)
CREATE UNIQUE INDEX IF NOT EXISTS ipt_dedupe ON investor_portfolio_transactions (
  source_id,
  COALESCE(external_tx_signature, external_tx_hash, ''),
  COALESCE(normalized_symbol, asset_symbol, ''),
  COALESCE(direction, ''),
  transaction_type
);
CREATE INDEX IF NOT EXISTS ipt_portfolio_time ON investor_portfolio_transactions(portfolio_id, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS ipt_symbol ON investor_portfolio_transactions(portfolio_id, normalized_symbol);
CREATE INDEX IF NOT EXISTS ipt_owner ON investor_portfolio_transactions(org_id, user_id);

-- ── 4. investor_portfolio_holdings (current state; recomputed each sync) ──
CREATE TABLE IF NOT EXISTS investor_portfolio_holdings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id)               ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  portfolio_id    uuid NOT NULL REFERENCES investor_portfolios(id) ON DELETE CASCADE,
  asset_symbol    text,
  normalized_symbol text,
  canonical_asset_id text,
  contract_address text,
  chain           text,
  asset_class     text NOT NULL DEFAULT 'token' CHECK (asset_class IN ('native','token','stablecoin')),
  quantity        double precision NOT NULL DEFAULT 0,
  average_cost    double precision,                  -- per-unit cost basis (NULL = unknown)
  cost_basis_usd  double precision,
  current_price   double precision,
  current_value   double precision,                  -- NULL when unpriced (excluded from totals)
  price_source    text,                              -- 'exchange_profile'|'birdeye_snapshot'|'stable_floor'|null
  price_status    text NOT NULL DEFAULT 'unpriced' CHECK (price_status IN ('priced','stale','unpriced','estimated')),
  last_priced_at  timestamptz,
  unrealized_pnl     double precision,
  unrealized_pnl_pct double precision,
  realized_pnl       double precision,
  day_pnl         double precision,
  day_pnl_pct     double precision,
  allocation_pct  double precision,
  pnl_state       text NOT NULL DEFAULT 'estimate' CHECK (pnl_state IN ('estimate','incomplete_history','unpriced_or_stale')),
  reconciliation_status text CHECK (reconciliation_status IS NULL OR reconciliation_status IN (
    'matched','wallet_higher','wallet_lower','manual_only','wallet_only','unknown')),
  market_context  jsonb NOT NULL DEFAULT '{}',       -- signal/liquidity/caution/mcap snapshot
  is_dust         boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS iph_unique_holding
  ON investor_portfolio_holdings (portfolio_id, COALESCE(chain,''), COALESCE(contract_address, normalized_symbol, asset_symbol, ''));
CREATE INDEX IF NOT EXISTS iph_portfolio_value ON investor_portfolio_holdings(portfolio_id, current_value DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS iph_owner ON investor_portfolio_holdings(org_id, user_id);

-- ── 5. investor_portfolio_snapshots (one row per portfolio per day) ──
CREATE TABLE IF NOT EXISTS investor_portfolio_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id)               ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  portfolio_id       uuid NOT NULL REFERENCES investor_portfolios(id) ON DELETE CASCADE,
  snapshot_date      date NOT NULL,
  base_currency      text NOT NULL DEFAULT 'USD',
  total_value_usd    double precision,
  total_cost_usd     double precision,
  unrealized_pnl_usd double precision,
  realized_pnl_usd   double precision,
  day_pnl_usd        double precision,
  day_pnl_pct        double precision,
  risk_score         double precision,
  stablecoin_pct     double precision,
  chain_allocations  jsonb NOT NULL DEFAULT '[]',
  asset_allocations  jsonb NOT NULL DEFAULT '[]',
  risk_summary       jsonb NOT NULL DEFAULT '{}',
  holdings_summary   jsonb NOT NULL DEFAULT '[]',
  token_count        integer,
  as_of              timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, snapshot_date)               -- exactly one snapshot/day/portfolio (rev 8)
);
CREATE INDEX IF NOT EXISTS ipsn_portfolio_date ON investor_portfolio_snapshots(portfolio_id, snapshot_date DESC);

-- ── 6. investor_portfolio_sync_logs ─────────────────────────
CREATE TABLE IF NOT EXISTS investor_portfolio_sync_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id)               ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  portfolio_id    uuid NOT NULL REFERENCES investor_portfolios(id) ON DELETE CASCADE,
  source_id       uuid REFERENCES investor_portfolio_sources(id) ON DELETE SET NULL,
  sync_kind       text NOT NULL CHECK (sync_kind IN ('holdings','backfill','snapshot')),
  status          text NOT NULL CHECK (status IN ('started','succeeded','failed','partial','skipped')),
  trigger         text NOT NULL DEFAULT 'on_demand' CHECK (trigger IN ('on_demand','cron','worker')),
  holdings_count  integer,
  txns_imported   integer,
  txns_deduped    integer,
  provider_calls  jsonb NOT NULL DEFAULT '{}',       -- budget logging (rev 4)
  duration_ms     integer,
  error           text,
  detail          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ipsl_portfolio_time ON investor_portfolio_sync_logs(portfolio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ipsl_owner ON investor_portfolio_sync_logs(org_id, user_id);

-- ── updated_at triggers ─────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'investor_portfolios','investor_portfolio_sources',
    'investor_portfolio_transactions','investor_portfolio_holdings'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t);
  END LOOP;
END $$;

-- ── Per-user RLS (org_id AND user_id, all four verbs) ───────
ALTER TABLE investor_portfolios             ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_portfolio_sources      ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_portfolio_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_portfolio_holdings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_portfolio_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_portfolio_sync_logs    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text; prefix text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'investor_portfolios','investor_portfolio_sources','investor_portfolio_transactions',
    'investor_portfolio_holdings','investor_portfolio_snapshots','investor_portfolio_sync_logs'
  ] LOOP
    prefix := 'ip_' || left(replace(t, 'investor_portfolio', 'ipf'), 26);
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_select" ON %s FOR SELECT
      USING (org_id = get_my_org_id() AND user_id = auth.uid())$p$, prefix, t);

    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_insert" ON %s FOR INSERT
      WITH CHECK (org_id = get_my_org_id() AND user_id = auth.uid())$p$, prefix, t);

    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_update" ON %s FOR UPDATE
      USING (org_id = get_my_org_id() AND user_id = auth.uid())
      WITH CHECK (org_id = get_my_org_id() AND user_id = auth.uid())$p$, prefix, t);

    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_delete" ON %s FOR DELETE
      USING (org_id = get_my_org_id() AND user_id = auth.uid())$p$, prefix, t);
  END LOOP;
END $$;

-- ── Abuse caps (rev 14): DB-level backstop the client cannot bypass ──
-- Tunable via GUC (e.g. SET app.portfolio_max_portfolios_per_user = '20'),
-- defaulting to the same literals as the PORTFOLIO_* env vars at the app layer.
CREATE OR REPLACE FUNCTION enforce_max_portfolios_per_user()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max int; v_count int;
BEGIN
  v_max := COALESCE(NULLIF(current_setting('app.portfolio_max_portfolios_per_user', true), '')::int, 10);
  SELECT count(*) INTO v_count FROM investor_portfolios
    WHERE user_id = NEW.user_id AND org_id = NEW.org_id;
  IF v_count >= v_max THEN
    RAISE EXCEPTION 'portfolio limit reached (max % per user)', v_max USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_ip_max_portfolios ON investor_portfolios;
CREATE TRIGGER trg_ip_max_portfolios BEFORE INSERT ON investor_portfolios
  FOR EACH ROW EXECUTE FUNCTION enforce_max_portfolios_per_user();

CREATE OR REPLACE FUNCTION enforce_max_sources_per_portfolio()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max int; v_count int;
BEGIN
  v_max := COALESCE(NULLIF(current_setting('app.portfolio_max_sources_per_portfolio', true), '')::int, 25);
  SELECT count(*) INTO v_count FROM investor_portfolio_sources WHERE portfolio_id = NEW.portfolio_id;
  IF v_count >= v_max THEN
    RAISE EXCEPTION 'source limit reached (max % per portfolio)', v_max USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_ips_max_sources ON investor_portfolio_sources;
CREATE TRIGGER trg_ips_max_sources BEFORE INSERT ON investor_portfolio_sources
  FOR EACH ROW EXECUTE FUNCTION enforce_max_sources_per_portfolio();

-- Manual-entry cap: only counts txns whose source is manual (the user-facing form).
CREATE OR REPLACE FUNCTION enforce_max_manual_txns_per_portfolio()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max int; v_count int; v_is_manual boolean;
BEGIN
  SELECT (source_type = 'manual') INTO v_is_manual FROM investor_portfolio_sources WHERE id = NEW.source_id;
  IF COALESCE(v_is_manual, false) THEN
    v_max := COALESCE(NULLIF(current_setting('app.portfolio_max_manual_txns_per_portfolio', true), '')::int, 10000);
    SELECT count(*) INTO v_count FROM investor_portfolio_transactions t
      JOIN investor_portfolio_sources s ON s.id = t.source_id
      WHERE t.portfolio_id = NEW.portfolio_id AND s.source_type = 'manual';
    IF v_count >= v_max THEN
      RAISE EXCEPTION 'manual transaction limit reached (max % per portfolio)', v_max USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_ipt_max_manual ON investor_portfolio_transactions;
CREATE TRIGGER trg_ipt_max_manual BEFORE INSERT ON investor_portfolio_transactions
  FOR EACH ROW EXECUTE FUNCTION enforce_max_manual_txns_per_portfolio();
