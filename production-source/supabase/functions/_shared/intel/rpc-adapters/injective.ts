// Injective denom metadata — the public LCD (Cosmos bank module).
//
// Endpoint
//   GET https://sentry.lcd.injective.network/cosmos/bank/v1beta1/denoms_metadata/{denom}
//       → { metadata: { description, denom_units: [ { denom, exponent, aliases } ],
//                       base, display, name, symbol, uri, uri_hash } }
//
// The denom is a path segment that contains slashes (`ibc/<hash>`,
// `factory/<creator>/<sub>`, `peggy0x…`), so it is percent-encoded before it is
// appended — an unencoded `ibc/…` would address a different route entirely.
//
// Decimals come from the denom_unit whose `denom` equals `display`: the bank
// module records the exponent between the base unit and the display unit, which
// is the same number a token calls its decimals.
//
// A denom the chain carries no metadata for answers 404/`not found`, which is a
// miss — the denom may still exist, we simply have no name for it.
//
// Terms: the Injective Labs sentry LCD is free and keyless, rate-limited per IP.
// `INJECTIVE_LCD_URL` points at another node without a code change.
// One paste costs one call.

import { type AdapterContext, type RpcMetadata, decimalsOf, metadata, text } from './types.ts'

const INJECTIVE_LCD = 'https://sentry.lcd.injective.network'

export async function injectiveAdapter(ctx: AdapterContext): Promise<RpcMetadata | null> {
  const denom = String(ctx.address || '').trim()
  if (!denom || denom.length > 200) return null
  const base = ctx.env?.('INJECTIVE_LCD_URL')?.replace(/\/+$/, '') || INJECTIVE_LCD
  const url = `${base}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`

  // deno-lint-ignore no-explicit-any
  const raw: any = await ctx.rpcCall(url, null, ctx.timeoutMs)
  const meta = raw?.metadata
  if (!meta || typeof meta !== 'object') return null
  // A node that answered about a different denom is not an answer about this one.
  if (meta.base && text(meta.base, 200) !== denom) return null

  return metadata('injective', {
    symbol: text(meta.symbol, 64) || text(meta.display, 64),
    name: text(meta.name, 160) || text(meta.description, 160),
    decimals: displayExponent(meta),
  })
}

/** The exponent of the display unit, which is the token's decimals. */
// deno-lint-ignore no-explicit-any
function displayExponent(meta: any): number | null {
  const units = Array.isArray(meta?.denom_units) ? meta.denom_units : []
  const display = text(meta?.display, 64)
  // deno-lint-ignore no-explicit-any
  const unit = units.find((u: any) => display && text(u?.denom, 200) === display)
  if (unit) return decimalsOf(unit.exponent)
  // No display unit named: the largest exponent the chain lists is the display
  // unit by construction (the base unit is exponent 0).
  // deno-lint-ignore no-explicit-any
  const exponents = units.map((u: any) => decimalsOf(u?.exponent)).filter((e: number | null): e is number => e != null)
  return exponents.length ? Math.max(...exponents) : null
}
