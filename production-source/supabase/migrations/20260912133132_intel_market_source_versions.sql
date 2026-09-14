-- Undated provider records are versioned separately from dated market facts.
-- This table contains public, normalized source data only; no user/portfolio text.
CREATE TABLE public.intel_market_source_versions (
 id text PRIMARY KEY CHECK (id ~ '^cmc-source:[a-f0-9]{64}$'),
 subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 240),
 family text NOT NULL CHECK (family IN ('security','rwa_relationship')),
 provider text NOT NULL DEFAULT 'coinmarketcap' CHECK (provider='coinmarketcap'),
 content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
 document jsonb NOT NULL CHECK (jsonb_typeof(document)='object' AND octet_length(document::text)<=20000),
 source_reference jsonb NOT NULL CHECK (jsonb_typeof(source_reference)='object' AND octet_length(source_reference::text)<=4000),
 fetched_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 retain_until timestamptz NOT NULL,
 ai_allowed boolean NOT NULL DEFAULT false,
 export_allowed boolean NOT NULL DEFAULT false,
 CHECK (expires_at<=retain_until AND fetched_at<=recorded_at+interval '5 minutes')
);
CREATE INDEX intel_source_subject_time ON public.intel_market_source_versions(subject,family,fetched_at DESC,id DESC);
CREATE INDEX intel_source_retention ON public.intel_market_source_versions(retain_until);
ALTER TABLE public.intel_market_source_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_market_source_versions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.intel_market_source_versions TO service_role;

-- Atomic retry-safe insertion. A cache read cannot reset first recording time.
-- Repeated cache responses are deduplicated; new source fetches retain their
-- own freshness receipt, including unchanged values and A->B->A sequences.
-- Delayed older responses cannot create a change.
CREATE FUNCTION public.intel_record_market_source_versions(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r jsonb; prior public.intel_market_source_versions; added integer; n integer:=0; t timestamptz:=clock_timestamp();
BEGIN
 IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>100 OR octet_length(p_rows::text)>500000 THEN RAISE EXCEPTION 'invalid_source_batch'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_rows) ORDER BY value->>'subject',value->>'family',value->>'fetchedAt' LOOP
  IF r->>'family' NOT IN ('security','rwa_relationship') OR r->>'subject' IS NULL
    OR (r->>'fetchedAt')::timestamptz>t+interval '5 minutes'
    OR (r->>'retainUntil')::timestamptz<=t OR (r->>'retainUntil')::timestamptz>t+interval '31 days'
    OR (r->>'expiresAt')::timestamptz>(r->>'retainUntil')::timestamptz THEN RAISE EXCEPTION 'invalid_source_version'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('intel-source:'||(r->>'subject')||':'||(r->>'family'),0));
  SELECT * INTO prior FROM public.intel_market_source_versions
   WHERE subject=r->>'subject' AND family=r->>'family' AND retain_until>t ORDER BY fetched_at DESC,id DESC LIMIT 1;
  IF FOUND AND prior.fetched_at>=(r->>'fetchedAt')::timestamptz THEN CONTINUE; END IF;
  INSERT INTO public.intel_market_source_versions(id,subject,family,content_hash,document,source_reference,fetched_at,expires_at,retain_until,ai_allowed,export_allowed)
   VALUES(r->>'id',r->>'subject',r->>'family',r->>'contentHash',r->'document',r->'sourceReference',(r->>'fetchedAt')::timestamptz,(r->>'expiresAt')::timestamptz,(r->>'retainUntil')::timestamptz,
    coalesce((r->>'aiAllowed')::boolean,false),coalesce((r->>'exportAllowed')::boolean,false)) ON CONFLICT(id) DO NOTHING;
  GET DIAGNOSTICS added=ROW_COUNT; n:=n+added;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.intel_record_market_source_versions(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_market_source_versions(jsonb) TO service_role;

CREATE FUNCTION public.intel_prune_market_source_versions(p_limit integer DEFAULT 2000)
RETURNS integer LANGUAGE plpgsql SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF p_limit<1 OR p_limit>5000 OR p_limit IS NULL THEN RAISE EXCEPTION 'invalid_prune_limit'; END IF;
 WITH expired AS (SELECT id FROM public.intel_market_source_versions WHERE retain_until<=clock_timestamp() ORDER BY retain_until,id LIMIT p_limit FOR UPDATE SKIP LOCKED)
 DELETE FROM public.intel_market_source_versions s USING expired e WHERE s.id=e.id;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.intel_prune_market_source_versions(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_prune_market_source_versions(integer) TO service_role;

-- Extend the existing bounded retention lane; no new scheduler, provider work,
-- configuration activation or worker release is required for this cleanup.
CREATE OR REPLACE FUNCTION public.intel_prune_investigation_history(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SET search_path=public AS $$
DECLARE removed integer;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'invalid_retention_batch'; END IF;
 WITH expired AS (SELECT id FROM public.intel_market_observations WHERE retain_until<=now() ORDER BY retain_until LIMIT p_limit FOR UPDATE SKIP LOCKED)
 DELETE FROM public.intel_market_observations WHERE id IN(SELECT id FROM expired);
 GET DIAGNOSTICS removed=ROW_COUNT;
 WITH expired AS (SELECT id FROM public.intel_market_cohorts WHERE retain_until<=now() ORDER BY retain_until LIMIT p_limit FOR UPDATE SKIP LOCKED)
 DELETE FROM public.intel_market_cohorts WHERE id IN(SELECT id FROM expired);
 PERFORM public.intel_prune_market_source_versions(p_limit);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION public.intel_prune_investigation_history(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_prune_investigation_history(integer) TO service_role;
