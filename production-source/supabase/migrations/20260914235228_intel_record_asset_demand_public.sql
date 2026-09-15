-- Investor Intel — public wrapper for app_private.intel_record_asset_demand.
--
-- PostgREST exposes only the schemas listed in config.toml (public,
-- graphql_public), so an Edge Function holding the service-role key cannot call
-- app_private.intel_record_asset_demand directly. This wrapper is the only way
-- in: SECURITY DEFINER, executable by service_role alone, and it adds nothing of
-- its own — the ledger logic, the key length check and the 24-hour in-use window
-- all still live in the app_private function.
--
-- It stores what was asked for, never who asked: the demand row has no user or
-- org column and this wrapper passes none.

CREATE OR REPLACE FUNCTION public.intel_record_asset_demand(
  p_asset_key text,
  p_provider text DEFAULT NULL,
  p_provider_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_private.intel_record_asset_demand(p_asset_key, p_provider, p_provider_id);
END $$;

-- REVOKE FROM PUBLIC alone leaves the default EXECUTE grant that PUBLIC already
-- holds on a newly created function; revoke from every role that could reach
-- PostgREST, then grant back to service_role only.
REVOKE ALL ON FUNCTION public.intel_record_asset_demand(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_asset_demand(text, text, text) TO service_role;

COMMENT ON FUNCTION public.intel_record_asset_demand(text, text, text) IS
  'Service-role-only wrapper over app_private.intel_record_asset_demand, so intel-asset-resolve can record which asset was demanded (never who demanded it).';
