-- ============================================================
-- Investor Intel — display currency (CMC plan proposal 26)
-- ============================================================
-- Readers outside the dollar zone can read every Intel money figure in their own
-- currency. Two tables carry that, and nothing else changes:
--
--   intel_fx_rates         one hour bucket x thirty currencies, captured once an
--                          hour from CoinMarketCap price-conversion. Service-role
--                          only, exactly like the other capture tables: the app
--                          reads it through `intel-capture` `{op:'read',view:'fx'}`.
--   intel_user_preferences the reader's chosen currency. Per USER, not per org —
--                          two people in one workspace can read the same desk in
--                          different currencies — so it is the one table here
--                          that is readable and writable from the browser, under
--                          RLS that lets a user touch only their own row.
--
-- THE STORAGE RULE, which this migration does not relax: every amount in Investor
-- Intel stays denominated in USD. No stored figure is ever re-denominated, no
-- historical row is rewritten when a rate moves, and conversion happens only at
-- display time against the newest captured hour. `intel_fx_rates` is therefore a
-- presentation input, never an accounting record.
--
-- Cost: ONE price-conversion call an hour (`amount=1, symbol=USD, convert=<the
-- thirty codes>`) = 1 credit, 24 credits a day. `/v1/fiat/map` is deliberately
-- not called: currency names and signs for a fixed thirty-code list are a static
-- table in `_shared/intel/capture-fx-read.ts`.
--
-- Retention: rates are kept 400 days, the same horizon as the other hourly
-- capture tables, and are removed by `app_private.intel_capture_retention` —
-- which this migration restates in full to add the new table. If another capture
-- lane lands its own restatement of that function, the two must be MERGED rather
-- than allowed to overwrite each other: whichever migration applies last wins,
-- and a lost DELETE block means that lane's table grows without bound.
-- User preferences are never expired: a row is the size of a session setting and
-- losing it silently reverts a reader to dollars.
--
-- Vault + net.http_post cron pattern, identical to 20260915010343_intel_capture_cron.
-- Safe to apply anytime; idempotent.
--
-- Rollback:
--   SELECT cron.unschedule('intel-capture-fx-hourly');
--   DROP TABLE public.intel_fx_rates;
--   DROP TABLE public.intel_user_preferences;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature = 'fx';
--   -- then restore app_private.intel_capture_retention from 20260914232100.
-- Dropping the tables reverts every surface to USD; nothing else depends on them.
-- ============================================================

-- ── 1. Captured rates: one USD-based row per currency per hour ──
-- The primary key is the hour bucket, so a retried or overlapping cron run
-- overwrites its own hour instead of duplicating it. A currency the provider did
-- not price is ABSENT for that hour — never stored as 0 or as 1, either of which
-- would quietly misprice a reader's whole screen.
-- `rate > 0` alone would admit numeric 'NaN' (which compares greater than every
-- finite value), so the finite bound is asserted as well.
CREATE TABLE public.intel_fx_rates (
  base text NOT NULL DEFAULT 'USD' CHECK (base ~ '^[A-Z]{3}$'),
  quote text NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
  captured_at timestamptz NOT NULL,
  rate numeric NOT NULL CHECK (rate > 0 AND 1e30 >= abs(rate)),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base, quote, captured_at)
);
CREATE INDEX intel_fx_rates_captured_idx ON public.intel_fx_rates (captured_at DESC);
ALTER TABLE public.intel_fx_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_fx_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_fx_rates TO service_role;

