// Runtime feature flags (v3.1) — DB-backed toggles for the provider-capacity
// features, so operators can enable/kill features via SQL or the Super Admin
// kill-switch panel WITHOUT redeploying edge secrets.
//
// Precedence: an explicit env var wins (hard on/off override); otherwise the
// intel_runtime_flags row decides; otherwise the default. Env true => force on,
// env false => force off (kill switch), env unset => DB value.

// deno-lint-ignore no-explicit-any
type DB = any

function envFlagRaw(name: string): boolean | null {
  try {
    // deno-lint-ignore no-explicit-any
    const v = (globalThis as any)?.Deno?.env?.get?.(name)
    if (v == null || v === '') return null
    return /^(1|true|yes|on)$/i.test(String(v).trim())
  } catch {
    return null
  }
}

export async function isFeatureEnabled(db: DB, flag: string, dflt = false): Promise<boolean> {
  const env = envFlagRaw(flag)
  if (env !== null) return env
  try {
    const { data } = await db.from('intel_runtime_flags').select('enabled').eq('flag', flag).maybeSingle()
    if (data && typeof data.enabled === 'boolean') return data.enabled
  } catch { /* table absent (pre-migration) → default */ }
  return dflt
}
