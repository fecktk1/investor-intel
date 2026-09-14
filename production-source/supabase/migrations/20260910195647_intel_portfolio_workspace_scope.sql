-- Authorize the requested workspace from current membership, independently of
-- mutable account-wide active_org_id. Portfolio records remain private to owners.
CREATE OR REPLACE FUNCTION public.intel_portfolio_org_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT m.org_id FROM public.org_members m WHERE m.user_id = (SELECT auth.uid())
$$;
REVOKE ALL ON FUNCTION public.intel_portfolio_org_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.intel_portfolio_org_ids() TO authenticated, service_role;

ALTER POLICY "ipcbo_delete" ON public."investor_portfolio_cost_basis_overrides"
 USING ("investor_portfolio_cost_basis_overrides".user_id = (SELECT auth.uid()) AND "investor_portfolio_cost_basis_overrides".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_cost_basis_overrides".portfolio_id AND p.org_id="investor_portfolio_cost_basis_overrides".org_id AND p.user_id="investor_portfolio_cost_basis_overrides".user_id));
ALTER POLICY "ipcbo_insert" ON public."investor_portfolio_cost_basis_overrides"
 WITH CHECK ("investor_portfolio_cost_basis_overrides".user_id = (SELECT auth.uid()) AND "investor_portfolio_cost_basis_overrides".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_cost_basis_overrides".portfolio_id AND p.org_id="investor_portfolio_cost_basis_overrides".org_id AND p.user_id="investor_portfolio_cost_basis_overrides".user_id));
ALTER POLICY "ipcbo_select" ON public."investor_portfolio_cost_basis_overrides"
 USING ("investor_portfolio_cost_basis_overrides".user_id = (SELECT auth.uid()) AND "investor_portfolio_cost_basis_overrides".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_cost_basis_overrides".portfolio_id AND p.org_id="investor_portfolio_cost_basis_overrides".org_id AND p.user_id="investor_portfolio_cost_basis_overrides".user_id));
ALTER POLICY "ipcbo_update" ON public."investor_portfolio_cost_basis_overrides"
 USING ("investor_portfolio_cost_basis_overrides".user_id = (SELECT auth.uid()) AND "investor_portfolio_cost_basis_overrides".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_cost_basis_overrides".portfolio_id AND p.org_id="investor_portfolio_cost_basis_overrides".org_id AND p.user_id="investor_portfolio_cost_basis_overrides".user_id))
 WITH CHECK ("investor_portfolio_cost_basis_overrides".user_id = (SELECT auth.uid()) AND "investor_portfolio_cost_basis_overrides".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_cost_basis_overrides".portfolio_id AND p.org_id="investor_portfolio_cost_basis_overrides".org_id AND p.user_id="investor_portfolio_cost_basis_overrides".user_id));
ALTER POLICY "ip_ipf_holdings_delete" ON public."investor_portfolio_holdings"
 USING ("investor_portfolio_holdings".user_id = (SELECT auth.uid()) AND "investor_portfolio_holdings".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_holdings".portfolio_id AND p.org_id="investor_portfolio_holdings".org_id AND p.user_id="investor_portfolio_holdings".user_id) AND ("investor_portfolio_holdings".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_holdings".source_id AND s.org_id="investor_portfolio_holdings".org_id AND s.user_id="investor_portfolio_holdings".user_id AND s.portfolio_id="investor_portfolio_holdings".portfolio_id)));
ALTER POLICY "ip_ipf_holdings_insert" ON public."investor_portfolio_holdings"
 WITH CHECK ("investor_portfolio_holdings".user_id = (SELECT auth.uid()) AND "investor_portfolio_holdings".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_holdings".portfolio_id AND p.org_id="investor_portfolio_holdings".org_id AND p.user_id="investor_portfolio_holdings".user_id) AND ("investor_portfolio_holdings".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_holdings".source_id AND s.org_id="investor_portfolio_holdings".org_id AND s.user_id="investor_portfolio_holdings".user_id AND s.portfolio_id="investor_portfolio_holdings".portfolio_id)));
ALTER POLICY "ip_ipf_holdings_select" ON public."investor_portfolio_holdings"
 USING ("investor_portfolio_holdings".user_id = (SELECT auth.uid()) AND "investor_portfolio_holdings".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_holdings".portfolio_id AND p.org_id="investor_portfolio_holdings".org_id AND p.user_id="investor_portfolio_holdings".user_id) AND ("investor_portfolio_holdings".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_holdings".source_id AND s.org_id="investor_portfolio_holdings".org_id AND s.user_id="investor_portfolio_holdings".user_id AND s.portfolio_id="investor_portfolio_holdings".portfolio_id)));
