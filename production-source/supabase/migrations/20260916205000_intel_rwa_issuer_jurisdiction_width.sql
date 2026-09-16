-- Investor Intel: the issuer entity jurisdiction column holds the source text verbatim.
--
-- WHY. intel_rwa_issuer_entities.jurisdiction was capped at 20 characters
-- (20260916150000_intel_rwa_issuer_legitimacy.sql line 115). That fits GLEIF's
-- ISO style codes ('US-DE', 'VG') but not the jurisdiction an SEC Form D reports,
-- which is free text: BlackRock USD Institutional Digital Liquidity Fund Ltd.
-- (CIK 0002013810, asserted in rwa-issuer-alias-1) reports 'VIRGIN ISLANDS,
-- BRITISH', 23 characters. The first manual run of the rwa_issuer_registry lane
-- on 2026-09-16 failed the whole upsert on that one row, so no issuer entity was
-- stored at all and the legitimacy view stayed empty.
--
-- The companion column for the same Form D field,
-- intel_rwa_issuer_admission_filings.jurisdiction_of_inc, already allows 120
-- characters. This aligns the entity column with it. Evidence is recorded as the
-- source wrote it; it is never rewritten to fit a column.
--
-- Rollback (only once no stored value is longer than 20 characters):
--   ALTER TABLE public.intel_rwa_issuer_entities DROP CONSTRAINT intel_rwa_issuer_entities_jurisdiction_check;
--   ALTER TABLE public.intel_rwa_issuer_entities ADD CONSTRAINT intel_rwa_issuer_entities_jurisdiction_check
--     CHECK (jurisdiction IS NULL OR length(jurisdiction) <= 20);

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.intel_rwa_issuer_entities DROP CONSTRAINT IF EXISTS intel_rwa_issuer_entities_jurisdiction_check;
ALTER TABLE public.intel_rwa_issuer_entities ADD CONSTRAINT intel_rwa_issuer_entities_jurisdiction_check
  CHECK (jurisdiction IS NULL OR length(jurisdiction) <= 120);
