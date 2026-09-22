import assert from 'node:assert/strict'

Deno.test('CMC HTTP credentials and provider URLs remain confined to the governed transport',async()=>{
  const root=new URL('../../../../',import.meta.url),violations:string[]=[]
  async function walk(relative:string){
    try{await Deno.stat(new URL(relative+'/',root))}catch(error){if(error instanceof Deno.errors.NotFound)return;throw error}
    for await(const file of Deno.readDir(new URL(relative+'/',root))){
      const name=relative+'/'+file.name
      if(file.isDirectory)await walk(name)
      else if(/\.(ts|tsx|js|mjs)$/.test(name)&&!/[.](test|spec)[.]/.test(name)){
        const source=(await Deno.readTextFile(new URL(name,root))).split('\n').filter(l=>!l.trim().startsWith('//')).join('\n')
        if(/['"`]https?:\/\/pro-api\.coinmarketcap\.com|['"]X-CMC_PRO_API_KEY['"]/.test(source)&&!['supabase/functions/_shared/market-assets/cmc-transport.ts','worker/src/intel-live-focus.ts','supabase/functions/_shared/market-assets/cmc-reproduce.ts'].includes(name))violations.push(name)
      }
    }
  }
  for(const dir of ['supabase/functions','worker/src','src','netlify/functions'])await walk(dir)
  assert.deepEqual(violations,[])
})
// cmc-reproduce.ts names the provider base only to PRINT a curl command for a
// reader's own key. It is exempt from the URL rule above on the condition that it
// never calls anything and never reads a key: it must stay text-only.
Deno.test('the reproduce command builder never calls the provider or reads a key',async()=>{
  const source=(await Deno.readTextFile(new URL('./cmc-reproduce.ts',import.meta.url))).split('\n').filter(l=>!l.trim().startsWith('//')&&!l.trim().startsWith('*')).join('\n')
  assert.doesNotMatch(source,/\bfetch\s*\(|Deno\.env|process\.env|import\.meta\.env|XMLHttpRequest|WebSocket/)
  assert.doesNotMatch(source,/from\s+['"][^'"]*cmc-transport/)
})
