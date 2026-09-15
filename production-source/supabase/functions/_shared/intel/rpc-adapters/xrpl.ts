// XRP Ledger issued-asset metadata — public JSON-RPC.
//
// Endpoint
//   POST https://xrplcluster.com/   (the XRPL community full-history cluster; the
//        XRPL docs list it alongside s1.ripple.com:51234 as a public server)
//        { "method": "account_info",      "params": [{ account, ledger_index: 'validated' }] }
//        { "method": "gateway_balances",  "params": [{ account, ledger_index: 'validated' }] }
//
// An XRPL token is not a contract: it is a currency code issued by an account,
// written `<CODE>.<rISSUER>`. So there is nothing to read a name or a decimals
// field from —
//   * symbol      the currency code. Three-character codes are used as-is; the
//                 40-hex form is decoded to its ASCII name (e.g. 534F4C4F… → SOLO).
//   * name        null. The ledger has no token name field, and the issuer's
//                 Domain is a domain, not a name, so nothing is invented.
//   * decimals    null. IOU amounts are decimal floats with 15 significant
//                 digits; there is no per-token decimals field to report.
//   * totalSupply the issuer's obligation for that currency — the amount it has
//                 put into circulation, which is the ledger's own supply figure.
//
// An identity with a symbol and no name is exactly the case the resolver reports
// as `identity_only`: searchable and truthful, with nothing claiming a market.
//
// Terms: the public cluster is free and keyless, rate-limited per IP, and asks
// that heavy users run their own node. `XRPL_RPC_URL` overrides it.
// One paste costs one or two calls.

import { type AdapterContext, type RpcMetadata, hexToAscii, metadata, supplyOf } from './types.ts'
import { parseXrplIou } from '../asset-identifier.ts'

const XRPL_RPC = 'https://xrplcluster.com/'

export async function xrplAdapter(ctx: AdapterContext): Promise<RpcMetadata | null> {
  const url = ctx.env?.('XRPL_RPC_URL') || XRPL_RPC
  const value = String(ctx.address || '').trim()
  const iou = parseXrplIou(value)

  if (iou) {
    const obligations = await gatewayBalances(ctx, url, iou.issuer)
    // A verified issuer that does not issue this code is not this token.
    if (obligations && !(iou.currency in obligations)) return null
    if (!obligations && !(await accountExists(ctx, url, iou.issuer))) return null
    return metadata('xrpl', {
      symbol: currencySymbol(iou.currency),
      totalSupply: obligations ? supplyOf(obligations[iou.currency]) : null,
    })
  }

  // A bare issuer account: it names a token only when it issues exactly one
  // currency. Two or more is a chooser the resolver has to make, not a guess.
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) return null
  const obligations = await gatewayBalances(ctx, url, value)
  const codes = obligations ? Object.keys(obligations) : []
  if (codes.length !== 1) return null
  return metadata('xrpl', { symbol: currencySymbol(codes[0]), totalSupply: supplyOf(obligations![codes[0]]) })
}

/** The issuer's outstanding obligations per currency code, or null when the
 *  ledger did not answer with any. */
async function gatewayBalances(ctx: AdapterContext, url: string, account: string): Promise<Record<string, unknown> | null> {
  const body = { method: 'gateway_balances', params: [{ account, ledger_index: 'validated' }] }
  // deno-lint-ignore no-explicit-any
  const raw: any = await ctx.rpcCall(url, body, ctx.timeoutMs)
  const result = raw?.result
  if (!result || result.error || result.status === 'error') return null
  const obligations = result.obligations
  return obligations && typeof obligations === 'object' && !Array.isArray(obligations)
    ? obligations as Record<string, unknown>
    : null
}

async function accountExists(ctx: AdapterContext, url: string, account: string): Promise<boolean> {
  const body = { method: 'account_info', params: [{ account, ledger_index: 'validated' }] }
  // deno-lint-ignore no-explicit-any
  const raw: any = await ctx.rpcCall(url, body, ctx.timeoutMs)
  const result = raw?.result
  return !!result?.account_data?.Account && !result.error
}

/** A 3-character code is the symbol; the 40-hex form decodes to its ASCII name,
 *  and a hex code that is not printable ASCII stays hex rather than becoming
 *  mojibake. */
function currencySymbol(code: string): string | null {
  const raw = String(code || '').trim()
  if (!raw) return null
  if (/^[0-9A-Fa-f]{40}$/.test(raw)) return hexToAscii(raw) || raw
  return raw.slice(0, 64)
}
