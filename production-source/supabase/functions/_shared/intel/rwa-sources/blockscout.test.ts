import { strict as assert } from 'node:assert'
import { concentration, concentrationScope, fetchAddressImplementation, fetchTokenSummary, fetchTopHolders, HOLDER_FIELDS_DROPPED, blockscoutExportAllowed } from './blockscout.ts'
import { __resetRwaSourceStateForTests } from './http.ts'
import { deps, fakeFetch } from './test-support.ts'

const BUIDL = '0x7712c34205737192402172409a8F7ccef8aA2AEc'
const TOKEN_URL = `https://eth.blockscout.com/api/v2/tokens/${BUIDL}`
// Reported total supply, probed 2026-09-16.
const TOTAL = 212143220660349n

const ADDRESS_URL = (a: string) => `https://eth.blockscout.com/api/v2/addresses/${a}`

Deno.test('a proxy implementation is resolved so the source is read where the logic lives', async () => {
  __resetRwaSourceStateForTests()
  // The shape probed 2026-09-16 for OUSG.
  const { impl } = fakeFetch({ [ADDRESS_URL(BUIDL)]: { body: { proxy_type: 'eip1967', implementations: [{ address_hash: '0x1CEB44b6E515aBf009E0CCb6ddaFD723886cf3Ff', name: 'CashKYCSenderReceiver' }] } } })
  const result = await fetchAddressImplementation('ethereum', BUIDL, deps(impl))
  assert.equal(result.state, 'resolved')
  assert.equal(result.proxyType, 'eip1967')
  assert.equal(result.implementation, '0x1ceb44b6e515abf009e0ccb6ddafd723886cf3ff')
  assert.equal(result.implementationName, 'CashKYCSenderReceiver')
})

Deno.test('a proxy with no readable implementation is unresolved, never treated as unrestricted', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [ADDRESS_URL(BUIDL)]: { body: { proxy_type: 'eip1967', implementations: [] } } })
  const result = await fetchAddressImplementation('ethereum', BUIDL, deps(impl))
  // Not having looked is not the same as having looked and found nothing.
  assert.equal(result.state, 'unresolved')
  assert.equal(result.implementation, null)
  assert.equal(result.reason, 'implementation_not_published')
  assert.notEqual(result.state, 'not_proxy')
})

Deno.test('a token that holds its own logic is reported as not a proxy', async () => {
  __resetRwaSourceStateForTests()
  // The shape probed 2026-09-16 for BUIDL, which is not a proxy.
  const { impl } = fakeFetch({ [ADDRESS_URL(BUIDL)]: { body: { proxy_type: null, implementations: [] } } })
  const result = await fetchAddressImplementation('ethereum', BUIDL, deps(impl))
  assert.equal(result.state, 'not_proxy')
  assert.equal(result.implementation, null)
  assert.equal(result.reason, null)
})

Deno.test('an unreachable explorer leaves proxy status unknown rather than assuming none', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [ADDRESS_URL(BUIDL)]: { status: 503, body: {} } })
  const unreachable = await fetchAddressImplementation('ethereum', BUIDL, deps(impl))
  assert.equal(unreachable.state, 'unavailable')
  assert.equal(unreachable.reason, 'http_503')

  const invalid = await fetchAddressImplementation('ethereum', 'not-an-address', deps(impl))
  assert.equal(invalid.state, 'unavailable')
  assert.equal(invalid.reason, 'invalid_contract_identity')
})

Deno.test('a top-one share reproduces the figure the explorer reports for a real token', () => {
  // The largest holder balance probed 2026-09-16 against a total supply of
  // 212143220660349, which the explorer renders as 25.82 percent.
  const result = concentration([{ address: '0x' + 'a'.repeat(40), value: 54777445540000n }], TOTAL, { tiers: [1] })
  assert.equal(Number(result.tiers[0].share!.toFixed(2)), 25.82)
})

Deno.test('a concentration figure of zero renders as zero rather than as a missing value', () => {
  const result = concentration([{ address: '0x' + 'b'.repeat(40), value: 0n }], TOTAL, { tiers: [1, 5] })
  // Zero is a measurement: the largest holder holds nothing.
  assert.equal(result.tiers[0].share, 0)
  assert.equal(result.tiers[1].share, 0)
  assert.notEqual(result.tiers[0].share, null)
  assert.equal(result.holdersRead, 1)
})

