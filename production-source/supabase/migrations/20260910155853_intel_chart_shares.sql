-- All snapshot bodies are served through the source-policy-aware service.
-- RLS remains as defense in depth; direct reads must not bypass a policy change.
REVOKE SELECT ON public.intel_chart_snapshots FROM authenticated;
CREATE TABLE public.intel_chart_shares (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 snapshot_id uuid REFERENCES public.intel_chart_snapshots(id) ON DELETE SET NULL,
 operation_id uuid NOT NULL,
 token text NOT NULL UNIQUE CHECK(token ~ '^[a-f0-9]{64}$'),
 audience text NOT NULL CHECK(audience IN ('owner','org','unlisted','public')),
 drawing_ids uuid[] NOT NULL DEFAULT '{}' CHECK(cardinality(drawing_ids)<=200),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,
 UNIQUE(org_id,user_id,operation_id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
CREATE INDEX intel_chart_share_owner ON public.intel_chart_shares(org_id,user_id,created_at DESC,id DESC);
CREATE INDEX intel_chart_share_snapshot ON public.intel_chart_shares(snapshot_id) WHERE snapshot_id IS NOT NULL;
ALTER TABLE public.intel_chart_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_chart_shares FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.intel_chart_shares TO service_role;
GRANT UPDATE(revoked_at) ON public.intel_chart_shares TO service_role;

CREATE FUNCTION public.intel_create_chart_share(p_org uuid,p_user uuid,p_snapshot uuid,p_operation uuid,p_token text,p_audience text,p_drawings uuid[],p_expires timestamptz)
RETURNS public.intel_chart_shares LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE previous public.intel_chart_shares; original jsonb; stamp timestamptz:=clock_timestamp();
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) OR public.can_access_intel(p_user,p_org) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF p_operation IS NULL THEN RAISE EXCEPTION 'invalid_chart_share_operation';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('chart-share:'||p_org::text||':'||p_user::text,0));
 SELECT * INTO previous FROM public.intel_chart_shares WHERE org_id=p_org AND user_id=p_user AND operation_id=p_operation;
 IF FOUND THEN RETURN previous;END IF;
 SELECT state INTO original FROM public.intel_chart_snapshots WHERE id=p_snapshot AND org_id=p_org AND user_id=p_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'chart_share_unavailable';END IF;
 IF p_audience IS NULL OR p_audience NOT IN ('owner','org','unlisted','public') OR p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' OR p_expires IS NULL OR p_expires<=stamp OR p_expires>stamp+interval '30 days' OR p_drawings IS NULL OR cardinality(p_drawings)>200 OR EXISTS(SELECT 1 FROM unnest(p_drawings) d WHERE d IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(original#>'{layout,drawings}') a WHERE a->>'id'=d::text)) OR cardinality(p_drawings)<>(SELECT count(DISTINCT d) FROM unnest(p_drawings) d) THEN RAISE EXCEPTION 'invalid_chart_share';END IF;
 IF (SELECT count(*) FROM public.intel_chart_shares WHERE org_id=p_org AND user_id=p_user AND snapshot_id IS NOT NULL AND revoked_at IS NULL AND expires_at>stamp)>=250 THEN RAISE EXCEPTION 'chart_share_limit';END IF;
 INSERT INTO public.intel_chart_shares(org_id,user_id,snapshot_id,operation_id,token,audience,drawing_ids,expires_at,created_at) VALUES(p_org,p_user,p_snapshot,p_operation,p_token,p_audience,p_drawings,p_expires,stamp) RETURNING * INTO previous;
 RETURN previous;
END $$;
REVOKE ALL ON FUNCTION public.intel_create_chart_share(uuid,uuid,uuid,uuid,text,text,uuid[],timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_create_chart_share(uuid,uuid,uuid,uuid,text,text,uuid[],timestamptz) TO service_role;

CREATE FUNCTION public.intel_revoke_chart_share(p_org uuid,p_user uuid,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE affected integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 UPDATE public.intel_chart_shares SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id=p_id AND org_id=p_org AND user_id=p_user;
 GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected>0;
END $$;
REVOKE ALL ON FUNCTION public.intel_revoke_chart_share(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_revoke_chart_share(uuid,uuid,uuid) TO service_role;

-- Only the edge service may supply p_viewer, after auth.getUser verifies a JWT.
-- The share's row determines the organization; a URL/body never selects it.
CREATE FUNCTION public.intel_resolve_chart_share(p_token text,p_viewer uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE s public.intel_chart_shares; original jsonb;
BEGIN
 IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN RETURN NULL;END IF;
 SELECT * INTO s FROM public.intel_chart_shares WHERE token=p_token AND revoked_at IS NULL AND expires_at>statement_timestamp() AND snapshot_id IS NOT NULL;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=s.org_id AND user_id=s.user_id) OR public.can_access_intel(s.user_id,s.org_id) IS NOT TRUE THEN RETURN NULL;END IF;
 IF s.audience='owner' AND p_viewer IS DISTINCT FROM s.user_id THEN RETURN NULL;END IF;
 IF s.audience='org' AND (p_viewer IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=s.org_id AND user_id=p_viewer) OR public.can_access_intel(p_viewer,s.org_id) IS NOT TRUE) THEN RETURN NULL;END IF;
 SELECT state INTO original FROM public.intel_chart_snapshots WHERE id=s.snapshot_id AND org_id=s.org_id AND user_id=s.user_id;
 IF NOT FOUND THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('snapshot',original,'audience',s.audience,'drawingIds',s.drawing_ids,'expiresAt',s.expires_at);
END $$;
REVOKE ALL ON FUNCTION public.intel_resolve_chart_share(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_resolve_chart_share(text,uuid) TO service_role;
