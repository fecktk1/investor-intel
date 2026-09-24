// Built for the hackathon: a recountable record of the Investor Intel files that
// make up the CoinMarketCap integration and the RWA and DEX lanes, and of what
// git history records about each one. Nothing in it is typed by hand: the
// packager (scripts/package-investor-intel-demo.mjs) writes it on every package,
// the package test (scripts/test-intel-extraction-package.mjs) recomputes it from
// git and fails on any difference, and anyone can recompute it from the public
// repository's history:
//
//   node production-source/scripts/intel-built-list.mjs --check
//
// Dates are the git author dates as recorded, shown in UTC. History is read,
// never rewritten.
//
// The scope is mechanical, so it cannot be tuned file by file. A product file
// (under src/ or supabase/) that ships in production-source/ is in scope when:
//   1. name: a path segment names a lane (cmc, coinmarketcap, rwa, capture, mcp,
//      dex), or a migration's name has one of those words as a token;
//   2. market-assets: it is in _shared/market-assets/, the market-data provider
//      layer that carries the CoinMarketCap integration;
//   3. mentions: its text mentions CoinMarketCap or CMC;
//   4. standalone: it is in the reviewed standalone subset the package ships
//      and tests on its own (the RWA lane and the CMC transport, closed under
//      imports).
// NAME_RULE_EXCEPTIONS only switch off rule 1 for a file whose name matches a
// lane word by accident; the other rules still apply. Only a file first
// committed during the event may be listed, so an exception can lower the count
// of new files and never hide an older one. The package test enforces that.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const EVENT_START = '2026-09-09T00:00:00Z'
export const BUILT_LIST_DOC = 'docs/built-for-the-hackathon.md'
export const BUILT_LIST_JSON = 'docs/built-for-the-hackathon.json'
export const PUBLIC_PREFIX = 'production-source/'
// The published history (git filter-repo, 2026-09-23) ends at private main
// commit a3250a0e (#249). In the public repository that commit is the first
// parent of the merge commit a21cc622 that joined the history in. Later work
// reaches the public repository in package commits, which bundle several private
// commits each.
export const HISTORY_CUT = Object.freeze({
  private: 'a3250a0e3f70578d6a2edac4016e4623c7970a1d',
  public: 'a21cc622ecbe850ea85abae0775e2358278a035c^1',
  publicLabel: 'a21cc62^1',
})
// The paths whose history was published on 2026-09-23 (docs/build-timeline.md,
// "What it includes"). A few platform modules outside them ship in the
// standalone subset because the RWA lane imports them; the public repository
// has no history for those before they first arrived in a package commit.
export const isHistoryPath = file => file.startsWith('src/intel/') || file.startsWith('supabase/functions/_shared/intel/') || file.startsWith('supabase/functions/_shared/market-assets/') || /^supabase\/functions\/intel-[^/]+\//.test(file) || /^supabase\/migrations\/([^/]*_)?intel[_.][^/]*$/.test(file) || /^supabase\/migrations\/[^/]*investor[^/]*$/.test(file) || /^src\/i18n\/locales\/[^/]+\/intel\.json$/.test(file)
// Known, documented differences between the private and the published history
// for a file whose history was published, as the published figure minus the
// private one.
export const PUBLIC_HISTORY_EXCEPTIONS = Object.freeze({
  'supabase/functions/_shared/intel/rwa-sources/http.ts': {
    commitsSinceEventInPublishedHistory: -1,
    why: 'a commit on 2026-09-22 only reworded a code comment. When the history was published, that comment\'s earlier wording was replaced with the new one in every earlier version (see build-timeline.md), so here the commit leaves the file unchanged and is not counted',
  },
})
export const NAME_RULE_EXCEPTIONS = Object.freeze({
  'supabase/migrations/20260911063342_intel_comparison_capture_retention.sql': 'chart snapshot retention: "capture" here names a saved chart comparison, not a capture lane',
})
const LANE_WORDS = ['cmc', 'coinmarketcap', 'rwa', 'capture', 'mcp', 'dex']
// A segment names a lane when it starts with a lane word (lower case, or
// capitalised for components) followed by a separator, a capital or the end.
const LANE_SEGMENT = new RegExp(String.raw`^(?:intel-)?(?:${LANE_WORDS.flatMap(word => [word, word[0].toUpperCase() + word.slice(1)]).join('|')}|CoinMarketCap)(?=[-_.A-Z]|$)`)
const AREA_ROOTS = ['src/intel/', 'supabase/functions/_shared/intel/', 'supabase/functions/_shared/market-assets/', 'supabase/functions/_shared/', 'supabase/functions/']
// CoinMarketCap by name, or CMC at the start of a word (cmc-transport, CMC_ID,
// cmcId). The same pattern in POSIX form is what the document tells readers to
// run with git grep.
const MENTIONS_CMC = /coinmarketcap|(?:^|[^a-z0-9_])cmc/im
export const MENTIONS_CMC_GREP = String.raw`coinmarketcap|(^|[^[:alnum:]_])cmc`
const PRODUCT = /^(?:src|supabase)\//
// Generated lists and the licence the packager writes into production-source/.
const GENERATED = new Set(['LICENSE.md', 'standalone-tests.txt', 'runnable-tests.txt', 'runnable-vitest-tests.txt', 'excluded-tests.md'])

