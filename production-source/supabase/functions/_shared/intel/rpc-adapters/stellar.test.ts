import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { stellarAdapter } from './stellar.ts'
import { fakeRpc } from './test-support.ts'

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

// Horizon /assets record shape.
const record = (code: string, amount: string) => ({
  _links: { toml: { href: 'https://www.example.com/.well-known/stellar.toml' } },
  asset_type: 'credit_alphanum4',
  asset_code: code,
  asset_issuer: ISSUER,
  paging_token: `${code}_${ISSUER}_credit_alphanum4`,
  num_accounts: 1_204_331,
  amount,
  accounts: { authorized: 1_204_331, authorized_to_maintain_liabilities: 0, unauthorized: 0 },
  balances: { authorized: amount, authorized_to_maintain_liabilities: '0.0000000', unauthorized: '0.0000000' },
})
const embedded = (...records: unknown[]) => ({ _links: {}, _embedded: { records } })

Deno.test('a Stellar CODE-ISSUER asset decodes its code, the protocol decimals and the issued amount', async () => {
  const rpc = fakeRpc([{ match: 'horizon.stellar.org/assets', reply: embedded(record('USDC', '1234567.8901234')) }])
  const meta = await stellarAdapter(rpc.context(`USDC-${ISSUER}`))
  eq(meta, { symbol: 'USDC', name: null, decimals: 7, totalSupply: 1_234_567.8901234, source: 'rpc:stellar' })
  eq(rpc.calls.length, 1)
  eq(rpc.calls[0].body, null)
  eq(rpc.calls[0].url.includes(`asset_code=USDC&asset_issuer=${ISSUER}&limit=1`), true)
})

Deno.test('a bare Stellar issuer names an asset only when it issued exactly one', async () => {
  const single = fakeRpc([{ match: '/assets', reply: embedded(record('USDC', '10.0000000')) }])
  eq((await stellarAdapter(single.context(ISSUER)))?.symbol, 'USDC')
  eq(single.calls[0].url.includes('limit=2'), true)

  const several = fakeRpc([{ match: '/assets', reply: embedded(record('USDC', '10'), record('EURC', '5')) }])
  eq(await stellarAdapter(several.context(ISSUER)), null)

  const none = fakeRpc([{ match: '/assets', reply: embedded() }])
  eq(await stellarAdapter(none.context(ISSUER)), null)
})

Deno.test('a Horizon record without an asset code is not an identity', async () => {
  const rpc = fakeRpc([{ match: '/assets', reply: embedded({ asset_type: 'native', amount: '100' }) }])
  eq(await stellarAdapter(rpc.context(`USDC-${ISSUER}`)), null)
})

Deno.test('Stellar honours a STELLAR_HORIZON_URL override and refuses a non-Stellar string', async () => {
  const rpc = fakeRpc([{ match: 'horizon.internal/assets', reply: embedded(record('USDC', '1')) }])
  eq((await stellarAdapter(rpc.context(`USDC-${ISSUER}`, { STELLAR_HORIZON_URL: 'https://horizon.internal/' })))?.symbol, 'USDC')

  const unused = fakeRpc([{ match: '/assets', reply: embedded(record('USDC', '1')) }])
  eq(await stellarAdapter(unused.context('GNOTANISSUER')), null)
  eq(unused.calls.length, 0)
})
