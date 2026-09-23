-- Investor Intel: the public RWA research reads through intel-rwa-lookup.
--
-- The same endpoint serves the six /intel/rwa research reads (rwaList, rwaInfo,
-- rwaQuotes, rwaPairs, issuers, issuer) to callers with no account, exactly as a
-- free member gets them. This keeps the newest usable body of each exact read,
-- keyed by capability and its canonical parameters, so a failed live miss after
-- the plan change (1 Oct 2026) answers with a dated copy and the reason rather
-- than an empty page. The key set is bounded by what the free lane could serve:
-- a shared-cache hit, or a live read granted by the 200 credit daily budget.
--
-- Service role only, as intel_rwa_lookup_last_good.

CREATE TABLE IF NOT EXISTS public.intel_rwa_lookup_research_last_good (
  capability  text NOT NULL CHECK (capability IN ('rwaList', 'rwaInfo', 'rwaQuotes', 'rwaPairs', 'issuers', 'issuer')),
  params_key  text NOT NULL CHECK (length(params_key) BETWEEN 2 AND 500),
  body        jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capability, params_key),
  CONSTRAINT intel_rwa_lookup_research_last_good_body_size CHECK (pg_column_size(body) <= 262144)
);

ALTER TABLE public.intel_rwa_lookup_research_last_good ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_rwa_lookup_research_last_good FROM PUBLIC;
REVOKE ALL ON public.intel_rwa_lookup_research_last_good FROM anon;
REVOKE ALL ON public.intel_rwa_lookup_research_last_good FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.intel_rwa_lookup_research_last_good TO service_role;

CREATE OR REPLACE FUNCTION public.intel_rwa_lookup_research_remember(
  p_capability text, p_params_key text, p_body jsonb, p_fetched_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_capability IS NULL OR p_capability NOT IN ('rwaList', 'rwaInfo', 'rwaQuotes', 'rwaPairs', 'issuers', 'issuer')
     OR p_params_key IS NULL OR length(p_params_key) NOT BETWEEN 2 AND 500
     OR p_body IS NULL OR jsonb_typeof(p_body) <> 'object'
     OR p_fetched_at IS NULL OR p_fetched_at > now() + interval '5 minutes' THEN
    RETURN false;
  END IF;
  INSERT INTO public.intel_rwa_lookup_research_last_good AS t (capability, params_key, body, fetched_at, recorded_at)
  VALUES (p_capability, p_params_key, p_body, p_fetched_at, now())
  ON CONFLICT (capability, params_key) DO UPDATE
    SET body = EXCLUDED.body, fetched_at = EXCLUDED.fetched_at, recorded_at = now()
    WHERE EXCLUDED.fetched_at > t.fetched_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.intel_rwa_lookup_research_remember(text, text, jsonb, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_rwa_lookup_research_remember(text, text, jsonb, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.intel_rwa_lookup_research_remember(text, text, jsonb, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.intel_rwa_lookup_research_remember(text, text, jsonb, timestamptz) TO service_role;

COMMENT ON TABLE public.intel_rwa_lookup_research_last_good IS
  'intel-rwa-lookup research mode: newest usable free-lane body per (capability, canonical params), served dated with a reason when a live miss fails. Service role only.';
