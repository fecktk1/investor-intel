-- ============================================================
-- Investor Intel — the stored candle archive (candle history, goal B)
-- ============================================================
-- Bitcoin showed one year, because one provider window was the whole answer. This migration adds the storage behind
-- the `candle_backfill`, `candle_daily` and `history_backfill` ops of the `intel-capture` Edge Function, so an asset's
-- COMPLETE daily history is fetched ONCE and then extended forward a day at a time:
--
--   market_asset_candles            one row per (asset, provider, interval, period). Daily candles at least; hourly
--                                   where a source gives them away. Service-role only, exactly like every other
--                                   capture table: Intel members read it only through the existing read paths
--                                   (`intel-markets` merges it under the chart, `intel-capture`
--                                   `{op:'read',view:'candle_coverage'}` reports what it holds), never through
--                                   PostgREST.
--
--   market_asset_candle_backfill    one row per asset in the backfill queue: its priority, which source filled it,
--                                   how far back it reaches, how many candles it holds, how many CoinMarketCap
--                                   credits it has cost, and why it is not finished. This is what makes a run
--                                   RESUMABLE: a run never repeats work another run has already paid for.
--
-- HONESTY RULES the schema enforces, not only the job:
--   * A candle must have a CLOSE. open/high/low may be absent for a source that does not report them, but a row with
--     no close is not a candle and the column is NOT NULL.
--   * high >= low, and high/low bracket open and close wherever those exist. A row that claims a low above its high
--     is rejected rather than drawn.
--   * A zero volume is a completed period in which nothing traded and is stored as zero; a volume the source did not
--     report is NULL. The check allows zero and rejects a negative.
--   * Every period is ALIGNED to its interval in UTC, so a "daily" row can never hold an arbitrary timestamp.
--   * `oldest_candle`/`newest_candle` bracket correctly, and a queue row cannot claim `complete` with no source.
--
-- Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass.
--
-- CREDITS. `/v2/cryptocurrency/ohlcv/historical` is documented at one credit per 100 daily points, and the registry
-- caps one page at 250 points (`numericCeiling` in cmc-capabilities.ts), so the lane pages 249 days at 3 credits a
-- page. Bitcoin's pre-Binance gap (2013 to 2017) is 7 pages, 19 credits; a whole history from 2010 is 25 pages, 74.
-- Most of the top 100 are listed on Binance, whose daily klines are free and reach back to 2017, so the paid rung
-- only buys the years before that. The STANDING ceiling for the whole backfill is 5,000 credits and it lives in
-- provider_schedule_policy.max_credits, added by this migration, so it can be changed without a deploy. One run
-- additionally spends at most 400 (the lane's own BACKFILL_RUN_CREDITS), and the daily append at most 150.
--
-- RETENTION. DAILY CANDLES ARE NEVER THINNED AND NEVER DELETED. That is the whole point of the table: an archive that
-- forgets is not an archive. Only the optional HOURLY rows are pruned, at 400 days, because they exist for recent
-- intraday reading and the chart's own provider window covers that period anyway. The retention block is PATCHED
-- into the LIVE definition of app_private.intel_capture_retention (the meme graduation lane's technique, 20260915034403)
-- rather than restated: the live function carries blocks from every lane before this one (category, FX, new listing,
-- holder tags, meme stages), a restatement copied from any one migration silently drops the blocks added after it,
-- and a lost DELETE block means that lane's table grows without bound. The patch reads the function as it is, refuses
-- to run twice, and inserts one block before its single `RETURN removed;`.
-- If a LATER capture lane restates this function in full, it must carry the market_asset_candles block below.
--
-- Vault + net.http_post cron pattern, identical to 20260915010343_intel_capture_cron. Safe to apply anytime;
-- idempotent.
--
-- ROLLBACK
--   -- stop the lanes, keep the data:
--   SELECT cron.unschedule('intel-capture-candle-backfill');
--   SELECT cron.unschedule('intel-capture-candle-daily');
--   -- disable them instead of unscheduling:
--   UPDATE public.provider_schedule_policy SET enabled = false
--     WHERE provider = 'coinmarketcap' AND feature IN ('candle_history','candle_daily');
--   -- drop the data too:
--   DROP TABLE public.market_asset_candles;
--   DROP TABLE public.market_asset_candle_backfill;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature IN ('candle_history','candle_daily');
--   ALTER TABLE public.provider_schedule_policy DROP COLUMN max_credits;
--   -- then restore app_private.intel_capture_retention from 20260915034150_intel_new_listing_capture.sql
--   -- (otherwise the nightly job errors on its next run against the dropped table).
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: candle archive table

-- 1. The archive itself.
CREATE TABLE public.market_asset_candles (
  -- The canonical asset key the rest of Investor Intel uses ('bip122:native:BTC', 'eip155:1:native',
  -- 'solana:<mint>', or 'market:<provider>:<id>' for an asset with no canonical chain identity).
  asset_key text NOT NULL CHECK (asset_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,199}$'),
  -- Which source produced this row. Two sources may both hold a period; both are kept, because they are two
  -- measurements and neither corrects the other, and the READ picks one with a stated precedence.
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- 'interval' is a type name in PostgreSQL; the column is spelled out so no expression over this table has to quote
  -- its way around a keyword.
  candle_interval text NOT NULL CHECK (candle_interval IN ('1h','1d')),
  candle_time timestamptz NOT NULL,
  open numeric,
  high numeric,
  low numeric,
  -- A row with no close is not a candle.
  close numeric NOT NULL,
  -- Zero is a completed period in which nothing traded. NULL is a period whose volume was never reported.
  volume numeric CHECK (volume IS NULL OR volume >= 0),
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 200),
  recorded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_key, provider, candle_interval, candle_time),
  -- A daily row lands on a UTC midnight and an hourly row on a UTC hour. `AT TIME ZONE 'UTC'` with a literal zone is
  -- immutable, so this is a legal CHECK.
  CONSTRAINT market_asset_candles_aligned CHECK (
    candle_time = CASE candle_interval
      WHEN '1d' THEN date_trunc('day', candle_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ELSE date_trunc('hour', candle_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END),
  -- A period that claims a low above its high, or a high below what traded, is not a measurement.
  CONSTRAINT market_asset_candles_bracket CHECK (
    (high IS NULL OR low IS NULL OR high >= low)
    AND (high IS NULL OR high >= close) AND (low IS NULL OR low <= close)
    AND (high IS NULL OR open IS NULL OR high >= open) AND (low IS NULL OR open IS NULL OR low <= open)),
  CONSTRAINT market_asset_candles_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(open), abs(high), abs(low), abs(close), abs(volume)]), true))
);
-- The chart read asks for "every candle of THIS asset at THIS interval inside a window, oldest first".
CREATE INDEX market_asset_candles_read_idx ON public.market_asset_candles (asset_key, candle_interval, candle_time);
-- The daily append asks "what is the newest period I hold".
CREATE INDEX market_asset_candles_recent_idx ON public.market_asset_candles (candle_interval, candle_time DESC);
ALTER TABLE public.market_asset_candles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.market_asset_candles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.market_asset_candles TO service_role;

