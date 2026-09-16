-- ============================================================
-- Investor Intel: maker swap flow (the DEX swap tape, per account)
-- ============================================================
-- Two new capture tables behind the `maker_flow` view of the `intel-research` Edge Function. No cron job, no alert
-- arm, no new RPC: capture is ON DEMAND from the contract workspace and bounded at eight provider calls per hour per
-- contract.
--
--   intel_swap_flow_snapshots  One MAKER ACCOUNT's swap flow for one contract at one sweep hour: how much of this
--                              contract's token moved into and out of that account across the swaps the sweep read,
--                              in USD and in token quantity, with the count of swaps behind each side. One row per
--                              account per sweep.
--
--   intel_swap_flow_captures   What ONE sweep actually covered: how many pages were walked, how many swaps were read,
--                              how many of them named a maker at all, the oldest and newest swap it saw, and whether
--                              the provider ran out of tape before our ceiling did. One row per sweep.
--
-- Both are service-role only, exactly like every other capture table: reads go through `intel-research`
-- `{capability:'dexContext', params:{view:'maker_flow'}}`, never through PostgREST.
--
-- WHY THE SECOND TABLE EXISTS. It is not bookkeeping. `/v1/dex/tokens/transactions` is a cursor-paged tape with no
-- published total, so a sweep always stops somewhere: because the provider ran out of rows, or because OUR page
-- ceiling or credit budget ran out first. Those two endings mean completely different things about the same data. A
-- "first touch" is only a first touch if the sweep reached the end of the tape; otherwise it is the earliest swap in
-- the part we chose to read. The coverage row is what lets the read view tell the reader which of the two it is
-- looking at, instead of quietly presenting a bounded sample as a complete history.
--
-- TWO CLOCKS, NEVER MIXED.
--   `captured_at` is OUR clock: the hour WE swept, truncated to the hour by a CHECK constraint the capture lane
--   cannot talk its way around. Flooring is what makes a retried or double-clicked refresh inside one hour land on
--   the same primary key instead of inventing a second sweep of the same tape.
--   `first_event_at`, `last_event_at`, `oldest_event_at` and `newest_event_at` are the PROVIDER's own swap
--   timestamps. Unlike `/v1/dex/holders/tag_count` and `/v1/dex/holders/list`, the swap tape DOES date its rows, so
--   these are real observation times and are stored as such. A sweep time is never presented as a swap time.
--
-- WHAT A MAKER ROW IS, AND IS NOT.
--   It is one public on-chain ACCOUNT that the provider attributed at least one swap of this contract to, inside the
--   pages this sweep read. It is not a holder, not a trader ranking, not a whole history and not a person. An address
--   here is an address: no ENS name, no exchange label, no social handle, no clustering, no ownership claim, and
--   there is deliberately no column in this table in which such a thing could be recorded.
--   The provider's `f` (sender) and `pa` (pool) are NOT captured. Keeping a second account beside the maker is how
--   address linking starts, and this platform does not relate accounts to each other.
--   A swap the provider attributed to no maker is counted in `swaps_seen` on the coverage row and belongs to no
--   account row. It is never bundled into an "unknown account" bucket: one invented account standing in for many
--   real ones would be a fabricated participant.
--
-- WHAT `acquired` AND `disposed` MEAN.
--   Probed live on 2026-09-16 against /v1/dex/tokens/transactions: each swap row states a direction PER LEG in
--   `t0pt`/`t1pt`, observed as "reduce" and "add". On the probed row the queried token was the base leg, `tp` was
--   "sell", `t0pt` was "reduce" and `t1pt` was "add": the maker gave up the queried token and received the other.
--   So "reduce" on the subject's own leg is `disposed_*` and "add" is `acquired_*`, and the direction is READ from
--   the provider rather than deduced from anything.
--   FALLBACK, used only when the provider states nothing for the subject's leg: the older reading of `tp`, which
--   classifies the trade against the BASE leg, so a subject that is the quote leg inverts it. That fallback is an
--   INTERPRETATION, not a provider statement; the 2026-09-16 probe showed the two agreeing on that row, which is
--   supporting evidence and not a guarantee. The leg vocabulary is undocumented, so a word that is neither "add" nor
--   "reduce" drops to the fallback rather than being read as a direction.
--   Both live in one named function (`swapDirection` in supabase/functions/_shared/intel/swap-flow.ts), the read view
--   states them in words and the UI repeats them. Anything neither can place lands in `unclassified_*` rather than
--   being forced onto a side.
--   These columns describe how a token MOVED. They are not intent, not strategy, not skill and not advice.
--
-- OTHER HONESTY RULES THE SCHEMA ENFORCES:
--   * A figure we could not read is NULL. Zero is a real answer and is stored as zero; it never stands in for
--     "unknown". That is why every `_usd` and `_qty` column is nullable while the counts are NOT NULL: a count
--     exists because a swap was counted.
--   * `acquired_qty` / `disposed_qty` are quantities of THIS contract's token, taken from whichever leg is this
--     contract. A leg the provider did not report is NULL, not zero.
--   * `exhausted` is NOT NULL and defaults to false: "we do not know whether we reached the end" must never read as
--     "we reached the end". The safe direction is the one that makes a first-touch claim weaker, not stronger.
--   * No column is signed except by arithmetic done at read time: the net is computed from the two sides so that an
--     account with an unreadable side keeps the side that WAS readable.
--
-- Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass.
--
-- Credits per refresh (upper bound; a fresh shared cache costs 0):
--   1 x dexSwaps per page walked, at most 8. `dexSwaps` is a Startup capability; below Startup the view answers
-- `plan_below_startup` and spends nothing, the way `dexHolderTags` does for the holder-tag board.
--
-- Retention: 180 days on both tables, SPLICED into app_private.intel_capture_retention below, which stays pg_cron only.
-- This migration does NOT restate that function. An earlier draft of this file did, rebuilt from the text of
-- 20260915034326_intel_holder_tags, and that silently dropped four blocks later lanes had added to the LIVE
-- definition: intel_chart_working_states, market_asset_candles, intel_meme_stage_snapshots and
-- intel_meme_stage_transitions. market_asset_candles is the archive behind the chart workstation, so the restatement
-- would have stopped its retention with no error and no warning anywhere. See section 4 for the guarded splice and
-- for why splicing is what lets this migration compose with agent/intel-rwa-yield in either merge order.
--
-- Safe to apply anytime; idempotent. There is nothing to schedule and no live function body to patch.
--
-- ROLLBACK
--   -- stop the lane, keep the data (the view then answers with retained sweeps only and never refreshes):
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'coinmarketcap' AND feature = 'swap_flow';
--   -- drop the data too:
--   DROP TABLE public.intel_swap_flow_snapshots;
--   DROP TABLE public.intel_swap_flow_captures;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature = 'swap_flow';
--   -- and remove ONLY the block this migration spliced into app_private.intel_capture_retention (otherwise the
--   -- nightly job errors on its next run against the dropped tables). Removing just this block leaves every other
--   -- lane's retention untouched, which is the whole point of splicing rather than restating:
--   --   DO $r$ DECLARE original text; changed text; BEGIN
--   --     original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
--   --     changed  := regexp_replace(original,
--   --       '\n[ \t]*-- Added by 20260916104500.*?jsonb_build_object\(''intel_swap_flow_captures'', n\);\n', E'\n', 'ns');
--   --     IF changed = original THEN RAISE EXCEPTION 'swap_flow_retention_block_not_found'; END IF;
--   --     EXECUTE changed;
--   --   END $r$;
--   -- Retained `swap_event_usd` observations in intel_market_observations are untouched by this rollback; they
--   -- expire on their own retain_until.
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: maker swap-flow capture tables

