import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  parseScaledUiAccount, readScaledUiMultipliers, multiplierAt, reinvestingClass, ondoMintFor, resolveAccrual,
  ondoSolanaMultiplierSource, ONDO_GM_SOLANA_MINTS, ONDO_GM_MULTIPLIER_AUTHORITY, TOKEN_2022_PROGRAM_ID,
  ONDO_GM_ISSUER, BACKED_ISSUER, ACCRUAL_MAX_READS, type AccrualMultiplierSource, type MultiplierReading,
  XSTOCKS_SOLANA_MINTS, XSTOCKS_MULTIPLIER_AUTHORITY, xstockMintFor, multiplierTarget, solanaScaledUiMultiplierSource,
  ACCRUAL_SOURCES,
} from './accrual-multiplier.ts'
import { liveNavRpcCall, type NavRpc } from './chainlink-nav.ts'

// ─── Fixtures, shaped like the live answers ───────────────────────────────────
//
// `getAccountInfo` with `encoding: 'jsonParsed'` for the SPYon and NVDAon mints,
// trimmed to the fields the reader uses, with the values the chain returned on
// 2026-09-23 (publicnode, finalized). The extension list is in the chain's own
// order; the reader must find each one by name, not by position.

const SPYON_MINT = ONDO_GM_SOLANA_MINTS['38067'].mint
const NVDAON_MINT = ONDO_GM_SOLANA_MINTS['38093'].mint
const READ_AT = '2026-09-23T21:30:00.000Z'

function mintAccount(options: {
  mint: string; symbol: string; multiplier?: string | number; newMultiplier?: string | number; effectiveAt?: number
  owner?: string; authority?: string; scaled?: boolean
}) {
  const extensions: unknown[] = [
    { extension: 'metadataPointer', state: { authority: ONDO_GM_MULTIPLIER_AUTHORITY, metadataAddress: options.mint } },
    { extension: 'pausableConfig', state: { authority: ONDO_GM_MULTIPLIER_AUTHORITY, paused: false } },
    { extension: 'tokenMetadata', state: { additionalMetadata: [], mint: options.mint, name: `${options.symbol} (Ondo Tokenized)`, symbol: options.symbol, updateAuthority: ONDO_GM_MULTIPLIER_AUTHORITY, uri: `https://app.ondo.finance/api/v2/assets/${options.symbol}/sol_metadata.json` } },
  ]
  if (options.scaled !== false) {
    extensions.unshift({ extension: 'scaledUiAmountConfig', state: {
      authority: options.authority ?? ONDO_GM_MULTIPLIER_AUTHORITY,
      multiplier: options.multiplier ?? '1.0094730727840426',
      newMultiplier: options.newMultiplier ?? options.multiplier ?? '1.0094730727840426',
      newMultiplierEffectiveTimestamp: options.effectiveAt ?? 1789754055,
    } })
  }
  return {
    data: { parsed: { info: { decimals: 9, extensions, isInitialized: true, mintAuthority: ONDO_GM_MULTIPLIER_AUTHORITY }, type: 'mint' }, program: 'spl-token-2022', space: 648 },
    executable: false, lamports: 5400960, owner: options.owner ?? TOKEN_2022_PROGRAM_ID, space: 648,
  }
}
const SPYON = () => mintAccount({ mint: SPYON_MINT, symbol: 'SPYon' })
const NVDAON = () => mintAccount({ mint: NVDAON_MINT, symbol: 'NVDAon', multiplier: '1.0017152487959897', effectiveAt: 1788998645 })

