-- ============================================================
-- Investor Intel: tokenised-asset on-chain DEPTH and CROSS-CHAIN DEPLOYMENT RESOLUTION
-- ============================================================
-- Two service-role-only tables behind the `rwa_depth` and `rwa_token_depth` read views of the `intel-capture` Edge
-- Function, plus one schedule policy row and one daily cron job.
--
-- WHY. "Is this wrapper too thin to sell?" is the question the RWA track cannot answer. The endpoint built for it,
-- `/v5/real-world-assets/market-pairs/list`, is GROWTH tier: on this Startup key it is refused 1006, it is registered
-- `tier:'growth'` in supabase/functions/_shared/market-assets/cmc-capabilities.ts and it is never called. Every entry
-- that reaches for it falls back to 24-hour volume, which is turnover and says nothing about the size a holder could
-- clear. The DEX family IS on Startup and is already in production here (`/v1/dex/token/pools` and
-- `/v1/dex/holders/count`, probed on the owner's key 2026-09-12), so the answer is built from deployment resolution
-- plus pool reads instead.
--
--   intel_rwa_token_deployments   WHERE a tokenised asset lives. One row per token per (platform, contract), resolved
--                                 from `market_assets.facts.deployments` (already written by the daily metadata pass),
--                                 from a bounded `/v2/cryptocurrency/info` call, or from the dated alias map. The
--                                 address is stored VERBATIM; only an address on a chain the platform can validate
--                                 also gets a canonical `dex_address`, and `readable` says which rows the pool lane
--                                 can act on. This table is what makes "no pool found" printable: it names the chains.
--
--   intel_rwa_depth_snapshots     WHAT WAS FOUND THERE. One row per token per capture day: the pools, their reported
--                                 liquidity and 24-hour volume, the deepest pool and its venue and pair, the holder
--                                 count where the endpoint gave one, and a `depth_state` that never collapses "we
--                                 looked and found nothing" into "we could not look".
--
-- ── WHAT THE SCHEMA ENFORCES, NOT MERELY THE LANE ────────────────────────────────────────────────────────────────
--   * NO DERIVED FIGURE IS STORED. Concentration (the deepest pool's share of the liquidity found) and the
--     one-and-five-percent "size relative to the deepest pool" readings are OURS, are computed in
--     capture-rwa-depth-read.ts on every read and are labelled there as our calculation with their method stated.
--     There is deliberately no column for either: a stored ratio outlives the formula that made it.
--   * A DEPTH CLAIM NEEDS A POOL. `intel_rwa_depth_pools_read_has_pools` refuses a row that says `pools_read` with no
--     pool, so the one state that means "there is a depth figure" cannot exist without one.
--   * "ISSUER REDEMPTION ONLY" NEEDS EVIDENCE. `intel_rwa_depth_redemption_evidenced` refuses that state without a
--     `restriction_state` carried from intel_rwa_token_restrictions, which is read from VERIFIED CONTRACT SOURCE. The
--     absence of a pool is never by itself allowed to become a claim about how an asset is sold.
--   * READABLE IS NOT AN OPINION. `intel_rwa_deployments_readable_matches` ties `readable` to `dex_platform`, and
--     `dex_platform` is restricted to the four chains this plan has verified DEX evidence for. A row cannot claim the
--     pool lane can reach it when it names no such chain.
--   * ZERO IS A REAL ANSWER. A holder count of 0, a liquidity of 0 and a pool count of 0 are all stored as given.
--     NULL means "not read", and the two are never mixed: `pool_count` is NULL for a token no pool call was made for.
--   * A ROW CANNOT EXIST WITHOUT ITS SCOPE. `scope` is NOT NULL with a minimum length, exactly as
--     intel_rwa_issuer_risk_signals.scope is, because a liquidity figure shown without "what this does not mean"
--     invites a reader to treat it as an executable quote.
--   * TWO SIZES, NEVER BLENDED. `underlying_value_usd` is the whole tokenised float of the real-world asset this token
--     wraps, from the RWA payload. `token_market_cap` is THIS token's market cap from our own catalogue. They are
--     different measurements from different endpoints and there is no column holding a ratio of them.
--   * ONE CLOCK, NAMED. `captured_at` is when WE asked. CoinMarketCap publishes no observation time for a pool
--     liquidity figure (see cmcObservedAt: every `dex*` capability returns null), so there is no column that could
--     pretend otherwise.
--
-- Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass. Copied from 20260916150000.
--
-- ── SCHEDULE POLICY ROW AND WHAT A RUN COSTS ─────────────────────────────────────────────────────────────────────
--   ('coinmarketcap', 'rwa_depth', 86400, true, 'startup', 87, '<reason>')
--   provider 'coinmarketcap'  so `loadSchedulePolicy` in capture-jobs.ts picks the row up with the other CMC lanes and
--                             the cadence calibrator can stretch it. Setting enabled = false stops the lane.
--   cadence_seconds 86400     daily. The lane ALSO carries 86400 as its own fallback (LANE_CADENCE in
--                             capture-rwa-depth.ts), because `schedulePolicy` defaults an unknown feature to one hour
--                             and one hour would mean 87 credits an hour.
--   min_plan 'startup'        `/v1/dex/token/pools` and `/v1/dex/holders/count` are Startup capabilities. Below
--                             Startup the lane skips itself with `plan_below_startup` and spends nothing to find out.
--   max_credits 87            the PER-RUN ceiling, which is also the daily ceiling at this cadence:
--                               6   `rwaList`, one per asset type, with params IDENTICAL to the hourly `rwa` universe
--                                   lane's, so the shared transport answers from ITS cache for 0 CREDITS whenever
--                                   that lane ran inside the hour. 6 is the worst case, not the expected one.
--                               1   `/v2/cryptocurrency/info`, up to 50 ids in one call, only for tokens whose
--                                   deployments `market_assets.facts` does not already hold.
--                              60   `/v1/dex/token/pools`, one per readable deployment (POOL_CALLS_PER_RUN).
--                              20   `/v1/dex/holders/count`, only for the deepest tokens (HOLDER_CALLS_PER_RUN).
--                             Typical measured cost is therefore ~81 credits a day, and a token whose deployment set
--                             is unchanged and whose depth was already read today is skipped, so a retried or resumed
--                             run walks forward instead of paying twice.
--
-- ── SCHEDULE ────────────────────────────────────────────────────────────────────────────────────────────────────
-- Minute 34 of hour 3 UTC. Checked against cron.job on 2026-09-20: nothing else is scheduled at 34 3, the nearest
-- neighbours are `cron-history-prune` at 30 3 and `market-asset-logo-verify-nightly` at 35 3, and both post to other
-- functions. Hour 3 is after the nightly `market-assets-refresh-deep` passes have written the day's
-- `facts.deployments`, which is the zero-credit source this lane resolves deployments from. The constant
-- RWA_DEPTH_CAPTURE_SCHEDULE in capture-rwa-depth.ts states the same job name and cron string and a Deno test reads
-- THIS FILE and fails if the two disagree.
--
-- Retention: 400 days on the depth snapshots, PATCHED into the live definition of app_private.intel_capture_retention
-- with the technique from 20260916150000 rather than restated, so the blocks every earlier lane added are preserved.
-- The DEPLOYMENT table is NOT pruned: it is upserted one row per token per contract, it does not grow with time, and
-- it is what lets an old depth row still name the chains it was talking about.
--
-- APPLY ONCE. This file is NOT idempotent: the two CREATE TABLE statements and their indexes are unguarded, so a
-- second application fails on `intel_rwa_token_deployments` already existing. The policy row, the cron job and the
-- retention splice are each separately re-runnable. NOT APPLIED by this change. Validated offline with pglast.
--
-- ROLLBACK
--   SELECT cron.unschedule('intel-capture-rwa-depth-daily');
--   -- stop the lane, keep the data:
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'coinmarketcap' AND feature = 'rwa_depth';
--   -- drop the data too:
--   DROP TABLE public.intel_rwa_depth_snapshots;
--   DROP TABLE public.intel_rwa_token_deployments;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature = 'rwa_depth';
--   -- then restore app_private.intel_capture_retention from its newest prior definition, otherwise the nightly job
--   -- errors on its next run against the dropped table.
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: where a tokenised asset lives

-- 1. One deployment. `token_key` is the join key for the whole lane: 'cmc:<crypto_id>' when CoinMarketCap names the
-- token (which is what the asset page looks up), and 'contract:<chain>:<address>' for a contract the dated alias map
-- asserts an issuer for and that has no CoinMarketCap catalogue row at all (checked 2026-09-20: USTB, BUIDL and OUSG
-- have none). A pinned contract is still an asset a reader may hold, so it is read rather than dropped for lacking a
-- provider id.
CREATE TABLE public.intel_rwa_token_deployments (
  provider text NOT NULL DEFAULT 'coinmarketcap' CHECK (provider = 'coinmarketcap'),
  token_key text NOT NULL CHECK (token_key ~ '^(cmc:[1-9][0-9]{0,11}|contract:(eip155:[1-9][0-9]{0,9}:0x[0-9a-f]{40}|solana:[1-9A-HJ-NP-Za-km-z]{32,44}))$'),
  -- The platform AS COINMARKETCAP NAMES IT, lower-cased for the key. Deliberately NOT restricted to a chain list: XDC
  -- Network, HyperEVM, Sui and BNB Chain are all real deployments of real tokenised assets, and refusing to store them
  -- would make the board claim a token lives in fewer places than it does.
  platform_key text NOT NULL CHECK (length(platform_key) BETWEEN 1 AND 120),
  platform_label text CHECK (platform_label IS NULL OR length(platform_label) <= 120),
  -- The app's own chain id, when the app defines that chain. NULL for a platform the app has no chain for.
  chain text CHECK (chain IS NULL OR length(chain) <= 120),
  -- VERBATIM, exactly as the provider published it. Case is NOT normalised: a Sui type string and a Solana mint are
  -- both case significant, and lower-casing an address on a chain nobody validated would be a claim about its shape.
  contract_address text NOT NULL CHECK (length(contract_address) BETWEEN 1 AND 240),
  -- The verified CoinMarketCap DEX platform, when this deployment is on one of the four chains this plan publishes DEX
  -- data for. It is the ONLY thing that makes a deployment readable by the pool lane.
  dex_platform text CHECK (dex_platform IS NULL OR dex_platform IN ('ethereum','base','arbitrum','solana')),
  -- The canonical address for that platform: lower-case for EVM, exact base58 for Solana, as cmcDexCanonicalAddress
  -- defines it everywhere else in this repository.
  dex_address text CHECK (dex_address IS NULL OR dex_address ~ '^0x[0-9a-f]{40}$' OR dex_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  readable boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('catalogue_facts','provider_info','alias_map')),
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, token_key, platform_key, contract_address),
  -- `readable` is not an opinion: it is true exactly when a verified DEX platform was resolved, and that platform
  -- always brings its canonical address with it.
  CONSTRAINT intel_rwa_deployments_readable_matches CHECK (
    readable = (dex_platform IS NOT NULL)
    AND (dex_platform IS NULL) = (dex_address IS NULL)),
  -- A Solana deployment's canonical address is base58; every other verified chain is EVM hex.
  CONSTRAINT intel_rwa_deployments_address_shape CHECK (
    dex_platform IS NULL
    OR (dex_platform = 'solana' AND dex_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
    OR (dex_platform <> 'solana' AND dex_address ~ '^0x[0-9a-f]{40}$'))
);
CREATE INDEX intel_rwa_deployments_token_idx ON public.intel_rwa_token_deployments (token_key, readable DESC);
CREATE INDEX intel_rwa_deployments_readable_idx ON public.intel_rwa_token_deployments (dex_platform, dex_address) WHERE readable;
ALTER TABLE public.intel_rwa_token_deployments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_token_deployments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_token_deployments TO service_role;

-- SECTION: what was found there

-- 2. One token's depth on one capture day. `depth_state` is the whole honesty mechanism of this table and is the
-- reason there is no nullable "liquidity" column standing in for six different situations:
--   pools_read              at least one pool was found. There IS a depth figure.
--   no_pool_on_read_chains  the chains in `chains_read` were read and no pool was found. This is the only state that
--                           is a liquidity finding, and it is unreadable without `chains_read` beside it.
--   issuer_redemption_only  as above, AND the verified contract source shows permissioned transfers. Requires
--                           `restriction_state` (see the constraint below).
--   chain_not_covered       the token has deployments, none of them on a chain CoinMarketCap publishes DEX data for.
--   no_deployment_known     no contract was resolved for it at all.
--   provider_unavailable    every pool call for it failed. Unknown, not thin.
--   budget_deferred         the per-run ceiling did not reach it. Pending, not thin.
CREATE TABLE public.intel_rwa_depth_snapshots (
  provider text NOT NULL DEFAULT 'coinmarketcap' CHECK (provider = 'coinmarketcap'),
  token_key text NOT NULL CHECK (token_key ~ '^(cmc:[1-9][0-9]{0,11}|contract:(eip155:[1-9][0-9]{0,9}:0x[0-9a-f]{40}|solana:[1-9A-HJ-NP-Za-km-z]{32,44}))$'),
  snapshot_date date NOT NULL,
  -- When WE asked. There is no provider observation column because the provider publishes no observation time for a
  -- DEX pool figure; cmcObservedAt returns null for every `dex*` capability and this schema does not invent one.
  captured_at timestamptz NOT NULL,
  crypto_id text CHECK (crypto_id IS NULL OR crypto_id ~ '^[1-9][0-9]{0,11}$'),
  symbol text CHECK (symbol IS NULL OR length(symbol) <= 50),
  token_name text CHECK (token_name IS NULL OR length(token_name) <= 200),
  -- The real-world asset this token wraps, as the RWA endpoints name it.
  rwa_id text CHECK (rwa_id IS NULL OR rwa_id ~ '^[1-9][0-9]{0,11}$'),
  rwa_name text CHECK (rwa_name IS NULL OR length(rwa_name) <= 200),
  asset_type text CHECK (asset_type IS NULL OR asset_type IN ('stock','commodity','currency','government_security','etf','real_estate')),
  issuer_name text CHECK (issuer_name IS NULL OR length(issuer_name) <= 200),
  -- TWO different sizes, stored apart and never blended. See the header.
  underlying_value_usd numeric CHECK (underlying_value_usd IS NULL OR underlying_value_usd >= 0),
  token_market_cap numeric CHECK (token_market_cap IS NULL OR token_market_cap >= 0),
  depth_state text NOT NULL CHECK (depth_state IN (
    'pools_read','no_pool_on_read_chains','issuer_redemption_only','chain_not_covered','no_deployment_known','provider_unavailable','budget_deferred')),
  -- The chains, by the provider's own label for `chains_deployed` / `chains_not_covered` and by verified DEX platform
  -- for `chains_read`. `chains_read` is what makes "no pool found" a statement a reader can check.
  chains_deployed text[],
  chains_read text[],
  chains_not_covered text[],
  -- NULL means no pool call was made for this token. 0 means a call was made and the provider reported no pool.
  pool_count integer CHECK (pool_count IS NULL OR pool_count >= 0),
  -- How many of those pools actually reported a liquidity figure. A total built from 2 of 9 pools is not the token's
  -- liquidity, and the read view says so rather than presenting it as one.
  liquidity_pools integer CHECK (liquidity_pools IS NULL OR liquidity_pools >= 0),
  total_liquidity_usd numeric CHECK (total_liquidity_usd IS NULL OR total_liquidity_usd >= 0),
  total_volume_24h_usd numeric CHECK (total_volume_24h_usd IS NULL OR total_volume_24h_usd >= 0),
  deepest_pool_address text CHECK (deepest_pool_address IS NULL OR length(deepest_pool_address) <= 200),
  deepest_pool_dex text CHECK (deepest_pool_dex IS NULL OR length(deepest_pool_dex) <= 120),
  deepest_pool_chain text CHECK (deepest_pool_chain IS NULL OR deepest_pool_chain IN ('ethereum','base','arbitrum','solana')),
  -- A LABEL built from the two legs the response named, in the order it named them. Neither side is asserted to be the
  -- base or the quote, because the response does not say which is which.
  deepest_pool_pair text CHECK (deepest_pool_pair IS NULL OR length(deepest_pool_pair) <= 100),
  deepest_liquidity_usd numeric CHECK (deepest_liquidity_usd IS NULL OR deepest_liquidity_usd >= 0),
  deepest_volume_24h_usd numeric CHECK (deepest_volume_24h_usd IS NULL OR deepest_volume_24h_usd >= 0),
  -- 0 holder accounts is a real answer from /v1/dex/holders/count and is stored as 0. NULL is "not read".
  holder_count integer CHECK (holder_count IS NULL OR holder_count >= 0),
  holder_chain text CHECK (holder_chain IS NULL OR holder_chain IN ('ethereum','base','arbitrum','solana')),
  -- Carried from intel_rwa_token_restrictions so a token with no pool can be EXPLAINED rather than merely reported.
  restriction_state text CHECK (restriction_state IS NULL OR length(restriction_state) <= 40),
  restriction_kyc_gated boolean,
  restriction_source_url text CHECK (restriction_source_url IS NULL OR restriction_source_url ~ '^https://'),
  -- The retained pool rows, bounded by the lane at 30. An array, always: the type check stops a scalar or an object
  -- from reaching a read that iterates it.
  pools jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(pools) = 'array' AND jsonb_array_length(pools) <= 60),
  -- A fingerprint of the deployment set this reading was taken over. It is what "the deployments are unchanged" means:
  -- a token whose chains or contracts moved is re-read even inside the cadence, because the old reading no longer
  -- describes the same set of places the token lives.
  deployment_digest text CHECK (deployment_digest IS NULL OR length(deployment_digest) <= 200),
  -- What these figures do not mean. NOT NULL with a minimum length, exactly as intel_rwa_issuer_risk_signals.scope is.
  scope text NOT NULL CHECK (length(scope) BETWEEN 60 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, token_key, snapshot_date),
  -- The one state that means "there is a depth figure" cannot exist without a pool.
  CONSTRAINT intel_rwa_depth_pools_read_has_pools CHECK (
    depth_state <> 'pools_read' OR (pool_count IS NOT NULL AND pool_count > 0)),
  -- "Sold through the issuer, not through a pool" is a claim about how an asset trades. It may only be made on the
  -- strength of a restriction read from verified contract source, never on the absence of a pool.
  CONSTRAINT intel_rwa_depth_redemption_evidenced CHECK (
    depth_state <> 'issuer_redemption_only' OR restriction_state IS NOT NULL),
  -- A total cannot be built from more pools than were found, and the deepest pool cannot be deeper than the total.
  CONSTRAINT intel_rwa_depth_liquidity_pools_bounded CHECK (
    liquidity_pools IS NULL OR pool_count IS NULL OR liquidity_pools <= pool_count),
  CONSTRAINT intel_rwa_depth_deepest_within_total CHECK (
    deepest_liquidity_usd IS NULL OR total_liquidity_usd IS NULL OR deepest_liquidity_usd <= total_liquidity_usd),
  CONSTRAINT intel_rwa_depth_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(underlying_value_usd), abs(token_market_cap), abs(total_liquidity_usd), abs(total_volume_24h_usd),
    abs(deepest_liquidity_usd), abs(deepest_volume_24h_usd)]), true))
);
CREATE INDEX intel_rwa_depth_recent_idx ON public.intel_rwa_depth_snapshots (snapshot_date DESC, total_liquidity_usd DESC NULLS LAST);
CREATE INDEX intel_rwa_depth_crypto_idx ON public.intel_rwa_depth_snapshots (crypto_id, snapshot_date DESC) WHERE crypto_id IS NOT NULL;
ALTER TABLE public.intel_rwa_depth_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_depth_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_depth_snapshots TO service_role;

