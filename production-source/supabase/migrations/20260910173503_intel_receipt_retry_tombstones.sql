-- An authorized delete removes all receipt content. Only the operation identity
-- survives, so a delayed request cannot recreate it. No historical deleted
-- operation IDs are guessed; only existing receipts can be backfilled.
CREATE TABLE public.intel_receipt_operations (
 org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 saved_research_id uuid REFERENCES public.saved_research(id) ON DELETE SET NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,user_id,operation_id)
);
CREATE INDEX intel_receipt_operations_saved ON public.intel_receipt_operations(saved_research_id) WHERE saved_research_id IS NOT NULL;
ALTER TABLE public.intel_receipt_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_receipt_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.intel_receipt_operations TO service_role;
INSERT INTO public.intel_receipt_operations(org_id,user_id,operation_id,saved_research_id)
 SELECT org_id,user_id,receipt_operation_id,id FROM public.saved_research
 WHERE receipt_operation_id IS NOT NULL AND investigation_receipt IS NOT NULL
 ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.intel_save_investigation_receipt(p_org_id uuid,p_user_id uuid,p_operation_id uuid,p_receipt jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE saved uuid; reserved integer;
BEGIN
 IF p_operation_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org_id AND user_id=p_user_id)
   OR public.can_access_intel(p_user_id,p_org_id) IS NOT TRUE THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 INSERT INTO public.intel_receipt_operations(org_id,user_id,operation_id) VALUES(p_org_id,p_user_id,p_operation_id) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS reserved=ROW_COUNT;
 SELECT saved_research_id INTO saved FROM public.intel_receipt_operations WHERE org_id=p_org_id AND user_id=p_user_id AND operation_id=p_operation_id FOR UPDATE;
 IF reserved=0 THEN
  IF saved IS NULL THEN RAISE EXCEPTION 'receipt_deleted'; END IF;
  RETURN saved;
 END IF;
 IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR p_receipt->>'schemaVersion' IS DISTINCT FROM '1'
   OR coalesce(length(p_receipt->>'question'),0) NOT BETWEEN 1 AND 8000 OR length(p_receipt->>'decision')>16000
   OR octet_length(p_receipt::text)>250000 THEN RAISE EXCEPTION 'invalid_receipt'; END IF;
 INSERT INTO public.saved_research(org_id,user_id,private_owner_id,title,snapshot,tags,investigation_receipt,receipt_operation_id)
 VALUES(p_org_id,p_user_id,p_user_id,left(p_receipt->>'question',160),jsonb_build_object('summary',p_receipt->>'decision','source','Investor Intel research receipt','subject',p_receipt->>'subject'),ARRAY['investigation','receipt'],p_receipt,p_operation_id)
 RETURNING id INTO saved;
 UPDATE public.intel_receipt_operations SET saved_research_id=saved WHERE org_id=p_org_id AND user_id=p_user_id AND operation_id=p_operation_id;
 RETURN saved;
END $$;
REVOKE ALL ON FUNCTION public.intel_save_investigation_receipt(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_save_investigation_receipt(uuid,uuid,uuid,jsonb) TO service_role;
