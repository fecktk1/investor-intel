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
//
// THE GUARD from rwa-legitimacy.ts applies here through `identityGate`: a
// subject whose assertion is not in force at the instant read (explicitly
// lapsed, or not yet asserted at a replay instant) shows NO legal name,
// jurisdiction, registration status, sanctions pointer, admission terms or name
// collision. An assertion does NOT fall out of force because time passed.
// Holder concentration and contract restrictions are properties of the token
// contract and stay visible. A replay at an earlier instant lists only the
// mappings and refusals that had been recorded by then.
//
// NOTHING CAPTURED YET is a state, not a blank: `schedule` names the pg_cron
// jobs and times that fill these tables, so the board can say when the first
// capture will land.

import { ALIAS_VERSIONS, NAME_COLLISIONS, assertionsAsOf, collisionsFor, lapseFor, unmappedAsOf } from './rwa-issuer-aliases.ts'
import { identityGate } from './rwa-legitimacy.ts'
import { tokenSubject, CONCENTRATION_TABLE, DRIFT_TABLE, ENTITY_TABLE, FILING_TABLE, RESTRICTION_TABLE, RWA_ISSUER_CAPTURE_SCHEDULE, SIGNAL_TABLE } from './capture-rwa-issuer.ts'

const FILING_CAP = 200
const DRIFT_CAP = 200
const CONCENTRATION_CAP = 400
const IMAGE_CAP = 100

/** The catalogue's platform key for each chain this board can carry a subject on.
 * A chain missing here simply has no logo lookup, which draws a monogram. */
const CATALOGUE_PLATFORM: Record<string, string> = {
  ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum-one', polygon: 'polygon-pos',
}

/** Token logos for the subject headings, joined on the SUBJECT'S OWN CONTRACT.
 *
 * The join is the contract address inside `market_assets.platforms`, never a
 * symbol: these subjects are exactly the assets whose tickers collide (USTBL
 * matches two catalogue rows, `M` three), so a symbol join here would put another
 * asset's logo on an issuer identity. Case-insensitive because 270 of the 1068
 * catalogue rows carrying an `ethereum` platform store it checksum-cased
 * (measured 2026-09-20), so an exact match on a lower-cased address would
 * silently miss them.
 *
 * A subject with no catalogue row gets no image and the surface draws a monogram,
 * which is the right answer for an underlying that is not a listed token. */
