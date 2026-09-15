// Test-only helpers for the chain RPC adapters. Nothing in the function tree
// imports this module: it exists so each adapter test can state its fixtures as
// "this URL answers with this body" and then assert what was actually asked.

import type { AdapterContext, RpcCall } from './types.ts'

export type Route = {
  /** Substring of the URL this route answers for. */
  match: string
  /** The parsed JSON body, or an Error to reject with (a transport failure). */
  reply: unknown
}

export type FakeRpc = {
  rpcCall: RpcCall
  calls: { url: string; body: unknown }[]
  context: (address: string, env?: Record<string, string>) => AdapterContext
}

/** A recording fake for the single network seam. A URL no route matches is a
 *  rejection: a test that reaches an unexpected endpoint fails loudly rather
 *  than quietly returning undefined. */
export function fakeRpc(routes: Route[]): FakeRpc {
  const calls: { url: string; body: unknown }[] = []
  const rpcCall: RpcCall = (url, body) => {
    calls.push({ url, body })
    const route = routes.find((r) => url.includes(r.match))
    if (!route) return Promise.reject(new Error(`unexpected_url:${url}`))
    if (route.reply instanceof Error) return Promise.reject(route.reply)
    return Promise.resolve(route.reply)
  }
  return {
    rpcCall,
    calls,
    context: (address, env) => ({
      address,
      rpcCall,
      timeoutMs: 4000,
      env: (key: string) => env?.[key],
    }),
  }
}

/** ASCII → hex, right-padded to a 32-byte ABI word. */
export function abiWord(value: string): string {
  const hex = [...value].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return hex.padEnd(64, '0')
}

/** The ABI encoding of a dynamic string return value, without the 0x prefix. */
export function abiString(value: string): string {
  const length = value.length.toString(16).padStart(64, '0')
  return '0'.repeat(62) + '20' + length + abiWord(value)
}

/** A uint256 return value, without the 0x prefix. */
export function abiUint(value: number): string {
  return value.toString(16).padStart(64, '0')
}

/** Bytes of a UTF-8 string as the byte array NEAR's JSON-RPC returns. */
export function utf8Bytes(value: string): number[] {
  return [...new TextEncoder().encode(value)]
}

/** Base64 of a UTF-8 string — stands in for a BOC whose body is plain ASCII. */
export function base64(value: string): string {
  return btoa(value)
}
