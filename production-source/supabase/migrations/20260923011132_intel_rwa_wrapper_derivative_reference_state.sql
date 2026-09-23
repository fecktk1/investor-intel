-- CoinMarketCap lists derivative prices (issuer "NA (Derivatives)", market cap 0)
-- among an RWA asset's tokens. They are not wrappers anyone holds, and 5 of 41
-- were anchor members on 2026-09-23. rwa-wrapper-spread.ts now classifies them
-- as 'derivative_reference' (never in the anchor), so the state list gains it.
-- Applied BEFORE the capture code that writes it (MCP apply_migration, ledger
-- version 20260923011132).
ALTER TABLE public.intel_rwa_wrapper_tokens DROP CONSTRAINT intel_rwa_wrapper_tokens_wrapper_state_check;
ALTER TABLE public.intel_rwa_wrapper_tokens ADD CONSTRAINT intel_rwa_wrapper_tokens_wrapper_state_check
  CHECK (wrapper_state = ANY (ARRAY['liquid'::text, 'too_thin_to_anchor'::text, 'volume_not_reported'::text, 'no_price'::text,
    'unit_not_established'::text, 'accrues_in_price'::text, 'derivative_reference'::text]));
