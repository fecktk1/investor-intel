-- Personal brief memory inherits the artifact's existing owner boundary.
-- Existing organization-shared research keeps its current visibility.
SET lock_timeout='5s';
SET statement_timeout='60s';
CREATE OR REPLACE FUNCTION public.intel_private_brief_memory_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE owner_id uuid; artifact_org uuid;
BEGIN
 SELECT a.private_owner_id,a.org_id INTO owner_id,artifact_org FROM public.research_artifacts a WHERE a.id=NEW.artifact_id;
 IF owner_id IS NOT NULL THEN
   IF NEW.user_id IS DISTINCT FROM owner_id OR NEW.org_id IS DISTINCT FROM artifact_org THEN
     RAISE EXCEPTION 'Private research memory owner mismatch' USING ERRCODE='42501';
   END IF;
   NEW.metadata:=coalesce(NEW.metadata,'{}'::jsonb)||'{"private_user_scope":true}'::jsonb;
   NEW.visibility:='org_private';
 END IF;
 IF TG_OP='UPDATE' AND OLD.metadata->>'private_user_scope'='true' THEN
   IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
     RAISE EXCEPTION 'Private memory ownership cannot be changed' USING ERRCODE='42501';
   END IF;
   NEW.metadata:=coalesce(NEW.metadata,'{}'::jsonb)||'{"private_user_scope":true}'::jsonb;
   NEW.visibility:='org_private';
 END IF;
 IF NEW.metadata->>'private_user_scope'='true' AND (NEW.user_id IS NULL OR NEW.org_id IS NULL OR NEW.visibility<>'org_private') THEN
   RAISE EXCEPTION 'Private memory requires an owner and organization' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.intel_private_brief_memory_scope() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_private_brief_memory_scope BEFORE INSERT OR UPDATE ON public.decision_memory
FOR EACH ROW EXECUTE FUNCTION public.intel_private_brief_memory_scope();
UPDATE public.decision_memory d SET metadata=coalesce(d.metadata,'{}'::jsonb)||'{"private_user_scope":true}'::jsonb
FROM public.research_artifacts a WHERE d.artifact_id=a.id AND a.private_owner_id IS NOT NULL
 AND d.user_id=a.private_owner_id AND d.org_id=a.org_id AND d.metadata->>'private_user_scope' IS DISTINCT FROM 'true';
CREATE POLICY intel_private_memory_boundary ON public.decision_memory AS RESTRICTIVE FOR ALL TO authenticated,anon
USING(coalesce(metadata->>'private_user_scope','false')<>'true' OR
 (user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=decision_memory.org_id AND m.user_id=(SELECT auth.uid()))))
WITH CHECK(coalesce(metadata->>'private_user_scope','false')<>'true' OR
 (user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=decision_memory.org_id AND m.user_id=(SELECT auth.uid()))));