// An xStocks mint as publicnode returned it on 2026-09-23 (jsonParsed, trimmed):
// eight extensions, the scaled-UI one fourth, its authority xStocks' own, the
// metadata under a different update authority, and the multiplier fields as
// strings with the effective time as a number.
const XSTOCK_METADATA_AUTHORITY = '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq'
function xstockAccount(options: {
  mint: string; symbol: string; multiplier: string; newMultiplier: string; effectiveAt: number; authority?: string
}) {
  return {
    data: { parsed: { info: { decimals: 8, extensions: [
      { extension: 'metadataPointer', state: { authority: XSTOCK_METADATA_AUTHORITY, metadataAddress: options.mint } },
      { extension: 'permanentDelegate', state: { delegate: XSTOCK_METADATA_AUTHORITY } },
      { extension: 'defaultAccountState', state: { accountState: 'initialized' } },
      { extension: 'scaledUiAmountConfig', state: {
        authority: options.authority ?? XSTOCKS_MULTIPLIER_AUTHORITY,
        multiplier: options.multiplier, newMultiplier: options.newMultiplier,
        newMultiplierEffectiveTimestamp: options.effectiveAt,
      } },
      { extension: 'pausableConfig', state: { authority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs', paused: false } },
      { extension: 'confidentialTransferMint', state: { auditorElgamalPubkey: null, authority: XSTOCK_METADATA_AUTHORITY, autoApproveNewAccounts: false } },
      { extension: 'transferHook', state: { authority: XSTOCK_METADATA_AUTHORITY, programId: null } },
      { extension: 'tokenMetadata', state: { additionalMetadata: [], mint: options.mint, name: `${options.symbol.slice(0, -1)} xStock`, symbol: options.symbol, updateAuthority: XSTOCK_METADATA_AUTHORITY, uri: `https://xstocks-metadata.backed.fi/tokens/Solana/${options.symbol}/metadata.json` } },
    ], isInitialized: true, mintAuthority: '7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj' }, type: 'mint' }, program: 'spl-token-2022', space: 676 },
    executable: false, lamports: 36662853, owner: TOKEN_2022_PROGRAM_ID, space: 676,
  }
}
const SPYX_MINT = XSTOCKS_SOLANA_MINTS['37006'].mint
const TQQQX_MINT = XSTOCKS_SOLANA_MINTS['37044'].mint
const TSLAX_MINT = XSTOCKS_SOLANA_MINTS['37004'].mint
// SPYx on 2026-09-23: 1.003909 until 2026-06-18 04:00 UTC, 1.005715 since.
const SPYX = () => xstockAccount({ mint: SPYX_MINT, symbol: 'SPYx', multiplier: '1.003909240011759', newMultiplier: '1.005714560286254', effectiveAt: 1781755200 })
// TQQQx after its split: 2.008976 until 2026-09-23 04:00 UTC, 2.011691 since.
const TQQQX = () => xstockAccount({ mint: TQQQX_MINT, symbol: 'TQQQx', multiplier: '2.008976295242212', newMultiplier: '2.0116905979372675', effectiveAt: 1790136000 })
// TSLAx: never updated, no dividend since launch.
const TSLAX = () => xstockAccount({ mint: TSLAX_MINT, symbol: 'TSLAx', multiplier: '1', newMultiplier: '1', effectiveAt: 0 })

/** A fake RPC answering a JSON-RPC batch of getAccountInfo from a map of mints. */
function fakeRpc(accounts: Record<string, unknown>, options: { throws?: string; errorFor?: string } = {}) {
  const calls: { url: string; body: unknown; timeoutMs: number }[] = []
  const rpcCall: NavRpc = (url, body, timeoutMs) => {
    calls.push({ url, body, timeoutMs })
    if (options.throws) return Promise.reject(new Error(options.throws))
    const batch = body as { id: number; method: string; params: [string, unknown] }[]
    return Promise.resolve(batch.map((request) => {
      const mint = request.params[0]
      if (mint === options.errorFor) return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Request blocked' } }
      return { jsonrpc: '2.0', id: request.id, result: { context: { slot: 449832346 }, value: accounts[mint] ?? null } }
    }))
  }
  return { rpcCall, calls }
}

// Observed at 20:45:01 UTC on 2026-09-23, the newest capture's quote clock.
const OBSERVED = Date.parse('2026-09-23T20:45:01.000Z')

// ─── Parsing and proving one mint ─────────────────────────────────────────────

Deno.test('the SPYon mint fixture reads as Ondo\'s multiplier, found by name not position', () => {
  const reading = parseScaledUiAccount(SPYON(), { mint: SPYON_MINT, symbol: 'SPYon' }, READ_AT)
  eq(reading.state, 'read')
  eq(reading.reason, null)
  eq(reading.onChainSymbol, 'SPYon')
  eq(reading.multiplier, 1.0094730727840426)
  eq(reading.newMultiplier, 1.0094730727840426)
  eq(reading.effectiveAt, 1789754055)
  eq(reading.readAt, READ_AT)
})

Deno.test('a mint that cannot prove it is the token is refused, never read', () => {
  const expect = { mint: SPYON_MINT, symbol: 'SPYon' }
  eq(parseScaledUiAccount(null, expect, READ_AT).reason, 'account_not_found')
  eq(parseScaledUiAccount(mintAccount({ mint: SPYON_MINT, symbol: 'SPYon', owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }), expect, READ_AT).reason, 'not_token_2022')
  // One character off in the metadata symbol is a different token.
  eq(parseScaledUiAccount(mintAccount({ mint: SPYON_MINT, symbol: 'SPYON' }), expect, READ_AT).reason, 'mint_identity_not_proved')
  eq(parseScaledUiAccount(mintAccount({ mint: NVDAON_MINT, symbol: 'SPYon' }), expect, READ_AT).reason, 'mint_identity_not_proved')
  eq(parseScaledUiAccount(mintAccount({ mint: SPYON_MINT, symbol: 'SPYon', scaled: false }), expect, READ_AT).reason, 'no_published_multiplier')
  const moved = parseScaledUiAccount(mintAccount({ mint: SPYON_MINT, symbol: 'SPYon', authority: '11111111111111111111111111111111' }), expect, READ_AT)
  eq(moved.reason, 'multiplier_authority_changed')
  eq(moved.state, 'refused')
  eq(moved.multiplier, null)
  eq(parseScaledUiAccount(mintAccount({ mint: SPYON_MINT, symbol: 'SPYon', multiplier: '0' }), expect, READ_AT).reason, 'multiplier_out_of_range')
  eq(parseScaledUiAccount(mintAccount({ mint: SPYON_MINT, symbol: 'SPYon', multiplier: 'NaN' }), expect, READ_AT).reason, 'multiplier_out_of_range')
  eq(parseScaledUiAccount(mintAccount({ mint: SPYON_MINT, symbol: 'SPYon', newMultiplier: '250' }), expect, READ_AT).reason, 'multiplier_out_of_range')
})

// ─── Reading over RPC ─────────────────────────────────────────────────────────

Deno.test('one HTTP request carries every mint as a batch of getAccountInfo', async () => {
  const rpc = fakeRpc({ [SPYON_MINT]: SPYON(), [NVDAON_MINT]: NVDAON() })
  const readings = await readScaledUiMultipliers(
    [{ mint: SPYON_MINT, symbol: 'SPYon' }, { mint: NVDAON_MINT, symbol: 'NVDAon' }, { mint: SPYON_MINT, symbol: 'SPYon' }, { mint: 'not-an-address', symbol: 'X' }],
    { rpcCall: rpc.rpcCall, readAt: READ_AT },
  )
  eq(rpc.calls.length, 1)
  const batch = rpc.calls[0].body as { method: string; params: [string, { encoding: string }] }[]
  // Deduplicated, and an unparseable address is never sent.
  eq(batch.length, 2)
  assert(batch.every((b) => b.method === 'getAccountInfo' && b.params[1].encoding === 'jsonParsed'))
  eq(rpc.calls[0].url, 'https://solana-rpc.publicnode.com')
  eq(readings.get(SPYON_MINT)?.newMultiplier, 1.0094730727840426)
  eq(readings.get(NVDAON_MINT)?.newMultiplier, 1.0017152487959897)
  eq(readings.has('not-an-address'), false)
})

Deno.test('a failed RPC read is a stated reason on every mint, never a multiplier of one', async () => {
  const thrown = await readScaledUiMultipliers([{ mint: SPYON_MINT, symbol: 'SPYon' }, { mint: NVDAON_MINT, symbol: 'NVDAon' }], { rpcCall: fakeRpc({}, { throws: 'rpc_http_503' }).rpcCall, readAt: READ_AT })
  for (const mint of [SPYON_MINT, NVDAON_MINT]) {
    const reading = thrown.get(mint)!
    eq(reading.state, 'unavailable')
    eq(reading.reason, 'multiplier_read_failed')
    eq(reading.detail, 'rpc_http_503')
    eq(reading.multiplier, null)
    eq(reading.newMultiplier, null)
  }
  // One mint answered with an error inside an otherwise good batch.
  const partial = await readScaledUiMultipliers([{ mint: SPYON_MINT, symbol: 'SPYon' }, { mint: NVDAON_MINT, symbol: 'NVDAon' }], { rpcCall: fakeRpc({ [SPYON_MINT]: SPYON(), [NVDAON_MINT]: NVDAON() }, { errorFor: NVDAON_MINT }).rpcCall, readAt: READ_AT })
  eq(partial.get(SPYON_MINT)?.state, 'read')
  eq(partial.get(NVDAON_MINT)?.state, 'unavailable')
  eq(partial.get(NVDAON_MINT)?.detail, 'Request blocked')
  // And what the lane makes of a failed read: not adjusted, with the reason.
  eq(multiplierAt(thrown.get(SPYON_MINT), OBSERVED), { multiplier: null, asOf: null, reason: 'multiplier_read_failed' })
})

Deno.test('the read is bounded', async () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const many = Array.from({ length: ACCRUAL_MAX_READS + 25 }, (_, i) => ({ mint: `${'1'.repeat(36)}${B58[Math.floor(i / 58)]}${B58[i % 58]}ondo`, symbol: `T${i}` }))
  const rpc = fakeRpc({})
  await readScaledUiMultipliers(many, { rpcCall: rpc.rpcCall, readAt: READ_AT })
  eq((rpc.calls[0].body as unknown[]).length, ACCRUAL_MAX_READS)
})

// ─── The multiplier in effect when the prices were observed ──────────────────

Deno.test('a multiplier is used only if it took effect before the wrapper prices were observed', () => {
  const spy = parseScaledUiAccount(SPYON(), { mint: SPYON_MINT, symbol: 'SPYon' }, READ_AT)
  // Effective 2026-09-18 17:54:15 UTC, observed 2026-09-23 20:45 UTC.
  eq(multiplierAt(spy, OBSERVED), { multiplier: 1.0094730727840426, asOf: '2026-09-18T17:54:15.000Z', reason: null })
  // Observed on the morning of the change: the value in effect then is not on chain.
  eq(multiplierAt(spy, Date.parse('2026-09-18T08:45:59.000Z')), { multiplier: null, asOf: null, reason: 'multiplier_changed_after_observation' })
  eq(multiplierAt(spy, NaN).reason, 'wrapper_observation_time_unknown')
  // Never updated since the mint was created (GOOGon on 2026-09-23): in effect at every observation, no date to state.
  const never = parseScaledUiAccount(mintAccount({ mint: SPYON_MINT, symbol: 'SPYon', multiplier: '1', effectiveAt: 0 }), { mint: SPYON_MINT, symbol: 'SPYon' }, READ_AT)
  eq(multiplierAt(never, OBSERVED), { multiplier: 1, asOf: null, reason: null })
  eq(multiplierAt(null, OBSERVED).reason, 'multiplier_read_failed')
})

// ─── Which wrappers reinvest into their price ────────────────────────────────

const ondo = (cryptoId: string, symbol: string, name: string) => ({ cryptoId, symbol, name, issuerId: ONDO_GM_ISSUER.id, issuerName: ONDO_GM_ISSUER.name })

Deno.test('the register: Ondo GM, xStocks and wrapped xStocks carry a multiplier; the rest do not', () => {
  eq(reinvestingClass(ondo('38067', 'SPYon', 'SPDR S&P 500 Tokenized ETF (Ondo)')), 'ondo_gm')
  eq(ondoMintFor({ cryptoId: '38067', symbol: 'SPYon' })?.mint, SPYON_MINT)
  // A repurposed id does not inherit the mint.
  eq(ondoMintFor({ cryptoId: '38067', symbol: 'SPYX' }), null)
  // An Ondo GM token the registry has not met is still found, and gets no mint.
  eq(reinvestingClass(ondo('99999', 'NEWon', 'New Company Tokenized Stock (Ondo)')), 'ondo_gm')
  eq(ondoMintFor({ cryptoId: '99999', symbol: 'NEWon' }), null)
  eq(reinvestingClass({ cryptoId: '41525', symbol: 'wSPYx', name: 'Wrapped SP500 Tokenized ETF (xStock)', issuerId: BACKED_ISSUER.id, issuerName: BACKED_ISSUER.name }), 'wrapped_xstock')
  // An xStock is in the register: its quote may include its multiplier, so it is read.
  eq(reinvestingClass({ cryptoId: '37006', symbol: 'SPYX', name: 'SP500 tokenized ETF (xStock)', issuerId: BACKED_ISSUER.id, issuerName: BACKED_ISSUER.name }), 'xstock')
  // Pays out.
  eq(reinvestingClass({ cryptoId: '40694', symbol: 'SPY', name: 'SPDR S&P 500 Trust Tokenized ETF (Robinhood)', issuerId: '6a465832fbe3004b1a0ea2dd', issuerName: 'Robinhood' }), null)
  eq(reinvestingClass({ cryptoId: '40790', symbol: 'SPYB', name: 'State Street SPDR S&P 500 ETF Tokenized bStocks', issuerId: '6a2aed5097c45356b1a5f710', issuerName: 'bStocks' }), null)
  // A name that merely mentions Ondo under another issuer is not Ondo GM.
  eq(reinvestingClass({ cryptoId: '1', symbol: 'Xon', name: 'Something (Ondo)', issuerId: 'other', issuerName: 'Other' }), null)
  // Every registry entry is a well-formed Solana address carrying Ondo's vanity suffix.
  for (const entry of Object.values(ONDO_GM_SOLANA_MINTS)) {
    assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(entry.mint), entry.symbol)
    assert(entry.mint.endsWith('ondo') && entry.symbol.endsWith('on'), entry.symbol)
  }
  eq(new Set(Object.values(ONDO_GM_SOLANA_MINTS).map((e) => e.mint)).size, Object.keys(ONDO_GM_SOLANA_MINTS).length)
})