-- SECTION: schedule policy

-- 3. Cadence, enablement and the per-run credit ceiling. A later edit to the row wins, so re-running never resets one.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, max_credits, reason) VALUES
  ('coinmarketcap', 'rwa_depth', 86400, true, 'startup', 87,
   'Daily tokenised-asset depth capture: rwaList per asset type (params identical to the hourly rwa lane, so the shared transport answers from its cache for 0 credits), one bounded /v2/cryptocurrency/info call for tokens whose deployments market_assets.facts does not hold, then /v1/dex/token/pools per readable deployment (max 60) and /v1/dex/holders/count for the deepest tokens (max 20). max_credits 87 is the PER-RUN ceiling and, at this cadence, the daily one; the typical run is about 81 because the universe read is a cache hit. Startup minimum: the two DEX endpoints are Startup capabilities and the lane skips itself below that without spending a call.')
ON CONFLICT (provider, feature) DO NOTHING;

-- SECTION: schedule

-- 4. Minute 34 of hour 3 UTC. Idempotent: unscheduled by name before it is scheduled. Rows are keyed on the capture
-- DAY and upserted, and the lane additionally skips a token whose deployment set is unchanged and whose depth it
-- already read today, so an overlapping or retried run walks forward through the subject set rather than paying twice.
SELECT cron.unschedule('intel-capture-rwa-depth-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rwa-depth-daily');
SELECT cron.schedule('intel-capture-rwa-depth-daily', '34 3 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rwa_depth'), timeout_milliseconds := 110000);
$$);

