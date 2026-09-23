// The published test run for the Investor Intel extraction.
//
// production-source/ carries all of Investor Intel. Every test in it runs in
// public CI unless production-source/excluded-tests.md lists it with the reason:
// the Deno tests (*.test.ts) and the React frontend's Vitest tests (*.test.js,
// *.test.jsx). This module decides which, from the source alone, so the list is
// reproducible:
//
//   1. A test runs when every module it loads is in the package. The one
//      allowance is a module of the private parent platform that has a reviewed
//      TEST STAND-IN in test-support/stand-ins/, mapped for the test runs only by
//      the scoped import map in test-support/deno.json. The Vitest run applies
//      the same map (test-support/vitest.config.mjs), so there is one reviewed
//      list of stand-ins for both runners.
//   2. A stand-in only lets an import load. Every export throws when used and any
//      use fails the run (test-support/stand-ins/unavailable.ts), so a test that
//      passes never reached one. Checked here: a stand-in never sits at a
//      published path, stands in only for a tracked parent-platform module, starts
//      with the TEST STAND-IN header, and exports only names the real module
//      exports.
//   3. A test that loads a parent module with no stand-in, reads a parent file's
//      source, needs a name its stand-in does not provide, or (Vitest) imports an
//      npm package the package.json does not install is excluded here, with that
//      reason, automatically.
//   4. A test that loads but still cannot pass here (it calls a stand-in, or it
//      fails in the private repository too) is excluded by a reviewed entry in
//      test-support/excluded-tests.json. The packaging test runs the rest, so a
//      missing entry fails packaging rather than publishing a red run.
//
// Nothing here writes files; the packager writes what this returns.

import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'

export const STAND_IN_HEADER = '// TEST STAND-IN: not the production module; used only so the published Investor Intel tests can run without the private platform.'
export const TEST_SUPPORT_DIR = 'test-support'
export const TEST_CONFIG = 'test-support/deno.json'
export const RUNNABLE_TESTS = 'production-source/runnable-tests.txt'
export const RUNNABLE_VITEST_TESTS = 'production-source/runnable-vitest-tests.txt'
export const VITEST_CONFIG = 'test-support/vitest.config.mjs'
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

/** Why a test does not run. The first four are decided here from the source;
 * the rest come only from a reviewed entry in test-support/excluded-tests.json. */
