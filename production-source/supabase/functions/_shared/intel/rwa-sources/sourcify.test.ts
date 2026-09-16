import { strict as assert } from 'node:assert'
import { detectRestrictions, fetchContractAbi } from './sourcify.ts'
import { __resetRwaSourceStateForTests } from './http.ts'
import { deps, fakeFetch } from './test-support.ts'

// The member names probed 2026-09-16 on the OUSG implementation
// 0x1CEB44b6E515aBf009E0CCb6ddaFD723886cf3Ff (CashKYCSenderReceiver).
const OUSG_IMPLEMENTATION_ABI = [
  'kycRegistry', 'setKYCRegistry', 'kycRequirementGroup', 'setKYCRequirementGroup', 'KYC_CONFIGURER_ROLE',
  'KYCRegistrySet', 'KYCRequirementGroupSet', 'pause', 'unpause', 'paused', 'PAUSER_ROLE',
  'MINTER_ROLE', 'BURNER_ROLE', 'grantRole', 'revokeRole', 'hasRole', 'transfer', 'balanceOf',
].map((name) => ({ type: 'function', name }))

// What the PROXY's own verified source exposes. No transfer logic at all.
const PROXY_ABI = [
  { type: 'constructor', inputs: [{ name: '_logic', type: 'address' }, { name: '_admin', type: 'address' }] },
  { type: 'event', name: 'AdminChanged' },
  { type: 'event', name: 'Upgraded' },
  { type: 'function', name: 'admin' },
]

const IMPL = '0x1CEB44b6E515aBf009E0CCb6ddaFD723886cf3Ff'
const url = (address: string) => `https://sourcify.dev/server/v2/contract/1/${address}?fields=abi`

Deno.test('verified source proves a token requires KYC and can be paused', () => {
  const result = detectRestrictions(OUSG_IMPLEMENTATION_ABI)
  assert.equal(result.state, 'restricted')
  assert.equal(result.kycGated, true)
  assert.equal(result.pausable, true)
  // No freeze or blocklist member is present on this implementation, and one is
  // not invented to round out the picture.
  assert.equal(result.freezable, false)
  const kyc = result.findings.find((f) => f.capability === 'kyc')!
  assert.ok(kyc.members.includes('kycRegistry'))
  assert.ok(kyc.members.includes('setKYCRegistry'))
  assert.ok(kyc.members.includes('KYC_CONFIGURER_ROLE'))
})

Deno.test('a restriction finding describes code and never claims a restriction was applied', () => {
  const result = detectRestrictions(OUSG_IMPLEMENTATION_ABI)
  assert.match(result.scope, /describes what the CODE is able to do/)
  assert.match(result.scope, /does not establish that any restriction has been applied/)
  assert.match(result.scope, /not legal or investment advice/)
})

Deno.test('a proxy shell is reported as such rather than as an unrestricted token', () => {
  const result = detectRestrictions(PROXY_ABI)
  // Reporting "no restriction found" here would be a false negative on exactly
  // the tokens that are most restricted.
  assert.equal(result.state, 'proxy_abi_only')
  assert.equal(result.kycGated, false)
  assert.match(result.scope, /restrictions of the token live in its implementation/)
})

Deno.test('an unverified contract is unknown, and unknown is not the same as unrestricted', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [url('0x1111111111111111111111111111111111111111')]: { status: 404, body: { match: null } } })
  const read = await fetchContractAbi(1, '0x1111111111111111111111111111111111111111', deps(impl))
  assert.equal(read.state, 'not_verified')
  assert.equal(read.reason, null)

  const result = detectRestrictions(null)
  assert.equal(result.state, 'unknown')
  assert.match(result.scope, /Unknown is not the same as unrestricted/)
})

Deno.test('an ordinary token with no restriction members is reported as none found', () => {
  const plain = ['transfer', 'transferFrom', 'approve', 'balanceOf', 'totalSupply'].map((name) => ({ type: 'function', name }))
  const result = detectRestrictions(plain)
  assert.equal(result.state, 'no_restriction_found')
  assert.equal(result.kycGated, false)
  assert.equal(result.pausable, false)
})

Deno.test('a verified ABI is read from the implementation and a bad identity never reaches the network', async () => {
  __resetRwaSourceStateForTests()
  const { impl, calls } = fakeFetch({ [url(IMPL)]: { body: { abi: OUSG_IMPLEMENTATION_ABI } } })
  const read = await fetchContractAbi(1, IMPL, deps(impl))
  assert.equal(read.state, 'known')
  assert.equal(read.abi?.length, OUSG_IMPLEMENTATION_ABI.length)

  const bad = await fetchContractAbi(1, 'nope', deps(impl))
  assert.equal(bad.reason, 'invalid_contract_identity')
  assert.equal(calls.length, 1)
})
