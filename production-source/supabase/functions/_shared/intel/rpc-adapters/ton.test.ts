import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { tonAdapter } from './ton.ts'
import { base64, fakeRpc } from './test-support.ts'

const JETTON = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

// toncenter /api/v2/getTokenData, TEP-64 on-chain content. Shapes are the ones
// the documented endpoint returns; decimals arrives as a string.
const ONCHAIN = {
  ok: true,
  result: {
    total_supply: '1000000000000',
    mintable: true,
    admin_address: 'EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y',
    jetton_content: {
      type: 'onchain',
      data: { name: 'Notcoin', description: 'The community token', symbol: 'NOT', decimals: '9', image: 'https://cdn.example.com/not.png' },
    },
    jetton_wallet_code: 'te6cckEBAQEAAgAAAEysuc0=',
    contract_type: 'jetton_master',
  },
}

const OFFCHAIN = {
  ok: true,
  result: {
    total_supply: '5000000000',
    mintable: false,
    jetton_content: { type: 'offchain', data: 'https://cdn.example.com/jetton.json' },
    contract_type: 'jetton_master',
  },
}

Deno.test('TON on-chain jetton content decodes name, symbol, decimals and supply', async () => {
  const rpc = fakeRpc([{ match: '/getTokenData', reply: ONCHAIN }])
  const meta = await tonAdapter(rpc.context(JETTON))
  eq(meta, { symbol: 'NOT', name: 'Notcoin', decimals: 9, totalSupply: 1_000_000_000_000, source: 'rpc:ton' })
  eq(rpc.calls.length, 1)
  // A GET: the seam sends no body for toncenter's decoded read.
  eq(rpc.calls[0].body, null)
  eq(rpc.calls[0].url.includes(encodeURIComponent(JETTON)), true)
})

Deno.test('TON off-chain content is followed over HTTPS and decoded', async () => {
  const rpc = fakeRpc([
    { match: '/getTokenData', reply: OFFCHAIN },
    { match: 'cdn.example.com/jetton.json', reply: { name: 'Example Jetton', symbol: 'EXJ', decimals: 6, image: 'https://cdn.example.com/exj.png' } },
  ])
  const meta = await tonAdapter(rpc.context(JETTON))
  eq(meta?.symbol, 'EXJ')
  eq(meta?.name, 'Example Jetton')
  eq(meta?.decimals, 6)
  eq(meta?.totalSupply, 5_000_000_000)
  eq(rpc.calls.length, 2)
})

Deno.test('TON off-chain content that is not plain HTTPS is never fetched', async () => {
  for (const uri of ['ipfs://QmExampleHash', 'http://cdn.example.com/j.json', 'https://127.0.0.1/j.json', 'https://localhost/j.json']) {
    const rpc = fakeRpc([{ match: '/getTokenData', reply: { ...OFFCHAIN, result: { ...OFFCHAIN.result, jetton_content: { type: 'offchain', data: uri } } } }])
    const meta = await tonAdapter(rpc.context(JETTON))
    // The supply still stands; the identity fields simply stay unknown.
    eq(meta?.symbol, null, uri)
    eq(meta?.totalSupply, 5_000_000_000, uri)
    eq(rpc.calls.length, 1, `${uri} was fetched`)
  }
})

Deno.test('TON off-chain document over the 4 KB budget is refused', async () => {
  const rpc = fakeRpc([
    { match: '/getTokenData', reply: OFFCHAIN },
    { match: 'cdn.example.com', reply: { name: 'Big', symbol: 'BIG', decimals: 9, description: 'x'.repeat(5000) } },
  ])
  const meta = await tonAdapter(rpc.context(JETTON))
  eq(meta?.symbol, null)
  eq(meta?.totalSupply, 5_000_000_000)
})

Deno.test('TON falls back to runGetMethod and reads the off-chain URI out of the content cell', async () => {
  const cell = base64('https://cdn.example.com/fallback.json')
  const rpc = fakeRpc([
    { match: '/getTokenData', reply: { ok: false, error: 'not found' } },
    {
      match: '/runGetMethod',
      reply: {
        ok: true,
        result: {
          gas_used: 3000,
          exit_code: 0,
          stack: [
            ['num', '0xe8d4a51000'],
            ['num', '0x-1'],
            ['cell', { bytes: 'te6cckEBAQEAAgAAAEysuc0=' }],
            ['cell', { bytes: cell }],
            ['cell', { bytes: 'te6cckEBAQEAAgAAAEysuc0=' }],
          ],
        },
      },
    },
    { match: 'cdn.example.com/fallback.json', reply: { name: 'Fallback Jetton', symbol: 'FBJ', decimals: 9 } },
  ])
  const meta = await tonAdapter(rpc.context(JETTON))
  eq(meta?.symbol, 'FBJ')
  eq(meta?.name, 'Fallback Jetton')
  eq(meta?.totalSupply, 1_000_000_000_000)
  eq(rpc.calls.map((c) => (c.body == null ? 'GET' : 'POST')), ['GET', 'POST', 'GET'])
})

Deno.test('TON refuses to describe a contract that is not a jetton master', async () => {
  const rpc = fakeRpc([
    { match: '/getTokenData', reply: { ok: true, result: { contract_type: 'nft_item', jetton_content: { type: 'onchain', data: { name: 'Punk #1' } } } } },
    { match: '/runGetMethod', reply: { ok: false, error: 'method not found' } },
  ])
  eq(await tonAdapter(rpc.context(JETTON)), null)
})

Deno.test('TON honours a TON_RPC_URL override', async () => {
  const rpc = fakeRpc([{ match: 'ton.internal/api/v2/getTokenData', reply: ONCHAIN }])
  const meta = await tonAdapter(rpc.context(JETTON, { TON_RPC_URL: 'https://ton.internal/api/v2/' }))
  eq(meta?.symbol, 'NOT')
})
