-- Investor Intel: the provider's own platform identity and supply-side market
-- figures on every captured new listing.
--
-- WHY. `intel_new_listing_snapshots.chain` / `.contract_address` mean one narrow
-- thing and must keep meaning it: a VERIFIED DEX identity the inspection lane can
-- act on, on one of the four CMC DEX networks (ethereum, base, arbitrum, solana).
-- Everything else was dropped on the floor, so a listing on Arc, on Robinhood
-- Chain or on BNB Smart Chain stored a NULL chain and a NULL contract and the
-- board could only say "none reported" about an asset whose chain the provider
-- had told us plainly. Measured on the 2026-09-17 06:10 UTC page: 100 of 100
-- rows carry `platform.name`, while only a minority sit on a verified DEX chain.
--
-- The same page shows why one market cap column was never enough: 37 of 100 rows
-- carry a positive `quote.USD.market_cap`, while 100 of 100 carry a fully diluted
-- market cap and 82 a self-reported one. A row reading "not reported" when the
-- provider published two other measures of the same thing is our omission, not
-- the provider's.
--
-- So this migration adds, all nullable and all additive:
--   platform_name / platform_slug / platform_token_address
--        the provider's own `platform` object, verbatim and bounded. NOT a
--        verified identity: the inspection lane keeps reading chain/
--        contract_address and nothing here widens what it will inspect.
--   self_reported_market_cap / fully_diluted_market_cap / circulating_supply
--        the other two measures of size, plus the supply that explains why
--        `market_cap` is zero (an unreported circulating supply multiplies to 0).
--   cmc_rank
--        the provider's own rank for the asset.
--
-- NOTHING IS REMOVED OR REDEFINED. `chain`, `contract_address` and
-- `security_state` keep the exact semantics the due-diligence lane depends on.
--
-- Rollback:
--   ALTER TABLE public.intel_new_listing_snapshots
--     DROP COLUMN IF EXISTS platform_name,
--     DROP COLUMN IF EXISTS platform_slug,
--     DROP COLUMN IF EXISTS platform_token_address,
--     DROP COLUMN IF EXISTS self_reported_market_cap,
--     DROP COLUMN IF EXISTS fully_diluted_market_cap,
--     DROP COLUMN IF EXISTS cmc_rank,
--     DROP COLUMN IF EXISTS circulating_supply;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Every column nullable with no default, so this is a catalogue-only change on
-- an existing table: no rewrite, no backfill pass, no long lock.
ALTER TABLE public.intel_new_listing_snapshots
  ADD COLUMN IF NOT EXISTS platform_name text,
  ADD COLUMN IF NOT EXISTS platform_slug text,
  ADD COLUMN IF NOT EXISTS platform_token_address text,
  ADD COLUMN IF NOT EXISTS self_reported_market_cap numeric,
  ADD COLUMN IF NOT EXISTS fully_diluted_market_cap numeric,
  ADD COLUMN IF NOT EXISTS cmc_rank integer,
  ADD COLUMN IF NOT EXISTS circulating_supply numeric;

COMMENT ON COLUMN public.intel_new_listing_snapshots.platform_name IS
  'The provider''s own platform.name for the listing ("Arc", "Robinhood Chain", "BNB Smart Chain (BEP20)"). A reading, NOT a verified chain: only chain/contract_address name a chain the inspection lane will act on. NULL means the provider reported no platform, which is a native coin.';
COMMENT ON COLUMN public.intel_new_listing_snapshots.platform_slug IS
  'The provider''s own platform.slug ("arc-token", "robinhood-placeholder", "bnb"). Machine key for the platform name beside it.';
COMMENT ON COLUMN public.intel_new_listing_snapshots.platform_token_address IS
  'The provider''s own platform.token_address, stored verbatim and NOT canonicalised. contract_address holds the canonical form and only for a verified DEX chain; this is the address as reported, on any chain.';
COMMENT ON COLUMN public.intel_new_listing_snapshots.self_reported_market_cap IS
  'The provider''s self_reported_market_cap: a figure the project supplied, not one the provider computed. Shown labelled as self-reported and never blended with market_cap.';
COMMENT ON COLUMN public.intel_new_listing_snapshots.fully_diluted_market_cap IS
  'quote.USD.fully_diluted_market_cap: price times TOTAL supply. The honest fallback when market_cap is zero because no circulating supply is reported, and always shown labelled as FDV.';
COMMENT ON COLUMN public.intel_new_listing_snapshots.cmc_rank IS
  'The provider''s own rank for the asset at this capture. NULL is unranked, never a zero.';
COMMENT ON COLUMN public.intel_new_listing_snapshots.circulating_supply IS
  'The provider''s circulating_supply at this capture. A zero here is why market_cap is zero, and is a reading rather than an absence.';

