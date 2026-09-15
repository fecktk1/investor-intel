// Investor Intel — Data budget client (CMC plan proposal 6). Talks to the
// `intel-data-budget` edge function, which is super-admin only and answers 403
// for everyone else. Two operations exist and nothing else: a read, and an
// apply that defaults to a dry run on the server as well as here.
//
// Neither call ever throws. Every failure — transport, non-200, a body that is
// not the documented shape — becomes { state: 'unavailable', reason } so the
// panel can print why instead of drawing an empty page. A successful read is
// returned as { state: 'ready', ...payload }; `state` is not a field of the
// contract, so nothing is shadowed by it.

const FUNCTION = 'intel-data-budget'

// The function answers 400/403/500 with a JSON body carrying `error`, so a
// non-2xx response is still a readable reason rather than a bare transport
// failure. Supabase surfaces that response on error.context.
const bodyOf = async error => {
  try { return (await error?.context?.json?.()) ?? null } catch { return null }
}

const reasonOf = (payload, error, fallback) => {
  const reported = payload?.error ?? payload?.reason
  if (typeof reported === 'string' && reported) return reported
  const message = error?.message
  return typeof message === 'string' && message ? message : fallback
}

const unavailable = reason => ({ state: 'unavailable', reason })

export async function readDataBudget(supabase, { signal } = {}) {
  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION, { body: { op: 'read' }, ...(signal ? { signal } : {}) })
    if (error) return unavailable(reasonOf(await bodyOf(error), error, 'data_budget_unavailable'))
    if (!data || data.ok !== true) return unavailable(reasonOf(data, null, 'data_budget_unavailable'))
    return { state: 'ready', ...data }
  } catch (e) { return unavailable(reasonOf(null, e, 'data_budget_unavailable')) }
}

// dryRun defaults to true on both sides. `dryRun: false` is only ever sent from
// a second, explicit click in the panel — never as a side effect of a read.
export async function applyDataBudget(supabase, { dryRun = true } = {}) {
  const real = dryRun === false
  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION, { body: { op: 'apply', dryRun: !real } })
    if (error) return unavailable(reasonOf(await bodyOf(error), error, 'data_budget_apply_failed'))
    if (!data || data.ok !== true) return unavailable(reasonOf(data, null, data?.cronError || 'data_budget_apply_failed'))
    return { state: 'ready', ...data }
  } catch (e) { return unavailable(reasonOf(null, e, 'data_budget_apply_failed')) }
}