ALTER POLICY "ip_ipf_holdings_update" ON public."investor_portfolio_holdings"
 USING ("investor_portfolio_holdings".user_id = (SELECT auth.uid()) AND "investor_portfolio_holdings".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_holdings".portfolio_id AND p.org_id="investor_portfolio_holdings".org_id AND p.user_id="investor_portfolio_holdings".user_id) AND ("investor_portfolio_holdings".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_holdings".source_id AND s.org_id="investor_portfolio_holdings".org_id AND s.user_id="investor_portfolio_holdings".user_id AND s.portfolio_id="investor_portfolio_holdings".portfolio_id)))
 WITH CHECK ("investor_portfolio_holdings".user_id = (SELECT auth.uid()) AND "investor_portfolio_holdings".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_holdings".portfolio_id AND p.org_id="investor_portfolio_holdings".org_id AND p.user_id="investor_portfolio_holdings".user_id) AND ("investor_portfolio_holdings".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_holdings".source_id AND s.org_id="investor_portfolio_holdings".org_id AND s.user_id="investor_portfolio_holdings".user_id AND s.portfolio_id="investor_portfolio_holdings".portfolio_id)));
ALTER POLICY "ipm_delete" ON public."investor_portfolio_memory"
 USING ("investor_portfolio_memory".user_id = (SELECT auth.uid()) AND "investor_portfolio_memory".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_memory".portfolio_id AND p.org_id="investor_portfolio_memory".org_id AND p.user_id="investor_portfolio_memory".user_id));
ALTER POLICY "ipm_insert" ON public."investor_portfolio_memory"
 WITH CHECK ("investor_portfolio_memory".user_id = (SELECT auth.uid()) AND "investor_portfolio_memory".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_memory".portfolio_id AND p.org_id="investor_portfolio_memory".org_id AND p.user_id="investor_portfolio_memory".user_id));
ALTER POLICY "ipm_select" ON public."investor_portfolio_memory"
 USING ("investor_portfolio_memory".user_id = (SELECT auth.uid()) AND "investor_portfolio_memory".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_memory".portfolio_id AND p.org_id="investor_portfolio_memory".org_id AND p.user_id="investor_portfolio_memory".user_id));
ALTER POLICY "ipm_update" ON public."investor_portfolio_memory"
 USING ("investor_portfolio_memory".user_id = (SELECT auth.uid()) AND "investor_portfolio_memory".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_memory".portfolio_id AND p.org_id="investor_portfolio_memory".org_id AND p.user_id="investor_portfolio_memory".user_id))
 WITH CHECK ("investor_portfolio_memory".user_id = (SELECT auth.uid()) AND "investor_portfolio_memory".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_memory".portfolio_id AND p.org_id="investor_portfolio_memory".org_id AND p.user_id="investor_portfolio_memory".user_id));
ALTER POLICY "ip_ipf_snapshots_delete" ON public."investor_portfolio_snapshots"
 USING ("investor_portfolio_snapshots".user_id = (SELECT auth.uid()) AND "investor_portfolio_snapshots".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_snapshots".portfolio_id AND p.org_id="investor_portfolio_snapshots".org_id AND p.user_id="investor_portfolio_snapshots".user_id));
ALTER POLICY "ip_ipf_snapshots_insert" ON public."investor_portfolio_snapshots"
 WITH CHECK ("investor_portfolio_snapshots".user_id = (SELECT auth.uid()) AND "investor_portfolio_snapshots".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_snapshots".portfolio_id AND p.org_id="investor_portfolio_snapshots".org_id AND p.user_id="investor_portfolio_snapshots".user_id));
ALTER POLICY "ip_ipf_snapshots_select" ON public."investor_portfolio_snapshots"
 USING ("investor_portfolio_snapshots".user_id = (SELECT auth.uid()) AND "investor_portfolio_snapshots".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_snapshots".portfolio_id AND p.org_id="investor_portfolio_snapshots".org_id AND p.user_id="investor_portfolio_snapshots".user_id));
ALTER POLICY "ip_ipf_snapshots_update" ON public."investor_portfolio_snapshots"
 USING ("investor_portfolio_snapshots".user_id = (SELECT auth.uid()) AND "investor_portfolio_snapshots".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_snapshots".portfolio_id AND p.org_id="investor_portfolio_snapshots".org_id AND p.user_id="investor_portfolio_snapshots".user_id))
 WITH CHECK ("investor_portfolio_snapshots".user_id = (SELECT auth.uid()) AND "investor_portfolio_snapshots".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_snapshots".portfolio_id AND p.org_id="investor_portfolio_snapshots".org_id AND p.user_id="investor_portfolio_snapshots".user_id));
ALTER POLICY "ip_ipf_sources_delete" ON public."investor_portfolio_sources"
 USING ("investor_portfolio_sources".user_id = (SELECT auth.uid()) AND "investor_portfolio_sources".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_sources".portfolio_id AND p.org_id="investor_portfolio_sources".org_id AND p.user_id="investor_portfolio_sources".user_id));
ALTER POLICY "ip_ipf_sources_insert" ON public."investor_portfolio_sources"
 WITH CHECK ("investor_portfolio_sources".user_id = (SELECT auth.uid()) AND "investor_portfolio_sources".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_sources".portfolio_id AND p.org_id="investor_portfolio_sources".org_id AND p.user_id="investor_portfolio_sources".user_id));
ALTER POLICY "ip_ipf_sources_select" ON public."investor_portfolio_sources"
 USING ("investor_portfolio_sources".user_id = (SELECT auth.uid()) AND "investor_portfolio_sources".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_sources".portfolio_id AND p.org_id="investor_portfolio_sources".org_id AND p.user_id="investor_portfolio_sources".user_id));
ALTER POLICY "ip_ipf_sources_update" ON public."investor_portfolio_sources"
 USING ("investor_portfolio_sources".user_id = (SELECT auth.uid()) AND "investor_portfolio_sources".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_sources".portfolio_id AND p.org_id="investor_portfolio_sources".org_id AND p.user_id="investor_portfolio_sources".user_id))
 WITH CHECK ("investor_portfolio_sources".user_id = (SELECT auth.uid()) AND "investor_portfolio_sources".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_sources".portfolio_id AND p.org_id="investor_portfolio_sources".org_id AND p.user_id="investor_portfolio_sources".user_id));
ALTER POLICY "ipsc_select" ON public."investor_portfolio_sync_cursors"
 USING ("investor_portfolio_sync_cursors".user_id = (SELECT auth.uid()) AND "investor_portfolio_sync_cursors".org_id IN (SELECT public.intel_portfolio_org_ids()) AND ("investor_portfolio_sync_cursors".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_sync_cursors".source_id AND s.org_id="investor_portfolio_sync_cursors".org_id AND s.user_id="investor_portfolio_sync_cursors".user_id)));
ALTER POLICY "ipsj_select" ON public."investor_portfolio_sync_jobs"
 USING ("investor_portfolio_sync_jobs".user_id = (SELECT auth.uid()) AND "investor_portfolio_sync_jobs".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_sync_jobs".portfolio_id AND p.org_id="investor_portfolio_sync_jobs".org_id AND p.user_id="investor_portfolio_sync_jobs".user_id) AND ("investor_portfolio_sync_jobs".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_sync_jobs".source_id AND s.org_id="investor_portfolio_sync_jobs".org_id AND s.user_id="investor_portfolio_sync_jobs".user_id AND s.portfolio_id="investor_portfolio_sync_jobs".portfolio_id)));
ALTER POLICY "ip_ipf_sync_logs_delete" ON public."investor_portfolio_sync_logs"
 USING ("investor_portfolio_sync_logs".user_id = (SELECT auth.uid()) AND "investor_portfolio_sync_logs".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_sync_logs".portfolio_id AND p.org_id="investor_portfolio_sync_logs".org_id AND p.user_id="investor_portfolio_sync_logs".user_id) AND ("investor_portfolio_sync_logs".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_sync_logs".source_id AND s.org_id="investor_portfolio_sync_logs".org_id AND s.user_id="investor_portfolio_sync_logs".user_id AND s.portfolio_id="investor_portfolio_sync_logs".portfolio_id)));
ALTER POLICY "ip_ipf_sync_logs_insert" ON public."investor_portfolio_sync_logs"
 WITH CHECK ("investor_portfolio_sync_logs".user_id = (SELECT auth.uid()) AND "investor_portfolio_sync_logs".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_sync_logs".portfolio_id AND p.org_id="investor_portfolio_sync_logs".org_id AND p.user_id="investor_portfolio_sync_logs".user_id) AND ("investor_portfolio_sync_logs".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_sync_logs".source_id AND s.org_id="investor_portfolio_sync_logs".org_id AND s.user_id="investor_portfolio_sync_logs".user_id AND s.portfolio_id="investor_portfolio_sync_logs".portfolio_id)));
ALTER POLICY "ip_ipf_sync_logs_select" ON public."investor_portfolio_sync_logs"
 USING ("investor_portfolio_sync_logs".user_id = (SELECT auth.uid()) AND "investor_portfolio_sync_logs".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_sync_logs".portfolio_id AND p.org_id="investor_portfolio_sync_logs".org_id AND p.user_id="investor_portfolio_sync_logs".user_id) AND ("investor_portfolio_sync_logs".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_sync_logs".source_id AND s.org_id="investor_portfolio_sync_logs".org_id AND s.user_id="investor_portfolio_sync_logs".user_id AND s.portfolio_id="investor_portfolio_sync_logs".portfolio_id)));
ALTER POLICY "ip_ipf_sync_logs_update" ON public."investor_portfolio_sync_logs"
 USING ("investor_portfolio_sync_logs".user_id = (SELECT auth.uid()) AND "investor_portfolio_sync_logs".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_sync_logs".portfolio_id AND p.org_id="investor_portfolio_sync_logs".org_id AND p.user_id="investor_portfolio_sync_logs".user_id) AND ("investor_portfolio_sync_logs".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_sync_logs".source_id AND s.org_id="investor_portfolio_sync_logs".org_id AND s.user_id="investor_portfolio_sync_logs".user_id AND s.portfolio_id="investor_portfolio_sync_logs".portfolio_id)))
 WITH CHECK ("investor_portfolio_sync_logs".user_id = (SELECT auth.uid()) AND "investor_portfolio_sync_logs".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_sync_logs".portfolio_id AND p.org_id="investor_portfolio_sync_logs".org_id AND p.user_id="investor_portfolio_sync_logs".user_id) AND ("investor_portfolio_sync_logs".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_sync_logs".source_id AND s.org_id="investor_portfolio_sync_logs".org_id AND s.user_id="investor_portfolio_sync_logs".user_id AND s.portfolio_id="investor_portfolio_sync_logs".portfolio_id)));
ALTER POLICY "ip_ipf_transactions_delete" ON public."investor_portfolio_transactions"
 USING ("investor_portfolio_transactions".user_id = (SELECT auth.uid()) AND "investor_portfolio_transactions".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_transactions".portfolio_id AND p.org_id="investor_portfolio_transactions".org_id AND p.user_id="investor_portfolio_transactions".user_id) AND ("investor_portfolio_transactions".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_transactions".source_id AND s.org_id="investor_portfolio_transactions".org_id AND s.user_id="investor_portfolio_transactions".user_id AND s.portfolio_id="investor_portfolio_transactions".portfolio_id)) AND ("investor_portfolio_transactions".tx_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx g WHERE g.id="investor_portfolio_transactions".tx_id AND g.org_id="investor_portfolio_transactions".org_id AND g.user_id="investor_portfolio_transactions".user_id AND g.portfolio_id="investor_portfolio_transactions".portfolio_id)));
ALTER POLICY "ip_ipf_transactions_insert" ON public."investor_portfolio_transactions"
 WITH CHECK ("investor_portfolio_transactions".user_id = (SELECT auth.uid()) AND "investor_portfolio_transactions".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_transactions".portfolio_id AND p.org_id="investor_portfolio_transactions".org_id AND p.user_id="investor_portfolio_transactions".user_id) AND ("investor_portfolio_transactions".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_transactions".source_id AND s.org_id="investor_portfolio_transactions".org_id AND s.user_id="investor_portfolio_transactions".user_id AND s.portfolio_id="investor_portfolio_transactions".portfolio_id)) AND ("investor_portfolio_transactions".tx_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx g WHERE g.id="investor_portfolio_transactions".tx_id AND g.org_id="investor_portfolio_transactions".org_id AND g.user_id="investor_portfolio_transactions".user_id AND g.portfolio_id="investor_portfolio_transactions".portfolio_id)));
