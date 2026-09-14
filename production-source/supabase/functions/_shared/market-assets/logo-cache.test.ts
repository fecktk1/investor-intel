import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {selectLogoCandidates,logoObjectPath,validateLogoResponse,publicLogoUrl,nextErrorState,logoRowKind,MAX_LOGO_BYTES} from './logo-cache.ts'

const NOW='2026-09-15T00:00:00.000Z'
const days=(n:number)=>new Date(Date.parse(NOW)-n*86_400_000).toISOString()
const asset=(o:Record<string,unknown>={})=>({source_provider:'coinmarketcap',provider_id:'1',symbol:'BTC',market_cap_rank:1,image_url:'https://s2.coinmarketcap.com/1.png',cached_image_url:null,image_verified_at:null,image_last_checked_at:null,image_error_count:0,image_fallback_type:null,...o})
const meme=(o:Record<string,unknown>={})=>({chain:'solana',token_address:'AbC123',symbol:'WIF',image_url:'https://dd.dexscreener.com/wif.png',cached_image_url:null,image_verified_at:null,image_last_checked_at:null,image_error_count:0,...o})
const ids=(rows:any[])=>rows.map(r=>r.provider_id??r.token_address)

Deno.test('logo candidates admit only https rows that are unmirrored, stale or under the error budget',()=>{
 // Eligible: never cached; cached but never verified; cached and verified beyond the recheck window.
 eq(ids(selectLogoCandidates([
  asset({provider_id:'fresh',cached_image_url:'https://cdn/x.png',image_verified_at:days(2)}),   // still fresh → skip
  asset({provider_id:'stale',cached_image_url:'https://cdn/x.png',image_verified_at:days(9)}),
  asset({provider_id:'unverified',cached_image_url:'https://cdn/x.png',image_verified_at:null}),
  asset({provider_id:'new'}),
 ],NOW)).sort(),['new','stale','unverified'])

 // Rejected inputs: http, missing, blank, and rows that exhausted maxErrors.
 eq(selectLogoCandidates([
  asset({provider_id:'insecure',image_url:'http://s2.coinmarketcap.com/1.png'}),
  asset({provider_id:'none',image_url:null}),
  asset({provider_id:'blank',image_url:'   '}),
  asset({provider_id:'burned',image_error_count:3}),
 ],NOW).length,0)
 // The budget is exclusive: one attempt left is still a candidate.
 eq(ids(selectLogoCandidates([asset({provider_id:'last-try',image_error_count:2})],NOW)),['last-try'])
 eq(ids(selectLogoCandidates([asset({provider_id:'custom',image_error_count:1})],NOW,{maxErrors:1})),[])
 eq(ids(selectLogoCandidates([asset({provider_id:'wide',cached_image_url:'https://cdn/x.png',image_verified_at:days(9)})],NOW,{recheckDays:30})),[])
 eq(selectLogoCandidates(null,NOW).length,0)
})

Deno.test('logo candidates order by market-cap rank then least-recently-checked',()=>{
 const rows=[
  asset({provider_id:'rank-9',market_cap_rank:9,image_last_checked_at:days(1)}),
  meme({token_address:'unranked-recent',image_last_checked_at:days(1)}),
  asset({provider_id:'rank-2',market_cap_rank:2,image_last_checked_at:days(30)}),
  meme({token_address:'unranked-never',image_last_checked_at:null}),
  meme({token_address:'unranked-old',image_last_checked_at:days(40)}),
 ]
 eq(ids(selectLogoCandidates(rows,NOW)),['rank-2','rank-9','unranked-never','unranked-old','unranked-recent'])
 // Ranked rows always precede unranked ones even when the unranked row is older.
 eq(ids(selectLogoCandidates([meme({token_address:'m'}),asset({provider_id:'a',market_cap_rank:500,image_last_checked_at:days(1)})],NOW)),['a','m'])
 // Pure: the caller's array is not reordered in place.
 const input=[asset({provider_id:'b',market_cap_rank:2}),asset({provider_id:'a',market_cap_rank:1})]
 selectLogoCandidates(input,NOW);eq(ids(input),['b','a'])
})