-- 1. The per-account flow. One row per maker account per sweep hour, for one exact contract.
-- Only CoinMarketCap writes here, so there is no provider column to disagree with.
CREATE TABLE public.intel_swap_flow_snapshots (
  -- CAIP-style chain, restricted to the shapes the four verified CMC DEX networks use (ethereum, base, arbitrum, solana).
  chain text NOT NULL CHECK (chain ~ '^(eip155:[1-9][0-9]*|solana)$'),
  contract_address text NOT NULL CHECK (contract_address ~ '^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  -- OUR clock, floored to the hour. `date_trunc(text, timestamp)` is immutable; the timezone round-trip keeps the
  -- expression immutable and anchored to UTC, so the constraint holds whatever the session TimeZone happens to be.
  captured_at timestamptz NOT NULL CHECK (captured_at = date_trunc('hour', captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  -- An ACCOUNT. There is deliberately no column in this table for a name, a label, a handle or an entity, and no
  -- second address column in which a sender, a pool or a counterparty could be related to this one.
  maker_address text NOT NULL CHECK (maker_address ~ '^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  -- Swaps in which this contract's token moved INTO the account, per the direction rule documented above.
  acquired_count integer NOT NULL DEFAULT 0 CHECK (acquired_count >= 0),
  acquired_usd numeric CHECK (acquired_usd IS NULL OR acquired_usd >= 0),
  acquired_qty numeric CHECK (acquired_qty IS NULL OR acquired_qty >= 0),
  -- Swaps in which it moved OUT of the account.
  disposed_count integer NOT NULL DEFAULT 0 CHECK (disposed_count >= 0),
  disposed_usd numeric CHECK (disposed_usd IS NULL OR disposed_usd >= 0),
  disposed_qty numeric CHECK (disposed_qty IS NULL OR disposed_qty >= 0),
  -- Swaps the direction rule could not place. Counted and valued, never forced onto a side.
  unclassified_count integer NOT NULL DEFAULT 0 CHECK (unclassified_count >= 0),
  unclassified_usd numeric CHECK (unclassified_usd IS NULL OR unclassified_usd >= 0),
  -- Every swap attributed to this account in the sweep, and how many of those the provider itself marks excluded.
  swaps integer NOT NULL DEFAULT 0 CHECK (swaps >= 0),
  excluded_count integer NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
  -- The PROVIDER's swap timestamps: the earliest and latest swap of this account inside the swept pages. They date
  -- swaps, not the sweep, and they are not ordered by a constraint: the provider controls what it sends and one odd
  -- pair must not reject a whole sweep.
  first_event_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, contract_address, captured_at, maker_address),
  CONSTRAINT intel_swap_flow_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(acquired_usd), abs(acquired_qty), abs(disposed_usd), abs(disposed_qty), abs(unclassified_usd)]), true))
);
-- The contract + sweep reads are served by the primary key's leading columns. This index exists for retention,
-- which sweeps by capture time across every contract.
CREATE INDEX intel_swap_flow_snapshots_captured_idx ON public.intel_swap_flow_snapshots (captured_at);
ALTER TABLE public.intel_swap_flow_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_swap_flow_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_swap_flow_snapshots TO service_role;

