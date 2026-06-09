// Investor Intel — market regime client (shared global read).
export async function loadRegime(supabase) {
  const { data, error } = await supabase.rpc('intel_current_regime')
  if (error) throw error
  return (data && data[0]) || null
}
