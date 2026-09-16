// Investor Intel: the ISSUER ALIAS MAP.
//
// This is the module that decides whether a token may be connected to a legal
// entity at all, and it is deliberately the most conservative file in the lane.
//
// WHY IT EXISTS. A name is not an identifier. Probed against GLEIF 2026-09-16:
//   filter[fulltext]=Ondo                 17 records, top five being SARL
//                                         MOGABURE (FR), AUTOBUSES LA
//                                         GUIPUZCOANA SL (ES), SUNBETH GLOBAL
//                                         CONCEPTS LIMITED (NG) and two more
//                                         Spanish companies. None is Ondo.
//   filter[entity.legalName]=Ondo Finance          0 records
//   filter[entity.legalName]=Ondo Finance, Inc.    76,773 records, top hits
//                                         "INC Group Inc." (CA) and "INC" (FR)
//   filter[entity.legalName]=Paxos Trust Company, NA   748 records, and the only
//                                         Paxos-named one is a DIFFERENT legal
//                                         form (see the Paxos note below)
// A fuzzy match presented as fact would put a company name next to a sanctions
// pointer or a lapsed-registration signal. That is a legal problem, not a
// styling one. So: NOTHING IS EVER MATCHED BY SIMILARITY. A subject is mapped
// only by an explicit assertion below, recorded with what was compared, who
// asserted it and when. AN UNMAPPED ISSUER STAYS UNMAPPED.
//
// EDITORIAL CONTRACT, mirroring _shared/intel/rwa-issuer-evidence.ts: every
// assertion is dated, carries a seven-day review window, links its source, and
// is append only. A deployed assertion is never edited; it is superseded by a
// later version or it expires. Expiry is our freshness policy, not a claim that
// a legal entity ceased to exist on that date.
//
// FOUR KINDS OF RECORD, and the distinction is the honesty mechanism:
//   ALIAS_ASSERTIONS  a subject IS this legal entity. Both sides evidenced.
//   VERIFIED_ENTITIES a register record we read and can quote. It is NOT a
//                     claim that any token belongs to it.
//   UNMAPPED          a subject we deliberately did NOT map, with the
//                     reproduced negative probe that stopped us.
//   NAME_COLLISIONS   register records sharing a name stem with a mapped
//                     filer, surfaced for HUMAN REVIEW and explicitly not
//                     asserted. This is where a lapsed registration that may or
//                     may not be related shows up, without ever being attached
//                     to a token by similarity.

export const ALIAS_REVIEWED_AT = '2026-09-16T14:30:00.000Z'
export const ALIAS_REVIEW_EXPIRES = '2026-09-23T14:30:00.000Z'
export const ALIAS_REVIEW_WINDOW_MS = 7 * 86_400_000
export const ALIAS_VERSION = 'rwa-issuer-alias-1'
/** Who asserted every mapping in this version, recorded so a reader can ask. */
export const ALIAS_REVIEWER = 'investor-intel-editorial'

/** What was actually compared to justify a mapping. There is no 'similar_name'
 * member, and there never may be. */
export type AliasBasis =
  /** The register's legalName is byte-identical to the name we searched. */
  | 'exact_legal_name_match'
  /** The filer name on EDGAR matches the token's on-chain name, allowing only
   * a trailing legal-form suffix or series clause. Stated per assertion. */
  | 'filing_entity_name_match'
  /** The issuer's own published document names the legal entity. */
  | 'issuer_published_identifier'

export interface EntityRef {
  lei?: string | null
  cik?: string | null
  /** The name AS THE REGISTER PUBLISHES IT, never the CoinMarketCap string. */
  legalName: string
  jurisdiction?: string | null
  /** Register status as read on the probe date. Re-read live before display;
   * this copy exists so a reviewer can see what was true when asserted. */
  registrationStatus?: string | null
  sourceUrl: string
}

