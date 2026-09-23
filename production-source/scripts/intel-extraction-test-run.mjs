// The published Deno test run for the Investor Intel extraction.
//
// production-source/ carries all of Investor Intel. Every Deno test in it runs in
// public CI unless production-source/excluded-tests.md lists it with the reason.
// This module decides which, from the source alone, so the list is reproducible:
//
//   1. A test runs when every module it loads is in the package. The one
//      allowance is a module of the private parent platform that has a reviewed
//      TEST STAND-IN in test-support/stand-ins/, mapped for the test run only by
//      the scoped import map in test-support/deno.json.
//   2. A stand-in only lets an import load. Every export throws when used and any
//      use fails the run (test-support/stand-ins/unavailable.ts), so a test that
//      passes never reached one. Checked here: a stand-in never sits at a
//      published path, stands in only for a tracked parent-platform module, starts
//      with the TEST STAND-IN header, and exports only names the real module
//      exports.
//   3. A test that loads a parent module with no stand-in, reads a parent file's
//      source, or needs a name its stand-in does not provide is excluded here,
//      with that reason, automatically.
//   4. A test that loads but still cannot pass here (it calls a stand-in, or it
//      fails in the private repository too) is excluded by a reviewed entry in
//      test-support/excluded-tests.json. The packaging test runs the rest, so a
//      missing entry fails packaging rather than publishing a red run.
//
// Nothing here writes files; the packager writes what this returns.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const STAND_IN_HEADER = '// TEST STAND-IN: not the production module; used only so the published Investor Intel tests can run without the private platform.'
export const TEST_SUPPORT_DIR = 'test-support'
export const TEST_CONFIG = 'test-support/deno.json'
export const RUNNABLE_TESTS = 'production-source/runnable-tests.txt'
export const EXCLUDED_TESTS = 'production-source/excluded-tests.md'
const REVIEWED_EXCLUSIONS = 'test-support/excluded-tests.json'
const STAND_IN_SCOPE = '../production-source/'

/** Remote modules a published test may load: fetched when the tests start, never
 * by a test (the run has no network permission). Anything else stops packaging. */
export const EXTERNAL_TEST_DEPENDENCIES = Object.freeze([
  /^https:\/\/deno\.land\/std@\d+\.\d+\.\d+\//,
  /^jsr:@std\/[a-z-]+(@\d[\w.-]*)?$/,
  /^npm:@supabase\/supabase-js@2$/,
  /^node:[a-z/_]+$/,
])

/** Why a test does not run. The first three are decided here from the source;
 * the rest come only from a reviewed entry in test-support/excluded-tests.json. */
export const EXCLUSION_REASONS = Object.freeze({
  'parent-module': 'Imports a module of the private parent platform that is not in this repository and has no stand-in',
  'parent-source': 'Reads the source text of a parent-platform file that is not in this repository',
  'stand-in-gap': 'Uses a part of a parent-platform module that its stand-in does not provide',
  'stand-in-reached': 'Calls into a parent-platform module; the stand-in refuses the call, so the test cannot pass here',
  'fails-privately': 'Fails in the private repository too',
  'network': 'Needs network access',
  'database': 'Needs a live database',
  'secrets': 'Needs secrets',
})
const REVIEWED_REASONS = new Set(['stand-in-reached', 'fails-privately', 'network', 'database', 'secrets'])

const posix = file => file.replaceAll('\\', '/')
const listTree = dir => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? listTree(path.join(dir, entry.name)) : [path.join(dir, entry.name)])

