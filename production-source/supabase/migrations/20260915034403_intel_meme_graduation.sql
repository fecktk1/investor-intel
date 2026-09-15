-- ============================================================
-- Investor Intel — meme graduation lifecycle (CMC plan proposal 30)
-- ============================================================
-- Two new capture tables behind the `meme_stages` lane of the `intel-capture` Edge Function:
--
--   intel_meme_stage_snapshots    one row per contract per capture HOUR, carrying the launch stage CoinMarketCap
--                                 reported for it (`newCreations`, `aboutGraduates`, `graduates`), the reported name,
--                                 symbol, price and market cap, and `first_seen_at` — the first hour WE saw that
--                                 contract in any stage. Service-role only, exactly like every other capture table:
--                                 reads go through `intel-capture` `{op:'read',view:'meme_graduation'}`, never through
--                                 PostgREST.
--
--   intel_meme_stage_transitions  one row each time a contract's stage differs from the stage of its own previous
--                                 snapshot: from, to, when, and the hours since its first sighting. It is written by
--                                 the same lane, from rows the same run already read; it adds no provider call and no
--                                 credit.
--
-- HONESTY RULES the schema enforces, not only the job:
--   * The provider publishes NO clock for a discovery list. `captured_at` is OUR capture time, floored to the hour by
--     the lane, and the column is named for what it is. (The hour floor is the lane's invariant, not a CHECK: every
--     expression that could test it is only STABLE for timestamptz and may not appear in a constraint.)
--   * `first_seen_at` is a FIRST SIGHTING, never a deployment time, and can never be after the capture that records
--     it.
--   * A transition always MOVES: `from_stage <> to_stage`. A contract that stays in a stage writes nothing, and a
--     contract with no previous snapshot writes nothing — there is no stage to move from.
--   * One stage per contract per hour. The primary key makes a second, contradictory stage for the same hour
--     impossible, so a contract listed in two of the response's three arrays must be resolved by the lane (it keeps
--     the furthest stage) rather than stored twice.
--   * Only the three stages the endpoint documents are storable. A fourth name is a schema change, never a silent new
--     category.
--
-- Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass.
--
-- FOUR.MEME IS NOT COVERED. The audit names Pump.fun, Moonshot and Four.meme. Four.meme launches on BNB Chain, which
-- is not one of the four platforms this platform has verified CMC DEX evidence for, so the chain CHECK below does not
-- admit it and no Four.meme cohort is captured or implied. Widening it is the same work as widening CMC_DEX_NETWORKS
-- (proposal 31): `dexPlatforms` validation first, a migration second.
--
-- Credits per run at the seeded cadence (upper bound; a fresh shared cache costs 0):
--   meme_stages   1 run x 4 verified platforms x 1 `dexMeme` call = 4 credits an hour, 96 a day.
-- `dexMeme` is a Startup capability. Below Startup the lane is skipped with `plan_below_startup` and spends nothing,
-- the way `network_stats` is skipped below Growth.
--
-- Retention: 90 days of hourly stage rows and of transitions.
--
-- RETENTION PATCH, NOT A RESTATEMENT. Every earlier capture lane restated `app_private.intel_capture_retention` in
-- full, which is safe only when the author can see every block that already exists. This migration lands alongside
-- other Stage 4 lanes (`20260915030000_intel_new_listing_capture` is the newest restatement present in the tree as
-- this was written, and a holder-tags migration `20260915030400` is expected to restate the same function), so a full
-- restatement here would silently DROP whichever lane's DELETE block landed in between and let that table grow without
-- bound. Instead the two new blocks are INSERTED INTO THE LIVE DEFINITION immediately before `RETURN removed;`, the
-- same way 20260911213014, 20260915004720, 20260915014031 and 20260915030000 patched the alert bridge. If the anchor
-- has moved, the patch RAISES rather than guessing — and it refuses a second run rather than adding the blocks twice.
--
-- Vault + net.http_post cron pattern, identical to 20260915010343_intel_capture_cron. Safe to apply anytime;
-- idempotent except for the retention patch, which refuses a second run.
--
-- ROLLBACK
--   -- stop the lane, keep the data:
--   SELECT cron.unschedule('intel-capture-meme-hourly');
--   -- disable it instead of unscheduling it:
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'coinmarketcap' AND feature = 'meme_stages';
--   -- drop the data too:
--   DROP TABLE public.intel_meme_stage_transitions;
--   DROP TABLE public.intel_meme_stage_snapshots;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature = 'meme_stages';
--   -- and remove the two blocks this migration inserted into app_private.intel_capture_retention (otherwise the
--   -- nightly job errors on its next run against the dropped tables):
--   DO $undo$ DECLARE original text; changed text; BEGIN
--     original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
--     changed  := regexp_replace(original,
--       '\n  -- Added by 20260915030500.*?jsonb_build_object\(''intel_meme_stage_transitions'', n\);\n', E'\n', 'n');
--     IF changed = original THEN RAISE EXCEPTION 'meme_retention_block_not_found'; END IF;
--     EXECUTE changed;
--   END $undo$;
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: meme stage capture tables

