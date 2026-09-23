-- Investor Intel: the finished answers of the public RWA lookup (intel-rwa-lookup).
--
-- A lookup is a dozen database reads. Under load (23 Sep 2026, while the hourly
-- derived-market job ran) one took 15 seconds for SGOV, although every figure in
-- it was a stored capture row or a shared-cache copy. The function now keeps the
-- finished answer per query and serves it at once to the next visitor, re-aged
-- to the moment it is served, while a fresh answer is assembled behind it
-- (supabase/functions/_shared/intel/rwa-lookup.ts answerLookup).
--
-- One row per query key: 'id:<rwa_id>' or 'q:<query in lower case>'. The key set
-- is bounded by the lookup's own validation (60 characters of letters, digits
-- and . & ' ( ) -) and only answers that found an asset are kept.
--
-- Service role only, like intel_rwa_lookup_last_good. The keep RPC only ever
-- moves an answer forward in time.

CREATE TABLE IF NOT EXISTS public.intel_rwa_lookup_answers (
  query_key   text PRIMARY KEY CHECK (query_key ~ '^(id|q):.{1,64}$'),
  rwa_id      bigint,
  body        jsonb NOT NULL,
  built_at    timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intel_rwa_lookup_answers_body_size CHECK (pg_column_size(body) <= 262144)
);

ALTER TABLE public.intel_rwa_lookup_answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_rwa_lookup_answers FROM PUBLIC;
REVOKE ALL ON public.intel_rwa_lookup_answers FROM anon;
REVOKE ALL ON public.intel_rwa_lookup_answers FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.intel_rwa_lookup_answers TO service_role;

CREATE OR REPLACE FUNCTION public.intel_rwa_lookup_answer_keep(
  p_query_key text, p_rwa_id bigint, p_body jsonb, p_built_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_query_key IS NULL OR p_query_key !~ '^(id|q):.{1,64}$'
     OR p_body IS NULL OR jsonb_typeof(p_body) <> 'object'
     OR coalesce(p_body->>'state', '') NOT IN ('found', 'found_without_quote')
     OR p_built_at IS NULL OR p_built_at > now() + interval '5 minutes' THEN
    RETURN false;
  END IF;
  INSERT INTO public.intel_rwa_lookup_answers AS t (query_key, rwa_id, body, built_at, recorded_at)
  VALUES (p_query_key, p_rwa_id, p_body, p_built_at, now())
  ON CONFLICT (query_key) DO UPDATE
    SET rwa_id = EXCLUDED.rwa_id, body = EXCLUDED.body, built_at = EXCLUDED.built_at, recorded_at = now()
    WHERE EXCLUDED.built_at > t.built_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.intel_rwa_lookup_answer_keep(text, bigint, jsonb, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_rwa_lookup_answer_keep(text, bigint, jsonb, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.intel_rwa_lookup_answer_keep(text, bigint, jsonb, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.intel_rwa_lookup_answer_keep(text, bigint, jsonb, timestamptz) TO service_role;

COMMENT ON TABLE public.intel_rwa_lookup_answers IS
  'intel-rwa-lookup: the newest finished answer per query, served at once (re-aged) while a fresh one is assembled behind it. Service role only.';
