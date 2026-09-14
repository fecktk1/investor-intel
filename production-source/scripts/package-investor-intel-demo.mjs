// Explicit source-only extraction. No recursive repository copy, credentials,
// customer data, production migrations, build output or node_modules enter it.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),example=path.join(root,'examples/investor-intel-hackathon')
// Explicit fail-closed boundaries keep private app providers out of the standalone package.
const adapters={
 'src/intel/components/ChartWatchlistAdd.jsx':'examples/investor-intel-hackathon/adapters/ChartWatchlistAdd.jsx',
 'src/intel/context/WatchlistSelection.jsx':'examples/investor-intel-hackathon/adapters/WatchlistSelection.js',
 'src/intel/lib/watchlist-api.js':'examples/investor-intel-hackathon/adapters/watchlist-api.js',
}
// Discovery validates this explicit list; it never authorizes new copies.
const chartSources=[...Object.keys(adapters),
  ...['TokenChart','TokenChartFallback','JournalMarkerReceipt','ChartReplayControls','ResponsiveChartTools','EvidenceMarkerContext','PriceWorkstation','ChartDrawings','ChartLayoutLibrary','ChartAssetNavigator','TokenAvatar','ChartSnapshotSave','ChartAlertEditor','ChartStructurePanel','ChartOutcomePanel','InvestigationTable','ChartReadPanel','ChartPatternPanel','ChartTimeframePanel'].map(name=>`src/intel/components/${name}.jsx`),
  ...['chart-history','chart-event-changes','useChartAlertHistory','chart-workspace-api','chart-replay','chart-renderer-data','useChartStudies','chart-study.worker','chart-drawings','chains','useChartStructure','chart-structure.worker'].map(name=>`src/intel/lib/${name}.js`),
  ...['chart-workspace-contract','chart-analysis','chart-outcome-contract','chart-drawing-geometry','chart-outcome','chart-read','chart-levels','chart-structure','chart-patterns','chart-timeframes'].map(name=>`supabase/functions/_shared/intel/${name}.ts`),
  'src/intel/vendor/lightweight-charts-5.2.0/renderer.mjs',
]
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
const shared=[...chartSources.map(file=>[adapters[file]||file,`product/${file}`]),
  ...['LICENSE','NOTICE'].map(file=>[`src/intel/vendor/lightweight-charts-5.2.0/${file}`,`product/src/intel/vendor/lightweight-charts-5.2.0/${file}`]),
  ['src/intel/workspace.css','product/src/intel/workspace.css'],
  ...['cmc-capabilities','cmc-dex'].map(name=>[`supabase/functions/_shared/market-assets/${name}.ts`,`server/${name}.ts`]),
  ...['inter-400.woff2','barlow-condensed-600.woff2','geist-mono-400.woff2','LICENSE.md'].map(file=>['public/vsx-fonts/'+file,'public/vsx-fonts/'+file]),
]
for(const [source,dest] of shared){const target=path.join(example,dest);mkdirSync(path.dirname(target),{recursive:true});copyFileSync(path.join(root,source),target)}
const files=['package.json','package-lock.json','.gitignore','.env.example','README.md','index.html','vite.config.mjs','dev.mjs','src/main.jsx','src/style.css','src/fixtures.mjs','src/notebook.mjs','src/chart-data.mjs','server/index.mjs','server/governance.mjs','tests/governance.test.mjs','tests/notebook.test.mjs','tests/chart-data.test.mjs',...shared.map(([,dest])=>dest)]
// Validate the entire emitted dependency graph, including the server and tests.
// A browser-only build cannot detect an omitted server capability dependency.
const emittedFiles=new Set(files)
for(const file of files.filter(file=>/\.(?:[cm]?js|jsx|tsx?)$/.test(file))){
 const code=readFileSync(path.join(example,file),'utf8')
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
for(const file of files){if(file.includes('..')||path.isAbsolute(file)||(!file.endsWith('.example')&&/^\.env/.test(file)))throw Error('Unsafe package path');const bytes=readFileSync(path.join(example,file));const dest=path.join(target,file);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,bytes);manifest.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})}
writeFileSync(path.join(target,'SOURCE-MANIFEST.json'),JSON.stringify({createdAt:new Date().toISOString(),sourceFiles:shared.map(([source,extracted])=>({source,extracted})),files:manifest},null,2)+'\n')
console.log(target)
console.log(`Packaged ${manifest.length} allowed source files (${manifest.reduce((sum,f)=>sum+f.bytes,0)} bytes). Publication remains separately gated.`)