-- 2. What the sweep covered. One row per sweep; this is the row that makes a first-touch claim honest.
CREATE TABLE public.intel_swap_flow_captures (
  chain text NOT NULL CHECK (chain ~ '^(eip155:[1-9][0-9]*|solana)$'),
  contract_address text NOT NULL CHECK (contract_address ~ '^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  captured_at timestamptz NOT NULL CHECK (captured_at = date_trunc('hour', captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  -- Pages of 25 swaps actually walked, bounded by the lane's own ceiling.
  pages integer NOT NULL DEFAULT 0 CHECK (pages >= 0 AND pages <= 64),
  swaps_seen integer NOT NULL DEFAULT 0 CHECK (swaps_seen >= 0),
  -- Of those, how many named a maker at all. The difference between the two is the honest count of swaps that could
  -- not enter any cohort, and it is shown rather than absorbed.
  swaps_with_maker integer NOT NULL DEFAULT 0 CHECK (swaps_with_maker >= 0),
  makers integer NOT NULL DEFAULT 0 CHECK (makers >= 0),
  oldest_event_at timestamptz,
  newest_event_at timestamptz,
  -- TRUE only when the provider ran out of tape before our ceiling did. Defaults to false so that an unknown ending
  -- can never read as a complete one.
  exhausted boolean NOT NULL DEFAULT false,
  -- Why the walk ended: provider_exhausted, page_ceiling, call_budget, cursor_repeated, no_reported_swaps, or the
  -- provider's own reason. Free text is capped; it names a condition, never a person.
  stop_reason text CHECK (stop_reason IS NULL OR length(stop_reason) <= 60),
  credits integer NOT NULL DEFAULT 0 CHECK (credits >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, contract_address, captured_at),
  CONSTRAINT intel_swap_flow_captures_maker_subset CHECK (swaps_with_maker <= swaps_seen)
);
CREATE INDEX intel_swap_flow_captures_captured_idx ON public.intel_swap_flow_captures (captured_at);
ALTER TABLE public.intel_swap_flow_captures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_swap_flow_captures FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_swap_flow_captures TO service_role;

-- 3. The lane's on/off switch. There is NO cron schedule for maker flow: the sweep runs when a member opens the
-- contract workspace and asks for it, and skips inside its own hour. `cadence_seconds` is recorded as the hour the
-- lane already enforces, so an operator reading the policy table sees the real cadence; `enabled = false` stops the
-- lane and leaves the view reading retained sweeps. A later edit to a row wins, so re-running this never resets one.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, reason) VALUES
  ('coinmarketcap', 'swap_flow', 3600, true, 'startup', 'On demand from the contract workspace; no cron schedule.')
