CREATE FUNCTION public.intel_pin_watchlist_item(p_org_id uuid,p_list_id uuid,p_item_id uuid,p_revision integer,p_pinned boolean)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE parent public.watchlists; result integer;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org_id AND user_id=auth.uid())
 OR public.get_my_org_id() IS DISTINCT FROM p_org_id OR public.get_my_role()::text NOT IN ('owner','admin','editor')
 THEN RAISE EXCEPTION 'Watchlist editing is not permitted' USING ERRCODE='42501'; END IF;
 SELECT * INTO parent FROM public.watchlists WHERE id=p_list_id AND org_id=p_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Watchlist is unavailable' USING ERRCODE='42501'; END IF;
 IF p_revision IS DISTINCT FROM parent.revision THEN RAISE EXCEPTION 'watchlist_revision_conflict' USING ERRCODE='40001'; END IF;
 IF p_pinned IS NULL THEN RAISE EXCEPTION 'Pin state is required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.watchlist_items WHERE id=p_item_id AND watchlist_id=p_list_id AND org_id=p_org_id)
 THEN RAISE EXCEPTION 'Watchlist item is unavailable' USING ERRCODE='42501'; END IF;
 UPDATE public.watchlist_items SET is_pinned=p_pinned WHERE id=p_item_id AND watchlist_id=p_list_id AND org_id=p_org_id AND is_pinned IS DISTINCT FROM p_pinned;
 SELECT revision INTO result FROM public.watchlists WHERE id=p_list_id; RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_pin_watchlist_item(uuid,uuid,uuid,integer,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_pin_watchlist_item(uuid,uuid,uuid,integer,boolean) TO authenticated;
CREATE INDEX watchlist_items_pinned_order ON public.watchlist_items(watchlist_id,is_pinned DESC,sort_order,created_at DESC,id);