-- ── 2. The reader's chosen currency ──
-- One row per user. The check keeps the column an ISO 4217 code shape; the app
-- restricts it further to the supported thirty, and an unsupported-but-well-formed
-- code simply falls back to USD at display time rather than breaking a screen.
CREATE TABLE public.intel_user_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_currency text NOT NULL DEFAULT 'USD' CHECK (display_currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.intel_user_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_user_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.intel_user_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_user_preferences TO service_role;

-- A preference is private to its owner in both directions: the read policy stops
-- one member of a workspace enumerating another's setting, and the write policies
-- stop anyone writing a row that is not theirs. `(SELECT auth.uid())` is wrapped
-- so the planner evaluates it once per statement rather than once per row.
CREATE POLICY intel_user_preferences_select_own ON public.intel_user_preferences
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY intel_user_preferences_insert_own ON public.intel_user_preferences
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY intel_user_preferences_update_own ON public.intel_user_preferences
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- updated_at is stamped by the database, so "rates as of" and "you chose this at"
-- cannot be backdated by a client that forgets or lies about the column.
CREATE FUNCTION app_private.intel_user_preferences_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_user_preferences_touch() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER intel_user_preferences_touch
  BEFORE UPDATE ON public.intel_user_preferences
  FOR EACH ROW EXECUTE FUNCTION app_private.intel_user_preferences_touch();

-- ── 3. The capture cadence for the new lane ──
-- An existing row wins, so re-running this migration never resets an operator's edit.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, reason) VALUES
  ('coinmarketcap', 'fx', 3600, true, 'basic', NULL)
ON CONFLICT (provider, feature) DO NOTHING;

-- ── 4. Retention, restated in full to add intel_fx_rates at 400 days ──
-- A CREATE OR REPLACE is the whole function, so this restatement carries every
-- block from 20260914232100 AND the two category blocks that 20260915030100 adds
-- just before it — otherwise applying this migration would silently delete that
-- lane's retention and let its tables grow without bound.
--
-- Those two borrowed blocks run only if their tables exist. A lane that is
-- dropped, renamed or reordered therefore cannot break the nightly job: the
-- block is skipped and its key is simply absent from the report. The same guard
-- is what lets this migration be tested against the base schema alone.
--
-- If a LATER capture lane restates this function again, it must carry the
-- intel_fx_rates block below or FX rates will never be expired.
CREATE OR REPLACE FUNCTION app_private.intel_capture_retention(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  removed jsonb := '{}'::jsonb;
  n integer;
BEGIN
  DELETE FROM public.intel_regime_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_regime_snapshots', n);

  DELETE FROM public.intel_rank_history WHERE snapshot_date < (p_now - interval '3 years')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_rank_history', n);

  DELETE FROM public.intel_rwa_universe_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_rwa_universe_snapshots', n);

  DELETE FROM public.intel_index_constituent_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_index_constituent_snapshots', n);

  n := app_private.intel_thin_liquidation_snapshots(p_now);
  removed := removed || jsonb_build_object('intel_liquidation_snapshots', n);

  DELETE FROM public.intel_exchange_reserve_snapshots WHERE snapshot_date < (p_now - interval '400 days')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_exchange_reserve_snapshots', n);

  DELETE FROM public.intel_venue_share_snapshots WHERE snapshot_date < (p_now - interval '3 years')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_venue_share_snapshots', n);

  DELETE FROM public.intel_attention_snapshots WHERE captured_at < p_now - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_attention_snapshots', n);

  DELETE FROM public.intel_network_stats_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_network_stats_snapshots', n);

  -- From 20260915030100 (category capture), carried so this restatement does not
  -- drop it. Guarded because that lane may not be present in every environment.
  IF to_regclass('public.intel_category_snapshots') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.intel_category_snapshots WHERE captured_at < $1 - interval ''90 days''' USING p_now;
    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed || jsonb_build_object('intel_category_snapshots', n);
  END IF;

  IF to_regclass('public.intel_category_members') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.intel_category_members WHERE snapshot_date < ($1 - interval ''400 days'')::date' USING p_now;
    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed || jsonb_build_object('intel_category_members', n);
  END IF;

  DELETE FROM public.market_asset_demand_daily WHERE day < (p_now - interval '400 days')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('market_asset_demand_daily', n);

  -- Added 20260915030200: display-currency rates, same horizon as the other
  -- hourly captures. Thirty rows an hour is ~263k rows over 400 days.
  DELETE FROM public.intel_fx_rates WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_fx_rates', n);

  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;

-- ── 5. Hourly capture ──
-- At :23, clear of the :07 hourly batch and the :05/:10 liquidation ticks, so the
-- single conversion call never queues behind the multi-call lanes.
DO $schedule$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intel-capture-fx-hourly';
  PERFORM cron.schedule('intel-capture-fx-hourly', '23 * * * *', $job$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','fx'), timeout_milliseconds := 60000);
$job$);
END
$schedule$;
