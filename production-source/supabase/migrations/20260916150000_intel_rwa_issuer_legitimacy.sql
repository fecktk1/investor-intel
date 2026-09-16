-- ============================================================
-- Investor Intel: RWA issuer legitimacy graph, admission reality and holder concentration
-- ============================================================
-- Six service-role-only tables behind the `rwa_issuer_legitimacy` read view of the `intel-capture` Edge Function.
-- They answer "can I legally invest in this?" from PRIMARY SOURCES with dated provenance, rather than from a
-- hand-curated registry that is wrong the day it ships.
--
--   intel_rwa_issuer_entities            One resolved legal entity, as a register publishes it: its LEI record from
--                                        GLEIF and/or its EDGAR filer identity. Written ONLY for an issuer that a
--                                        dated assertion in _shared/intel/rwa-issuer-aliases.ts has mapped. There is
--                                        no row for a guess.
--
--   intel_rwa_issuer_admission_filings   One Form D per row: the admission terms a filer stated on a date. This is the
--                                        TIME SERIES, not a snapshot. Older filings are never rewritten by newer ones.
--
--   intel_rwa_issuer_admission_drift     One dated difference between two consecutive filings. This table is the
--                                        feature: it is what a curated registry structurally cannot hold.
--
--   intel_rwa_issuer_risk_signals        Registration-status and sanctions POINTERS. Every row carries a scope string
--                                        saying what it does not mean, and the constraint below refuses a row without
--                                        one.
--
--   intel_rwa_token_concentration        Top-N share of reported supply from a block explorer, per capture hour.
--
--   intel_rwa_token_restrictions         What a token's VERIFIED SOURCE shows its code can do: KYC gating, pause,
--                                        freeze.
--
-- ============================================================
-- REQUIRED SETTING BEFORE THIS FEATURE DOES ANYTHING: SEC_EDGAR_USER_AGENT
-- ============================================================
-- data.sec.gov answers HTTP 403 to a request with no descriptive User-Agent (confirmed 2026-09-16). The
-- `rwa_issuer_registry` lane therefore refuses to call EDGAR until the `SEC_EDGAR_USER_AGENT` environment variable is
-- set on the `intel-capture` Edge Function, and reports `user_agent_required` instead. This is a DEPLOYMENT
-- PREREQUISITE, not a defect: until it is set, no Form D is read, no admission time series is built and no drift is
-- recorded, and the read view will show mapped issuers with an empty admission history.
--
-- Set it to a descriptive identifier with a real contact, which is what the SEC asks for, for example:
--   supabase secrets set SEC_EDGAR_USER_AGENT="TheContentForge-InvestorIntel/1.0 (you@example.com)"
--
-- Nothing else in this feature needs a key: GLEIF, OFAC, Sourcify and the block explorer are all keyless.
-- ============================================================
--
-- WHY THIS SHAPE. Verified 2026-09-16 on EDGAR CIK 0002004367: a fund filed Form D in 2024 with minimum investment 0
-- under exemptions 06c/3C/3C.1/3C.7; by 2026-05-05 the minimum was 100000 and 3C.1 was gone; on 2026-07-14 the same
-- fund filed again under a NEW NAME (Superstate to Invesco), while EDGAR `formerNames` records the old one. Two drift
-- events, two dates. A single-row "current terms" table cannot represent that, so admission terms are stored append
-- only and the drift is derived and stored beside them.
--
-- HONESTY RULES THE SCHEMA ENFORCES, not merely the lane:
--   * EVERY row carries a source_url and a fetched_at. A figure with no primary source has no row.
--   * A RISK SIGNAL CANNOT EXIST WITHOUT ITS SCOPE STRING. `intel_rwa_issuer_risk_signals.scope` is NOT NULL with a
--     minimum length, because a lapsed registration or a sanctions pointer rendered without "what this does not mean"
--     is a legal problem, not a style problem.
--   * NO PERSON MAY BE STORED. Form D filings name natural persons (directors, with addresses) in relatedPersonsList;
--     the parser never reads that element and there is no column here that could hold one. The holder tables keep
--     ADDRESSES and BALANCES only, exactly like intel_holder_cohort_snapshots.
--   * ZERO IS A REAL ANSWER. minimum_investment_accepted 0 is the 2024 Superstate value and the whole point of the
--     drift record, so the column is nullable for "not stated" and accepts 0 for "stated as zero". The same applies to
--     every share and count column.
--   * EXPORT RIGHTS TRAVEL WITH THE ROW. Blockscout's redistribution terms could not be verified on 2026-09-16, so
--     intel_rwa_token_concentration.export_allowed defaults to false and the read view says the figure is
--     display-with-attribution only. GLEIF (CC0) and EDGAR (US public domain) rows are exportable.
--   * TWO CLOCKS, NEVER CONFLATED. `fetched_at` is when WE asked. `filing_date`, `observed_at` and `captured_at` are
--     the source's own dates. No column lets one stand in for the other.
--
-- Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass.
--
-- Retention: 400 days, PATCHED into the live definition of app_private.intel_capture_retention using the technique
-- from 20260915152118_intel_market_asset_candles rather than restating it, because a restatement copied from any one
-- migration silently drops the blocks added after it. The patch is SKIPPED with a notice when the function is absent,
-- so this migration is safe in an environment that has no capture retention job yet.
--
-- NOT SCHEDULED. There is deliberately no cron job in this migration. Capture is on demand from the RWA workspace,
-- bounded per run, and an operator can disable it through provider_schedule_policy.
--
-- Safe to apply anytime; idempotent.
--
-- ROLLBACK
--   -- stop the lane, keep the data:
--   UPDATE public.provider_schedule_policy SET enabled = false
--     WHERE provider = 'primary-sources' AND feature IN ('rwa_issuer_registry','rwa_token_concentration');
--   -- drop the data too:
--   DROP TABLE public.intel_rwa_token_restrictions;
--   DROP TABLE public.intel_rwa_token_concentration;
--   DROP TABLE public.intel_rwa_issuer_risk_signals;
--   DROP TABLE public.intel_rwa_issuer_admission_drift;
--   DROP TABLE public.intel_rwa_issuer_admission_filings;
--   DROP TABLE public.intel_rwa_issuer_entities;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'primary-sources';
--   -- then restore app_private.intel_capture_retention from its newest prior definition, otherwise the nightly job
--   -- errors on its next run against the dropped tables.
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: issuer legal entities

