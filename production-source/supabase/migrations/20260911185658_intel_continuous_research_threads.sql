CREATE TABLE public.intel_research_threads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.orgs ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles ON DELETE CASCADE,
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 240),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 draft_question text NOT NULL DEFAULT '' CHECK(length(draft_question)<=8000),
 draft_decision text NOT NULL DEFAULT '' CHECK(length(draft_decision)<=16000),
 context jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=16000),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE UNIQUE INDEX intel_thread_subject ON public.intel_research_threads(org_id,user_id,subject);
CREATE INDEX intel_thread_recent ON public.intel_research_threads(org_id,user_id,updated_at DESC,id DESC);
CREATE TABLE public.intel_research_thread_deletions (
 id uuid NOT NULL, org_id uuid NOT NULL REFERENCES public.orgs ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles ON DELETE CASCADE,
 deleted_at timestamptz NOT NULL DEFAULT statement_timestamp(), PRIMARY KEY(org_id,user_id,id)
);
ALTER TABLE public.intel_research_thread_deletions ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_thread_deletions ON public.intel_research_thread_deletions FOR ALL TO authenticated
 USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_research_thread_deletions.org_id AND m.user_id=(SELECT auth.uid())))
 WITH CHECK(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_research_thread_deletions.org_id AND m.user_id=(SELECT auth.uid())));
REVOKE ALL ON public.intel_research_thread_deletions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.intel_research_thread_deletions TO authenticated;
GRANT ALL ON public.intel_research_thread_deletions TO service_role;
CREATE FUNCTION app_private.intel_thread_deleted() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN INSERT INTO public.intel_research_thread_deletions(id,org_id,user_id) VALUES(OLD.id,OLD.org_id,OLD.user_id) ON CONFLICT DO NOTHING; RETURN OLD; END $$;
REVOKE ALL ON FUNCTION app_private.intel_thread_deleted() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_thread_deleted BEFORE DELETE ON public.intel_research_threads FOR EACH ROW EXECUTE FUNCTION app_private.intel_thread_deleted();
ALTER TABLE public.intel_research_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_research_threads ON public.intel_research_threads FOR ALL TO authenticated
 USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_research_threads.org_id AND m.user_id=(SELECT auth.uid())))
 WITH CHECK(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_research_threads.org_id AND m.user_id=(SELECT auth.uid())));
REVOKE ALL ON public.intel_research_threads FROM PUBLIC,anon;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_research_threads TO authenticated;
GRANT ALL ON public.intel_research_threads TO service_role;

CREATE TABLE public.intel_research_thread_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 thread_id uuid NOT NULL REFERENCES public.intel_research_threads ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES public.orgs ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('question','note','receipt','comparison','invalidation','refresh')),
 question text NOT NULL CHECK(length(question) BETWEEN 1 AND 8000),
 decision text NOT NULL DEFAULT '' CHECK(length(decision)<=16000),
 context jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=16000),
 saved_research_id uuid REFERENCES public.saved_research ON DELETE SET NULL,
 evidence_version text CHECK(length(evidence_version)<=160),
 recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(org_id,user_id,operation_id)
);
CREATE INDEX intel_thread_entries_window ON public.intel_research_thread_entries(thread_id,recorded_at DESC,id DESC);
ALTER TABLE public.intel_research_thread_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_research_thread_entries ON public.intel_research_thread_entries FOR ALL TO authenticated
 USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_research_thread_entries.org_id AND m.user_id=(SELECT auth.uid())))
 WITH CHECK(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_research_thread_entries.org_id AND m.user_id=(SELECT auth.uid())));
REVOKE ALL ON public.intel_research_thread_entries FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.intel_research_thread_entries TO authenticated;
GRANT ALL ON public.intel_research_thread_entries TO service_role;

CREATE FUNCTION app_private.intel_thread_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
   IF ROW(NEW.id,NEW.org_id,NEW.user_id,NEW.subject,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.user_id,OLD.subject,OLD.created_at) THEN RAISE EXCEPTION 'Pinned research identity is immutable' USING ERRCODE='42501'; END IF;
   IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'thread_revision_conflict' USING ERRCODE='40001'; END IF;
 ELSE
   PERFORM pg_advisory_xact_lock(hashtextextended('thread:'||NEW.org_id||':'||NEW.user_id,0));
   IF EXISTS(SELECT 1 FROM public.intel_research_thread_deletions WHERE id=NEW.id AND org_id=NEW.org_id AND user_id=NEW.user_id) THEN RAISE EXCEPTION 'Deleted research cannot be recreated by a delayed save'; END IF;
   IF (SELECT count(*) FROM public.intel_research_threads WHERE org_id=NEW.org_id AND user_id=NEW.user_id)>=200 THEN RAISE EXCEPTION 'Research thread limit reached'; END IF;
   NEW.created_at:=statement_timestamp(); NEW.revision:=1;
 END IF;
 IF NEW.context->>'portfolio' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.investor_portfolios WHERE id::text=NEW.context->>'portfolio' AND org_id=NEW.org_id AND user_id=NEW.user_id) THEN RAISE EXCEPTION 'Portfolio context is unavailable' USING ERRCODE='42501'; END IF;
 IF NEW.context->>'thesis' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.intel_theses WHERE id::text=NEW.context->>'thesis' AND org_id=NEW.org_id) THEN RAISE EXCEPTION 'Thesis context is unavailable' USING ERRCODE='42501'; END IF;
 IF NEW.context->>'watchlist' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.watchlists WHERE id::text=NEW.context->>'watchlist' AND org_id=NEW.org_id) THEN RAISE EXCEPTION 'Watchlist context is unavailable' USING ERRCODE='42501'; END IF;
 NEW.updated_at:=statement_timestamp(); RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_thread_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_thread_guard BEFORE INSERT OR UPDATE ON public.intel_research_threads FOR EACH ROW EXECUTE FUNCTION app_private.intel_thread_guard();

