// Only an explicit successful cache-only reply proves the ledger was untouched.
// Unknown/older server replies conservatively recheck private activity/research.
export function portfolioSyncChangesActivity(result) {
  return !(result?.ok === true && result.live === false && !result.backfillJobId &&
    ['open', 'holdings', 'reprice'].includes(result.mode))
}
