-- ============================================================
-- Investor Intel: dividend-reinvestment multiplier on the RWA wrapper board
-- ============================================================
-- Some tokenised-stock wrappers reinvest the share's dividends INSIDE the token (Ondo Global Markets tokens, wrapped
-- xStocks), so one token is worth more than one share and its price drifts above the stock and above every wrapper
-- that pays dividends out. On 2026-09-23 SPYon sat +73 bp over the SPY Chainlink price and +101 bp over its sibling
-- median, almost all of it reinvested dividends (its own on-chain multiplier was 1.00947).
--
-- The six-hourly `rwa_wrappers` lane now divides such a wrapper's price by the multiplier its issuer publishes for that
-- token on chain, in effect when the wrapper prices were observed (supabase/functions/_shared/intel/
-- accrual-multiplier.ts; the Ondo mints' Token-2022 scaled-UI multiplier, one keyless Solana RPC request, zero
-- CoinMarketCap credits), before comparing it with its siblings or the stock. Where no sourced multiplier applies,
-- nothing is guessed: the wrapper keeps the existing 'accrues_in_price' state with an accrual gap, never a premium.
--
--   intel_rwa_wrapper_tokens   + accrual_* columns: the treatment ('adjusted' or 'not_adjusted'), why not adjusted,
--                                the multiplier, its source, its own on-chain effective time, where it was read, the
--                                per-share price (adjusted_price), and the UNADJUSTED premium and gap to the stock kept
--                                beside the adjusted ones (raw_premium_bps, underlying_ref_raw_bps).
--   intel_rwa_wrapper_assets   + accrual_adjusted_count.
--   intel_rwa_underlying_reference_observations
--                              capture_op may also be 'rwa_wrapper_accrual': the one-off recompute of the newest capture,
--                              which re-reads the stock reference because the anchor it is measured against moved.
--
-- ADDITIVE ONLY. Every new column is nullable with no default, so every existing reader and writer is unaffected and a
-- row written before this migration simply carries no adjustment. The existing accrual rule (an 'accrues_in_price'
-- wrapper never carries premium_bps or underlying_ref_bps) is unchanged and still enforced.
--
-- PRIVILEGES. Unchanged: service role only on all three tables.
--
-- ROLLBACK (manual):
--   ALTER TABLE public.intel_rwa_wrapper_tokens DROP CONSTRAINT intel_rwa_wrapper_tokens_accrual_multiplier,
--     DROP COLUMN accrual_treatment, DROP COLUMN accrual_reason, DROP COLUMN accrual_multiplier,
--     DROP COLUMN accrual_multiplier_source, DROP COLUMN accrual_multiplier_as_of, DROP COLUMN accrual_multiplier_network,
--     DROP COLUMN accrual_multiplier_address, DROP COLUMN accrual_multiplier_read_at, DROP COLUMN adjusted_price,
--     DROP COLUMN raw_premium_bps, DROP COLUMN underlying_ref_raw_bps;
--   ALTER TABLE public.intel_rwa_wrapper_assets DROP CONSTRAINT intel_rwa_wrapper_assets_accrual_adjusted_count,
--     DROP COLUMN accrual_adjusted_count;
--   and restore the capture_op CHECK to ('rwa_wrappers', 'rwa_wrapper_reference') once no 'rwa_wrapper_accrual' row
--   remains.

-- SECTION 1: each wrapper's dividend treatment

ALTER TABLE public.intel_rwa_wrapper_tokens
  ADD COLUMN IF NOT EXISTS accrual_treatment text,
  ADD COLUMN IF NOT EXISTS accrual_reason text,
  ADD COLUMN IF NOT EXISTS accrual_multiplier numeric,
  ADD COLUMN IF NOT EXISTS accrual_multiplier_source text,
  ADD COLUMN IF NOT EXISTS accrual_multiplier_as_of timestamptz,
  ADD COLUMN IF NOT EXISTS accrual_multiplier_network text,
  ADD COLUMN IF NOT EXISTS accrual_multiplier_address text,
  ADD COLUMN IF NOT EXISTS accrual_multiplier_read_at timestamptz,
  ADD COLUMN IF NOT EXISTS adjusted_price numeric,
  ADD COLUMN IF NOT EXISTS raw_premium_bps numeric,
  ADD COLUMN IF NOT EXISTS underlying_ref_raw_bps numeric;

ALTER TABLE public.intel_rwa_wrapper_tokens DROP CONSTRAINT IF EXISTS intel_rwa_wrapper_tokens_accrual_multiplier;
ALTER TABLE public.intel_rwa_wrapper_tokens ADD CONSTRAINT intel_rwa_wrapper_tokens_accrual_multiplier CHECK (
  (accrual_treatment IS NULL OR accrual_treatment IN ('adjusted', 'not_adjusted'))
  AND (accrual_multiplier_source IS NULL OR accrual_multiplier_source IN ('ondo_solana_scaled_ui'))
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

-- SECTION 2: the count on each asset row

ALTER TABLE public.intel_rwa_wrapper_assets
  ADD COLUMN IF NOT EXISTS accrual_adjusted_count integer;

ALTER TABLE public.intel_rwa_wrapper_assets DROP CONSTRAINT IF EXISTS intel_rwa_wrapper_assets_accrual_adjusted_count;
ALTER TABLE public.intel_rwa_wrapper_assets ADD CONSTRAINT intel_rwa_wrapper_assets_accrual_adjusted_count CHECK (
  accrual_adjusted_count IS NULL OR (accrual_adjusted_count >= 0 AND accrual_adjusted_count <= wrapper_count)
);

-- SECTION 3: the recompute op may write reference observations

ALTER TABLE public.intel_rwa_underlying_reference_observations
  DROP CONSTRAINT IF EXISTS intel_rwa_underlying_reference_observations_capture_op_check;
ALTER TABLE public.intel_rwa_underlying_reference_observations
  ADD CONSTRAINT intel_rwa_underlying_reference_observations_capture_op_check
  CHECK (capture_op IN ('rwa_wrappers', 'rwa_wrapper_reference', 'rwa_wrapper_accrual'));