export interface AliasAssertion {
  /** 'token:<caip-like>' or 'cmc-issuer:<id>'. Never a name. */
  subject: string
  subjectLabel: string
  entity: EntityRef
  basis: AliasBasis
  /** Exactly what was compared, in words a reviewer can re-run. */
  evidence: string
  assertedBy: string
  assertedAt: string
  expiresAt: string
  version: string
}

export interface UnmappedRecord {
  subject: string
  subjectLabel: string
  /** Short machine-readable cause. */
  reason: 'no_register_record' | 'name_not_an_identifier' | 'legal_form_mismatch'
  /** The reproduced probe that stopped the mapping. */
  evidence: string
  probedAt: string
  sourceUrl: string
  version: string
}

export interface NameCollision {
  /** The mapped subject whose filer name contains the shared stem. */
  relatedSubject: string
  stem: string
  entities: EntityRef[]
  note: string
  probedAt: string
  version: string
}

const review = { assertedBy: ALIAS_REVIEWER, assertedAt: ALIAS_REVIEWED_AT, expiresAt: ALIAS_REVIEW_EXPIRES, version: ALIAS_VERSION }

/**
 * Subject IS this legal entity.
 *
 * Only two mappings are asserted in this version, both from a TOKEN CONTRACT to
 * an SEC filer. A token contract is a precise identifier and its on-chain name
 * is readable, so the comparison is checkable. Mapping from a CoinMarketCap
 * issuer STRING was attempted and abandoned: see UNMAPPED below.
 */
export const ALIAS_ASSERTIONS: readonly AliasAssertion[] = [
  {
    subject: 'token:eip155:1:0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e',
    subjectLabel: 'USTB',
    entity: {
      cik: '0002004367',
      legalName: 'Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust',
      jurisdiction: 'DE',
      sourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0002004367&type=D&dateb=&owner=include&count=40',
    },
    basis: 'filing_entity_name_match',
    evidence:
      'Probed 2026-09-16. The token at this contract reports its on-chain name as "Invesco Short Duration US Government Securities Fund" (symbol USTB). EDGAR filer CIK 0002004367 is named "Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust". The on-chain name is the exact leading portion of the filer name, the remainder being the series clause. EDGAR formerNames additionally records the filer as "Superstate Short Duration US Government Securities Fund, a series of Superstate Asset Trust" from 2024-01-02 to 2026-07-07, which is why this mapping is made to a CIK and not to a name.',
    ...review,
  },
  {
    subject: 'token:eip155:1:0x7712c34205737192402172409a8f7ccef8aa2aec',
    subjectLabel: 'BUIDL',
    entity: {
      cik: '0002013810',
      legalName: 'BlackRock USD Institutional Digital Liquidity Fund Ltd.',
      jurisdiction: 'VIRGIN ISLANDS, BRITISH',
      sourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0002013810&type=D&dateb=&owner=include&count=40',
    },
    basis: 'filing_entity_name_match',
    evidence:
      'Probed 2026-09-16. The token at this contract reports its on-chain name as "BlackRock USD Institutional Digital Liquidity Fund" (symbol BUIDL). EDGAR filer CIK 0002013810 is named "BlackRock USD Institutional Digital Liquidity Fund Ltd.", differing only by the trailing legal-form suffix "Ltd.". That filer has no formerNames. Its Form D reports jurisdiction of incorporation VIRGIN ISLANDS, BRITISH.',
    ...review,
  },
]

/**
 * Register records we read and can quote.
 *
 * Presence here is NOT a mapping. These exist so the legitimacy view can quote
 * a register accurately when something resolves to one, and so a reviewer can
 * see the lapsed registrations that motivated the feature.
 */
