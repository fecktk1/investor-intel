-- ============================================================
-- 186: Investor Intel — grouped transactions + line items
-- ============================================================
-- The flat investor_portfolio_transactions (171) stays the SOURCE OF TRUTH for
-- manual/CSV entries and the per-leg cost-basis ledger. These two NEW tables are
-- the synced activity feed: one header per signature/hash, with per-asset legs.
--
-- NO DOUBLE-COUNTING: a manual entry may also get a display-mirror header here so
-- it shows in the unified feed (is_display_mirror=true, mirror_of -> flat row);
-- the mirror is EXCLUDED from cost-basis input. Cost basis reads exactly two
-- non-overlapping sets: synced line items (non-manual sources) + flat manual rows.
--
-- Per-user RLS (org_id + user_id), JOIN-free via denormalized columns (171 model).
-- ============================================================

-- ── Grouped transaction header ───────────────────────────────
CREATE TABLE IF NOT EXISTS investor_portfolio_tx (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id)               ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  portfolio_id       uuid NOT NULL REFERENCES investor_portfolios(id) ON DELETE CASCADE,
  source_id          uuid NOT NULL REFERENCES investor_portfolio_sources(id) ON DELETE CASCADE,
  chain              text NOT NULL,
  tx_hash            text,                      -- EVM
  signature          text,                      -- Solana
  block_time         timestamptz,
  block_number       bigint,
  slot               bigint,
  type               text NOT NULL DEFAULT 'unknown' CHECK (type IN (
    'transfer_in','transfer_out','swap','buy','sell','airdrop','mint','burn',
    'stake','unstake','reward','fee','bridge','lp_add','lp_remove','approval',
    'wrap','unwrap','nft','contract','unknown')),
  subtype            text,                      -- 'jupiter'|'raydium'|'erc20_approve'|'sol_wrap'|...
  direction          text CHECK (direction IS NULL OR direction IN ('in','out','self','neutral')),
  title              text,
  summary            text,
  protocol           text,                      -- 'Jupiter'|'Uniswap V3'|...
  counterparty       text,
  status             text NOT NULL DEFAULT 'success' CHECK (status IN ('success','failed','pending')),
  confidence         double precision,
  classification_status text NOT NULL DEFAULT 'inferred'
    CHECK (classification_status IN ('confirmed','inferred','unclassified','user_corrected')),
  original_type      text,                      -- IMMUTABLE: what the classifier first produced
  fee_asset          text,
  fee_amount         numeric,
  fee_usd            double precision,
  provider           text NOT NULL DEFAULT 'unknown',
  provider_network   text,
  is_display_mirror  boolean NOT NULL DEFAULT false,   -- true => a manual entry mirrored for the feed; NOT a cost-basis input
  mirror_of          uuid REFERENCES investor_portfolio_transactions(id) ON DELETE CASCADE,
  raw                jsonb NOT NULL DEFAULT '{}',       -- provider response DATA only (no urls/keys)
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- DEDUPE: one grouped row per signature/hash per source. COALESCE(...,id::text)
-- keeps the index total (a row with neither hash nor sig never collides).
CREATE UNIQUE INDEX IF NOT EXISTS iptx_dedupe
  ON investor_portfolio_tx (portfolio_id, source_id, chain, COALESCE(tx_hash, signature, id::text));
CREATE INDEX IF NOT EXISTS iptx_feed  ON investor_portfolio_tx(portfolio_id, block_time DESC);
CREATE INDEX IF NOT EXISTS iptx_owner ON investor_portfolio_tx(org_id, user_id);
CREATE INDEX IF NOT EXISTS iptx_mirror ON investor_portfolio_tx(mirror_of) WHERE mirror_of IS NOT NULL;

-- ── Line items (per-asset legs) ──────────────────────────────
CREATE TABLE IF NOT EXISTS investor_portfolio_tx_line_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id)               ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  portfolio_id       uuid NOT NULL REFERENCES investor_portfolios(id) ON DELETE CASCADE,
  tx_id              uuid NOT NULL REFERENCES investor_portfolio_tx(id) ON DELETE CASCADE,
  leg_index          integer NOT NULL DEFAULT 0,
  canonical_asset_key text NOT NULL,
  chain              text NOT NULL,
  mint_or_contract   text,                      -- mint / contract / null (native)
  symbol             text,
  name               text,
  decimals           integer,
  direction          text CHECK (direction IN ('in','out')),
  amount             numeric,                   -- ui-amount (decimal-adjusted)
  amount_raw         text,                      -- raw lossless string (Helius amount / Etherscan value)
  price_usd_at_tx    double precision,          -- NULL unless deterministically known (never invented)
  value_usd_at_tx    double precision,
  logo_url           text,
  verified           boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS iptli_tx    ON investor_portfolio_tx_line_items(tx_id);
CREATE INDEX IF NOT EXISTS iptli_asset ON investor_portfolio_tx_line_items(portfolio_id, canonical_asset_key);
CREATE UNIQUE INDEX IF NOT EXISTS iptli_dedupe
  ON investor_portfolio_tx_line_items (tx_id, canonical_asset_key, direction, leg_index);

-- ── Link flat synced rows back to their group (nullable; manual rows stay NULL) ──
ALTER TABLE investor_portfolio_transactions
  ADD COLUMN IF NOT EXISTS tx_id uuid REFERENCES investor_portfolio_tx(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS canonical_asset_key text;

-- ── Extend the flat transaction_type vocab (drop + re-add the column CHECK) ──
ALTER TABLE investor_portfolio_transactions
  DROP CONSTRAINT IF EXISTS investor_portfolio_transactions_transaction_type_check;
ALTER TABLE investor_portfolio_transactions
  ADD CONSTRAINT investor_portfolio_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'buy','sell','transfer_in','transfer_out','swap','fee','airdrop','staking_reward',
    'deposit','withdrawal','stake','unstake','reward','bridge','lp_add','lp_remove',
    'approval','wrap','unwrap','mint','burn','nft','contract','unknown'));

-- ── updated_at trigger ───────────────────────────────────────
DROP TRIGGER IF EXISTS trg_investor_portfolio_tx_updated_at ON investor_portfolio_tx;
CREATE TRIGGER trg_investor_portfolio_tx_updated_at BEFORE UPDATE ON investor_portfolio_tx
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Per-user RLS (both new tables) ───────────────────────────
ALTER TABLE investor_portfolio_tx           ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_portfolio_tx_line_items ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text; prefix text;
BEGIN
  FOREACH t IN ARRAY ARRAY['investor_portfolio_tx','investor_portfolio_tx_line_items'] LOOP
    prefix := CASE t WHEN 'investor_portfolio_tx' THEN 'iptx' ELSE 'iptli' END;
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
