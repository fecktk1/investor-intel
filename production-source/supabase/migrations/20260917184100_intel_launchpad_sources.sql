-- ============================================================
-- Investor Intel — meme graduation lifecycle, second source (CoinGecko onchain / GeckoTerminal launchpads)
-- ============================================================
-- WHY. `/intel/graduation` is fed by exactly one lane today, `meme_stages`, which asks CoinMarketCap
-- `/v1/dex/meme/list`. On this account that endpoint answers 200, one credit and three EMPTY arrays, run after run
-- (see the header of supabase/functions/_shared/intel/capture-meme.ts for the three corrections already made to that
-- request). Both tables below are EMPTY in production as this migration is written (verified 2026-09-17:
-- intel_meme_stage_snapshots 0 rows, intel_meme_stage_transitions 0 rows), so the page has nothing to draw.
--
-- This migration does NOT touch the CoinMarketCap lane, its request or its policy row. It WIDENS the two tables the
-- page already reads so a second capture lane, `launchpad_stages`, can fill them from real launchpads on Solana, BNB
-- Chain, Base and Robinhood Chain through CoinGecko's onchain API (the same data GeckoTerminal serves).
--
-- ── DECISION 1: the primary key does NOT change. ───────────────────────────────────────────────────────────────────
-- It stays (chain, contract_address, captured_at), and `source` is a COLUMN, not a key part.
--   * The page's question is "what stage is this contract in this hour", and that question has exactly one honest
--     answer. Putting `source` in the key would let CoinMarketCap say `newCreations` and CoinGecko say `graduates`
--     for the same contract in the same hour, and every count on the page (funnel, cohort denominator, graduation
--     rate) would silently double-count that contract.
--   * So `source` records the FIRST WRITER of the row. A later lane that sees the same contract in the same hour
--     fills only the fields that are still NULL (launchpad, graduation_pct, completed_at, migration_pool, fdv,
--     platform_id) and never rewrites a stage, a price or a source another lane already recorded. That merge is done
--     BY THE LANE — it reads the same-hour row before it writes — because a PostgREST upsert replaces a whole row and
--     cannot express "only when null". See `mergeExisting` in capture-launchpads.ts.
--   * The alternative (adding `source` to the key, or a unique index per source) was rejected for the reason above:
--     it makes the table honest about provenance and the PAGE dishonest about counts, which is the wrong trade for a
--     funnel whose whole value is the denominator.
-- No unique index is added. (chain, contract_address, captured_at) already is one, and it is the one the read needs.
--
-- ── DECISION 2: the CHECKs stay CHECKs, and they stay narrow. ─────────────────────────────────────────────────────
-- `chain` is relaxed from `eip155:<n>|solana` to the CAIP-2 shapes this platform can actually identify today:
-- `eip155:<n>`, `solana`, `tron`, `ton`. It is NOT relaxed to "any text": a chain nobody can resolve to a block
-- explorer is a row nobody can verify, and the launchpad lane refuses to write one.
-- `contract_address` gains two shapes beside 0x-40-hex and Solana base58:
--     TRON  base58check, 'T' + 33 base58 characters (34 total)
--     TON   'EQ' or 'UQ' + 46 base64url characters (48 total)
-- Neither chain has a lane yet. They are admitted now because the third allowed `source` value below ('trongrid') is
-- the already-named next source, and widening a CHECK later is a second exclusive lock on a table the page reads.
--
-- ── DECISION 3: platform_id becomes nullable. ─────────────────────────────────────────────────────────────────────
-- It is the CoinMarketCap DEX platform id and nothing else (1 ethereum, 16 solana, 51 arbitrum, 199 base). CoinGecko
-- does not publish it and this migration does not invent one: a CoinGecko row carries NULL there and names its chain
-- in `chain`. The CHECK `platform_id > 0` is kept for the rows that do have one.
--
-- ── NEW COLUMNS (both tables, so a transition row can be read without joining back to a snapshot) ─────────────────
--   source           text NOT NULL DEFAULT 'coinmarketcap', CHECK IN ('coinmarketcap','coingecko','trongrid')
--                    The default backfills the existing rows correctly: every row that exists today was written by
--                    the CoinMarketCap lane. (There are none, but the default is still the honest one.)
--   launchpad        text  the pad's own id at the source, e.g. 'pump-fun', 'four-meme', 'virtuals-base'. NULL for a
--                    CoinMarketCap row, which names a protocol code rather than a pad id.
--   graduation_pct   numeric -100..100, NULL when the source publishes no bonding-curve progress (a pad with no
--                    curve, or a token already migrated). NULL is "not published", never 0.
--                    THE BAND IS NOT 0..100, AND THAT IS NOT A TYPO. Probed live on 2026-09-17, pump-fun publishes
--                    small NEGATIVE percentages for a token at the very start of its curve
--                    (6JL8po5CKmmcLRQN912udcQNLMhaa56C9X6cUDBX1yq6, graduation_percentage -4.8). A 0 floor would
--                    silently rewrite a value the source published, which is exactly the kind of repair this schema
--                    refuses everywhere else. A value outside -100..100 is stored as NULL by the lane with
--                    graduation_pct_out_of_band on the run line, never clamped into range.
--   completed_at     timestamptz  the source's own `launchpad_details.completed_at`. NOT our capture clock, and never
--                    filled from one: a graduation we observed but whose time the source did not publish keeps NULL.
--   migration_pool   text  the destination AMM pool the token migrated into, as the source publishes it.
--   fdv              numeric  fully diluted valuation at capture. Stored beside `market_cap` rather than instead of
--                    it: before graduation CoinGecko publishes fdv and leaves market_cap null, so a funnel that only
--                    had market_cap would show every pre-graduation token as valueless.
--
-- ── INDEXES the read needs ───────────────────────────────────────────────────────────────────────────────────────
-- The widened read filters by launchpad and by source and always orders newest first, so each gets a composite index
-- ending in captured_at DESC (at DESC for transitions). The existing chain/captured_at and contract indexes still
-- serve the chain filter and the lane's prior-snapshot read.
--
-- ── SCHEDULE POLICY ROW ──────────────────────────────────────────────────────────────────────────────────────────
--   ('coingecko', 'launchpad_stages', 3600, true, NULL, 40, '<reason>')
--   cadence_seconds 3600  hourly, the same cadence as the CoinMarketCap meme lane and the cadence the CoinGecko paid
--                         terms require of cached values anyway (refresh within 24 hours is the ceiling; an hour is
--                         well inside it).
--   min_plan NULL         this lane has NO CoinMarketCap plan gate. The CMC plan tier says nothing about a CoinGecko
--                         key, and gating it on `startup` the way `meme_stages` is gated would pause a lane that
--                         spends no CMC credit. NULL is read by schedulePolicy() as "no minimum".
--   max_credits 40        the lane's PER-RUN CALL ceiling, not a credit balance: CoinGecko onchain calls are rate
--                         limited, not metered, so the number that has to be held down is calls per run. The lane
--                         reads this column as its budget and halves it to 24 when it is running keyless against the
--                         shared 30-requests-per-minute public host.
--
-- ── RETENTION: nothing to add. ───────────────────────────────────────────────────────────────────────────────────
-- `app_private.intel_capture_retention` already deletes both tables past 90 days (inserted by
-- 20260915034403_intel_meme_graduation.sql). This migration creates no table, so it does not touch that function —
-- which is also why it does not have to guess at an anchor inside it.
--
-- ── LICENSING (why the lane stores derived history and the read carries an attribution object) ────────────────────
-- CoinGecko's paid terms permit charging for a product that integrates the API, forbid redistributing API access,
-- require a visible "Powered by CoinGecko" attribution (font size at least 10) wherever the data is shown, and
-- require cached values to be refreshed within 24 hours. So: these tables hold OUR hourly observations (stage,
-- graduation percentage, price, fdv at our capture clock) as derived history, no raw feed endpoint is ever exposed,
-- the hourly cadence is well inside the 24-hour refresh rule, and the read payload carries
-- `attribution: {provider:'coingecko', text:'Powered by CoinGecko', url:'https://www.coingecko.com'}` so the page
-- cannot render the data without being handed the attribution it must show.
--
-- Idempotent. Every ADD COLUMN is IF NOT EXISTS, every CHECK is dropped by name before being recreated, every index
-- is IF NOT EXISTS, the policy row is ON CONFLICT DO NOTHING and the cron job is unscheduled by name before it is
-- scheduled. Safe to apply more than once. Validated offline with pglast. NOT APPLIED by this change.
--
-- ROLLBACK
--   SELECT cron.unschedule('intel-capture-launchpads-hourly');
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'coingecko' AND feature = 'launchpad_stages';
--   -- and, only if the widened columns must go too (this DELETES every CoinGecko row):
--   DELETE FROM public.intel_meme_stage_snapshots   WHERE source <> 'coinmarketcap';
--   DELETE FROM public.intel_meme_stage_transitions WHERE source <> 'coinmarketcap';
--   ALTER TABLE public.intel_meme_stage_snapshots   DROP COLUMN source, DROP COLUMN launchpad, DROP COLUMN graduation_pct,
--     DROP COLUMN completed_at, DROP COLUMN migration_pool, DROP COLUMN fdv;
--   ALTER TABLE public.intel_meme_stage_transitions DROP COLUMN source, DROP COLUMN launchpad, DROP COLUMN graduation_pct,
--     DROP COLUMN completed_at, DROP COLUMN migration_pool, DROP COLUMN fdv;
--   ALTER TABLE public.intel_meme_stage_snapshots ALTER COLUMN platform_id SET NOT NULL;
--   -- restore the narrow CHECKs from 20260915034403 by name.
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION 1: widen intel_meme_stage_snapshots