-- 2. The backfill queue and its progress. This is what makes a run resumable.
CREATE TABLE public.market_asset_candle_backfill (
  asset_key text PRIMARY KEY CHECK (asset_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,199}$'),
  provider text,
  provider_id text,
  symbol text,
  -- Which source actually filled it: 'binance', 'coinmarketcap', or 'binance+coinmarketcap' when the venue covered
  -- the years it lists and the paid rung covered the years before that.
  source text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','partial','complete','unavailable')),
  -- Market-cap rank for a catalogue asset; the cohort size plus one for an asset a reader opened.
  priority integer NOT NULL DEFAULT 1000 CHECK (priority > 0),
  oldest_candle date,
  newest_candle date,
  candles bigint NOT NULL DEFAULT 0 CHECK (candles >= 0),
  credits_spent integer NOT NULL DEFAULT 0 CHECK (credits_spent >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reason text CHECK (reason IS NULL OR length(reason) <= 200),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A window that ends before it starts is not a window.
  CONSTRAINT market_asset_candle_backfill_window CHECK (oldest_candle IS NULL OR newest_candle IS NULL OR oldest_candle <= newest_candle),
  -- "Complete" is a claim about stored history. It may not be made without a source, without a window, and without
  -- candles; an asset that stored nothing is 'unavailable' with a reason, never a silent success.
  CONSTRAINT market_asset_candle_backfill_complete CHECK (
    state <> 'complete' OR (source IS NOT NULL AND oldest_candle IS NOT NULL AND newest_candle IS NOT NULL AND candles > 0)),
  CONSTRAINT market_asset_candle_backfill_unavailable CHECK (state <> 'unavailable' OR reason IS NOT NULL)
);
-- The queue read asks for "the pending work, best priority first".
CREATE INDEX market_asset_candle_backfill_queue_idx ON public.market_asset_candle_backfill (state, priority, asset_key);
-- The daily append asks for "whatever has fallen furthest behind".
CREATE INDEX market_asset_candle_backfill_stale_idx ON public.market_asset_candle_backfill (newest_candle NULLS FIRST);
ALTER TABLE public.market_asset_candle_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.market_asset_candle_backfill FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.market_asset_candle_backfill TO service_role;

-- 3. A standing credit ceiling for a feature. Every lane before this one is bounded per RUN, which is the right shape
-- for a repeating capture. A backfill that fills an archive ONCE needs a budget it can be held to ACROSS runs, so the
-- ceiling lives in the policy table and can be changed without a deploy.
ALTER TABLE public.provider_schedule_policy ADD COLUMN IF NOT EXISTS max_credits integer
  CHECK (max_credits IS NULL OR max_credits >= 0);
COMMENT ON COLUMN public.provider_schedule_policy.max_credits IS
  'Standing credit ceiling for this feature across runs. NULL means the lane uses its own documented default.';

-- 4. Cadence and budget for the two new lanes. A later edit to a row wins, so re-running this migration never resets
-- one. `candle_history` is the backfill (every 20 minutes until the queue drains, 5,000 credits in total);
-- `candle_daily` is the append (once a day, 150 credits, which only ever binds for assets no free venue lists).
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, max_credits, reason) VALUES
  ('coinmarketcap', 'candle_history', 1200, true, 'startup', 5000, 'one-time daily candle history per asset; free venue first, OHLCV for older years'),
  ('coinmarketcap', 'candle_daily', 86400, true, 'startup', 150, 'daily append of yesterday''s candle for every stored asset')
