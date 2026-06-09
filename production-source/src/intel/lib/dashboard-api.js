// Investor Intel — home dashboard digest client.
export async function loadDashboard(supabase, orgId, { scope = 'all', chain = null } = {}) {
  const { data, error } = await supabase.functions.invoke('intel-dashboard', { body: { orgId, scope, chain } })
  if (error) throw new Error(error.message || 'dashboard_failed')
  if (data?.error) throw new Error(data.error)
  return data
}
