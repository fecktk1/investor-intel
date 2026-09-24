-- ============================================================
-- Investor Intel: xStocks multipliers on the RWA wrapper board
-- ============================================================
-- Follow-up to 20260923220000_intel_rwa_wrapper_accrual_multiplier.sql. The six-hourly `rwa_wrappers` lane now also
-- reads the xStocks multiplier from each xStock's Solana mint (Token-2022 scaled-UI extension, the same keyless
-- batched request as the Ondo mints; supabase/functions/_shared/intel/accrual-multiplier.ts):
--
--   * a WRAPPED xStock (an ERC-4626 vault whose convertToAssets rate is exactly that multiplier) is divided by it,
--     so its row is 'adjusted' with accrual_multiplier_source 'xstocks_solana_scaled_ui';
--   * an xStock whose multiplier is exactly 1 is per share on every venue and is recorded as 'adjusted' by 1 with the
--     same source;
--   * an xStock whose multiplier is above 1 is NOT divided: its CoinMarketCap quote blends per-share venues with
--     on-chain pools that price one raw token (which includes the multiplier), so it is 'not_adjusted' with
--     accrual_reason 'quote_unit_mixed', an accrual gap, and no premium. That path needs no schema change.
--
-- The only change: the CHECK that lists the allowed multiplier sources gains 'xstocks_solana_scaled_ui'. Every other
-- clause of the constraint is restated unchanged, so existing rows validate exactly as before.
--
-- PRIVILEGES. Unchanged: service role only.
--
-- ROLLBACK (manual): re-run SECTION 1 of 20260923220000_intel_rwa_wrapper_accrual_multiplier.sql once no row carries
--   accrual_multiplier_source 'xstocks_solana_scaled_ui' (UPDATE those rows through the one-off `rwa_wrapper_accrual`
--   op of an earlier build, or delete the affected capture).

ALTER TABLE public.intel_rwa_wrapper_tokens DROP CONSTRAINT IF EXISTS intel_rwa_wrapper_tokens_accrual_multiplier;
ALTER TABLE public.intel_rwa_wrapper_tokens ADD CONSTRAINT intel_rwa_wrapper_tokens_accrual_multiplier CHECK (
  (accrual_treatment IS NULL OR accrual_treatment IN ('adjusted', 'not_adjusted'))
  AND (accrual_multiplier_source IS NULL OR accrual_multiplier_source IN ('ondo_solana_scaled_ui', 'xstocks_solana_scaled_ui'))
  AND (accrual_multiplier_network IS NULL OR accrual_multiplier_network IN ('solana'))
  AND (accrual_reason IS NULL OR length(accrual_reason) BETWEEN 1 AND 120)
  AND (accrual_multiplier_address IS NULL OR accrual_multiplier_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  -- The same band the reader refuses outside of: room for a 10:1 split, nothing that is not a published factor.
  AND (accrual_multiplier IS NULL OR (accrual_multiplier >= 0.01 AND accrual_multiplier <= 100))
  AND (adjusted_price IS NULL OR (adjusted_price > 0 AND adjusted_price < 1e12))
  -- Nothing about a dividend treatment exists on a wrapper that has none.
  AND (accrual_treatment IS NOT NULL OR (accrual_reason IS NULL AND accrual_multiplier IS NULL
       AND accrual_multiplier_source IS NULL AND accrual_multiplier_as_of IS NULL AND accrual_multiplier_network IS NULL
       AND accrual_multiplier_address IS NULL AND accrual_multiplier_read_at IS NULL AND adjusted_price IS NULL
       AND raw_premium_bps IS NULL AND underlying_ref_raw_bps IS NULL))
  -- ADJUSTED: always the multiplier and its source, never a reason not to.
  AND (accrual_treatment IS DISTINCT FROM 'adjusted' OR (accrual_multiplier IS NOT NULL
       AND accrual_multiplier_source IS NOT NULL AND accrual_reason IS NULL))
  -- NOT ADJUSTED: always the reason; never a multiplier (one that did not apply must not be readable as one that did),
  -- never a per-share price and never a premium of any kind. It is an accrual, or it has no comparable price at all.
  AND (accrual_treatment IS DISTINCT FROM 'not_adjusted' OR (accrual_reason IS NOT NULL AND accrual_multiplier IS NULL
       AND accrual_multiplier_source IS NULL AND adjusted_price IS NULL AND raw_premium_bps IS NULL AND premium_bps IS NULL
       AND wrapper_state IN ('accrues_in_price', 'no_price', 'unit_not_established')))
  -- A per-share price and an unadjusted premium exist only where a multiplier was applied.
  AND (adjusted_price IS NULL OR accrual_treatment = 'adjusted')
  AND (raw_premium_bps IS NULL OR (accrual_treatment = 'adjusted' AND premium_bps IS NOT NULL))
  -- The unadjusted gap to the stock sits only beside an observed reference.
  AND (underlying_ref_raw_bps IS NULL OR underlying_ref_price IS NOT NULL)
  AND coalesce(1e30 >= ALL (ARRAY[abs(adjusted_price), abs(raw_premium_bps), abs(underlying_ref_raw_bps)]), true)
);
