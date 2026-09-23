// The Vitest run of the Investor Intel frontend tests in production-source/.
//
// Run it with `npm run test:vitest`, which runs Vitest from inside
// production-source/. That folder has the private repository's layout, and one
// test reads a translation file by its path from the repository root, as it
// does there.
//
// Which tests: production-source/runnable-vitest-tests.txt, written by the
// packaging script (scripts/intel-extraction-test-run.mjs decides). Every other
// Vitest file is listed with its reason in production-source/excluded-tests.md.
//
// Stand-ins: some Intel modules import a module of the private parent platform.
// This applies the reviewed map in test-support/deno.json, the one the Deno run
// uses: for an importer inside production-source/ only, such an import resolves
// to a TEST STAND-IN in test-support/stand-ins/, which only lets the module load.
// Every export throws when used, and any use fails the run. The published source
// is unchanged.
//
// Offline: test-support/vitest-offline.mjs replaces the network globals with
// ones that fail the test. The tests hand the code under test a fake network.
//
// The rest mirrors the private repository's Vitest configuration: the node
// environment by default (the two page tests ask for jsdom themselves) and
// global test functions.
import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(here, '..', 'production-source')
const SCOPE = '../production-source/'
const reviewedMap = JSON.parse(readFileSync(path.join(here, 'deno.json'), 'utf8')).scopes[SCOPE]
const standIns = new Map(Object.entries(reviewedMap).map(([parent, standIn]) => [path.resolve(here, parent), path.resolve(here, standIn)]))
// How Vite resolves an import written without its extension (the planner uses the same list).
const EXTENSIONS = ['', '.js', '.jsx', '.mjs', '.ts', '.tsx', '/index.js', '/index.jsx', '/index.ts']
const insideSource = file => {
  const relative = path.relative(sourceRoot, file)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
const runnable = readFileSync(path.join(sourceRoot, 'runnable-vitest-tests.txt'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(file => file.replace(/^production-source\//, ''))

export default defineConfig({
  root: sourceRoot,
  // Keep Vite's cache in the package's own node_modules, not inside production-source/.
  cacheDir: path.resolve(here, '..', 'node_modules', '.vite'),
  plugins: [{
    name: 'investor-intel-test-stand-ins',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      const from = importer.split('?')[0]
      if (!insideSource(from)) return null
      const target = path.resolve(path.dirname(from), source.split('?')[0])
      for (const extension of EXTENSIONS) {
        const standIn = standIns.get(target + extension)
        if (standIn) return standIn
      }
      return null
    },
  }],
  test: {
    include: runnable,
    environment: 'node',
    globals: true,
    setupFiles: [path.join(here, 'vitest-offline.mjs')],
    // The two page tests render the whole Markets page, and their first render
    // compiles about ninety modules. That fits the default 5 s on a warm machine
    // but not always on a shared CI runner, so the ceiling is higher here.
    testTimeout: 30_000,
  },
})
