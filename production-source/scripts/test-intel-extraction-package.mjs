// Builds the newly emitted source package, rather than an older example bundle.
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
import { PUBLIC_DOCS, PRIVATE_DOCS, DRAFT_MARKER, deniedPackagePaths, isBinaryPackagePath, findSecretShapes, findFullSourceSecretShapes } from './intel-extraction-package-guards.mjs'
import { STAND_IN_HEADER, TEST_CONFIG, RUNNABLE_TESTS, RUNNABLE_VITEST_TESTS, VITEST_CONFIG, EXCLUDED_TESTS, testRunner } from './intel-extraction-test-run.mjs'
import { computeBuiltList, builtListJson, builtListMarkdown, publishedFromManifest, HISTORY_CUT, EVENT_START, BUILT_LIST_DOC, BUILT_LIST_JSON, NAME_RULE_EXCEPTIONS, PUBLIC_HISTORY_EXCEPTIONS } from './intel-built-list.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const require=createRequire(import.meta.url)
function run(args,cwd=root){const result=spawnSync(process.execPath,args,{cwd,windowsHide:true,encoding:'utf8',timeout:120000});if(result.error||result.status!==0)throw Error(result.error?.message||result.stderr||result.stdout);return result.stdout}
const emitted=run(['scripts/package-investor-intel-demo.mjs'])
const target=emitted.split(/\r?\n/)[0]
assert.ok(target.startsWith(path.join(root,'artifacts')+path.sep))
const manifest=JSON.parse(readFileSync(path.join(target,'SOURCE-MANIFEST.json')))
for(const entry of manifest.files){
  assert.ok(!entry.file.includes('..')&&!path.isAbsolute(entry.file))
  assert.ok(!/(^|\/)(node_modules|\.local|\.env($|\.(?!example$)))/.test(entry.file))
  assert.equal(createHash('sha256').update(readFileSync(path.join(target,entry.file))).digest('hex'),entry.sha256)
}
assert.ok(manifest.files.some(f=>f.file.endsWith('chart-study.worker.js')))
assert.ok(manifest.files.some(f=>f.file.endsWith('chart-structure.worker.js')))
assert.ok(manifest.files.some(f=>f.file.endsWith('lightweight-charts-5.2.0/LICENSE')))
assert.ok(manifest.files.some(f=>f.file.endsWith('lightweight-charts-5.2.0/NOTICE')))
// Source-available, never open source: PolyForm Noncommercial at the root,
// PolyForm Strict on the product source, and no leftover all-rights-reserved text.
for(const [file,licence] of [['LICENSE.md','PolyForm Noncommercial License 1.0.0'],['product/LICENSE.md','PolyForm Strict License 1.0.0'],['production-source/LICENSE.md','PolyForm Strict License 1.0.0']]){
  assert.ok(manifest.files.some(f=>f.file===file),`${file} must ship`)
  assert.ok(readFileSync(path.join(target,file),'utf8').includes(`# ${licence}`),`${file} must carry the ${licence} text`)
}
assert.ok(!readFileSync(path.join(target,'README.md'),'utf8').includes('All rights reserved'))
// Private working documents never ship, and the public docs the README and the
// submission text point at always do.
const packaged=manifest.files.map(f=>f.file)
for(const doc of PRIVATE_DOCS)assert.ok(!packaged.some(file=>file.toLowerCase().endsWith(path.posix.basename(doc))),`private document in the package manifest: ${doc}`)
assert.deepEqual(deniedPackagePaths(packaged),[],'the package manifest contains a denylisted document')
for(const doc of PUBLIC_DOCS)assert.ok(packaged.includes(doc),`public document missing from the package: ${doc}`)
// The rules require visible evidence of a real API call: at least one recorded
// CMC call artefact ships, and each one parses and carries its provider status.
const evidence=packaged.filter(file=>/^evidence\/(?:recorded-cmc-calls\/)?cmc-receipt-evidence-\d{4}-\d{2}-\d{2}\.json$/.test(file))
assert.ok(evidence.some(file=>file.startsWith('evidence/recorded-cmc-calls/')),'no recorded CMC call evidence in the package')
for(const file of evidence){
  const artefact=JSON.parse(readFileSync(path.join(target,file),'utf8'))
  assert.ok(Array.isArray(artefact.probes)&&artefact.probes.length>0,`${file} has no probes`)
  assert.ok(artefact.probes.every(probe=>probe.providerStatus&&Number.isInteger(probe.httpStatus)),`${file} lacks a provider status or HTTP status`)
}
// The emitted bytes, not only the source tree, pass the secret-shape scan.
const fullSource=new Set(manifest.files.filter(f=>f.role==='full-source').map(f=>f.file))
const findings=packaged.filter(file=>!isBinaryPackagePath(file)).flatMap(file=>(fullSource.has(file)?findFullSourceSecretShapes:findSecretShapes)(file,readFileSync(path.join(target,file),'utf8')))
// The full Investor Intel source ships under production-source/, never outside it.
assert.ok(fullSource.size>0,'the full Investor Intel source is missing from the package')
assert.ok([...fullSource].every(file=>file.startsWith('production-source/')),'full-source files must stay under production-source/')
assert.ok(packaged.includes('production-source/src/intel/demo/demo-fetch.js'),'the frontend source is missing from the full source')
assert.deepEqual(findings,[],`secret-shaped text in the emitted package: ${findings.map(f=>`${f.file}:${f.line} (${f.pattern})`).join(', ')}`)
// The public .gitignore must not ignore anything the package ships: a shipped
// file that the public repository ignores is left out of its next commit.
const gitignore=readFileSync(path.join(target,'.gitignore'),'utf8').split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'))
const ignoredShipped=packaged.filter(file=>{const parts=file.split('/');return gitignore.some(rule=>rule.endsWith('/')?parts.slice(0,-1).includes(rule.slice(0,-1)):rule.startsWith('*.')?file.endsWith(rule.slice(1)):parts.includes(rule))})
assert.deepEqual(ignoredShipped,[],'the public .gitignore ignores packaged files')
// The offline test workflow ships and needs no secrets.
assert.ok(packaged.includes('.github/workflows/test.yml'),'the test workflow is missing from the package')
assert.ok(!/\bsecrets\./.test(readFileSync(path.join(target,'.github/workflows/test.yml'),'utf8')),'the test workflow must not read secrets')
// Code excerpts the README cites by file and line match those lines exactly
// (ignoring indentation), so a repackage cannot leave a stale citation.
const readmeText=readFileSync(path.join(target,'README.md'),'utf8').replace(/\r\n/g,'\n')
const citations=[...readmeText.matchAll(/`(production-source\/[^`]+?\.ts)` lines? (\d+)(?: to (\d+))?:\n\n```ts\n([\s\S]*?)\n```/g)]
assert.ok(citations.length>=2,'the README should cite the real-call code by file and line')
for(const [,file,from,to,excerpt] of citations){
  const lines=readFileSync(path.join(target,file),'utf8').split(/\r?\n/).slice(Number(from)-1,Number(to||from))
  assert.deepEqual(excerpt.split('\n').map(line=>line.trim()),lines.map(line=>line.trim()),`README excerpt does not match ${file} line ${from}`)
}
// The keyless demo mode ships with the extraction and its tests.
assert.ok(manifest.files.some(f=>f.file==='server/keyless.mjs'))
assert.ok(manifest.files.some(f=>f.file==='tests/keyless.test.mjs'))
const keyless=readFileSync(path.join(target,'server/keyless.mjs'),'utf8')
assert.ok(keyless.includes('keyless commercial terms are unstated; keep it to the demo until reviewed'))
assert.ok(!/X-CMC_PRO_API_KEY|CMC_API_KEY/.test(keyless),'the keyless client must never read or send a key')
assert.ok(readFileSync(path.join(target,'README.md'),'utf8').includes('keyless commercial terms are unstated; keep it to the demo until reviewed'))
// The keyless mode is confined to this extraction: no parent-product source may
// reach the keyless base or emit its source label.
const productRoots=['src','supabase/functions','worker','netlify','scripts','local-intelligence-worker','image-worker','render-worker','shared']
const thisFile=path.resolve(fileURLToPath(import.meta.url))
const walk=dir=>{let out=[];for(const entry of readdirSync(dir)){if(entry==='node_modules'||entry==='dist')continue
  const full=path.join(dir,entry);const info=statSync(full)
  out=out.concat(info.isDirectory()?walk(full):/\.(?:[cm]?jsx?|tsx?)$/.test(entry)?[full]:[])}
 return out}
for(const dir of productRoots){
  let files=[];try{files=walk(path.join(root,dir))}catch{continue}
  for(const file of files){
    if(path.resolve(file)===thisFile)continue // this guard names the strings it forbids
    const code=readFileSync(file,'utf8')
    assert.ok(!code.includes('coinmarketcap.com/public-api'),`keyless base reached from the parent product: ${file}`)
    assert.ok(!code.includes('coinmarketcap_keyless'),`keyless source label used outside the extraction: ${file}`)
  }
}
// The production snapshot ships, carries no drafting markers, and runs its own
// Deno tests inside the emitted folder, which proves its imports are closed.
assert.ok(packaged.some(file=>file==='production-source/supabase/functions/_shared/market-assets/cmc-transport.ts'))
assert.ok(packaged.some(file=>file==='production-source/supabase/functions/_shared/intel/rwa-wrapper-spread.ts'))
for(const file of packaged.filter(file=>!isBinaryPackagePath(file)))assert.ok(!readFileSync(path.join(target,file),'utf8').includes(DRAFT_MARKER),`drafting marker in ${file}`)
// The published test run. runnable-tests.txt (Deno) and runnable-vitest-tests.txt
// (Vitest) are the lists the public CI runs; every other test file in
// production-source/ is listed, with its reason, in excluded-tests.md, so no test
// goes unaccounted for.
const listed=file=>readFileSync(path.join(target,file),'utf8').split(/\r?\n/).filter(Boolean)
const standaloneTests=listed('production-source/standalone-tests.txt')
const runnableTests=listed(RUNNABLE_TESTS)
const runnableVitestTests=listed(RUNNABLE_VITEST_TESTS)
const excludedListed=[...readFileSync(path.join(target,EXCLUDED_TESTS),'utf8').matchAll(/^\| `(production-source\/[^`]+\.test\.[cm]?[jt]sx?)` \|/gm)].map(match=>match[1])
const excludedTests=excludedListed.filter(file=>testRunner(file)==='deno')
const excludedVitestTests=excludedListed.filter(file=>testRunner(file)==='vitest')
const denoTests=packaged.filter(file=>file.startsWith('production-source/')&&testRunner(file)==='deno')
const vitestTests=packaged.filter(file=>file.startsWith('production-source/')&&testRunner(file)==='vitest')
assert.ok(standaloneTests.length>0&&standaloneTests.every(file=>packaged.includes(file)),'standalone-tests.txt lists a file the package lacks')
assert.ok(runnableTests.length>0&&runnableTests.every(file=>packaged.includes(file)),'runnable-tests.txt lists a file the package lacks')
assert.ok(runnableVitestTests.length>0&&runnableVitestTests.every(file=>packaged.includes(file)&&testRunner(file)==='vitest'),'runnable-vitest-tests.txt lists a file the package lacks')
assert.ok(standaloneTests.every(file=>runnableTests.includes(file)),'a standalone test is missing from the published run')
assert.deepEqual([...runnableTests,...excludedTests].sort(),[...denoTests].sort(),'every production-source Deno test is either run or listed with its reason, once')
assert.deepEqual([...runnableVitestTests,...excludedVitestTests].sort(),[...vitestTests].sort(),'every production-source Vitest test is either run or listed with its reason, once')
assert.ok(packaged.includes(VITEST_CONFIG)&&packaged.includes('test-support/vitest-offline.mjs'),'the Vitest configuration or its offline guard is missing from the package')
// Stand-ins are labelled, live only under test-support/stand-ins/, and are mapped
// by the test configuration alone; none sits at, or shadows, a published path.
const testConfig=JSON.parse(readFileSync(path.join(target,TEST_CONFIG),'utf8'))
assert.deepEqual(Object.keys(testConfig).sort(),['lock','nodeModulesDir','scopes'],'the test configuration holds only the npm mode, the lock switch and the stand-in scope')
assert.deepEqual(Object.keys(testConfig.scopes),['../production-source/'],'stand-ins apply to imports from production-source/ only')
const standInFiles=packaged.filter(file=>file.startsWith('test-support/stand-ins/'))
assert.ok(standInFiles.length>0,'the stand-ins are missing from the package')
for(const file of standInFiles)assert.ok(readFileSync(path.join(target,file),'utf8').startsWith(STAND_IN_HEADER),`stand-in without the TEST STAND-IN header: ${file}`)
for(const [from,to] of Object.entries(testConfig.scopes['../production-source/'])){
  assert.ok(standInFiles.includes(`test-support/${to.replace(/^\.\//,'')}`),`the test configuration maps to something that is not a packaged stand-in: ${to}`)
  assert.ok(from.startsWith('../production-source/')&&!packaged.includes(from.slice(3)),`a stand-in shadows a published module: ${from}`)
}
// The runs, as the public CI runs them. The standalone subset first, with no
// configuration at all, which shows it needs nothing outside itself. Then the
// published run: its dependencies fetched once, and the tests run from the cache
// only, without network permission. Any stand-in a test reaches fails the run;
// the output is checked for one as well.
const denoRun=(args,label,cwd=target)=>{
  const result=spawnSync('deno',args,{cwd,windowsHide:true,encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024})
  const output=`${result.stdout||''}${result.stderr||''}`.replace(/\x1b\[[0-9;]*m/g,'')
  if(result.error||result.status!==0)throw Error(`${label} failed: ${result.error?.message||output.slice(-3000)}`)
  return output
}
// Deno's closing line: "ok | 2244 passed (3 steps) | 0 failed | 1 ignored (40s)".
const denoSummary=(output,label)=>{
  const line=output.trim().split(/\r?\n/).reverse().find(text=>/^ok \| \d+ passed\b/.test(text))
  assert.ok(line,`${label}: no Deno summary line in the output`)
  return {line,passed:Number(line.match(/^ok \| (\d+) passed/)[1]),filtered:Number(line.match(/\| (\d+) filtered out/)?.[1]||0)}
}
const standalone=denoSummary(denoRun(['test','--allow-read','--allow-env','--no-check','-q',...standaloneTests],'standalone production-source tests'),'standalone production-source tests')
console.log(`standalone subset: ${standalone.line}`)
denoRun(['cache','--config',TEST_CONFIG,...runnableTests],'fetching the test dependencies')
const published=denoRun(['test','--config',TEST_CONFIG,'--cached-only','--allow-read','--allow-env','--no-check','-q',...runnableTests],'published production-source tests')
assert.ok(!published.includes('TEST STAND-IN reached'),'a published test reached a stand-in')
const publishedDeno=denoSummary(published,'published production-source tests')
console.log(`published run (${runnableTests.length} files, ${excludedTests.length} listed in ${EXCLUDED_TESTS}): ${publishedDeno.line}`)
// The Vitest run, as `npm run test:vitest` runs it: from inside production-source/
// with the published configuration. The JSON report gives the counts.
const vitestBin=(()=>{const manifestPath=require.resolve('vitest/package.json'),bin=JSON.parse(readFileSync(manifestPath,'utf8')).bin;return path.join(path.dirname(manifestPath),typeof bin==='string'?bin:bin.vitest)})()
const scratch=mkdtempSync(path.join(tmpdir(),'intel-package-test-'))
const vitestJson=(label,cwd,args,reportFile)=>{
  const result=spawnSync(process.execPath,[vitestBin,...args],{cwd,windowsHide:true,encoding:'utf8',timeout:600000,maxBuffer:64*1024*1024})
  const output=`${result.stdout||''}${result.stderr||''}`.replace(/\x1b\[[0-9;]*m/g,'')
  if(result.error||result.status!==0)throw Error(`${label} failed: ${result.error?.message||output.slice(-3000)}`)
  return {output,report:JSON.parse(readFileSync(reportFile,'utf8'))}
}
const vitestReport=path.join(scratch,'published-vitest.json')
const vitestRun=vitestJson('published production-source Vitest tests',path.join(target,'production-source'),['run','--config','../test-support/vitest.config.mjs','--reporter=default','--reporter=json',`--outputFile.json=${vitestReport}`],vitestReport)
assert.ok(!/TEST STAND-IN reached|OFFLINE: a published test reached the network/.test(vitestRun.output),'a published Vitest test reached a stand-in or the network')
assert.equal(vitestRun.report.numFailedTests,0,'a published Vitest test failed')
assert.equal(vitestRun.report.numTotalTests,vitestRun.report.numPassedTests,'a published Vitest test was skipped or did not finish')
assert.deepEqual(vitestRun.report.testResults.map(result=>path.relative(target,result.name).replaceAll('\\','/')).sort(),[...runnableVitestTests].sort(),'the Vitest run did not run exactly runnable-vitest-tests.txt')
const vitestPassed=vitestRun.report.numPassedTests
console.log(`published Vitest run (${runnableVitestTests.length} files, ${excludedVitestTests.length} listed in ${EXCLUDED_TESTS}): ${vitestPassed} passed`)
// The excluded files cannot load here, so their tests are counted where they can:
// in the private repository, collected but not run. Deno registers every test of
// a file and runs none when no test name matches the filter; Vitest lists them.
const privatePath=file=>file.replace(/^production-source\//,'')
const excludedDenoCount=excludedTests.length?denoSummary(denoRun(['test','--no-check','--allow-read','--allow-env','-q','--filter','investor-intel-package-test: count only, no test has this name',...excludedTests.map(privatePath)],'counting the excluded Deno tests',root),'counting the excluded Deno tests').filtered:0
const excludedVitestCount=(()=>{
  if(!excludedVitestTests.length)return 0
  const listFile=path.join(scratch,'excluded-vitest.json')
  const {report}=vitestJson('counting the excluded Vitest tests',root,['list',`--json=${listFile}`,...excludedVitestTests.map(privatePath)],listFile)
  for(const file of excludedVitestTests)assert.ok(report.some(entry=>entry.file.replaceAll('\\','/').endsWith(`/${privatePath(file)}`)),`the private repository's Vitest setup does not collect ${file}`)
  return report.length
})()
rmSync(scratch,{recursive:true,force:true})
const vite=path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js')
const nodeTestFiles=manifest.files.filter(f=>f.file.startsWith('tests/')&&f.file.endsWith('.test.mjs')).map(f=>f.file)
const nodeRun=run(['--test',...nodeTestFiles],target)
console.log(nodeRun)
console.log(run([vite,'build',target,'--config',path.join(target,'vite.config.mjs')],target))

// Built for the hackathon (docs/built-for-the-hackathon.md and .json). The
// published record is recomputed from git, from the package's own manifest
// rather than the packager's lists, and must match to the byte.
const builtRecordText=readFileSync(path.join(target,BUILT_LIST_JSON),'utf8')
const builtRecord=JSON.parse(builtRecordText)
const builtNow=await computeBuiltList({repo:root,...publishedFromManifest(manifest),cut:HISTORY_CUT.private})
assert.equal(builtRecordText,builtListJson(builtNow),`${BUILT_LIST_JSON} differs from a recomputation from git`)
assert.equal(readFileSync(path.join(target,BUILT_LIST_DOC),'utf8'),builtListMarkdown(builtNow),`${BUILT_LIST_DOC} differs from a recomputation from git`)
const builtTotals=builtRecord.totals
assert.ok(builtTotals.files>0&&builtTotals.files===builtTotals.new+builtTotals.changed+builtTotals.unchanged,'the built-for-the-hackathon totals do not add up')
// A second, independent recomputation for a sample of rows (every file that
// existed before the event, every exception, and every 20th new file), using
// the git commands the document prints, one file at a time.
{
  const git=args=>{const result=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:256*1024*1024,env:{...process.env,TZ:'UTC'}});if(result.error||result.status!==0)throw Error(`git ${args[0]} failed: ${result.error?.message||result.stderr}`);return result.stdout}
  const lines=text=>text.split(/\r?\n/).filter(Boolean)
  const base=git(['rev-list','-1','--first-parent',`--before=${EVENT_START}`,HISTORY_CUT.private]).trim()
  const stamp='--date=format-local:%Y-%m-%d %H:%M'
  const byRow=new Map(builtRecord.files.map(row=>[row.path,row]))
  for(const file of [...Object.keys(NAME_RULE_EXCEPTIONS),...Object.keys(PUBLIC_HISTORY_EXCEPTIONS)])assert.ok(builtNow.rows.some(row=>row.path===file)||packaged.includes(`production-source/${file}`),`${file} is named as an exception but is no longer published: remove it`)
  // A name-rule exception may only ever lower the count of new files.
  for(const file of Object.keys(NAME_RULE_EXCEPTIONS)){
    assert.ok(!git(['ls-tree','--name-only',base,'--',file]).trim(),`${file} existed before the event, so it cannot be a name-rule exception`)
    assert.ok(lines(git(['log','--full-history','--diff-filter=A',stamp,'--format=%ad','HEAD','--',file])).every(date=>date>='2026-09-09'),`${file} was first committed before the event, so it cannot be a name-rule exception`)
  }
  for(const file of Object.keys(PUBLIC_HISTORY_EXCEPTIONS))assert.ok(byRow.has(file),`${file} has a public-history exception but is not in scope: remove it`)
  const sample=builtRecord.files.filter((row,index)=>row.status!=='new'||index%20===0||NAME_RULE_EXCEPTIONS[row.path]||PUBLIC_HISTORY_EXCEPTIONS[row.path])
  for(const row of sample){
    const file=row.path
    const inCut=lines(git(['log','--full-history','--diff-filter=A',stamp,'--format=%ad',HISTORY_CUT.private,'--',file])).sort()
    const anywhere=lines(git(['log','--full-history','--diff-filter=A',stamp,'--format=%ad','HEAD','--',file])).sort()
    assert.equal(row.firstCommitted.replace('T',' ').slice(0,16),(inCut[0]||anywhere[0]),`${file}: first commit differs from git log`)
    const existed=Boolean(git(['ls-tree','--name-only',base,'--',file]).trim())
    const [added=0,removed=0]=(lines(git(['diff','--numstat',base,'--',file]))[0]||'').split('\t').filter((_,i)=>i<2).map(Number)
    assert.equal(row.status,existed?(added||removed?'changed':'unchanged'):'new',`${file}: status differs from git`)
    assert.deepEqual([row.linesAdded,row.linesRemoved],[added,removed],`${file}: lines differ from git diff --numstat`)
    const since=range=>lines(git(['log','--no-merges','--full-history',stamp,'--format=%ad',range,'--',file])).filter(date=>date>='2026-09-09').length
    assert.equal(row.commitsSinceEvent,since('HEAD'),`${file}: commits since the event differ from git log`)
    if(row.historyPublished)assert.equal(row.commitsSinceEventInPublishedHistory,since(HISTORY_CUT.private),`${file}: published-history commits differ from git log`)
  }
  // The README's claim that the integration's first commit came after the event
  // opened is the record's earliest new file.
  const earliestNew=builtRecord.files.filter(row=>row.status==='new').map(row=>row.firstCommitted).sort()[0]
  assert.ok(earliestNew>=EVENT_START,'a new file in the record was committed before the event')
  assert.ok(readmeText.includes(`its first commit was ${earliestNew.slice(0,10)}, after submissions opened on 2026-09-09`),`the README's first-commit date no longer matches the record (${earliestNew.slice(0,10)})`)
  const adapter=byRow.get('supabase/functions/_shared/market-assets/coinmarketcap-provider.ts')
  assert.ok(adapter&&adapter.status!=='new'&&adapter.mentionedCmcBeforeEvent,'the README names coinmarketcap-provider.ts as the pre-existing CMC adapter; the record must agree')
  console.log(`built for the hackathon: ${builtTotals.files} files (${builtTotals.new} new, ${builtTotals.changed} changed, ${builtTotals.unchanged} unchanged), ${sample.length} rows rechecked file by file`)
}

// Every count the README and the public docs state about this package is checked
// against the package itself, so no repackage can publish a stale number. A claim
// that is reworded fails here until its pattern is updated, and any other
// "N tests / files / tools" phrase in those documents must be one of these claims
// or a count recorded for a named earlier run (HISTORICAL_COUNTS).
const nodeTests=Number(nodeRun.match(/^(?:ℹ|#) tests (\d+)$/m)?.[1])
assert.ok(nodeTests>0,'no test count in the demo test output')
const nodeTestsIn=Object.fromEntries(nodeTestFiles.map(file=>[path.posix.basename(file),(readFileSync(path.join(target,file),'utf8').match(/^\s*test\(/gm)||[]).length]))
assert.equal(Object.values(nodeTestsIn).reduce((sum,count)=>sum+count,0),nodeTests,'the demo tests counted by their test( calls differ from the run')
const sourceText=file=>readFileSync(path.join(target,file),'utf8').replace(/\r\n/g,'\n')
const mcpToolsSource=sourceText('production-source/supabase/functions/_shared/intel/mcp-tools.ts')
const mcpTools=[...(mcpToolsSource.match(/^export const MCP_TOOLS:ToolSpec\[\]=\[\n([\s\S]*?)\n\]\n/m)?.[1]||'').matchAll(/^  name:'([a-z_]+)',$/gm)].map(match=>match[1])
const demoToolsSource=sourceText('production-source/supabase/functions/intel-mcp-demo/demo-tools.ts')
const demoTools=[...(demoToolsSource.match(/^export const DEMO_TOOL_NAMES=\[([\s\S]*?)\] as const/m)?.[1]||'').matchAll(/'([a-z_]+)'/g)].map(match=>match[1])
const demoLeftOut=[...(demoToolsSource.match(/^export const DEMO_EXCLUDED:Record<string,string>=\{([\s\S]*?)\n\}/m)?.[1]||'').matchAll(/^ ([a-z_]+):/gm)].map(match=>match[1])
assert.ok(mcpTools.length>0&&demoTools.length>0,'could not read the MCP tool lists')
assert.deepEqual([...demoTools,...demoLeftOut].sort(),[...mcpTools].sort(),'every MCP tool is either served by the demo or left out of it by name, once')
const demoHandlerSource=sourceText('production-source/supabase/functions/intel-mcp-demo/handler.ts')
const demoLimit=name=>Number(demoHandlerSource.match(new RegExp(String.raw`^ ${name}:(\d+),$`,'m'))?.[1])
const WORD_NUMBERS=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty']
const numberOf=text=>WORD_NUMBERS.includes(text.toLowerCase())?WORD_NUMBERS.indexOf(text.toLowerCase()):Number(text.replaceAll(',',''))
const N=String.raw`(\d[\d,]*|${WORD_NUMBERS.join('|')})`
const claim=(file,source,expected)=>({file,pattern:new RegExp(source.replaceAll('{n}',N),'gi'),expected})
let mcpToolsAdded=null
const CLAIMS=[
  claim('README.md',String.raw`\`npm test\` \({n} demo tests in fixture mode\)`,()=>[nodeTests]),
  claim('README.md',String.raw`\*\*{n} Deno tests from {n} of the {n} Deno test files in \`production-source/\`\*\*`,()=>[publishedDeno.passed,runnableTests.length,denoTests.length]),
  claim('README.md',String.raw`\*\*{n} Vitest tests from {n} of the {n} Vitest test files in \`production-source/\`\*\*`,()=>[vitestPassed,runnableVitestTests.length,vitestTests.length]),
  claim('README.md',String.raw`The other {n} Deno test files \({n} tests\) and {n} Vitest test files? \({n} tests\)`,()=>[excludedTests.length,excludedDenoCount,excludedVitestTests.length,excludedVitestCount]),
  claim('README.md',String.raw`{n} tests from \`production-source/runnable-tests\.txt\``,()=>[publishedDeno.passed]),
  claim('README.md',String.raw`{n} tests from \`production-source/runnable-vitest-tests\.txt\``,()=>[vitestPassed]),
  claim('README.md',String.raw`{n} tests behind the RWA lane and the CMC transport`,()=>[standalone.passed]),
  claim('README.md',String.raw`the same {n} Deno tests and {n} Vitest tests as CI`,()=>[publishedDeno.passed,vitestPassed]),
  // The split into read and write tools and the count shown in the video are stated
  // facts; what is checked is that they add up to the tools the server has.
  claim('README.md',String.raw`a hosted MCP server with {n} tools covering all of the above\. {n} of them are grounded read tools\. The other {n} write`,([,reads,writes])=>[mcpTools.length,mcpTools.length-writes,writes]),
  claim('README.md',String.raw`The demo video shows {n} tools because it was recorded before {n} were added`,([,added])=>{mcpToolsAdded=added;return [mcpTools.length-added,added]}),
  claim('README.md',String.raw`\*\*What it serves\.\*\* {n} of the {n} tools: [^\n]*? and {n} \`rwa_\` tools\.`,()=>[demoTools.length,mcpTools.length,demoTools.filter(name=>name.startsWith('rwa_')).length]),
  claim('README.md',String.raw`The full {n} tools need an Investor Intel account`,()=>[mcpTools.length]),
  claim('README.md',String.raw`\*\*Limits\.\*\* {n} tool calls a minute and {n} a day per address`,()=>[demoLimit('toolCallsPerMinute'),demoLimit('toolCallsPerDay')]),
  claim('README.md',String.raw`# The {n} tools\n`,()=>[demoTools.length]),
  claim('docs/demo-guide.md',String.raw`\`npm test\` runs {n} tests across {n} files \(counted from the \`test\(\` calls in \`tests/\*\.test\.mjs\` and confirmed by a passing run on \d{4}-\d{2}-\d{2}: {n} pass, 0 fail\)`,()=>[nodeTests,nodeTestFiles.length,nodeTests]),
  claim('docs/demo-guide.md',String.raw`{n} cover the governed service, charts and notebook \(\`governance\.test\.mjs\` {n}, \`chart-data\.test\.mjs\` {n}, \`notebook\.test\.mjs\` {n}\)`,()=>{const {['governance.test.mjs']:g,['chart-data.test.mjs']:c,['notebook.test.mjs']:n}=nodeTestsIn;return [g+c+n,g,c,n]}),
  claim('docs/demo-guide.md',String.raw`{n} cover the keyless mode \(\`keyless\.test\.mjs\`\)`,()=>[nodeTestsIn['keyless.test.mjs']]),
  claim('docs/demo-guide.md',String.raw`{n} cover the keyless evidence capture \(\`capture-keyless-evidence\.test\.mjs\`\)`,()=>[nodeTestsIn['capture-keyless-evidence.test.mjs']]),
  claim('docs/demo-guide.md',String.raw`{n} production-source Deno tests \(listed in \`production-source/runnable-tests\.txt\`\) and {n} production-source Vitest tests`,()=>[publishedDeno.passed,vitestPassed]),
  claim('docs/build-timeline.md',String.raw`{n} more MCP tools`,()=>[mcpToolsAdded]),
  // The totals of docs/built-for-the-hackathon.json, wherever they are cited.
  claim('README.md',String.raw`Of the {n} files in scope, {n} were first committed during the event, {n} existed before it and were changed, and {n} existed before it and are unchanged\.`,()=>[builtTotals.files,builtTotals.new,builtTotals.changed,builtTotals.unchanged]),
  claim('docs/build-timeline.md',String.raw`{n} of its {n} files were first committed during the event\. Of the {n} that existed before, only {n} mentioned CoinMarketCap at all\.`,()=>[builtTotals.new,builtTotals.files,builtTotals.changed+builtTotals.unchanged,builtTotals.preExistingThatMentionedCmc]),
  claim(BUILT_LIST_DOC,String.raw`\*\*{n} files are in scope: {n} were first committed during the event, {n} existed before it and were changed during it, and {n} existed before it and are unchanged\.\*\*`,()=>[builtTotals.files,builtTotals.new,builtTotals.changed,builtTotals.unchanged]),
]
// Counts dated to an earlier run, kept as the record of that run.
const HISTORICAL_COUNTS={
  'docs/keyless-demo-mode.md':['10 new keyless checks','74 files','72 files'],
  'docs/build-timeline.md':['299 files','475 standalone tests'],
}
const COUNT_PHRASE=new RegExp(String.raw`\b${N}((?:[ (]+[\w\x60.:/-]+){0,4}?)[ ]+(tests|test files?|files?|tools?|checks)\b`,'gi')
const countDocs=['README.md',...PUBLIC_DOCS.filter(doc=>doc.endsWith('.md'))]
const covered=new Map(countDocs.map(file=>[file,[]]))
for(const {file,pattern,expected} of CLAIMS){
  const text=readFileSync(path.join(target,file),'utf8').replace(/\r\n/g,'\n')
  const matches=[...text.matchAll(pattern)]
  assert.ok(matches.length>0,`${file} no longer states the count this test expects (${pattern.source.slice(0,80)}...): update the claim here`)
  for(const match of matches){
    const stated=match.slice(1).map(numberOf)
    assert.deepEqual(stated,expected(stated),`${file} says "${match[0].trim()}", which does not match the package`)
    covered.get(file).push([match.index,match.index+match[0].length])
  }
}
for(const file of countDocs){
  const text=readFileSync(path.join(target,file),'utf8').replace(/\r\n/g,'\n')
  const historical=HISTORICAL_COUNTS[file]||[]
  for(const phrase of historical)assert.ok(text.includes(phrase),`${file}: the historical count "${phrase}" is gone; remove it from HISTORICAL_COUNTS`)
  for(const match of text.matchAll(COUNT_PHRASE)){
    const inClaim=covered.get(file).some(([start,end])=>start<=match.index&&match.index+match[0].length<=end)
    assert.ok(inClaim||historical.includes(match[0]),`${file} states "${match[0]}", a count this test does not check: add a claim for it (or, for a dated record, a HISTORICAL_COUNTS entry)`)
  }
}
console.log(`published counts checked: ${CLAIMS.length} claims across ${countDocs.length} documents (Deno ${publishedDeno.passed} run + ${excludedDenoCount} excluded, Vitest ${vitestPassed} run + ${excludedVitestCount} excluded, standalone ${standalone.passed}, demo ${nodeTests}, MCP ${mcpTools.length}/${demoTools.length})`)
console.log(JSON.stringify({target,sourceFiles:manifest.files.length,sourceBytes:manifest.files.reduce((sum,f)=>sum+f.bytes,0),verified:'manifest hashes, excluded private paths, worker/license inclusion, emitted server tests, Deno and Vitest runs, published counts, the built-for-the-hackathon record recomputed from git and package build',dependencyInstall:'This regression uses existing workspace dependencies. Fresh standalone dependency installation is a separately recorded check.'}))