// ─── Resolving a capture ──────────────────────────────────────────────────────

const SPY_ASSET = {
  rwaId: '86', observedAt: '2026-09-23T20:45:01.000Z',
  tokens: [
    ondo('38067', 'SPYon', 'SPDR S&P 500 Tokenized ETF (Ondo)'),
    { cryptoId: '41525', symbol: 'wSPYx', name: 'Wrapped SP500 Tokenized ETF (xStock)', issuerId: BACKED_ISSUER.id, issuerName: BACKED_ISSUER.name },
    { cryptoId: '40694', symbol: 'SPY', name: 'SPDR S&P 500 Trust Tokenized ETF (Robinhood)', issuerId: '6a465832fbe3004b1a0ea2dd', issuerName: 'Robinhood' },
    ondo('99999', 'NEWon', 'New Company Tokenized Stock (Ondo)'),
  ],
}

Deno.test('resolving a capture: adjusted where sourced, labelled with the reason everywhere else', async () => {
  const rpc = fakeRpc({ [SPYON_MINT]: SPYON(), [SPYX_MINT]: SPYX() })
  const result = await resolveAccrual([SPY_ASSET], ondoSolanaMultiplierSource({ rpcCall: rpc.rpcCall }), READ_AT)
  eq(result.reinvesting, 3)
  eq(result.adjusted, 2)
  eq(result.notAdjusted, 1)
  // The Ondo mint and the xStock mint behind wSPYx, in one request.
  eq(result.reads, 2)
  eq(rpc.calls.length, 1)
  const verdicts = result.verdicts.get('86')!
  const spy = verdicts.get('38067')!
  eq(spy.treatment, 'adjusted')
  eq(spy.multiplier, 1.0094730727840426)
  eq(spy.source, 'ondo_solana_scaled_ui')
  eq(spy.asOf, '2026-09-18T17:54:15.000Z')
  eq(spy.network, 'solana')
  eq(spy.address, SPYON_MINT)
  eq(spy.reason, null)
  // The wrapped xStock is divided by its xStock's multiplier, attributed to xStocks.
  eq(verdicts.get('41525'), { treatment: 'adjusted', reinvestingClass: 'wrapped_xstock', reason: null, multiplier: 1.005714560286254, source: 'xstocks_solana_scaled_ui', asOf: '2026-06-18T04:00:00.000Z', network: 'solana', address: SPYX_MINT, readAt: READ_AT })
  eq(verdicts.get('99999')?.reason, 'no_multiplier_address')
  // A wrapper that pays its dividends out gets no verdict at all.
  eq(verdicts.has('40694'), false)
})

