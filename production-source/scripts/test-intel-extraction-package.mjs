// Builds the newly emitted source package, rather than an older example bundle.
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
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
const vite=path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js')
console.log(run(['--test',...manifest.files.filter(f=>f.file.startsWith('tests/')&&f.file.endsWith('.test.mjs')).map(f=>f.file)],target))
console.log(run([vite,'build',target,'--config',path.join(target,'vite.config.mjs')],target))
console.log(JSON.stringify({target,sourceFiles:manifest.files.length,sourceBytes:manifest.files.reduce((sum,f)=>sum+f.bytes,0),verified:'manifest hashes, excluded private paths, worker/license inclusion, emitted server tests and package build',dependencyInstall:'This regression uses existing workspace dependencies. Fresh standalone dependency installation is a separately recorded check.'}))