-- SECTION: retention

-- 5. 400 days on the depth snapshots, PATCHED into the live retention function rather than restated, so the blocks
-- every earlier lane added are preserved. Skipped with a notice when the function does not exist yet, and skipped with
-- a notice when its block is already present - the same harmless re-splice behaviour as 20260916150000. The DEPLOYMENT
-- table is not pruned: it holds one upserted row per token per contract, it does not grow with time, and it is what
-- lets an old depth row still name the chains it was talking about.
DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  IF to_regprocedure('app_private.intel_capture_retention(timestamptz)') IS NULL THEN
    RAISE NOTICE 'app_private.intel_capture_retention is absent; skipping the RWA depth retention block.';
    RETURN;
  END IF;
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  IF position('intel_rwa_depth_snapshots' in original) > 0 THEN
    RAISE NOTICE 'RWA depth retention block already present; leaving the function unchanged.';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by the RWA depth lane. Only the daily depth snapshots are pruned: intel_rwa_token_deployments is\n'
    || E'  -- upserted one row per token per contract and is what lets an old reading still name its chains.\n'
    || E'  DELETE FROM public.intel_rwa_depth_snapshots WHERE captured_at < p_now - interval ''400 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_rwa_depth_snapshots'', n);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
END $retention$;
-- OUTSIDE the DO block, exactly as 20260916104500, 20260916120000 and 20260916150000 run it, so it runs on every path
-- through the block rather than only on the one that reaches the end of it.
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;