Deno.test('a switched-off or failing read still labels every reinvesting wrapper, never adjusts one', async () => {
  const off = await resolveAccrual([SPY_ASSET], false, READ_AT)
  eq(off.adjusted, 0)
  eq(off.error, 'multiplier_step_off')
  eq(off.verdicts.get('86')!.get('38067')?.reason, 'multiplier_not_read')
  eq(off.verdicts.get('86')!.get('38067')?.multiplier, null)
  const failing: AccrualMultiplierSource = { id: 'ondo_solana_scaled_ui', network: 'solana', read: () => Promise.reject(new Error('boom')) }
  const failed = await resolveAccrual([SPY_ASSET], failing, READ_AT)
  eq(failed.error, 'boom')
  eq(failed.verdicts.get('86')!.get('38067')?.treatment, 'not_adjusted')
  eq(failed.verdicts.get('86')!.get('38067')?.reason, 'multiplier_read_failed')
  const down = await resolveAccrual([SPY_ASSET], ondoSolanaMultiplierSource({ rpcCall: fakeRpc({}, { throws: 'rpc_http_503' }).rpcCall }), READ_AT)
  eq(down.verdicts.get('86')!.get('38067')?.reason, 'multiplier_read_failed')
  // A stale observation clock: the multiplier moved after the prices were seen.
  const early = await resolveAccrual([{ ...SPY_ASSET, observedAt: '2026-09-18T08:45:59.000Z' }], ondoSolanaMultiplierSource({ rpcCall: fakeRpc({ [SPYON_MINT]: SPYON() }).rpcCall }), READ_AT)
  eq(early.verdicts.get('86')!.get('38067')?.reason, 'multiplier_changed_after_observation')
})

