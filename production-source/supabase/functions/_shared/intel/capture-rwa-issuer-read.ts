// Investor Intel: read view over the RWA issuer legitimacy tables.
//
// Same contract as every other capture read module: pure functions over a
// PostgREST-shaped `db`, bounded by explicit row caps, and a FAILED read
// reported as a reason on an otherwise intact result rather than as an empty
// list. The tables are service-role only, so this runs inside `intel-capture`
// behind an authenticated Investor Intel membership check.
//
// The view is organised around the alias map rather than around the tables:
// every MAPPED subject is listed, plus every DELIBERATE NON-MAPPING, because
// "we looked and the sources did not support a mapping" is a finding a reader
// needs, not an absence to hide.

import { ALIAS_ASSERTIONS, ALIAS_REVIEWED_AT, ALIAS_REVIEW_EXPIRES, NAME_COLLISIONS, UNMAPPED, collisionsFor, resolveAlias } from './rwa-issuer-aliases.ts'
import { tokenSubject, CONCENTRATION_TABLE, DRIFT_TABLE, ENTITY_TABLE, FILING_TABLE, RESTRICTION_TABLE, SIGNAL_TABLE } from './capture-rwa-issuer.ts'

const FILING_CAP = 200
const DRIFT_CAP = 200
const CONCENTRATION_CAP = 400

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 2000): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/**
 * The legitimacy board.
 *
 * Every figure keeps the clock that produced it: `filing_date` is EDGAR's,
 * `captured_at` is ours, and `fetched_at` is when we read the source. The view
 * never merges them into a single "as of".
 */
