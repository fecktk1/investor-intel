-- Shared observations extend the market cache; personal decisions stay in
-- saved_research. No user text, portfolio balance or trade enters this table.
CREATE TABLE public.intel_market_observations (
 id text PRIMARY KEY CHECK(length(id)<=180),
 subject text NOT NULL CHECK(length(subject)<=240),
 provider text NOT NULL CHECK(length(provider)<=64),
 metric text NOT NULL CHECK(length(metric)<=100),
 observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object' AND octet_length(observation::text)<=16000),
 observed_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 retain_until timestamptz NOT NULL,
 CHECK(retain_until>recorded_at),
 CHECK(observation->>'subject'=subject AND observation->>'provider'=provider AND observation->>'metric'=metric)
);
CREATE INDEX intel_observation_asset_time ON public.intel_market_observations(subject,observed_at DESC,id DESC);
CREATE INDEX intel_observation_retention ON public.intel_market_observations(retain_until);
ALTER TABLE public.intel_market_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_market_observations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.intel_market_observations TO service_role;

-- Exact first-collection membership is immutable. Missing constituents remain
-- present until the permitted cohort retention ends; current screens are not
-- retroactively relabeled as historical cohorts.
CREATE TABLE public.intel_market_cohorts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cohort_key text NOT NULL UNIQUE CHECK(length(cohort_key)<=300),
 kind text NOT NULL CHECK(kind IN ('sector','new_listings')),
 name text NOT NULL CHECK(length(name)<=160),
 provider text NOT NULL,
 source_ref text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 retain_until timestamptz NOT NULL,
 members jsonb NOT NULL CHECK(jsonb_typeof(members)='array' AND jsonb_array_length(members) BETWEEN 1 AND 100 AND octet_length(members::text)<=100000),
 CHECK(retain_until>created_at)
);
CREATE INDEX intel_cohort_retention ON public.intel_market_cohorts(retain_until);
ALTER TABLE public.intel_market_cohorts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_market_cohorts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.intel_market_cohorts TO service_role;

CREATE TABLE public.intel_investigation_visits (
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 subject text NOT NULL CHECK(length(subject)<=240),
 lens text NOT NULL CHECK(length(lens)<=64),
 seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,user_id,subject,lens)
);
ALTER TABLE public.intel_investigation_visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY investigation_own_visits ON public.intel_investigation_visits FOR ALL TO authenticated
 USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_investigation_visits.org_id AND m.user_id=(SELECT auth.uid())))
 WITH CHECK(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_investigation_visits.org_id AND m.user_id=(SELECT auth.uid())));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_investigation_visits TO authenticated,service_role;
REVOKE ALL ON public.intel_investigation_visits FROM anon;

ALTER TABLE public.saved_research ADD COLUMN IF NOT EXISTS investigation_receipt jsonb,
 ADD COLUMN IF NOT EXISTS receipt_operation_id uuid;
CREATE UNIQUE INDEX intel_receipt_operation ON public.saved_research(org_id,user_id,receipt_operation_id) WHERE receipt_operation_id IS NOT NULL;
ALTER TABLE public.saved_research ADD CONSTRAINT intel_receipt_private CHECK(investigation_receipt IS NULL OR (
 private_owner_id=user_id AND private_owner_id IS NOT NULL AND
 jsonb_typeof(investigation_receipt)='object' AND octet_length(investigation_receipt::text)<=250000));

CREATE OR REPLACE FUNCTION public.intel_record_market_observations(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE r jsonb; n integer:=0; added integer; t timestamptz:=clock_timestamp();
BEGIN
 IF jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>2000 OR octet_length(p_rows::text)>2000000 THEN RAISE EXCEPTION 'invalid_observation_batch'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
   IF (r->>'observedAt')::timestamptz>t+interval '5 minutes' OR (r->>'recordedAt')::timestamptz>t+interval '5 minutes'
     OR (r->>'retainUntil')::timestamptz>t+interval '366 days' THEN RAISE EXCEPTION 'invalid_observation_time'; END IF;
   INSERT INTO public.intel_market_observations(id,subject,provider,metric,observation,observed_at,recorded_at,retain_until)
   VALUES(r->>'id',r->>'subject',r->>'provider',r->>'metric',r-'retainUntil',(r->>'observedAt')::timestamptz,(r->>'recordedAt')::timestamptz,(r->>'retainUntil')::timestamptz)
   ON CONFLICT(id) DO NOTHING;
   GET DIAGNOSTICS added=ROW_COUNT; n:=n+added;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.intel_record_market_observations(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_market_observations(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.intel_save_investigation_receipt(p_org_id uuid,p_user_id uuid,p_operation_id uuid,p_receipt jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE saved uuid;
BEGIN
 IF p_operation_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org_id AND user_id=p_user_id)
   OR public.can_access_intel(p_user_id,p_org_id) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR p_receipt->>'schemaVersion' IS DISTINCT FROM '1' OR coalesce(length(p_receipt->>'question'),0) NOT BETWEEN 1 AND 8000 OR length(p_receipt->>'decision')>16000 THEN RAISE EXCEPTION 'invalid_receipt'; END IF;
 INSERT INTO public.saved_research(org_id,user_id,private_owner_id,title,snapshot,tags,investigation_receipt,receipt_operation_id)
 VALUES(p_org_id,p_user_id,p_user_id,left(p_receipt->>'question',160),jsonb_build_object('summary',p_receipt->>'decision','source','Investor Intel research receipt','subject',p_receipt->>'subject'),ARRAY['investigation','receipt'],p_receipt,p_operation_id)
 ON CONFLICT(org_id,user_id,receipt_operation_id) WHERE receipt_operation_id IS NOT NULL DO NOTHING RETURNING id INTO saved;
 IF saved IS NULL THEN SELECT id INTO saved FROM public.saved_research WHERE org_id=p_org_id AND user_id=p_user_id AND receipt_operation_id=p_operation_id; END IF;
 RETURN saved;
END $$;
REVOKE ALL ON FUNCTION public.intel_save_investigation_receipt(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_save_investigation_receipt(uuid,uuid,uuid,jsonb) TO service_role;
GRANT SELECT,INSERT ON public.saved_research TO service_role;
GRANT SELECT ON public.org_members TO service_role;

CREATE OR REPLACE FUNCTION public.intel_prune_investigation_history(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE removed integer;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'invalid_retention_batch'; END IF;
 WITH expired AS (SELECT id FROM public.intel_market_observations WHERE retain_until<=now() ORDER BY retain_until LIMIT p_limit FOR UPDATE SKIP LOCKED)
 DELETE FROM public.intel_market_observations WHERE id IN(SELECT id FROM expired);
 GET DIAGNOSTICS removed=ROW_COUNT;
 WITH expired AS (SELECT id FROM public.intel_market_cohorts WHERE retain_until<=now() ORDER BY retain_until LIMIT p_limit FOR UPDATE SKIP LOCKED)
 DELETE FROM public.intel_market_cohorts WHERE id IN(SELECT id FROM expired);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION public.intel_prune_investigation_history(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_prune_investigation_history(integer) TO service_role;