ALTER TABLE public.intel_meme_stage_snapshots
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'coinmarketcap',
  ADD COLUMN IF NOT EXISTS launchpad text,
  ADD COLUMN IF NOT EXISTS graduation_pct numeric,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS migration_pool text,
  ADD COLUMN IF NOT EXISTS fdv numeric;

-- The CMC DEX platform id is CMC-specific; a CoinGecko row has none and never invents one.
ALTER TABLE public.intel_meme_stage_snapshots ALTER COLUMN platform_id DROP NOT NULL;

-- CAIP-2 chain shapes this platform can identify. Dropped by name first so re-running lands the same definition.
ALTER TABLE public.intel_meme_stage_snapshots DROP CONSTRAINT IF EXISTS intel_meme_stage_snapshots_chain_check;
ALTER TABLE public.intel_meme_stage_snapshots
  ADD CONSTRAINT intel_meme_stage_snapshots_chain_check
  CHECK (chain ~ '^(eip155:[1-9][0-9]*|solana|tron|ton)$');

-- 0x-40-hex (EVM) | Solana base58 | TRON 'T' + 33 base58 | TON 'EQ'/'UQ' + 46 base64url.
ALTER TABLE public.intel_meme_stage_snapshots DROP CONSTRAINT IF EXISTS intel_meme_stage_snapshots_contract_address_check;
ALTER TABLE public.intel_meme_stage_snapshots
  ADD CONSTRAINT intel_meme_stage_snapshots_contract_address_check
  CHECK (contract_address ~ '^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|T[1-9A-HJ-NP-Za-km-z]{33}|(EQ|UQ)[A-Za-z0-9_-]{46})$');

