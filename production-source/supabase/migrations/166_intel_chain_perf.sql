-- ============================================================
-- 166: Investor Intel — per-chain native-token performance (shared)
-- ============================================================
-- One global row per launch chain (native-token price + 24h change), refreshed
-- by the existing regime cron in ONE shared CoinGecko call. Market Pulse renders
-- only the chains a user has SELECTED (chains_of_interest ∪ watchlist), so it
-- stays hidden until they pick chains and shows all 17 if they pick all 17.
-- Read by any authed user; written service-role.
-- ============================================================

CREATE TABLE IF NOT EXISTS intel_chain_perf (
  chain_id     text PRIMARY KEY,
  symbol       text,
  coingecko_id text,
  price        numeric,
  change_24h   numeric,
  market_cap   numeric,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE intel_chain_perf ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_chain_perf_read ON intel_chain_perf;
CREATE POLICY intel_chain_perf_read ON intel_chain_perf FOR SELECT USING (auth.uid() IS NOT NULL);
-- writes service-role only (intel-regime).