// ─── xStocks ──────────────────────────────────────────────────────────────────

const backed = (cryptoId: string, symbol: string, name: string) => ({ cryptoId, symbol, name, issuerId: BACKED_ISSUER.id, issuerName: BACKED_ISSUER.name })
const XSTOCK_EXPECT = (mint: string, symbol: string) => ({ mint, symbol, authority: XSTOCKS_MULTIPLIER_AUTHORITY })

Deno.test('an xStocks mint reads under xStocks\' own authority, found by name not position', () => {
  const reading = parseScaledUiAccount(SPYX(), XSTOCK_EXPECT(SPYX_MINT, 'SPYx'), READ_AT)
  eq(reading.state, 'read')
  eq(reading.onChainSymbol, 'SPYx')
  eq(reading.multiplier, 1.003909240011759)
  eq(reading.newMultiplier, 1.005714560286254)
  eq(reading.effectiveAt, 1781755200)
  // The authority gate is per issuer: the same mint proved against Ondo's is refused,
  // and an xStock whose multiplier authority moved supplies no factor.
  eq(parseScaledUiAccount(SPYX(), { mint: SPYX_MINT, symbol: 'SPYx' }, READ_AT).reason, 'multiplier_authority_changed')
  eq(parseScaledUiAccount(xstockAccount({ mint: SPYX_MINT, symbol: 'SPYx', multiplier: '1', newMultiplier: '1', effectiveAt: 0, authority: ONDO_GM_MULTIPLIER_AUTHORITY }), XSTOCK_EXPECT(SPYX_MINT, 'SPYx'), READ_AT).reason, 'multiplier_authority_changed')
  // CoinMarketCap's symbol (SPYX) is not the mint's (SPYx): the register proves the mint's own.
  eq(parseScaledUiAccount(SPYX(), XSTOCK_EXPECT(SPYX_MINT, 'SPYX'), READ_AT).reason, 'mint_identity_not_proved')
  eq(multiplierTarget({ cryptoId: '37006', symbol: 'SPYX' }, 'xstock')?.request, XSTOCK_EXPECT(SPYX_MINT, 'SPYx'))
})

