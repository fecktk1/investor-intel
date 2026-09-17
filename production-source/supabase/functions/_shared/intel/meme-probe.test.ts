// DIAGNOSTIC TEST. Delete with `meme-probe.ts`.
import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  probeMemeVariants, memePlatformComparison, MEME_PROBE_VARIANTS, MEME_PROBE_MAX_CREDITS, MEME_PROBE_AUTHORITIES,
} from './meme-probe.ts'

const NOW = new Date('2026-09-17T13:00:00.000Z')
const ctxFor = (name: string, maxCalls: number) => ({ jobName: 'test', caller: name, kind: 'job' as const, maxCalls })

/** Records every table it is asked for, so a test can prove what was written. */
function fakeDb() {
  const tables: string[] = []
  return {
    tables,
    from(table: string) {
      tables.push(table)
      // deno-lint-ignore no-explicit-any
      const q: any = { insert: () => Promise.resolve({ error: null }), select: () => q, eq: () => q, upsert: () => Promise.resolve({ error: null }), limit: () => Promise.resolve({ data: [], error: null }) }
      return q
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
}

const memeBody = (rows: Record<string, unknown[]> = {}, credit = 1) => ({
  data: { newCreations: rows.newCreations ?? [], aboutGraduates: rows.aboutGraduates ?? [], graduates: rows.graduates ?? [] },
  status: { error_code: 0, error_message: null, credit_count: credit },
})
const respond = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

Deno.test('the probe refuses without the capture gate, calls nothing and writes nothing', async () => {
  const db = fakeDb()
  let calls = 0
  const never = (() => { calls += 1; return Promise.resolve(respond(memeBody())) }) as unknown as typeof fetch
  const deps = { request: () => { calls += 1; return Promise.resolve({ payload: null }) }, policy: [] }
  for (const authority of [undefined, null, '', 'anonymous', 'service_role', 'read']) {
    const result = await probeMemeVariants(db, ctxFor, NOW, 'startup', deps as never, {}, authority, never)
    eq(result.skipped, 'unauthorized', String(authority))
    eq(result.credits, 0)
    eq(result.rows, 0)
  }
  eq(calls, 0, 'a refused probe never reaches a provider')
  eq(db.tables, [], 'a refused probe never touches a table')
  // Only the two authorities the capture half can produce are accepted.
  eq(MEME_PROBE_AUTHORITIES, ['cron_secret', 'super_admin'])
})

Deno.test('the probe below Startup or without a credential spends nothing', async () => {
  const db = fakeDb()
  let calls = 0
  const never = (() => { calls += 1; return Promise.resolve(respond(memeBody())) }) as unknown as typeof fetch
  const below = await probeMemeVariants(db, ctxFor, NOW, 'basic', undefined, {}, 'cron_secret', never)
  eq(below.skipped, 'plan_below_startup')
  eq(calls, 0)
  eq(db.tables, [])
})

Deno.test('the probe sends the documented bodies, stores nothing and reports what came back', async () => {
  const saved = Deno.env.get('COINMARKETCAP_API_KEY')
  Deno.env.set('COINMARKETCAP_API_KEY', 'synthetic-probe-test-key')
  try {
    const db = fakeDb()
    const sent: { url: string; body: unknown; hasKey: boolean }[] = []
    const row = { pid: 16, addr: 'So11111111111111111111111111111111111111112', n: 'x'.repeat(400), sym: 'AAA', p: 0.1, mcap: 1000 }
    const impl = ((url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      sent.push({ url: String(url), body, hasKey: Boolean((init.headers as Record<string, string>)['X-CMC_PRO_API_KEY']) })
      // Only the fourth variant answers rows; the rest answer the empty board.
      if (Number(body.protocol) === 2001) return Promise.resolve(respond(memeBody({ graduates: [row] })))
      return Promise.resolve(respond(memeBody()))
    }) as unknown as typeof fetch
    const deps = { request: () => Promise.resolve({ payload: { data: [{ id: 16, n: 'solana', dexerTxHashFormat: 'base58' }] }, receipt: { origin: 'live' } }), policy: [] }
    const result = await probeMemeVariants(db, ctxFor, NOW, 'startup', deps as never, {}, 'cron_secret', impl)

    // Every documented variant, in order, to the one path being diagnosed.
    eq(sent.length, MEME_PROBE_VARIANTS.length)
    eq(sent.every((s) => s.url.endsWith('/v1/dex/meme/list') && s.hasKey), true)
    eq(sent.map((s) => s.body), MEME_PROBE_VARIANTS.map((v) => v.body))
    // Six meme calls plus the platform list, and never more than the ceiling.
    eq(result.credits, MEME_PROBE_MAX_CREDITS)
    assert((result.credits as number) <= MEME_PROBE_MAX_CREDITS)

    const variants = result.variants as Record<string, unknown>[]
    eq(variants.length, 6)
    eq(variants.map((v) => v.variant), [1, 2, 3, 4, 5, 6])
    // The body that produced each answer travels WITH the answer.
    eq(variants[0].body, { limit: 25 })
    eq(variants[0].lengths, { newCreations: 0, aboutGraduates: 0, graduates: 0 })
    eq(variants[0].sample, null, 'an empty board has no first row')
    eq(result.withRows, [4])
    const sample = variants[3].sample as { stage: string; keys: string[]; row: Record<string, string> }
    eq(sample.stage, 'graduates')
    assert(sample.keys.includes('addr'))
    // Every reported value is truncated; nothing unbounded is echoed back.
    eq(sample.row.n.length, 121)
    eq(sample.row.addr, row.addr)

    // The platform list is compared against the ids this platform hardcodes.
    const platforms = result.platforms as Record<string, unknown>[]
    eq(platforms.length, 4)
    eq(platforms.find((p) => p.platform === 'solana'), { chain: 'solana', platform: 'solana', hardcodedId: 16, publishedId: 16, publishedName: 'solana', dexerTxHashFormat: 'base58', matches: true })
    // A network the list does not name is reported as unmatched, never assumed.
    eq(platforms.find((p) => p.platform === 'base')?.matches, false)
    eq(platforms.find((p) => p.platform === 'base')?.publishedId, null)

    // NOTHING is stored: the only table touched is the provider call receipt.
    eq([...new Set(db.tables)], ['provider_call_logs'])
    eq(db.tables.some((t) => t.startsWith('intel_meme')), false)
    eq(result.rows, 0)
  } finally {
    if (saved == null) Deno.env.delete('COINMARKETCAP_API_KEY'); else Deno.env.set('COINMARKETCAP_API_KEY', saved)
  }
})

Deno.test('a refusal or an unreadable body is reported rather than thrown', async () => {
  const saved = Deno.env.get('COINMARKETCAP_API_KEY')
  Deno.env.set('COINMARKETCAP_API_KEY', 'synthetic-probe-test-key')
  try {
    const db = fakeDb()
    const impl = ((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (body.platformIds === 16) return Promise.resolve(new Response('<html>403 Forbidden</html>', { status: 403 }))
      return Promise.resolve(respond({ status: { error_code: 1006, error_message: 'Your plan does not support this endpoint.', credit_count: 0 } }, 403))
    }) as unknown as typeof fetch
    const deps = { request: () => Promise.resolve({ payload: null, reason: 'insufficient_entitlement' }), policy: [] }
    const result = await probeMemeVariants(db, ctxFor, NOW, 'startup', deps as never, {}, 'super_admin', impl)
    const variants = result.variants as Record<string, unknown>[]
    eq(variants[1].status, 403)
    eq(variants[1].unreadable, '<html>403 Forbidden</html>')
    eq(variants[0].errorCode, '1006')
    eq(variants[0].errorMessage, 'Your plan does not support this endpoint.')
    // A refusal is not charged, and an unavailable platform list is a reason.
    eq(result.credits, 0)
    eq(result.platforms, null)
    eq(result.platformReason, 'insufficient_entitlement')
    eq(result.skipped, 'no_variant_returned_rows')
    eq(db.tables.some((t) => t.startsWith('intel_meme')), false)
  } finally {
    if (saved == null) Deno.env.delete('COINMARKETCAP_API_KEY'); else Deno.env.set('COINMARKETCAP_API_KEY', saved)
  }
})

Deno.test('the platform comparison matches on the provider name, never on our own id', () => {
  // The ids are deliberately WRONG in this answer: the comparison must report
  // them as published and say they do not match, not quietly accept ours.
  const payload = { data: [
    { id: 99, n: 'Solana', dexerTxHashFormat: 'base58' },
    { id: 1, n: 'Ethereum', dexerTxHashFormat: 'hex' },
  ] }
  const rows = memePlatformComparison(payload)
  eq(rows.find((r) => r.platform === 'solana')?.publishedId, 99)
  eq(rows.find((r) => r.platform === 'solana')?.matches, false)
  eq(rows.find((r) => r.platform === 'ethereum')?.matches, true)
  eq(rows.find((r) => r.platform === 'arbitrum')?.publishedId, null)
})
