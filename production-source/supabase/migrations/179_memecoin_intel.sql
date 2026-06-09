-- ============================================================
-- 179: Memecoin Intel — multi-chain Degen terminal (latest + caches + health)
-- ============================================================
-- Backs Degen mode (/intel/markets?mode=degen) for memecoins across Solana /
-- Ethereum / Base / BNB (architecture not limited to four). Free-first cached
-- data from DexScreener + GeckoTerminal (+ DefiLlama/Jupiter); Birdeye is only
-- a LAZY per-token enrichment on open. All tables GLOBAL, service-role write,
-- authenticated read — render paths read `memecoin_latest_tokens` only.
-- Safe to apply anytime.
-- ============================================================

-- ── Provider health (dexscreener/geckoterminal/defillama/jupiter/pumpportal/birdeye)
CREATE TABLE IF NOT EXISTS memecoin_providers (
  provider             text PRIMARY KEY,
  name                 text,
  base_url             text,
  enabled              boolean     NOT NULL DEFAULT true,
  provider_type        text        NOT NULL DEFAULT 'dex',
  ws_connected         boolean     NOT NULL DEFAULT false,
  ws_reconnects        integer     NOT NULL DEFAULT 0,
  last_event_at        timestamptz,
  last_ok_at           timestamptz,
  last_error_at        timestamptz,
  last_status          integer,
  last_error           text,
  consecutive_failures integer     NOT NULL DEFAULT 0,
  rate_limited_until   timestamptz,
  paused_until         timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE memecoin_providers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memecoin_providers_read ON memecoin_providers;
CREATE POLICY memecoin_providers_read ON memecoin_providers FOR SELECT USING (auth.uid() IS NOT NULL);

-- ── Latest memecoin tokens (PRIMARY Degen read) ──────────────
CREATE TABLE IF NOT EXISTS memecoin_latest_tokens (
  chain                 text NOT NULL,
  token_address         text NOT NULL,
  symbol                text,
  name                  text,
  -- images (robust pipeline; see TokenAvatar + G2)
  image_url             text,
  cached_image_url      text,
  image_source          text,
  image_fallback_type   text,
  image_last_checked_at timestamptz,
  image_verified_at     timestamptz,
  image_error_count     integer NOT NULL DEFAULT 0,
  -- market
  price_usd             double precision,
  change_1h_pct         double precision,
  change_24h_pct        double precision,
  volume_24h_usd        double precision,
  liquidity_usd         double precision,
  fdv                   double precision,
  market_cap            double precision,
  buys_24h              integer,
  sells_24h             integer,
  txns_24h              integer,
  pair_address          text,
  dex_id                text,
  socials               jsonb,
  links                 jsonb,
  pair_created_at       timestamptz,
  -- discovery flags / buckets
  is_trending           boolean NOT NULL DEFAULT false,
  is_boosted            boolean NOT NULL DEFAULT false,
  is_takeover           boolean NOT NULL DEFAULT false,
  is_new                boolean NOT NULL DEFAULT false,
  is_pumpfun            boolean NOT NULL DEFAULT false,
  is_migrated           boolean NOT NULL DEFAULT false,
  discovery_reasons     text[]  NOT NULL DEFAULT '{}',
  liquidity_verified    boolean NOT NULL DEFAULT false,
  listing_state         text    NOT NULL DEFAULT 'verified',  -- 'pre_liquidity' | 'verified'
  launch_source         text,
  launch_timestamp      timestamptz,
  migration_timestamp   timestamptz,
  -- deterministic scoring (no AI)
  momentum_score        double precision,
  risk_score            double precision,
  risk_flags            jsonb,
  signal_direction      text,                                  -- bullish | bearish | caution | neutral
  -- attribution (first-class; see M6.4)
  source                text,
  source_provider       text,
  source_url            text,
  source_label          text,
  attribution_label     text,
  confidence            text,
  last_refreshed_at     timestamptz NOT NULL DEFAULT now(),
  -- lazy enrichment
  birdeye_enriched      boolean NOT NULL DEFAULT false,
  enriched_at           timestamptz,
  as_of                 timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, token_address)
);
CREATE INDEX IF NOT EXISTS memetok_vol ON memecoin_latest_tokens (volume_24h_usd DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS memetok_liq ON memecoin_latest_tokens (liquidity_usd DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS memetok_mc ON memecoin_latest_tokens (market_cap DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS memetok_chg ON memecoin_latest_tokens (change_24h_pct DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS memetok_created ON memecoin_latest_tokens (pair_created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS memetok_risk ON memecoin_latest_tokens (risk_score ASC NULLS LAST);
CREATE INDEX IF NOT EXISTS memetok_chain ON memecoin_latest_tokens (chain);
CREATE INDEX IF NOT EXISTS memetok_state ON memecoin_latest_tokens (listing_state);
CREATE INDEX IF NOT EXISTS memetok_sym_search ON memecoin_latest_tokens (lower(symbol));
CREATE INDEX IF NOT EXISTS memetok_name_search ON memecoin_latest_tokens (lower(name));
CREATE INDEX IF NOT EXISTS memetok_addr ON memecoin_latest_tokens (lower(token_address));
CREATE INDEX IF NOT EXISTS memetok_reasons ON memecoin_latest_tokens USING gin (discovery_reasons);
CREATE INDEX IF NOT EXISTS memetok_flags ON memecoin_latest_tokens (is_trending, is_boosted, is_new, is_pumpfun, is_migrated, is_takeover);
ALTER TABLE memecoin_latest_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memetok_read ON memecoin_latest_tokens;
CREATE POLICY memetok_read ON memecoin_latest_tokens FOR SELECT USING (auth.uid() IS NOT NULL);

-- ── Append-only snapshots (history) ──────────────────────────
CREATE TABLE IF NOT EXISTS memecoin_token_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain            text NOT NULL,
  token_address    text NOT NULL,
  symbol           text,
  price_usd        double precision,
  change_1h_pct    double precision,
  change_24h_pct   double precision,
  volume_24h_usd   double precision,
  liquidity_usd    double precision,
  fdv              double precision,
  market_cap       double precision,
  txns_24h         integer,
  momentum_score   double precision,
  risk_score       double precision,
  as_of            timestamptz NOT NULL DEFAULT now(),
  fetched_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memesnap_lookup ON memecoin_token_snapshots (chain, token_address, as_of DESC);
ALTER TABLE memecoin_token_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memesnap_read ON memecoin_token_snapshots;
CREATE POLICY memesnap_read ON memecoin_token_snapshots FOR SELECT USING (auth.uid() IS NOT NULL);

-- ── Provider response cache (service-role only) ──────────────
CREATE TABLE IF NOT EXISTS memecoin_response_cache (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,
  cache_key      text NOT NULL,
  endpoint       text NOT NULL,
  response_json  jsonb,
  status_code    integer,
  cache_status   text,
  expires_at     timestamptz NOT NULL,
  negative_cache boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, cache_key)
);
CREATE INDEX IF NOT EXISTS meme_respcache_expiry ON memecoin_response_cache (expires_at);
ALTER TABLE memecoin_response_cache ENABLE ROW LEVEL SECURITY;
-- Service-role only: no read policy.

-- ── API usage logs (super-admin read) ────────────────────────
CREATE TABLE IF NOT EXISTS memecoin_api_usage_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  provider          text NOT NULL,
  endpoint          text NOT NULL,
  chain             text,
  token_address     text,
  job_name          text,
  caller            text,
  cache_status      text,
  status_code       integer,
  duration_ms       integer,
  retry_count       integer,
  blocked_by_limit  boolean,
  error_message     text
);
CREATE INDEX IF NOT EXISTS meme_usage_created ON memecoin_api_usage_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS meme_usage_provider ON memecoin_api_usage_logs (provider, created_at DESC);
ALTER TABLE memecoin_api_usage_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meme_usage_superadmin_read ON memecoin_api_usage_logs;
CREATE POLICY meme_usage_superadmin_read ON memecoin_api_usage_logs
  FOR SELECT USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_super_admin = true));

INSERT INTO memecoin_providers (provider, name, base_url, provider_type)
VALUES
  ('dexscreener',  'DEX Screener',  'https://api.dexscreener.com',        'dex'),
  ('geckoterminal','GeckoTerminal',  'https://api.geckoterminal.com/api/v2','dex'),
  ('defillama',    'DefiLlama',      'https://coins.llama.fi',             'price'),
  ('jupiter',      'Jupiter',        'https://lite-api.jup.ag',            'solana'),
  ('pumpportal',   'PumpPortal',     'wss://pumpportal.fun/api/data',      'launchpad_ws'),
  ('birdeye',      'Birdeye',        'https://api.birdeye.so',             'enrichment')
ON CONFLICT (provider) DO NOTHING;

-- NOTE: retention/pruning scheduled in 182.
