// Publication guards for the Investor Intel hackathon extraction.
//
// Two rules, both fail closed, both applied by scripts/package-investor-intel-demo.mjs
// before a single byte is written to the package folder:
//
//   1. PRIVATE DOCUMENTS NEVER SHIP. The example folder holds two working files
//      that exist only for the owner: hackathon-submission.md (infrastructure
//      identifiers, historical release commands) and filing-checklist.md (owner
//      steps). They sit beside the public docs, so an allowlist alone is one
//      careless edit away from publishing them. The denylist is matched on the
//      file NAME as well as the path, so a copy moved elsewhere is refused too.
//
//   2. NO SECRET-SHAPED TEXT SHIPS. Every packaged text file is scanned. A match
//      stops packaging and names the file, the line and the pattern, never the
//      matched text itself, so the failure message cannot leak what it found.
//
// This module reads nothing and writes nothing; callers hand it paths and text.

import path from 'node:path'

/** Public documents copied from examples/investor-intel-hackathon/docs. */
export const PUBLIC_DOCS = Object.freeze([
  'docs/keyless-demo-mode.md',
  'docs/real-api-call.md',
  'docs/build-timeline.md',
  'docs/demo-guide.md',
  // The per-file record of what was built during the event and what existed
  // before it, and its JSON twin. The packager writes both from git history on
  // every package (scripts/intel-built-list.mjs); they are never edited by hand.
  'docs/built-for-the-hackathon.md',
  'docs/built-for-the-hackathon.json',
  // The full X post, because public embeds cut long posts short and hide its BUIDL link.
  'docs/x-post-2026-09-22.png',
])

/** Private working documents. Never packaged, whatever path they appear under.
 * The last five were filing preparation: the BUIDL is filed, the video is
 * recorded, and their unverified drafting markers must not reach judges. */
export const PRIVATE_DOCS = Object.freeze([
  'docs/hackathon-submission.md',
  'docs/filing-checklist.md',
  'docs/submission-requirements.md',
  'docs/judge-walkthrough.md',
  'docs/demo-video-script.md',
  'docs/buidl-description.md',
  'docs/licence-options.md',
])

/** An unresolved drafting marker is never published. It is assembled from two
 * parts because this file now ships in the full source, and the literal marker
 * would make the package refuse this very file. */
export const DRAFT_MARKER = ['[[VERIFY', 'AFTER-MERGE'].join('-')

const privateNames = new Set(PRIVATE_DOCS.map(file => path.posix.basename(file).toLowerCase()))

/** Package paths that the denylist refuses. Empty is the only passing result. */
export function deniedPackagePaths(files) {
  return files.filter(file => {
    const normal = String(file).replaceAll('\\', '/')
    return PRIVATE_DOCS.includes(normal) || privateNames.has(path.posix.basename(normal).toLowerCase())
  })
}

/** Binary assets carry no text to scan. Anything else is scanned as UTF-8. */
export const BINARY_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf'])

export function isBinaryPackagePath(file) {
  return BINARY_EXTENSIONS.includes(path.posix.extname(String(file).replaceAll('\\', '/')).toLowerCase())
}

/**
 * Named secret shapes. Each is deliberately broad: a false positive costs a
 * reviewed edit, a false negative publishes a credential.
 *
 * uuid_shaped_token covers CoinMarketCap API keys (UUID format) and also the
 * Netlify and Railway identifiers in the private submission record, which is
 * why no UUID of any kind may appear in the public package.
 */
