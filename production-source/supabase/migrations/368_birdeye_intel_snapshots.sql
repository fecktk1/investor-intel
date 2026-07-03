-- ============================================================
-- Batch 5 (v3.1): Birdeye security + holder + top-trader snapshots
-- ============================================================
-- token_security_snapshots  → token risk badge/panel (Birdeye + CoinGecko GT)
-- token_holder_snapshots    → holder concentration panel + holder_shift alert
-- smart_money_events        → smart-money feed (Birdeye Top Traders PnL)
-- Global-read RLS (cross-org shared cache), service-role write. Column names
-- match the mig-363 freshness RPC (fetched_at / snapshot_at / occurred_at).

-- ── token_security_snapshots (latest per token per provider) ──
CREATE TABLE IF NOT EXISTS token_security_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid,
  chain               text NOT NULL,
  token_address       text NOT NULL,
  canonical_ref_key   text,
  provider            text NOT NULL DEFAULT 'birdeye',   -- birdeye | coingecko
  mint_authority      text,             -- null/'' => renounced/none
  freeze_authority    text,
  is_honeypot         text,             -- 'true' | 'false' | 'unknown'
  top10_holder_pct    numeric,
  lp_burned_pct       numeric,
  lp_locked_pct       numeric,
  buy_tax             numeric,
  sell_tax            numeric,
  creator_address     text,
  creator_pct         numeric,
  owner_address       text,
  is_mutable_metadata boolean,
  gt_score            integer,          -- CoinGecko GT trust score 0..100
  raw_response        jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence          numeric,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  stale_after         timestamptz NOT NULL DEFAULT now() + interval '1 day',
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, token_address, provider)
);
CREATE INDEX IF NOT EXISTS token_security_snapshots_lookup ON token_security_snapshots(chain, token_address, fetched_at DESC);

-- ── token_holder_snapshots (history; ≤1/hour per provider for delta) ──
CREATE TABLE IF NOT EXISTS token_holder_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid,
  chain             text NOT NULL,
  token_address     text NOT NULL,
  canonical_ref_key text,
  provider          text NOT NULL DEFAULT 'birdeye',
  holder_count      integer,
  top_holders       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{address, ui_amount, pct}]
  top1_pct          numeric,
  top10_pct         numeric,
  raw_response      jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot_at       timestamptz NOT NULL DEFAULT now(),
  stale_after       timestamptz NOT NULL DEFAULT now() + interval '6 hours',
  dedup_key         text NOT NULL,
  UNIQUE (dedup_key)
);
CREATE INDEX IF NOT EXISTS token_holder_snapshots_lookup ON token_holder_snapshots(chain, token_address, snapshot_at DESC);

-- ── smart_money_events (Top Traders + later webhook/enhanced-tx) ──
CREATE TABLE IF NOT EXISTS smart_money_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain           text NOT NULL,
  token_address   text,
  wallet_address  text NOT NULL,
  event_type      text NOT NULL,        -- top_trader | accumulate | distribute | ...
  pnl_realized    numeric,
  pnl_unrealized  numeric,
  pnl_total       numeric,
  volume_usd      numeric,
  trade_count     integer,
  source_provider text NOT NULL DEFAULT 'birdeye',
  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  dedup_key       text NOT NULL,
  UNIQUE (dedup_key)
);
CREATE INDEX IF NOT EXISTS smart_money_events_token ON smart_money_events(token_address, occurred_at DESC);
CREATE INDEX IF NOT EXISTS smart_money_events_wallet ON smart_money_events(wallet_address, occurred_at DESC);

-- RLS: global-read for authenticated (shared cache), service-role write.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['token_security_snapshots','token_holder_snapshots','smart_money_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_read ON %I', t, t);
    EXECUTE format('CREATE POLICY %I_read ON %I FOR SELECT USING (auth.uid() IS NOT NULL)', t, t);
    EXECUTE format('GRANT SELECT ON TABLE %I TO authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO service_role', t);
  END LOOP;
END $$;