ALTER TABLE public.intel_meme_stage_snapshots DROP CONSTRAINT IF EXISTS intel_meme_stage_snapshots_source_check;
ALTER TABLE public.intel_meme_stage_snapshots
  ADD CONSTRAINT intel_meme_stage_snapshots_source_check
  CHECK (source IN ('coinmarketcap', 'coingecko', 'trongrid'));

-- A percentage is a percentage. NULL means the source published none; it is never repaired into a 0.
ALTER TABLE public.intel_meme_stage_snapshots DROP CONSTRAINT IF EXISTS intel_meme_stage_snapshots_graduation_pct_check;
ALTER TABLE public.intel_meme_stage_snapshots
  ADD CONSTRAINT intel_meme_stage_snapshots_graduation_pct_check
  CHECK (graduation_pct IS NULL OR (graduation_pct >= -100 AND graduation_pct <= 100));

-- NaN and +/-Infinity both compare greater than 1e30; an all-NULL array yields NULL and coalesce lets it pass.
ALTER TABLE public.intel_meme_stage_snapshots DROP CONSTRAINT IF EXISTS intel_meme_stage_snapshots_finite;
ALTER TABLE public.intel_meme_stage_snapshots
  ADD CONSTRAINT intel_meme_stage_snapshots_finite
  CHECK (coalesce(1e30 >= ALL (ARRAY[abs(price), abs(market_cap), abs(fdv)]), true));

COMMENT ON COLUMN public.intel_meme_stage_snapshots.source IS
  'Which capture lane FIRST wrote this row: coinmarketcap (meme_stages) or coingecko (launchpad_stages). A later lane that sees the same contract in the same hour fills only NULL fields and never rewrites this.';
COMMENT ON COLUMN public.intel_meme_stage_snapshots.launchpad IS
  'The launchpad''s own id at the source, e.g. pump-fun, four-meme, virtuals-base. NULL for a CoinMarketCap row.';
COMMENT ON COLUMN public.intel_meme_stage_snapshots.graduation_pct IS
  'Bonding-curve progress as the source published it at our capture clock, band -100..100 (pump-fun publishes small negative values at the start of a curve). NULL means not published, never 0.';
COMMENT ON COLUMN public.intel_meme_stage_snapshots.completed_at IS
  'The source''s own graduation time. Never our capture clock: an observed graduation whose time the source did not publish keeps NULL.';
COMMENT ON COLUMN public.intel_meme_stage_snapshots.migration_pool IS
  'Destination AMM pool the token migrated into, as the source publishes it.';
COMMENT ON COLUMN public.intel_meme_stage_snapshots.fdv IS
  'Fully diluted valuation at capture. Pre-graduation the source publishes fdv and leaves market_cap NULL.';

