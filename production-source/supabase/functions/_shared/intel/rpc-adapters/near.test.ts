import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { nearAdapter } from './near.ts'
import { utf8Bytes } from './test-support.ts'

const NEP148 = {
  spec: 'ft-1.0.0',
  name: 'Wrapped NEAR fungible token',
  symbol: 'wNEAR',
  decimals: 24,
  icon: 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
}

/** A NEAR JSON-RPC `call_function` reply: the return value as a byte array. */
const viewReply = (value: unknown) => ({
  jsonrpc: '2.0',
  id: 'intel-asset-resolve',
  result: { result: utf8Bytes(JSON.stringify(value)), logs: [], block_height: 129_000_000, block_hash: 'A1B2' },
})

function ctxFor(replies: Record<string, unknown>, address = 'wrap.near') {
  const methods: string[] = []
  return {
    methods,
    ctx: {
      address,
      timeoutMs: 4000,
      rpcCall: (url: string, body: unknown) => {
        eq(url, 'https://rpc.mainnet.near.org')
        // deno-lint-ignore no-explicit-any
        const params: any = (body as any)?.params
        eq(params.request_type, 'call_function')
        eq(params.finality, 'final')
        // base64 of `{}` — every NEP-148 view takes an empty argument object.
        eq(params.args_base64, 'e30=')
        methods.push(params.method_name)
        return Promise.resolve(replies[params.method_name] ?? { error: { name: 'HANDLER_ERROR' } })
      },
    },
  }
}

Deno.test('a NEAR fungible token decodes ft_metadata and ft_total_supply', async () => {
  const { ctx, methods } = ctxFor({
    ft_metadata: viewReply(NEP148),
    ft_total_supply: viewReply('1234567890'),
  })
  const meta = await nearAdapter(ctx)
  eq(meta, { symbol: 'wNEAR', name: 'Wrapped NEAR fungible token', decimals: 24, totalSupply: 1_234_567_890, source: 'rpc:near' })
  eq(methods.sort(), ['ft_metadata', 'ft_total_supply'])
})

Deno.test('a NEAR account that is not a fungible token is a miss', async () => {
  const { ctx } = ctxFor({ ft_total_supply: viewReply('1') }, 'alice.near')
  eq(await nearAdapter(ctx), null)
})

Deno.test('a NEAR supply too large for an exact number is dropped, never rounded', async () => {
  const { ctx } = ctxFor({
    ft_metadata: viewReply(NEP148),
    ft_total_supply: viewReply('570098069151293818184400000000000'),
  })
  const meta = await nearAdapter(ctx)
  eq(meta?.symbol, 'wNEAR')
  eq(meta?.totalSupply, null)
})

Deno.test('NEAR honours a NEAR_RPC_URL override', async () => {
  const urls: string[] = []
  const meta = await nearAdapter({
    address: 'wrap.near',
    timeoutMs: 4000,
    env: (key) => (key === 'NEAR_RPC_URL' ? 'https://free.rpc.fastnear.com' : undefined),
    rpcCall: (url, body) => {
      urls.push(url)
      // deno-lint-ignore no-explicit-any
      return Promise.resolve((body as any).params.method_name === 'ft_metadata' ? viewReply(NEP148) : viewReply('1'))
    },
  })
  eq(meta?.symbol, 'wNEAR')
  eq([...new Set(urls)], ['https://free.rpc.fastnear.com'])
})

Deno.test('a NEAR return value that is not JSON, or is absurdly large, is refused', async () => {
  const notJson = await nearAdapter({
    address: 'wrap.near',
    timeoutMs: 4000,
    rpcCall: () => Promise.resolve({ result: { result: utf8Bytes('not json at all') } }),
  })
  eq(notJson, null)

  const huge = await nearAdapter({
    address: 'wrap.near',
    timeoutMs: 4000,
    rpcCall: () => Promise.resolve({ result: { result: new Array(9000).fill(65) } }),
  })
  eq(huge, null)
})