ON CONFLICT (provider, feature) DO NOTHING;

-- 5. Retention, PATCHED into the live definition (see the header). DAILY CANDLES ARE NEVER DELETED AND NEVER THINNED:
-- an archive that forgets is not an archive, and the whole reason this table exists is that a provider window cannot
-- reach the years behind it. Only the optional hourly rows are pruned, at 400 days, because the chart's own provider
-- window already covers recent intraday reading. The daily count is reported as 0 so a reader of the function's
-- result can see that the block ran and deliberately removed nothing.
DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  -- Refuse a second application rather than adding the same DELETE block twice.
  IF position('market_asset_candles' in original) > 0 THEN
    RAISE EXCEPTION 'candle_retention_block_already_present';
  END IF;
  -- Exactly one `RETURN removed;` is what makes the insertion point unambiguous. Any other count means the function
  -- is not the one this migration was written against, and guessing at a second anchor is how a lane's horizon gets
  -- lost.
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by the candle archive lane. Daily candles are never deleted and never thinned; only the optional hourly\n'
    || E'  -- rows are pruned, at 400 days. The daily count is reported as 0 so the block is seen to run and remove nothing.\n'
    || E'  DELETE FROM public.market_asset_candles WHERE candle_interval = ''1h'' AND candle_time < p_now - interval ''400 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''market_asset_candles_1h'', n, ''market_asset_candles_1d'', 0);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
END $retention$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;

-- SECTION: candle archive schedule

-- 6. The backfill, every twenty minutes at :05 past the third of an hour, clear of the :07 hourly batch, the :10
-- new-listing run, the :17 category run and the :23 FX run. Each run fills at most ten assets and records its
-- progress, so the job is idempotent and a repeated run never re-pays for a period already stored. Once the queue
-- drains every run answers `queue_empty` and spends nothing; the schedule is kept so a newly opened asset is filled
-- without anyone remembering to run it.
SELECT cron.unschedule('intel-capture-candle-backfill') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-candle-backfill');
SELECT cron.schedule('intel-capture-candle-backfill', '5,25,45 * * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','candle_backfill'), timeout_milliseconds := 110000);
$$);

-- 7. The daily append, at 00:40 UTC — after the UTC day closes, before the 06:10 new-listing run. It asks each stored
-- asset only for the days AFTER its newest stored candle, so a missed night is caught up rather than lost.
SELECT cron.unschedule('intel-capture-candle-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-candle-daily');
SELECT cron.schedule('intel-capture-candle-daily', '40 0 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','candle_daily'), timeout_milliseconds := 110000);
$$);