-- 1. One resolved legal entity. `entity_key` is the stable key the rest of the lane joins on and is derived from the
-- identifier that resolved it ('lei:<20 chars>' or 'cik:<10 digits>'), never from a name.
CREATE TABLE public.intel_rwa_issuer_entities (
  entity_key text PRIMARY KEY CHECK (entity_key ~ '^(lei:[0-9A-Z]{20}|cik:[0-9]{10})$'),
  -- ISO 17442. Null for an entity resolved only through EDGAR.
  lei text CHECK (lei IS NULL OR lei ~ '^[0-9A-Z]{18}[0-9]{2}$'),
  cik text CHECK (cik IS NULL OR cik ~ '^[0-9]{10}$'),
  -- The name AS THE REGISTER PUBLISHES IT. Not the CoinMarketCap issuer string, which is what the alias map maps FROM.
  legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 500),
  jurisdiction text CHECK (jurisdiction IS NULL OR length(jurisdiction) <= 20),
  -- The entity's own status, distinct from whether its registration is maintained. Superstate Limited is ACTIVE and
  -- LAPSED at the same time, which is why both columns exist.
  entity_status text CHECK (entity_status IS NULL OR length(entity_status) <= 40),
  registration_status text CHECK (registration_status IS NULL OR length(registration_status) <= 40),
  initial_registration_date timestamptz,
  last_update_date timestamptz,
  next_renewal_date timestamptz,
  -- Which dated assertion in rwa-issuer-aliases.ts produced this row, so a mapping can always be traced to the
  -- reviewer and the date that asserted it.
  alias_version text CHECK (alias_version IS NULL OR length(alias_version) <= 60),
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intel_rwa_issuer_entities_identified CHECK (lei IS NOT NULL OR cik IS NOT NULL)
);
CREATE INDEX intel_rwa_issuer_entities_lei_idx ON public.intel_rwa_issuer_entities (lei) WHERE lei IS NOT NULL;
CREATE INDEX intel_rwa_issuer_entities_cik_idx ON public.intel_rwa_issuer_entities (cik) WHERE cik IS NOT NULL;
ALTER TABLE public.intel_rwa_issuer_entities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_issuer_entities FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_issuer_entities TO service_role;