Deno.test('logo object paths are namespaced, lowercased and extension-typed',()=>{
 eq(logoObjectPath(asset(),'image/png'),'market-logos/coinmarketcap/1.png')
 eq(logoObjectPath(asset({source_provider:'CoinGecko',provider_id:'wrapped-bitcoin'}),'image/webp'),'market-logos/coingecko/wrapped-bitcoin.webp')
 eq(logoObjectPath(meme({chain:'Solana',token_address:'AbC123'}),'image/jpeg'),'market-logos/memecoin/solana/abc123.jpg')
 // Content type wins; without one the extension comes from the URL, else png.
 eq(logoObjectPath(asset({image_url:'https://cdn/logo.JPEG?v=2'})),'market-logos/coinmarketcap/1.jpg')
 eq(logoObjectPath(asset({image_url:'https://cdn/logo'})),'market-logos/coinmarketcap/1.png')
 // Hostile ids cannot escape the prefix: no slashes survive and dot runs collapse.
 eq(logoObjectPath(asset({provider_id:'../../secret'}),'image/png'),'market-logos/coinmarketcap/secret.png')
 eq(logoObjectPath(asset({provider_id:'a/b/../c'}),'image/png'),'market-logos/coinmarketcap/a-b-.-c.png')
 eq(logoObjectPath(asset({provider_id:'   '}),'image/png'),'market-logos/coinmarketcap/unknown-id.png')
 eq(logoRowKind(asset()),'catalogue');eq(logoRowKind(meme()),'memecoin')
})

Deno.test('logo responses validate on mime, size and the catalogue-only svg rule',()=>{
 eq(validateLogoResponse('image/png',2048,'catalogue'),{ok:true,contentType:'image/png',ext:'png'})
 eq(validateLogoResponse('image/JPEG; charset=binary',10,'memecoin'),{ok:true,contentType:'image/jpeg',ext:'jpg'})
 eq(validateLogoResponse('image/svg+xml',900,'catalogue').ok,true)
 // svg is executable markup — never re-served from our origin for attacker-supplied memecoin metadata.
 eq(validateLogoResponse('image/svg+xml',900,'memecoin'),{ok:false,reason:'svg_not_allowed_for_memecoin'})
 eq(validateLogoResponse('text/html',900,'catalogue'),{ok:false,reason:'unsupported_content_type:text/html'})
 eq(validateLogoResponse(null,900,'catalogue'),{ok:false,reason:'missing_content_type'})
 eq(validateLogoResponse('image/png',0,'catalogue'),{ok:false,reason:'empty_body'})
 eq(validateLogoResponse('image/png',MAX_LOGO_BYTES,'catalogue').ok,true)
 eq(validateLogoResponse('image/png',MAX_LOGO_BYTES+1,'catalogue'),{ok:false,reason:`too_large:${MAX_LOGO_BYTES+1}`})
})

Deno.test('public logo url joins the bucket path without doubling slashes',()=>{
 eq(publicLogoUrl('https://abc.supabase.co','market-logos/coinmarketcap/1.png'),'https://abc.supabase.co/storage/v1/object/public/public-assets/market-logos/coinmarketcap/1.png')
 eq(publicLogoUrl('https://abc.supabase.co/','/market-logos/x.png'),'https://abc.supabase.co/storage/v1/object/public/public-assets/market-logos/x.png')
})

Deno.test('error state increments and pins to initials only at the cap',()=>{
 eq(nextErrorState(asset({image_error_count:0})),{image_error_count:1,image_fallback_type:null})
 eq(nextErrorState(asset({image_error_count:1,image_fallback_type:'provider'})),{image_error_count:2,image_fallback_type:'provider'})
 eq(nextErrorState(asset({image_error_count:2})),{image_error_count:3,image_fallback_type:'initials'})
 eq(nextErrorState(asset({image_error_count:0}),{maxErrors:1}),{image_error_count:1,image_fallback_type:'initials'})
 eq(nextErrorState({}),{image_error_count:1,image_fallback_type:null})
})
