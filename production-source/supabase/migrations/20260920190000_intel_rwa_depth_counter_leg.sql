-- ============================================================
-- Investor Intel: WHAT IS ON THE OTHER SIDE OF AN RWA POOL
-- ============================================================
-- Nullable columns on public.intel_rwa_depth_snapshots (created by 20260920151000). No table, no index rebuild, no
-- backfill, no data loss, and every existing row keeps every figure it already holds.
--
-- WHY. CoinMarketCap's `liqUsd` on a DEX pool values BOTH legs, so a pool whose other leg is a token nobody can value
-- reports a large USD figure that no seller could ever take out. The first production run of the depth lane, 2026-09-20,
-- put exactly that at the top of the board:
--
--   XAUt   deepest pool `XAUt / GOLDGR` on PancakeSwap v3 (Ethereum), $16,488,627 reported, $812 of 24-hour volume.
--          That one pool was 31 percent of XAUt's $52,814,963 headline.
--   SLVon  deepest pool `u / SLVon` on Uniswap v3 (Ethereum), $10,368,049 reported with ZERO 24-hour volume, against a
--          $25,546,251 token market cap, while its real `USDC / SLVon` pool holds $561,554.
--
-- The board's question is "where can this actually be sold". These columns hold the split that lets it answer honestly:
-- a headline built only from pools whose other leg is a major quote asset on that chain or another tokenised asset we
-- have captured, matched BY CONTRACT ADDRESS and never by symbol, and everything else reported separately in its own
-- clearly labelled group.
--
-- ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────────────────────────────────────────
--   * NO CHANGE TO AN EXISTING COLUMN. `total_liquidity_usd`, `deepest_*` and `pool_count` keep meaning exactly what
--     they have always meant: the PROVIDER's figures over every pool found. An agent comparing two days must not see a
--     column change shape underneath it. The counted figures are new columns beside them.
--   * NO BACKFILL. Rows captured before this change carry no pool leg ADDRESSES at all, only a `pair` label built from
--     two symbols, and a worthless token can call itself USDC. `pool_classification` is therefore NULL on those rows and
--     the read view says "counter legs not classified for this capture" rather than classifying from a symbol, which
--     would be the same defect in a new place. The next daily run classifies every token it reads.
--   * NO CLASS COLUMN PER POOL. The class lives on each element of the existing `pools` jsonb array, beside the leg it
--     was decided from, so a pool and its classification cannot be separated.
--   * NO DERIVED RATIO. Concentration and the exit sizes stay computed on read in capture-rwa-depth-read.ts, exactly as
--     20260920151000 set out: a stored ratio outlives the formula that made it.
--
-- IDEMPOTENT. Every statement is guarded (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before `ADD`), so a
-- second application is a no-op. NOT APPLIED by this change. Validated offline with pglast.
--
-- DEPLOY ORDER: this migration FIRST, then the `intel-capture` Edge Function (it writes these columns; a write to a
-- column that does not exist fails the whole upsert batch), then `intel-mcp` (its `rwa_liquidity_depth` tool selects
-- them; a select of a missing column is reported as `unavailable`, not as a missing table).
--
-- ROLLBACK
--   ALTER TABLE public.intel_rwa_depth_snapshots
--     DROP CONSTRAINT IF EXISTS intel_rwa_depth_counted_bounded,
--     DROP CONSTRAINT IF EXISTS intel_rwa_depth_counted_finite,
--     DROP COLUMN IF EXISTS pool_classification,
--     DROP COLUMN IF EXISTS recognised_pool_count,
--     DROP COLUMN IF EXISTS recognised_liquidity_pools,
--     DROP COLUMN IF EXISTS recognised_liquidity_usd,
--     DROP COLUMN IF EXISTS recognised_volume_24h_usd,
--     DROP COLUMN IF EXISTS unrecognised_pool_count,
--     DROP COLUMN IF EXISTS unrecognised_liquidity_usd,
--     DROP COLUMN IF EXISTS deepest_recognised_address,
--     DROP COLUMN IF EXISTS deepest_recognised_dex,
--     DROP COLUMN IF EXISTS deepest_recognised_chain,
--     DROP COLUMN IF EXISTS deepest_recognised_pair,
--     DROP COLUMN IF EXISTS deepest_recognised_liquidity_usd,
--     DROP COLUMN IF EXISTS deepest_recognised_volume_24h_usd,
--     DROP COLUMN IF EXISTS exit_liquidity_usd,
--     DROP COLUMN IF EXISTS exit_liquidity_pools;
--   -- then redeploy the previous intel-capture and intel-mcp.
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: the split

