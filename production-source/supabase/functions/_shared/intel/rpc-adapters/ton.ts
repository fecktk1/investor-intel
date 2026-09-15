// TON jetton metadata — toncenter v2 (public, keyless tier).
//
// Endpoints
//   GET  https://toncenter.com/api/v2/getTokenData?address=<jetton master>
//        toncenter's decoded form of the jetton master's get_jetton_data():
//        { ok, result: { total_supply, mintable, admin_address, contract_type,
//                        jetton_content: { type: 'onchain' | 'offchain', data } } }
//        On-chain content is already a { name, symbol, decimals, image } object
//        (TEP-64 keys hashed into the content dictionary, resolved by toncenter);
//        off-chain content is the metadata URI as a plain string.
//   POST https://toncenter.com/api/v2/runGetMethod
//        { address, method: 'get_jetton_data', stack: [] } — the raw get-method
//        fallback. Its stack is
//        [ num total_supply, num mintable, cell admin_address, cell jetton_content,
//          cell jetton_wallet_code ]. We take the supply from the first entry and
//        scan the content cell's BOC for a TEP-64 off-chain https URI. That scan
//        is a byte scan, not a BOC parser: a snake-encoded URI is plain ASCII in
//        the cell body, and anything that is not a clean https URL is ignored.
//
// Terms: toncenter is operated by the TON Foundation and is free to use without
// an API key at roughly 1 request/second (a key raises the limit). Attribution
// is not required. One paste costs at most three requests.

import {
  type AdapterContext,
  type RpcMetadata,
  base64ToBytes,
  bytesToUtf8,
  metadata,
  safeMetadataUrl,
  withinOffchainBudget,
} from './types.ts'

const TONCENTER = 'https://toncenter.com/api/v2'

export async function tonAdapter(ctx: AdapterContext): Promise<RpcMetadata | null> {
  const address = String(ctx.address || '').trim()
  if (!address) return null
  const base = ctx.env?.('TON_RPC_URL')?.replace(/\/+$/, '') || TONCENTER

  const decoded = await tokenData(ctx, base, address)
  if (decoded) return decoded
  return await getMethod(ctx, base, address)
}

/** getTokenData: toncenter has already resolved the content dictionary. */
async function tokenData(ctx: AdapterContext, base: string, address: string): Promise<RpcMetadata | null> {
  const url = `${base}/getTokenData?address=${encodeURIComponent(address)}`
  // deno-lint-ignore no-explicit-any
  const raw: any = await ctx.rpcCall(url, null, ctx.timeoutMs)
  const result = raw?.result
  if (raw?.ok === false || !result) return null
  // A wallet or an NFT item is not a jetton master; refuse rather than describe
  // the wrong object.
  if (result.contract_type && result.contract_type !== 'jetton_master') return null

  const content = result.jetton_content
  const fields = content?.type === 'offchain'
    ? await offchain(ctx, content?.data)
    : onchain(content?.data ?? content)

  return metadata('ton', { ...fields, totalSupply: result.total_supply })
}

/** runGetMethod fallback: the supply, plus an off-chain URI when the content
 *  cell carries one in the clear. */
async function getMethod(ctx: AdapterContext, base: string, address: string): Promise<RpcMetadata | null> {
  const body = { address, method: 'get_jetton_data', stack: [] }
  // deno-lint-ignore no-explicit-any
  const raw: any = await ctx.rpcCall(`${base}/runGetMethod`, body, ctx.timeoutMs)
  const result = raw?.result
  if (raw?.ok === false || !result || Number(result.exit_code ?? 0) !== 0) return null
  const stack: unknown[] = Array.isArray(result.stack) ? result.stack : []
  const entry = (index: number) => (Array.isArray(stack[index]) ? stack[index] as unknown[] : null)

  const supplyCell = entry(0)
  const totalSupply = supplyCell?.[0] === 'num' ? hexNumber(supplyCell[1]) : null

  const contentCell = entry(3)
  const uri = contentCell?.[0] === 'cell' ? uriInCell((contentCell[1] as { bytes?: unknown })?.bytes) : null
  const fields = uri ? await offchain(ctx, uri) : {}

  return metadata('ton', { ...fields, totalSupply })
}

/** TEP-64 on-chain content, already keyed by toncenter. */
function onchain(data: unknown): { symbol?: unknown; name?: unknown; decimals?: unknown } {
  const record = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  return { symbol: record.symbol, name: record.name, decimals: record.decimals }
}

/** Follow a TEP-64 off-chain metadata URI. HTTPS only, 4 KB only, and a failure
 *  is simply "no off-chain fields" — never an error for the ladder. */
async function offchain(ctx: AdapterContext, value: unknown): Promise<{ symbol?: unknown; name?: unknown; decimals?: unknown }> {
  const url = safeMetadataUrl(value)
  if (!url) return {}
  try {
    const payload = await ctx.rpcCall(url, null, ctx.timeoutMs)
    if (!withinOffchainBudget(payload)) return {}
    return onchain(payload)
  } catch {
    return {}
  }
}

/** toncenter reports get-method integers as `0x…` strings. */
function hexNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value.trim())) return null
  try {
    const n = BigInt(value.trim())
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null
  } catch {
    return null
  }
}

/** Scan a base64 BOC for a clean https URI. Snake-encoded TEP-64 off-chain
 *  content stores the URL as ASCII bytes, so a scan finds it without a cell
 *  parser; anything ambiguous is dropped. */
function uriInCell(bytes: unknown): string | null {
  const decoded = base64ToBytes(bytes)
  if (!decoded) return null
  const asText = bytesToUtf8(decoded)
  if (!asText) return null
  const match = /https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{4,400}/.exec(asText)
  return match ? safeMetadataUrl(match[0]) : null
}
