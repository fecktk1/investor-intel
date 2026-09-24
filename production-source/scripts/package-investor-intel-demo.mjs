// Explicit source-only extraction. No recursive repository copy, credentials,
// customer data, production migrations, build output or node_modules enter it.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PUBLIC_DOCS, assertPublishable, deniedPackagePaths } from './intel-extraction-package-guards.mjs'
import { planPublishedTestRun, RUNNABLE_TESTS, RUNNABLE_VITEST_TESTS, EXCLUDED_TESTS } from './intel-extraction-test-run.mjs'
import { computeBuiltList, writeBuiltList, HISTORY_CUT } from './intel-built-list.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),example=path.join(root,'examples/investor-intel-hackathon')
// Explicit fail-closed boundaries keep private app providers out of the standalone package.
const adapters={
 'src/intel/components/ChartWatchlistAdd.jsx':'examples/investor-intel-hackathon/adapters/ChartWatchlistAdd.jsx',
 'src/intel/context/WatchlistSelection.jsx':'examples/investor-intel-hackathon/adapters/WatchlistSelection.js',
 'src/intel/lib/watchlist-api.js':'examples/investor-intel-hackathon/adapters/watchlist-api.js',
 // TokenChart imports one symbol from the working-state module, and that symbol is
 // pure. The module around it autosaves through Supabase and needs a client plus
 // user, org and asset identity, so the module itself must never enter this package.
 // The adapter carries the pure draft store alone; if TokenChart ever reaches for
 // more of that module, the check below fails on the new symbol rather than letting
 // backend coupling in quietly.
 'src/intel/lib/chart-working-state.js':'examples/investor-intel-hackathon/adapters/chart-working-state.js',
 // The component around that store exists only to write the chart back through
 // the intel-chart-workspace edge function, and it runs at all only for a context
 // carrying a Supabase client plus user and org identity. Strip the saving and
 // nothing is left, so it is refused rather than carried.
 'src/intel/components/ChartWorkingState.jsx':'examples/investor-intel-hackathon/adapters/ChartWorkingState.jsx',
 // The Share button on its own is pure, but its only purpose is to load
 // ChartSharePanel, which saves a version through requestChartWorkspace and then
 // manages audience, expiry and revocation through the same service. Refusing at
 // the launcher keeps that flow and its three share components out entirely.
 'src/intel/components/ChartShareLaunch.jsx':'examples/investor-intel-hackathon/adapters/ChartShareLaunch.jsx',
 // The post card's layout is pure and the adapter carries it, but the post text
 // is read by the intel-tweet-embed edge function through a Supabase client and
 // an org id. The adapter says that on the card instead, which keeps the private
 // reader out and avoids a card that waits on a read that will never arrive.
 'src/intel/components/ChartTweetCard.jsx':'examples/investor-intel-hackathon/adapters/ChartTweetCard.jsx',
}
// Discovery validates this explicit list; it never authorizes new copies.
const chartSources=[...Object.keys(adapters),
  ...['TokenChart','TokenChartFallback','JournalMarkerReceipt','ChartReplayControls','ResponsiveChartTools','EvidenceMarkerContext','PriceWorkstation','ChartDrawings','ChartLayoutLibrary','ChartAssetNavigator','TokenAvatar','ChartSnapshotSave','ChartAlertEditor','ChartStructurePanel','ChartOutcomePanel','InvestigationTable','ChartReadPanel','ChartPatternPanel','ChartTimeframePanel','deferred-panel','deferred-tool','ChartDrawingEditor','ChartDrawingSurface','ChartDrawingToolbar','ChartDrawingOptions','ChartDrawingMorePanel','ChartIndicatorDialog','ChartIndicatorMenu','ChartIndicatorPanel','ChartLayoutLaunch','ChartWatermark','ChartCandleProvenance','FigureProvenance','SourceCallReceipt','ReceiptCostLine','ReceiptParameters'].map(name=>`src/intel/components/${name}.jsx`),
  ...['chart-history','chart-event-changes','useChartAlertHistory','chart-workspace-api','chart-replay','chart-renderer-data','useChartStudies','chart-study.worker','chart-drawings','chains','useChartStructure','chart-structure.worker','chart-drawing-snap','chart-drawing-tools','chart-size','chart-watermark','chart-indicators','source-receipt','stored-series-caption','chart-source-label','as-of','receipt-parameters'].map(name=>`src/intel/lib/${name}.js`),
  ...['chart-workspace-contract','chart-analysis','chart-outcome-contract','chart-drawing-geometry','chart-outcome','chart-read','chart-levels','chart-structure','chart-patterns','chart-timeframes'].map(name=>`supabase/functions/_shared/intel/${name}.ts`),
  'src/intel/vendor/lightweight-charts-5.2.0/renderer.mjs',
  // The receipt's reproduce line builds its curl from the capability registry.
  ...['cmc-reproduce','cmc-capabilities','cmc-dex'].map(name=>`supabase/functions/_shared/market-assets/${name}.ts`),
]
// Read-only snapshot of the production modules behind the live RWA lane and the
// CMC transport, copied to production-source/ under their original paths. The
// list is closed under relative imports (checked below), so it runs its own Deno
// tests. Access control, org authorization, the free-tier gate and the services
// that talk to the production database are deliberately absent, as are the tests
// that import them.
const productionSources=[
  ...['depth-read','depth','issuer-read','issuer','underlyings-read','underlyings','wrappers-read','wrappers','yield-read','yield'].map(name=>`capture-rwa-${name}.ts`),
  ...['depth-read','depth','issuer-read','issuer','underlyings-read','underlyings','wrappers','yield-read','yield'].map(name=>`capture-rwa-${name}.test.ts`),
  ...['admission-drift','benchmark-rates','counter-leg','issuer-aliases','issuer-evidence','legitimacy','nav-integrity','portfolio-exposure','terms','wrapper-spread','yield-realized','yield-register'].map(name=>`rwa-${name}.ts`),
  ...['admission-drift','benchmark-rates','counter-leg','issuer-aliases','issuer-review-cycles','legitimacy','nav-integrity','portfolio-exposure','terms','wrapper-spread','yield-realized','yield-register'].map(name=>`rwa-${name}.test.ts`),
  ...['blockscout','edgar-agent','edgar','gleif','http','ofac','sourcify'].flatMap(name=>[`rwa-sources/${name}.ts`,`rwa-sources/${name}.test.ts`]),'rwa-sources/test-support.ts',
  ...['chainlink-nav','sec-nmfp-yield','underlying-reference','accrual-multiplier'].flatMap(name=>[`${name}.ts`,`${name}.test.ts`]),
  ...['rwa-wrapper-picks','rwa-coverage','capture-rwa-coverage','capture-rwa-coverage-read','capture-rwa-wrapper-backfill','capture-rwa-wrapper-history-read',].flatMap(name=>[`${name}.ts`,`${name}.test.ts`]),'rwa-exit-capacity.ts','capture-rwa-coverage.fixtures.ts','capture-rwa-wrappers-read.test.ts',
  'cmc-chart.ts',
  'chart-analysis.ts',
  'capture-read.ts',
  'breadth-spread.ts',
  'investigation-sessions.ts',
  ...['capture-jobs','bounded-request','market-source-versions','market-source-reference','investigation-normalize','investigation-evidence','stress-scenario-contract','cmc-dex-evidence','market-figure-scope','market-read-quality','representation-review'].map(name=>`${name}.ts`),
].map(file=>`supabase/functions/_shared/intel/${file}`).concat(
  ...['cmc-capabilities','cmc-demand-policy','cmc-dex-platforms','cmc-dex','cmc-evidence-shape','cmc-live-focus','cmc-operating-settings','cmc-price','cmc-quote-groups','cmc-refresh-planner','cmc-transport','coinmarketcap-provider','issuer-identities','types','cmc-reproduce'].map(name=>`supabase/functions/_shared/market-assets/${name}.ts`),
  ...['cmc-cache-read-failure','cmc-catalog','cmc-connected-dex','cmc-reproduce','cmc-demand-policy','cmc-dex-platforms','cmc-evidence-shape','cmc-live-focus','cmc-operating-settings','cmc-price','cmc-quote-groups','cmc-recording-policy','cmc-refresh-planner'].map(name=>`supabase/functions/_shared/market-assets/${name}.test.ts`),
  ['chains','provider-budget'].map(name=>`supabase/functions/_shared/${name}.ts`),
  'supabase/functions/_shared/memecoin/degen-gate.ts',
  // Three RWA tests assert against the schema that stores their output.
  ['20260920150000_intel_rwa_wrapper_spread','20260920151000_intel_rwa_depth','20260920152000_intel_rwa_underlying_registrants','20260922100000_intel_rwa_wrapper_premium_backfill','20260922110000_intel_rwa_universe_coverage','20260924000000_intel_rwa_wrapper_xstocks_multiplier'].map(name=>`supabase/migrations/${name}.sql`),
)
const productionSet=new Set(productionSources)
for(const file of productionSources.filter(file=>file.endsWith('.ts'))){
  const code=readFileSync(path.join(root,file),'utf8')
  for(const match of code.matchAll(/(?:from\s*|import\s*\(|import\s+|new URL\s*\()\s*['"](\.[^'"]+)['"]/g)){
    const ref=path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1]))
    if(!productionSet.has(ref))throw Error(`Review production-source dependency before packaging: ${file} -> ${match[1]}`)
  }
}
const EVIDENCE_FILE=/^cmc-receipt-evidence-\d{4}-\d{2}-\d{2}\.json$/
function recordedEvidence(){return readdirSync(path.join(root,'docs/investor-intel/evidence')).filter(file=>EVIDENCE_FILE.test(file)).sort()}
// A capture written by the example's own script (npm run capture:evidence) lands
// at the top of evidence/. It is optional: a checkout that never ran it has none.
function localCaptures(){const dir=path.join(example,'evidence');return existsSync(dir)?readdirSync(dir).filter(file=>EVIDENCE_FILE.test(file)).sort().map(file=>`evidence/${file}`):[]}
const allowed=new Set(chartSources),extensions=['','.js','.jsx','.ts','.tsx','.mjs']
for(const file of chartSources){
  const code=readFileSync(path.join(root,adapters[file]||file),'utf8')
  const refs=[...code.matchAll(/(?:from\s*|import\s*\(|import\s+|new URL\s*\()\s*['"](\.[^'"]+)['"]/g)].map(match=>match[1])
  for(const ref of refs){
    const base=path.resolve(root,path.dirname(file),ref)
    const resolved=extensions.map(ext=>base+ext).find(candidate=>existsSync(candidate))
    const relative=resolved&&path.relative(root,resolved).replaceAll('\\','/')
    if(!relative||!allowed.has(relative))throw Error(`Review extraction dependency before packaging: ${file} -> ${ref}`)
  }
}
// The full Investor Intel source, published for reading and for its history
// (owner decision, 2026-09-23: the public repository covers all of Investor
// Intel). It lands in production-source/ under its original paths, beside the
// standalone subset above. It is NOT closed under imports: modules that reach
// the parent platform (authentication, the Supabase client, shared helpers) are
// there to read. Its tests still run where they can: see the published test run
// below. Tracked files only; the private
// working documents and environment files never enter, and every file passes
// the full-source secret scan before anything is written.
const FULL_SOURCE_SCRIPTS=['scripts/package-investor-intel-demo.mjs','scripts/intel-extraction-package-guards.mjs','scripts/intel-extraction-test-run.mjs','scripts/test-intel-extraction-package.mjs','scripts/intel-built-list.mjs']
const isFullSource=file=>file.startsWith('src/intel/')||file.startsWith('supabase/functions/_shared/intel/')||file.startsWith('supabase/functions/_shared/market-assets/')||/^supabase\/functions\/intel-[^/]+\//.test(file)||/^supabase\/migrations\/([^/]*_)?intel[_.][^/]*$/.test(file)||/^supabase\/migrations\/[^/]*investor[^/]*$/.test(file)||/^src\/i18n\/locales\/[^/]+\/intel\.json$/.test(file)||FULL_SOURCE_SCRIPTS.includes(file)
const tracked=spawnSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',maxBuffer:256*1024*1024,windowsHide:true})
if(tracked.status!==0)throw Error(`git ls-files failed: ${tracked.stderr}`)
const trackedFiles=tracked.stdout.split('\0').filter(Boolean)
const fullSources=trackedFiles.filter(isFullSource)
  .filter(file=>!productionSet.has(file)&&!/(^|\/)\.env(\.(?!example$)[^/]*)?$/.test(file)&&deniedPackagePaths([file]).length===0)
// The standalone subset's tests need nothing outside it, so they run with no
// configuration at all; the list stays for the command that shows that.
const standaloneTests=productionSources.filter(file=>file.endsWith('.test.ts')).map(file=>`production-source/${file}`)
// The published test run: every Deno and Vitest test in production-source/
// whose modules load inside this package, where a parent-platform import may
// resolve to a reviewed TEST STAND-IN (test-support/), and the rest listed with
// the reason in production-source/excluded-tests.md. scripts/intel-extraction-test-run.mjs
// decides which and checks the stand-ins; see its header.
const testRun=planPublishedTestRun({root,example,publishedSource:[...productionSources,...fullSources],tracked:trackedFiles,isIntelSource:isFullSource})
const leftRun=standaloneTests.filter(file=>!testRun.runnable.includes(file))
if(leftRun.length)throw Error(`A standalone test left the published run: ${leftRun.join(', ')}`)
const shared=[...chartSources.map(file=>[adapters[file]||file,`product/${file}`]),
  ...['LICENSE','NOTICE'].map(file=>[`src/intel/vendor/lightweight-charts-5.2.0/${file}`,`product/src/intel/vendor/lightweight-charts-5.2.0/${file}`]),
  ['src/intel/workspace.css','product/src/intel/workspace.css'],
  // ChartWatermark reads this from the package root, so the copied chart would
  // otherwise render a mark that resolves to nothing.
  ['public/logo-light.png','public/logo-light.png'],
  ...['cmc-capabilities','cmc-dex','cmc-evidence-shape'].map(name=>[`supabase/functions/_shared/market-assets/${name}.ts`,`server/${name}.ts`]),
  ...['inter-400.woff2','barlow-condensed-600.woff2','geist-mono-400.woff2','LICENSE.md'].map(file=>['public/vsx-fonts/'+file,'public/vsx-fonts/'+file]),
  // The hackathon rules require visible evidence of a real API call. These are
  // the recorded CMC call artefacts kept with the product documentation, carried
  // under one clearly named folder so they are never mistaken for a fresh capture.
  ...recordedEvidence().map(file=>[`docs/investor-intel/evidence/${file}`,`evidence/recorded-cmc-calls/${file}`]),
  ...productionSources.map(file=>[file,`production-source/${file}`]),
  ...fullSources.map(file=>[file,`production-source/${file}`]),
]
for(const [source,dest] of shared){const target=path.join(example,dest);mkdirSync(path.dirname(target),{recursive:true});copyFileSync(path.join(root,source),target)}
// Package paths whose bytes come from a different file in the example folder.
// The example's own .gitignore ignores production-source/ because that folder
// is a generated copy inside the private repository. Shipping that file made the
// public repository ignore its own production-source/, so files added in a later
// package were silently left out of the public commit and its tests failed on a
// fresh clone. The public repository gets public.gitignore instead.
const PACKAGE_SOURCE_OVERRIDES=Object.freeze({'.gitignore':'public.gitignore','production-source/LICENSE.md':'product/LICENSE.md'})
const exampleSource=file=>path.join(example,PACKAGE_SOURCE_OVERRIDES[file]||file)
writeFileSync(path.join(example,'production-source/standalone-tests.txt'),standaloneTests.join('\n')+'\n')
writeFileSync(path.join(example,RUNNABLE_TESTS),testRun.runnable.join('\n')+'\n')
writeFileSync(path.join(example,RUNNABLE_VITEST_TESTS),testRun.vitestRunnable.join('\n')+'\n')
writeFileSync(path.join(example,EXCLUDED_TESTS),testRun.markdown)
// What was built during the event, file by file, from git history: the CMC
// integration and the RWA and DEX lanes as they ship in production-source/.
// Rewritten on every package; the package test recomputes it and compares.
writeBuiltList(example,await computeBuiltList({repo:root,published:[...productionSources,...fullSources],standalone:productionSources,cut:HISTORY_CUT.private}))
const fullSourceFiles=new Set(fullSources.map(file=>`production-source/${file}`))
const files=['package.json','package-lock.json','.gitignore','.github/workflows/test.yml','.env.example','README.md','LICENSE.md','product/LICENSE.md','production-source/LICENSE.md','index.html','vite.config.mjs','dev.mjs','src/main.jsx','src/style.css','src/fixtures.mjs','src/notebook.mjs','src/chart-data.mjs','server/index.mjs','server/governance.mjs','server/keyless.mjs','scripts/capture-keyless-evidence.mjs','tests/governance.test.mjs','tests/keyless.test.mjs','tests/notebook.test.mjs','tests/chart-data.test.mjs','tests/capture-keyless-evidence.test.mjs',...PUBLIC_DOCS,...localCaptures(),...shared.map(([,dest])=>dest),'production-source/standalone-tests.txt',RUNNABLE_TESTS,RUNNABLE_VITEST_TESTS,EXCLUDED_TESTS,...testRun.testSupportFiles]
// Fail closed before anything is written: the private-document denylist and the
// secret-shape scan run over every file this package would contain.
assertPublishable(files.map(file=>({file,text:readFileSync(exampleSource(file),'utf8'),fullSource:fullSourceFiles.has(file)})))
// Validate the entire emitted dependency graph, including the server and tests.
// A browser-only build cannot detect an omitted server capability dependency.
// The full source is there to read, not to run, so it is outside this check.
const emittedFiles=new Set(files)
for(const file of files.filter(file=>!fullSourceFiles.has(file)&&/\.(?:[cm]?js|jsx|tsx?)$/.test(file))){
 const code=readFileSync(exampleSource(file),'utf8')
 for(const match of code.matchAll(/(?:from\s*|import\s*\(|import\s+|new URL\s*\()\s*['"](\.[^'"]+)['"]/g)){
  const base=path.resolve(example,path.dirname(file),match[1])
  const dependency=extensions.map(ext=>path.relative(example,base+ext).replaceAll('\\','/')).find(ref=>emittedFiles.has(ref))
  if(!dependency)throw Error(`Review extraction dependency before packaging: ${file} -> ${match[1]}`)
 }
}
if(process.argv.includes('--sync-only')){console.log(`Synchronized ${chartSources.length} reviewed chart dependencies, styles, capability catalog and licensed assets.`);process.exit(0)}
const target=path.join(root,'artifacts',`investor-intel-hackathon-${new Date().toISOString().replace(/[:.]/g,'-')}`)
mkdirSync(target,{recursive:true})
const manifest=[]
for(const file of files){if(file.includes('..')||path.isAbsolute(file)||(!file.endsWith('.example')&&/^\.env/.test(file)))throw Error('Unsafe package path');const bytes=readFileSync(exampleSource(file));const dest=path.join(target,file);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,bytes);manifest.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...(fullSourceFiles.has(file)?{role:'full-source'}:{})})}
writeFileSync(path.join(target,'SOURCE-MANIFEST.json'),JSON.stringify({createdAt:new Date().toISOString(),sourceFiles:shared.map(([source,extracted])=>({source,extracted})),files:manifest},null,2)+'\n')
console.log(target)
console.log(`Packaged ${manifest.length} allowed source files (${manifest.reduce((sum,f)=>sum+f.bytes,0)} bytes). Publication remains separately gated.`)
