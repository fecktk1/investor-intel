-- Supabase's production default privileges grant anon function execution
-- directly. Revoking PUBLIC alone does not remove that inherited creation ACL.
REVOKE ALL ON FUNCTION public.intel_market_history_deadline(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.intel_market_history_deadline(timestamptz) TO authenticated, service_role;