-- The widened read filters by launchpad and by source, always newest first.
CREATE INDEX IF NOT EXISTS intel_meme_stage_snapshots_launchpad_idx
  ON public.intel_meme_stage_snapshots (launchpad, captured_at DESC);
CREATE INDEX IF NOT EXISTS intel_meme_stage_snapshots_source_idx
  ON public.intel_meme_stage_snapshots (source, captured_at DESC);
-- The lane re-polls "the newest contracts of this pad that have not completed yet".
CREATE INDEX IF NOT EXISTS intel_meme_stage_snapshots_tracked_idx
  ON public.intel_meme_stage_snapshots (source, launchpad, stage, captured_at DESC);

-- SECTION 2: widen intel_meme_stage_transitions the same way

ALTER TABLE public.intel_meme_stage_transitions
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'coinmarketcap',
  ADD COLUMN IF NOT EXISTS launchpad text,
  ADD COLUMN IF NOT EXISTS graduation_pct numeric,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS migration_pool text,
  ADD COLUMN IF NOT EXISTS fdv numeric;

ALTER TABLE public.intel_meme_stage_transitions DROP CONSTRAINT IF EXISTS intel_meme_stage_transitions_chain_check;
ALTER TABLE public.intel_meme_stage_transitions
  ADD CONSTRAINT intel_meme_stage_transitions_chain_check
  CHECK (chain ~ '^(eip155:[1-9][0-9]*|solana|tron|ton)$');

ALTER TABLE public.intel_meme_stage_transitions DROP CONSTRAINT IF EXISTS intel_meme_stage_transitions_contract_address_check;
ALTER TABLE public.intel_meme_stage_transitions
  ADD CONSTRAINT intel_meme_stage_transitions_contract_address_check
  CHECK (contract_address ~ '^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|T[1-9A-HJ-NP-Za-km-z]{33}|(EQ|UQ)[A-Za-z0-9_-]{46})$');

ALTER TABLE public.intel_meme_stage_transitions DROP CONSTRAINT IF EXISTS intel_meme_stage_transitions_source_check;
ALTER TABLE public.intel_meme_stage_transitions
  ADD CONSTRAINT intel_meme_stage_transitions_source_check
  CHECK (source IN ('coinmarketcap', 'coingecko', 'trongrid'));

ALTER TABLE public.intel_meme_stage_transitions DROP CONSTRAINT IF EXISTS intel_meme_stage_transitions_graduation_pct_check;
ALTER TABLE public.intel_meme_stage_transitions
  ADD CONSTRAINT intel_meme_stage_transitions_graduation_pct_check
  CHECK (graduation_pct IS NULL OR (graduation_pct >= -100 AND graduation_pct <= 100));

ALTER TABLE public.intel_meme_stage_transitions DROP CONSTRAINT IF EXISTS intel_meme_stage_transitions_finite;
ALTER TABLE public.intel_meme_stage_transitions
  ADD CONSTRAINT intel_meme_stage_transitions_finite
  CHECK (coalesce(1e30 >= ALL (ARRAY[abs(hours_since_first_seen), abs(fdv)]), true));

CREATE INDEX IF NOT EXISTS intel_meme_stage_transitions_launchpad_idx
  ON public.intel_meme_stage_transitions (launchpad, at DESC);
CREATE INDEX IF NOT EXISTS intel_meme_stage_transitions_source_idx
  ON public.intel_meme_stage_transitions (source, at DESC);

-- SECTION 3: the lane's cadence policy row. A later edit to the row wins, so re-running never resets one.

INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, max_credits, reason) VALUES
  ('coingecko', 'launchpad_stages', 3600, true, NULL, 40,
   'Hourly launchpad stage capture through the CoinGecko onchain API. max_credits is this lane''s PER-RUN CALL ceiling (CoinGecko onchain is rate limited, not metered); the lane halves it to 24 when running keyless against the shared public host. No CMC plan gate: this lane spends no CoinMarketCap credit.')
ON CONFLICT (provider, feature) DO NOTHING;

-- SECTION 4: schedule. Minute 41, four minutes after the CoinMarketCap meme lane at :37, so the two lanes that write
-- the same two tables never start in the same minute and the CoinGecko lane sees the CMC lane's rows for the hour
-- already in place when it merges. Minute 41 is named by no other job in cron.job (checked 2026-09-17).
-- The job is idempotent: rows are keyed on the capture hour and upserted, the lane reads only snapshots STRICTLY
-- BEFORE the hour it is writing when it carries first_seen_at forward, and it additionally skips when the newest
-- CoinGecko capture is younger than cadence_seconds in provider_schedule_policy.

SELECT cron.unschedule('intel-capture-launchpads-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-launchpads-hourly');
SELECT cron.schedule('intel-capture-launchpads-hourly', '41 * * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','launchpad_stages'), timeout_milliseconds := 110000);
$$);
