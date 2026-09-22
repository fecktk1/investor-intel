-- ============================================================
-- Investor Intel: the RWA asset universe, provider-asserted descriptive profiles, and UNDERLYING REGISTRANTS
-- ============================================================
-- WHY, AND THE DISTINCTION THIS MIGRATION EXISTS TO KEEP
-- ------------------------------------------------------------
-- 20260916150000 built the ISSUER legitimacy graph: who issued a tokenised instrument, answered only by a dated hand
-- assertion in _shared/intel/rwa-issuer-aliases.ts. Three subjects are mapped there, and that is deliberate: a name is
-- not an identifier and a wrong legal entity next to a sanctions pointer is a legal problem, not a styling one.
--
-- A tokenised stock has a SECOND legal question behind it with a DIFFERENT answer. CoinMarketCap publishes a `cik` on
-- /v5/real-world-assets/info for tokenised equities and ETFs, and that filer number belongs to the UNDERLYING LISTED
-- COMPANY (Nvidia's), not to the firm that wrapped the share and sold the wrapper. Pouring those CIKs into
-- intel_rwa_issuer_entities would answer "who issued this token?" with the answer to "what is underneath it?", which is
-- exactly the class of mistake the alias map was written to prevent.
--
-- So this migration creates a SECOND, SEPARATELY NAMED THING. Nothing here writes to any issuer table, and the issuer
-- board is untouched. Its four tables and one view are:
--
--   intel_rwa_asset_map              Every asset in the RWA universe, enumerated through the ZERO-CREDIT `rwaMap`
--                                    capability (which had no caller in this codebase before now). One row per rwa id.
--                                    `profiled_at` is the lane's own resume cursor, which is why it lives here rather
--                                    than being derived by a join on every run.
--
--   intel_rwa_asset_map_counts       TRUE per-type counts for one UTC day: a COUNT of enumerated ids, not the length of
--                                    a list page. intel_rwa_universe_snapshots reports what one 250-row `rwaList` page
--                                    contained, which is a different number and stops at 250; these rows do not.
--                                    MEASURED IN PRODUCTION, the newest snapshot stored at 2026-09-20 14:00 UTC:
--                                    stock 250, etf 250, commodity 4, all 504. Two of those are EXACTLY the page
--                                    ceiling, which is what a capped count looks like, so the true number of tokenised
--                                    equities and of tokenised funds is at least 250 each and is not knowable from that
--                                    table. That is the measurement this table exists to replace.
--
--   intel_rwa_asset_profiles         The descriptive fields CoinMarketCap publishes per asset, INCLUDING the `cik` of
--                                    the underlying company. Recorded as a PROVIDER ASSERTION: `provider`,
--                                    `provider_capability`, `cik_field` and `captured_at` travel with every row and
--                                    `scope` says in words whose filer number it is. It is never our identity claim.
--
--   intel_rwa_underlying_registrants What WE read at SEC EDGAR for that filer number: registrant name, SIC, state of
--                                    incorporation, fiscal year end, and the latest annual, quarterly and current
--                                    report with its date and accession number. Plus the NAME COMPARISON, stored as
--                                    both raw strings, both normalised strings and one verdict.
--
--   intel_rwa_underlying_coverage    A grouped view giving the EXACT coverage numbers ("N of M carry a filer number;
--                                    K confirmed at EDGAR") over the whole universe, so the board's headline is right
--                                    even when its row list is capped.
--
-- HONESTY RULES THE SCHEMA ENFORCES, not merely the lane
-- ------------------------------------------------------------
--   * A PROVIDER ASSERTION IS LABELLED AS ONE. intel_rwa_asset_profiles.scope is NOT NULL with a minimum length, and
--     `cik_field` must be present whenever `cik` is: a filer number with no record of which provider field it came from
--     cannot be stored at all.
--   * A NAME COMPARISON IS EXACT OR IT IS NOTHING. `name_match` is one of exact / contained / differs / unknown. There
--     is no score, no distance and no threshold column, and there never may be one. Both normalised strings are stored
--     so the verdict is reproducible, and 'differs' is a FINDING that the read view surfaces rather than hides.
--   * TWO CLOCKS, NEVER CONFLATED. `captured_at` / `checked_at` / `fetched_at` are OURS. `latest_*_date`,
--     `about_date_added` and `provider_fetched_at` belong to EDGAR or to the provider. No column lets one stand in for
--     the other, and "days since the last periodic filing" is computed in the READ and labelled as our calculation
--     rather than stored as though a source had published it.
--   * NOTHING EXPIRES ON A CLOCK. There is no review date, no renewal column and no validity window anywhere here. A
--     profile is refreshed when the lane reaches it, oldest first, and an unrefreshed row stays true as of the capture
--     time it carries.
--   * NO PERSON MAY BE STORED. `employees` is a count the provider publishes. There is no column that could hold a
--     name, an officer or an address, and the EDGAR reader this lane uses never reads Form D's relatedPersonsList.
--   * ZERO IS A REAL ANSWER. `employees` 0, `asset_count` 0 and `filings_read` 0 are stored as 0. NULL means we do not
--     know, and the read view keeps the two apart.
--
-- WHAT ONE RUN COSTS
-- ------------------------------------------------------------
--   rwa_asset_map               up to 6 asset types x 4 pages = 24 `rwaMap` calls. rwaMap is a ZERO-COST capability
--                               (cmc-capabilities.ts, cost:'zero'), so this op spends 0 credits a run and 0 a day.
--   rwa_asset_profiles          up to 12 `rwaInfo` calls of 50 ids each. The registry prices rwaInfo per 250 ids, so
--                               each call is 1 credit: at most 12 CREDITS A RUN and, at once a day, 12 A DAY. 600
--                               profiles a run works through a universe of a few thousand assets in under a week, and
--                               after the first pass the same 12 calls a day refresh the stalest rows slowly.
--   rwa_underlying_registrants  0 credits. SEC EDGAR is US public domain and keyless. Up to 25 distinct filer numbers a
--                               run, spaced 600 ms apart on top of the shared transport's own 150 ms floor, which is
--                               under two requests a second against a documented ceiling of ten; the op also stops
--                               STARTING reads after 55 seconds of wall clock and the next run resumes where it left.
--
-- REQUIRED SETTING FOR THE THIRD OP: SEC_EDGAR_USER_AGENT
-- ------------------------------------------------------------
-- data.sec.gov answers HTTP 403 without a descriptive User-Agent. The shared transport refuses such a call BEFORE
-- issuing it and names the reason `user_agent_required`, so a missing agent is an honest failure rather than an empty
-- registrant list. This is the SAME setting 20260916150000 already documents; if the issuer lane is reading EDGAR
-- today, this lane needs nothing new.
--
-- RETENTION: nothing to add. All four tables are keyed on an identity (rwa_id, or asset_type plus a UTC day) and are
-- upserted in place, so they do not grow with time the way an hourly snapshot table does. app_private.intel_capture_
-- retention is therefore NOT patched by this migration. intel_rwa_asset_map_counts adds one row per asset type per day
-- (seven rows a day including the 'all' row), which is a few thousand rows a decade.
--
-- Idempotent: every CREATE is IF NOT EXISTS or OR REPLACE, the policy rows are ON CONFLICT DO NOTHING, and each cron
-- job is unscheduled by name before it is scheduled. Validated offline with pglast. NOT APPLIED by this change.
--
-- ROLLBACK
--   SELECT cron.unschedule('intel-capture-rwa-asset-map-daily');
--   SELECT cron.unschedule('intel-capture-rwa-asset-profiles-daily');
--   SELECT cron.unschedule('intel-capture-rwa-underlying-registrants-daily');
--   UPDATE public.provider_schedule_policy SET enabled = false
--     WHERE feature IN ('rwa_asset_map','rwa_asset_profiles','rwa_underlying_registrants');
--   -- and, only if the rows must go too:
--   DROP VIEW  IF EXISTS public.intel_rwa_underlying_coverage;
--   DROP TABLE IF EXISTS public.intel_rwa_underlying_registrants;
--   DROP TABLE IF EXISTS public.intel_rwa_asset_profiles;
--   DROP TABLE IF EXISTS public.intel_rwa_asset_map_counts;
--   DROP TABLE IF EXISTS public.intel_rwa_asset_map;
--   DELETE FROM public.provider_schedule_policy WHERE feature IN ('rwa_asset_map','rwa_asset_profiles','rwa_underlying_registrants');
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION 1: the enumerated universe

-- 1. One row per RWA asset, from the zero-credit `rwaMap` capability. `has_tokens` is NULLABLE on purpose: it decides
-- whether the profile op will ever ask about this asset, so an absent provider field stays unknown rather than becoming
-- a false that would silently drop the asset from the queue for good.
CREATE TABLE IF NOT EXISTS public.intel_rwa_asset_map (
  rwa_id bigint PRIMARY KEY CHECK (rwa_id >= 1),
  slug text CHECK (slug IS NULL OR length(slug) <= 120),
  symbol text CHECK (symbol IS NULL OR length(symbol) <= 40),
  name text CHECK (name IS NULL OR length(name) <= 300),
  asset_type text CHECK (asset_type IS NULL OR length(asset_type) <= 40),
  has_tokens boolean,
  rwa_rank integer CHECK (rwa_rank IS NULL OR rwa_rank >= 0),
  -- Which capability enumerated this row, so the universe can always name its source.
  map_source text NOT NULL DEFAULT 'coinmarketcap:rwaMap' CHECK (length(map_source) BETWEEN 1 AND 60),
  -- THE LANE'S RESUME CURSOR. NULL means never profiled, which is why the queue orders nulls first. It is not an
  -- expiry: a row with an old stamp is simply next in line, never invalid.
  profiled_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
-- The queue read: assets NOT KNOWN TO LACK TOKENS, never profiled first, then the stalest. `IS NOT FALSE` rather than
-- `IS TRUE` on purpose: a NULL means the `rwaMap` row did not carry the field, and an `IS TRUE` queue would then be
-- empty for ever while the lane looked enabled and healthy. Asking `rwaInfo` about such an asset costs one id in a
-- batch and settles the question, because its response does carry `has_tokens`.
CREATE INDEX IF NOT EXISTS intel_rwa_asset_map_queue_idx ON public.intel_rwa_asset_map (profiled_at NULLS FIRST, rwa_id) WHERE has_tokens IS NOT FALSE;
CREATE INDEX IF NOT EXISTS intel_rwa_asset_map_type_idx ON public.intel_rwa_asset_map (asset_type, rwa_rank);
ALTER TABLE public.intel_rwa_asset_map ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_asset_map FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_asset_map TO service_role;

-- 2. TRUE per-type counts for one UTC day. These are a COUNT of enumerated ids. intel_rwa_universe_snapshots.asset_count
-- reports what one 250-row `rwaList` page held, which is a different figure and cannot exceed 250; these rows can.
CREATE TABLE IF NOT EXISTS public.intel_rwa_asset_map_counts (
  -- 'all' is the aggregate row, exactly as intel_rwa_universe_snapshots uses it.
  asset_type text NOT NULL CHECK (length(asset_type) BETWEEN 1 AND 40),
  snapshot_date date NOT NULL,
  asset_count integer NOT NULL CHECK (asset_count >= 0),
  with_tokens_count integer NOT NULL CHECK (with_tokens_count >= 0),
  map_source text NOT NULL DEFAULT 'coinmarketcap:rwaMap' CHECK (length(map_source) BETWEEN 1 AND 60),
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_type, snapshot_date),
  -- An asset cannot carry tokens without being an asset.
  CONSTRAINT intel_rwa_asset_map_counts_bounded CHECK (with_tokens_count <= asset_count)
);
CREATE INDEX IF NOT EXISTS intel_rwa_asset_map_counts_recent_idx ON public.intel_rwa_asset_map_counts (snapshot_date DESC, asset_type);
ALTER TABLE public.intel_rwa_asset_map_counts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_asset_map_counts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_asset_map_counts TO service_role;

-- SECTION 2: provider-asserted descriptive profiles

-- 3. The descriptive fields CoinMarketCap publishes per asset. The `cik` here is the filer number of the UNDERLYING
-- LISTED COMPANY as the PROVIDER ASSERTS IT. The constraint below refuses a CIK with no record of which provider field
-- carried it, and `scope` is NOT NULL with a minimum length because a filer number displayed without saying whose it is
-- invites exactly the confusion this table exists to prevent.
CREATE TABLE IF NOT EXISTS public.intel_rwa_asset_profiles (
  rwa_id bigint PRIMARY KEY CHECK (rwa_id >= 1),
  provider text NOT NULL DEFAULT 'coinmarketcap' CHECK (length(provider) BETWEEN 1 AND 40),
  provider_capability text NOT NULL DEFAULT 'rwaInfo' CHECK (length(provider_capability) BETWEEN 1 AND 40),
  slug text CHECK (slug IS NULL OR length(slug) <= 120),
  symbol text CHECK (symbol IS NULL OR length(symbol) <= 40),
  name text CHECK (name IS NULL OR length(name) <= 300),
  asset_type text CHECK (asset_type IS NULL OR length(asset_type) <= 40),
  cik text CHECK (cik IS NULL OR cik ~ '^[0-9]{10}$'),
  -- The provider field the CIK came from, e.g. 'cik' on rwaInfo.
  cik_field text CHECK (cik_field IS NULL OR length(cik_field) <= 40),
  industry text CHECK (industry IS NULL OR length(industry) <= 200),
  -- As published: a year, or a date, or a phrase. Not parsed into a date, because the provider does not promise one.
  founded text CHECK (founded IS NULL OR length(founded) <= 40),
  -- 0 is a real published count. NULL means the provider published none.
  employees integer CHECK (employees IS NULL OR employees >= 0),
  primary_exchange text CHECK (primary_exchange IS NULL OR length(primary_exchange) <= 120),
  rwa_rank integer CHECK (rwa_rank IS NULL OR rwa_rank >= 0),
  has_tokens boolean,
  -- https only. An http image on an https page is a broken image and a mixed-content warning, not a logo.
  logo_url text CHECK (logo_url IS NULL OR logo_url ~ '^https://'),
  website text CHECK (website IS NULL OR website ~ '^https://'),
  description text CHECK (description IS NULL OR length(description) <= 20000),
  -- The provider's own clock for when it added the asset. Never presented as our capture time.
  about_date_added timestamptz,
  -- OURS: when this row was captured.
  captured_at timestamptz NOT NULL,
  -- The provider's transport clock for the response this row came from.
  provider_fetched_at timestamptz,
  -- The EDGAR half's resume cursor. NULL means never checked; it is not an expiry.
  registrant_checked_at timestamptz,
  scope text NOT NULL CHECK (length(scope) BETWEEN 80 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A filer number may not be stored without recording which provider field asserted it.
  CONSTRAINT intel_rwa_asset_profiles_cik_attributed CHECK (cik IS NULL OR cik_field IS NOT NULL)
);
-- The EDGAR queue read: profiles carrying a CIK, never checked first, then the stalest.
CREATE INDEX IF NOT EXISTS intel_rwa_asset_profiles_registrant_queue_idx ON public.intel_rwa_asset_profiles (registrant_checked_at NULLS FIRST, rwa_id) WHERE cik IS NOT NULL;
CREATE INDEX IF NOT EXISTS intel_rwa_asset_profiles_cik_idx ON public.intel_rwa_asset_profiles (cik) WHERE cik IS NOT NULL;
CREATE INDEX IF NOT EXISTS intel_rwa_asset_profiles_rank_idx ON public.intel_rwa_asset_profiles (rwa_rank NULLS LAST, rwa_id);
ALTER TABLE public.intel_rwa_asset_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_asset_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_asset_profiles TO service_role;

-- SECTION 3: what we read at EDGAR ourselves

-- 4. One row per tokenised asset whose provider-asserted filer number we looked up. `state` distinguishes the three
-- honest outcomes: EDGAR answered with a readable filer record; EDGAR HAS NO SUCH FILER, which is a finding about the
-- provider's assertion and must not look like a failed read; or EDGAR did not answer, which is our problem and not the
-- registrant's.
CREATE TABLE IF NOT EXISTS public.intel_rwa_underlying_registrants (
  rwa_id bigint PRIMARY KEY REFERENCES public.intel_rwa_asset_profiles (rwa_id) ON DELETE CASCADE,
  cik text NOT NULL CHECK (cik ~ '^[0-9]{10}$'),
  state text NOT NULL CHECK (state IN ('known','not_found','unavailable')),
  reason text CHECK (reason IS NULL OR length(reason) <= 120),
  -- The registrant name AS EDGAR PUBLISHES IT. Null when EDGAR has no such filer.
  registrant_name text CHECK (registrant_name IS NULL OR length(registrant_name) <= 500),
  sic text CHECK (sic IS NULL OR sic ~ '^[0-9]{1,10}$'),
  sic_description text CHECK (sic_description IS NULL OR length(sic_description) <= 200),
  state_of_incorporation text CHECK (state_of_incorporation IS NULL OR length(state_of_incorporation) <= 20),
  -- As EDGAR publishes it, MMDD (e.g. '0131'). Not coerced to a date: it is a recurring day, not an instant.
  fiscal_year_end text CHECK (fiscal_year_end IS NULL OR fiscal_year_end ~ '^[0-9-]{1,8}$'),
  -- The filer's own reported exchanges and tickers, kept BESIDE the provider's primary_exchange rather than merged.
  exchanges text[],
  tickers text[],
  latest_annual_form text CHECK (latest_annual_form IS NULL OR length(latest_annual_form) <= 20),
  latest_annual_date date,
  latest_annual_accession text CHECK (latest_annual_accession IS NULL OR latest_annual_accession ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  latest_quarterly_form text CHECK (latest_quarterly_form IS NULL OR length(latest_quarterly_form) <= 20),
  latest_quarterly_date date,
  latest_quarterly_accession text CHECK (latest_quarterly_accession IS NULL OR latest_quarterly_accession ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  latest_current_form text CHECK (latest_current_form IS NULL OR length(latest_current_form) <= 20),
  latest_current_date date,
  latest_current_accession text CHECK (latest_current_accession IS NULL OR latest_current_accession ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  -- How many periodic filings the read actually saw. 0 is a real answer.
  filings_read integer NOT NULL DEFAULT 0 CHECK (filings_read >= 0),
  -- THE COMPARISON. Both raw strings and both normalised strings are stored, so the verdict is reproducible and a
  -- mismatch is legible. 'contained' is CONTAINMENT of one normalised string in the other and is never an identity
  -- claim; there is deliberately no score, no distance and no threshold column here.
  asset_name text CHECK (asset_name IS NULL OR length(asset_name) <= 300),
  registrant_name_normalized text CHECK (registrant_name_normalized IS NULL OR length(registrant_name_normalized) <= 300),
  asset_name_normalized text CHECK (asset_name_normalized IS NULL OR length(asset_name_normalized) <= 300),
  name_match text NOT NULL CHECK (name_match IN ('exact','contained','differs','unknown')),
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  -- When WE read EDGAR. Never presented as a filing date.
  fetched_at timestamptz NOT NULL,
  checked_at timestamptz NOT NULL,
  scope text NOT NULL CHECK (length(scope) BETWEEN 80 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A name verdict may only be claimed when both normalised names are present.
  CONSTRAINT intel_rwa_underlying_name_verdict CHECK (
    name_match = 'unknown' OR (registrant_name_normalized IS NOT NULL AND asset_name_normalized IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS intel_rwa_underlying_registrants_cik_idx ON public.intel_rwa_underlying_registrants (cik);
-- The interesting row is the one that has not filed for a long time, so the periodic dates are indexed oldest first.
CREATE INDEX IF NOT EXISTS intel_rwa_underlying_registrants_periodic_idx ON public.intel_rwa_underlying_registrants (latest_quarterly_date NULLS FIRST, latest_annual_date NULLS FIRST);
CREATE INDEX IF NOT EXISTS intel_rwa_underlying_registrants_match_idx ON public.intel_rwa_underlying_registrants (name_match);
ALTER TABLE public.intel_rwa_underlying_registrants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_underlying_registrants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_underlying_registrants TO service_role;

-- SECTION 4: exact coverage

-- 5. The coverage aggregate. The board states "N of M tokenised equities and funds carry a filer number from
-- CoinMarketCap; K confirmed against EDGAR", and that sentence must be true about the WHOLE universe rather than about
-- the capped list underneath it. Grouping in the database is how it stays true.
--
-- security_invoker = true so the view carries the CALLER's privileges rather than the owner's: the underlying tables are
-- service-role only and a definer-rights view over them would be a way around that.
--
-- The WHERE clause counts assets NOT KNOWN TO LACK TOKENS. `intel_rwa_asset_map.has_tokens` is NULL when the map row did
-- not carry the field, and `rwaInfo` (which does carry it) overrides the map once a profile exists. So an asset the
-- provider's own info endpoint says has no tokens is excluded, and one nobody has answered for yet is counted, which is
-- the same rule the profile queue uses.
CREATE OR REPLACE VIEW public.intel_rwa_underlying_coverage
  WITH (security_invoker = true) AS
SELECT
  m.asset_type,
  count(*)                                                        AS tokenised_count,
  count(p.rwa_id)                                                 AS profiled_count,
  count(p.cik)                                                    AS with_cik_count,
  count(r.rwa_id) FILTER (WHERE r.state = 'known')                AS registrant_known_count,
  count(r.rwa_id) FILTER (WHERE r.state = 'not_found')             AS registrant_not_found_count,
  count(r.rwa_id) FILTER (WHERE r.state = 'unavailable')           AS registrant_unavailable_count,
  count(r.rwa_id) FILTER (WHERE r.name_match = 'differs')          AS name_differs_count,
  max(p.captured_at)                                              AS newest_profile_at,
  max(r.checked_at)                                               AS newest_registrant_at
FROM public.intel_rwa_asset_map m
LEFT JOIN public.intel_rwa_asset_profiles p ON p.rwa_id = m.rwa_id
LEFT JOIN public.intel_rwa_underlying_registrants r ON r.rwa_id = m.rwa_id
WHERE m.has_tokens IS NOT FALSE AND coalesce(p.has_tokens, true) IS NOT FALSE
GROUP BY m.asset_type;
REVOKE ALL ON public.intel_rwa_underlying_coverage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.intel_rwa_underlying_coverage TO service_role;

-- SECTION 5: schedule policy

-- 6. One row per op. A later edit to a row wins, so re-running never resets one.
--
--   rwa_asset_map               provider 'coinmarketcap'. rwaMap is a ZERO-COST capability, so this row's max_credits
--                               is 0 and that is a fact rather than an omission.
--   rwa_asset_profiles          provider 'coinmarketcap'. max_credits 12 is this lane's STANDING per-run credit
--                               ceiling: 12 rwaInfo calls of 50 ids, priced by the registry at 1 credit each.
--   rwa_underlying_registrants  provider 'primary-sources', like the issuer lane: SEC EDGAR is keyless US public domain
--                               and spends no credit. `loadSchedulePolicy` in capture-jobs.ts reads only 'coinmarketcap'
--                               rows, so the lane reads this row itself, which is what makes enabled = false here
--                               actually stop it. max_credits 25 is its PER-RUN FILER ceiling, not a credit balance.
--
-- min_plan is NULL on all three. The CMC plan tier gates a capability, not a lane, and rwaInfo is available on this
-- account's plan; the transport still refuses a capability above the plan with its own recorded reason.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, max_credits, reason) VALUES
  ('coinmarketcap', 'rwa_asset_map', 86400, true, NULL, 0,
   'Daily enumeration of the whole RWA universe through the zero-credit rwaMap capability, with true per-type counts. Spends no credits: rwaMap is cost zero in cmc-capabilities.ts.'),
  ('coinmarketcap', 'rwa_asset_profiles', 86400, true, NULL, 12,
   'Daily descriptive profiles for tokenised assets through rwaInfo, 12 calls of 50 ids a run, oldest-profiled first so the universe is worked through over several days and then refreshed slowly. max_credits 12 is the per-run credit ceiling.'),
  ('primary-sources', 'rwa_underlying_registrants', 86400, true, NULL, 25,
   'Daily SEC EDGAR submissions reads for the underlying filer numbers CoinMarketCap asserts. Keyless and free, so max_credits 25 is a per-run FILER ceiling and not a credit balance. Requires SEC_EDGAR_USER_AGENT.')
ON CONFLICT (provider, feature) DO NOTHING;

-- SECTION 6: schedule

-- 7. Three daily jobs, in dependency order and far enough apart that each sees the previous one's rows: the map at
-- 03:11 fills the profile queue, the profiles at 03:29 fill the EDGAR queue, and the EDGAR reads run at 03:47. They sit
-- after the issuer lane's 02:19 and 02:53 and share no minute with it. Each job is idempotent: every write is an upsert
-- keyed on an identity, and each op advances its own resume cursor so a repeated run moves forward rather than
-- re-reading the same rows.
-- The timeout is 110 seconds, matching the Edge Function's own 100 second work budget with headroom.

SELECT cron.unschedule('intel-capture-rwa-asset-map-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rwa-asset-map-daily');
SELECT cron.schedule('intel-capture-rwa-asset-map-daily', '11 3 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rwa_asset_map'), timeout_milliseconds := 110000);
$$);

SELECT cron.unschedule('intel-capture-rwa-asset-profiles-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rwa-asset-profiles-daily');
SELECT cron.schedule('intel-capture-rwa-asset-profiles-daily', '29 3 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rwa_asset_profiles'), timeout_milliseconds := 110000);
$$);

SELECT cron.unschedule('intel-capture-rwa-underlying-registrants-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rwa-underlying-registrants-daily');
SELECT cron.schedule('intel-capture-rwa-underlying-registrants-daily', '47 3 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rwa_underlying_registrants'), timeout_milliseconds := 110000);
$$);