Deno.test('a share is withheld only when there is no denominator or no rows to measure', () => {
  const noSupply = concentration([{ address: '0x' + 'c'.repeat(40), value: 5n }], null, { tiers: [1] })
  assert.equal(noSupply.tiers[0].share, null)
  const zeroSupply = concentration([{ address: '0x' + 'c'.repeat(40), value: 5n }], 0n, { tiers: [1] })
  assert.equal(zeroSupply.tiers[0].share, null)
  const noRows = concentration([], TOTAL, { tiers: [1] })
  assert.equal(noRows.tiers[0].share, null)
})

Deno.test('wider tiers include narrower ones and a short page never inflates a share', () => {
  const holders = [10n, 8n, 6n, 4n, 2n].map((value, i) => ({ address: '0x' + String(i).repeat(40), value }))
  const result = concentration(holders, 100n, { tiers: [1, 5, 10] })
  assert.equal(result.tiers[0].share, 10)
  assert.equal(result.tiers[1].share, 30)
  // Only five rows exist, so top ten is the same measured five, not a guess.
  assert.equal(result.tiers[2].share, 30)
})

Deno.test('only an address and a balance survive the holder read, never a name or a tag', async () => {
  __resetRwaSourceStateForTests()
  const holder = {
    address: {
      hash: '0xEd71aa0dA4fdBA512FfA398fcFf9db8C49A5Cf72',
      ens_domain_name: 'whale.eth',
      name: 'Treasury Desk',
      public_tags: ['exchange'],
      private_tags: ['client'],
      watchlist_names: ['my watchlist'],
      metadata: { note: 'a person' },
      reputation: 'ok',
      is_contract: false,
    },
    value: '54777445540000',
  }
  const { impl } = fakeFetch({ [`${TOKEN_URL}/holders`]: { body: { items: [holder] } } })
  const result = await fetchTopHolders('ethereum', BUIDL, deps(impl))
  assert.equal(result.state, 'known')
  assert.equal(result.holders.length, 1)
  assert.equal(result.holders[0].address, '0xed71aa0da4fdba512ffa398fcff9db8c49a5cf72')
  assert.equal(result.holders[0].value, 54777445540000n)
  // Nothing that could name or characterise a party may survive.
  assert.deepEqual(Object.keys(result.holders[0]).sort(), ['address', 'value'])
  const serialized = JSON.stringify(result.holders, (_k, v) => (typeof v === 'bigint' ? String(v) : v))
  for (const field of HOLDER_FIELDS_DROPPED) assert.equal(serialized.includes(field), false)
  for (const leak of ['whale.eth', 'Treasury Desk', 'exchange', 'client', 'a person']) {
    assert.equal(serialized.includes(leak), false, `holder rows must not carry "${leak}"`)
  }
})

Deno.test('a reported holder count of zero is kept and a truncated page says so', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [TOKEN_URL]: { body: { holders_count: '0', total_supply: '0', decimals: '6', symbol: 'BUIDL', name: 'BlackRock USD Institutional Digital Liquidity Fund' } } })
  const summary = await fetchTokenSummary('ethereum', BUIDL, deps(impl))
  assert.equal(summary.state, 'known')
  assert.equal(summary.summary?.holdersCount, 0)
  assert.equal(summary.summary?.totalSupply, 0n)

  __resetRwaSourceStateForTests()
  const paged = fakeFetch({ [`${TOKEN_URL}/holders`]: { body: { items: [{ address: { hash: '0x' + 'd'.repeat(40) }, value: '1' }], next_page_params: { key: 1 } } } })
  const holders = await fetchTopHolders('ethereum', BUIDL, deps(paged.impl))
  assert.equal(holders.truncated, true)
  assert.match(concentrationScope(true), /not the whole holder base/)
})

Deno.test('a failed holder read states a reason instead of reporting an empty holder base', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [`${TOKEN_URL}/holders`]: { status: 500, body: {} } })
  const result = await fetchTopHolders('ethereum', BUIDL, deps(impl))
  assert.equal(result.state, 'unavailable')
  assert.equal(result.reason, 'http_500')
  assert.deepEqual(result.holders, [])

  const invalid = await fetchTopHolders('ethereum', 'not-an-address', deps(impl))
  assert.equal(invalid.reason, 'invalid_contract_identity')
})

Deno.test('concentration figures are display only because the explorer licence is unverified', () => {
  assert.equal(blockscoutExportAllowed(), false)
  assert.match(concentrationScope(false), /An address is not a person/)
  assert.match(concentrationScope(false), /redistribution terms could not be verified/)
  assert.match(concentrationScope(false), /does not establish control, coordination or risk/)
})