CREATE FUNCTION app_private.intel_thread_entry_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
   IF OLD.saved_research_id IS NOT NULL AND NEW.saved_research_id IS NULL AND (to_jsonb(OLD)-'saved_research_id')=(to_jsonb(NEW)-'saved_research_id') THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'Saved thread entries are immutable' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.intel_research_threads WHERE id=NEW.thread_id AND org_id=NEW.org_id AND user_id=NEW.user_id) THEN RAISE EXCEPTION 'Thread is unavailable' USING ERRCODE='42501'; END IF;
 IF NEW.context IS DISTINCT FROM (SELECT context FROM public.intel_research_threads WHERE id=NEW.thread_id) THEN RAISE EXCEPTION 'Thread context changed; save the current context before recording this entry' USING ERRCODE='40001'; END IF;
 IF NEW.saved_research_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.saved_research WHERE id=NEW.saved_research_id AND org_id=NEW.org_id AND user_id=NEW.user_id) THEN RAISE EXCEPTION 'Research reference is unavailable' USING ERRCODE='42501'; END IF;
 NEW.recorded_at:=statement_timestamp(); RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_thread_entry_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_thread_entry_guard BEFORE INSERT OR UPDATE ON public.intel_research_thread_entries FOR EACH ROW EXECUTE FUNCTION app_private.intel_thread_entry_guard();

CREATE FUNCTION public.intel_save_research_thread(p_org_id uuid,p_expected_user uuid,p_id uuid,p_revision integer,p_subject text,p_title text,p_question text,p_decision text,p_context jsonb)
RETURNS public.intel_research_threads LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE saved public.intel_research_threads;
BEGIN
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_expected_user THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF p_revision=0 THEN
  INSERT INTO public.intel_research_threads(id,org_id,user_id,subject,title,draft_question,draft_decision,context) VALUES(p_id,p_org_id,auth.uid(),p_subject,p_title,p_question,p_decision,p_context) ON CONFLICT DO NOTHING RETURNING * INTO saved;
 ELSE
  UPDATE public.intel_research_threads SET title=p_title,draft_question=p_question,draft_decision=p_decision,context=p_context,revision=revision+1 WHERE id=p_id AND org_id=p_org_id AND user_id=auth.uid() AND subject=p_subject AND revision=p_revision RETURNING * INTO saved;
 END IF;
 IF saved.id IS NULL THEN RAISE EXCEPTION 'thread_revision_conflict' USING ERRCODE='40001'; END IF;
 RETURN saved;
END $$;
REVOKE ALL ON FUNCTION public.intel_save_research_thread(uuid,uuid,uuid,integer,text,text,text,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_save_research_thread(uuid,uuid,uuid,integer,text,text,text,text,jsonb) TO authenticated;

CREATE FUNCTION public.intel_append_research_thread(p_org_id uuid,p_expected_user uuid,p_thread_id uuid,p_operation uuid,p_action text,p_question text,p_decision text,p_context jsonb,p_saved_id uuid DEFAULT NULL,p_evidence_version text DEFAULT NULL)
RETURNS public.intel_research_thread_entries LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE saved public.intel_research_thread_entries;
BEGIN
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_expected_user THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('thread-entry:'||p_org_id||':'||auth.uid()||':'||p_operation,0));
 SELECT * INTO saved FROM public.intel_research_thread_entries WHERE org_id=p_org_id AND user_id=auth.uid() AND operation_id=p_operation;
 IF FOUND THEN
  IF ROW(saved.thread_id,saved.action,saved.question,saved.decision,saved.context,saved.saved_research_id,saved.evidence_version) IS DISTINCT FROM ROW(p_thread_id,p_action,p_question,p_decision,p_context,p_saved_id,p_evidence_version) THEN RAISE EXCEPTION 'Thread operation was already used for different content'; END IF;
  RETURN saved;
 END IF;
 INSERT INTO public.intel_research_thread_entries(thread_id,org_id,user_id,operation_id,action,question,decision,context,saved_research_id,evidence_version) VALUES(p_thread_id,p_org_id,auth.uid(),p_operation,p_action,p_question,p_decision,p_context,p_saved_id,p_evidence_version) RETURNING * INTO saved;
 RETURN saved;
END $$;
REVOKE ALL ON FUNCTION public.intel_append_research_thread(uuid,uuid,uuid,uuid,text,text,text,jsonb,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_append_research_thread(uuid,uuid,uuid,uuid,text,text,text,jsonb,uuid,text) TO authenticated;