-- SECTION: admission reality

-- 2. One Form D per row. APPEND ONLY in spirit: a newer filing is a new row, never an update of an older one, because
-- the older terms were true on their date and a replay must still find them.
CREATE TABLE public.intel_rwa_issuer_admission_filings (
  cik text NOT NULL CHECK (cik ~ '^[0-9]{10}$'),
  accession_number text NOT NULL CHECK (accession_number ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  -- EDGAR's own clock for the filing. Distinct from fetched_at below.
  filing_date date,
  signature_date date,
  submission_type text CHECK (submission_type IS NULL OR submission_type IN ('D','D/A')),
  -- The entity name ON THIS FILING. It is deliberately stored per filing: this is how the Superstate to Invesco
  -- rename is visible as a dated change rather than as a single overwritten name.
  entity_name text CHECK (entity_name IS NULL OR length(entity_name) <= 500),
  jurisdiction_of_inc text CHECK (jurisdiction_of_inc IS NULL OR length(jurisdiction_of_inc) <= 120),
  -- Claimed exemptions in filing order, e.g. {06c,3C,3C.7}. An empty array means the filing stated none; NULL means we
  -- could not read them. The two are not the same and the read view distinguishes them.
  federal_exemptions text[],
  -- 0 is a REAL minimum (Superstate's 2024 filing) and must never be coerced to NULL. NULL means "not stated".
  minimum_investment_accepted numeric CHECK (minimum_investment_accepted IS NULL OR minimum_investment_accepted >= 0),
  has_non_accredited_investors boolean,
  total_amount_sold numeric CHECK (total_amount_sold IS NULL OR total_amount_sold >= 0),
  total_offering_amount numeric CHECK (total_offering_amount IS NULL OR total_offering_amount >= 0),
  total_investors integer CHECK (total_investors IS NULL OR total_investors >= 0),
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  -- When WE read the filing. Never presented as the filing date.
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cik, accession_number),
  CONSTRAINT intel_rwa_admission_filings_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(minimum_investment_accepted), abs(total_amount_sold), abs(total_offering_amount)]), true))
);
CREATE INDEX intel_rwa_admission_filings_series_idx ON public.intel_rwa_issuer_admission_filings (cik, filing_date DESC, accession_number DESC);
ALTER TABLE public.intel_rwa_issuer_admission_filings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_issuer_admission_filings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_issuer_admission_filings TO service_role;

