import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { cardanoAdapter } from './cardano.ts'
import { fakeRpc } from './test-support.ts'

// Djed, a registered Cardano native asset: policy id + hex asset name.
const POLICY = '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61'
const ASSET_NAME = '446a65644d6963726f555344' // 'DjedMicroUSD'

const ASSET_INFO = [{
  policy_id: POLICY,
  asset_name: ASSET_NAME,
  asset_name_ascii: 'DjedMicroUSD',
  fingerprint: 'asset1c3f4mvzzqx3qhh5l5s3lnqzqxtz6qz6c8h6g9p',
  minting_tx_hash: 'a1b2c3',
  total_supply: '4231150000000',
  mint_cnt: 12,
  burn_cnt: 3,
  token_registry_metadata: {
    name: 'Djed',
    description: 'An overcollateralised stablecoin',
    ticker: 'DJED',
    url: 'https://djed.xyz',
    logo: 'iVBORw0KGgo=',
    decimals: 6,
  },
}]

Deno.test('a Cardano policy.assetName reads the token registry entry', async () => {
  const rpc = fakeRpc([{ match: '/asset_info', reply: ASSET_INFO }])
  const meta = await cardanoAdapter(rpc.context(`${POLICY}.${ASSET_NAME}`))
  eq(meta, { symbol: 'DJED', name: 'Djed', decimals: 6, totalSupply: 4_231_150_000_000, source: 'rpc:cardano' })
  eq(rpc.calls.length, 1)
  eq(rpc.calls[0].url, 'https://api.koios.rest/api/v1/asset_info')
  eq(rpc.calls[0].body, { _asset_list: [[POLICY, ASSET_NAME]] })
})

Deno.test('an unregistered Cardano asset falls back to its decoded hex name and never invents a name', async () => {
  const rpc = fakeRpc([{
    match: '/asset_info',
    reply: [{ policy_id: POLICY, asset_name: ASSET_NAME, asset_name_ascii: 'DjedMicroUSD', total_supply: '100' }],
  }])
  const meta = await cardanoAdapter(rpc.context(`${POLICY}.${ASSET_NAME}`))
  eq(meta?.symbol, 'DjedMicroUSD')
  eq(meta?.name, null)
  eq(meta?.decimals, null)
  eq(meta?.totalSupply, 100)
})

Deno.test('a bare Cardano policy id resolves only when it minted exactly one asset', async () => {
  const single = fakeRpc([
    { match: '/policy_asset_list', reply: [{ asset_name: ASSET_NAME, fingerprint: 'asset1c3f', total_supply: '100' }] },
    { match: '/asset_info', reply: ASSET_INFO },
  ])
  eq((await cardanoAdapter(single.context(POLICY)))?.symbol, 'DJED')
  eq(single.calls.map((c) => c.url.split('/').pop()), ['policy_asset_list', 'asset_info'])

  const several = fakeRpc([
    { match: '/policy_asset_list', reply: [{ asset_name: ASSET_NAME }, { asset_name: '4f544845' }] },
    { match: '/asset_info', reply: ASSET_INFO },
  ])
  eq(await cardanoAdapter(several.context(POLICY)), null)
  eq(several.calls.length, 1)
})

Deno.test('a Koios answer about another policy is not an answer about this one', async () => {
  const rpc = fakeRpc([{
    match: '/asset_info',
    reply: [{ ...ASSET_INFO[0], policy_id: '0'.repeat(56) }],
  }])
  eq(await cardanoAdapter(rpc.context(`${POLICY}.${ASSET_NAME}`)), null)
})

Deno.test('Cardano refuses a string that is not a policy id, and honours CARDANO_RPC_URL', async () => {
  const unused = fakeRpc([{ match: '/asset_info', reply: ASSET_INFO }])
  eq(await cardanoAdapter(unused.context('not-a-policy')), null)
  eq(unused.calls.length, 0)

  const override = fakeRpc([{ match: 'koios.internal/asset_info', reply: ASSET_INFO }])
  const meta = await cardanoAdapter(override.context(`${POLICY}.${ASSET_NAME}`, { CARDANO_RPC_URL: 'https://koios.internal/' }))
  eq(meta?.symbol, 'DJED')
})
