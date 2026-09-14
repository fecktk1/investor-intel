-- PostgREST ON CONFLICT does not infer a partial unique index without a
-- predicate. Full indexes retain NULL-distinct behavior and support the
-- existing provider/contract upserts. No profile or user record is rewritten.
CREATE UNIQUE INDEX token_profiles_provider_upsert_uniq
  ON public.token_profiles(source_provider, provider_id);
CREATE UNIQUE INDEX token_profiles_contract_upsert_uniq
  ON public.token_profiles(chain, token_address);
DROP INDEX public.token_profiles_provider_uniq;
DROP INDEX public.token_profiles_contract_uniq;
ALTER INDEX public.token_profiles_provider_upsert_uniq RENAME TO token_profiles_provider_uniq;
ALTER INDEX public.token_profiles_contract_upsert_uniq RENAME TO token_profiles_contract_uniq;

-- Exact address lookup preserves case on Solana and other non-EVM networks.
CREATE INDEX token_alias_exact_address ON public.token_profile_aliases(alias_type, chain, address);
