-- Preserve existing manual/synced records. New paired manual operations have
-- two directionally coherent legs; one flat update cannot detach or corrupt them.
SET lock_timeout='5s';
SET statement_timeout='60s';

CREATE OR REPLACE FUNCTION app_private.intel_manual_pair_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
BEGIN
 IF OLD.raw_metadata ? 'manual_group_id' AND (
  NEW.raw_metadata->>'manual_group_id' IS DISTINCT FROM OLD.raw_metadata->>'manual_group_id'
  OR NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.org_id<>OLD.org_id OR NEW.portfolio_id<>OLD.portfolio_id
  OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.direction IS DISTINCT FROM OLD.direction) THEN
  RAISE EXCEPTION 'A paired record must keep its owner, source, group and direction. Correct the pair together.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.intel_manual_pair_membership() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_manual_pair_membership BEFORE UPDATE ON public.investor_portfolio_transactions
 FOR EACH ROW EXECUTE FUNCTION app_private.intel_manual_pair_membership();

CREATE OR REPLACE FUNCTION app_private.intel_validate_manual_pair()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
DECLARE v_operation app_private.intel_manual_swap_operations; v_group text:=NEW.raw_metadata->>'manual_group_id';
 v_count integer;v_valid integer;v_assets integer;v_directions integer;v_sources integer;v_times integer;v_notes integer;
 v_class text;v_classes integer;v_types_valid boolean;
BEGIN
 IF v_group IS NULL THEN RETURN NULL;END IF;
 IF v_group!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RAISE EXCEPTION 'Invalid paired operation' USING ERRCODE='23514';
 END IF;
 SELECT * INTO v_operation FROM app_private.intel_manual_swap_operations WHERE id=v_group::uuid FOR UPDATE;
 IF NOT FOUND OR v_operation.user_id<>NEW.user_id OR v_operation.org_id<>NEW.org_id OR v_operation.portfolio_id<>NEW.portfolio_id THEN
  RAISE EXCEPTION 'Paired operation unavailable' USING ERRCODE='23514';
 END IF;
 SELECT count(*),count(*) FILTER(WHERE t.user_id=v_operation.user_id AND t.org_id=v_operation.org_id AND t.portfolio_id=v_operation.portfolio_id
  AND t.quantity IS NOT NULL AND t.quantity>0 AND t.quantity<=1e30 AND t.quantity::text NOT IN ('NaN','Infinity','-Infinity')
  AND t.price_per_unit IS NOT NULL AND t.price_per_unit>=0 AND t.price_per_unit<=1e20 AND t.price_per_unit::text NOT IN ('NaN','Infinity','-Infinity')
  AND t.total_value IS NOT NULL AND t.total_value::text NOT IN ('NaN','Infinity','-Infinity')
  AND abs(t.total_value-t.quantity*t.price_per_unit)<=greatest(1e-9,abs(t.quantity*t.price_per_unit)*1e-9)
  AND t.quote_currency='USD' AND t.fee_currency='USD' AND t.direction IN ('in','out')
  AND (t.fee_amount IS NULL OR (t.fee_amount>=0 AND t.fee_amount<=1e20 AND t.fee_amount::text NOT IN ('NaN','Infinity','-Infinity')))
  AND (t.direction='out' OR coalesce(t.fee_amount,0)=0) AND t.canonical_asset_key IS NOT NULL
  AND t."timestamp" IS NOT NULL AND isfinite(t."timestamp")
  AND EXISTS(SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id=t.source_id AND s.source_type='manual' AND s.org_id=t.org_id AND s.user_id=t.user_id AND s.portfolio_id=t.portfolio_id)),
  count(DISTINCT t.canonical_asset_key),count(DISTINCT t.direction),count(DISTINCT t.source_id),count(DISTINCT t."timestamp"),
  count(DISTINCT jsonb_build_array(t.notes)),count(DISTINCT coalesce(t.raw_metadata->>'manual_pair_classification','swap')),
  min(coalesce(t.raw_metadata->>'manual_pair_classification','swap'))
 INTO v_count,v_valid,v_assets,v_directions,v_sources,v_times,v_notes,v_classes,v_class
 FROM public.investor_portfolio_transactions t WHERE t.org_id=v_operation.org_id AND t.user_id=v_operation.user_id AND t.portfolio_id=v_operation.portfolio_id AND t.raw_metadata->>'manual_group_id'=v_group;
 IF v_operation.deleted_at IS NOT NULL AND v_count=0 THEN RETURN NULL;END IF;
 IF v_operation.deleted_at IS NOT NULL OR v_count<>2 OR v_valid<>2 OR v_assets<>2 OR v_directions<>2 OR v_sources<>1 OR v_times<>1 OR v_notes<>1 OR v_classes<>1 THEN
  RAISE EXCEPTION 'Paired activity requires two valid distinct assets, opposite directions, one time, one note and one fee allocation.' USING ERRCODE='23514';
 END IF;
 SELECT bool_and(CASE WHEN v_class IN ('swap','buy','sell') THEN transaction_type='swap'
   WHEN v_class IN ('transfer_in','transfer_out','bridge','wrap','unwrap','lp_add','lp_remove','stake','unstake') THEN transaction_type=CASE WHEN direction='in' THEN 'transfer_in' ELSE 'transfer_out' END
   WHEN v_class='unknown' THEN transaction_type='unknown' ELSE false END)
 INTO v_types_valid FROM public.investor_portfolio_transactions WHERE org_id=v_operation.org_id AND user_id=v_operation.user_id AND portfolio_id=v_operation.portfolio_id AND raw_metadata->>'manual_group_id'=v_group;
 IF NOT coalesce(v_types_valid,false) THEN RAISE EXCEPTION 'Reclassify both paired legs together; one type cannot override their directions.' USING ERRCODE='23514';END IF;
 RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.intel_validate_manual_pair() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER intel_manual_pair_consistency AFTER INSERT OR UPDATE ON public.investor_portfolio_transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.intel_validate_manual_pair();

