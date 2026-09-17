// Investor Intel: the RWA issuer legitimacy capture lane.
//
// Two ops, both keyless and both FREE. There is no credit line here at all:
// GLEIF is CC0, EDGAR and OFAC are US public domain, Sourcify publishes
// verified source, and the block explorer is read within its published rate
// limit. Every JobResult therefore reports `credits: 0`, which is a fact rather
// than an omission.
//
//   rwa_issuer_registry       For each MAPPED subject in rwa-issuer-aliases.ts:
//                             read its EDGAR submissions, its Form D series and
//                             its GLEIF record, screen the registered legal name
//                             against the OFAC SDN publication, and store the
//                             entity, the admission time series, the dated drift
//                             and the risk signals.
//
//   rwa_token_concentration   For each mapped TOKEN subject: read the explorer's
//                             token summary and one page of holders, compute the
//                             top-N shares, and read the verified contract source
//                             for transfer restrictions.
//
// AN UNMAPPED SUBJECT IS NEVER CAPTURED. The lane iterates the assertions IN
// FORCE at the run's clock (`currentAssertions`), not the tokens we happen to
// track, so there is no path by which a legal fact is stored against a subject
// whose identity was never asserted, or whose assertion was explicitly lapsed.
// An assertion does not fall out of force because time passed. Rows captured
// while a mapping was in force are kept; they are simply not refreshed until a
// later version restates it.
//
// SCHEDULE. Both ops are driven by pg_cron from migration
// 20260916202000_intel_rwa_capture_cron.sql, once a day each, at the times in
// RWA_ISSUER_CAPTURE_SCHEDULE below. A test reads that migration and fails if
// the two disagree.
//
// NEVER THROWS. Every failure becomes a named reason on the result, and a source
// that failed never empties a table: the writes are upserts keyed so a retry
// lands on the same row.

import { hourBucket } from './capture-jobs.ts'
import type { CaptureDeps, JobResult, SchedulePolicyRow } from './capture-jobs.ts'
import { ALIAS_VERSION, currentAssertions, type AliasAssertion } from './rwa-issuer-aliases.ts'
import { fetchLeiRecord } from './rwa-sources/gleif.ts'
import { fetchFormD, fetchSubmissions, formDFilings } from './rwa-sources/edgar.ts'
import { concentration, concentrationScope, fetchAddressImplementation, fetchTokenSummary, fetchTopHolders, type BlockscoutChain } from './rwa-sources/blockscout.ts'
import { detectRestrictions, fetchContractAbi } from './rwa-sources/sourcify.ts'
import { fetchSdnIndex, screenLegalEntity, type SdnIndex } from './rwa-sources/ofac.ts'
import { leiRegistrationSignal } from './rwa-sources/gleif.ts'
import { admissionDrift, admissionSnapshot, admissionTimeline } from './rwa-admission-drift.ts'
import type { SourceDeps } from './rwa-sources/http.ts'
import { resolveEdgarUserAgent } from './rwa-sources/edgar-agent.ts'

/** These lanes answer to their own provider row, not CoinMarketCap's. */
export const RWA_ISSUER_PROVIDER = 'primary-sources'
export const RWA_REGISTRY_FEATURE = 'rwa_issuer_registry'
export const RWA_CONCENTRATION_FEATURE = 'rwa_token_concentration'

export const ENTITY_TABLE = 'intel_rwa_issuer_entities'
export const FILING_TABLE = 'intel_rwa_issuer_admission_filings'
export const DRIFT_TABLE = 'intel_rwa_issuer_admission_drift'
export const SIGNAL_TABLE = 'intel_rwa_issuer_risk_signals'
export const CONCENTRATION_TABLE = 'intel_rwa_token_concentration'
export const RESTRICTION_TABLE = 'intel_rwa_token_restrictions'

/** The pg_cron jobs that run these lanes (UTC). Served by the read view so an
 * empty board can say when it fills; asserted against the migration by test. */