// A statement's `from` clause: `import {a, type B} from './x.ts'`, `export * from`.
// Anchored at a line start, so an import quoted inside a test's string is not one.
const IMPORT_FROM = /^[ \t]*(?:import|export)\b([^'"`;]*?)\bfrom\s*['"]([^'"]+)['"]/gm
const IMPORT_BARE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm
const IMPORT_DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const READ_URL = /\bnew URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g

/**
 * The references one module makes when it RUNS. The tests run with --no-check,
 * which erases type-only imports, so `import type` and imports whose every name
 * is `type` are not references. Each is { spec, kind: 'import'|'read', names, whole }:
 * `names` are the value names taken, `whole` means the module is taken whole
 * (a default, namespace, star or dynamic import).
 */
export function runtimeReferences(code) {
  const refs = []
  for (const [, clause, spec] of code.matchAll(IMPORT_FROM)) {
    const body = clause.trim()
    if (/^type[\s{*]/.test(body)) continue
    const braces = body.match(/\{([\s\S]*)\}/)
    const listed = braces ? braces[1].split(',').map(name => name.trim()).filter(Boolean) : []
    const names = listed.filter(name => !/^type\s/.test(name)).map(name => name.split(/\s+as\s+/)[0].trim())
    const outside = body.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ').trim()
    if (braces && listed.length && !names.length && !outside) continue
    refs.push({ spec, kind: 'import', names, whole: !braces || outside.length > 0 })
  }
  for (const [, spec] of code.matchAll(IMPORT_BARE)) refs.push({ spec, kind: 'import', names: [], whole: false })
  for (const [, spec] of code.matchAll(IMPORT_DYNAMIC)) refs.push({ spec, kind: 'import', names: [], whole: true })
  for (const [, spec] of code.matchAll(READ_URL)) refs.push({ spec, kind: 'read', names: [], whole: false })
  return refs
}

/** Value names a module exports (functions, classes, constants, export lists). */
export function exportedNames(code) {
  const names = new Set()
  for (const [, name] of code.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(name)
  for (const [, list] of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const item of list.split(',').map(part => part.trim()).filter(Boolean)) {
      if (!/^type\s/.test(item)) names.add(item.split(/\s+as\s+/).pop().trim())
    }
  }
  return names
}

/**
 * Plan the published test run.
 *   root             the private repository.
 *   example          the example folder the package is built from.
 *   publishedSource  repository paths copied to production-source/.
 *   tracked          every tracked repository path.
 *   isIntelSource    true for a path that belongs to Investor Intel itself.
 * Returns { runnable, excluded, testSupportFiles, standIns, markdown, vitestFiles }.
 */
export function planPublishedTestRun({ root, example, publishedSource, tracked, isIntelSource }) {
  const published = new Set(publishedSource)
  const trackedSet = new Set(tracked)

  // test-support/ ships as tracked files only, so a stray local file never does.
  const exampleRoot = posix(path.relative(root, example))
  const onDisk = listTree(path.join(example, TEST_SUPPORT_DIR)).map(file => posix(path.relative(example, file))).sort()
  const untracked = onDisk.filter(file => !trackedSet.has(`${exampleRoot}/${file}`))
  if (untracked.length) throw Error(`Review test-support files before packaging (not tracked by git): ${untracked.join(', ')}`)
  const testSupportFiles = onDisk

  // The config maps parent paths to stand-ins, for importers inside production-source/ only.
  const config = JSON.parse(readFileSync(path.join(example, TEST_CONFIG), 'utf8'))
  const unexpectedKeys = Object.keys(config).filter(key => !['nodeModulesDir', 'lock', 'scopes'].includes(key))
  if (unexpectedKeys.length) throw Error(`${TEST_CONFIG} may hold only nodeModulesDir, lock and scopes: ${unexpectedKeys.join(', ')}`)
  if (JSON.stringify(Object.keys(config.scopes || {})) !== JSON.stringify([STAND_IN_SCOPE])) throw Error(`${TEST_CONFIG} must have exactly one scope, "${STAND_IN_SCOPE}"`)
  const standIns = new Map()
  for (const [from, to] of Object.entries(config.scopes[STAND_IN_SCOPE])) {
    const parent = from.startsWith(STAND_IN_SCOPE) ? from.slice(STAND_IN_SCOPE.length) : null
    const standIn = to.startsWith('./stand-ins/') ? `${TEST_SUPPORT_DIR}/${to.slice(2)}` : null
    if (!parent || !standIn) throw Error(`${TEST_CONFIG}: every mapping goes from ${STAND_IN_SCOPE}<parent path> to ./stand-ins/<file>: ${from} -> ${to}`)
    if (published.has(parent)) throw Error(`A stand-in may never replace a published module: ${parent}`)
    if (isIntelSource(parent)) throw Error(`A stand-in may replace only a parent-platform module, never Investor Intel's own: ${parent}`)
    if (!trackedSet.has(parent)) throw Error(`A stand-in must replace a real, tracked parent-platform module: ${parent}`)
    if (!testSupportFiles.includes(standIn)) throw Error(`Stand-in file missing: ${standIn}`)
    const text = readFileSync(path.join(example, standIn), 'utf8')
    const exports = exportedNames(text)
    const real = exportedNames(readFileSync(path.join(root, parent), 'utf8'))
    const invented = [...exports].filter(name => !real.has(name))
    if (invented.length) throw Error(`Stand-in ${standIn} exports names the real module does not: ${invented.join(', ')}`)
    standIns.set(parent, { file: standIn, exports })
  }
  const standInFiles = testSupportFiles.filter(file => file.startsWith(`${TEST_SUPPORT_DIR}/stand-ins/`))
  for (const file of standInFiles) {
    if (!readFileSync(path.join(example, file), 'utf8').startsWith(STAND_IN_HEADER)) throw Error(`Stand-in lacks the TEST STAND-IN header on its first line: ${file}`)
  }
  const mapped = new Set([...standIns.values()].map(entry => entry.file))
  const orphans = standInFiles.filter(file => !mapped.has(file) && file !== `${TEST_SUPPORT_DIR}/stand-ins/unavailable.ts`)
  if (orphans.length) throw Error(`Stand-ins that nothing maps: ${orphans.join(', ')}`)

  // Walk each test's runtime graph and collect what stops it from loading here.
  const referencesOf = new Map()
  const references = file => {
    if (!referencesOf.has(file)) referencesOf.set(file, runtimeReferences(readFileSync(path.join(root, file), 'utf8')))
    return referencesOf.get(file)
  }
  // A folder a test reads (a migrations listing, its own directory) is there when
  // the package carries something inside it.
  const publishedFolder = folder => [...published].some(file => file.startsWith(folder))
  const blockersOf = test => {
    const blockers = [], lacking = new Map(), seen = new Set([test]), queue = [test]
    while (queue.length) {
      const file = queue.shift()
      for (const ref of references(file)) {
        if (!ref.spec.startsWith('.')) {
          if (!EXTERNAL_TEST_DEPENDENCIES.some(pattern => pattern.test(ref.spec))) throw Error(`Review external test dependency before packaging: ${file} -> ${ref.spec}`)
          continue
        }
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), ref.spec))
        if (published.has(target)) {
          if (ref.kind === 'import' && /\.[cm]?[jt]sx?$/.test(target) && !seen.has(target)) { seen.add(target); queue.push(target) }
          continue
        }
        if (ref.kind === 'read' && ref.spec.endsWith('/') && publishedFolder(target === './' || target === '.' ? '' : target.replace(/\/?$/, '/'))) continue
        const standIn = ref.kind === 'import' && standIns.get(target)
        if (standIn) {
          const names = ref.whole ? ['the whole module'] : ref.names.filter(name => !standIn.exports.has(name))
          if (names.length) lacking.set(target, new Set([...(lacking.get(target) || []), ...names]))
          continue
        }
        blockers.push({ reason: ref.kind === 'read' ? 'parent-source' : 'parent-module', detail: `\`${target}\`` })
      }
    }
    for (const [target, names] of lacking) blockers.push({ reason: 'stand-in-gap', detail: `\`${target}\`: ${[...names].join(', ')}` })
    return blockers
  }

  const tests = [...published].filter(file => file.endsWith('.test.ts')).sort()
  const excluded = new Map()
  for (const test of tests) {
    const blockers = blockersOf(test)
    if (!blockers.length) continue
    const reason = ['parent-module', 'parent-source', 'stand-in-gap'].find(kind => blockers.some(blocker => blocker.reason === kind))
    const details = [...new Set(blockers.filter(blocker => blocker.reason === reason).map(blocker => blocker.detail))]
    excluded.set(test, { reason, detail: details.join('; ') })
  }
  const reviewed = JSON.parse(readFileSync(path.join(example, REVIEWED_EXCLUSIONS), 'utf8'))
  for (const { file, reason, detail } of reviewed.tests) {
    const test = file.replace(/^production-source\//, '')
    if (!tests.includes(test)) throw Error(`${REVIEWED_EXCLUSIONS} names a test the package does not carry: ${file}`)
    if (!REVIEWED_REASONS.has(reason)) throw Error(`${REVIEWED_EXCLUSIONS}: unknown reason "${reason}" for ${file}`)
    if (!String(detail || '').trim()) throw Error(`${REVIEWED_EXCLUSIONS}: ${file} needs a detail`)
    if (excluded.has(test)) throw Error(`${REVIEWED_EXCLUSIONS}: ${file} is already excluded (${excluded.get(test).reason}); remove the reviewed entry`)
    excluded.set(test, { reason, detail })
  }
  const runnable = tests.filter(test => !excluded.has(test))
  // Browser-code tests written for Vitest: not Deno tests, and not part of this run.
  const vitestFiles = [...published].filter(file => /\.test\.[cm]?jsx?$/.test(file)).sort()
  return {
    runnable: runnable.map(test => `production-source/${test}`),
    excluded: [...excluded].map(([test, entry]) => ({ file: `production-source/${test}`, ...entry })),
    testSupportFiles,
    standIns: [...standIns].map(([parent, entry]) => ({ parent, file: entry.file, exports: [...entry.exports] })),
    vitestFiles: vitestFiles.map(file => `production-source/${file}`),
    markdown: excludedMarkdown(tests.length, runnable.length, excluded, vitestFiles),
  }
}

