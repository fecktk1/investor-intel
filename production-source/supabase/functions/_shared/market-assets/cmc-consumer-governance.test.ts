import assert from 'node:assert/strict'

Deno.test('CMC HTTP credentials and provider URLs remain confined to the governed transport',async()=>{
  const root=new URL('../../../../',import.meta.url),violations:string[]=[]
  async function walk(relative:string){
    for await(const file of Deno.readDir(new URL(relative+'/',root))){
      const name=relative+'/'+file.name
      if(file.isDirectory)await walk(name)
      else if(/\.(ts|tsx|js|mjs)$/.test(name)&&!/[.](test|spec)[.]/.test(name)){
        const source=(await Deno.readTextFile(new URL(name,root))).split('\n').filter(l=>!l.trim().startsWith('//')).join('\n')
        if(/['"`]https?:\/\/pro-api\.coinmarketcap\.com|['"]X-CMC_PRO_API_KEY['"]/.test(source)&&!['supabase/functions/_shared/market-assets/cmc-transport.ts','worker/src/intel-live-focus.ts'].includes(name))violations.push(name)
      }
    }
  }
  for(const dir of ['supabase/functions','worker/src','src','netlify/functions'])await walk(dir)
  assert.deepEqual(violations,[])
})