Deno.test('a pending xStocks multiplier with a future effective time is not applied to an earlier quote', () => {
  // Read at 03:00 UTC on 2026-09-23, an hour before TQQQx's next multiplier takes effect.
  const pending = parseScaledUiAccount(TQQQX(), XSTOCK_EXPECT(TQQQX_MINT, 'TQQQx'), '2026-09-23T03:00:00.000Z')
  eq(pending.state, 'read')
  eq(pending.multiplier, 2.008976295242212)
  eq(pending.newMultiplier, 2.0116905979372675)
  // The 02:45 quote: the value in effect now is on chain, but not since when, so it is not proved for 02:45.
  eq(multiplierAt(pending, Date.parse('2026-09-23T02:45:59.000Z')), { multiplier: null, asOf: null, reason: 'multiplier_update_pending' })
  // Read after the activation, the same quote is refused for the other reason.
  const later = parseScaledUiAccount(TQQQX(), XSTOCK_EXPECT(TQQQX_MINT, 'TQQQx'), READ_AT)
  eq(multiplierAt(later, Date.parse('2026-09-23T02:45:59.000Z')).reason, 'multiplier_changed_after_observation')
  // A quote after the activation takes the new value, dated.
  eq(multiplierAt(later, OBSERVED), { multiplier: 2.0116905979372675, asOf: '2026-09-23T04:00:00.000Z', reason: null })
})

Deno.test('xStocks: a wrapped xStock is divided, an xStock at exactly 1 is compared as it stands, any other xStock is labelled', async () => {
  const qqqAsset = { rwaId: '118', observedAt: '2026-09-23T20:45:01.000Z', tokens: [
    backed('37044', 'TQQQX', 'TQQQ tokenized ETF (xStock)'),
    backed('41573', 'wTQQQx', 'Wrapped TQQQ Tokenized ETF (xStock)'),
  ] }
  const assets = [
    { rwaId: '86', observedAt: '2026-09-23T20:45:01.000Z', tokens: [
      backed('37006', 'SPYX', 'SP500 tokenized ETF (xStock)'),
      backed('41525', 'wSPYx', 'Wrapped SP500 Tokenized ETF (xStock)'),
      { cryptoId: '40790', symbol: 'SPYB', name: 'State Street SPDR S&P 500 ETF Tokenized bStocks', issuerId: '6a2aed5097c45356b1a5f710', issuerName: 'bStocks' },
    ] },
    { rwaId: '20', observedAt: '2026-09-23T20:45:01.000Z', tokens: [
      backed('37004', 'TSLAX', 'Tesla tokenized stock (xStock)'),
      backed('37227', 'WTSLAX', 'Wrapped Tesla Tokenized stock (xStock)'),
      // Not in the register: no mint to read, so labelled rather than assumed to be 1.
      backed('99998', 'NEWx', 'New Company tokenized stock (xStock)'),
    ] },
    qqqAsset,
  ]
  const rpc = fakeRpc({ [SPYX_MINT]: SPYX(), [TSLAX_MINT]: TSLAX(), [TQQQX_MINT]: TQQQX() })
  const result = await resolveAccrual(assets, solanaScaledUiMultiplierSource({ rpcCall: rpc.rpcCall }), READ_AT)
  // Three mints for six registered tokens: a wrapped xStock reads its xStock's mint.
  eq(result.reads, 3)
  eq(rpc.calls.length, 1)
  const spy = result.verdicts.get('86')!
  // SPYX: the multiplier is proved, above 1, and not divided: its quote's unit is mixed.
  eq(spy.get('37006'), { treatment: 'not_adjusted', reinvestingClass: 'xstock', reason: 'quote_unit_mixed', multiplier: null, source: null, asOf: null, network: 'solana', address: SPYX_MINT, readAt: READ_AT })
  eq(spy.get('41525')?.treatment, 'adjusted')
  eq(spy.get('41525')?.multiplier, 1.005714560286254)
  // bStocks are not read: no verdict at all.
  eq(spy.has('40790'), false)
  const tsla = result.verdicts.get('20')!
  // TSLAX at exactly 1 since launch: per share on every venue, a sourced x1 with no date.
  eq(tsla.get('37004'), { treatment: 'adjusted', reinvestingClass: 'xstock', reason: null, multiplier: 1, source: 'xstocks_solana_scaled_ui', asOf: null, network: 'solana', address: TSLAX_MINT, readAt: READ_AT })
  eq(tsla.get('37227')?.treatment, 'adjusted')
  eq(tsla.get('37227')?.multiplier, 1)
  eq(tsla.get('99998')?.reason, 'no_multiplier_address')
  eq(tsla.get('99998')?.reinvestingClass, 'xstock')
  // A repurposed id does not inherit the mint: the symbol must still match.
  eq(xstockMintFor({ cryptoId: '37004', symbol: 'TSLAB' }), null)
  eq(multiplierTarget({ cryptoId: '37004', symbol: 'TSLAB' }, 'xstock'), null)
  // TQQQX: 2.0117 after a split, and its quote is per share; labelled, never divided.
  const tqqq = result.verdicts.get('118')!
  eq(tqqq.get('37044')?.reason, 'quote_unit_mixed')
  eq(tqqq.get('37044')?.multiplier, null)
  eq(tqqq.get('41573')?.multiplier, 2.0116905979372675)
  eq(tqqq.get('41573')?.source, 'xstocks_solana_scaled_ui')
})

