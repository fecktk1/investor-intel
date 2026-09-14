GRANT USAGE ON SCHEMA app_private TO service_role;
CREATE TABLE public.intel_chart_comments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),share_id uuid NOT NULL REFERENCES public.intel_chart_shares(id) ON DELETE CASCADE,
 snapshot_id uuid NOT NULL REFERENCES public.intel_chart_snapshots(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 anchor jsonb NOT NULL,body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 2000),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX intel_chart_comments_read ON public.intel_chart_comments(share_id,created_at,id);
CREATE INDEX intel_chart_comments_snapshot ON public.intel_chart_comments(snapshot_id);
ALTER TABLE public.intel_chart_comments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_chart_comments FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_chart_comments TO service_role;
CREATE POLICY chart_comments_service ON public.intel_chart_comments FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE TABLE public.intel_chart_comment_operations(
 share_id uuid NOT NULL REFERENCES public.intel_chart_shares(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,comment_id uuid REFERENCES public.intel_chart_comments(id) ON DELETE SET NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(share_id,user_id,operation_id));
ALTER TABLE public.intel_chart_comment_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_chart_comment_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_chart_comment_operations TO service_role;
CREATE POLICY chart_comment_operations_service ON public.intel_chart_comment_operations FOR ALL TO service_role USING(true) WITH CHECK(true);

-- Service-only context: the authenticated viewer is supplied by the Edge
-- Function, never by a URL/body. The share itself selects its organization.
CREATE FUNCTION app_private.intel_chart_review_context(p_token text,p_user uuid) RETURNS public.intel_chart_shares
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.intel_chart_shares;resolved jsonb;
BEGIN
 IF p_user IS NULL THEN RAISE EXCEPTION 'chart_review_unavailable' USING ERRCODE='42501'; END IF;
 resolved:=public.intel_resolve_chart_share(p_token,p_user);
 IF resolved IS NULL OR resolved->>'audience' NOT IN ('owner','org') THEN RAISE EXCEPTION 'chart_review_unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM public.intel_chart_shares WHERE token=p_token;
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=s.org_id AND user_id=p_user) OR public.can_access_intel(p_user,s.org_id) IS NOT TRUE THEN RAISE EXCEPTION 'chart_review_unavailable' USING ERRCODE='42501';END IF;
 RETURN s;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_chart_review_context(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_private.intel_chart_review_context(text,uuid) TO service_role;

CREATE FUNCTION public.intel_chart_review_page(p_token text,p_user uuid,p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.intel_chart_shares;rows jsonb;total integer;
BEGIN
 IF p_page IS NULL OR p_page NOT BETWEEN 0 AND 200 THEN RAISE EXCEPTION 'chart_review_invalid_page';END IF;
 s:=app_private.intel_chart_review_context(p_token,p_user);
 SELECT count(*) INTO total FROM public.intel_chart_comments WHERE share_id=s.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'anchor',c.anchor,'text',c.body,'revision',c.revision,'createdAt',c.created_at,'updatedAt',c.updated_at,
  'author',CASE WHEN c.user_id=p_user THEN 'You' WHEN c.user_id=s.user_id THEN 'Snapshot owner' ELSE 'Team member' END,'canEdit',c.user_id=p_user,'canDelete',c.user_id=p_user OR s.user_id=p_user) ORDER BY c.created_at,c.id),'[]') INTO rows
  FROM (SELECT * FROM public.intel_chart_comments WHERE share_id=s.id ORDER BY created_at,id LIMIT 5 OFFSET p_page*5) c;
 RETURN jsonb_build_object('rows',rows,'total',total,'page',p_page,'hasMore',(p_page+1)*5<total,'audience',s.audience,'expiresAt',s.expires_at);
