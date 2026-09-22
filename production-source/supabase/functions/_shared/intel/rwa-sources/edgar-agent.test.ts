import { strict as assert } from 'node:assert'
import { EDGAR_AGENT_ENV, compliantEdgarAgent, edgarAgentProblem, resolveEdgarUserAgent } from './edgar-agent.ts'

const GOOD = 'TheContentForge Investor Intel support@thecontentforge.io'

/** A PostgREST-shaped fake for the one operating profile read. */
function profileDb(config: Record<string, unknown> | null, opts: { error?: string; throws?: boolean } = {}) {
  const seen: [string, unknown][] = []
  const db = {
    seen,
    from(table: string) {
      seen.push(['table', table])
      if (opts.throws) throw new Error('boom')
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { seen.push([k, v]); return q },
        maybeSingle: () => Promise.resolve(opts.error ? { data: null, error: { message: opts.error } } : { data: config == null ? null : { config }, error: null }),
      }
      return q
    },
  }
  return db
}

Deno.test('a compliant agent names a client and carries a contact address', () => {
  assert.equal(edgarAgentProblem(GOOD), null)
  assert.equal(compliantEdgarAgent(`  ${GOOD}  `), GOOD)
  assert.equal(edgarAgentProblem('TheContentForge Investor Intel'), 'no_contact_address')
  assert.equal(edgarAgentProblem('support@thecontentforge.io'), 'no_client_name')
  assert.equal(edgarAgentProblem('TheContentForge x@y.io\r\nX-Injected: 1'), 'control_character')
  assert.equal(edgarAgentProblem(''), 'empty')
  assert.equal(edgarAgentProblem(null), 'not_text')
  assert.equal(edgarAgentProblem(`${'a'.repeat(200)} x@y.io`), 'length')
})

Deno.test('the environment wins over the operating profile row', async () => {
  const db = profileDb({ [EDGAR_AGENT_ENV]: 'Row Client row@example.test' })
  const resolved = await resolveEdgarUserAgent(db, { env: (name) => (name === EDGAR_AGENT_ENV ? GOOD : undefined) })
  assert.deepEqual(resolved, { userAgent: GOOD, source: 'env', rejected: [] })
})

Deno.test('the operating profile row is read when the environment is unset', async () => {
  const db = profileDb({ [EDGAR_AGENT_ENV]: GOOD, CMC_ENABLED: 'true' })
  const resolved = await resolveEdgarUserAgent(db, { env: () => undefined })
  assert.equal(resolved.userAgent, GOOD)
  assert.equal(resolved.source, 'operating_profile')
  // The exact ledger row, not any row of that table.
  assert.deepEqual(db.seen, [['table', 'provider_quota_budgets'], ['provider', 'coinmarketcap'], ['data_type', 'cmc_operating_profile'], ['period_start', '1970-01-01T00:00:00Z']])
})

Deno.test('a non-compliant environment value does not block a compliant row, and is named', async () => {
  const resolved = await resolveEdgarUserAgent(profileDb({ [EDGAR_AGENT_ENV]: GOOD }), { env: () => 'anonymous' })
  assert.equal(resolved.userAgent, GOOD)
  assert.deepEqual(resolved.rejected, ['env:length'])
})

Deno.test('no agent anywhere resolves to none, and an unreadable row never throws', async () => {
  assert.deepEqual(await resolveEdgarUserAgent(profileDb(null), { env: () => undefined }), { userAgent: null, source: null, rejected: [] })
  assert.equal((await resolveEdgarUserAgent(profileDb({}, { error: 'permission denied' }), { env: () => undefined })).userAgent, null)
  assert.equal((await resolveEdgarUserAgent(profileDb({}, { throws: true }), { env: () => undefined })).userAgent, null)
  assert.equal((await resolveEdgarUserAgent(null, { env: () => undefined })).userAgent, null)
  const refused = await resolveEdgarUserAgent(profileDb({ [EDGAR_AGENT_ENV]: 'no contact here' }), { env: () => undefined })
  assert.deepEqual(refused, { userAgent: null, source: null, rejected: ['operating_profile:no_contact_address'] })
})
