-- Multiple independently licensed series share one immutable research snapshot.
-- Expiry redacts only the due source and schedules the next remaining deadline.
CREATE OR REPLACE FUNCTION app_private.intel_chart_snapshot_retention() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE expiry timestamptz;earliest timestamptz;capture jsonb;item record;captures jsonb;
BEGIN
 IF NEW.state#>'{layout,comparison}' IS NOT NULL THEN
  captures:=NEW.state->'comparisonSeries';
  IF jsonb_typeof(captures) IS DISTINCT FROM 'array' OR jsonb_array_length(captures) NOT BETWEEN 2 AND 4
   OR jsonb_array_length(captures) IS DISTINCT FROM jsonb_array_length(NEW.state#>'{layout,comparison,assets}')
   OR jsonb_typeof(NEW.state->'bars') IS DISTINCT FROM 'null' THEN RAISE EXCEPTION 'chart_snapshot_invalid_comparison';END IF;
  FOR item IN SELECT value,ordinality FROM jsonb_array_elements(captures) WITH ORDINALITY LOOP
   IF item.value->>'asset' IS DISTINCT FROM NEW.state#>>ARRAY['layout','comparison','assets',(item.ordinality-1)::text,'asset'] THEN RAISE EXCEPTION 'chart_snapshot_invalid_comparison';END IF;
  END LOOP;
 ELSE
  IF NEW.state?'comparisonSeries' THEN RAISE EXCEPTION 'chart_snapshot_invalid_comparison';END IF;
  captures:=jsonb_build_array(NEW.state);
 END IF;
 FOR capture IN SELECT value FROM jsonb_array_elements(captures) LOOP
  IF jsonb_typeof(capture->'bars')='array' THEN
   IF jsonb_typeof(capture#>'{policy,retainUntil}') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'chart_snapshot_retention_required';END IF;
   expiry:=to_timestamp((capture#>>'{policy,retainUntil}')::double precision/1000);
   IF NOT isfinite(expiry) OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '366 days' THEN RAISE EXCEPTION 'chart_snapshot_invalid_retention';END IF;
   earliest:=least(earliest,expiry);
  END IF;
 END LOOP;
 NEW.series_retain_until:=earliest;NEW.series_pruned_at:=NULL;RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.intel_prune_chart_prices(p_limit integer DEFAULT 100) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed integer:=0;r record;capture jsonb;captures jsonb;next_expiry timestamptz;expiry timestamptz;at_time timestamptz:=clock_timestamp();
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_retention_batch';END IF;
 FOR r IN SELECT id,state FROM public.intel_chart_snapshots WHERE series_retain_until<=at_time AND series_pruned_at IS NULL ORDER BY series_retain_until,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  IF r.state#>'{layout,comparison}' IS NOT NULL THEN
   captures:='[]';next_expiry:=NULL;
   FOR capture IN SELECT value FROM jsonb_array_elements(r.state->'comparisonSeries') LOOP
    IF jsonb_typeof(capture->'bars')='array' THEN
     expiry:=to_timestamp((capture#>>'{policy,retainUntil}')::double precision/1000);
     IF expiry<=at_time THEN capture:=jsonb_set(capture,'{bars}','null'::jsonb);ELSE next_expiry:=least(next_expiry,expiry);END IF;
    END IF;
    captures:=captures||jsonb_build_array(capture);
   END LOOP;
   UPDATE public.intel_chart_snapshots SET state=jsonb_set(state,'{comparisonSeries}',captures),series_retain_until=next_expiry,series_pruned_at=CASE WHEN next_expiry IS NULL THEN at_time END WHERE id=r.id;
  ELSE
   UPDATE public.intel_chart_snapshots SET state=jsonb_set(state,'{bars}','null'::jsonb),series_pruned_at=at_time WHERE id=r.id;
  END IF;
  changed:=changed+1;
 END LOOP;
 RETURN changed;
END $$;
-- Existing service-only grants and authenticated direct-read denial are retained.

-- Review anchors identify one asset from the immutable comparison.
CREATE OR REPLACE FUNCTION public.intel_save_chart_comment(p_token text,p_user uuid,p_id uuid,p_revision integer,p_operation uuid,p_anchor jsonb,p_text text)
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
 IF layout?'comparison' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(layout#>'{comparison,assets}') a WHERE a->>'asset'=p_anchor->>'asset') THEN RAISE EXCEPTION 'chart_review_asset_mismatch';END IF;
  p_anchor:=jsonb_build_object('t',t,'price',price,'asset',p_anchor->>'asset');
 ELSE
  IF p_anchor?'asset' AND p_anchor->>'asset' IS DISTINCT FROM layout->>'asset' THEN RAISE EXCEPTION 'chart_review_asset_mismatch';END IF;
  p_anchor:=jsonb_build_object('t',t,'price',price);
 END IF;
 SELECT * INTO previous FROM public.intel_chart_comment_operations WHERE share_id=s.id AND user_id=p_user AND operation_id=p_operation;
 IF FOUND THEN IF previous.comment_id IS NULL THEN RAISE EXCEPTION 'chart_review_comment_deleted';END IF;RETURN previous.result;END IF;
 IF p_id IS NULL THEN
  IF p_revision<>0 THEN RAISE EXCEPTION 'chart_review_revision_conflict' USING ERRCODE='40001';END IF;
  IF (SELECT count(*) FROM public.intel_chart_comments WHERE share_id=s.id)>=1000 THEN RAISE EXCEPTION 'chart_review_limit';END IF;
  INSERT INTO public.intel_chart_comments(share_id,snapshot_id,org_id,user_id,anchor,body) VALUES(s.id,s.snapshot_id,s.org_id,p_user,p_anchor,p_text) RETURNING * INTO saved;
 ELSE
  SELECT * INTO old FROM public.intel_chart_comments WHERE id=p_id AND share_id=s.id AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'chart_review_unavailable';END IF;
  IF p_revision<>old.revision THEN RAISE EXCEPTION 'chart_review_revision_conflict' USING ERRCODE='40001';END IF;
  UPDATE public.intel_chart_comments SET anchor=p_anchor,body=p_text,revision=old.revision+1,updated_at=clock_timestamp() WHERE id=old.id RETURNING * INTO saved;
 END IF;
 result:=jsonb_build_object('id',saved.id,'revision',saved.revision);
 INSERT INTO public.intel_chart_comment_operations(share_id,user_id,operation_id,comment_id,result) VALUES(s.id,p_user,p_operation,saved.id,result);
 RETURN result;
END $$;