ALTER POLICY "ip_ipf_transactions_select" ON public."investor_portfolio_transactions"
 USING ("investor_portfolio_transactions".user_id = (SELECT auth.uid()) AND "investor_portfolio_transactions".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_transactions".portfolio_id AND p.org_id="investor_portfolio_transactions".org_id AND p.user_id="investor_portfolio_transactions".user_id) AND ("investor_portfolio_transactions".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_transactions".source_id AND s.org_id="investor_portfolio_transactions".org_id AND s.user_id="investor_portfolio_transactions".user_id AND s.portfolio_id="investor_portfolio_transactions".portfolio_id)) AND ("investor_portfolio_transactions".tx_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx g WHERE g.id="investor_portfolio_transactions".tx_id AND g.org_id="investor_portfolio_transactions".org_id AND g.user_id="investor_portfolio_transactions".user_id AND g.portfolio_id="investor_portfolio_transactions".portfolio_id)));
ALTER POLICY "ip_ipf_transactions_update" ON public."investor_portfolio_transactions"
 USING ("investor_portfolio_transactions".user_id = (SELECT auth.uid()) AND "investor_portfolio_transactions".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_transactions".portfolio_id AND p.org_id="investor_portfolio_transactions".org_id AND p.user_id="investor_portfolio_transactions".user_id) AND ("investor_portfolio_transactions".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_transactions".source_id AND s.org_id="investor_portfolio_transactions".org_id AND s.user_id="investor_portfolio_transactions".user_id AND s.portfolio_id="investor_portfolio_transactions".portfolio_id)) AND ("investor_portfolio_transactions".tx_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx g WHERE g.id="investor_portfolio_transactions".tx_id AND g.org_id="investor_portfolio_transactions".org_id AND g.user_id="investor_portfolio_transactions".user_id AND g.portfolio_id="investor_portfolio_transactions".portfolio_id)))
 WITH CHECK ("investor_portfolio_transactions".user_id = (SELECT auth.uid()) AND "investor_portfolio_transactions".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_transactions".portfolio_id AND p.org_id="investor_portfolio_transactions".org_id AND p.user_id="investor_portfolio_transactions".user_id) AND ("investor_portfolio_transactions".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_transactions".source_id AND s.org_id="investor_portfolio_transactions".org_id AND s.user_id="investor_portfolio_transactions".user_id AND s.portfolio_id="investor_portfolio_transactions".portfolio_id)) AND ("investor_portfolio_transactions".tx_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx g WHERE g.id="investor_portfolio_transactions".tx_id AND g.org_id="investor_portfolio_transactions".org_id AND g.user_id="investor_portfolio_transactions".user_id AND g.portfolio_id="investor_portfolio_transactions".portfolio_id)));
