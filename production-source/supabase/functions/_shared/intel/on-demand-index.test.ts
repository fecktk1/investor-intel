import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { demandQuoteRefresh, indexResolvedAsset, onDemandAssetRow, type IndexableIdentity } from './on-demand-index.ts'

// ── Fakes ────────────────────────────────────────────────────────────────────

type Options = { cacheRows?: unknown[]; cacheError?: boolean; inserted?: boolean; rpcError?: string; rpcThrows?: boolean; updateFails?: boolean }

function fakeAdmin(options: Options = {}) {
  const rpcCalls: { name: string; params: Record<string, unknown> }[] = []
  const reads: string[] = []
  const updates: Record<string, unknown>[] = []
  return {
    rpcCalls,
    reads,
    updates,
    rpc(name: string, params: Record<string, unknown>) {
      rpcCalls.push({ name, params })
      if (options.rpcThrows) throw new Error('postgrest_down')
      if (options.rpcError) return Promise.resolve({ data: null, error: { message: options.rpcError } })
      return Promise.resolve({ data: { inserted: options.inserted !== false, provider_id: 'x', source_provider: 'y' }, error: null })
    },
    from(table: string) {
      reads.push(table)
      // deno-lint-ignore no-explicit-any
      const q: any = {}
      q.select = () => q
      q.eq = () => q
      q.order = () => q
      q.limit = () => Promise.resolve(options.cacheError ? { data: null, error: { message: 'boom' } } : { data: options.cacheRows || [], error: null })
      q.update = (values: Record<string, unknown>) => {
        updates.push(values)
        // deno-lint-ignore no-explicit-any
        const u: any = {}
        u.eq = () => u
        // deno-lint-ignore no-explicit-any
        u.then = (resolve: any) => resolve({ error: options.updateFails ? { message: 'denied' } : null })
        return u
      }
      return q
    },
  }
}

