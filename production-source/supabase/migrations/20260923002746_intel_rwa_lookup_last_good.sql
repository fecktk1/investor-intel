-- Investor Intel: public "Look up any tokenised asset, now" (intel-rwa-lookup).
--
-- The newest good rwaQuotes answer the lookup has seen for each asset, so that a
-- failed live miss can still answer with a dated figure and its age. The shared
-- response cache cannot be relied on for that: once a row passes stale_until the
-- transport stops serving it, and a refused refresh with no usable snapshot
-- overwrites its body with a negative record. From 1 Oct 2026 the event key
-- reverts to the Basic plan and the RWA endpoints may refuse, so the lookup
-- keeps its own last good copy.
--
-- Only what the answer shows is kept: the asset, its USD quote and up to 40
-- wrapper tokens. Prose never. One row per asset; a write only ever moves the
-- row forward in time.
--
-- Service role only: RLS on with no policy, and no grants to anon or
-- authenticated on the table or the function (REVOKE FROM PUBLIC alone does not
-- remove Supabase's default grants, so each role is named).

CREATE TABLE IF NOT EXISTS public.intel_rwa_lookup_last_good (
  rwa_id       bigint PRIMARY KEY CHECK (rwa_id > 0),
  payload      jsonb NOT NULL,
  fetched_at   timestamptz NOT NULL,
  http_status  integer,
  credit_count numeric,
  served_as    text NOT NULL CHECK (served_as IN ('live', 'cache')),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intel_rwa_lookup_last_good_payload_size CHECK (pg_column_size(payload) <= 65536)
);

ALTER TABLE public.intel_rwa_lookup_last_good ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_rwa_lookup_last_good FROM PUBLIC;
REVOKE ALL ON public.intel_rwa_lookup_last_good FROM anon;
REVOKE ALL ON public.intel_rwa_lookup_last_good FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.intel_rwa_lookup_last_good TO service_role;

CREATE OR REPLACE FUNCTION public.intel_rwa_lookup_remember(
  p_rwa_id bigint, p_payload jsonb, p_fetched_at timestamptz,
  p_http_status integer, p_credit_count numeric, p_served_as text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_rwa_id IS NULL OR p_rwa_id <= 0 OR p_payload IS NULL OR p_fetched_at IS NULL
     OR p_fetched_at > now() + interval '5 minutes'
     OR p_served_as NOT IN ('live', 'cache') THEN
    RETURN false;
  END IF;
  INSERT INTO public.intel_rwa_lookup_last_good AS t (rwa_id, payload, fetched_at, http_status, credit_count, served_as, recorded_at)
  VALUES (p_rwa_id, p_payload, p_fetched_at, p_http_status, p_credit_count, p_served_as, now())
  ON CONFLICT (rwa_id) DO UPDATE
    SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at, http_status = EXCLUDED.http_status,
        credit_count = EXCLUDED.credit_count, served_as = EXCLUDED.served_as, recorded_at = now()
    WHERE EXCLUDED.fetched_at > t.fetched_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.intel_rwa_lookup_remember(bigint, jsonb, timestamptz, integer, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_rwa_lookup_remember(bigint, jsonb, timestamptz, integer, numeric, text) FROM anon;
REVOKE ALL ON FUNCTION public.intel_rwa_lookup_remember(bigint, jsonb, timestamptz, integer, numeric, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.intel_rwa_lookup_remember(bigint, jsonb, timestamptz, integer, numeric, text) TO service_role;

COMMENT ON TABLE public.intel_rwa_lookup_last_good IS
  'intel-rwa-lookup: newest good rwaQuotes answer per asset (trimmed), served with its age when a live miss fails. Service role only.';
