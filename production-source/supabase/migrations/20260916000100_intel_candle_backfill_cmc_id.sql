-- ============================================================
-- Investor Intel — the candle backfill queue remembers the CoinMarketCap id it resolved
-- ============================================================
-- The lane derived an asset's CoinMarketCap id from the queue row's CATALOGUE provider: only a row whose
-- `source_provider` was already 'coinmarketcap' ever reached the paid rung. That is not how the rest of Investor Intel
-- resolves the identity — `marketCmcIdentity` in _shared/intel/market-asset-source.ts also maps a CoinGecko-sourced
-- row through its issuer identity and through the native-asset table — so the first live cohort run finished
-- xrpl:native:XRP as 'complete' with reason 'no_cmc_listing' and only Binance history from 2018, and marked
-- market:coingecko:tether and market:coingecko:usd-coin 'unavailable' although both have a CoinMarketCap listing.
--
-- The id is now resolved AT SEED TIME, from the catalogue row, by the same function the chart read uses, and stored on
-- the queue row. Storing it rather than re-deriving it per run means the queue records WHICH listing each stored year
-- was bought against, so a later identity change is visible instead of silently changing what an asset's archive
-- means. A row that genuinely resolves to nothing keeps a NULL `cmc_id` and its honest 'no_cmc_listing' reason.
--
-- Nothing else changes: no grant, no policy, no index, no retention. Existing rows keep NULL until the next seed pass
-- fills them in, and a NULL behaves exactly as today.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the check is added only when it is absent.
--
-- ROLLBACK
--   ALTER TABLE public.market_asset_candle_backfill DROP COLUMN cmc_id;
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: candle backfill cmc id

ALTER TABLE public.market_asset_candle_backfill ADD COLUMN IF NOT EXISTS cmc_id text;

-- A CoinMarketCap asset id is a positive integer with no leading zero, the same shape every other CMC surface
-- validates. An unresolvable identity is NULL, never an empty string standing in for one.
DO $cmc_id$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.market_asset_candle_backfill'::regclass
      AND conname = 'market_asset_candle_backfill_cmc_id'
  ) THEN
    ALTER TABLE public.market_asset_candle_backfill
      ADD CONSTRAINT market_asset_candle_backfill_cmc_id CHECK (cmc_id IS NULL OR cmc_id ~ '^[1-9][0-9]{0,9}$');
  END IF;
END $cmc_id$;

COMMENT ON COLUMN public.market_asset_candle_backfill.cmc_id IS
  'CoinMarketCap asset id resolved from the catalogue row at seed time (marketCmcIdentity), so a CoinGecko-sourced asset still reaches the paid OHLCV rung. NULL means the identity genuinely resolves to nothing.';
