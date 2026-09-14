-- Parent account/workspace deletion must remain possible. Only retain a retry
-- tombstone while both authorization parents still exist.
CREATE OR REPLACE FUNCTION app_private.intel_thread_deleted() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.orgs WHERE id=OLD.org_id) AND EXISTS(SELECT 1 FROM public.profiles WHERE id=OLD.user_id) THEN
  INSERT INTO public.intel_research_thread_deletions(id,org_id,user_id) VALUES(OLD.id,OLD.org_id,OLD.user_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN OLD;
END $$;
