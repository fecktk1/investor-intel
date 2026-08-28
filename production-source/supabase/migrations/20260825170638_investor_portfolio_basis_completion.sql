-- Complete portfolio accounting provenance without changing existing ownership
-- or RLS. Applied as a targeted migration only; never via broad db push.

ALTER TABLE public.investor_portfolio_tx_line_items
  ADD COLUMN IF NOT EXISTS price_source_at_tx text;

COMMENT ON COLUMN public.investor_portfolio_tx_line_items.price_source_at_tx IS
  'Historical cost-basis price provenance: provider historical, stable peg, paired-leg implied, current-price estimate, or zero-value unpriced acquisition.';

UPDATE public.investor_portfolio_tx_line_items
SET price_source_at_tx = 'legacy_provider_price'
WHERE price_usd_at_tx IS NOT NULL
  AND price_source_at_tx IS NULL;

ALTER TABLE public.investor_portfolio_holdings
  DROP CONSTRAINT IF EXISTS investor_portfolio_holdings_cost_basis_status_check;

ALTER TABLE public.investor_portfolio_holdings
  ADD CONSTRAINT investor_portfolio_holdings_cost_basis_status_check
  CHECK (cost_basis_status IS NULL OR cost_basis_status IN (
    'known','estimated','partial','incomplete','unknown','manual_override','none'
  ));

COMMENT ON COLUMN public.investor_portfolio_holdings.cost_basis_status IS
  'known=provider or transaction-derived; estimated=explicit reconciled fallback; manual_override=user supplied; incomplete/unknown are legacy/error states that backfill must eliminate.';