export const EXCLUSION_REASONS = Object.freeze({
  'parent-module': 'Imports a module of the private parent platform that is not in this repository and has no stand-in',
  'parent-source': 'Reads the source text of a parent-platform file that is not in this repository',
  'stand-in-gap': 'Uses a part of a parent-platform module that its stand-in does not provide',
  'npm-package': 'Imports an npm package that this repository does not install',
  'stand-in-reached': 'Calls into a parent-platform module; the stand-in refuses the call, so the test cannot pass here',
  'fails-privately': 'Fails in the private repository too',
  'network': 'Needs network access',
  'database': 'Needs a live database',
  'secrets': 'Needs secrets',
})
const AUTOMATIC_REASONS = ['parent-module', 'parent-source', 'stand-in-gap', 'npm-package']
const REVIEWED_REASONS = new Set(['stand-in-reached', 'fails-privately', 'network', 'database', 'secrets'])
/** Which runner a published test file belongs to. */
export const testRunner = file => /\.test\.ts$/.test(file) ? 'deno' : /\.test\.[cm]?jsx?$/.test(file) ? 'vitest' : null
// How Vite (and so Vitest) resolves a relative import written without its extension.
const VITE_RESOLVE = ['', '.js', '.jsx', '.mjs', '.ts', '.tsx', '/index.js', '/index.jsx', '/index.ts']
const CODE_FILE = /\.[cm]?[jt]sx?$/

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
 * Returns { runnable, vitestRunnable, excluded, testSupportFiles, standIns, markdown }:
 * runnable lists the Deno tests that run, vitestRunnable the Vitest tests, and
 * excluded every other test with its runner, reason and detail.
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
  // A Deno test imports each module by its exact path. A Vitest test goes through
  // Vite, which also resolves an import written without its extension, and loads
  // npm packages from node_modules, so those must be ones package.json installs.
  const exampleManifest = JSON.parse(readFileSync(path.join(example, 'package.json'), 'utf8'))
  const installed = new Set([...Object.keys(exampleManifest.dependencies || {}), ...Object.keys(exampleManifest.devDependencies || {})])
  const packageName = spec => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')
  const referencesOf = new Map()
  const references = file => {
    if (!referencesOf.has(file)) referencesOf.set(file, runtimeReferences(readFileSync(path.join(root, file), 'utf8')))
    return referencesOf.get(file)
  }
  // A folder a test reads (a migrations listing, its own directory) is there when
  // the package carries something inside it.
  const publishedFolder = folder => [...published].some(file => file.startsWith(folder))
  const blockersOf = (test, runner) => {
    const blockers = [], lacking = new Map(), seen = new Set([test]), queue = [test]
    while (queue.length) {
      const file = queue.shift()
      for (const ref of references(file)) {
        if (!ref.spec.startsWith('.')) {
          if (runner === 'deno') {
            if (!EXTERNAL_TEST_DEPENDENCIES.some(pattern => pattern.test(ref.spec))) throw Error(`Review external test dependency before packaging: ${file} -> ${ref.spec}`)
          } else if (!ref.spec.startsWith('node:') && !builtinModules.includes(ref.spec) && !installed.has(packageName(ref.spec))) {
            blockers.push({ reason: 'npm-package', detail: `\`${ref.spec}\`` })
          }
          continue
        }
        // Vite reads a query (`?url`, `?worker`) as a loading hint, not part of the path.
        const spec = runner === 'vitest' ? ref.spec.replace(/[?#].*$/, '') : ref.spec
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
        const candidates = runner === 'vitest' && ref.kind === 'import' ? VITE_RESOLVE.map(ext => target + ext) : [target]
        const found = candidates.find(candidate => published.has(candidate))
        if (found) {
          if (ref.kind === 'import' && CODE_FILE.test(found) && !seen.has(found)) { seen.add(found); queue.push(found) }
          continue
        }
        if (ref.kind === 'read' && ref.spec.endsWith('/') && publishedFolder(target === './' || target === '.' ? '' : target.replace(/\/?$/, '/'))) continue
        const parent = candidates.find(candidate => standIns.has(candidate))
        const standIn = ref.kind === 'import' && parent && standIns.get(parent)
        if (standIn) {
          const names = ref.whole ? ['the whole module'] : ref.names.filter(name => !standIn.exports.has(name))
          if (names.length) lacking.set(parent, new Set([...(lacking.get(parent) || []), ...names]))
          continue
        }
        const missing = candidates.find(candidate => trackedSet.has(candidate)) || target
        blockers.push({ reason: ref.kind === 'read' ? 'parent-source' : 'parent-module', detail: `\`${missing}\`` })
      }
    }
    for (const [target, names] of lacking) blockers.push({ reason: 'stand-in-gap', detail: `\`${target}\`: ${[...names].join(', ')}` })
    return blockers
  }

  const tests = [...published].filter(file => testRunner(file)).sort()
  const excluded = new Map()
  for (const test of tests) {
    const blockers = blockersOf(test, testRunner(test))
    if (!blockers.length) continue
    const reason = AUTOMATIC_REASONS.find(kind => blockers.some(blocker => blocker.reason === kind))
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
  const runnableFor = runner => tests.filter(test => testRunner(test) === runner && !excluded.has(test))
  const vitestRunnable = runnableFor('vitest')
  if (vitestRunnable.length && !testSupportFiles.includes(VITEST_CONFIG)) throw Error(`Vitest tests would run, but ${VITEST_CONFIG} is missing`)
  const count = runner => ({ total: tests.filter(test => testRunner(test) === runner).length, runnable: runnableFor(runner).length })
  return {
    runnable: runnableFor('deno').map(test => `production-source/${test}`),
    vitestRunnable: vitestRunnable.map(test => `production-source/${test}`),
    excluded: [...excluded].map(([test, entry]) => ({ file: `production-source/${test}`, runner: testRunner(test), ...entry })),
    testSupportFiles,
    standIns: [...standIns].map(([parent, entry]) => ({ parent, file: entry.file, exports: [...entry.exports] })),
    markdown: excludedMarkdown({ deno: count('deno'), vitest: count('vitest') }, excluded),
  }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

function excludedMarkdown(counts, excluded) {
  const rowsOf = runner => [...excluded].filter(([test]) => testRunner(test) === runner).sort(([a], [b]) => a.localeCompare(b))
  const deno = rowsOf('deno'), vitest = rowsOf('vitest')
  const lines = [
    '# Production-source tests that do not run in public CI',
    '',
    'Generated by `scripts/package-investor-intel-demo.mjs` (with `scripts/intel-extraction-test-run.mjs`). Do not edit by hand.',
    '',
    '`production-source/` holds all of Investor Intel. Public CI runs its tests offline and with no secrets:',
    '',
    `- ${counts.deno.runnable} of its ${plural(counts.deno.total, 'Deno test file')}, listed in \`production-source/runnable-tests.txt\`, without network permission;`,
    `- ${counts.vitest.runnable} of its ${plural(counts.vitest.total, 'Vitest test file')} (the React frontend's), listed in \`production-source/runnable-vitest-tests.txt\`, with the network globals replaced by ones that fail the test.`,
    '',
    `The ${plural(deno.length, 'Deno test file')} and ${plural(vitest.length, 'Vitest test file')} below do not run, each for the reason given.`,
    '',
    'Some Intel modules import a module of the private parent platform. For the test runs only, `test-support/deno.json` maps such an import to a TEST STAND-IN in `test-support/stand-ins/`, and `test-support/vitest.config.mjs` applies the same map to the Vitest run. A stand-in only lets the import load: every export throws when used, and any use fails the run. So a test that needs the parent module\'s behaviour is listed here, and a test that passes never reached a stand-in. The published production source is unchanged.',
    '',
  ]
  const needsOutside = ['network', 'database', 'secrets'].filter(reason => [...excluded.values()].some(entry => entry.reason === reason))
  if (!needsOutside.length) lines.push('No test is excluded for needing the network, a live database or secrets: the Intel tests hand their modules fakes.', '')
  for (const [reason, label] of Object.entries(EXCLUSION_REASONS)) {
    const rows = deno.filter(([, entry]) => entry.reason === reason)
    if (!rows.length) continue
    lines.push(`## ${label} (${plural(rows.length, 'file')})`, '', '| Test file | Detail |', '| --- | --- |')
    for (const [test, entry] of rows) lines.push(`| \`production-source/${test}\` | ${entry.detail.replaceAll('|', '\\|')} |`)
    lines.push('')
  }
  if (vitest.length) {
    lines.push(`## Vitest tests of the React frontend (${plural(vitest.length, 'file')})`, '', `Public CI runs the other ${counts.vitest.runnable} with \`npm run test:vitest\`, from inside \`production-source/\`, the way the private repository runs them from its root.`, '', '| Test file | Reason | Detail |', '| --- | --- | --- |')
    for (const [test, entry] of vitest) lines.push(`| \`production-source/${test}\` | ${EXCLUSION_REASONS[entry.reason]} | ${entry.detail.replaceAll('|', '\\|')} |`)
    lines.push('')
  }
  return lines.join('\n')
}
