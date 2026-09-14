import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { existsSync } from 'node:fs'
if(existsSync('.env'))process.loadEnvFile('.env')
const require=createRequire(import.meta.url)
const vite=path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js')
const children=[spawn(process.execPath,['server/index.mjs'],{stdio:'inherit',windowsHide:true}),spawn(process.execPath,[vite],{stdio:'inherit',windowsHide:true})]
let closing=false
function close(code=0){if(closing)return;closing=true;for(const child of children)child.kill();process.exitCode=code}
for(const child of children)child.on('exit',code=>close(code||0))
process.on('SIGINT',()=>close());process.on('SIGTERM',()=>close())
