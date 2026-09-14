// Builds the newly emitted source package, rather than an older example bundle.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
const vite=path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js')
console.log(run(['--test',...manifest.files.filter(f=>f.file.startsWith('tests/')&&f.file.endsWith('.test.mjs')).map(f=>f.file)],target))
console.log(run([vite,'build',target,'--config',path.join(target,'vite.config.mjs')],target))
console.log(JSON.stringify({target,sourceFiles:manifest.files.length,sourceBytes:manifest.files.reduce((sum,f)=>sum+f.bytes,0),verified:'manifest hashes, excluded private paths, worker/license inclusion, emitted server tests and package build',dependencyInstall:'This regression uses existing workspace dependencies. Fresh standalone dependency installation is a separately recorded check.'}))