export const RWA_ISSUER_CAPTURE_SCHEDULE = {
  rwa_issuer_registry: { job: 'intel-capture-rwa-issuer-registry-daily', cron: '19 2 * * *', cadence: 'daily', utc: '02:19' },
  rwa_token_concentration: { job: 'intel-capture-rwa-token-concentration-daily', cron: '53 2 * * *', cadence: 'daily', utc: '02:53' },
} as const

/** Filings read per subject per run. The admission series is short by nature:
 * the longest real series probed 2026-09-16 was seven filings. */
export const FILINGS_PER_SUBJECT = 8
/** Subjects one run will process, so a growing alias map cannot grow the run. */
export const SUBJECTS_PER_RUN = 10

/** The setting carrying the descriptive contact EDGAR requires. REQUIRED
 * SETTING: until it resolves, `rwa_issuer_registry` reads nothing from EDGAR and
 * reports `user_agent_required`. It is read from the environment first and then
 * from the operating profile row; see `rwa-sources/edgar-agent.ts`. */
export { EDGAR_AGENT_ENV } from './rwa-sources/edgar-agent.ts'

/** Recorded for a token that IS a proxy but whose implementation could not be
 * read. It must never fall through to `no_restriction_found`: not having looked
 * is not the same as having looked and found nothing. */
export const PROXY_UNRESOLVED_SCOPE =
  'This token is a proxy contract and its implementation could not be resolved, so its transfer restrictions were NOT read. Absence of a detected restriction here is not evidence that transfers are unrestricted, that no identity registry applies, or that a holder cannot be frozen. Nothing is asserted about this token\'s restrictions. Read the contract at the block explorer.'

/** This lane's own policy row. `schedulePolicy` in capture-jobs.ts filters on
 * the CoinMarketCap provider, so it would never see these rows. */
export function lanePolicy(policy: SchedulePolicyRow[] | undefined, feature: string): { enabled: boolean } {
  const row = (policy || []).find((r) => r?.feature === feature && r.provider === RWA_ISSUER_PROVIDER)
  return { enabled: row ? row.enabled !== false : true }
}

