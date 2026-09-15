import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { injectiveAdapter } from './injective.ts'
import { fakeRpc } from './test-support.ts'

const PEGGY_USDT = 'peggy0xdAC17F958D2ee523a2206206994597C13D831ec7'
const IBC_DENOM = 'ibc/C4CFF46FD6DE35CA4CF4CE031E643C8FDC9BA4B99AE598E9B0ED98FE3A2319F9'

const metadata = (base: string, symbol: string, display: string, exponent: number) => ({
  metadata: {
    description: `${symbol} on Injective`,
    denom_units: [
      { denom: base, exponent: 0, aliases: [] },
      { denom: display, exponent, aliases: [] },
    ],
    base,
    display,
    name: symbol,
    symbol,
    uri: '',
    uri_hash: '',
  },
})

Deno.test('an Injective peggy denom decodes symbol, name and the display exponent', async () => {
  const rpc = fakeRpc([{ match: '/denoms_metadata/', reply: metadata(PEGGY_USDT, 'USDT', 'USDT', 6) }])
  const meta = await injectiveAdapter(rpc.context(PEGGY_USDT))
  eq(meta, { symbol: 'USDT', name: 'USDT', decimals: 6, totalSupply: null, source: 'rpc:injective' })
  eq(rpc.calls[0].body, null)
})

Deno.test('an ibc denom is percent-encoded into the path, never appended raw', async () => {
  const rpc = fakeRpc([{ match: '/denoms_metadata/', reply: metadata(IBC_DENOM, 'ATOM', 'ATOM', 6) }])
  eq((await injectiveAdapter(rpc.context(IBC_DENOM)))?.symbol, 'ATOM')
  const url = rpc.calls[0].url
  eq(url.includes('ibc%2FC4CFF46FD6DE35CA4CF4CE031E643C8FDC9BA4B99AE598E9B0ED98FE3A2319F9'), true)
  eq(url.includes('ibc/C4CF'), false)
})

Deno.test('metadata about a different denom is not an answer about this one', async () => {
  const rpc = fakeRpc([{ match: '/denoms_metadata/', reply: metadata('inj', 'INJ', 'INJ', 18) }])
  eq(await injectiveAdapter(rpc.context(PEGGY_USDT)), null)
})

Deno.test('a denom the chain carries no metadata for is a miss', async () => {
  const rpc = fakeRpc([{ match: '/denoms_metadata/', reply: { code: 5, message: "client metadata for denom 'factory/x/y' not found" } }])
  eq(await injectiveAdapter(rpc.context('factory/inj1abcdefghijk/mytoken')), null)
})

Deno.test('without a named display unit the largest exponent is the decimals', async () => {
  const rpc = fakeRpc([{
    match: '/denoms_metadata/',
    reply: {
      metadata: {
        base: PEGGY_USDT,
        display: '',
        symbol: '',
        name: '',
        description: 'Tether',
        denom_units: [{ denom: PEGGY_USDT, exponent: 0 }, { denom: 'usdt', exponent: 6 }],
      },
    },
  }])
  const meta = await injectiveAdapter(rpc.context(PEGGY_USDT))
  eq(meta?.decimals, 6)
  eq(meta?.name, 'Tether')
  eq(meta?.symbol, null)
})

Deno.test('Injective honours an INJECTIVE_LCD_URL override', async () => {
  const rpc = fakeRpc([{ match: 'lcd.internal/cosmos/bank', reply: metadata(PEGGY_USDT, 'USDT', 'USDT', 6) }])
  const meta = await injectiveAdapter(rpc.context(PEGGY_USDT, { INJECTIVE_LCD_URL: 'https://lcd.internal/' }))
  eq(meta?.symbol, 'USDT')
})
