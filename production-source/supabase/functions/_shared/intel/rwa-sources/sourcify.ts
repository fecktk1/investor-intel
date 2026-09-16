// Investor Intel: transfer restrictions read from VERIFIED contract source.
//
// This is the admission fact no registry states. A curated registry can tell
// you an issuer says the token is restricted; verified source tells you the
// token's own code CAN restrict it, and who may pull the lever.
//
// VERIFIED 2026-09-16, OUSG 0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92:
//   The token is an eip1967 proxy. Its implementation is
//   0x1CEB44b6E515aBf009E0CCb6ddaFD723886cf3Ff, named CashKYCSenderReceiver,
//   whose 49-entry ABI carries kycRegistry, setKYCRegistry, kycRequirementGroup,
//   setKYCRequirementGroup, KYC_CONFIGURER_ROLE, pause, unpause, paused,
//   PAUSER_ROLE, MINTER_ROLE and BURNER_ROLE.
//   That is on-chain evidence that holding the token requires passing a KYC
//   registry, and that transfers can be halted.
//
// A PROXY'S OWN ABI IS NOT THE ANSWER. Reading the proxy returns
// constructor(_logic,_admin,_data) and AdminChanged, which says nothing about
// transfer restrictions. The caller must resolve the implementation first (the
// Blockscout address payload reports it) and read THAT. `detectRestrictions`
// reports `proxy_abi_only` when it is handed a proxy shell, so a proxy can
// never be mistaken for an unrestricted token.
//
// Endpoint: https://sourcify.dev/server/v2/contract/{chainId}/{address}?fields=abi
// A contract with no verified source answers 404 with a body whose `match` is
// null (probed 2026-09-16). That is a REAL answer, `not_verified`, and it is
// not the same as "unrestricted": unverified source means we cannot tell.

import { fetchSource, type SourceDeps } from './http.ts'

