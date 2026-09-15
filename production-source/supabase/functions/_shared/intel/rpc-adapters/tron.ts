// Tron TRC-20 metadata — TronGrid (public, keyless tier).
//
// Endpoint
//   POST https://api.trongrid.io/wallet/triggerconstantcontract
//        { owner_address, contract_address, function_selector, parameter: '' }
//        → { result: { result: true }, constant_result: ['<abi hex>'] }
//        A constant call executes the method without a transaction, so name(),
//        symbol(), decimals() and totalSupply() cost nothing and need no key.
//        TRC-20 returns are ABI-encoded exactly like ERC-20, so the same
//        decoders read them.
//
// Addresses: TronGrid speaks either base58check ("visible": true) or the 21-byte
// hex form (0x41 + the 20-byte account). We convert locally and send hex, which
// means a mistyped address fails its checksum here and never reaches the
// network — the same reason the resolver validates formats before it calls out.
//
// Terms: TronGrid's public endpoint is free and keyless at a published
// rate limit (roughly 15 queries/second per IP; an API key raises it).
// `TRON_RPC_URL` overrides the base when a keyed endpoint is configured.
//
// One paste costs four constant calls, issued in parallel.

import { type AdapterContext, type RpcMetadata, metadata } from './types.ts'
import { decodeAbiString, decodeAbiUint } from './evm-abi.ts'

const TRONGRID = 'https://api.trongrid.io'
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export async function tronAdapter(ctx: AdapterContext): Promise<RpcMetadata | null> {
  const hex = await tronBase58ToHex(ctx.address)
  if (!hex) return null
  const base = ctx.env?.('TRON_RPC_URL')?.replace(/\/+$/, '') || TRONGRID

  const [name, symbol, decimals, supply] = await Promise.all([
    constantCall(ctx, base, hex, 'name()'),
    constantCall(ctx, base, hex, 'symbol()'),
    constantCall(ctx, base, hex, 'decimals()'),
    constantCall(ctx, base, hex, 'totalSupply()'),
  ])

  return metadata('tron', {
    symbol: decodeAbiString(symbol),
    name: decodeAbiString(name),
    decimals: decodeAbiUint(decimals),
    totalSupply: decodeAbiUint(supply),
  })
}

/** One constant call. A contract without the method answers with an empty or
 *  failed result, which is "no value", not an error for the ladder. */
async function constantCall(ctx: AdapterContext, base: string, contractHex: string, selector: string): Promise<string | null> {
  const body = {
    owner_address: contractHex,
    contract_address: contractHex,
    function_selector: selector,
    parameter: '',
  }
  let raw: unknown
  try {
    raw = await ctx.rpcCall(`${base}/wallet/triggerconstantcontract`, body, ctx.timeoutMs)
  } catch {
    return null
  }
  // deno-lint-ignore no-explicit-any
  const payload: any = raw
  if (payload?.result?.result !== true) return null
  const value = Array.isArray(payload.constant_result) ? payload.constant_result[0] : null
  return typeof value === 'string' && /^[0-9a-fA-F]*$/.test(value) && value.length ? `0x${value}` : null
}

/** base58check → the 21-byte hex form TronGrid accepts, or null when the
 *  address is not 0x41-prefixed or its checksum does not verify. */
export async function tronBase58ToHex(value: unknown): Promise<string | null> {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(raw)) return null
  const decoded = base58Decode(raw)
  if (!decoded || decoded.length !== 25 || decoded[0] !== 0x41) return null

  const payload = decoded.slice(0, 21)
  const checksum = decoded.slice(21)
  const first = new Uint8Array(await crypto.subtle.digest('SHA-256', payload))
  const second = new Uint8Array(await crypto.subtle.digest('SHA-256', first))
  for (let i = 0; i < 4; i++) if (second[i] !== checksum[i]) return null

  return [...payload].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function base58Decode(value: string): Uint8Array | null {
  let total = 0n
  for (const ch of value) {
    const index = BASE58.indexOf(ch)
    if (index < 0) return null
    total = total * 58n + BigInt(index)
  }
  const digits: number[] = []
  while (total > 0n) {
    digits.unshift(Number(total % 256n))
    total /= 256n
  }
  // Every leading '1' is a leading zero byte.
  for (const ch of value) {
    if (ch !== '1') break
    digits.unshift(0)
  }
  return new Uint8Array(digits)
}