ALTER POLICY "iptx_delete" ON public."investor_portfolio_tx"
 USING ("investor_portfolio_tx".user_id = (SELECT auth.uid()) AND "investor_portfolio_tx".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_tx".portfolio_id AND p.org_id="investor_portfolio_tx".org_id AND p.user_id="investor_portfolio_tx".user_id) AND ("investor_portfolio_tx".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_tx".source_id AND s.org_id="investor_portfolio_tx".org_id AND s.user_id="investor_portfolio_tx".user_id AND s.portfolio_id="investor_portfolio_tx".portfolio_id)));
ALTER POLICY "iptx_insert" ON public."investor_portfolio_tx"
 WITH CHECK ("investor_portfolio_tx".user_id = (SELECT auth.uid()) AND "investor_portfolio_tx".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_tx".portfolio_id AND p.org_id="investor_portfolio_tx".org_id AND p.user_id="investor_portfolio_tx".user_id) AND ("investor_portfolio_tx".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_tx".source_id AND s.org_id="investor_portfolio_tx".org_id AND s.user_id="investor_portfolio_tx".user_id AND s.portfolio_id="investor_portfolio_tx".portfolio_id)));
ALTER POLICY "iptx_select" ON public."investor_portfolio_tx"
 USING ("investor_portfolio_tx".user_id = (SELECT auth.uid()) AND "investor_portfolio_tx".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_tx".portfolio_id AND p.org_id="investor_portfolio_tx".org_id AND p.user_id="investor_portfolio_tx".user_id) AND ("investor_portfolio_tx".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_tx".source_id AND s.org_id="investor_portfolio_tx".org_id AND s.user_id="investor_portfolio_tx".user_id AND s.portfolio_id="investor_portfolio_tx".portfolio_id)));
