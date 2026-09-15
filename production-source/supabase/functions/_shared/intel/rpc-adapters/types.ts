// Investor Intel — chain RPC metadata adapters: the shared contract.
//
// The resolver's ladder ends at the chain itself. EVM (eth_call multicall) and
// Solana (getAccountInfo) are decoded inline in asset-resolver.ts; every other
// namespace gets one adapter module in this folder.
//
// Rules every adapter keeps:
//   * It reaches the network ONLY through the injected `rpcCall(url, body, ms)`
//     seam, so a test never contacts a public endpoint. `body === null` is a
//     GET; anything else is a JSON POST.
//   * A "this identifier is not a token here" answer is `null`, never a throw.
//     A transport failure may throw: stepRpc turns it into
//     { outcome: 'error', detail } in the provenance, which is the honest
//     record that the chain was asked and did not answer.
//   * It never invents a field. A chain that has no on-ledger name returns
//     name: null, and the resolver then reports `identity_only` rather than
//     claiming a resolved market identity.
//   * Public, keyless endpoints only. Where a keyed endpoint would be better,
//     the URL is overridable through one documented environment variable and
//     the keyless default stays the shipped behaviour.

/** What an adapter can learn from the chain about one token. */
export type RpcMetadata = {
  symbol: string | null
  name: string | null
  decimals: number | null
  /** Whole units are NOT applied: this is the raw on-chain figure when the
   *  chain reports one, and null when it does not. */
  totalSupply?: number | null
  /** Always `rpc:<namespace>` — the provenance label for the source. */
  source: string
}

/** The single network seam. `body === null` means GET. */
export type RpcCall = (url: string, body: unknown, timeoutMs: number) => Promise<unknown>

export type AdapterContext = {
  /** The identifier exactly as the detector canonicalised it. */
  address: string
  rpcCall: RpcCall
  timeoutMs: number
  /** Reads an optional endpoint override. Never throws under a restricted
   *  permission set; an unset variable is undefined. */
  env?: (key: string) => string | undefined
}

export type RpcAdapter = (ctx: AdapterContext) => Promise<RpcMetadata | null>

// ── Shared decoding helpers ──────────────────────────────────────────────────

export const text = (value: unknown, max = 120): string | null => {
  const s = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
  return s ? s.slice(0, max) : null
}

export const numeric = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

/** A decimals field is only believable inside the range every chain uses. */
export const decimalsOf = (value: unknown): number | null => {
  const n = numeric(value)
  return n != null && Number.isInteger(n) && n >= 0 && n <= 36 ? n : null
}

/** A supply that survives as an exact JS number, or null. A figure larger than
 *  2^53-1 is dropped rather than rounded into a wrong number. */
export const supplyOf = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isSafeInteger(value) || Number.isFinite(value) ? value : null
  const s = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{1,30}(\.\d{1,18})?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : null
}

/** Strip control bytes and the replacement character from provider text. */
export const clean = (value: string | null): string | null => {
  if (!value) return null
  const trimmed = [...value].filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 65533).join('').trim()
  return trimmed ? trimmed.slice(0, 120) : null
}

export function bytesToUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

/** Standard or URL-safe base64 to bytes; null when the input is not base64. */
export function base64ToBytes(value: unknown): Uint8Array | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || !/^[A-Za-z0-9+/_=-]+$/.test(raw)) return null
  const normalized = raw.replaceAll('-', '+').replaceAll('_', '/')
  try {
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export function hexToBytes(value: unknown): Uint8Array | null {
  const raw = typeof value === 'string' ? value.trim().replace(/^0x/i, '') : ''
  if (!raw || raw.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) return null
  const out = new Uint8Array(raw.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Hex that encodes ASCII text (XRPL 40-character currency codes, Cardano
 *  asset names). Trailing NUL padding is dropped; a code that is not printable
 *  ASCII is not text and returns null rather than mojibake. */
export function hexToAscii(value: unknown): string | null {
  const bytes = hexToBytes(value)
  if (!bytes) return null
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  if (!end) return null
  let out = ''
  for (let i = 0; i < end; i++) {
    const code = bytes[i]
    if (code < 32 || code > 126) return null
    out += String.fromCharCode(code)
  }
  return clean(out)
}

/** The maximum size of an off-chain metadata document an adapter will read.
 *  Token metadata is a small JSON object; anything larger is not one. */
export const MAX_OFFCHAIN_BYTES = 4096

/** An off-chain metadata URI is only followed when it is plain HTTPS to a
 *  named host. IP literals, credentials, ports and non-HTTPS schemes (ipfs://,
 *  data:, http://, file://) are refused — an adapter must never be turned into
 *  a fetcher for an address the pasted identifier chose. */
export function safeMetadataUrl(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw.length > 500 || !/^https:\/\//i.test(raw)) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    const host = url.hostname.toLowerCase()
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.local') || host === 'localhost') return null
    return url.toString()
  } catch {
    return null
  }
}

/** True when a decoded off-chain document is inside the 4 KB budget. The
 *  transport bounds the bytes it reads; this bounds what an adapter accepts. */
export function withinOffchainBudget(payload: unknown): boolean {
  try {
    return JSON.stringify(payload ?? null).length <= MAX_OFFCHAIN_BYTES
  } catch {
    return false
  }
}

/** Assemble a result, or null when the chain told us nothing at all. */
export function metadata(
  namespace: string,
  fields: { symbol?: unknown; name?: unknown; decimals?: unknown; totalSupply?: unknown },
): RpcMetadata | null {
  const symbol = clean(text(fields.symbol, 64))
  const name = clean(text(fields.name, 160))
  const decimals = decimalsOf(fields.decimals)
  const totalSupply = supplyOf(fields.totalSupply)
  if (symbol == null && name == null && decimals == null && totalSupply == null) return null
  return { symbol, name, decimals, totalSupply, source: `rpc:${namespace}` }
}
