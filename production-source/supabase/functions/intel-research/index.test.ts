import { assert, assertEquals } from 'jsr:@std/assert@1'
import { researchSurfaceRequired } from './index.ts'
import { CMC_CAPABILITIES } from '../_shared/market-assets/cmc-capabilities.ts'

// Which research reads may be served to a membership that does not carry the
// research_on_demand surface. The rule is cost, not convenience: a read is free
// only when serving it once more spends nothing, now or later.

/** Answered entirely from our own store. Checked against the path each takes:
 * catalog returns above requestCmc, assetIdentity reads market_assets and one
 * indexed RPC, sourceHistory reads retained versions and never activates
 * demand, narrativeInputs reads the caller's own artifact and the snapshot it
 * names. None of them can reach a provider on any branch. */
const STORE_ONLY = ['catalog', 'assetIdentity', 'sourceHistory', 'narrativeInputs']

/** Reads that take their own branch in the handler and do reach the provider. */
const BRANCHED_SPENDERS = ['dexCohort', 'dexContext', 'venueContext', 'exchangeDisclosure']

const READ_MODES = [undefined, null, 'retained', 'live', '', 0]

Deno.test('the store-only reads are served without the paid surface, whatever read mode is asked for', () => {
  for (const capability of STORE_ONLY) {
    for (const readMode of READ_MODES) {
      assertEquals(
        researchSurfaceRequired(capability, readMode),
        false,
        `${capability} costs nothing extra per reader, so it is not gated`,
      )
    }
  }
})

Deno.test('every provider backed capability still needs the paid surface', () => {
  const capabilities = Object.keys(CMC_CAPABILITIES)
  assert(capabilities.length > 0, 'the capability catalogue is not empty')
  for (const capability of capabilities) {
    assertEquals(
      researchSurfaceRequired(capability),
      true,
      `${capability} calls the provider for the asking member and must stay gated`,
    )
  }
  for (const capability of BRANCHED_SPENDERS) {
    assertEquals(researchSurfaceRequired(capability), true, `${capability} must stay gated`)
  }
})

Deno.test('a retained read is NOT exempt, because it still records demand that the refresh worker spends on', () => {
  // requestCmc returns the cached row on kind 'render' with maxCalls 0, so a
  // retained read buys nothing as it is served. It reaches that return through
  // the demand branch with selectedDemand true, and when connected demand is
  // enabled that branch stamps demanded_at on the shared cache row. Foreground
  // demand is the refresh worker's only input, so the provider call is made
  // later, on another clock, against the same budget. That is still spending.
  for (const capability of [...Object.keys(CMC_CAPABILITIES), ...BRANCHED_SPENDERS]) {
    assertEquals(
      researchSurfaceRequired(capability, 'retained'),
      true,
      `a retained ${capability} read can still cause a paid refresh`,
    )
  }
})

Deno.test('an unknown or empty capability is gated rather than assumed free', () => {
  for (const capability of ['', 'not_a_capability', 'Catalog', 'CATALOG', 'sourcehistory']) {
    assertEquals(researchSurfaceRequired(capability), true, `${capability} is refused rather than guessed at`)
  }
})

Deno.test('the free list is exactly those four reads, so a fifth has to be a deliberate edit', () => {
  const free = [...Object.keys(CMC_CAPABILITIES), ...BRANCHED_SPENDERS, ...STORE_ONLY, 'anything_else']
    .filter((capability) => !researchSurfaceRequired(capability))
    .sort()
  assertEquals(free, [...STORE_ONLY].sort())
})
