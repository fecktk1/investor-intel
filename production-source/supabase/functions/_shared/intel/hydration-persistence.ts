export async function persistHydrationRows(admin: any, table: string, rows: unknown, conflict: string, options: { ignoreDuplicates?: boolean; returning: string }): Promise<number> {
  const { data, error } = await admin.from(table).upsert(rows, { onConflict: conflict, ignoreDuplicates: !!options.ignoreDuplicates }).select(options.returning)
  if (error || !Array.isArray(data) || (!options.ignoreDuplicates && data.length === 0)) throw new Error('hydration_save_unavailable')
  return data.length
}

export async function reserveBirdeyeHydration(admin: any, credits: number, now = new Date()): Promise<boolean> {
  if (!Number.isFinite(credits) || credits <= 0) throw new Error('invalid_hydration_credits')
  const { data, error } = await admin.rpc('provider_budget_bump', {
    p_provider: 'birdeye', p_data_type: 'calls',
    p_period_start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    p_period_end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    p_calls: 1, p_credits: credits, p_soft_cap: 36000, p_hard_cap: 45000,
  })
  if (error || typeof data?.allowed !== 'boolean') throw new Error('hydration_budget_unavailable')
  return data.allowed
}