export const SECRET_PATTERNS = Object.freeze([
  ['json_web_token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['supabase_secret_key', /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  ['service_role_key_assignment', /SERVICE_ROLE_KEY['"]?\s*[:=]\s*['"]?[A-Za-z0-9._-]{20,}/],
  ['supabase_project_url', /\b[a-z0-9]{20}\.supabase\.(?:co|in)\b/],
  ['supabase_project_ref_flag', /(?:project[-_]ref|projectRef)['"]?\s*[:= ]\s*['"]?[a-z0-9]{20}\b/i],
  ['cmc_key_assignment', /(?:X-CMC_PRO_API_KEY|CMC_API_KEY|COINMARKETCAP_API_KEY)['"]?\s*[:=]\s*['"]?[A-Za-z0-9-]{16,}/i],
  ['uuid_shaped_token', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['private_key_block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['openai_or_anthropic_key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['email_address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/],
])

/**
 * Exact values reviewed by hand and cleared for publication. Each is removed
 * from a line before the scan, so any other match on the same line still stops
 * packaging. Add a value only after reading every place it appears.
 */
export const REVIEWED_PUBLIC_VALUES = Object.freeze([
  // The product's published support address, sent to SEC EDGAR as its contact.
  'support@thecontentforge.io',
  // A retired EDGAR agent string kept so old imports resolve; never sent.
  'intel@thecontentforge.com',
  // Test fixtures: reserved or obviously fake addresses and a patterned fake key.
  'contact@example.test',
  'row@example.test',
  'x@y.io',
  'pass@data.sec.gov',
  '11111111-2222-3333-4444-555555555555',
  // A made-up reservation id in the reproduce-command test (cmc-reproduce.test.ts).
  '3f2c9a1e-8b7d-4c6e-9f00-1a2b3c4d5e6f',
  // The public, no-account MCP demo endpoint, published in the README on purpose
  // (reviewed 2026-09-23). Exactly this path: any other URL on the project host
  // still stops packaging.
  'andrimdaxlxcqgqdqrbz.supabase.co/functions/v1/intel-mcp-demo',
])

/**
 * Findings for one file: [{ file, line, pattern }]. The matched text is never
 * returned. An empty array is the only result that permits packaging.
 */
export function findSecretShapes(file, text) {
  const findings = []
  const lines = String(text).split(/\r?\n/)
    .map(line => REVIEWED_PUBLIC_VALUES.reduce((rest, value) => rest.split(value).join(''), line))
  lines.forEach((content, index) => {
    for (const [pattern, expression] of SECRET_PATTERNS) {
      if (expression.test(content)) findings.push({ file, line: index + 1, pattern })
    }
  })
  return findings
}

/**
 * The full Investor Intel source (production-source/ beyond the standalone
 * subset) ships for reading and for its history, and it carries test fixtures.
 * Two more kinds of value are cleared there, and only there: obviously synthetic
 * UUIDs (one repeated digit, or a digit followed by seven zeros, as in the
 * fixtures' 10000000-0000-4000-8000-000000000001 counters) and the exact values
 * below, each read in place on 2026-09-23. Every credential pattern still applies.
 */
export const SYNTHETIC_UUID = /\b(?:([0-9a-f])\1{7}|[0-9a-f]0{7})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

export const REVIEWED_FULL_SOURCE_VALUES = Object.freeze([
  // Fixture ids and one quoted request trace id. None is a key.
  'c161e12e-5a3d-43f3-a280-64eacc4a36f5', // alert-explanation-receipt.test.ts: event id
  'd204aaf9-ef74-4f93-a1c3-936d2c4be4f1', // chart-structure.test.ts: drawing id
  'd407b24f-c2d5-4e3a-9d96-79109903bcfe', // chart-outcome.test.ts: drawing id
  '6144432d-22f1-4d8a-91c7-d2ec5ebf76eb', // contract-identity-route.test.ts: trace id quoted in a comment
  'a1bcd8b7-9287-4b26-ad64-70d2304a6a23', // investigation-receipt.test.ts: operation id
  'c1bcd8b7-9287-4b26-ad64-70d2304a6a23', // stress-scenario.test.ts: thesis id
  // The public logo mirror: a public storage bucket that the product's own pages load.
  'andrimdaxlxcqgqdqrbz.supabase.co/storage/v1/object/public/',
  // Placeholder addresses: localized examples in intel.json, reserved or made-up domains in tests and a migration comment.
  'du@beispiel.de', 'tu@ejemplo.com', 'vous@exemple.fr', 'tu@esempio.it', 'jij@voorbeeld.nl', 'voce@exemplo.com', 'ti@shembull.com',
  'you@example.com', 'a@b.co', 'ops@issuer.example.com',
])

/** findSecretShapes for a full-source file, after the full-source clearances above. */
export function findFullSourceSecretShapes(file, text) {
  const cleared = String(text).split(/\r?\n/)
    .map(line => REVIEWED_FULL_SOURCE_VALUES.reduce((rest, value) => rest.split(value).join(''), line).replace(SYNTHETIC_UUID, ''))
    .join('\n')
  return findSecretShapes(file, cleared)
}

/**
 * Throws with file, line and pattern names when any guard fails. An entry
 * flagged fullSource is scanned with findFullSourceSecretShapes.
 */
export function assertPublishable(entries) {
  const denied = deniedPackagePaths(entries.map(entry => entry.file))
  if (denied.length) throw Error(`Private document refused by the package denylist: ${denied.join(', ')}`)
  const drafts = entries.filter(entry => !isBinaryPackagePath(entry.file) && String(entry.text).includes(DRAFT_MARKER)).map(entry => entry.file)
  if (drafts.length) throw Error(`Unresolved drafting marker; nothing was packaged: ${drafts.join(', ')}`)
  const findings = entries
    .filter(entry => !isBinaryPackagePath(entry.file))
    .flatMap(entry => (entry.fullSource ? findFullSourceSecretShapes : findSecretShapes)(entry.file, entry.text))
  if (findings.length) {
    throw Error(`Secret-shaped text found; nothing was packaged: ${findings.map(f => `${f.file}:${f.line} (${f.pattern})`).join(', ')}`)
  }
}