ALTER TABLE public.intel_rwa_depth_snapshots
  -- HOW the counter legs were decided. 'by_counter_leg_address' is the only value and is the only thing that makes the
  -- columns below readable; NULL means this capture predates the leg addresses and nothing below it was computed.
  ADD COLUMN IF NOT EXISTS pool_classification text
    CHECK (pool_classification IS NULL OR pool_classification = 'by_counter_leg_address'),

  -- COUNTED: pools whose other leg is a recognised quote asset on that chain, or another tokenised asset we captured.
  -- These are the only pools any headline figure, ranking or chart point is built from.
  ADD COLUMN IF NOT EXISTS recognised_pool_count integer
    CHECK (recognised_pool_count IS NULL OR recognised_pool_count >= 0),
  ADD COLUMN IF NOT EXISTS recognised_liquidity_pools integer
    CHECK (recognised_liquidity_pools IS NULL OR recognised_liquidity_pools >= 0),
  ADD COLUMN IF NOT EXISTS recognised_liquidity_usd numeric
    CHECK (recognised_liquidity_usd IS NULL OR recognised_liquidity_usd >= 0),
  ADD COLUMN IF NOT EXISTS recognised_volume_24h_usd numeric
    CHECK (recognised_volume_24h_usd IS NULL OR recognised_volume_24h_usd >= 0),

  -- NOT COUNTED: pools whose other leg is a token we cannot value. Reported per token in their own group, never summed
  -- into a headline. A count of 0 is a real and reassuring answer; NULL means no pool call was made for this token.
  ADD COLUMN IF NOT EXISTS unrecognised_pool_count integer
    CHECK (unrecognised_pool_count IS NULL OR unrecognised_pool_count >= 0),
  ADD COLUMN IF NOT EXISTS unrecognised_liquidity_usd numeric
    CHECK (unrecognised_liquidity_usd IS NULL OR unrecognised_liquidity_usd >= 0),

  -- The deepest COUNTED pool. This is what "deepest pool" means on the board from now on; `deepest_pool_*` is kept
  -- unchanged beside it as the provider's own deepest, which for XAUt on 2026-09-20 was the GOLDGR pool.
  ADD COLUMN IF NOT EXISTS deepest_recognised_address text
    CHECK (deepest_recognised_address IS NULL OR length(deepest_recognised_address) <= 200),
  ADD COLUMN IF NOT EXISTS deepest_recognised_dex text
    CHECK (deepest_recognised_dex IS NULL OR length(deepest_recognised_dex) <= 120),
  ADD COLUMN IF NOT EXISTS deepest_recognised_chain text
    CHECK (deepest_recognised_chain IS NULL OR deepest_recognised_chain IN ('ethereum','base','arbitrum','solana')),
  ADD COLUMN IF NOT EXISTS deepest_recognised_pair text
    CHECK (deepest_recognised_pair IS NULL OR length(deepest_recognised_pair) <= 100),
  ADD COLUMN IF NOT EXISTS deepest_recognised_liquidity_usd numeric
    CHECK (deepest_recognised_liquidity_usd IS NULL OR deepest_recognised_liquidity_usd >= 0),
  ADD COLUMN IF NOT EXISTS deepest_recognised_volume_24h_usd numeric
    CHECK (deepest_recognised_volume_24h_usd IS NULL OR deepest_recognised_volume_24h_usd >= 0),

  -- The QUOTE LEGS' OWN reported sizes, summed over the recognised-quote pools that reported one. It is the side of the
  -- pool a seller receives, so it is the closest figure in this data to "what could be taken out". CoinMarketCap leaves
  -- it at zero for many pools, so it is a FLOOR built from the pools that reported one, never a capacity, and
  -- `exit_liquidity_pools` says how many pools it came from so a reader can see how thin the evidence is.
  ADD COLUMN IF NOT EXISTS exit_liquidity_usd numeric
    CHECK (exit_liquidity_usd IS NULL OR exit_liquidity_usd >= 0),
  ADD COLUMN IF NOT EXISTS exit_liquidity_pools integer
    CHECK (exit_liquidity_pools IS NULL OR exit_liquidity_pools >= 0);

-- SECTION: what the split may not say

-- A counted subset cannot be larger than the whole, and the deepest counted pool cannot be deeper than the counted
-- total. Dropped first so a re-run replaces rather than duplicates.
ALTER TABLE public.intel_rwa_depth_snapshots DROP CONSTRAINT IF EXISTS intel_rwa_depth_counted_bounded;
ALTER TABLE public.intel_rwa_depth_snapshots ADD CONSTRAINT intel_rwa_depth_counted_bounded CHECK (
  (recognised_pool_count IS NULL OR pool_count IS NULL OR recognised_pool_count <= pool_count)
  AND (unrecognised_pool_count IS NULL OR pool_count IS NULL OR unrecognised_pool_count <= pool_count)
  AND (recognised_liquidity_pools IS NULL OR recognised_pool_count IS NULL OR recognised_liquidity_pools <= recognised_pool_count)
  AND (recognised_liquidity_usd IS NULL OR total_liquidity_usd IS NULL OR recognised_liquidity_usd <= total_liquidity_usd)
  AND (deepest_recognised_liquidity_usd IS NULL OR recognised_liquidity_usd IS NULL
       OR deepest_recognised_liquidity_usd <= recognised_liquidity_usd)
  AND (exit_liquidity_pools IS NULL OR recognised_pool_count IS NULL OR exit_liquidity_pools <= recognised_pool_count));

-- Same NaN and +/-Infinity refusal the table already applies to its other money columns: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass.
ALTER TABLE public.intel_rwa_depth_snapshots DROP CONSTRAINT IF EXISTS intel_rwa_depth_counted_finite;
ALTER TABLE public.intel_rwa_depth_snapshots ADD CONSTRAINT intel_rwa_depth_counted_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
  abs(recognised_liquidity_usd), abs(recognised_volume_24h_usd), abs(unrecognised_liquidity_usd),
  abs(deepest_recognised_liquidity_usd), abs(deepest_recognised_volume_24h_usd), abs(exit_liquidity_usd)]), true));

-- SECTION: ranking

-- The board ranks by the COUNTED total now, so the index that serves it ranks by the same column. The original
-- `intel_rwa_depth_recent_idx` on total_liquidity_usd is kept: the provider's own total is still selected and still
-- shown beside the counted one.
CREATE INDEX IF NOT EXISTS intel_rwa_depth_recognised_idx
  ON public.intel_rwa_depth_snapshots (snapshot_date DESC, recognised_liquidity_usd DESC NULLS LAST);
