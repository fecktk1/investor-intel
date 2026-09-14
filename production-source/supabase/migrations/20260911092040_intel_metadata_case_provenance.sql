-- Existing baselines may have lost case-sensitive address characters. Keep that
-- provenance until a new provider observation is captured by the corrected writer.
ALTER TABLE public.token_metadata_baseline ADD COLUMN normalization_version smallint NOT NULL DEFAULT 1
  CONSTRAINT token_metadata_normalization_version CHECK(normalization_version IN (1,2));
COMMENT ON COLUMN public.token_metadata_baseline.normalization_version IS '1: legacy all-address case folding; 2: only EVM hex casing normalized. Version changes only on a newly captured provider baseline.';