export const AREAS = Object.freeze([
  ['cmc', 'CoinMarketCap modules (`_shared/market-assets/`)', file => file.startsWith('supabase/functions/_shared/market-assets/')],
  ['shared', 'Intel shared modules (`_shared/intel/` and other `_shared/`)', file => file.startsWith('supabase/functions/_shared/')],
  ['functions', 'Edge Functions (`supabase/functions/intel-*`)', file => file.startsWith('supabase/functions/')],
  ['migrations', 'Migrations (`supabase/migrations/`)', file => file.startsWith('supabase/migrations/')],
  ['frontend', 'Frontend (`src/intel/`)', file => file.startsWith('src/intel/')],
  ['translations', 'Translations (`src/i18n/locales/*/intel.json`)', file => file.startsWith('src/')],
])
const areaOf = file => AREAS.find(([, , test]) => test(file))[0]

export function nameRule(file) {
  if (file.startsWith('supabase/migrations/')) return path.posix.basename(file).replace(/\.sql$/, '').split('_').some(token => LANE_WORDS.includes(token.toLowerCase()))
  const root = AREA_ROOTS.find(prefix => file.startsWith(prefix)) || ''
  return file.slice(root.length).split('/').some(segment => LANE_SEGMENT.test(segment))
}

function git(repo, args, { allowFail = false } = {}) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, windowsHide: true })
  if (result.error || (result.status !== 0 && !allowFail)) throw Error(`git ${args.slice(0, 3).join(' ')} failed: ${result.error?.message || result.stderr}`)
  return result.status === 0 ? result.stdout : null
}
function gitAsync(repo, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repo, windowsHide: true })
    const out = [], err = []
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(Error(`git ${args.slice(0, 5).join(' ')} failed: ${Buffer.concat(err).toString('utf8')}`)))
  })
}
// Code-unit order, the same on every machine (localeCompare is not).
const byText = (a, b) => a < b ? -1 : a > b ? 1 : 0
const utc = iso => new Date(iso).toISOString().replace(/\.000Z$/, 'Z')
// Many `git show <commit>:<path>` reads in one process.
function blobs(repo, specs) {
  const result = spawnSync('git', ['cat-file', '--batch'], { cwd: repo, input: specs.join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024, windowsHide: true })
  if (result.error || result.status !== 0) throw Error(`git cat-file failed: ${result.error?.message || result.stderr}`)
  const out = result.stdout, texts = new Map()
  let offset = 0
  for (const spec of specs) {
    const end = out.indexOf(10, offset), header = out.subarray(offset, end).toString('utf8')
    offset = end + 1
    if (header.endsWith(' missing')) { texts.set(spec, null); continue }
    const size = Number(header.split(' ')[2])
    texts.set(spec, out.subarray(offset, offset + size).toString('utf8'))
    offset += size + 1
  }
  return texts
}

/** The published source and its standalone subset, read from a package's
 * SOURCE-MANIFEST.json (the public repository carries one at its root). */
export function publishedFromManifest(manifest) {
  const published = manifest.sourceFiles.filter(entry => entry.extracted.startsWith(PUBLIC_PREFIX)).map(entry => entry.extracted.slice(PUBLIC_PREFIX.length)).filter(file => !GENERATED.has(file))
  const fullSource = new Set(manifest.files.filter(entry => entry.role === 'full-source').map(entry => entry.file.slice(PUBLIC_PREFIX.length)))
  return { published: [...new Set(published)].sort(), standalone: published.filter(file => !fullSource.has(file)).sort() }
}

