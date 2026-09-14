-- Shared provider-ID cohorts written by the existing canonical refresh job.
-- Public market metadata only; existing market_assets RLS remains in force.
ALTER TABLE public.market_assets ADD COLUMN IF NOT EXISTS quote_batch_ids text[];
ALTER TABLE public.market_assets ADD CONSTRAINT market_assets_quote_batch_bounds
 CHECK (quote_batch_ids IS NULL OR (source_provider='coinmarketcap' AND
  cardinality(quote_batch_ids) BETWEEN 1 AND 250 AND provider_id=ANY(quote_batch_ids)));
