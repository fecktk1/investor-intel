SET lock_timeout='5s';
SET statement_timeout='60s';
-- Keep existing sharing/deletion roles and private-owner/linked-artifact guards.
CREATE POLICY intel_saved_selected_read ON public.saved_research FOR SELECT TO authenticated USING (
 EXISTS(SELECT 1 FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id WHERE m.org_id=saved_research.org_id AND m.user_id=(SELECT auth.uid()) AND o.product_mode='intel'));
CREATE POLICY intel_saved_selected_insert ON public.saved_research FOR INSERT TO authenticated WITH CHECK (
 user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id WHERE m.org_id=saved_research.org_id AND m.user_id=(SELECT auth.uid()) AND m.role::text IN ('owner','admin','editor') AND o.product_mode='intel'));
CREATE POLICY intel_saved_selected_update ON public.saved_research FOR UPDATE TO authenticated USING (
 EXISTS(SELECT 1 FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id WHERE m.org_id=saved_research.org_id AND m.user_id=(SELECT auth.uid()) AND m.role::text IN ('owner','admin','editor') AND o.product_mode='intel')) WITH CHECK (
 EXISTS(SELECT 1 FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id WHERE m.org_id=saved_research.org_id AND m.user_id=(SELECT auth.uid()) AND m.role::text IN ('owner','admin','editor') AND o.product_mode='intel'));
CREATE POLICY intel_saved_selected_delete ON public.saved_research FOR DELETE TO authenticated USING (
 EXISTS(SELECT 1 FROM public.org_members m JOIN public.orgs o ON o.id=m.org_id WHERE m.org_id=saved_research.org_id AND m.user_id=(SELECT auth.uid()) AND m.role::text IN ('owner','admin','editor') AND o.product_mode='intel'));
