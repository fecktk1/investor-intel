ALTER TABLE public.watchlists ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.watchlists ADD COLUMN updated_at timestamptz NOT NULL DEFAULT statement_timestamp();
ALTER TABLE public.watchlist_items ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;
CREATE INDEX watchlist_items_ordered ON public.watchlist_items(watchlist_id,sort_order,created_at,id);
CREATE POLICY watchlists_membership_boundary ON public.watchlists AS RESTRICTIVE FOR ALL TO authenticated
 USING(EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=watchlists.org_id AND m.user_id=(SELECT auth.uid())))
 WITH CHECK(EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=watchlists.org_id AND m.user_id=(SELECT auth.uid())));
CREATE POLICY watchlist_items_membership_boundary ON public.watchlist_items AS RESTRICTIVE FOR ALL TO authenticated
 USING(EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=watchlist_items.org_id AND m.user_id=(SELECT auth.uid())))
 WITH CHECK(EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=watchlist_items.org_id AND m.user_id=(SELECT auth.uid())));

CREATE FUNCTION app_private.intel_watchlist_version() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'Watchlist ownership cannot be reassigned' USING ERRCODE='42501'; END IF;
 NEW.revision:=OLD.revision+1; NEW.updated_at:=statement_timestamp(); RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_watchlist_version() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_watchlist_version BEFORE UPDATE ON public.watchlists FOR EACH ROW EXECUTE FUNCTION app_private.intel_watchlist_version();

CREATE FUNCTION app_private.intel_watchlist_item_scope() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE parent public.watchlists;
BEGIN
 SELECT * INTO parent FROM public.watchlists WHERE id=NEW.watchlist_id AND org_id=NEW.org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Watchlist is unavailable in this workspace' USING ERRCODE='42501'; END IF;
 IF NEW.entity_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.entities WHERE id=NEW.entity_id AND org_id=NEW.org_id) THEN RAISE EXCEPTION 'Asset is unavailable in this workspace' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND ROW(OLD.org_id,OLD.watchlist_id,OLD.entity_id) IS DISTINCT FROM ROW(NEW.org_id,NEW.watchlist_id,NEW.entity_id) THEN RAISE EXCEPTION 'Remove and add an item to move it between lists' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN SELECT coalesce(max(sort_order),-1)+1 INTO NEW.sort_order FROM public.watchlist_items WHERE watchlist_id=NEW.watchlist_id; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_watchlist_item_scope() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_watchlist_item_scope BEFORE INSERT OR UPDATE ON public.watchlist_items FOR EACH ROW EXECUTE FUNCTION app_private.intel_watchlist_item_scope();

CREATE FUNCTION app_private.intel_watchlist_items_version() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 UPDATE public.watchlists SET updated_at=statement_timestamp() WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.watchlist_id ELSE NEW.watchlist_id END;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_watchlist_items_version() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_watchlist_items_version AFTER INSERT OR UPDATE OR DELETE ON public.watchlist_items FOR EACH ROW EXECUTE FUNCTION app_private.intel_watchlist_items_version();

CREATE FUNCTION public.intel_reorder_watchlist(p_org_id uuid,p_list_id uuid,p_revision integer,p_item_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE parent public.watchlists; result integer;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org_id AND user_id=auth.uid()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF public.get_my_org_id() IS DISTINCT FROM p_org_id OR public.get_my_role()::text NOT IN ('owner','admin','editor') THEN RAISE EXCEPTION 'Watchlist editing is not permitted' USING ERRCODE='42501'; END IF;
 SELECT * INTO parent FROM public.watchlists WHERE id=p_list_id AND org_id=p_org_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF p_revision IS DISTINCT FROM parent.revision THEN RAISE EXCEPTION 'watchlist_revision_conflict' USING ERRCODE='40001'; END IF;
 IF p_item_ids IS NULL OR cardinality(p_item_ids)>1000 OR cardinality(p_item_ids)<>(SELECT count(DISTINCT id) FROM unnest(p_item_ids) id)
  OR cardinality(p_item_ids)<>(SELECT count(*) FROM public.watchlist_items WHERE watchlist_id=p_list_id AND org_id=p_org_id)
  OR EXISTS(SELECT 1 FROM unnest(p_item_ids) requested(id) WHERE NOT EXISTS(SELECT 1 FROM public.watchlist_items i WHERE i.id=requested.id AND i.watchlist_id=p_list_id AND i.org_id=p_org_id))
 THEN RAISE EXCEPTION 'watchlist_members_changed'; END IF;
 UPDATE public.watchlist_items i SET sort_order=position.ordinality-1 FROM unnest(p_item_ids) WITH ORDINALITY position(id,ordinality)
 WHERE i.id=position.id AND i.watchlist_id=p_list_id AND i.sort_order IS DISTINCT FROM position.ordinality-1;
 SELECT revision INTO result FROM public.watchlists WHERE id=p_list_id; RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.intel_reorder_watchlist(uuid,uuid,integer,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.intel_reorder_watchlist(uuid,uuid,integer,uuid[]) TO authenticated;
