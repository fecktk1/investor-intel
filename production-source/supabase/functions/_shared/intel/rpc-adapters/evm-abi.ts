// Minimal ABI return decoding, shared by the EVM rung of the resolver ladder
// and by the Tron adapter (TRC-20 returns are ABI-encoded exactly like ERC-20).
//
// Moved out of asset-resolver.ts unchanged so an adapter can use it without
// importing the resolver back. asset-resolver.ts re-exports both functions, so
// the public surface (and its tests) is unchanged.

/** A dynamic string, or the bytes32 form older tokens use. */
export function decodeAbiString(result: unknown): string | null {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) return null
  const hex = result.slice(2)
  if (!hex.length) return null
  const bytes = (slice: string) => {
    const out: number[] = []
    for (let i = 0; i + 1 < slice.length; i += 2) out.push(parseInt(slice.slice(i, i + 2), 16))
    return new Uint8Array(out)
  }
  const clean = (value: string) => {
    const trimmed = [...value].filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 65533).join('').trim()
    return trimmed ? trimmed.slice(0, 120) : null
  }
  if (hex.length === 64) return clean(new TextDecoder().decode(bytes(hex)))
  if (hex.length < 128) return null
  const offset = Number(BigInt('0x' + hex.slice(0, 64)))
  if (!Number.isFinite(offset) || offset * 2 + 64 > hex.length) return null
  const length = Number(BigInt('0x' + hex.slice(offset * 2, offset * 2 + 64)))
  if (!Number.isFinite(length) || length > 1024) return null
  return clean(new TextDecoder().decode(bytes(hex.slice(offset * 2 + 64, offset * 2 + 64 + length * 2))))
}

export function decodeAbiUint(result: unknown): number | null {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) return null
  try {
    const value = BigInt(result)
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
  } catch { return null }
}