ON CONFLICT (provider, feature) DO NOTHING;

-- 4. Retention, SPLICED into the live definition rather than restated.
--
-- WHY NOT A RESTATEMENT. A CREATE OR REPLACE is the WHOLE function body, so restating it from any migration file
-- silently deletes every block added to the live function after that file was written. An earlier draft of this
-- migration did exactly that and would have stopped retention on four live lanes, the candle archive among them,
-- without raising anything. A lost DELETE block means that lane's table grows without bound, and nothing reports it.
--
-- IT IS ALSO WHAT MAKES THIS COMPOSE WITH OTHER BRANCHES. agent/intel-rwa-yield splices three blocks of its own into
-- the same function. A restatement rewrites the entire body while a splice edits it, so git reports NO conflict
-- between them and whichever branch merged second silently wins: a restatement landing last erases the other branch's
-- blocks, and landing first has its own erased. Splicing removes that entirely, because each migration only ever
-- inserts its own block and reads whatever is already there. Applying this migration and rwa-yield in either order
-- ends with every block present.
--
-- The technique is copied from 20260915171001_intel_chart_working_state and 20260916120000_intel_rwa_yield_provenance.
--
-- GUARDS.
--   * If the anchor is not EXACTLY one `RETURN removed;`, it RAISES. The function is then not the one this migration
--     was written against, and guessing at a second anchor is how a lane's horizon gets lost.
--   * If the splice would not change the text, it RAISES rather than reporting a success it did not achieve.
--   * If this lane's block is already present it returns without touching anything, so a re-run is harmless. That is
--     a deliberate difference from the two migrations above, which raise on a second application: an idempotent
--     re-run lets this file be re-applied after a partially completed deploy without an operator having to work out
--     whether it already ran.
DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  -- Already spliced: do nothing rather than add the same DELETE blocks a second time.
  IF position('intel_swap_flow_snapshots' in original) > 0 THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by 20260916104500 (maker swap flow). 180 days, twice the widest window the reads offer.\n'
    || E'  -- The per-account table goes first: it is the larger one and the one whose rows are addresses.\n'
    || E'  DELETE FROM public.intel_swap_flow_snapshots WHERE captured_at < p_now - interval ''180 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_swap_flow_snapshots'', n);\n'
    || E'\n'
    || E'  DELETE FROM public.intel_swap_flow_captures WHERE captured_at < p_now - interval ''180 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_swap_flow_captures'', n);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
END $retention$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;
