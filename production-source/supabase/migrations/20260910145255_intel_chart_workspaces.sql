CREATE TABLE public.intel_chart_layouts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 asset text NOT NULL CHECK(length(asset) BETWEEN 1 AND 240),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120),
 state jsonb NOT NULL CHECK(jsonb_typeof(state)='object' AND state->>'schemaVersion'='1' AND state->>'asset'=asset AND octet_length(state::text)<=200000),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX intel_chart_layout_owner ON public.intel_chart_layouts(org_id,user_id,updated_at DESC,id DESC);
CREATE INDEX intel_chart_layout_asset ON public.intel_chart_layouts(org_id,user_id,asset,updated_at DESC);
ALTER TABLE public.intel_chart_layouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_chart_layout_read ON public.intel_chart_layouts FOR SELECT TO authenticated
 USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_chart_layouts.org_id AND m.user_id=(SELECT auth.uid())));
REVOKE ALL ON public.intel_chart_layouts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.intel_chart_layouts TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_chart_layouts TO service_role;

CREATE TABLE public.intel_chart_layout_operations (
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 layout_id uuid REFERENCES public.intel_chart_layouts(id) ON DELETE SET NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,user_id,operation_id)
);
ALTER TABLE public.intel_chart_layout_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_chart_layout_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.intel_chart_layout_operations TO service_role;

CREATE OR REPLACE FUNCTION public.intel_save_chart_layout(p_org uuid,p_user uuid,p_id uuid,p_revision integer,p_operation uuid,p_title text,p_state jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE old public.intel_chart_layouts; saved public.intel_chart_layouts; previous jsonb; previous_id uuid; result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) OR public.can_access_intel(p_user,p_org) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF p_operation IS NULL OR p_revision IS NULL OR p_revision<0 OR p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 120
  OR p_state IS NULL OR jsonb_typeof(p_state)<>'object' OR p_state->>'schemaVersion' IS DISTINCT FROM '1'
  OR coalesce(length(p_state->>'asset'),0) NOT BETWEEN 1 AND 240 OR octet_length(p_state::text)>200000
  OR jsonb_typeof(p_state->'drawings') IS DISTINCT FROM 'array' OR jsonb_typeof(p_state->'studies') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'invalid_chart_layout'; END IF;
 IF jsonb_array_length(p_state->'drawings')>200 OR jsonb_array_length(p_state->'studies')>20 THEN RAISE EXCEPTION 'chart_layout_limit'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text||':'||p_user::text||':'||p_operation::text,0));
 SELECT o.result,o.layout_id INTO previous,previous_id FROM public.intel_chart_layout_operations o WHERE o.org_id=p_org AND o.user_id=p_user AND o.operation_id=p_operation;
 IF FOUND THEN
  IF previous_id IS NULL THEN RAISE EXCEPTION 'chart_layout_deleted'; END IF;
  RETURN previous;
 END IF;
 IF p_id IS NULL THEN
  IF p_revision<>0 THEN RAISE EXCEPTION 'chart_revision_conflict' USING ERRCODE='40001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chart-limit:'||p_org::text||':'||p_user::text,0));
  IF (SELECT count(*) FROM public.intel_chart_layouts WHERE org_id=p_org AND user_id=p_user)>=100 THEN RAISE EXCEPTION 'chart_layout_limit'; END IF;
  INSERT INTO public.intel_chart_layouts(org_id,user_id,asset,title,state) VALUES(p_org,p_user,p_state->>'asset',btrim(p_title),p_state) RETURNING * INTO saved;
 ELSE
  SELECT * INTO old FROM public.intel_chart_layouts WHERE id=p_id AND org_id=p_org AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  IF old.revision<>p_revision THEN RAISE EXCEPTION 'chart_revision_conflict' USING ERRCODE='40001'; END IF;
  UPDATE public.intel_chart_layouts SET title=btrim(p_title),asset=p_state->>'asset',state=p_state,revision=old.revision+1,updated_at=clock_timestamp() WHERE id=old.id RETURNING * INTO saved;
 END IF;
 -- Retry receipts contain no private title, annotation or market data. A deleted
 -- layout leaves a content-free tombstone so a delayed retry cannot recreate it.
 result:=jsonb_build_object('id',saved.id,'revision',saved.revision,'updatedAt',saved.updated_at);
 INSERT INTO public.intel_chart_layout_operations(org_id,user_id,operation_id,layout_id,result) VALUES(p_org,p_user,p_operation,saved.id,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_save_chart_layout(uuid,uuid,uuid,integer,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_save_chart_layout(uuid,uuid,uuid,integer,uuid,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.intel_delete_chart_layout(p_org uuid,p_user uuid,p_id uuid,p_revision integer)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE old public.intel_chart_layouts;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO old FROM public.intel_chart_layouts WHERE org_id=p_org AND user_id=p_user AND id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF p_revision IS DISTINCT FROM old.revision THEN RAISE EXCEPTION 'chart_revision_conflict' USING ERRCODE='40001'; END IF;
 DELETE FROM public.intel_chart_layouts WHERE id=old.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.intel_delete_chart_layout(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_delete_chart_layout(uuid,uuid,uuid,integer) TO service_role;
