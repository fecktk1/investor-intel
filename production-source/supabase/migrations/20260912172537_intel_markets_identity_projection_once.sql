-- Compute canonical enrichment confidence once per bounded source row.
-- Query-local materialization only: no stored snapshot, provider request or new clock.
-- Keep the reviewed view's columns, dependencies, ACL and SECURITY INVOKER semantics.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $migration$
DECLARE previous_definition text; next_definition text;
BEGIN
  PERFORM pg_catalog.set_config('search_path', '', true);
  previous_definition := pg_catalog.pg_get_viewdef('public.intel_market_screen_source_rows'::regclass, true);
  IF pg_catalog.md5(pg_catalog.replace(previous_definition, 'identities AS MATERIALIZED (', 'identities AS (')) <> '5782c858ea7f0c6d4b0fdef1129ed2af' THEN
    RAISE EXCEPTION 'Markets source view differs from the reviewed definition; review before applying';
  END IF;
  IF NOT COALESCE((SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_catalog.pg_class WHERE oid='public.intel_market_screen_source_rows'::regclass), false) THEN
    RAISE EXCEPTION 'Markets source view must remain SECURITY INVOKER';
  END IF;
  next_definition := pg_catalog.replace(previous_definition, 'identities AS (', 'identities AS MATERIALIZED (');
  IF next_definition <> previous_definition THEN
    EXECUTE 'CREATE OR REPLACE VIEW public.intel_market_screen_source_rows WITH (security_invoker=true) AS ' || next_definition;
  END IF;
END $migration$;