const CMC: IndexableIdentity = {
  kind: 'cmc', provider: 'coinmarketcap', providerId: '3408', symbol: 'USDC', name: 'USDC',
  chain: 'base', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', logoUrl: 'https://cmc/3408.png',
  deployments: [
    { chain: 'base', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', source: 'cmc_metadata' },
    { chain: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', source: 'cmc_metadata' },
    { chain: null, address: '0xdead', source: 'cmc_metadata' },
  ],
}
const CONTRACT: IndexableIdentity = {
  kind: 'contract', provider: 'contract', providerId: 'base:0x4ed4e862860bed51a9570b96d89af5e1b0efefed',
  symbol: 'DEGEN', name: 'Degen', chain: 'base', address: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed',
  logoUrl: 'https://img/degen.png', deployments: [{ chain: 'base', address: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed', source: 'dexscreener' }],
}
const owner = { orgId: 'org-1', userId: 'user-1' }
const quoteRow = (id: string) => ({ cache_key: `cmc:v3:basic:fp:quotes:${id}`, request_params: { id }, demanded_at: null })

// ── Row building ─────────────────────────────────────────────────────────────

Deno.test('a CMC identity becomes a record with every known deployment and no invented market data', () => {
  eq(onDemandAssetRow(CMC), {
    kind: 'cmc', providerId: '3408', chain: 'base', symbol: 'USDC', name: 'USDC',
    imageUrl: 'https://cmc/3408.png',
    platforms: { base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  })
})

Deno.test('a contract identity carries its own chain and a matching provider id', () => {
  const row = onDemandAssetRow(CONTRACT, { logoUrl: 'https://better/logo.png' })
  eq(row?.kind, 'contract')
  eq(row?.providerId, 'base:0x4ed4e862860bed51a9570b96d89af5e1b0efefed')
  eq(row?.chain, 'base')
  eq(row?.imageUrl, 'https://better/logo.png')
  eq(row?.platforms, { base: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed' })
  eq(Object.keys(row || {}).includes('market'), false)
})

Deno.test('an identity without a symbol, a chain or a numeric CMC id is not a record', () => {
  eq(onDemandAssetRow({ ...CMC, symbol: null }), null)
  eq(onDemandAssetRow({ ...CMC, providerId: 'not-a-number' }), null)
  eq(onDemandAssetRow({ ...CONTRACT, chain: null }), null)
  eq(onDemandAssetRow({ ...CONTRACT, address: null }), null)
})

// ── Indexing ─────────────────────────────────────────────────────────────────

Deno.test('a resolved CMC asset is indexed once and put on the demand cadence', async () => {
  const admin = fakeAdmin({ cacheRows: [quoteRow('1,1027,3408,5426')] })
  const result = await indexResolvedAsset(admin, CMC, { ...owner })

  eq(result, { indexed: true, demanded: true, reasons: [] })
  eq(admin.rpcCalls.length, 1)
  eq(admin.rpcCalls[0].name, 'intel_upsert_on_demand_asset')
  eq((admin.rpcCalls[0].params.p_row as Record<string, unknown>).providerId, '3408')
  eq(admin.updates.length, 1)
  eq(admin.updates[0].demand_org_id, 'org-1')
  eq(admin.updates[0].demand_user_id, 'user-1')
  eq(typeof admin.updates[0].demanded_at, 'string')
})

Deno.test('an asset someone already resolved is not written again', async () => {
  const admin = fakeAdmin({ inserted: false, cacheRows: [quoteRow('3408')] })
  const result = await indexResolvedAsset(admin, CMC, { ...owner })
  eq(result.indexed, false)
  eq(result.demanded, true)
  eq(result.reasons, ['already_indexed'])
})

Deno.test('a contract identity is indexed but never stamps a quote demand', async () => {
  const admin = fakeAdmin({ cacheRows: [quoteRow('3408')] })
  const result = await indexResolvedAsset(admin, CONTRACT, { ...owner })
  eq(result.indexed, true)
  eq(result.demanded, false)
  eq(result.reasons, ['not_a_quote_asset'])
  eq(admin.reads.includes('market_data_response_cache'), false)
  eq(admin.updates.length, 0)
})

Deno.test('indexing never throws and never fails a resolution', async () => {
  const thrown = await indexResolvedAsset(fakeAdmin({ rpcThrows: true }), CMC, { ...owner })
  eq(thrown.indexed, false)
  eq(thrown.reasons[0], 'index_failed:postgrest_down')

  const errored = await indexResolvedAsset(fakeAdmin({ rpcError: 'permission denied' }), CMC, { ...owner })
  eq(errored.indexed, false)
  eq(errored.reasons[0], 'index_failed:permission denied')

  const noDb = await indexResolvedAsset({}, CMC, { ...owner })
  eq(noDb, { indexed: false, demanded: false, reasons: ['no_database', 'no_database'] })

  const incomplete = await indexResolvedAsset(fakeAdmin(), { ...CMC, symbol: null }, { ...owner })
  eq(incomplete.indexed, false)
  eq(incomplete.reasons[0], 'identity_incomplete')
  eq(fakeAdmin().rpcCalls.length, 0)
})

// ── The quote demand stamp ───────────────────────────────────────────────────

Deno.test('the id must be a member of the batch, never a substring of another id', async () => {
  const admin = fakeAdmin({ cacheRows: [quoteRow('13408,23408')] })
  eq(await demandQuoteRefresh(admin, CMC, { ...owner }), { demanded: false, reason: 'quote_cache_absent' })
  eq(admin.updates.length, 0)

  const member = fakeAdmin({ cacheRows: [quoteRow('13408,3408,23408')] })
  eq(await demandQuoteRefresh(member, CMC, { ...owner }), { demanded: true, reason: null })
})

Deno.test('a stamp needs a demand owner the worker can recheck, and reports what stopped it', async () => {
  const noOwner = fakeAdmin({ cacheRows: [quoteRow('3408')] })
  eq(await demandQuoteRefresh(noOwner, CMC, {}), { demanded: false, reason: 'demand_owner_unknown' })
  eq(noOwner.reads.length, 0)

  eq(await demandQuoteRefresh(fakeAdmin({ cacheError: true }), CMC, { ...owner }), { demanded: false, reason: 'cache_unavailable' })
  eq(await demandQuoteRefresh(fakeAdmin({ cacheRows: [] }), CMC, { ...owner }), { demanded: false, reason: 'quote_cache_absent' })
  eq(await demandQuoteRefresh(fakeAdmin({ cacheRows: [quoteRow('3408')], updateFails: true }), CMC, { ...owner }), { demanded: false, reason: 'demand_stamp_failed' })
})
