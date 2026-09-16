// The rule that turns an entitlement answer into a lock, kept on its own and
// free of every dependency so it can be read, reasoned about and tested without
// a Supabase client, a profile or a React tree.
//
// It is a LABEL rule, not a boundary. The server refuses a locked surface
// before the withheld reading is produced; this only decides what the product
// says about a surface it is already not going to be given.

/**
 * The lock for one surface, or null when it is open (or unknown).
 *
 * Only a definite `allowed === false` from intel_account_access locks a panel.
 * A surface we were never told about, a malformed row, and an access read that
 * failed all read as OPEN on purpose: locking on a missing answer would invent
 * a refusal that no gate ever made, and would hide a surface from a member who
 * is entitled to it the moment one read fails.
 */
export function intelSurfaceLock(surfaces, surface) {
  const row = surfaces && typeof surfaces === 'object' ? surfaces[surface] : null
  if (!row || typeof row !== 'object' || row.allowed !== false) return null
  return { surface, minTier: typeof row.minTier === 'string' && row.minTier ? row.minTier : 'starter' }
}
