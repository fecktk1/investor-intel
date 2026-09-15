import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { CHAINS } from '../../chains.ts'
import { RPC_ADAPTERS, rpcAdapterFor } from './index.ts'

Deno.test('every long-tail namespace dispatches to its own adapter', () => {
  for (const namespace of ['ton', 'tron', 'xrpl', 'stellar', 'near', 'cardano', 'injective']) {
    eq(typeof rpcAdapterFor(namespace), 'function', `${namespace} has no adapter`)
  }
  eq(Object.keys(RPC_ADAPTERS).sort(), ['cardano', 'injective', 'near', 'stellar', 'ton', 'tron', 'xrpl'])
})

Deno.test('namespaces the resolver decodes itself, or cannot ask at all, have no adapter', () => {
  // eip155 and solana are decoded inline in asset-resolver.ts; the rest have no
  // metadata endpoint we have verified, and must stay `no_rpc_adapter`.
  for (const namespace of ['eip155', 'solana', 'sui', 'aptos', 'bip122', 'zcash', 'hyperliquid', 'sei', '', null, undefined]) {
    eq(rpcAdapterFor(namespace as string), null, `${namespace} unexpectedly has an adapter`)
  }
})

Deno.test('every adapter namespace is a namespace the chain registry carries', () => {
  const namespaces = new Set(CHAINS.map((c) => c.namespace))
  for (const namespace of Object.keys(RPC_ADAPTERS)) {
    eq(namespaces.has(namespace), true, `${namespace} is not in CHAINS`)
  }
})

Deno.test('Cardano is a registered chain with a policy-id address format', () => {
  const cardano = CHAINS.find((c) => c.id === 'cardano')
  eq(cardano?.namespace, 'cardano')
  eq(cardano?.label, 'Cardano')
  eq(cardano?.nativeSymbol, 'ADA')
  eq(cardano?.addressFormat, 'cardano_policy')
  // Consistent with the other chains that have no market provider yet.
  eq(cardano?.startingSupportLevel, 'coming_soon')
  eq(cardano?.explorerToken, 'https://cardanoscan.io/token/')
})
