import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { tronAdapter, tronBase58ToHex } from './tron.ts'
import { abiString, abiUint, fakeRpc } from './test-support.ts'

// Tether USD on Tron. Its 21-byte hex form is published on every explorer, so
// it pins the base58check decoder rather than re-deriving it from our own code.
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c'

/** One TronGrid constant-call reply for a given return value. */
const constant = (hex: string) => ({ result: { result: true }, energy_used: 1000, constant_result: [hex] })

Deno.test('a Tron base58check address decodes to the 21-byte hex form', async () => {
  eq(await tronBase58ToHex(USDT_TRON), USDT_HEX)
  eq(await tronBase58ToHex('TF17BgPaZYbz8oxbjhriubPDsA7ArKoLX3'), '4137349aeb75a32f8c4c090daff376cf975f5d2eba')
})

Deno.test('a Tron address whose checksum fails never reaches the network', async () => {
  // Same address with the last base58 character changed: still the right shape,
  // wrong checksum.
  const rpc = fakeRpc([{ match: 'trongrid', reply: constant(abiString('WRONG')) }])
  eq(await tronBase58ToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u'), null)
  eq(await tronAdapter(rpc.context('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')), null)
  eq(rpc.calls.length, 0)
  // Shapes that are not Tron addresses at all are refused the same way.
  eq(await tronBase58ToHex('0xdac17f958d2ee523a2206206994597c13d831ec7'), null)
  eq(await tronBase58ToHex(''), null)
})

Deno.test('a TRC-20 answers name, symbol, decimals and supply through constant calls', async () => {
  const replies: Record<string, unknown> = {
    'name()': constant(abiString('Tether USD')),
    'symbol()': constant(abiString('USDT')),
    'decimals()': constant(abiUint(6)),
    'totalSupply()': constant(abiUint(1_000_000_000)),
  }
  const calls: unknown[] = []
  const ctx = {
    address: USDT_TRON,
    timeoutMs: 4000,
    rpcCall: (url: string, body: unknown) => {
      calls.push(body)
      eq(url, 'https://api.trongrid.io/wallet/triggerconstantcontract')
      const selector = String((body as { function_selector?: string })?.function_selector || '')
      return Promise.resolve(replies[selector] ?? { result: { result: false } })
    },
  }
  const meta = await tronAdapter(ctx)
  eq(meta, { symbol: 'USDT', name: 'Tether USD', decimals: 6, totalSupply: 1_000_000_000, source: 'rpc:tron' })
  eq(calls.length, 4)
  // Addresses go out in hex, so a mistyped address fails its checksum locally.
  eq((calls[0] as { contract_address: string }).contract_address, USDT_HEX)
  eq((calls[0] as { owner_address: string }).owner_address, USDT_HEX)
})

Deno.test('a Tron contract without the TRC-20 methods is a miss, not an error', async () => {
  const rpc = fakeRpc([{ match: 'trongrid', reply: { result: { result: false }, message: 'REVERT' } }])
  eq(await tronAdapter(rpc.context(USDT_TRON)), null)
  eq(rpc.calls.length, 4)
})

Deno.test('one failing Tron call does not lose the fields the others returned', async () => {
  const ctx = {
    address: USDT_TRON,
    timeoutMs: 4000,
    rpcCall: (_url: string, body: unknown) => {
      const selector = String((body as { function_selector?: string })?.function_selector || '')
      if (selector === 'name()') return Promise.reject(new Error('trongrid_timeout'))
      if (selector === 'symbol()') return Promise.resolve(constant(abiString('USDT')))
      if (selector === 'decimals()') return Promise.resolve(constant(abiUint(6)))
      return Promise.resolve({ result: { result: false } })
    },
  }
  const meta = await tronAdapter(ctx)
  eq(meta?.symbol, 'USDT')
  eq(meta?.name, null)
  eq(meta?.decimals, 6)
})

Deno.test('Tron honours a TRON_RPC_URL override', async () => {
  const rpc = fakeRpc([{ match: 'tron.internal/wallet/triggerconstantcontract', reply: constant(abiString('USDT')) }])
  const meta = await tronAdapter(rpc.context(USDT_TRON, { TRON_RPC_URL: 'https://tron.internal/' }))
  eq(meta?.symbol, 'USDT')
})