// deno-lint-ignore no-explicit-any
export async function readSubjectImages(db: any, tokens: { chain: string; address: string }[]): Promise<{
  images: Map<string, { cached: string | null; source: string | null }>; reason: string | null
}> {
  // PostgREST splits a logic-tree clause on `.`, so a json key carrying a
  // reserved character (`arbitrum-one`, `polygon-pos`) is double-quoted while a
  // plain identifier is left bare, which is the form already proved in
  // `cached-asset-quote.ts`. The address is matched with `ilike` and no wildcard,
  // which is an exact, case-insensitive comparison; it is validated as hex first,
  // so nothing that could contain a `.` or a `,` ever reaches the filter.
  const field = (key: string) => `platforms->>${/^[a-z0-9_]+$/.test(key) ? key : `"${key}"`}`
  const clauses = [...new Set(tokens
    .map((t) => (CATALOGUE_PLATFORM[t.chain] && /^0x[0-9a-fA-F]{40}$/.test(t.address) ? `${field(CATALOGUE_PLATFORM[t.chain])}.ilike.${t.address}` : null))
    .filter((v): v is string => !!v))]
  const images = new Map<string, { cached: string | null; source: string | null }>()
  if (!clauses.length) return { images, reason: null }
  const read = await readRows(() => db.from('market_assets')
    .select('platforms,cached_image_url,image_url')
    .eq('in_current_catalog', true).or(clauses.join(',')).limit(IMAGE_CAP))
  for (const row of read.rows) {
    const platforms = row?.platforms && typeof row.platforms === 'object' ? row.platforms as Record<string, unknown> : {}
    for (const value of Object.values(platforms)) {
      const address = typeof value === 'string' ? value.toLowerCase() : null
      if (!address || images.has(address)) continue
      images.set(address, { cached: str(row?.cached_image_url, 500), source: str(row?.image_url, 500) })
    }
  }
  return { images, reason: read.reason }
}

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
  const assertions = assertionsAsOf(at).filter((a) => !wanted || a.subject.toLowerCase() === wanted.toLowerCase())
  const gates = new Map(assertions.map((a) => [a.subject, identityGate(a.subject, at)]))
  // Legal-person tables are read only for subjects whose mapping is in force.
  const legal = assertions.filter((a) => gates.get(a.subject)?.legalFactsAllowed)
  const ciks = [...new Set(legal.map((a) => a.entity.cik).filter((c): c is string => !!c))]
  const entityKeys = [...new Set(legal.map((a) => (a.entity.lei ? `lei:${a.entity.lei}` : a.entity.cik ? `cik:${a.entity.cik}` : null)).filter((k): k is string => !!k))]
  const addresses = [...new Set(assertions.map((a) => tokenSubject(a)?.address).filter((x): x is string => !!x))]
  const subjectTokens = assertions.map((a) => tokenSubject(a)).filter((t) => !!t)
    .map((t) => ({ chain: String(t!.chain), address: t!.address }))

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

  // Subject logos, read once for the whole board rather than per row, so the
  // surface never issues an image query of its own. An unavailable image read is
  // a missing logo and a recorded reason, never a missing subject.
  const subjectImages = await readSubjectImages(db, subjectTokens)
  if (subjectImages.reason) reasons.push(`market_assets:${subjectImages.reason}`)

  const subjects = assertions.map((assertion) => {
    const entityKey = assertion.entity.lei ? `lei:${assertion.entity.lei}` : `cik:${assertion.entity.cik}`
    const token = tokenSubject(assertion)
    const allowed = gates.get(assertion.subject)?.legalFactsAllowed === true
    // deno-lint-ignore no-explicit-any
    const mine = (rows: any[], key: string, value: unknown) => rows.filter((r) => r?.[key] === value)
    const series = !allowed ? [] : mine(filingRows, 'cik', assertion.entity.cik)
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
    const entityRow = allowed ? entityRows.find((r) => r.entity_key === entityKey) : undefined
    const drifts = allowed ? mine(driftRows, 'cik', assertion.entity.cik) : []

    const image = token ? subjectImages.images.get(token.address) ?? null : null

    return {
      subject: assertion.subject,
      subjectLabel: assertion.subjectLabel,
      // Identity picture, matched on this subject's own contract. Null is normal
      // and draws a monogram; it is never a reason to hide the subject.
      imageUrl: image?.cached ?? null,
      imageSourceUrl: image?.source ?? null,
      state: allowed ? 'mapped' : 'lapsed',
      // True when the guard withheld every fact about a legal person.
      legalFactsWithheld: !allowed,
      identity: {
        entityKey: allowed ? entityKey : null,
        lei: allowed ? assertion.entity.lei ?? null : null,
        cik: allowed ? assertion.entity.cik ?? null : null,
        legalName: !allowed ? null : str(entityRow?.legal_name, 500) ?? assertion.entity.legalName,
        jurisdiction: !allowed ? null : str(entityRow?.jurisdiction, 20) ?? assertion.entity.jurisdiction ?? null,
        registrationStatus: str(entityRow?.registration_status, 40),
        entityStatus: str(entityRow?.entity_status, 40),
        // The assertion's own recorded words stay, so a reader can see what was
        // asserted, when, and that it lapsed.
        basis: assertion.basis, evidence: assertion.evidence,
        assertedBy: assertion.assertedBy, assertedAt: assertion.assertedAt,
        // Null unless a reviewer explicitly withdrew this mapping. There is no
        // date on which it withdraws itself.
        lapsedAt: lapseFor(assertion.subject, at)?.lapsedAt ?? null,
        lapseReason: lapseFor(assertion.subject, at)?.reason ?? null,
        version: assertion.version,
        sourceUrl: assertion.entity.sourceUrl,
      },
      admission: {
        timeline: series,
        current: series.at(-1) ?? null,
        termDrift: drifts.filter((r) => r.kind === 'term').map(driftRow),
        activityDrift: drifts.filter((r) => r.kind === 'activity').map(driftRow),
      },
      // Has anything been captured for this subject yet? Distinguishes "not
      // captured yet" from "captured and found nothing".
      captured: !!entityRow || series.length > 0 || !!latestConcentration || !!restriction,
      signals: signalRows.filter((r) => allowed && r.entity_key === entityKey).map((r) => ({
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
      collisions: allowed ? collisionsFor(assertion.subject) : [],
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
    unmapped: unmappedAsOf(at).map((u) => ({ subject: u.subject, subjectLabel: u.subjectLabel, reason: u.reason, evidence: u.evidence, probedAt: u.probedAt, sourceUrl: u.sourceUrl, version: u.version })),
    collisions: NAME_COLLISIONS.filter((c) => subjects.some((s) => s.subject === c.relatedSubject && !s.legalFactsWithheld)),
    review: aliasReview(subjects, at),
    // When the capture lanes run, so an empty board can say when it fills.
    schedule: RWA_ISSUER_CAPTURE_SCHEDULE,
  }
}

/**
 * The review state of the board. `lapsed` is true when a listed assertion has
 * been EXPLICITLY withdrawn, which is the only way a mapping stops being in
 * force; `lapsedAt` is the earliest such withdrawal. There is no expiry and no
 * next date to watch: `versions` simply lists every review recorded by `at`.
 */
function aliasReview(subjects: { state: string; identity: { lapsedAt: string | null } }[], at: number) {
  const versions = ALIAS_VERSIONS.filter((v) => Date.parse(v.reviewedAt) <= at)
  const withdrawals = subjects.filter((s) => s.state === 'lapsed').map((s) => s.identity.lapsedAt).filter((v): v is string => !!v).sort()
  return {
    reviewedAt: versions.at(-1)?.reviewedAt ?? null,
    lapsedAt: withdrawals[0] ?? null,
    lapsed: subjects.some((s) => s.state === 'lapsed'),
    versions: versions.map((v) => ({ version: v.version, reviewedAt: v.reviewedAt })),
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