export interface AbiResult {
  state: 'known' | 'not_verified' | 'unavailable'
  // deno-lint-ignore no-explicit-any
  abi: any[] | null
  reason: string | null
  fetchedAt: string
  sourceUrl: string
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

export const sourcifyContractUrl = (chainId: number, address: string): string =>
  `https://sourcify.dev/server/v2/contract/${chainId}/${address}`

export async function fetchContractAbi(chainId: unknown, address: unknown, deps: SourceDeps = {}): Promise<AbiResult> {
  const chain = Number(chainId)
  const addr = String(address ?? '').trim()
  const fetchedAt = new Date((deps.now ?? Date.now)()).toISOString()
  if (!Number.isInteger(chain) || chain <= 0 || !EVM_ADDRESS.test(addr)) {
    return { state: 'unavailable', abi: null, reason: 'invalid_contract_identity', fetchedAt, sourceUrl: 'https://sourcify.dev/' }
  }
  const url = `${sourcifyContractUrl(chain, addr)}?fields=abi`
  // deno-lint-ignore no-explicit-any
  const response = await fetchSource<any>('sourcify', url, deps)
  if (!response.ok) {
    // 404 means Sourcify holds no verified source. A real answer, not a failure.
    const missing = response.status === 404
    return { state: missing ? 'not_verified' : 'unavailable', abi: null, reason: missing ? null : response.reason, fetchedAt: response.fetchedAt, sourceUrl: url }
  }
  const abi = Array.isArray(response.data?.abi) ? response.data.abi : null
  if (!abi) return { state: 'not_verified', abi: null, reason: null, fetchedAt: response.fetchedAt, sourceUrl: url }
  return { state: 'known', abi, reason: null, fetchedAt: response.fetchedAt, sourceUrl: url }
}

/** Capability groups looked for in a verified ABI. Each is a list of exact,
 * lower-cased ABI member names, so a coincidental substring cannot trip one. */
const CAPABILITY_MATCHERS: Record<string, RegExp> = {
  // Holding or receiving requires passing an identity registry.
  kyc: /^(kycregistry|setkycregistry|kycrequirementgroup|setkycrequirementgroup|kyc_configurer_role|kycregistryset|kycrequirementgroupset|iskyc|verifykyc|kycstatus)$/,
  // Transfers can be halted outright.
  pause: /^(pause|unpause|paused|pauser_role|whennotpaused|setpaused)$/,
  // A named holder can be frozen or denied, individually.
  freeze: /^(freeze|unfreeze|freezeaccount|isfrozen|frozen|blacklist|unblacklist|isblacklisted|blocklist|denylist|setfrozen|addtoblacklist)$/,
  // Supply can be created or destroyed by a privileged role.
  supply: /^(mint|burn|minter_role|burner_role|burnfrom|mintto)$/,
  // Access is gated by role administration.
  roles: /^(grantrole|revokerole|hasrole|getroleadmin|default_admin_role|renouncerole)$/,
}

export interface RestrictionFinding {
  capability: keyof typeof CAPABILITY_MATCHERS
  members: string[]
}

export interface TransferRestrictions {
  state: 'restricted' | 'no_restriction_found' | 'proxy_abi_only' | 'unknown'
  findings: RestrictionFinding[]
  /** Convenience flags for the read view. Each is a statement about CODE. */
  kycGated: boolean
  pausable: boolean
  freezable: boolean
  scope: string
}

const PROXY_MEMBERS = new Set(['adminchanged', 'upgraded', 'beaconupgraded', 'implementation', 'upgradeto', 'upgradetoandcall', 'changeadmin', 'admin'])

const RESTRICTION_SCOPE =
  'Read from the verified source of the contract named here. It describes what the CODE is able to do and which role is able to do it. It does not establish that any restriction has been applied, that any transfer was blocked, that any holder was frozen, or that a given reader may or may not hold this token. It is not legal or investment advice. Read the verified source.'

/**
 * Which restriction capabilities a verified ABI exposes.
 *
 * A proxy shell reports `proxy_abi_only` rather than "no restriction found":
 * the restrictions live in the implementation, and calling a proxy
 * unrestricted would be a false negative on exactly the tokens that are most
 * restricted.
 */
// deno-lint-ignore no-explicit-any
export function detectRestrictions(abi: any[] | null): TransferRestrictions {
  const base = { kycGated: false, pausable: false, freezable: false, scope: RESTRICTION_SCOPE }
  if (!Array.isArray(abi) || !abi.length) {
    return { ...base, state: 'unknown', findings: [], scope: 'No verified source was read for this contract, so its transfer restrictions are unknown. Unknown is not the same as unrestricted. ' + RESTRICTION_SCOPE }
  }
  const names = abi.map((entry) => String(entry?.name ?? '').trim()).filter(Boolean)
  const findings: RestrictionFinding[] = []
  for (const [capability, matcher] of Object.entries(CAPABILITY_MATCHERS)) {
    const members = [...new Set(names.filter((name) => matcher.test(name.toLowerCase())))].sort()
    if (members.length) findings.push({ capability: capability as keyof typeof CAPABILITY_MATCHERS, members })
  }
  const has = (capability: string) => findings.some((f) => f.capability === capability)
  const meaningful = findings.filter((f) => f.capability !== 'roles')
  if (!meaningful.length) {
    // Only proxy plumbing and role administration: the real ABI is elsewhere.
    const proxyish = names.filter((n) => PROXY_MEMBERS.has(n.toLowerCase())).length
    if (proxyish > 0) {
      return { ...base, state: 'proxy_abi_only', findings, scope: 'This is a proxy contract. Its own verified source carries no transfer logic, so the restrictions of the token live in its implementation contract and were not read here. ' + RESTRICTION_SCOPE }
    }
    return { ...base, state: 'no_restriction_found', findings }
  }
  return {
    state: 'restricted',
    findings,
    kycGated: has('kyc'),
    pausable: has('pause'),
    freezable: has('freeze'),
    scope: RESTRICTION_SCOPE,
  }
}
