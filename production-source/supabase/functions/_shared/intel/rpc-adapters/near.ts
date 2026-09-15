// NEAR fungible-token metadata — public JSON-RPC.
//
// Endpoint
//   POST https://rpc.mainnet.near.org
//        { jsonrpc: '2.0', id: '1', method: 'query', params: {
//            request_type: 'call_function', finality: 'final',
//            account_id: '<token>.near', method_name: 'ft_metadata',
//            args_base64: 'e30=' } }            ('e30=' is base64 for `{}`)
//        → { result: { result: [123, 34, …], logs: [], block_height, block_hash } }
//        `result.result` is the method's return value as a byte array; decoding
//        it as UTF-8 gives the NEP-148 document:
//        { spec: 'ft-1.0.0', name, symbol, decimals, icon?, reference? }
//
//   The same shape with method_name 'ft_total_supply' returns a JSON string of
//   the raw supply; both calls are issued in parallel.
//
// An account that is not a fungible token answers with an error (the method
// does not exist), which is `null` here — a miss, not a failure.
//
// Terms: the NEAR Foundation's public RPC is free and keyless, rate-limited per
// IP. `NEAR_RPC_URL` points at an alternative (FastNEAR's free endpoint, or a
// keyed provider) without a code change.
// One paste costs two calls.

import { type AdapterContext, type RpcMetadata, bytesToUtf8, metadata, supplyOf } from './types.ts'

const NEAR_RPC = 'https://rpc.mainnet.near.org'
/** base64 of `{}` — the argument every NEP-148 view takes. */
const EMPTY_ARGS = 'e30='

export async function nearAdapter(ctx: AdapterContext): Promise<RpcMetadata | null> {
  const account = String(ctx.address || '').trim()
  if (!account || account.length > 64) return null
  const url = ctx.env?.('NEAR_RPC_URL') || NEAR_RPC

  const [meta, supply] = await Promise.all([
    viewFunction(ctx, url, account, 'ft_metadata'),
    viewFunction(ctx, url, account, 'ft_total_supply'),
  ])
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null

  const record = meta as Record<string, unknown>
  return metadata('near', {
    symbol: record.symbol,
    name: record.name,
    decimals: record.decimals,
    totalSupply: supplyOf(supply),
  })
}

/** One `call_function` view. The return value is a byte array holding JSON. */
async function viewFunction(ctx: AdapterContext, url: string, account: string, method: string): Promise<unknown> {
  const body = {
    jsonrpc: '2.0',
    id: 'intel-asset-resolve',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: account,
      method_name: method,
      args_base64: EMPTY_ARGS,
    },
  }
  let raw: unknown
  try {
    raw = await ctx.rpcCall(url, body, ctx.timeoutMs)
  } catch {
    return null
  }
  // deno-lint-ignore no-explicit-any
  const payload: any = raw
  if (payload?.error || payload?.result?.error) return null
  const bytes = payload?.result?.result
  if (!Array.isArray(bytes) || !bytes.length || bytes.length > 8192) return null
  if (!bytes.every((b: unknown) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)) return null

  const decoded = bytesToUtf8(new Uint8Array(bytes))
  if (!decoded) return null
  try {
    return JSON.parse(decoded)
  } catch {
    return null
  }
}