// deno-lint-ignore no-explicit-any
export async function readRwaIssuerLegitimacy(db: any, params: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const at = now instanceof Date ? now.getTime() : now
  const wanted = str(params.subject, 200)
  const assertions = ALIAS_ASSERTIONS.filter((a) => !wanted || a.subject.toLowerCase() === wanted.toLowerCase())
  const ciks = [...new Set(assertions.map((a) => a.entity.cik).filter((c): c is string => !!c))]
  const entityKeys = [...new Set(assertions.map((a) => (a.entity.lei ? `lei:${a.entity.lei}` : a.entity.cik ? `cik:${a.entity.cik}` : null)).filter((k): k is string => !!k))]
  const addresses = [...new Set(assertions.map((a) => tokenSubject(a)?.address).filter((x): x is string => !!x))]

  const reasons: string[] = []
  const collect = <T>(result: { rows: T[]; reason: string | null }, source: string): T[] => {
    if (result.reason) reasons.push(`${source}:${result.reason}`)
    return result.rows
  }

  // Each read is independent, so one unavailable table degrades to its own
  // stated reason instead of blanking the board.
  const [entities, filings, drift, signals, concentration, restrictions] = await Promise.all([
    entityKeys.length ? readRows(() => db.from(ENTITY_TABLE).select('entity_key,lei,cik,legal_name,jurisdiction,entity_status,registration_status,next_renewal_date,alias_version,source_url,fetched_at').in('entity_key', entityKeys).limit(100)) : Promise.resolve({ rows: [], reason: null }),
    ciks.length ? readRows(() => db.from(FILING_TABLE).select('cik,accession_number,filing_date,submission_type,entity_name,jurisdiction_of_inc,federal_exemptions,minimum_investment_accepted,has_non_accredited_investors,total_amount_sold,total_investors,source_url,fetched_at').in('cik', ciks).order('filing_date', { ascending: false }).limit(FILING_CAP)) : Promise.resolve({ rows: [], reason: null }),
    ciks.length ? readRows(() => db.from(DRIFT_TABLE).select('cik,from_accession,to_accession,field,kind,from_value,to_value,held_until,changed_by,scope').in('cik', ciks).order('changed_by', { ascending: false }).limit(DRIFT_CAP)) : Promise.resolve({ rows: [], reason: null }),
    entityKeys.length ? readRows(() => db.from(SIGNAL_TABLE).select('entity_key,signal_type,level,status,source_url,scope,fetched_at').in('entity_key', entityKeys).limit(100)) : Promise.resolve({ rows: [], reason: null }),
    addresses.length ? readRows(() => db.from(CONCENTRATION_TABLE).select('chain,contract_address,captured_at,holders_count,total_supply,top1_share,top5_share,top10_share,holders_read,truncated,source_url,export_allowed,scope').in('contract_address', addresses).order('captured_at', { ascending: false }).limit(CONCENTRATION_CAP)) : Promise.resolve({ rows: [], reason: null }),
    addresses.length ? readRows(() => db.from(RESTRICTION_TABLE).select('chain,contract_address,implementation_address,state,kyc_gated,pausable,freezable,matched_members,source_url,scope,fetched_at').in('contract_address', addresses).limit(100)) : Promise.resolve({ rows: [], reason: null }),
  ])

  const entityRows = collect(entities, ENTITY_TABLE)
  const filingRows = collect(filings, FILING_TABLE)
  const driftRows = collect(drift, DRIFT_TABLE)
  const signalRows = collect(signals, SIGNAL_TABLE)
  const concentrationRows = collect(concentration, CONCENTRATION_TABLE)
  const restrictionRows = collect(restrictions, RESTRICTION_TABLE)

  const subjects = assertions.map((assertion) => {
    const entityKey = assertion.entity.lei ? `lei:${assertion.entity.lei}` : `cik:${assertion.entity.cik}`
    const token = tokenSubject(assertion)
    // deno-lint-ignore no-explicit-any
    const mine = (rows: any[], key: string, value: unknown) => rows.filter((r) => r?.[key] === value)
    const series = mine(filingRows, 'cik', assertion.entity.cik)
      .map((r) => ({
        accessionNumber: str(r.accession_number, 25), filingDate: str(r.filing_date, 10), submissionType: str(r.submission_type, 10),
        entityName: str(r.entity_name, 500), jurisdictionOfInc: str(r.jurisdiction_of_inc, 120),
        federalExemptions: Array.isArray(r.federal_exemptions) ? r.federal_exemptions : null,
        // A stated zero minimum is a real term and survives as 0.
        minimumInvestmentAccepted: num(r.minimum_investment_accepted),
        hasNonAccreditedInvestors: typeof r.has_non_accredited_investors === 'boolean' ? r.has_non_accredited_investors : null,
        totalAmountSold: num(r.total_amount_sold), totalInvestors: num(r.total_investors),
        sourceUrl: str(r.source_url, 500), fetchedAt: str(r.fetched_at, 40),
      }))
      .sort((a, b) => String(a.filingDate ?? '').localeCompare(String(b.filingDate ?? '')))
    const latestConcentration = token
      ? mine(concentrationRows, 'contract_address', token.address)
        .map((r) => ({
          chain: str(r.chain, 20), capturedAt: str(r.captured_at, 40), holdersCount: num(r.holders_count),
          totalSupply: str(r.total_supply, 80),
          tiers: [
            { topN: 1, share: num(r.top1_share) },
            { topN: 5, share: num(r.top5_share) },
            { topN: 10, share: num(r.top10_share) },
          ],
          holdersRead: num(r.holders_read) ?? 0, truncated: r.truncated === true,
          sourceUrl: str(r.source_url, 500), exportAllowed: r.export_allowed === true, scope: str(r.scope),
        }))
        .sort((a, b) => String(b.capturedAt ?? '').localeCompare(String(a.capturedAt ?? '')))[0] ?? null
      : null
    const restriction = token ? mine(restrictionRows, 'contract_address', token.address)[0] ?? null : null

    return {
      subject: assertion.subject,
      subjectLabel: assertion.subjectLabel,
      state: resolveAlias(assertion.subject, at) ? 'mapped' : 'expired',
      identity: {
        entityKey, lei: assertion.entity.lei ?? null, cik: assertion.entity.cik ?? null,
        legalName: str(entityRows.find((r) => r.entity_key === entityKey)?.legal_name, 500) ?? assertion.entity.legalName,
        jurisdiction: str(entityRows.find((r) => r.entity_key === entityKey)?.jurisdiction, 20) ?? assertion.entity.jurisdiction ?? null,
        registrationStatus: str(entityRows.find((r) => r.entity_key === entityKey)?.registration_status, 40),
        entityStatus: str(entityRows.find((r) => r.entity_key === entityKey)?.entity_status, 40),
        basis: assertion.basis, evidence: assertion.evidence,
        assertedBy: assertion.assertedBy, assertedAt: assertion.assertedAt, expiresAt: assertion.expiresAt,
        sourceUrl: assertion.entity.sourceUrl,
      },
      admission: {
        timeline: series,
        current: series.at(-1) ?? null,
        termDrift: mine(driftRows, 'cik', assertion.entity.cik).filter((r) => r.kind === 'term').map(driftRow),
        activityDrift: mine(driftRows, 'cik', assertion.entity.cik).filter((r) => r.kind === 'activity').map(driftRow),
      },
      signals: signalRows.filter((r) => r.entity_key === entityKey).map((r) => ({
        type: str(r.signal_type, 40), level: str(r.level, 40), status: str(r.status, 120),
        sourceUrl: str(r.source_url, 500), scope: str(r.scope), fetchedAt: str(r.fetched_at, 40),
      })),
      concentration: latestConcentration,
      restrictions: restriction
        ? {
          state: str(restriction.state, 40), kycGated: restriction.kyc_gated === true,
          pausable: restriction.pausable === true, freezable: restriction.freezable === true,
          matchedMembers: Array.isArray(restriction.matched_members) ? restriction.matched_members : [],
          sourceUrl: str(restriction.source_url, 500), scope: str(restriction.scope),
        }
        : null,
      collisions: collisionsFor(assertion.subject),
    }
  })

  const stamps = [...filingRows.map((r) => r.fetched_at), ...concentrationRows.map((r) => r.captured_at)]
    .map((v) => str(v, 40)).filter((v): v is string => !!v).sort()

  return {
    view: 'rwa_issuer_legitimacy',
    asOf: stamps.at(-1) ?? null,
    coverage: stamps.length ? { from: stamps[0], to: stamps.at(-1)!, count: subjects.length } : emptyCoverage(),
    reason: reasons.length ? reasons.join(' ').slice(0, 400) : null,
    subjects,
    // Deliberate non-mappings are part of the answer, not an absence.
    unmapped: UNMAPPED.map((u) => ({ subject: u.subject, subjectLabel: u.subjectLabel, reason: u.reason, evidence: u.evidence, probedAt: u.probedAt, sourceUrl: u.sourceUrl })),
    collisions: NAME_COLLISIONS,
    review: { reviewedAt: ALIAS_REVIEWED_AT, expiresAt: ALIAS_REVIEW_EXPIRES, expired: at >= Date.parse(ALIAS_REVIEW_EXPIRES) },
  }
}

// deno-lint-ignore no-explicit-any
const driftRow = (r: any) => ({
  field: str(r.field, 40), kind: str(r.kind, 20), from: str(r.from_value, 1000), to: str(r.to_value, 1000),
  fromAccession: str(r.from_accession, 25), toAccession: str(r.to_accession, 25),
  heldUntil: str(r.held_until, 10), changedBy: str(r.changed_by, 10), scope: str(r.scope),
})

export const RWA_ISSUER_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  rwa_issuer_legitimacy: (db, body, now) => readRwaIssuerLegitimacy(db, body, now),
}