/** Which rules put each published file in scope. Paths are private-repository
 * paths (no production-source/ prefix); files are read from `repo`/`prefix`. */
export function scopeOf({ repo, prefix = '', published, standalone }) {
  const standaloneSet = new Set(standalone)
  const reasons = new Map()
  for (const file of published) {
    if (!PRODUCT.test(file)) continue
    const why = []
    if (nameRule(file) && !NAME_RULE_EXCEPTIONS[file]) why.push('name')
    if (file.startsWith('supabase/functions/_shared/market-assets/')) why.push('market-assets')
    if (MENTIONS_CMC.test(readFileSync(path.join(repo, prefix + file), 'utf8'))) why.push('mentions')
    if (standaloneSet.has(file)) why.push('standalone')
    if (why.length) reasons.set(file, why)
  }
  return reasons
}

/** Recompute every row from git. `cut` is the end of the published history in
 * this repository (HISTORY_CUT.private or HISTORY_CUT.public). */
export async function computeBuiltList({ repo, prefix = '', published, standalone, cut }) {
  const reasons = scopeOf({ repo, prefix, published, standalone })
  const files = [...reasons.keys()].sort()
  const full = file => prefix + file
  const dirs = [...new Set(files.map(file => path.posix.dirname(full(file))))].sort()
  if (git(repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true') throw Error('This needs the full history, and this clone is shallow. Run `git fetch --unshallow` first.')
  const cutCommit = git(repo, ['rev-parse', '--verify', `${cut}^{commit}`]).trim()
  // The main line as it stood when the event opened. The public history keeps
  // the private main line (commits that touch no Intel path were pruned, which
  // leaves every Intel path's content at this point unchanged).
  const base = git(repo, ['rev-list', '-1', '--first-parent', `--before=${EVENT_START}`, cutCommit]).trim()
  const inCut = new Set(git(repo, ['rev-list', cutCommit]).split(/\r?\n/).filter(Boolean))
  const wanted = new Set(files.map(full))
  const history = new Map(files.map(file => [full(file), { adds: [], since: [] }]))
  // One pass over every non-merge commit that touched these folders, renames
  // split into a removal and an addition, as `git log -- <file>` shows them.
  const log = git(repo, ['log', 'HEAD', '--no-merges', '--full-history', '--no-renames', '--format=%x01%H%x09%aI', '--name-status', '--', ...dirs])
  for (const chunk of log.split('\x01').slice(1)) {
    const [header, ...lines] = chunk.split(/\r?\n/)
    const [hash, authored] = header.split('\t'), date = utc(authored)
    for (const line of lines) {
      const [status, file] = line.split('\t')
      if (!file || !wanted.has(file)) continue
      const entry = history.get(file)
      if (status === 'A') entry.adds.push({ hash, date })
      if (date >= EVENT_START) entry.since.push(hash)
    }
  }
  const before = new Set(git(repo, ['ls-tree', '-r', '--name-only', base, '--', ...dirs]).split(/\r?\n/).filter(Boolean))
  const numstat = new Map()
  // Working tree against the pre-event state: the package copies the working
  // tree, so this is what it ships. Untracked files are counted from disk.
  for (const line of git(repo, ['diff', '--numstat', '--no-renames', base, '--', ...dirs]).split(/\r?\n/).filter(Boolean)) {
    const [added, removed, file] = line.split('\t')
    numstat.set(file, [added === '-' ? null : Number(added), removed === '-' ? null : Number(removed)])
  }
  const tracked = new Set(git(repo, ['ls-files', '--', ...dirs]).split(/\r?\n/).filter(Boolean))
  const rows = files.map(file => {
    const entry = history.get(full(file))
    // The earliest addition inside the published history if there is one, as
    // the documented command (run on $CUT) prints it; otherwise the earliest.
    const adds = entry.adds.sort((a, b) => byText(a.date, b.date) || byText(a.hash, b.hash))
    const first = adds.find(add => inCut.has(add.hash)) || adds[0] || null
    const existed = before.has(full(file))
    let [added, removed] = numstat.get(full(file)) || [0, 0]
    if (!tracked.has(full(file))) { added = readFileSync(path.join(repo, full(file)), 'utf8').split('\n').filter((line, i, all) => i < all.length - 1 || line).length; removed = 0 }
    return {
      path: file,
      area: areaOf(file),
      historyPublished: isHistoryPath(file),
      reasons: reasons.get(file),
      firstCommitted: first?.date || null,
      firstCommitInPublishedHistory: Boolean(first && isHistoryPath(file) && inCut.has(first.hash)),
      status: !existed ? 'new' : added || removed ? 'changed' : 'unchanged',
      linesAdded: added,
      linesRemoved: removed,
      commitsSinceEvent: entry.since.length,
      commitsSinceEventInPublishedHistory: isHistoryPath(file) ? entry.since.filter(hash => inCut.has(hash)).length : 0,
      _firstHash: first?.hash || null,
    }
  })
  // Provenance: was any new file created by moving or copying a file that
  // existed before the event? git's rename and copy detection, against every
  // file in the parent commit.
  const beforeAll = new Set(git(repo, ['ls-tree', '-r', '--name-only', base]).split(/\r?\n/).filter(Boolean))
  const byCommit = new Map()
  for (const row of rows.filter(row => row.status === 'new' && row._firstHash)) byCommit.set(row._firstHash, [...(byCommit.get(row._firstHash) || []), row])
  const commits = [...byCommit.keys()], outputs = new Map()
  // Copy detection against a whole tree takes about a second a commit, so a few
  // run at once.
  await Promise.all(Array.from({ length: Math.min(8, commits.length) }, async () => {
    for (let hash = commits.shift(); hash; hash = commits.shift()) outputs.set(hash, await gitAsync(repo, ['-c', 'diff.renameLimit=100000', 'diff-tree', '-r', '--root', '-M', '-C', '--find-copies-harder', '--name-status', '--no-commit-id', hash]))
  }))
  for (const [hash, commitRows] of byCommit) {
    const targets = new Map(commitRows.map(row => [full(row.path), row]))
    for (const line of outputs.get(hash).split(/\r?\n/)) {
      const [status, source, target] = line.split('\t')
      if (!/^[RC]\d+$/.test(status || '') || !targets.has(target) || !beforeAll.has(source)) continue
      targets.get(target).derivedFrom = { path: source.startsWith(prefix) ? source.slice(prefix.length) : source, similarity: Number(status.slice(1)), kind: status[0] === 'R' ? 'moved' : 'copied' }
    }
  }
  for (const row of rows) delete row._firstHash
  // Did a file that existed before the event already mention CoinMarketCap then?
  const earlier = blobs(repo, rows.filter(row => row.status !== 'new').map(row => `${base}:${full(row.path)}`))
  for (const row of rows) row.mentionedCmcBeforeEvent = row.status === 'new' ? null : MENTIONS_CMC.test(earlier.get(`${base}:${full(row.path)}`))
  const count = (list, status) => list.filter(row => row.status === status).length
  const totals = { files: rows.length, new: count(rows, 'new'), changed: count(rows, 'changed'), unchanged: count(rows, 'unchanged'),
    newDerivedFromOlder: rows.filter(row => row.derivedFrom).length,
    firstCommittedAfterPublishedHistory: rows.filter(row => row.historyPublished && row.firstCommitted && !row.firstCommitInPublishedHistory).length,
    uncommitted: rows.filter(row => !row.firstCommitted).length,
    preExistingThatMentionedCmc: rows.filter(row => row.mentionedCmcBeforeEvent).length,
    historyNotPublished: rows.filter(row => !row.historyPublished).length,
    byArea: Object.fromEntries(AREAS.map(([key]) => { const list = rows.filter(row => row.area === key); return [key, { files: list.length, new: count(list, 'new'), changed: count(list, 'changed'), unchanged: count(list, 'unchanged') }] })) }
  // A file present before the event must have been committed before it, and a
  // file absent then must have been committed after it. Any exception is listed.
  const mismatches = rows.filter(row => row.firstCommitted && ((row.status === 'new') !== (row.firstCommitted >= EVENT_START))).map(row => row.path)
  return { eventStart: EVENT_START, totals, mismatches, rows }
}

/** The published JSON twin: exactly the computed record, nothing added. */
export const builtListJson = result => JSON.stringify({
  about: 'Investor Intel product files in production-source/ that belong to the CoinMarketCap integration and the RWA and DEX lanes, with what git history records about each. Generated by production-source/scripts/intel-built-list.mjs. docs/built-for-the-hackathon.md gives the scope rule and the commands that recompute every field.',
  eventStart: result.eventStart,
  publishedHistoryEnds: HISTORY_CUT.publicLabel,
  scope: { rules: SCOPE_RULES.map(([key]) => key), laneWords: LANE_WORDS, mentionsPattern: MENTIONS_CMC_GREP, nameRuleExceptions: NAME_RULE_EXCEPTIONS },
  publicHistoryExceptions: PUBLIC_HISTORY_EXCEPTIONS,
  totals: result.totals,
  mismatches: result.mismatches,
  files: result.rows,
}, null, 2) + '\n'

const SCOPE_RULES = [
  ['name', 'name'],
  ['market-assets', 'market-assets'],
  ['mentions', 'mentions CMC'],
  ['standalone', 'standalone subset'],
]
const REASON_TEXT = Object.fromEntries(SCOPE_RULES)
// Published-history commits first, as the documented command counts them.
const commitsCell = row => !row.historyPublished ? `${row.commitsSinceEvent}, not published` : row.commitsSinceEvent > row.commitsSinceEventInPublishedHistory ? `${row.commitsSinceEventInPublishedHistory} + ${row.commitsSinceEvent - row.commitsSinceEventInPublishedHistory} later` : `${row.commitsSinceEvent}`
const fmtDate = iso => iso ? iso.replace('T', ' ').replace(/:\d\dZ$/, '') : 'not committed yet'
const yesNo = value => value ? 'yes' : 'no'
function tableOf(rows, { before = false } = {}) {
  const head = ['File', 'First commit (UTC)', ...(before ? ['Mentioned CMC before the event'] : []), 'Lines added', 'Lines removed', 'Commits since 2026-09-09', 'In scope by']
  const align = ['---', '---', ...(before ? ['---'] : []), '---:', '---:', '---:', '---']
  const cells = row => [
    `\`${row.path}\`${row.derivedFrom ? ` (${row.derivedFrom.kind} from \`${row.derivedFrom.path}\`, ${row.derivedFrom.similarity}% similar)` : ''}`,
    `${fmtDate(row.firstCommitted)}${!row.historyPublished ? ' †' : row.firstCommitted && !row.firstCommitInPublishedHistory ? ' *' : ''}`,
    ...(before ? [yesNo(row.mentionedCmcBeforeEvent)] : []),
    row.linesAdded ?? 'binary', row.linesRemoved ?? 'binary', commitsCell(row),
    row.reasons.map(reason => REASON_TEXT[reason]).join(', '),
  ]
  return [head, align, ...rows.map(cells)].map(line => `| ${line.join(' | ')} |`).join('\n')
}

/** The human-readable record. Its only "N files" phrase is the totals sentence,
 * which the package test checks like every other stated count. */
export function builtListMarkdown(result) {
  const { totals, rows } = result
  const group = status => rows.filter(row => row.status === status)
  const older = rows.filter(row => row.status !== 'new').sort((a, b) => byText(a.firstCommitted, b.firstCommitted) || byText(a.path, b.path))
  const mentionedBefore = older.filter(row => row.mentionedCmcBeforeEvent)
  const exceptions = Object.entries(NAME_RULE_EXCEPTIONS)
  const notPublished = rows.filter(row => !row.historyPublished)
  const notPublishedNote = notPublished.length ? `- **Files without published history.** ${notPublished.map(row => `\`${row.path}\` (first committed ${(row.firstCommitted || "not yet").slice(0, 10)}, ${row.status === 'new' ? 'new during the event' : 'existed before the event'})`).join(', ')} are parent-platform modules outside the Investor Intel paths. The RWA lane imports them, so they ship in the standalone subset, but their history was not published. Here each first appears in a package commit and so looks new. This record keeps their private history instead, marked \`†\`, because that is the less favourable reading: ${notPublished.filter(row => row.status !== 'new').length} of them existed before the event. \`--check\` can only confirm their scope and that they arrived after the published history.\n` : ''
  const exceptionNotes = Object.entries(PUBLIC_HISTORY_EXCEPTIONS).map(([file, { why, commitsSinceEventInPublishedHistory: delta }]) => `- **\`${path.posix.basename(file)}\`.** Its commit count here is ${Math.abs(delta)} ${delta < 0 ? 'lower' : 'higher'}: ${why}. \`--check\` allows for exactly this.\n`).join('')
  return `# Built for the hackathon

This is the per-file record behind [the build timeline](build-timeline.md). It lists the Investor Intel product files in \`production-source/\` that belong to the CoinMarketCap integration or to the RWA and DEX lanes. For each one it gives what git history records: when the file was first committed, whether it existed before the event, and how much of it changed during the event.

Nothing in it is typed by hand. \`production-source/scripts/intel-built-list.mjs\` writes it, and its machine-readable twin [\`built-for-the-hackathon.json\`](built-for-the-hackathon.json), every time the package is built. The package test recomputes both from git and fails if any row or total differs. The commands below recompute them from this repository's history.

## Totals

**${totals.files} files are in scope: ${totals.new} were first committed during the event, ${totals.changed} existed before it and were changed during it, and ${totals.unchanged} existed before it and are unchanged.**

The event opened for submissions on 2026-09-09 at 00:00 UTC. Dates are git author dates as recorded, shown in UTC.

| Area | New | Pre-existing, changed | Pre-existing, unchanged | Total |
|---|---:|---:|---:|---:|
${AREAS.map(([key, label]) => { const area = totals.byArea[key]; return `| ${label} | ${area.new} | ${area.changed} | ${area.unchanged} | ${area.files} |` }).join('\n')}
| **All** | **${totals.new}** | **${totals.changed}** | **${totals.unchanged}** | **${totals.files}** |

${totals.newDerivedFromOlder ? 'Some new files were created by moving or copying a file that existed before the event. Each is marked in its row.' : 'No new file was created by moving or copying a file that existed before the event. This was checked with git\'s rename and copy detection (`-M -C --find-copies-harder`) on the commit that added each one.'}
${result.mismatches.length ? `\nThe main line and the first commit disagree for ${result.mismatches.map(file => `\`${file}\``).join(', ')}: the status follows the main line when the event opened.\n` : ''}
## What existed before the event

These in-scope files existed before 2026-09-09, oldest first.

${mentionedBefore.length ? `Before the event, only these of them mentioned CoinMarketCap at all, some only in a comment or a label: ${mentionedBefore.map(row => `\`${row.path}\``).join(', ')}.` : 'None of them mentioned CoinMarketCap before the event.'} The CoinMarketCap client among them is \`coinmarketcap-provider.ts\`, the narrow v1 listings and global-metrics adapter. The rest are in scope for another reason, given in the last column: they mention CoinMarketCap now but did not before the event, or they are market-data modules or part of the standalone subset.

${tableOf(older, { before: true })}

## Scope rule

A file is in scope when it is Investor Intel product code in \`production-source/\` (under \`src/\` or \`supabase/\`) and at least one rule holds. The packaging scripts in \`production-source/scripts/\` are not product code and are left out. The rules are mechanical: \`intel-built-list.mjs\` applies them to the published tree.

- **name**: a path segment below \`src/intel/\`, \`supabase/functions/_shared/\` or \`supabase/functions/\` starts with a lane word (${LANE_WORDS.map(word => `\`${word}\``).join(', ')}). Examples are \`cmc-transport.ts\`, \`capture-rwa-depth.ts\`, \`rwa-sources/gleif.ts\`, \`intel-mcp-demo/\` and \`RwaDepth.jsx\`. For a migration, one of those words must be a token of its name, as in \`intel_rwa_depth\`.
- **market-assets**: the file is in \`supabase/functions/_shared/market-assets/\`, the market-data provider layer that carries the CoinMarketCap integration.
- **mentions CMC**: the file's text mentions CoinMarketCap, or CMC at the start of a word. This is the widest rule. It catches every module that calls, stores, labels or tests CoinMarketCap data, older ones included. To list these files: \`git grep -l -i -E '${MENTIONS_CMC_GREP}' HEAD -- production-source/src production-source/supabase\`.
- **standalone subset**: the RWA lane and the CMC transport as the package ships and tests them on their own, closed under imports. \`SOURCE-MANIFEST.json\` lists them as the \`production-source/\` files without the \`full-source\` role.
${exceptions.length ? `\nThe name rule is switched off for ${exceptions.map(([file, why]) => `\`${file}\` (${why})`).join('; ')}. The other rules still apply to it. Only a file first committed during the event may be listed here, so this can lower the count of new files and never hide an older one. The package test enforces that.\n` : ''}
## How each column is computed

Every figure for a file whose history was published (all but the files marked \`†\`) can be recomputed from this repository's history. In bash (Git Bash on Windows), from the repository root:

\`\`\`bash
CUT=${HISTORY_CUT.publicLabel}   # where the published history ends: the first parent of the merge that published it
B=$(git rev-list -1 --first-parent --before=${EVENT_START} $CUT)   # the main line when the event opened
F=production-source/supabase/functions/_shared/market-assets/coinmarketcap-provider.ts

# First commit (UTC)
TZ=UTC git log --full-history --diff-filter=A --date='format-local:%Y-%m-%d %H:%M' --format=%ad $CUT -- $F | sort | head -n 1
# Existed before the event? Prints "existed" or "new".
git cat-file -e "$B:$F" 2>/dev/null && echo existed || echo new
# Lines added and removed since the event. No output means unchanged.
git diff --numstat "$B" HEAD -- $F
# Commits since the event
TZ=UTC git log --no-merges --full-history --date='format-local:%Y-%m-%d %H:%M' --format=%ad $CUT -- $F | awk '$0 >= "2026-09-09"' | wc -l
\`\`\`

To recompute every row and total and compare them with \`built-for-the-hackathon.json\`, run \`node production-source/scripts/intel-built-list.mjs --check\` (Node.js 24, in a full clone rather than a \`--depth 1\` one). It prints each difference and exits with an error if there is one.

- **Status.** New: absent from the main line as it stood when the event opened (\`$B\`). Pre-existing and changed: present then, different now. Pre-existing and unchanged: byte for byte the same.
- **First commit.** The earliest author date of a commit that added the file at this path.
- **Mentioned CMC before the event.** Whether the file as it stood at \`$B\` matches the mentions pattern above.
- **Lines added and removed.** The net difference between the file when the event opened (nothing, for a new file) and the file now. Changes made and later undone are not counted.
- **Commits since 2026-09-09.** Commits that changed the file and were authored on or after 2026-09-09, merge commits aside. The first figure counts those in the published history, which is what the command prints. "+ N later" adds the commits made after the history was published.

## What the public history shows differently

This repository's history was published on 2026-09-23 and ends at \`${HISTORY_CUT.publicLabel}\`. Later work reaches it in package commits, and each package commit bundles several commits of the private repository. So for work after that point, this repository shows fewer, later commits than this record:

- **First commit.** ${totals.firstCommittedAfterPublishedHistory ? `Some files were first committed after the history was published (the JSON gives the count as \`firstCommittedAfterPublishedHistory\`). Their dates are marked \`*\` and come from the private repository. Here, each first appears in the package commit that shipped it, which is later. Each of them is new during the event either way. To see that package commit, run the first-commit command with \`HEAD\` in place of \`$CUT\`. For every other file, the date here is exactly what the command prints.` : 'Every file was first committed inside the published history, so every date here is exactly what the command prints.'}
- **Commits.** The count includes commits made after the history was published, which arrive here inside package commits. The command above counts the commits in the published history. The JSON gives that count as \`commitsSinceEventInPublishedHistory\`, and \`intel-built-list.mjs --check\` compares it.
- **Status, lines and scope** do not depend on this. They compare file contents, which are the same in both repositories.
${notPublishedNote}${exceptionNotes}
## New during the event

${tableOf(group('new'))}

## Pre-existing, changed during the event

${tableOf(group('changed'))}

## Pre-existing, unchanged

${tableOf(group('unchanged'))}
`
}