function excludedMarkdown(total, runnable, excluded, vitestFiles) {
  const lines = [
    '# Production-source tests that do not run in public CI',
    '',
    'Generated by `scripts/package-investor-intel-demo.mjs` (with `scripts/intel-extraction-test-run.mjs`). Do not edit by hand.',
    '',
    `\`production-source/\` holds all of Investor Intel. Public CI runs ${runnable} of its ${total} Deno test files, listed in \`production-source/runnable-tests.txt\`, offline, with no secrets and without network permission. The ${excluded.size} files below do not run, each for the reason given.`,
    '',
    'Some Intel modules import a module of the private parent platform. For the test run only, `test-support/deno.json` maps such an import to a TEST STAND-IN in `test-support/stand-ins/`. A stand-in only lets the import load: every export throws when used, and any use fails the run. So a test that needs the parent module\'s behaviour is listed here, and a test that passes never reached a stand-in. The published production source is unchanged.',
    '',
  ]
  const needsOutside = ['network', 'database', 'secrets'].filter(reason => [...excluded.values()].some(entry => entry.reason === reason))
  if (!needsOutside.length) lines.push('No test is excluded for needing the network, a live database or secrets: the Intel tests hand their modules fakes.', '')
  for (const [reason, label] of Object.entries(EXCLUSION_REASONS)) {
    const rows = [...excluded].filter(([, entry]) => entry.reason === reason).sort(([a], [b]) => a.localeCompare(b))
    if (!rows.length) continue
    lines.push(`## ${label} (${rows.length} ${rows.length === 1 ? 'file' : 'files'})`, '', '| Test file | Detail |', '| --- | --- |')
    for (const [test, entry] of rows) lines.push(`| \`production-source/${test}\` | ${entry.detail.replaceAll('|', '\\|')} |`)
    lines.push('')
  }
  if (vitestFiles.length) {
    lines.push(`## Browser-code tests written for Vitest (${vitestFiles.length} files)`, '', 'These test the React code with the private repository\'s Vitest setup. They are not Deno tests, and this repository has no Vitest, so they are there to read.', '')
    for (const file of vitestFiles) lines.push(`- \`production-source/${file}\``)
    lines.push('')
  }
  return lines.join('\n')
}