-- ── One-off backfill from the newest cached listings page ────────────────────
--
-- The response cache holds exactly one `/v1/cryptocurrency/listings/new` body at
-- a time, so this can only reach assets that page still carries (290 of the 300
-- stored rows on 2026-09-17). Everything it does not reach fills at the next
-- 06:10 UTC capture, which is why nothing below is required for correctness.
--
-- TWO STATEMENTS, ON PURPOSE. The platform identity is a property of the asset
-- and is true of every snapshot of it. The market figures are DATED READINGS,
-- and writing today's rank or FDV onto a snapshot taken three days ago would
-- invent a measurement nobody made, so those are filled only on the snapshot day
-- the cached page itself belongs to.
--
-- Both are guarded on the target column still being NULL, so re-running this
-- migration writes nothing and a later real capture is never overwritten.

WITH latest AS (
  SELECT response_json
    FROM public.market_data_response_cache
   WHERE provider = 'coinmarketcap'
     AND endpoint = '/v1/cryptocurrency/listings/new'
     AND jsonb_typeof(response_json -> 'data') = 'array'
   ORDER BY COALESCE(fetched_at, observed_at, created_at) DESC
   LIMIT 1
), page AS (
  SELECT jsonb_array_elements(response_json -> 'data') AS entry FROM latest
), ident AS (
  -- DISTINCT ON: a provider page that repeated an id would otherwise make
  -- UPDATE ... FROM pick a row at random.
  SELECT DISTINCT ON (entry ->> 'id')
         entry ->> 'id'                                        AS provider_id,
         left(entry -> 'platform' ->> 'name', 120)             AS platform_name,
         left(entry -> 'platform' ->> 'slug', 120)             AS platform_slug,
         left(entry -> 'platform' ->> 'token_address', 200)    AS platform_token_address
    FROM page
   WHERE entry ->> 'id' IS NOT NULL
     AND jsonb_typeof(entry -> 'platform') = 'object'
)
UPDATE public.intel_new_listing_snapshots s
   SET platform_name          = ident.platform_name,
       platform_slug          = ident.platform_slug,
       platform_token_address = ident.platform_token_address
  FROM ident
 WHERE s.provider = 'coinmarketcap'
   AND s.provider_id = ident.provider_id
   AND s.platform_name IS NULL
   AND ident.platform_name IS NOT NULL;

WITH latest AS (
  SELECT response_json,
         (COALESCE(observed_at, fetched_at, created_at) AT TIME ZONE 'UTC')::date AS page_date
    FROM public.market_data_response_cache
   WHERE provider = 'coinmarketcap'
     AND endpoint = '/v1/cryptocurrency/listings/new'
     AND jsonb_typeof(response_json -> 'data') = 'array'
   ORDER BY COALESCE(fetched_at, observed_at, created_at) DESC
   LIMIT 1
), page AS (
  SELECT jsonb_array_elements(response_json -> 'data') AS entry, page_date FROM latest
), figures AS (
  -- Every cast is gated on the value actually being a JSON number, so a provider
  -- string in a numeric field leaves a NULL instead of aborting the migration.
  SELECT DISTINCT ON (entry ->> 'id')
         entry ->> 'id' AS provider_id,
         page_date,
         CASE WHEN jsonb_typeof(entry -> 'self_reported_market_cap') = 'number'
              THEN (entry ->> 'self_reported_market_cap')::numeric END AS self_reported_market_cap,
         CASE WHEN jsonb_typeof(entry -> 'quote' -> 'USD' -> 'fully_diluted_market_cap') = 'number'
              THEN (entry -> 'quote' -> 'USD' ->> 'fully_diluted_market_cap')::numeric END AS fully_diluted_market_cap,
         CASE WHEN jsonb_typeof(entry -> 'cmc_rank') = 'number'
              THEN (entry ->> 'cmc_rank')::numeric::integer END AS cmc_rank,
         CASE WHEN jsonb_typeof(entry -> 'circulating_supply') = 'number'
              THEN (entry ->> 'circulating_supply')::numeric END AS circulating_supply
    FROM page
   WHERE entry ->> 'id' IS NOT NULL
)
UPDATE public.intel_new_listing_snapshots s
   SET self_reported_market_cap = figures.self_reported_market_cap,
       fully_diluted_market_cap = figures.fully_diluted_market_cap,
       cmc_rank                 = figures.cmc_rank,
       circulating_supply       = figures.circulating_supply
  FROM figures
 WHERE s.provider = 'coinmarketcap'
   AND s.provider_id = figures.provider_id
   AND s.snapshot_date = figures.page_date
   AND s.cmc_rank IS NULL
   AND s.fully_diluted_market_cap IS NULL;

COMMIT;