/** Write both files into `dir` (the example folder). */
export function writeBuiltList(dir, result) {
  writeFileSync(path.join(dir, BUILT_LIST_JSON), builtListJson(result))
  writeFileSync(path.join(dir, BUILT_LIST_DOC), builtListMarkdown(result))
}

/** Check a published record against a recomputation from the public
 * repository's history. Scope must match exactly. For a file whose history was
 * published, status, lines, the pre-event mention and the published-history
 * commit count must match (allowing PUBLIC_HISTORY_EXCEPTIONS), and so must the
 * first commit when it falls inside the published history; a later one must
 * fall after the event opened. A file whose history was not published can only
 * be checked for scope and for arriving after the published history. The
 * record's totals must be the counts of its own rows. Returns the differences
 * and the files that could not be checked in full. */
export function compareBuiltList(record, recomputed) {
  const problems = [], partial = []
  const mine = new Map(recomputed.rows.map(row => [row.path, row]))
  const theirs = new Map(record.files.map(row => [row.path, row]))
  for (const file of theirs.keys()) if (!mine.has(file)) problems.push(`${file}: listed, but not in scope when recomputed`)
  for (const file of mine.keys()) if (!theirs.has(file)) problems.push(`${file}: in scope when recomputed, but not listed`)
  const differs = (file, field, expected, actual) => { if (JSON.stringify(expected) !== JSON.stringify(actual)) problems.push(`${file}: ${field} is ${JSON.stringify(expected)} in the record, ${JSON.stringify(actual)} recomputed`) }
  for (const [file, row] of theirs) {
    const now = mine.get(file)
    if (!now) continue
    for (const field of ['area', 'historyPublished', 'reasons']) differs(file, field, row[field], now[field])
    if (!row.historyPublished) {
      partial.push(file)
      if (!(now.firstCommitted >= EVENT_START)) problems.push(`${file}: the record says its history was not published, but here it was first committed ${now.firstCommitted}, before the event`)
      continue
    }
    for (const field of ['status', 'mentionedCmcBeforeEvent', 'linesAdded', 'linesRemoved']) differs(file, field, row[field], now[field])
    differs(file, 'commitsSinceEventInPublishedHistory', row.commitsSinceEventInPublishedHistory + (PUBLIC_HISTORY_EXCEPTIONS[file]?.commitsSinceEventInPublishedHistory || 0), now.commitsSinceEventInPublishedHistory)
    if (row.firstCommitInPublishedHistory) for (const field of ['firstCommitted', 'firstCommitInPublishedHistory']) differs(file, field, row[field], now[field])
    else if (now.firstCommitInPublishedHistory || !(now.firstCommitted >= EVENT_START)) problems.push(`${file}: first committed ${now.firstCommitted} here, but the record says after the published history, during the event`)
  }
  const rows = record.files, count = status => rows.filter(row => row.status === status).length
  for (const [field, value] of [['files', rows.length], ['new', count('new')], ['changed', count('changed')], ['unchanged', count('unchanged')]]) if (record.totals[field] !== value) problems.push(`totals.${field} is ${record.totals[field]}, but the record lists ${value}`)
  return { problems, partial }
}