CREATE OR REPLACE FUNCTION public.intel_reclassify_manual_pair(p_org_id uuid,p_portfolio_id uuid,p_group_id uuid,p_type text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $function$
DECLARE v_user uuid:=auth.uid();v_count integer;v_time timestamptz:=clock_timestamp();
BEGIN
 IF v_user IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org_id AND user_id=v_user) THEN
  RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.investor_portfolios WHERE id=p_portfolio_id AND org_id=p_org_id AND user_id=v_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE='42501';END IF;
 IF p_type IS NULL OR p_type NOT IN ('swap','buy','sell','transfer_in','transfer_out','bridge','wrap','unwrap','lp_add','lp_remove','stake','unstake','unknown') THEN
  RAISE EXCEPTION 'Choose a classification that supports both recorded legs.' USING ERRCODE='22023';END IF;
 PERFORM 1 FROM public.investor_portfolio_transactions WHERE org_id=p_org_id AND user_id=v_user AND portfolio_id=p_portfolio_id AND raw_metadata->>'manual_group_id'=p_group_id::text ORDER BY id FOR UPDATE;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count<>2 THEN RAISE EXCEPTION 'Paired activity unavailable' USING ERRCODE='42501';END IF;
 UPDATE public.investor_portfolio_transactions SET
  transaction_type=CASE WHEN p_type IN ('swap','buy','sell') THEN 'swap' WHEN p_type='unknown' THEN 'unknown' WHEN direction='in' THEN 'transfer_in' ELSE 'transfer_out' END,
  classification_status='user_corrected',updated_at=v_time,
  raw_metadata=raw_metadata||jsonb_build_object('manual_pair_classification',p_type)
 WHERE org_id=p_org_id AND user_id=v_user AND portfolio_id=p_portfolio_id AND raw_metadata->>'manual_group_id'=p_group_id::text;
 RETURN jsonb_build_object('id',p_group_id,'classification',p_type,'updatedAt',v_time,'legs',2);
END;
$function$;
REVOKE ALL ON FUNCTION public.intel_reclassify_manual_pair(uuid,uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_reclassify_manual_pair(uuid,uuid,uuid,text) TO authenticated;
