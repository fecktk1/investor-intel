-- Personal organization is separate from the immutable saved words and evidence.
CREATE TABLE public.intel_saved_research_properties(
 research_id uuid NOT NULL REFERENCES public.saved_research(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 label text NOT NULL DEFAULT '' CHECK(length(label)<=120),tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(tags)<=12),
 workflow_state text NOT NULL DEFAULT 'saved' CHECK(workflow_state IN('saved','reviewing','reviewed')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),PRIMARY KEY(research_id,user_id)
);
ALTER TABLE public.intel_saved_research_properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY personal_research_properties ON public.intel_saved_research_properties FOR ALL TO authenticated
 USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_saved_research_properties.org_id AND m.user_id=(SELECT auth.uid())) AND EXISTS(SELECT 1 FROM public.saved_research s WHERE s.id=research_id AND s.org_id=intel_saved_research_properties.org_id))
 WITH CHECK(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_saved_research_properties.org_id AND m.user_id=(SELECT auth.uid())) AND EXISTS(SELECT 1 FROM public.saved_research s WHERE s.id=research_id AND s.org_id=intel_saved_research_properties.org_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_saved_research_properties TO authenticated;
CREATE FUNCTION app_private.intel_research_properties_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.research_id,NEW.org_id,NEW.user_id) IS DISTINCT FROM ROW(OLD.research_id,OLD.org_id,OLD.user_id) THEN RAISE EXCEPTION 'Research property scope cannot change' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Research properties changed; reload before saving' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(NEW.tags) tag WHERE tag IS NULL OR length(tag) NOT BETWEEN 1 AND 40) THEN RAISE EXCEPTION 'Use up to 12 tags of 1 to 40 characters' USING ERRCODE='22023'; END IF;
 NEW.updated_at:=statement_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_research_properties_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_research_properties_guard BEFORE INSERT OR UPDATE ON public.intel_saved_research_properties FOR EACH ROW EXECUTE FUNCTION app_private.intel_research_properties_guard();
CREATE FUNCTION public.intel_save_research_properties(p_org_id uuid,p_user uuid,p_research uuid,p_revision integer,p_label text,p_tags text[],p_state text)
RETURNS public.intel_saved_research_properties LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE saved public.intel_saved_research_properties;
BEGIN
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF p_revision=0 THEN
  INSERT INTO public.intel_saved_research_properties(research_id,org_id,user_id,label,tags,workflow_state) VALUES(p_research,p_org_id,p_user,p_label,p_tags,p_state) ON CONFLICT DO NOTHING RETURNING * INTO saved;
 ELSE
  UPDATE public.intel_saved_research_properties SET label=p_label,tags=p_tags,workflow_state=p_state,revision=revision+1 WHERE research_id=p_research AND org_id=p_org_id AND user_id=p_user AND revision=p_revision RETURNING * INTO saved;
 END IF;
 IF saved.research_id IS NULL THEN RAISE EXCEPTION 'Research properties changed; reload before saving' USING ERRCODE='40001'; END IF;
 RETURN saved;
END $$;
REVOKE ALL ON FUNCTION public.intel_save_research_properties(uuid,uuid,uuid,integer,text,text[],text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_save_research_properties(uuid,uuid,uuid,integer,text,text[],text) TO authenticated;
CREATE FUNCTION app_private.intel_thread_receipt_reference() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE fingerprint text;
BEGIN
 IF NEW.evidence_version IS NOT NULL THEN
  SELECT investigation_receipt->>'fingerprint' INTO fingerprint FROM public.saved_research WHERE id=NEW.saved_research_id AND org_id=NEW.org_id AND user_id=NEW.user_id;
  IF fingerprint IS NULL OR fingerprint IS DISTINCT FROM NEW.evidence_version THEN RAISE EXCEPTION 'Saved evidence version does not match the original receipt' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_thread_receipt_reference() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_thread_receipt_reference BEFORE INSERT ON public.intel_research_thread_entries FOR EACH ROW EXECUTE FUNCTION app_private.intel_thread_receipt_reference();