END $$;
REVOKE ALL ON FUNCTION public.intel_chart_review_page(text,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_chart_review_page(text,uuid,integer) TO service_role;

CREATE FUNCTION public.intel_save_chart_comment(p_token text,p_user uuid,p_id uuid,p_revision integer,p_operation uuid,p_anchor jsonb,p_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.intel_chart_shares;old public.intel_chart_comments;saved public.intel_chart_comments;previous public.intel_chart_comment_operations;layout jsonb;result jsonb;t numeric;price numeric;
BEGIN
 s:=app_private.intel_chart_review_context(p_token,p_user);
 -- Serialize edits/creation and revocation of this capability.
 PERFORM 1 FROM public.intel_chart_shares WHERE id=s.id AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'chart_review_unavailable';END IF;
 IF p_operation IS NULL OR p_revision IS NULL OR p_revision<0 OR p_text IS NULL OR length(btrim(p_text)) NOT BETWEEN 1 AND 2000 OR p_anchor IS NULL
  OR jsonb_typeof(p_anchor->'t') IS DISTINCT FROM 'number' OR jsonb_typeof(p_anchor->'price') IS DISTINCT FROM 'number' OR octet_length(p_anchor::text)>2000 THEN RAISE EXCEPTION 'chart_review_invalid_comment';END IF;
 t:=(p_anchor->>'t')::numeric;price:=(p_anchor->>'price')::numeric;
 SELECT state->'layout' INTO layout FROM public.intel_chart_snapshots WHERE id=s.snapshot_id AND org_id=s.org_id AND user_id=s.user_id;
 IF t<0 OR t>4102444800000 OR price<=0 OR price>1e18 OR layout IS NULL OR jsonb_typeof(layout#>'{range,from}') IS DISTINCT FROM 'number' OR jsonb_typeof(layout#>'{range,to}') IS DISTINCT FROM 'number' OR t<(layout#>>'{range,from}')::numeric OR t>(layout#>>'{range,to}')::numeric THEN RAISE EXCEPTION 'chart_review_anchor_outside_snapshot';END IF;
 SELECT * INTO previous FROM public.intel_chart_comment_operations WHERE share_id=s.id AND user_id=p_user AND operation_id=p_operation;
 IF FOUND THEN IF previous.comment_id IS NULL THEN RAISE EXCEPTION 'chart_review_comment_deleted';END IF;RETURN previous.result;END IF;
 IF p_id IS NULL THEN
  IF p_revision<>0 THEN RAISE EXCEPTION 'chart_review_revision_conflict' USING ERRCODE='40001';END IF;
  IF (SELECT count(*) FROM public.intel_chart_comments WHERE share_id=s.id)>=1000 THEN RAISE EXCEPTION 'chart_review_limit';END IF;
  INSERT INTO public.intel_chart_comments(share_id,snapshot_id,org_id,user_id,anchor,body) VALUES(s.id,s.snapshot_id,s.org_id,p_user,jsonb_build_object('t',t,'price',price),p_text) RETURNING * INTO saved;
 ELSE
  SELECT * INTO old FROM public.intel_chart_comments WHERE id=p_id AND share_id=s.id AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'chart_review_unavailable';END IF;
  IF p_revision<>old.revision THEN RAISE EXCEPTION 'chart_review_revision_conflict' USING ERRCODE='40001';END IF;
  UPDATE public.intel_chart_comments SET anchor=jsonb_build_object('t',t,'price',price),body=p_text,revision=old.revision+1,updated_at=clock_timestamp() WHERE id=old.id RETURNING * INTO saved;
 END IF;
 result:=jsonb_build_object('id',saved.id,'revision',saved.revision);
 INSERT INTO public.intel_chart_comment_operations(share_id,user_id,operation_id,comment_id,result) VALUES(s.id,p_user,p_operation,saved.id,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_save_chart_comment(text,uuid,uuid,integer,uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_save_chart_comment(text,uuid,uuid,integer,uuid,jsonb,text) TO service_role;

CREATE FUNCTION public.intel_delete_chart_comment(p_token text,p_user uuid,p_id uuid,p_revision integer)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.intel_chart_shares;old public.intel_chart_comments;
BEGIN
 s:=app_private.intel_chart_review_context(p_token,p_user);
 SELECT * INTO old FROM public.intel_chart_comments WHERE id=p_id AND share_id=s.id FOR UPDATE;
 IF NOT FOUND THEN RETURN false;END IF;
 IF old.user_id<>p_user AND s.user_id<>p_user THEN RAISE EXCEPTION 'chart_review_unavailable';END IF;
 IF old.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'chart_review_revision_conflict' USING ERRCODE='40001';END IF;
 DELETE FROM public.intel_chart_comments WHERE id=old.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.intel_delete_chart_comment(text,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_delete_chart_comment(text,uuid,uuid,integer) TO service_role;