Deno.test('xStocks: a failed read labels every xStock, including one whose multiplier is 1, and never adjusts one', async () => {
  const assets = [{ rwaId: '20', observedAt: '2026-09-23T20:45:01.000Z', tokens: [
    backed('37004', 'TSLAX', 'Tesla tokenized stock (xStock)'),
    backed('37227', 'WTSLAX', 'Wrapped Tesla Tokenized stock (xStock)'),
  ] }]
  const down = await resolveAccrual(assets, solanaScaledUiMultiplierSource({ rpcCall: fakeRpc({}, { throws: 'rpc_http_503' }).rpcCall }), READ_AT)
  eq(down.adjusted, 0)
  for (const id of ['37004', '37227']) {
    const verdict = down.verdicts.get('20')!.get(id)!
    eq(verdict.treatment, 'not_adjusted')
    eq(verdict.reason, 'multiplier_read_failed')
    eq(verdict.multiplier, null)
    eq(verdict.address, TSLAX_MINT)
  }
  // One mint missing from an otherwise good answer is a stated reason too.
  const missing = await resolveAccrual(assets, solanaScaledUiMultiplierSource({ rpcCall: fakeRpc({}).rpcCall }), READ_AT)
  eq(missing.verdicts.get('20')!.get('37004')?.reason, 'account_not_found')
  const off = await resolveAccrual(assets, false, READ_AT)
  eq(off.verdicts.get('20')!.get('37004')?.reason, 'multiplier_not_read')
})

Deno.test('the xStocks register: well-formed, one mint per xStock, and a wrapped xStock shares its xStock\'s mint', () => {
  const entries = Object.entries(XSTOCKS_SOLANA_MINTS)
  eq(entries.length, 75)
  const byXstock = new Map<string, string>()
  for (const [id, entry] of entries) {
    assert(/^[1-9][0-9]*$/.test(id), id)
    assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(entry.mint) && entry.mint.startsWith('Xs'), entry.symbol)
    assert(entry.xstock.endsWith('x'), entry.xstock)
    // CoinMarketCap's symbol is the xStock's in some case, with a leading w for the wrapped one.
    eq((entry.wrapped ? entry.symbol.replace(/^w/i, '') : entry.symbol).toUpperCase(), entry.xstock.toUpperCase(), entry.symbol)
    const seen = byXstock.get(entry.xstock)
    if (seen) eq(seen, entry.mint, entry.xstock)
    else byXstock.set(entry.xstock, entry.mint)
    eq(reinvestingClass({ cryptoId: id, symbol: entry.symbol, name: null, issuerId: null, issuerName: null }), entry.wrapped ? 'wrapped_xstock' : 'xstock')
  }
  eq(byXstock.size, 42)
  eq(new Set(byXstock.values()).size, 42)
  // No mint belongs to both issuers.
  const ondo = new Set(Object.values(ONDO_GM_SOLANA_MINTS).map((e) => e.mint))
  assert([...byXstock.values()].every((mint) => !ondo.has(mint)))
  // Every registered mint of both issuers fits one bounded read.
  assert(byXstock.size + ondo.size <= ACCRUAL_MAX_READS)
})

