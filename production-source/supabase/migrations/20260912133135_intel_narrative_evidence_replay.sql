-- Public market/narrative inputs only. Access is through an authorized research
-- artifact, never by exposing the shared source store to authenticated clients.
CREATE TABLE public.intel_narrative_evidence_snapshots (
 id text PRIMARY KEY CHECK(id ~ '^narrative-input:[a-f0-9]{64}$'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 slug text NOT NULL CHECK(slug ~ '^[a-z0-9][a-z0-9_-]{0,119}$'),
 pack jsonb CHECK(pack IS NULL OR (jsonb_typeof(pack)='object' AND octet_length(pack::text)<=600000)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 retain_until timestamptz NOT NULL,
 pruned_at timestamptz,
 CHECK(id='narrative-input:'||content_hash),
 CHECK((pack IS NULL)=(pruned_at IS NOT NULL)),
 CHECK(retain_until<=recorded_at+interval '30 days')
);
CREATE INDEX intel_narrative_input_expiry ON public.intel_narrative_evidence_snapshots(retain_until,id) WHERE pack IS NOT NULL;
ALTER TABLE public.intel_narrative_evidence_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_narrative_evidence_snapshots FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.intel_narrative_evidence_snapshots TO service_role;
GRANT UPDATE(pack,pruned_at) ON public.intel_narrative_evidence_snapshots TO service_role;

-- Only expiry pruning can alter a row. No retries or cache reads reset clocks,
-- replace source words, restore a pruned pack, or extend source retention.
CREATE FUNCTION public.intel_narrative_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF OLD.pack IS NULL OR NEW.pack IS NOT NULL OR OLD.retain_until>clock_timestamp()
 OR NEW.pruned_at IS NULL OR NEW.pruned_at<OLD.retain_until
 OR (to_jsonb(NEW)-'pack'-'pruned_at') IS DISTINCT FROM (to_jsonb(OLD)-'pack'-'pruned_at')
 THEN RAISE EXCEPTION 'narrative_snapshot_immutable'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.intel_narrative_snapshot_immutable() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_narrative_snapshot_immutable BEFORE UPDATE ON public.intel_narrative_evidence_snapshots
 FOR EACH ROW EXECUTE FUNCTION public.intel_narrative_snapshot_immutable();

CREATE FUNCTION public.intel_record_narrative_snapshot(p_hash text,p_slug text,p_pack jsonb,p_retain_until timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r public.intel_narrative_evidence_snapshots;
BEGIN
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9_-]{0,119}$'
 OR p_pack IS NULL OR jsonb_typeof(p_pack)<>'object' OR octet_length(p_pack::text)>600000 OR p_pack->>'slug' IS DISTINCT FROM p_slug
 OR p_retain_until IS NULL OR p_retain_until<=clock_timestamp() OR p_retain_until>clock_timestamp()+interval '30 days'
 THEN RAISE EXCEPTION 'invalid_narrative_snapshot'; END IF;
 INSERT INTO public.intel_narrative_evidence_snapshots(id,content_hash,slug,pack,retain_until)
 VALUES('narrative-input:'||p_hash,p_hash,p_slug,p_pack,p_retain_until) ON CONFLICT(id) DO NOTHING;
 SELECT * INTO STRICT r FROM public.intel_narrative_evidence_snapshots WHERE id='narrative-input:'||p_hash;
 IF r.pack IS NULL OR r.retain_until<=clock_timestamp() THEN RAISE EXCEPTION 'narrative_snapshot_expired'; END IF;
 IF r.pack IS DISTINCT FROM p_pack OR r.slug IS DISTINCT FROM p_slug THEN RAISE EXCEPTION 'narrative_snapshot_collision'; END IF;
 RETURN jsonb_build_object('id',r.id,'content_hash',r.content_hash,'slug',r.slug,'recorded_at',r.recorded_at,'retain_until',r.retain_until);
END $$;
REVOKE ALL ON FUNCTION public.intel_record_narrative_snapshot(text,text,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_narrative_snapshot(text,text,jsonb,timestamptz) TO service_role;

CREATE FUNCTION public.intel_prune_narrative_snapshots(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'invalid_narrative_prune_limit'; END IF;
 WITH expired AS (SELECT id FROM public.intel_narrative_evidence_snapshots WHERE pack IS NOT NULL AND retain_until<=clock_timestamp() ORDER BY retain_until,id LIMIT p_limit FOR UPDATE SKIP LOCKED)
 UPDATE public.intel_narrative_evidence_snapshots s SET pack=NULL,pruned_at=clock_timestamp() FROM expired e WHERE s.id=e.id;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.intel_prune_narrative_snapshots(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_prune_narrative_snapshots(integer) TO service_role;

-- Independent of the three pending investigation migrations and worker v6.
-- Refuse installation without a scheduler; never silently retain expired packs.
DO $$ BEGIN
 IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN RAISE EXCEPTION 'narrative_snapshot_cron_required'; END IF;
 PERFORM cron.schedule('intel-narrative-input-retention','*/10 * * * *','select public.intel_prune_narrative_snapshots(500)');
END $$;
