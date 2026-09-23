// Builds the newly emitted source package, rather than an older example bundle.
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
import { PUBLIC_DOCS, PRIVATE_DOCS, DRAFT_MARKER, deniedPackagePaths, isBinaryPackagePath, findSecretShapes, findFullSourceSecretShapes } from './intel-extraction-package-guards.mjs'
import { STAND_IN_HEADER, TEST_CONFIG, RUNNABLE_TESTS, EXCLUDED_TESTS } from './intel-extraction-test-run.mjs'
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
// The published test run. runnable-tests.txt is the list the public CI runs;
// every other Deno test in production-source/ is listed, with its reason, in
// excluded-tests.md, so no test goes unaccounted for.
const listed=file=>readFileSync(path.join(target,file),'utf8').split(/\r?\n/).filter(Boolean)
const standaloneTests=listed('production-source/standalone-tests.txt')
const runnableTests=listed(RUNNABLE_TESTS)
const excludedTests=[...readFileSync(path.join(target,EXCLUDED_TESTS),'utf8').matchAll(/^\| `(production-source\/[^`]+\.test\.ts)` \|/gm)].map(match=>match[1])
const denoTests=packaged.filter(file=>file.startsWith('production-source/')&&file.endsWith('.test.ts'))
assert.ok(standaloneTests.length>0&&standaloneTests.every(file=>packaged.includes(file)),'standalone-tests.txt lists a file the package lacks')
assert.ok(runnableTests.length>0&&runnableTests.every(file=>packaged.includes(file)),'runnable-tests.txt lists a file the package lacks')
assert.ok(standaloneTests.every(file=>runnableTests.includes(file)),'a standalone test is missing from the published run')
assert.deepEqual([...runnableTests,...excludedTests].sort(),[...denoTests].sort(),'every production-source Deno test is either run or listed with its reason, once')
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
const denoRun=(args,label)=>{
  const result=spawnSync('deno',args,{cwd:target,windowsHide:true,encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024})
  const output=`${result.stdout||''}${result.stderr||''}`.replace(/\x1b\[[0-9;]*m/g,'')
  if(result.error||result.status!==0)throw Error(`${label} failed: ${result.error?.message||output.slice(-3000)}`)
  return output
}
console.log(`standalone subset: ${denoRun(['test','--allow-read','--allow-env','--no-check','-q',...standaloneTests],'standalone production-source tests').trim().split(/\r?\n/).pop()}`)
denoRun(['cache','--config',TEST_CONFIG,...runnableTests],'fetching the test dependencies')
const published=denoRun(['test','--config',TEST_CONFIG,'--cached-only','--allow-read','--allow-env','--no-check','-q',...runnableTests],'published production-source tests')
assert.ok(!published.includes('TEST STAND-IN reached'),'a published test reached a stand-in')
console.log(`published run (${runnableTests.length} files, ${excludedTests.length} listed in ${EXCLUDED_TESTS}): ${published.trim().split(/\r?\n/).pop()}`)
const vite=path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js')
console.log(run(['--test',...manifest.files.filter(f=>f.file.startsWith('tests/')&&f.file.endsWith('.test.mjs')).map(f=>f.file)],target))
console.log(run([vite,'build',target,'--config',path.join(target,'vite.config.mjs')],target))
console.log(JSON.stringify({target,sourceFiles:manifest.files.length,sourceBytes:manifest.files.reduce((sum,f)=>sum+f.bytes,0),verified:'manifest hashes, excluded private paths, worker/license inclusion, emitted server tests and package build',dependencyInstall:'This regression uses existing workspace dependencies. Fresh standalone dependency installation is a separately recorded check.'}))