Deno.test('every multiplier source the lane can write is allowed by the newest schema', async () => {
  const sql = await Deno.readTextFile(new URL('../../../migrations/20260924000000_intel_rwa_wrapper_xstocks_multiplier.sql', import.meta.url))
  const allowed = sql.match(/accrual_multiplier_source IN \(([^)]*)\)/)?.[1] ?? ''
  eq(allowed.split(',').map((v) => v.trim().replace(/'/g, '')).sort(), [...ACCRUAL_SOURCES].sort())
})

// ─── Live (skipped by default) ───────────────────────────────────────────────

/** INTEL_LIVE_RPC=1 re-proves the SPYon and NVDAon mints on chain and checks the
 * Solana multiplier against Ondo's Ethereum SyntheticSharesOracle where that
 * oracle carries the token (SPYon; NVDAon reverts AssetNotFound there). */
Deno.test({
  name: 'live: SPYon and NVDAon publish a multiplier on chain, equal to the Ethereum sValue where both exist',
  ignore: Deno.env.get('INTEL_LIVE_RPC') !== '1',
  async fn() {
    const readings = await readScaledUiMultipliers([
      { mint: SPYON_MINT, symbol: 'SPYon' },
      { mint: NVDAON_MINT, symbol: 'NVDAon' },
    ], { readAt: new Date().toISOString() })
    for (const mint of [SPYON_MINT, NVDAON_MINT]) {
      const reading = readings.get(mint) as MultiplierReading
      eq(reading.state, 'read', `${mint}: ${reading.reason} ${reading.detail}`)
      assert(reading.newMultiplier! >= 1 && reading.newMultiplier! < 1.2)
      const at = multiplierAt(reading, Date.now())
      eq(at.reason, null)
    }
    // Ethereum SyntheticSharesOracle.getSValue(SPYon), 18 decimals.
    const oracle = '0x9bc39db6fbb44b91a48b8d5a6c208b82b1741be6'
    const spyonEth = 'fedc5f4a6c38211c1338aa411018dfaf26612c08'
    // deno-lint-ignore no-explicit-any
    const answer = await liveNavRpcCall('https://ethereum-rpc.publicnode.com', { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: oracle, data: '0x0a562827' + spyonEth.padStart(64, '0') }, 'latest'] }, 8000) as any
    const sValue = Number(BigInt('0x' + String(answer.result).slice(2, 66))) / 1e18
    assert(Math.abs(sValue - readings.get(SPYON_MINT)!.newMultiplier!) < 1e-12, `eth ${sValue} vs solana ${readings.get(SPYON_MINT)!.newMultiplier}`)
  },
})

/** INTEL_LIVE_RPC=1 re-proves the SPYx and TQQQx mints under xStocks' authority,
 * and checks that the wSPYx vault on Ethereum is worth exactly SPYx's Solana
 * multiplier in SPYx (`convertToAssets(1e18)`), which is why a wrapped xStock is
 * divided by it. */
Deno.test({
  name: 'live: xStocks mints publish a multiplier on chain, equal to the wrapped vault\'s convertToAssets rate',
  ignore: Deno.env.get('INTEL_LIVE_RPC') !== '1',
  async fn() {
    const readings = await readScaledUiMultipliers([
      XSTOCK_EXPECT(SPYX_MINT, 'SPYx'),
      XSTOCK_EXPECT(TQQQX_MINT, 'TQQQx'),
    ], { readAt: new Date().toISOString() })
    for (const mint of [SPYX_MINT, TQQQX_MINT]) {
      const reading = readings.get(mint) as MultiplierReading
      eq(reading.state, 'read', `${mint}: ${reading.reason} ${reading.detail}`)
      assert(reading.newMultiplier! >= 1 && reading.newMultiplier! < 10)
    }
    const spyx = readings.get(SPYX_MINT)!
    const now = multiplierAt(spyx, Date.now())
    // Pending at this moment is a stated reason, not a failure of the check.
    if (now.reason === 'multiplier_update_pending') return
    eq(now.reason, null)
    // wSPYx (the issuer API's wrapperAddressV2 on Ethereum): convertToAssets(1e18).
    const vault = '0xe7e553cd128f0011777323a0b44a7b96ea1cb540'
    // deno-lint-ignore no-explicit-any
    const answer = await liveNavRpcCall('https://ethereum-rpc.publicnode.com', { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: vault, data: '0x07a2d13a' + (10n ** 18n).toString(16).padStart(64, '0') }, 'latest'] }, 8000) as any
    const rate = Number(BigInt('0x' + String(answer.result).slice(2, 66))) / 1e18
    assert(Math.abs(rate - now.multiplier!) < 1e-12, `vault ${rate} vs solana ${now.multiplier}`)
  },
})
