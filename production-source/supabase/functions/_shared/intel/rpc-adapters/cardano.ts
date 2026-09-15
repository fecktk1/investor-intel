// Cardano native-asset metadata — Koios (public, keyless tier).
//
// Endpoints
//   POST https://api.koios.rest/api/v1/asset_info
//        { "_asset_list": [["<policy id hex>", "<asset name hex>"]] }
//        → [ { policy_id, asset_name, asset_name_ascii, fingerprint, total_supply,
//              token_registry_metadata: { name, description, ticker, url, logo,
//                                         decimals }, … } ]
//   POST https://api.koios.rest/api/v1/policy_asset_list
//        { "_asset_policy": "<policy id hex>" }
//        → [ { asset_name, fingerprint, total_supply, decimals }, … ]
//        Used when the pasted identifier is a bare policy id: a policy that
//        minted exactly one asset names it; two or more is a chooser, not a
//        guess.
//
// A Cardano asset has no on-chain name or ticker of its own — those live in the
// Cardano Token Registry, which Koios joins in as `token_registry_metadata`.
// When an asset is not registered, the hex asset name decoded to ASCII is the
// only honest symbol and `name` stays null.
//
// Terms: Koios is a community-run, free and keyless public API (an optional
// token raises the rate limit; the free tier does not need one), so this adapter
// is on by default. `CARDANO_RPC_URL` points the adapter at another
// Koios-compatible base (a self-hosted instance or a paid tier) without a code
// change; it is an override, not a switch — nothing here returns
// `no_rpc_adapter` when it is unset.
// One paste costs one call, or two for a bare policy id.

import { type AdapterContext, type RpcMetadata, hexToAscii, metadata, supplyOf, text } from './types.ts'

const KOIOS = 'https://api.koios.rest/api/v1'

export async function cardanoAdapter(ctx: AdapterContext): Promise<RpcMetadata | null> {
  const base = ctx.env?.('CARDANO_RPC_URL')?.replace(/\/+$/, '') || KOIOS
  const value = String(ctx.address || '').trim().toLowerCase()
  const parsed = /^([0-9a-f]{56})(?:\.([0-9a-f]{2,64}))?$/.exec(value)
  if (!parsed) return null

  const policy = parsed[1]
  let assetName = parsed[2] || ''

  if (!assetName) {
    const minted = await policyAssets(ctx, base, policy)
    if (!minted || minted.length !== 1) return null
    assetName = text((minted[0] as { asset_name?: unknown })?.asset_name, 64)?.toLowerCase() || ''
    if (!/^[0-9a-f]{2,64}$/.test(assetName)) return null
  }

  const info = await assetInfo(ctx, base, policy, assetName)
  if (!info) return null

  // deno-lint-ignore no-explicit-any
  const registry: any = info.token_registry_metadata || {}
  return metadata('cardano', {
    symbol: text(registry.ticker, 64) || hexToAscii(text(info.asset_name, 64) || assetName),
    name: registry.name,
    decimals: registry.decimals,
    totalSupply: supplyOf(info.total_supply),
  })
}

// deno-lint-ignore no-explicit-any
async function assetInfo(ctx: AdapterContext, base: string, policy: string, assetName: string): Promise<any | null> {
  const body = { _asset_list: [[policy, assetName]] }
  // deno-lint-ignore no-explicit-any
  const raw: any = await ctx.rpcCall(`${base}/asset_info`, body, ctx.timeoutMs)
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : null
  if (!rows?.length) return null
  // deno-lint-ignore no-explicit-any
  return rows.find((r: any) => String(r?.policy_id || '').toLowerCase() === policy) || null
}

async function policyAssets(ctx: AdapterContext, base: string, policy: string): Promise<unknown[] | null> {
  const body = { _asset_policy: policy }
  // deno-lint-ignore no-explicit-any
  const raw: any = await ctx.rpcCall(`${base}/policy_asset_list`, body, ctx.timeoutMs)
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : null
  return rows || null
}
