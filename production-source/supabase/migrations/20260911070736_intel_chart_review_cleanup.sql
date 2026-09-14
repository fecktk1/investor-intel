-- Authors retain cleanup of their text after capability/source/plan expiry.
-- This path never resolves prices or reveals another author's review text.
CREATE FUNCTION public.intel_chart_owned_comments(p_token text,p_user uuid,p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.intel_chart_shares;rows jsonb;
BEGIN
 IF p_page IS NULL OR p_page NOT BETWEEN 0 AND 200 THEN RAISE EXCEPTION 'chart_review_invalid_page';END IF;
 SELECT * INTO s FROM public.intel_chart_shares WHERE token=p_token AND audience IN ('owner','org');
 IF NOT FOUND OR p_user IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=s.org_id AND user_id=p_user) THEN RAISE EXCEPTION 'chart_review_unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'text',c.body,'anchor',c.anchor,'revision',c.revision,'createdAt',c.created_at,'updatedAt',c.updated_at) ORDER BY c.created_at,c.id),'[]') INTO rows
  FROM (SELECT * FROM public.intel_chart_comments WHERE share_id=s.id AND user_id=p_user ORDER BY created_at,id LIMIT 6 OFFSET p_page*5)c;
 RETURN jsonb_build_object('rows',rows,'page',p_page,'hasMore',jsonb_array_length(rows)>5);
END $$;
REVOKE ALL ON FUNCTION public.intel_chart_owned_comments(text,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_chart_owned_comments(text,uuid,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.intel_delete_chart_comment(p_token text,p_user uuid,p_id uuid,p_revision integer)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.intel_chart_shares;old public.intel_chart_comments;
BEGIN
 SELECT * INTO s FROM public.intel_chart_shares WHERE token=p_token AND audience IN ('owner','org');
 IF NOT FOUND OR p_user IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=s.org_id AND user_id=p_user) THEN RAISE EXCEPTION 'chart_review_unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_revision IS NULL OR p_revision<1 THEN RAISE EXCEPTION 'chart_review_invalid_comment';END IF;
 SELECT * INTO old FROM public.intel_chart_comments WHERE id=p_id AND share_id=s.id FOR UPDATE;
 IF NOT FOUND THEN RETURN false;END IF;
 IF old.user_id<>p_user AND s.user_id<>p_user THEN RAISE EXCEPTION 'chart_review_unavailable';END IF;
 IF old.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'chart_review_revision_conflict' USING ERRCODE='40001';END IF;
 DELETE FROM public.intel_chart_comments WHERE id=old.id;
 RETURN true;
END $$;
