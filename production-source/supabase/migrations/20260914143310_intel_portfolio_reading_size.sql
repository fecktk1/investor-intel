-- A saved portfolio reading keeps the evidence shown with it: up to ten market
-- evidence records, exposures, recent activity and the 90-day performance tables.
-- Portfolios with many holdings or daily snapshots exceeded the original 100 KB
-- cap, so completing their research failed. Both copies of a reading now accept
-- up to 1 MB; larger readings are still refused.
ALTER TABLE public.intel_portfolio_research_cache
 DROP CONSTRAINT intel_portfolio_research_cache_artifact_check,
 ADD CONSTRAINT intel_portfolio_research_cache_artifact_check
  CHECK (artifact IS NULL OR (jsonb_typeof(artifact)='object' AND octet_length(artifact::text)<=1000000));
ALTER TABLE public.intel_portfolio_reading_versions
 DROP CONSTRAINT intel_portfolio_reading_versions_artifact_check,
 ADD CONSTRAINT intel_portfolio_reading_versions_artifact_check
  CHECK (jsonb_typeof(artifact)='object' AND octet_length(artifact::text)<=1000000);