-- 3. One dated difference between two consecutive filings. `kind` separates a change in what is ASKED OF AN INVESTOR
-- from a change in how much has merely been sold: BUIDL's terms did not move between 2024 and 2026 while its amount
-- sold went from 0 to 5,135,523,412, and reporting that as admission drift would cry wolf on every fund that grew.
CREATE TABLE public.intel_rwa_issuer_admission_drift (
  cik text NOT NULL CHECK (cik ~ '^[0-9]{10}$'),
  from_accession text NOT NULL CHECK (from_accession ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  to_accession text NOT NULL CHECK (to_accession ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  field text NOT NULL CHECK (field IN ('entity_name','jurisdiction','federal_exemptions','minimum_investment','non_accredited','amount_sold','investor_count')),
  kind text NOT NULL CHECK (kind IN ('term','activity')),
  from_value text NOT NULL CHECK (length(from_value) BETWEEN 1 AND 1000),
  to_value text NOT NULL CHECK (length(to_value) BETWEEN 1 AND 1000),
  -- The earlier filing's date: the last date the old answer is known to have held.
  held_until date,
  -- The later filing's date: the change happened at or before this, never necessarily on it.
  changed_by date,
  scope text NOT NULL CHECK (length(scope) BETWEEN 40 AND 2000),
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cik, from_accession, to_accession, field),
  -- A drift record whose two sides are equal is not a change.
  CONSTRAINT intel_rwa_admission_drift_changed CHECK (from_value IS DISTINCT FROM to_value)
);
CREATE INDEX intel_rwa_admission_drift_recent_idx ON public.intel_rwa_issuer_admission_drift (cik, kind, changed_by DESC);
ALTER TABLE public.intel_rwa_issuer_admission_drift ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_issuer_admission_drift FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_issuer_admission_drift TO service_role;

-- SECTION: risk signals

-- 4. Registration-status and sanctions POINTERS. `scope` is NOT NULL with a minimum length on purpose: a lapsed
-- registration or a name that matches a sanctions publication, rendered without "what this does not mean", is a legal
-- problem. The schema refuses to hold one.
CREATE TABLE public.intel_rwa_issuer_risk_signals (
  entity_key text NOT NULL REFERENCES public.intel_rwa_issuer_entities (entity_key) ON DELETE CASCADE,
  signal_type text NOT NULL CHECK (signal_type IN ('lei_registration','sanctions_name_pointer')),
  -- For a registration: maintained / unmaintained / unknown. For a sanctions pointer: exact_match / no_exact_match /
  -- not_screened. Never a score, never a rating.
  level text NOT NULL CHECK (length(level) BETWEEN 1 AND 40),
  status text CHECK (status IS NULL OR length(status) <= 120),
  -- What a reader must open and judge for themselves.
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  scope text NOT NULL CHECK (length(scope) BETWEEN 60 AND 2000),
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_key, signal_type)
);
ALTER TABLE public.intel_rwa_issuer_risk_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_issuer_risk_signals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_issuer_risk_signals TO service_role;

-- SECTION: token concentration and transfer restrictions

-- 5. Top-N share of reported supply, on OUR capture clock floored to the hour, exactly like intel_holder_tag_snapshots.
-- The explorer publishes no observation time for a holder balance, so captured_at is the hour we asked and no read may
-- present it as a provider reading.
CREATE TABLE public.intel_rwa_token_concentration (
  chain text NOT NULL CHECK (chain IN ('ethereum','base','arbitrum','polygon')),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  captured_at timestamptz NOT NULL CHECK (captured_at = date_trunc('hour', captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  -- A reported count. Zero is a real answer.
  holders_count integer CHECK (holders_count IS NULL OR holders_count >= 0),
  -- Supply exceeds bigint range for some tokens, so it is numeric and written as an integer string.
  total_supply numeric CHECK (total_supply IS NULL OR total_supply >= 0),
  -- Percentages of reported supply. 0 is a real share and is stored as 0, never as NULL.
  top1_share numeric CHECK (top1_share IS NULL OR (top1_share >= 0 AND top1_share <= 100)),
  top5_share numeric CHECK (top5_share IS NULL OR (top5_share >= 0 AND top5_share <= 100)),
  top10_share numeric CHECK (top10_share IS NULL OR (top10_share >= 0 AND top10_share <= 100)),
  -- How many rows the shares were computed from, and whether the provider had more.
  holders_read integer NOT NULL DEFAULT 0 CHECK (holders_read >= 0),
  truncated boolean NOT NULL DEFAULT false,
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  -- FALSE by default: this explorer's redistribution terms could not be verified on 2026-09-16, so a figure derived
  -- from it is display-with-attribution only and must not enter an export.
  export_allowed boolean NOT NULL DEFAULT false,
  scope text NOT NULL CHECK (length(scope) BETWEEN 60 AND 2000),
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, contract_address, captured_at),
  -- Shares must not decrease as the tier widens: top5 includes top1.
  CONSTRAINT intel_rwa_concentration_ordered CHECK (
    (top1_share IS NULL OR top5_share IS NULL OR top5_share >= top1_share)
    AND (top5_share IS NULL OR top10_share IS NULL OR top10_share >= top5_share)),
  CONSTRAINT intel_rwa_concentration_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(total_supply), abs(top1_share), abs(top5_share), abs(top10_share)]), true))
);
CREATE INDEX intel_rwa_concentration_recent_idx ON public.intel_rwa_token_concentration (chain, contract_address, captured_at DESC);
ALTER TABLE public.intel_rwa_token_concentration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_token_concentration FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_token_concentration TO service_role;