// CLI. In the public repository this file sits at production-source/scripts/;
// run it from anywhere inside that repository.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const repo = path.resolve(option('--repo') || (path.basename(path.dirname(scriptDir)) === 'production-source' ? path.join(scriptDir, '..', '..') : process.cwd()))
  if (!existsSync(path.join(repo, 'SOURCE-MANIFEST.json')) || !existsSync(path.join(repo, 'production-source'))) {
    console.error('Run this in the public repository (it needs SOURCE-MANIFEST.json and production-source/), or pass --repo <path>.')
    process.exit(2)
  }
  const manifest = JSON.parse(readFileSync(path.join(repo, 'SOURCE-MANIFEST.json'), 'utf8'))
  const result = await computeBuiltList({ repo, prefix: PUBLIC_PREFIX, ...publishedFromManifest(manifest), cut: HISTORY_CUT.public })
  if (args.includes('--json')) { process.stdout.write(builtListJson(result)); process.exit(0) }
  const recordFile = option('--record') || path.join(repo, BUILT_LIST_JSON)
  if (!existsSync(recordFile)) { console.error(`No record at ${recordFile}.`); process.exit(2) }
  const { problems, partial } = compareBuiltList(JSON.parse(readFileSync(recordFile, 'utf8')), result)
  const shown = path.relative(repo, recordFile).replaceAll('\\', '/') || recordFile
  console.log(`Recomputed ${result.rows.length} in-scope files from this repository's history.`)
  if (partial.length) console.log(`${partial.length} of them have no published history, so only their scope and their arrival after the published history were checked: ${partial.join(', ')}.`)
  if (problems.length) { console.error(`${problems.length} differences from ${shown}:\n${problems.join('\n')}`); process.exit(1) }
  console.log(`Every other row, and every total, matches ${shown}.`)
}
