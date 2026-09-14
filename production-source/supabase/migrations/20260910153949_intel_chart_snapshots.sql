CREATE TABLE public.intel_chart_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 asset text NOT NULL CHECK(length(asset) BETWEEN 1 AND 240),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120),
 state jsonb NOT NULL CHECK(jsonb_typeof(state)='object' AND state->>'schemaVersion'='1' AND state#>>'{layout,asset}'=asset AND octet_length(state::text)<=1500000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX intel_chart_snapshot_owner ON public.intel_chart_snapshots(org_id,user_id,created_at DESC,id DESC);
ALTER TABLE public.intel_chart_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_chart_snapshot_read ON public.intel_chart_snapshots FOR SELECT TO authenticated
 USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=intel_chart_snapshots.org_id AND m.user_id=(SELECT auth.uid())));
REVOKE ALL ON public.intel_chart_snapshots FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.intel_chart_snapshots TO authenticated;
GRANT SELECT,INSERT,DELETE ON public.intel_chart_snapshots TO service_role;

CREATE TABLE public.intel_chart_snapshot_operations (
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 snapshot_id uuid REFERENCES public.intel_chart_snapshots(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,user_id,operation_id)
);
ALTER TABLE public.intel_chart_snapshot_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_chart_snapshot_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.intel_chart_snapshot_operations TO service_role;

ALTER TABLE public.saved_research ADD COLUMN chart_snapshot_id uuid REFERENCES public.intel_chart_snapshots(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX saved_research_chart_snapshot ON public.saved_research(chart_snapshot_id) WHERE chart_snapshot_id IS NOT NULL;
CREATE FUNCTION public.intel_validate_saved_chart_owner() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.chart_snapshot_id IS NOT NULL AND (NEW.private_owner_id IS DISTINCT FROM NEW.user_id OR NOT EXISTS(SELECT 1 FROM public.intel_chart_snapshots WHERE id=NEW.chart_snapshot_id AND org_id=NEW.org_id AND user_id=NEW.user_id)) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.intel_validate_saved_chart_owner() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER validate_saved_chart_owner BEFORE INSERT OR UPDATE ON public.saved_research FOR EACH ROW EXECUTE FUNCTION public.intel_validate_saved_chart_owner();
-- Deleting the saved research item is also an authorized deletion of its
-- private immutable snapshot. A content-free retry tombstone prevents revival.
CREATE FUNCTION public.intel_delete_saved_chart_snapshot() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF OLD.chart_snapshot_id IS NOT NULL THEN DELETE FROM public.intel_chart_snapshots WHERE id=OLD.chart_snapshot_id AND user_id=OLD.user_id AND org_id=OLD.org_id; END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.intel_delete_saved_chart_snapshot() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER delete_saved_chart_snapshot AFTER DELETE ON public.saved_research FOR EACH ROW EXECUTE FUNCTION public.intel_delete_saved_chart_snapshot();

CREATE FUNCTION public.intel_save_chart_snapshot(p_org uuid,p_user uuid,p_operation uuid,p_snapshot jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE previous uuid; saved uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) OR public.can_access_intel(p_user,p_org) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF p_operation IS NULL THEN RAISE EXCEPTION 'invalid_snapshot_operation'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('chart-snapshot:'||p_org::text||':'||p_user::text||':'||p_operation::text,0));
 SELECT snapshot_id INTO previous FROM public.intel_chart_snapshot_operations WHERE org_id=p_org AND user_id=p_user AND operation_id=p_operation;
 IF FOUND THEN IF previous IS NULL THEN RAISE EXCEPTION 'chart_snapshot_deleted'; END IF;RETURN previous;END IF;
 IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot)<>'object' OR p_snapshot->>'schemaVersion' IS DISTINCT FROM '1' OR coalesce(length(p_snapshot->>'title'),0) NOT BETWEEN 1 AND 120 OR coalesce(length(p_snapshot#>>'{layout,asset}'),0) NOT BETWEEN 1 AND 240 OR octet_length(p_snapshot::text)>1500000 THEN RAISE EXCEPTION 'invalid_chart_snapshot'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('chart-snapshot-limit:'||p_org::text||':'||p_user::text,0));
 IF (SELECT count(*) FROM public.intel_chart_snapshots WHERE org_id=p_org AND user_id=p_user)>=200 THEN RAISE EXCEPTION 'chart_snapshot_limit'; END IF;
 INSERT INTO public.intel_chart_snapshots(org_id,user_id,asset,title,state) VALUES(p_org,p_user,p_snapshot#>>'{layout,asset}',p_snapshot->>'title',p_snapshot) RETURNING id INTO saved;
 INSERT INTO public.saved_research(org_id,user_id,private_owner_id,title,snapshot,tags,chart_snapshot_id)
 VALUES(p_org,p_user,p_user,p_snapshot->>'title',jsonb_build_object('kind','chart_snapshot','snapshotId',saved,'subject',p_snapshot#>>'{layout,asset}','summary','Immutable chart snapshot'),ARRAY['chart','snapshot'],saved);
 INSERT INTO public.intel_chart_snapshot_operations(org_id,user_id,operation_id,snapshot_id) VALUES(p_org,p_user,p_operation,saved);
 RETURN saved;
END $$;
REVOKE ALL ON FUNCTION public.intel_save_chart_snapshot(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_save_chart_snapshot(uuid,uuid,uuid,jsonb) TO service_role;

CREATE FUNCTION public.intel_delete_chart_snapshot(p_org uuid,p_user uuid,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE count integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 DELETE FROM public.intel_chart_snapshots WHERE id=p_id AND org_id=p_org AND user_id=p_user;
 GET DIAGNOSTICS count=ROW_COUNT;
 RETURN count>0;
END $$;
REVOKE ALL ON FUNCTION public.intel_delete_chart_snapshot(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_delete_chart_snapshot(uuid,uuid,uuid) TO service_role;
