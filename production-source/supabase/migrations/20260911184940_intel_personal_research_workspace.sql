-- Visual preferences only. Chart layouts, prices, accounting and authored
-- research retain their existing stores and authorization contracts.
CREATE TABLE public.intel_workspace_preferences (
 org_id uuid NOT NULL REFERENCES public.orgs ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles ON DELETE CASCADE,
 slot text NOT NULL CHECK(slot IN ('selection','desk','markets','dossier')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 value jsonb NOT NULL CHECK(jsonb_typeof(value)='object' AND value->>'schemaVersion'='1' AND octet_length(value::text)<=16000),
 updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(org_id,user_id,slot)
);
ALTER TABLE public.intel_workspace_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_workspace_preferences ON public.intel_workspace_preferences FOR ALL TO authenticated
 USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_workspace_preferences.org_id AND m.user_id=(SELECT auth.uid())))
 WITH CHECK(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_workspace_preferences.org_id AND m.user_id=(SELECT auth.uid())));
REVOKE ALL ON public.intel_workspace_preferences FROM PUBLIC,anon;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_workspace_preferences TO authenticated;
GRANT ALL ON public.intel_workspace_preferences TO service_role;
CREATE FUNCTION app_private.intel_workspace_preference_version() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF ROW(NEW.org_id,NEW.user_id,NEW.slot) IS DISTINCT FROM ROW(OLD.org_id,OLD.user_id,OLD.slot) THEN RAISE EXCEPTION 'Preference ownership is immutable' USING ERRCODE='42501'; END IF;
 IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'workspace_revision_conflict' USING ERRCODE='40001'; END IF;
 NEW.updated_at:=statement_timestamp(); RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_workspace_preference_version() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_workspace_preference_version BEFORE UPDATE ON public.intel_workspace_preferences FOR EACH ROW EXECUTE FUNCTION app_private.intel_workspace_preference_version();

CREATE FUNCTION public.intel_save_workspace_preferences(p_org_id uuid,p_expected_user uuid,p_slot text,p_revision integer,p_value jsonb)
RETURNS public.intel_workspace_preferences LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE saved public.intel_workspace_preferences;
BEGIN
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_expected_user THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF p_revision=0 THEN
   INSERT INTO public.intel_workspace_preferences(org_id,user_id,slot,value) VALUES(p_org_id,auth.uid(),p_slot,p_value) ON CONFLICT DO NOTHING RETURNING * INTO saved;
 ELSE
   UPDATE public.intel_workspace_preferences SET value=p_value,revision=revision+1 WHERE org_id=p_org_id AND user_id=auth.uid() AND slot=p_slot AND revision=p_revision RETURNING * INTO saved;
 END IF;
 IF saved.org_id IS NULL THEN RAISE EXCEPTION 'workspace_revision_conflict' USING ERRCODE='40001'; END IF;
 RETURN saved;
END $$;
REVOKE ALL ON FUNCTION public.intel_save_workspace_preferences(uuid,uuid,text,integer,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_save_workspace_preferences(uuid,uuid,text,integer,jsonb) TO authenticated;
