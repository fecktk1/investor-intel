// Namespace → chain RPC metadata adapter.
//
// EVM (eip155) and Solana are decoded inline in asset-resolver.ts because they
// are the two namespaces the whole ladder is built around; every other
// namespace the identifier detector recognises gets an adapter here. A
// namespace with no entry is `no_rpc_adapter` — a skipped step with a reason,
// never a guessed identity.

import type { RpcAdapter } from './types.ts'
import { tonAdapter } from './ton.ts'
import { tronAdapter } from './tron.ts'
import { xrplAdapter } from './xrpl.ts'
import { stellarAdapter } from './stellar.ts'
import { nearAdapter } from './near.ts'
import { cardanoAdapter } from './cardano.ts'
import { injectiveAdapter } from './injective.ts'

export const RPC_ADAPTERS: Record<string, RpcAdapter> = {
  ton: tonAdapter,
  tron: tronAdapter,
  xrpl: xrplAdapter,
  stellar: stellarAdapter,
  near: nearAdapter,
  cardano: cardanoAdapter,
  injective: injectiveAdapter,
}

/** The adapter for a CAIP-2 namespace, or null when the chain cannot be asked. */
export function rpcAdapterFor(namespace: string | null | undefined): RpcAdapter | null {
  const key = String(namespace || '').trim().toLowerCase()
  return RPC_ADAPTERS[key] || null
}

export type { AdapterContext, RpcAdapter, RpcCall, RpcMetadata } from './types.ts'
