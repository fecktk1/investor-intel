-- ============================================================
-- Investor Intel: meme graduation lifecycle, third source (SunPump on TRON, read through TronGrid)
-- ============================================================
-- WHY. `/intel/graduation` has two lanes. The CoinMarketCap `meme_stages` lane answers 200, one credit and three
-- EMPTY arrays on this account, run after run. The CoinGecko `launchpad_stages` lane (20260917184100) fills the
-- tables from GeckoTerminal's dex registry and covers Solana, BNB Chain, Base and Robinhood Chain. Neither reaches
-- SunPump: SunPump's bonding curve is ONE contract on TRON and has no GeckoTerminal dex id, so there is no registry
-- entry for the CoinGecko lane to verify and nothing for it to page.
--
-- `sunpump_stages` fills the SAME two tables from the launchpad contract's own event log, through TronGrid. It does
-- not touch either existing lane, its request, its policy row or its cron job, and it spends no CoinMarketCap credit.
--
-- ── NO SCHEMA CHANGE IS NEEDED, AND THAT IS THE POINT ────────────────────────────────────────────────────────────
-- 20260917184100 already widened both tables for exactly this source and said so in its own header:
--     source CHECK      IN ('coinmarketcap', 'coingecko', 'trongrid')   -- 'trongrid' was named there in advance
--     chain CHECK       ~ '^(eip155:[1-9][0-9]*|solana|tron|ton)$'      -- 'tron' already admitted
--     contract_address  ... |T[1-9A-HJ-NP-Za-km-z]{33}| ...             -- TRON base58check already admitted
--     platform_id       already nullable (a CMC DEX platform id, which TRON has none of)
-- So this migration adds NO column, NO constraint and NO index. It seeds one policy row and schedules one job. If a
-- future reader is looking for the column definitions, they are in 20260917184100, not here.
--
-- ── SCHEDULE POLICY ROW ──────────────────────────────────────────────────────────────────────────────────────────
--   ('trongrid', 'sunpump_stages', 3600, true, NULL, 40, '<reason>')
--   provider 'trongrid'   NOT 'coinmarketcap'. `loadSchedulePolicy` in capture-jobs.ts only reads 'coinmarketcap'
--                         rows, so the lane reads this row ITSELF (`loadSunpumpPolicy`). Setting enabled = false
--                         here therefore actually stops the lane, which is the whole reason the row exists.
--   cadence_seconds 3600  hourly, matching the other two lanes that write these tables.
--   min_plan NULL         no CoinMarketCap plan gate. The CMC plan tier says nothing about a TronGrid key, and
--                         gating this lane on `startup` the way `meme_stages` is gated would pause a lane that
--                         spends no CMC credit. NULL is read as "no minimum".
--   max_credits 40        the lane's PER-RUN CALL ceiling, not a credit balance: TronGrid is rate limited (15
--                         requests a second and 500,000 a day on the free key), not metered. WITHOUT a key the lane
--                         drops itself to SIX paced calls against the anonymous host and records `keyless: true` on
--                         its run line, so a thin keyless hour is never read as a quiet chain.
--
-- ── WHAT ONE RUN COSTS ───────────────────────────────────────────────────────────────────────────────────────────
--   3 calls   GET /v1/contracts/{proxy}/events?event_name=TokenLaunched | LaunchPending | TokenCreate
--   <= 24     GET /wallet/gettransactioninfobyid?value=<txid>   (the raw logs; only transactions the three feeds named)
--   <= 2      GET https://api.dexscreener.com/tokens/v1/tron/<up to 30 addresses>   (graduated tokens only)
--   <= 20     POST /wallet/triggerconstantcontract  name() / symbol()  (two per token, cached 24 h)
-- Measured volumes on 2026-09-17: 594 TokenCreate and 8 TokenLaunched in thirty days, so a typical hour opens one or
-- two transactions and the ceiling is headroom rather than a target.
--
-- ── RETENTION: nothing to add. ───────────────────────────────────────────────────────────────────────────────────
-- `app_private.intel_capture_retention` already deletes both tables past 90 days (20260915034403). This migration
-- creates no table, so it does not touch that function.
--
-- ── LICENSING ────────────────────────────────────────────────────────────────────────────────────────────────────
-- TRON chain data is public. TronGrid is infrastructure over it and its terms govern the SERVICE, not the facts, so
-- nothing stored here is redistributed provider data; the rows are OUR hourly observations of a public contract log.
-- DexScreener is used only to enrich a token that has ALREADY graduated (price, market cap, fdv, name, symbol); its
-- terms permit commercial use of the API in a product and forbid reselling the feed, and this lane exposes no raw
-- feed endpoint. Neither source requires a displayed attribution, which is why the read payload's `attribution`
-- object is unchanged and still names CoinGecko only: CoinGecko is the one source on this page whose terms demand it.
--
-- Idempotent. The policy row is ON CONFLICT DO NOTHING and the cron job is unscheduled by name before it is
-- scheduled. Safe to apply more than once. Validated offline with pglast. NOT APPLIED by this change.
--
-- ROLLBACK
--   SELECT cron.unschedule('intel-capture-sunpump-hourly');
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'trongrid' AND feature = 'sunpump_stages';
--   -- and, only if the rows must go too:
--   DELETE FROM public.intel_meme_stage_snapshots   WHERE source = 'trongrid';
--   DELETE FROM public.intel_meme_stage_transitions WHERE source = 'trongrid';
--   -- The CHECKs and columns stay: they belong to 20260917184100 and the CoinGecko lane still needs them.
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION 1: the lane's cadence policy row. A later edit to the row wins, so re-running never resets one.

INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, max_credits, reason) VALUES
  ('trongrid', 'sunpump_stages', 3600, true, NULL, 40,
   'Hourly SunPump (TRON) launch-stage capture, read from the launchpad contract''s own event log through TronGrid. max_credits is this lane''s PER-RUN CALL ceiling (TronGrid is rate limited, not metered); without a TRONGRID_API_KEY the lane drops itself to 6 paced calls against the anonymous host and records keyless on its run line. No CMC plan gate: this lane spends no CoinMarketCap credit.')
ON CONFLICT (provider, feature) DO NOTHING;

-- SECTION 2: schedule. Minute 43, six minutes after the CoinMarketCap meme lane at :37 and two after the CoinGecko
-- launchpad lane at :41, so the three lanes that write the same two tables never start in the same minute and this
-- one sees the other two rows for the hour already in place when it merges. Minute 43 is shared with
-- `geckoterminal-ohlcv-prewarm-30m` (13,43), which posts to a DIFFERENT Edge Function and contends for nothing here
-- (checked against cron.job, 2026-09-17).
-- The job is idempotent: rows are keyed on the capture hour and upserted, the lane reads only snapshots STRICTLY
-- BEFORE the hour it is writing when it carries first_seen_at forward, and it additionally skips when the newest
-- TronGrid capture is younger than cadence_seconds in provider_schedule_policy.

SELECT cron.unschedule('intel-capture-sunpump-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-sunpump-hourly');
SELECT cron.schedule('intel-capture-sunpump-hourly', '43 * * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','sunpump_stages'), timeout_milliseconds := 110000);
$$);