-- 6. What the token's VERIFIED SOURCE shows its code can do. `implementation_address` is separate because a proxy's own
-- ABI says nothing about transfer restrictions: reading the proxy and reporting "unrestricted" would be a false
-- negative on exactly the tokens that are most restricted.
CREATE TABLE public.intel_rwa_token_restrictions (
  chain text NOT NULL CHECK (chain IN ('ethereum','base','arbitrum','polygon')),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  implementation_address text CHECK (implementation_address IS NULL OR implementation_address ~ '^0x[0-9a-f]{40}$'),
  -- 'proxy_unresolved' is the honest answer for a token that IS a proxy whose implementation could not be read. It is
  -- deliberately distinct from 'no_restriction_found': not having looked is not the same as having looked and found
  -- nothing, and collapsing the two would report the most restricted tokens as free.
  state text NOT NULL CHECK (state IN ('restricted','no_restriction_found','proxy_abi_only','proxy_unresolved','not_verified','unknown')),
  -- Statements about CODE, never about whether a restriction has been applied.
  kyc_gated boolean NOT NULL DEFAULT false,
  pausable boolean NOT NULL DEFAULT false,
  freezable boolean NOT NULL DEFAULT false,
  -- The exact ABI member names that matched, so a reader can verify the claim against the source.
  matched_members text[],
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  scope text NOT NULL CHECK (length(scope) BETWEEN 60 AND 2000),
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, contract_address),
  -- A capability may only be claimed when the read actually found restrictions.
  CONSTRAINT intel_rwa_restrictions_consistent CHECK (
    state = 'restricted' OR (kyc_gated = false AND pausable = false AND freezable = false))
);
ALTER TABLE public.intel_rwa_token_restrictions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_token_restrictions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_token_restrictions TO service_role;

-- SECTION: schedule policy

-- 7. Cadence and enablement for the two on-demand lanes. The provider is 'primary-sources' rather than a vendor name:
-- these are free public registers (GLEIF CC0, EDGAR public domain, OFAC public domain) plus one block explorer, and no
-- API key or credit is spent on any of them. A later edit to a row wins, so re-running never resets one.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, reason) VALUES
  ('primary-sources', 'rwa_issuer_registry', 86400, true, NULL, 'GLEIF, EDGAR and OFAC reads for mapped RWA issuers; keyless and free'),
  ('primary-sources', 'rwa_token_concentration', 3600, true, NULL, 'block explorer holder concentration and verified-source transfer restrictions; keyless and free')
ON CONFLICT (provider, feature) DO NOTHING;

-- SECTION: retention

-- 8. 400 days on the capture tables, PATCHED into the live retention function rather than restated, so the blocks every
-- earlier lane added are preserved. Skipped with a notice when the function does not exist yet, and refuses to apply
-- twice. The entity, risk-signal and admission tables are NOT pruned here: an admission time series that forgets its
-- own history is exactly the curated snapshot this feature exists to replace.
DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  IF to_regprocedure('app_private.intel_capture_retention(timestamptz)') IS NULL THEN
    RAISE NOTICE 'app_private.intel_capture_retention is absent; skipping the RWA issuer retention block.';
    RETURN;
  END IF;
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  IF position('intel_rwa_token_concentration' in original) > 0 THEN
    RAISE NOTICE 'RWA issuer retention block already present; leaving the function unchanged.';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by the RWA issuer legitimacy lane. Only the hourly concentration captures are pruned. Admission\n'
    || E'  -- filings, drift and resolved entities are never deleted: a time series that forgets is a snapshot.\n'
    || E'  DELETE FROM public.intel_rwa_token_concentration WHERE captured_at < p_now - interval ''400 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_rwa_token_concentration'', n);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
  REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;
END $retention$;
