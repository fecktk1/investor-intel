-- Investor Intel: honest coverage columns on the RWA universe capture.
--
-- WHY. `asset_count` used to hold the LENGTH OF ONE PAGE. The rwaList capability
-- clamps `limit` to 250 and the provider paginates, so `stock` and `etf` both
-- read exactly 250 while their real totals are 4812 and 3126 (probed
-- 2026-09-20), and the derived `all` row read 504 against a real 7942. The
-- capture now stores the provider's own `data.total_size` in `asset_count`, which
-- means the value, volume and token figures beside it no longer cover the whole
-- type. Two columns record that honestly:
--
--   assets_scanned      how many rows the sums were actually computed over
--   assets_with_tokens  how many of those rows the provider marked has_tokens
--
-- `assets_with_tokens` replaces the issuer column on the surface. The list
-- endpoint publishes no issuer field at all, so `issuer_count` could only ever
-- read 0; the column is LEFT IN PLACE because the same aggregate is reused for
-- the quote and info endpoints, which do report issuers.
--
-- Idempotent: re-running adds nothing and drops nothing. Existing rows keep
-- NULL in both columns, which the read layer reports as unknown coverage rather
-- than as zero.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.intel_rwa_universe_snapshots
  ADD COLUMN IF NOT EXISTS assets_scanned integer,
  ADD COLUMN IF NOT EXISTS assets_with_tokens integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.intel_rwa_universe_snapshots'::regclass
      AND conname = 'intel_rwa_universe_snapshots_assets_scanned_check'
  ) THEN
    ALTER TABLE public.intel_rwa_universe_snapshots
      ADD CONSTRAINT intel_rwa_universe_snapshots_assets_scanned_check
      CHECK (assets_scanned IS NULL OR assets_scanned >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.intel_rwa_universe_snapshots'::regclass
      AND conname = 'intel_rwa_universe_snapshots_assets_with_tokens_check'
  ) THEN
    ALTER TABLE public.intel_rwa_universe_snapshots
      ADD CONSTRAINT intel_rwa_universe_snapshots_assets_with_tokens_check
      CHECK (assets_with_tokens IS NULL OR assets_with_tokens >= 0);
  END IF;

  -- A token count can never exceed the rows it was counted in. This is the
  -- constraint that would catch a future edit summing tokens over one page while
  -- recording a different scan width.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.intel_rwa_universe_snapshots'::regclass
      AND conname = 'intel_rwa_universe_snapshots_tokens_within_scan_check'
  ) THEN
    ALTER TABLE public.intel_rwa_universe_snapshots
      ADD CONSTRAINT intel_rwa_universe_snapshots_tokens_within_scan_check
      CHECK (assets_with_tokens IS NULL OR assets_scanned IS NULL OR assets_with_tokens <= assets_scanned);
  END IF;
END
$$;

COMMENT ON COLUMN public.intel_rwa_universe_snapshots.asset_count IS
  'Provider data.total_size for this asset type: the whole type, not the page read.';
COMMENT ON COLUMN public.intel_rwa_universe_snapshots.assets_scanned IS
  'Rows actually read this capture. total_market_value_usd, volume_24h_usd and assets_with_tokens cover only these rows.';
COMMENT ON COLUMN public.intel_rwa_universe_snapshots.assets_with_tokens IS
  'Rows within assets_scanned whose has_tokens was true. Replaces the issuer column, which the list endpoint cannot fill.';
COMMENT ON COLUMN public.intel_rwa_universe_snapshots.issuer_count IS
  'Distinct reported issuers. Always 0 from the list endpoint, which publishes no issuer field; filled only by the quote and info endpoints.';
COMMENT ON COLUMN public.intel_rwa_universe_snapshots.change_24h_pct IS
  'Provider-published 24h change. The list endpoint publishes none, so this is null; the read layer derives the 24h change of tokenised value from our own snapshots instead and labels it as our calculation.';
