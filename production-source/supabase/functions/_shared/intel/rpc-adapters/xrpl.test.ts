import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { xrplAdapter } from './xrpl.ts'
import { fakeRpc } from './test-support.ts'

const ISSUER = 'rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz'
const SOLO_HEX = '534F4C4F00000000000000000000000000000000'
const GATEWAY = (obligations: Record<string, string>) => ({
  result: { account: ISSUER, obligations, ledger_hash: 'A1B2', ledger_index: 89_000_000, validated: true, status: 'success' },
})

Deno.test('a 40-hex XRPL currency code decodes to its ASCII symbol with the issued supply', async () => {
  const rpc = fakeRpc([{ match: 'xrplcluster', reply: GATEWAY({ [SOLO_HEX]: '399265844.6' }) }])
  const meta = await xrplAdapter(rpc.context(`${SOLO_HEX}.${ISSUER}`))
  eq(meta, { symbol: 'SOLO', name: null, decimals: null, totalSupply: 399_265_844.6, source: 'rpc:xrpl' })
  eq(rpc.calls.length, 1)
  eq((rpc.calls[0].body as { method: string }).method, 'gateway_balances')
})

Deno.test('a three-character XRPL code is the symbol as issued', async () => {
  const rpc = fakeRpc([{ match: 'xrplcluster', reply: GATEWAY({ USD: '14000.5' }) }])
  const meta = await xrplAdapter(rpc.context(`USD.${ISSUER}`))
  eq(meta?.symbol, 'USD')
  eq(meta?.totalSupply, 14_000.5)
  // XRPL has no on-ledger token name and no per-token decimals: nothing invented.
  eq(meta?.name, null)
  eq(meta?.decimals, null)
})

Deno.test('an issuer that does not issue the pasted code is not that token', async () => {
  const rpc = fakeRpc([{ match: 'xrplcluster', reply: GATEWAY({ USD: '14000' }) }])
  eq(await xrplAdapter(rpc.context(`EUR.${ISSUER}`)), null)
  eq(rpc.calls.length, 1)
})

Deno.test('a bare XRPL account names a token only when it issues exactly one', async () => {
  const single = fakeRpc([{ match: 'xrplcluster', reply: GATEWAY({ USD: '14000' }) }])
  eq((await xrplAdapter(single.context(ISSUER)))?.symbol, 'USD')

  const several = fakeRpc([{ match: 'xrplcluster', reply: GATEWAY({ USD: '14000', EUR: '900' }) }])
  eq(await xrplAdapter(several.context(ISSUER)), null)

  const none = fakeRpc([{ match: 'xrplcluster', reply: GATEWAY({}) }])
  eq(await xrplAdapter(none.context(ISSUER)), null)
})

Deno.test('an unfunded XRPL issuer is a miss, and a funded one still names its code', async () => {
  const missing = fakeRpc([
    { match: 'xrplcluster', reply: { result: { error: 'actNotFound', status: 'error' } } },
  ])
  eq(await xrplAdapter(missing.context(`USD.${ISSUER}`)), null)
  eq(missing.calls.length, 2)

  let call = 0
  const ctx = {
    address: `USD.${ISSUER}`,
    timeoutMs: 4000,
    rpcCall: (_url: string, body: unknown) => {
      call++
      const method = (body as { method: string }).method
      if (method === 'gateway_balances') return Promise.resolve({ result: { error: 'invalidParams', status: 'error' } })
      return Promise.resolve({ result: { account_data: { Account: ISSUER, Balance: '20000000' }, status: 'success', validated: true } })
    },
  }
  const meta = await xrplAdapter(ctx)
  eq(meta?.symbol, 'USD')
  eq(meta?.totalSupply, null)
  eq(call, 2)
})

Deno.test('XRPL honours an XRPL_RPC_URL override and refuses a non-account string', async () => {
  const rpc = fakeRpc([{ match: 'xrpl.internal', reply: GATEWAY({ USD: '1' }) }])
  eq((await xrplAdapter(rpc.context(`USD.${ISSUER}`, { XRPL_RPC_URL: 'https://xrpl.internal/' })))?.symbol, 'USD')

  const unused = fakeRpc([{ match: 'xrplcluster', reply: GATEWAY({ USD: '1' }) }])
  eq(await xrplAdapter(unused.context('not-an-account')), null)
  eq(unused.calls.length, 0)
})