-- 1. One row per contract per capture hour, with the stage the provider reported.
CREATE TABLE public.intel_meme_stage_snapshots (
  -- The CoinMarketCap DEX platform id (1 ethereum, 16 solana, 51 arbitrum, 199 base). Not an EVM chain id.
  platform_id integer NOT NULL CHECK (platform_id > 0),
  -- CAIP-style chain, restricted to the shapes the four verified CMC DEX networks use.
  chain text NOT NULL CHECK (chain ~ '^(eip155:[1-9][0-9]*|solana)$'),
  contract_address text NOT NULL CHECK (contract_address ~ '^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  captured_at timestamptz NOT NULL,
  stage text NOT NULL CHECK (stage IN ('newCreations', 'aboutGraduates', 'graduates')),
  name text,
  symbol text,
  -- A price or market cap the provider did not report is NULL. Zero is a real answer and is stored as zero.
  price numeric,
  market_cap numeric,
  -- The first hour we saw this contract in ANY stage. Carried forward on every later snapshot.
  first_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, contract_address, captured_at),
  -- A first sighting cannot be in the future of the capture that records it.
  CONSTRAINT intel_meme_stage_snapshots_first_seen CHECK (first_seen_at <= captured_at),
  CONSTRAINT intel_meme_stage_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[abs(price), abs(market_cap)]), true))
);
-- The read view asks for "every sighting inside the last N days, newest first", optionally for one chain.
CREATE INDEX intel_meme_stage_snapshots_captured_idx ON public.intel_meme_stage_snapshots (captured_at DESC);
CREATE INDEX intel_meme_stage_snapshots_chain_idx ON public.intel_meme_stage_snapshots (chain, captured_at DESC);
-- The cohort denominator asks for "every contract first seen inside the window".
CREATE INDEX intel_meme_stage_snapshots_first_seen_idx ON public.intel_meme_stage_snapshots (first_seen_at DESC);
-- The capture lane asks for "the newest snapshot of THESE contracts before this hour".
CREATE INDEX intel_meme_stage_snapshots_contract_idx ON public.intel_meme_stage_snapshots (chain, contract_address, captured_at DESC);
ALTER TABLE public.intel_meme_stage_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_meme_stage_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_meme_stage_snapshots TO service_role;

-- 2. One row each time a contract's stage differs from its own previous snapshot.
CREATE TABLE public.intel_meme_stage_transitions (
  chain text NOT NULL CHECK (chain ~ '^(eip155:[1-9][0-9]*|solana)$'),
  contract_address text NOT NULL CHECK (contract_address ~ '^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  from_stage text NOT NULL CHECK (from_stage IN ('newCreations', 'aboutGraduates', 'graduates')),
  to_stage text NOT NULL CHECK (to_stage IN ('newCreations', 'aboutGraduates', 'graduates')),
  -- The capture hour at which the new stage was observed. Not a provider event time: the provider publishes none.
  at timestamptz NOT NULL,
  -- Hours between the contract's first sighting and this capture. NULL when the first sighting is unreadable.
  hours_since_first_seen numeric CHECK (hours_since_first_seen IS NULL OR hours_since_first_seen >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, contract_address, at),
  -- A transition always moves. "It stayed where it was" is not a transition.
  CONSTRAINT intel_meme_stage_transitions_moved CHECK (from_stage <> to_stage),
  CONSTRAINT intel_meme_stage_transitions_finite CHECK (coalesce(1e30 >= abs(hours_since_first_seen), true))
);
-- The distribution read asks for "every newCreations -> graduates move inside the window, newest first".
CREATE INDEX intel_meme_stage_transitions_graduation_idx ON public.intel_meme_stage_transitions (to_stage, from_stage, at DESC);
CREATE INDEX intel_meme_stage_transitions_at_idx ON public.intel_meme_stage_transitions (at DESC);
ALTER TABLE public.intel_meme_stage_transitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_meme_stage_transitions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_meme_stage_transitions TO service_role;

-- 3. Cadence policy for the new lane, mirroring the display-currency lane's seed. A later edit to a row wins, so
-- re-running this migration never resets one.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, reason) VALUES
  ('coinmarketcap', 'meme_stages', 3600, true, 'startup', NULL)
ON CONFLICT (provider, feature) DO NOTHING;

-- 4. Retention, PATCHED into the live definition (see the header): 90 days of hourly stage rows and transitions.
-- 90 days is three times the widest window the read offers (30 days) — enough to review a quarter's launches without
-- retaining a year of hourly rows nothing reads.
DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  -- Refuse a second application rather than adding the same DELETE blocks twice.
  IF position('intel_meme_stage_snapshots' in original) > 0 THEN
    RAISE EXCEPTION 'meme_retention_block_already_present';
  END IF;
  -- Exactly one `RETURN removed;` is what makes the insertion point unambiguous. Any other count means the function
  -- is not the one this migration was written against, and guessing at a second anchor is how a lane's horizon gets
  -- lost.
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by 20260915030500 (meme graduation lifecycle). 90 days of hourly stage rows and transitions.\n'
    || E'  DELETE FROM public.intel_meme_stage_snapshots WHERE captured_at < p_now - interval ''90 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_meme_stage_snapshots'', n);\n'
    || E'\n'
    || E'  DELETE FROM public.intel_meme_stage_transitions WHERE at < p_now - interval ''90 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_meme_stage_transitions'', n);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
END $retention$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;

-- 5. Schedule. At :37 past the hour, clear of the :07 hourly batch, the :17 category run and the :23 FX run, so this
-- lane's four calls never queue behind another lane's. The job is idempotent: rows are keyed on the capture hour and
-- upserted, the lane reads only snapshots STRICTLY BEFORE the hour it is writing, and it additionally skips when the
-- newest capture is younger than the feature's cadence_seconds in provider_schedule_policy.
SELECT cron.unschedule('intel-capture-meme-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-meme-hourly');
SELECT cron.schedule('intel-capture-meme-hourly', '37 * * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','meme_stages'), timeout_milliseconds := 60000);
$$);
