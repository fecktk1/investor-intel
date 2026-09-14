CREATE UNIQUE INDEX intel_thesis_evidence_upsert ON public.intel_thesis_evidence(thesis_id,source_table,source_ref);
DROP INDEX public.ite_thesis_source;
ALTER INDEX public.intel_thesis_evidence_upsert RENAME TO ite_thesis_source;

-- Current membership and Intel access select eligible work before the bound.
-- Organization product mode does not describe subscription or holder access.
CREATE FUNCTION public.intel_thesis_monitor_candidates(p_limit integer DEFAULT 50)
RETURNS SETOF public.intel_theses LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_monitor_limit';END IF;
 RETURN QUERY SELECT t.* FROM public.intel_theses t
 WHERE t.subject_canonical_key IS NOT NULL
 AND t.status IN ('active','strengthening','weakening','needs_review','partially_confirmed')
 AND coalesce(t.evaluation_error_count,0)<5
 AND EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=t.org_id AND m.user_id=t.user_id)
 AND public.can_access_intel(t.user_id,t.org_id) IS TRUE
 ORDER BY t.last_evaluated_at ASC NULLS FIRST,t.id LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION public.intel_thesis_monitor_candidates(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_thesis_monitor_candidates(integer) TO service_role;
