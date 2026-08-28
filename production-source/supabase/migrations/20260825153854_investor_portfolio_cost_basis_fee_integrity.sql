-- Investor Intel portfolio accounting integrity:
-- retain closed positions and keep new manual rows canonically addressable.

ALTER TABLE investor_portfolio_holdings
  ADD COLUMN IF NOT EXISTS is_closed boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS iph_closed_positions
  ON investor_portfolio_holdings(portfolio_id, is_closed, updated_at DESC);

CREATE OR REPLACE FUNCTION public.set_investor_portfolio_txn_canonical_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.canonical_asset_key := public.canonical_asset_key(
    NEW.chain,
    NEW.asset_symbol,
    NEW.contract_address
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_investor_portfolio_txn_canonical_key
  ON investor_portfolio_transactions;
CREATE TRIGGER trg_investor_portfolio_txn_canonical_key
BEFORE INSERT OR UPDATE OF chain, asset_symbol, contract_address
ON investor_portfolio_transactions
FOR EACH ROW EXECUTE FUNCTION public.set_investor_portfolio_txn_canonical_key();

UPDATE investor_portfolio_transactions
SET canonical_asset_key = public.canonical_asset_key(chain, asset_symbol, contract_address)
WHERE chain IS NOT NULL
  AND canonical_asset_key IS NULL;