const iso = (value: unknown): string | null => {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}
const day = (value: unknown): string | null => {
  const s = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

// deno-lint-ignore no-explicit-any
async function upsert(db: any, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<{ rows: number; error?: string }> {
  if (!rows.length) return { rows: 0 }
  try {
    const { error } = await db.from(table).upsert(rows, { onConflict })
    if (error) return { rows: 0, error: String(error.message || error).slice(0, 200) }
    return { rows: rows.length }
  } catch (e) { return { rows: 0, error: ((e as Error)?.message || 'write_failed').slice(0, 200) } }
}

export interface RwaLaneDeps extends CaptureDeps { sources?: SourceDeps }

/** Token subjects carry a chain and an address; issuer subjects do not. */
export function tokenSubject(assertion: AliasAssertion): { chain: BlockscoutChain; address: string } | null {
  const match = /^token:eip155:(\d+):(0x[0-9a-f]{40})$/i.exec(assertion.subject)
  if (!match) return null
  const chain = ({ '1': 'ethereum', '8453': 'base', '42161': 'arbitrum', '137': 'polygon' } as Record<string, BlockscoutChain>)[match[1]]
  return chain ? { chain, address: match[2].toLowerCase() } : null
}

/**
 * Registry, admission series and risk signals for every mapped subject.
 *
 * The OFAC publication is fetched ONCE per run and screened against every
 * entity, rather than re-downloading five megabytes per subject.
 */
export async function captureRwaIssuerRegistry(
  // deno-lint-ignore no-explicit-any
  admin: any,
  now: Date,
  deps: RwaLaneDeps,
  options: { subjects?: readonly AliasAssertion[]; at?: number } = {},
): Promise<JobResult> {
  const job = RWA_REGISTRY_FEATURE
  try {
    if (!lanePolicy(deps.policy, RWA_REGISTRY_FEATURE).enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const at = options.at ?? now.getTime()
    const assertions = (options.subjects ?? currentAssertions(at)).slice(0, SUBJECTS_PER_RUN)
    if (!assertions.length) return { job, rows: 0, credits: 0, skipped: 'no_mapped_subjects' }

    // An injected agent wins (tests, a manual run); otherwise the environment,
    // then the operating profile row. None resolves to `user_agent_required`
    // at the transport, before any EDGAR call is issued.
    const agent = deps.sources?.userAgent ?? (await resolveEdgarUserAgent(admin)).userAgent
    const sources: SourceDeps = { ...(deps.sources ?? {}), userAgent: agent }

    // One SDN read for the whole run. A failure here suppresses only the
    // sanctions signal; every other fact still lands.
    const sdnRead = await fetchSdnIndex(sources)
    const sdn: SdnIndex | null = sdnRead.index
    const reasons: Record<string, string> = {}
    if (sdnRead.reason) reasons.ofac = sdnRead.reason

    let rows = 0
    for (const assertion of assertions) {
      const entityKey = assertion.entity.lei ? `lei:${assertion.entity.lei}` : assertion.entity.cik ? `cik:${assertion.entity.cik}` : null
      if (!entityKey) continue

      // GLEIF, when the assertion carries an LEI.
      const leiRead = assertion.entity.lei ? await fetchLeiRecord(assertion.entity.lei, sources) : null
      if (leiRead?.reason) reasons.gleif = leiRead.reason

      // EDGAR submissions and the Form D series, when it carries a CIK.
      const submissionsRead = assertion.entity.cik ? await fetchSubmissions(assertion.entity.cik, sources) : null
      if (submissionsRead?.reason) reasons.edgar = submissionsRead.reason

      const legalName = leiRead?.record?.legalName ?? submissionsRead?.record?.name ?? assertion.entity.legalName
      const entityWrite = await upsert(admin, ENTITY_TABLE, [{
        entity_key: entityKey,
        lei: assertion.entity.lei ?? null,
        cik: assertion.entity.cik ?? null,
        legal_name: legalName,
        jurisdiction: leiRead?.record?.jurisdiction ?? assertion.entity.jurisdiction ?? null,
        entity_status: leiRead?.record?.entityStatus ?? null,
        registration_status: leiRead?.record?.registrationStatus ?? null,
        initial_registration_date: iso(leiRead?.record?.initialRegistrationDate),
        last_update_date: iso(leiRead?.record?.lastUpdateDate),
        next_renewal_date: iso(leiRead?.record?.nextRenewalDate),
        alias_version: assertion.version ?? ALIAS_VERSION,
        source_url: leiRead?.sourceUrl ?? submissionsRead?.sourceUrl ?? assertion.entity.sourceUrl,
        fetched_at: new Date(at).toISOString(),
      }], 'entity_key')
      if (entityWrite.error) return { job, rows, credits: 0, error: entityWrite.error }
      rows += entityWrite.rows

      // Risk signals. A signal without its scope string is refused by the
      // schema, so both are written together or not at all.
      const signals: Record<string, unknown>[] = []
      if (leiRead?.record) {
        const signal = leiRegistrationSignal(leiRead.record)
        signals.push({ entity_key: entityKey, signal_type: 'lei_registration', level: signal.level, status: signal.status, source_url: signal.sourceUrl, scope: signal.scope, fetched_at: leiRead.fetchedAt })
      }
      if (legalName) {
        const screening = screenLegalEntity(legalName, sdn)
        signals.push({ entity_key: entityKey, signal_type: 'sanctions_name_pointer', level: screening.state, status: screening.matches[0]?.program ?? null, source_url: screening.sourceUrl, scope: screening.scope, fetched_at: sdnRead.fetchedAt })
      }
      const signalWrite = await upsert(admin, SIGNAL_TABLE, signals, 'entity_key,signal_type')
      rows += signalWrite.rows

      // The admission time series.
      const filings = formDFilings(submissionsRead?.record ?? null).slice(0, FILINGS_PER_SUBJECT)
      const snapshots = []
      for (const filing of filings) {
        const parsed = await fetchFormD(assertion.entity.cik, filing.accessionNumber, sources)
        if (!parsed.terms) { if (parsed.reason) reasons.edgar = parsed.reason; continue }
        snapshots.push(admissionSnapshot(filing, parsed.terms, parsed.sourceUrl, parsed.fetchedAt))
      }
      if (snapshots.length) {
        const filingWrite = await upsert(admin, FILING_TABLE, snapshots.map((s) => ({
          cik: assertion.entity.cik, accession_number: s.accessionNumber,
          filing_date: day(s.filingDate), signature_date: day(s.signatureDate), submission_type: s.submissionType,
          entity_name: s.entityName, jurisdiction_of_inc: s.jurisdictionOfInc,
          federal_exemptions: s.federalExemptions, minimum_investment_accepted: s.minimumInvestmentAccepted,
          has_non_accredited_investors: s.hasNonAccreditedInvestors, total_amount_sold: s.totalAmountSold,
          total_offering_amount: null, total_investors: s.totalNumberAlreadyInvested,
          source_url: s.sourceUrl, fetched_at: s.fetchedAt,
        })), 'cik,accession_number')
        if (filingWrite.error) return { job, rows, credits: 0, error: filingWrite.error }
        rows += filingWrite.rows

        const drift = admissionDrift(admissionTimeline(snapshots))
        const driftWrite = await upsert(admin, DRIFT_TABLE, drift.map((d) => ({
          cik: assertion.entity.cik, from_accession: d.fromAccession, to_accession: d.toAccession,
          field: d.field, kind: d.kind, from_value: d.from.slice(0, 1000), to_value: d.to.slice(0, 1000),
          held_until: day(d.heldUntil), changed_by: day(d.changedBy), scope: d.scope,
          fetched_at: new Date(at).toISOString(),
        })), 'cik,from_accession,to_accession,field')
        rows += driftWrite.rows
      }
    }
    const reason = Object.entries(reasons).map(([source, why]) => `${source}:${why}`).join(' ')
    return { job, rows, credits: 0, subjects: assertions.length, ...(reason ? { partial: reason.slice(0, 200) } : {}) }
  } catch (e) {
    return { job, rows: 0, credits: 0, error: ((e as Error)?.message || 'rwa_issuer_registry_failed').slice(0, 200) }
  }
}

/** Holder concentration and transfer restrictions for every mapped TOKEN. */
export async function captureRwaTokenConcentration(
  // deno-lint-ignore no-explicit-any
  admin: any,
  now: Date,
  deps: RwaLaneDeps,
  options: { subjects?: readonly AliasAssertion[]; at?: number } = {},
): Promise<JobResult> {
  const job = RWA_CONCENTRATION_FEATURE
  try {
    if (!lanePolicy(deps.policy, RWA_CONCENTRATION_FEATURE).enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const at = options.at ?? now.getTime()
    const capturedAt = hourBucket(at)
    const tokens = (options.subjects ?? currentAssertions(at)).slice(0, SUBJECTS_PER_RUN)
      .map((a) => ({ assertion: a, token: tokenSubject(a) }))
      .filter((t): t is { assertion: AliasAssertion; token: { chain: BlockscoutChain; address: string } } => !!t.token)
    if (!tokens.length) return { job, rows: 0, credits: 0, skipped: 'no_mapped_tokens' }

    const sources: SourceDeps = deps.sources ?? {}
    const reasons: Record<string, string> = {}
    let rows = 0

    for (const { token } of tokens) {
      const summary = await fetchTokenSummary(token.chain, token.address, sources)
      const holders = await fetchTopHolders(token.chain, token.address, sources)
      if (summary.reason) reasons.blockscout = summary.reason
      if (holders.reason) reasons.blockscout = holders.reason

      // A failed read never writes a row of zeros: an unknown distribution is
      // absent, not flat.
      if (summary.state === 'known' && holders.state === 'known') {
        const shares = concentration(holders.holders, summary.summary?.totalSupply ?? null, { truncated: holders.truncated })
        const tier = (n: number) => shares.tiers.find((t) => t.topN === n)?.share ?? null
        const write = await upsert(admin, CONCENTRATION_TABLE, [{
          chain: token.chain, contract_address: token.address, captured_at: capturedAt,
          holders_count: summary.summary?.holdersCount ?? null,
          total_supply: summary.summary?.totalSupply != null ? String(summary.summary.totalSupply) : null,
          top1_share: tier(1), top5_share: tier(5), top10_share: tier(10),
          holders_read: shares.holdersRead, truncated: shares.truncated,
          source_url: holders.sourceUrl,
          // The explorer's redistribution terms could not be verified.
          export_allowed: false,
          scope: concentrationScope(shares.truncated),
          fetched_at: holders.fetchedAt,
        }], 'chain,contract_address,captured_at')
        if (write.error) return { job, rows, credits: 0, error: write.error }
        rows += write.rows
      }

      // Transfer restrictions from VERIFIED SOURCE, read at the IMPLEMENTATION
      // when this token is a proxy. A proxy's own ABI carries no transfer logic,
      // so reading the proxy and reporting "no restriction found" would be a
      // false negative on exactly the tokens that are most restricted. Verified
      // 2026-09-16: OUSG and USTB are eip1967 proxies whose implementations
      // carry the restrictions, while BUIDL is not a proxy at all.
      const chainId = ({ ethereum: 1, base: 8453, arbitrum: 42161, polygon: 137 } as Record<string, number>)[token.chain]
      const proxy = await fetchAddressImplementation(token.chain, token.address, sources)
      if (proxy.reason) reasons.blockscout = proxy.reason

      // A declared proxy whose implementation could not be read is recorded as
      // UNRESOLVED and nothing is claimed about it. Absence of a detected
      // restriction is not evidence that transfers are unrestricted, so this
      // case must never fall through to `no_restriction_found`.
      const unresolvedProxy = proxy.state === 'unresolved'
      const readAt = proxy.state === 'resolved' && proxy.implementation ? proxy.implementation : token.address
      const abi = unresolvedProxy ? null : await fetchContractAbi(chainId, readAt, sources)
      if (abi?.reason) reasons.sourcify = abi.reason
      const restrictions = detectRestrictions(abi?.abi ?? null)
      const members = restrictions.findings.flatMap((f) => f.members).slice(0, 50)
      const restrictionWrite = await upsert(admin, RESTRICTION_TABLE, [{
        chain: token.chain, contract_address: token.address,
        // Recorded so a reader can verify the claim against the exact contract
        // whose source was actually read.
        implementation_address: proxy.state === 'resolved' ? proxy.implementation : null,
        state: unresolvedProxy ? 'proxy_unresolved' : abi?.state === 'not_verified' ? 'not_verified' : restrictions.state,
        kyc_gated: unresolvedProxy ? false : restrictions.kycGated,
        pausable: unresolvedProxy ? false : restrictions.pausable,
        freezable: unresolvedProxy ? false : restrictions.freezable,
        matched_members: !unresolvedProxy && members.length ? members : null,
        source_url: unresolvedProxy ? proxy.sourceUrl : abi!.sourceUrl,
        scope: unresolvedProxy ? PROXY_UNRESOLVED_SCOPE : restrictions.scope,
        fetched_at: unresolvedProxy ? proxy.fetchedAt : abi!.fetchedAt,
      }], 'chain,contract_address')
      if (restrictionWrite.error) return { job, rows, credits: 0, error: restrictionWrite.error }
      rows += restrictionWrite.rows
    }
    const reason = Object.entries(reasons).map(([source, why]) => `${source}:${why}`).join(' ')
    return { job, rows, credits: 0, capturedAt, tokens: tokens.length, ...(reason ? { partial: reason.slice(0, 200) } : {}) }
  } catch (e) {
    return { job, rows: 0, credits: 0, error: ((e as Error)?.message || 'rwa_token_concentration_failed').slice(0, 200) }
  }
}

/** Lane ops, in the shape `intel-capture/index.ts` spreads into its runners. */
export const RWA_ISSUER_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any,
  ctxFor: (name: string, maxCalls: number) => unknown,
  now: Date,
  plan: string,
  deps: RwaLaneDeps,
  body: Record<string, unknown>,
) => Promise<JobResult>> = {
  rwa_issuer_registry: (admin, _ctxFor, now, _plan, deps) => captureRwaIssuerRegistry(admin, now, deps),
  rwa_token_concentration: (admin, _ctxFor, now, _plan, deps) => captureRwaTokenConcentration(admin, now, deps),
}
