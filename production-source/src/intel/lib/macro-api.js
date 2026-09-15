// Investor Intel — macro section client API.
// Reads the GLOBAL macro store (shared by every workspace; populated by the
// intel-macro-cron) + high-signal macro news aggregated from data orgs already
// retain (intel_macro_news RPC, SECURITY DEFINER).

export async function loadMacroNews(supabase, { limit = 40 } = {}) {
  const { data, error } = await supabase.rpc('intel_macro_news', { p_limit: limit })
  if (error) throw error
  return data || []
}

export async function loadMacroIndicators(supabase) {
  const { data, error } = await supabase.from('intel_macro_indicators').select('*').order('metric_key', { ascending: true })
  if (error) throw error
  return data || []
}

export async function loadMacroCalendar(supabase, { days = 21 } = {}) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const until = new Date(Date.now() + days * 24 * 3600_000).toISOString()
  const { data, error } = await supabase
    .from('intel_macro_calendar')
    .select('*')
    .gte('scheduled_at', since)
    .lte('scheduled_at', until)
    .order('scheduled_at', { ascending: true })
    .limit(60)
  if (error) throw error
  if (!Array.isArray(data)) throw new Error('calendar_read_invalid')
  return data
}