ALTER POLICY "iptx_update" ON public."investor_portfolio_tx"
 USING ("investor_portfolio_tx".user_id = (SELECT auth.uid()) AND "investor_portfolio_tx".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_tx".portfolio_id AND p.org_id="investor_portfolio_tx".org_id AND p.user_id="investor_portfolio_tx".user_id) AND ("investor_portfolio_tx".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_tx".source_id AND s.org_id="investor_portfolio_tx".org_id AND s.user_id="investor_portfolio_tx".user_id AND s.portfolio_id="investor_portfolio_tx".portfolio_id)))
 WITH CHECK ("investor_portfolio_tx".user_id = (SELECT auth.uid()) AND "investor_portfolio_tx".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_tx".portfolio_id AND p.org_id="investor_portfolio_tx".org_id AND p.user_id="investor_portfolio_tx".user_id) AND ("investor_portfolio_tx".source_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_sources s WHERE s.id="investor_portfolio_tx".source_id AND s.org_id="investor_portfolio_tx".org_id AND s.user_id="investor_portfolio_tx".user_id AND s.portfolio_id="investor_portfolio_tx".portfolio_id)));
ALTER POLICY "iptli_delete" ON public."investor_portfolio_tx_line_items"
 USING ("investor_portfolio_tx_line_items".user_id = (SELECT auth.uid()) AND "investor_portfolio_tx_line_items".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_tx_line_items".portfolio_id AND p.org_id="investor_portfolio_tx_line_items".org_id AND p.user_id="investor_portfolio_tx_line_items".user_id) AND ("investor_portfolio_tx_line_items".tx_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx g WHERE g.id="investor_portfolio_tx_line_items".tx_id AND g.org_id="investor_portfolio_tx_line_items".org_id AND g.user_id="investor_portfolio_tx_line_items".user_id AND g.portfolio_id="investor_portfolio_tx_line_items".portfolio_id)));
ALTER POLICY "iptli_insert" ON public."investor_portfolio_tx_line_items"
 WITH CHECK ("investor_portfolio_tx_line_items".user_id = (SELECT auth.uid()) AND "investor_portfolio_tx_line_items".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_tx_line_items".portfolio_id AND p.org_id="investor_portfolio_tx_line_items".org_id AND p.user_id="investor_portfolio_tx_line_items".user_id) AND ("investor_portfolio_tx_line_items".tx_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx g WHERE g.id="investor_portfolio_tx_line_items".tx_id AND g.org_id="investor_portfolio_tx_line_items".org_id AND g.user_id="investor_portfolio_tx_line_items".user_id AND g.portfolio_id="investor_portfolio_tx_line_items".portfolio_id)));
ALTER POLICY "iptli_select" ON public."investor_portfolio_tx_line_items"
 USING ("investor_portfolio_tx_line_items".user_id = (SELECT auth.uid()) AND "investor_portfolio_tx_line_items".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_tx_line_items".portfolio_id AND p.org_id="investor_portfolio_tx_line_items".org_id AND p.user_id="investor_portfolio_tx_line_items".user_id) AND ("investor_portfolio_tx_line_items".tx_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx g WHERE g.id="investor_portfolio_tx_line_items".tx_id AND g.org_id="investor_portfolio_tx_line_items".org_id AND g.user_id="investor_portfolio_tx_line_items".user_id AND g.portfolio_id="investor_portfolio_tx_line_items".portfolio_id)));
ALTER POLICY "iptli_update" ON public."investor_portfolio_tx_line_items"
 USING ("investor_portfolio_tx_line_items".user_id = (SELECT auth.uid()) AND "investor_portfolio_tx_line_items".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_tx_line_items".portfolio_id AND p.org_id="investor_portfolio_tx_line_items".org_id AND p.user_id="investor_portfolio_tx_line_items".user_id) AND ("investor_portfolio_tx_line_items".tx_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx g WHERE g.id="investor_portfolio_tx_line_items".tx_id AND g.org_id="investor_portfolio_tx_line_items".org_id AND g.user_id="investor_portfolio_tx_line_items".user_id AND g.portfolio_id="investor_portfolio_tx_line_items".portfolio_id)))
 WITH CHECK ("investor_portfolio_tx_line_items".user_id = (SELECT auth.uid()) AND "investor_portfolio_tx_line_items".org_id IN (SELECT public.intel_portfolio_org_ids()) AND EXISTS (SELECT 1 FROM public.investor_portfolios p WHERE p.id="investor_portfolio_tx_line_items".portfolio_id AND p.org_id="investor_portfolio_tx_line_items".org_id AND p.user_id="investor_portfolio_tx_line_items".user_id) AND ("investor_portfolio_tx_line_items".tx_id IS NULL OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx g WHERE g.id="investor_portfolio_tx_line_items".tx_id AND g.org_id="investor_portfolio_tx_line_items".org_id AND g.user_id="investor_portfolio_tx_line_items".user_id AND g.portfolio_id="investor_portfolio_tx_line_items".portfolio_id)));
ALTER POLICY "ip_ipfs_delete" ON public."investor_portfolios"
 USING ("investor_portfolios".user_id = (SELECT auth.uid()) AND "investor_portfolios".org_id IN (SELECT public.intel_portfolio_org_ids()));
ALTER POLICY "ip_ipfs_insert" ON public."investor_portfolios"
 WITH CHECK ("investor_portfolios".user_id = (SELECT auth.uid()) AND "investor_portfolios".org_id IN (SELECT public.intel_portfolio_org_ids()));
ALTER POLICY "ip_ipfs_select" ON public."investor_portfolios"
 USING ("investor_portfolios".user_id = (SELECT auth.uid()) AND "investor_portfolios".org_id IN (SELECT public.intel_portfolio_org_ids()));
ALTER POLICY "ip_ipfs_update" ON public."investor_portfolios"
 USING ("investor_portfolios".user_id = (SELECT auth.uid()) AND "investor_portfolios".org_id IN (SELECT public.intel_portfolio_org_ids()))
 WITH CHECK ("investor_portfolios".user_id = (SELECT auth.uid()) AND "investor_portfolios".org_id IN (SELECT public.intel_portfolio_org_ids()));

-- Changing a selected workspace cannot move an existing record into it.
CREATE OR REPLACE FUNCTION public.intel_portfolio_scope_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
 IF current_user = 'authenticated' AND (
  NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
  OR to_jsonb(NEW)->'portfolio_id' IS DISTINCT FROM to_jsonb(OLD)->'portfolio_id'
 ) THEN RAISE EXCEPTION 'Portfolio ownership cannot be changed' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.intel_portfolio_scope_immutable() FROM PUBLIC, anon;
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolio_cost_basis_overrides" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolio_holdings" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolio_memory" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolio_snapshots" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolio_sources" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolio_sync_cursors" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolio_sync_jobs" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolio_sync_logs" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolio_transactions" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolio_tx" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolio_tx_line_items" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();
CREATE TRIGGER intel_portfolio_scope_immutable BEFORE UPDATE ON public."investor_portfolios" FOR EACH ROW EXECUTE FUNCTION public.intel_portfolio_scope_immutable();

CREATE OR REPLACE FUNCTION public.intel_asset_portfolio_context(p_org_id uuid, p_portfolio_id uuid, p_asset_key text, p_from timestamp with time zone, p_to timestamp with time zone, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 500));
  v_holding jsonb;
  v_events jsonb;
  v_cursor jsonb;
  v_undated boolean;
BEGIN
  IF auth.uid() IS NULL OR p_org_id IS NULL OR p_org_id NOT IN (SELECT public.intel_portfolio_org_ids())
    OR NOT EXISTS (SELECT 1 FROM public.investor_portfolios p
      WHERE p.id = p_portfolio_id AND p.org_id = p_org_id AND p.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Portfolio unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_asset_key IS NULL OR length(p_asset_key) NOT BETWEEN 3 AND 256
    OR p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'Invalid asset or chart range' USING ERRCODE = '22023';
  END IF;
  IF p_cursor IS NOT NULL AND (p_cursor->>'timestamp' IS NULL OR p_cursor->>'key' IS NULL) THEN
    RAISE EXCEPTION 'Invalid chart cursor' USING ERRCODE = '22023';
  END IF;

  SELECT to_jsonb(h) INTO v_holding FROM public.investor_portfolio_holdings h
    WHERE h.portfolio_id = p_portfolio_id AND h.canonical_asset_key = p_asset_key
      AND h.org_id = p_org_id AND h.user_id = auth.uid();

  WITH owned_sources AS MATERIALIZED (
    SELECT id, source_type, provider, label FROM public.investor_portfolio_sources
    WHERE portfolio_id = p_portfolio_id AND org_id = p_org_id AND user_id = auth.uid()
  ), grouped AS (
    SELECT 'grouped:' || g.id::text AS event_key, g.block_time AS happened_at,
      jsonb_build_object('id', g.id, 'kind', 'grouped', 'chain', g.chain,
        'txRef', coalesce(g.tx_hash, g.signature), 'timestamp', g.block_time,
        'type', g.type, 'title', g.title, 'summary', g.summary, 'notes', g.notes,
        'status', g.status, 'classification_status', g.classification_status,
        'confidence', g.confidence, 'protocol', g.protocol, 'counterparty', g.counterparty,
        'sourceId', s.id, 'sourceLabel', s.label, 'provider', s.provider,
        'feeAsset', g.fee_asset, 'feeAmount', g.fee_amount, 'feeUsd', g.fee_usd,
        'feeMatchesAsset', g.fee_asset IS NOT NULL AND g.fee_amount > 0 AND public.canonical_asset_key(g.chain, g.fee_asset, NULL) = p_asset_key,
        'lineItems', coalesce(legs.items, '[]'::jsonb), 'lineItemCount', coalesce(legs.total_count, 0),
        'lineItemsTruncated', coalesce(legs.total_count, 0) > 64) AS event
    FROM public.investor_portfolio_tx g JOIN owned_sources s ON s.id = g.source_id AND s.source_type <> 'manual'
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id', l.id, 'canonical_asset_key', l.canonical_asset_key,
        'chain', l.chain, 'symbol', l.symbol, 'name', l.name, 'direction', l.direction,
        'amount', l.amount, 'price_usd_at_tx', l.price_usd_at_tx,
        'value_usd_at_tx', l.value_usd_at_tx, 'price_source_at_tx', l.price_source_at_tx)
        ORDER BY l.leg_index, l.id) AS items, max(l.total_count) AS total_count
      FROM (SELECT li.*, count(*) OVER () AS total_count
        FROM public.investor_portfolio_tx_line_items li WHERE li.tx_id = g.id
          AND li.portfolio_id = p_portfolio_id AND li.org_id = p_org_id AND li.user_id = auth.uid()
        ORDER BY (li.canonical_asset_key = p_asset_key) DESC, li.leg_index, li.id LIMIT 64) l
    ) legs ON true
    WHERE g.portfolio_id = p_portfolio_id AND g.org_id = p_org_id AND g.user_id = auth.uid()
      AND g.is_display_mirror = false AND g.block_time BETWEEN p_from AND p_to
      AND (EXISTS (SELECT 1 FROM public.investor_portfolio_tx_line_items match_leg WHERE match_leg.tx_id = g.id
        AND match_leg.portfolio_id = p_portfolio_id AND match_leg.org_id = p_org_id AND match_leg.user_id = auth.uid() AND match_leg.canonical_asset_key = p_asset_key)
        OR (g.fee_asset IS NOT NULL AND g.fee_amount > 0 AND public.canonical_asset_key(g.chain, g.fee_asset, NULL) = p_asset_key))
      AND (p_cursor IS NULL OR (g.block_time, 'grouped:' || g.id::text) < ((p_cursor->>'timestamp')::timestamptz, p_cursor->>'key'))
    ORDER BY g.block_time DESC, g.id DESC LIMIT v_limit + 1
  ), manual AS (
    SELECT 'manual:' || m.id::text AS event_key, m."timestamp" AS happened_at,
      jsonb_build_object('id', m.id, 'kind', 'manual', 'chain', m.chain,
        'txRef', coalesce(m.external_tx_hash, m.external_tx_signature), 'timestamp', m."timestamp",
        'type', m.transaction_type, 'notes', m.notes, 'status', 'success',
        'classification_status', m.classification_status, 'confidence', m.confidence_score,
        'sourceId', s.id, 'sourceLabel', s.label, 'provider', s.provider,
        'feeAsset', m.fee_currency, 'feeAmount', m.fee_amount,
        'feeUsd', CASE WHEN upper(m.fee_currency) = 'USD' THEN m.fee_amount END,
        'feeMatchesAsset', false,
        'lineItems', jsonb_build_array(jsonb_build_object('id', m.id, 'canonical_asset_key', m.canonical_asset_key,
          'chain', m.chain, 'symbol', m.asset_symbol, 'direction', m.direction, 'amount', m.quantity,
          'price_usd_at_tx', CASE WHEN upper(m.quote_currency) = 'USD' THEN m.price_per_unit END,
          'value_usd_at_tx', CASE WHEN upper(m.quote_currency) = 'USD' THEN m.total_value END,
          'price_source_at_tx', 'manual', 'quote_currency', m.quote_currency,
          'recorded_price', m.price_per_unit, 'recorded_value', m.total_value))) AS event
    FROM public.investor_portfolio_transactions m JOIN owned_sources s ON s.id = m.source_id AND s.source_type = 'manual'
    WHERE m.portfolio_id = p_portfolio_id AND m.org_id = p_org_id AND m.user_id = auth.uid()
      AND m.canonical_asset_key = p_asset_key AND m."timestamp" BETWEEN p_from AND p_to
      AND (p_cursor IS NULL OR (m."timestamp", 'manual:' || m.id::text) < ((p_cursor->>'timestamp')::timestamptz, p_cursor->>'key'))
    ORDER BY m."timestamp" DESC, m.id DESC LIMIT v_limit + 1
  ), combined AS (
    SELECT * FROM grouped UNION ALL SELECT * FROM manual
  ), page AS MATERIALIZED (
    SELECT * FROM combined ORDER BY happened_at DESC, event_key DESC LIMIT v_limit + 1
  ), visible AS MATERIALIZED (
    SELECT * FROM page ORDER BY happened_at DESC, event_key DESC LIMIT v_limit
  ) SELECT
      coalesce((SELECT jsonb_agg(event || jsonb_build_object('eventKey', event_key) ORDER BY happened_at DESC, event_key DESC) FROM visible), '[]'::jsonb),
      CASE WHEN (SELECT count(*) FROM page) > v_limit THEN
        (SELECT jsonb_build_object('timestamp', happened_at, 'key', event_key) FROM visible ORDER BY happened_at ASC, event_key ASC LIMIT 1) END
    INTO v_events, v_cursor;

  SELECT EXISTS (
    SELECT 1 FROM public.investor_portfolio_transactions m JOIN public.investor_portfolio_sources s ON s.id = m.source_id
      WHERE m.portfolio_id = p_portfolio_id AND m.org_id = p_org_id AND m.user_id = auth.uid()
        AND s.source_type = 'manual' AND s.user_id = auth.uid() AND s.org_id = p_org_id
        AND m.canonical_asset_key = p_asset_key AND m."timestamp" IS NULL
    UNION ALL
    SELECT 1 FROM public.investor_portfolio_tx g JOIN public.investor_portfolio_sources s ON s.id = g.source_id
      WHERE g.portfolio_id = p_portfolio_id AND g.org_id = p_org_id AND g.user_id = auth.uid()
        AND s.source_type <> 'manual' AND s.user_id = auth.uid() AND s.org_id = p_org_id
        AND NOT g.is_display_mirror AND g.block_time IS NULL
        AND ((g.fee_asset IS NOT NULL AND g.fee_amount > 0 AND public.canonical_asset_key(g.chain, g.fee_asset, NULL) = p_asset_key)
          OR EXISTS (SELECT 1 FROM public.investor_portfolio_tx_line_items l WHERE l.tx_id = g.id
            AND l.portfolio_id = p_portfolio_id AND l.org_id = p_org_id AND l.user_id = auth.uid() AND l.canonical_asset_key = p_asset_key))
  ) INTO v_undated;
  RETURN jsonb_build_object('holding', v_holding, 'events', v_events, 'nextCursor', v_cursor,
    'coverage', jsonb_build_object('from', p_from, 'to', p_to, 'hasUndatedActivity', v_undated,
      'hasMore', v_cursor IS NOT NULL, 'historyStatus', coalesce(v_holding->>'reconciliation_status', 'unknown')));
END;
$function$
;

