-- Completed private readings outlive the generation cache and quote recomputation.
-- This records research versions only; holdings and transactions remain the existing ledger.
CREATE TABLE public.intel_portfolio_reading_versions (
 id uuid PRIMARY KEY,
 portfolio_id uuid NOT NULL REFERENCES public.investor_portfolios(id) ON DELETE CASCADE,
 org_id uuid NOT NULL, user_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 artifact jsonb NOT NULL CHECK(jsonb_typeof(artifact)='object' AND octet_length(artifact::text)<=100000),
 generated_at timestamptz NOT NULL,
 expires_at timestamptz,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX intel_portfolio_reading_history ON public.intel_portfolio_reading_versions
 (org_id,user_id,portfolio_id,generated_at DESC,id DESC);
ALTER TABLE public.intel_portfolio_reading_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY private_portfolio_reading_select ON public.intel_portfolio_reading_versions FOR SELECT TO authenticated
 USING(user_id=(SELECT auth.uid()) AND org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS(
 SELECT 1 FROM public.investor_portfolios p WHERE p.id=intel_portfolio_reading_versions.portfolio_id AND p.org_id=intel_portfolio_reading_versions.org_id AND p.user_id=(SELECT auth.uid())));
CREATE POLICY private_portfolio_reading_delete ON public.intel_portfolio_reading_versions FOR DELETE TO authenticated
 USING(user_id=(SELECT auth.uid()) AND org_id IN (SELECT public.intel_portfolio_org_ids()));
REVOKE ALL ON public.intel_portfolio_reading_versions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,DELETE ON public.intel_portfolio_reading_versions TO authenticated;
GRANT SELECT,INSERT,DELETE ON public.intel_portfolio_reading_versions TO service_role;

CREATE FUNCTION app_private.intel_archive_portfolio_reading() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.artifact IS NULL OR NEW.generated_at IS NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.investor_portfolios p JOIN public.org_members m ON m.org_id=p.org_id AND m.user_id=p.user_id
  WHERE p.id=NEW.portfolio_id AND p.org_id=NEW.org_id AND p.user_id=NEW.user_id) THEN
  RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO public.intel_portfolio_reading_versions(id,portfolio_id,org_id,user_id,fingerprint,artifact,generated_at,expires_at)
 VALUES(NEW.operation_id,NEW.portfolio_id,NEW.org_id,NEW.user_id,NEW.fingerprint,NEW.artifact,NEW.generated_at,NEW.expires_at)
 ON CONFLICT(id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.intel_portfolio_reading_versions v WHERE v.id=NEW.operation_id AND v.portfolio_id=NEW.portfolio_id
  AND v.org_id=NEW.org_id AND v.user_id=NEW.user_id AND v.fingerprint=NEW.fingerprint AND v.artifact=NEW.artifact) THEN
  RAISE EXCEPTION 'Research operation already records another version' USING ERRCODE='22023'; END IF;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app_private.intel_archive_portfolio_reading() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_archive_portfolio_reading AFTER INSERT OR UPDATE OF artifact,generated_at ON public.intel_portfolio_research_cache
 FOR EACH ROW EXECUTE FUNCTION app_private.intel_archive_portfolio_reading();

-- Only surviving completed records can be backfilled. No updated_at inference or mutable-memory reconstruction.
INSERT INTO public.intel_portfolio_reading_versions(id,portfolio_id,org_id,user_id,fingerprint,artifact,generated_at,expires_at)
 SELECT c.operation_id,c.portfolio_id,c.org_id,c.user_id,c.fingerprint,c.artifact,c.generated_at,c.expires_at
 FROM public.intel_portfolio_research_cache c JOIN public.investor_portfolios p ON p.id=c.portfolio_id AND p.org_id=c.org_id AND p.user_id=c.user_id
 WHERE c.artifact IS NOT NULL AND c.generated_at IS NOT NULL
 ON CONFLICT(id) DO NOTHING;

-- Deleting a private source or clearing its notes removes derived private words,
-- including versions whose prose may refer to evidence outside their bounded activity excerpt.
CREATE FUNCTION app_private.intel_delete_portfolio_readings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 DELETE FROM public.intel_portfolio_reading_versions v WHERE v.portfolio_id=OLD.portfolio_id;
 RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION app_private.intel_delete_portfolio_readings() FROM PUBLIC,anon,authenticated;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['investor_portfolio_transactions','investor_portfolio_tx','investor_portfolio_sources','investor_portfolio_memory'] LOOP
  EXECUTE format('CREATE TRIGGER intel_delete_reading_history AFTER DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_private.intel_delete_portfolio_readings()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['investor_portfolio_transactions','investor_portfolio_tx'] LOOP
  EXECUTE format('CREATE TRIGGER intel_clear_note_reading_history AFTER UPDATE OF notes ON public.%I FOR EACH ROW WHEN (nullif(btrim(OLD.notes),'''') IS NOT NULL AND nullif(btrim(NEW.notes),'''') IS NULL) EXECUTE FUNCTION app_private.intel_delete_portfolio_readings()',t);
 END LOOP;
END;$$;

-- A clear must also work when the optional memory row never existed.
CREATE FUNCTION public.intel_clear_portfolio_research(p_portfolio_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_org uuid; v_count int;
BEGIN
 SELECT p.org_id INTO v_org FROM public.investor_portfolios p WHERE p.id=p_portfolio_id AND p.user_id=auth.uid()
  AND p.org_id IN (SELECT public.intel_portfolio_org_ids());
 IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501'; END IF;
 DELETE FROM public.intel_portfolio_reading_versions WHERE portfolio_id=p_portfolio_id AND org_id=v_org AND user_id=auth.uid();
 GET DIAGNOSTICS v_count=ROW_COUNT;
 DELETE FROM public.intel_portfolio_research_cache WHERE portfolio_id=p_portfolio_id AND org_id=v_org AND user_id=auth.uid();
 DELETE FROM public.investor_portfolio_memory WHERE portfolio_id=p_portfolio_id AND org_id=v_org AND user_id=auth.uid();
 RETURN jsonb_build_object('deletedReadings',v_count);
END;$$;
REVOKE ALL ON FUNCTION public.intel_clear_portfolio_research(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_clear_portfolio_research(uuid) TO authenticated;