export const VERIFIED_ENTITIES: readonly EntityRef[] = [
  { cik: '0002004367', legalName: 'Invesco Short Duration US Government Securities Fund, a separate series of Superstate Asset Trust', jurisdiction: 'DE', sourceUrl: 'https://data.sec.gov/submissions/CIK0002004367.json' },
  { cik: '0002013810', legalName: 'BlackRock USD Institutional Digital Liquidity Fund Ltd.', jurisdiction: 'VIRGIN ISLANDS, BRITISH', sourceUrl: 'https://data.sec.gov/submissions/CIK0002013810.json' },
  // Carried for its admission time series only. It is NOT asserted to be the
  // issuer of any tokenised product; Ondo I LP and Ondo Finance Inc. are
  // separate Delaware filers (CIK 0001957431 and 0001949480).
  { cik: '0001957431', legalName: 'Ondo I LP', jurisdiction: 'DE', sourceUrl: 'https://data.sec.gov/submissions/CIK0001957431.json' },
  { lei: '254900RYEZ47C0C0YO93', legalName: 'SUPERSTATE INC.', jurisdiction: 'US-DE', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/254900RYEZ47C0C0YO93' },
  { lei: '2549003P4H6K2FQ3UV85', legalName: 'Superstate Limited', jurisdiction: 'VG', registrationStatus: 'LAPSED', sourceUrl: 'https://search.gleif.org/#/record/2549003P4H6K2FQ3UV85' },
  { lei: '254900AG86JY01ULWX64', legalName: 'Hashnote Master Fund LP', jurisdiction: 'KY', registrationStatus: 'LAPSED', sourceUrl: 'https://search.gleif.org/#/record/254900AG86JY01ULWX64' },
  { lei: '529900VBK42Y5HHRMD23', legalName: 'BlackRock, Inc.', jurisdiction: 'US-DE', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/529900VBK42Y5HHRMD23' },
  { lei: '549300EQW4J4RXDLD359', legalName: 'Paxos Trust Company, LLC', jurisdiction: 'US-NY', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/549300EQW4J4RXDLD359' },
  { lei: '254900THYWS8K2PQL620', legalName: 'PAXOS HOLDINGS LLC', jurisdiction: 'US-DE', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/254900THYWS8K2PQL620' },
]

/**
 * Deliberate non-mappings, each with the probe that stopped it.
 *
 * These are a FEATURE. "We do not know" is a publishable answer; a wrong legal
 * entity is not. The CoinMarketCap issuer identifiers are the ones already
 * reviewed in rwa-issuer-evidence.ts.
 */
export const UNMAPPED: readonly UnmappedRecord[] = [
  {
    subject: 'cmc-issuer:688ca4ccabae9b5b9fb3167a',
    subjectLabel: 'Ondo',
    reason: 'name_not_an_identifier',
    evidence:
      'GLEIF holds no entity under this name. filter[entity.legalName]=Ondo Finance returned 0 records; filter[entity.legalName]=Ondo Finance, Inc. returned 76,773 records whose top hits were "INC Group Inc." (CA) and "INC" (FR); filter[fulltext]=Ondo returned 17 unrelated records including SARL MOGABURE (FR) and AUTOBUSES LA GUIPUZCOANA SL (ES). EDGAR does hold Ondo Finance Inc. (CIK 0001949480) and Ondo I LP (CIK 0001957431), which are separate Delaware filers; neither has been shown to issue the CoinMarketCap-listed token, so neither is asserted.',
    probedAt: ALIAS_REVIEWED_AT,
    sourceUrl: 'https://api.gleif.org/api/v1/lei-records',
    version: ALIAS_VERSION,
  },
  {
    subject: 'cmc-issuer:68904c24abae9b5b9fb35815',
    subjectLabel: 'Paxos',
    reason: 'legal_form_mismatch',
    evidence:
      'The PAX Gold terms name the issuer "Paxos Trust Company, NA". GLEIF holds no entity under that name: filter[fulltext]=Paxos Trust returned exactly two records, "Paxos Trust Company, LLC" (US-NY, ISSUED) and "PAXOS HOLDINGS LLC" (US-DE, ISSUED). A national association and a limited liability company are different legal forms, and this review did not establish that the LLC record is the entity named in the terms. Mapping the issuer string to the LLC would assert an identity the sources do not support.',
    probedAt: ALIAS_REVIEWED_AT,
    sourceUrl: 'https://www.paxos.com/terms-and-conditions/pax-gold-terms-conditions',
    version: ALIAS_VERSION,
  },
  {
    subject: 'cmc-issuer:68904e9cabae9b5b9fb358ac',
    subjectLabel: 'Tether Holdings',
    reason: 'no_register_record',
    evidence: 'GLEIF filter[entity.legalName]=TG Commodities Limited, the entity named in the Tether Gold fee schedule, returned 0 records. No LEI was found and none is asserted.',
    probedAt: ALIAS_REVIEWED_AT,
    sourceUrl: 'https://api.gleif.org/api/v1/lei-records',
    version: ALIAS_VERSION,
  },
  {
    subject: 'cmc-issuer:68905a7babae9b5b9fb35a8d',
    subjectLabel: 'Matrixdock',
    reason: 'no_register_record',
    evidence: 'GLEIF filter[entity.legalName]=Matrixdock returned 0 records. No LEI was found and none is asserted.',
    probedAt: ALIAS_REVIEWED_AT,
    sourceUrl: 'https://api.gleif.org/api/v1/lei-records',
    version: ALIAS_VERSION,
  },
  {
    subject: 'cmc-issuer:68904cceabae9b5b9fb35839',
    subjectLabel: 'Comtech Gold',
    reason: 'no_register_record',
    evidence: 'GLEIF filter[entity.legalName]=Comtech Gold returned 0 records. No LEI was found and none is asserted.',
    probedAt: ALIAS_REVIEWED_AT,
    sourceUrl: 'https://api.gleif.org/api/v1/lei-records',
    version: ALIAS_VERSION,
  },
]

/**
 * Register records that share a name stem with a mapped filer.
 *
 * Surfaced for HUMAN REVIEW, never joined to a token. This is how a lapsed
 * registration becomes visible without being attached to a product by
 * similarity, which is exactly the mistake this module refuses to make.
 */
export const NAME_COLLISIONS: readonly NameCollision[] = [
  {
    relatedSubject: 'token:eip155:1:0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e',
    stem: 'Superstate',
    entities: [
      { lei: '254900RYEZ47C0C0YO93', legalName: 'SUPERSTATE INC.', jurisdiction: 'US-DE', registrationStatus: 'ISSUED', sourceUrl: 'https://search.gleif.org/#/record/254900RYEZ47C0C0YO93' },
      { lei: '2549003P4H6K2FQ3UV85', legalName: 'Superstate Limited', jurisdiction: 'VG', registrationStatus: 'LAPSED', sourceUrl: 'https://search.gleif.org/#/record/2549003P4H6K2FQ3UV85' },
    ],
    note:
      'The EDGAR filer name for this token contains "Superstate Asset Trust". GLEIF holds two entities whose legal names begin with "Superstate": one US Delaware record with an ISSUED registration and one British Virgin Islands record whose registration is LAPSED. NEITHER has been shown to be the sponsor of this trust, and neither is asserted to be. They are listed so a reviewer can check the relationship at the register; a shared name stem is not a relationship.',
    probedAt: ALIAS_REVIEWED_AT,
    version: ALIAS_VERSION,
  },
]

const normalizeSubject = (value: unknown): string => String(value ?? '').trim().toLowerCase()

/** The mapping for a subject, or null. Exact subject equality only. */
export function resolveAlias(subject: unknown, at: number = Date.parse(ALIAS_REVIEWED_AT)): AliasAssertion | null {
  const key = normalizeSubject(subject)
  if (!key) return null
  const found = ALIAS_ASSERTIONS.find((a) => normalizeSubject(a.subject) === key)
  if (!found) return null
  // An expired assertion is not a mapping. It keeps its words for replay, but
  // it stops resolving until a later version restates it.
  return at >= Date.parse(found.assertedAt) && at < Date.parse(found.expiresAt) ? found : null
}

/** A deliberate non-mapping, if one was recorded for this subject. */
export function unmappedRecord(subject: unknown): UnmappedRecord | null {
  const key = normalizeSubject(subject)
  return UNMAPPED.find((u) => normalizeSubject(u.subject) === key) ?? null
}

export type AliasState = 'mapped' | 'deliberately_unmapped' | 'expired' | 'unknown'

/**
 * What we are willing to say about this subject's legal identity.
 *
 * 'unknown' means nobody has reviewed it. 'deliberately_unmapped' means somebody
 * did and the sources did not support a mapping. The two must never be
 * collapsed: the second is a finding.
 */
export function aliasState(subject: unknown, at: number = Date.parse(ALIAS_REVIEWED_AT)): AliasState {
  const key = normalizeSubject(subject)
  if (!key) return 'unknown'
  if (resolveAlias(key, at)) return 'mapped'
  if (ALIAS_ASSERTIONS.some((a) => normalizeSubject(a.subject) === key)) return 'expired'
  if (unmappedRecord(key)) return 'deliberately_unmapped'
  return 'unknown'
}

/** Name collisions recorded against a mapped subject. */
export const collisionsFor = (subject: unknown): NameCollision[] => {
  const key = normalizeSubject(subject)
  return NAME_COLLISIONS.filter((c) => normalizeSubject(c.relatedSubject) === key)
}

const LEI = /^[0-9A-Z]{18}[0-9]{2}$/
const CIK = /^[0-9]{10}$/

/**
 * Structural problems in the map, for the test to assert is empty.
 *
 * This is the guard that keeps a future edit honest: a duplicate subject, a
 * malformed identifier, a review window that is not seven days, a subject that
 * is both asserted and recorded as unmapped, or an assertion with no evidence.
 */
export function aliasProblems(): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const a of ALIAS_ASSERTIONS) {
    const key = normalizeSubject(a.subject)
    if (seen.has(key)) problems.push(`${a.subject}: asserted more than once`)
    seen.add(key)
    if (!a.entity.lei && !a.entity.cik) problems.push(`${a.subject}: mapping carries no identifier`)
    if (a.entity.lei && !LEI.test(a.entity.lei)) problems.push(`${a.subject}: malformed LEI`)
    if (a.entity.cik && !CIK.test(a.entity.cik)) problems.push(`${a.subject}: malformed CIK`)
    if (!a.entity.sourceUrl.startsWith('https://')) problems.push(`${a.subject}: mapping has no https source`)
    // An assertion with no stated comparison is unreviewable, which defeats the
    // entire point of the map.
    if (a.evidence.trim().length < 60) problems.push(`${a.subject}: evidence is too thin to review`)
    if (!a.assertedBy.trim()) problems.push(`${a.subject}: no asserter recorded`)
    if (Date.parse(a.expiresAt) - Date.parse(a.assertedAt) !== ALIAS_REVIEW_WINDOW_MS) problems.push(`${a.subject}: review window must be seven days`)
  }
  for (const u of UNMAPPED) {
    if (seen.has(normalizeSubject(u.subject))) problems.push(`${u.subject}: recorded as both mapped and unmapped`)
    if (u.evidence.trim().length < 60) problems.push(`${u.subject}: non-mapping needs the probe that stopped it`)
  }
  for (const e of VERIFIED_ENTITIES) {
    if (e.lei && !LEI.test(e.lei)) problems.push(`${e.legalName}: malformed LEI`)
    if (e.cik && !CIK.test(e.cik)) problems.push(`${e.legalName}: malformed CIK`)
  }
  for (const c of NAME_COLLISIONS) {
    if (!ALIAS_ASSERTIONS.some((a) => normalizeSubject(a.subject) === normalizeSubject(c.relatedSubject))) {
      problems.push(`${c.stem}: collision recorded against an unmapped subject`)
    }
  }
  return problems
}
