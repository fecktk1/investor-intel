// Stellar issued-asset metadata — Horizon (SDF public instance).
//
// Endpoint
//   GET https://horizon.stellar.org/assets?asset_code=<CODE>&asset_issuer=<G…>&limit=1
//       → { _embedded: { records: [ { asset_type, asset_code, asset_issuer,
//             amount, num_accounts, balances: { authorized, … }, flags, … } ] } }
//
// Like XRPL, a Stellar asset is a code issued by an account, not a contract:
//   * symbol      the asset code exactly as issued.
//   * name        null. Horizon carries no name; the issuer's human name lives
//                 in its stellar.toml, which is a TOML document we do not follow
//                 (see the doc for why that is a later, separate source).
//   * decimals    7 — fixed by the protocol for every Stellar asset, so this is
//                 a chain fact rather than a claim about this token.
//   * totalSupply the issued amount Horizon reports.
//
// A bare G-address identifies a token only when the issuer has issued exactly
// one asset; two or more is a chooser, not a guess.
//
// Terms: SDF's Horizon is free and keyless, rate-limited per IP, and asks that
// heavy users run their own instance — `STELLAR_HORIZON_URL` points at one.
// One paste costs one call.

import { type AdapterContext, type RpcMetadata, metadata, supplyOf, text } from './types.ts'
import { parseStellarAsset } from '../asset-identifier.ts'

const HORIZON = 'https://horizon.stellar.org'
/** Every Stellar asset amount has seven decimal places (stroops). */
const STELLAR_DECIMALS = 7

export async function stellarAdapter(ctx: AdapterContext): Promise<RpcMetadata | null> {
  const base = ctx.env?.('STELLAR_HORIZON_URL')?.replace(/\/+$/, '') || HORIZON
  const value = String(ctx.address || '').trim()
  const asset = parseStellarAsset(value)

  if (asset) {
    const records = await assets(ctx, base, { asset_code: asset.code, asset_issuer: asset.issuer, limit: '1' })
    const record = records?.[0]
    if (!record) return null
    return describe(record)
  }

  if (!/^G[A-Z2-7]{55}$/.test(value)) return null
  const records = await assets(ctx, base, { asset_issuer: value, limit: '2' })
  if (!records || records.length !== 1) return null
  return describe(records[0])
}

// deno-lint-ignore no-explicit-any
function describe(record: any): RpcMetadata | null {
  const code = text(record?.asset_code, 64)
  // Without a code there is no asset — the fixed 7 decimals alone would be a
  // chain fact dressed up as an identity.
  if (!code) return null
  return metadata('stellar', {
    symbol: code,
    decimals: STELLAR_DECIMALS,
    totalSupply: supplyOf(record?.amount ?? record?.balances?.authorized),
  })
}

async function assets(ctx: AdapterContext, base: string, params: Record<string, string>): Promise<unknown[] | null> {
  const query = new URLSearchParams(params).toString()
  // deno-lint-ignore no-explicit-any
  const raw: any = await ctx.rpcCall(`${base}/assets?${query}`, null, ctx.timeoutMs)
  const records = raw?._embedded?.records
  return Array.isArray(records) ? records : null
}
