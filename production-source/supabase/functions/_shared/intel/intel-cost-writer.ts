// Investor adapter — binds the generic core cost-ledger writer to intel_cost_ledger.
//
// precise   → plain insert (one row per cost-relevant event).
// bucketed  → atomic upsert/increment via intel_cost_ledger_bump (one row per
//             feature/org/hour/status/reason; structurally no write-amplification).
// Best-effort: errors are swallowed by core.recordCostEvent, never breaking a request.

import type { CostRow, CostPrecision, CostWriter } from '../core-intel/cost-ledger.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = any

export function makeCostWriter(admin: DB): CostWriter {
  return async (row: CostRow, precision: CostPrecision): Promise<void> => {
    if (precision === 'bucketed') {
      await admin.rpc('intel_cost_ledger_bump', {
        p_feature: row.feature,
        p_org_id: row.org_id,
        p_bucket_start: row.bucket_start,
        p_cache_status: row.cache_status,
        p_allow_reason: row.allow_reason,
        p_artifact_type: row.artifact_type,
        p_provider_calls_avoided: row.provider_calls_avoided,
        p_provider_calls_made: row.provider_calls_made,
        p_subject_ref: row.subject_ref,
      })
      return
    }
    await admin.from('intel_cost_ledger').insert(row)
  }
}
