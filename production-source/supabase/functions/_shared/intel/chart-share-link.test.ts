// The short address for a shared chart, and the one property the whole feature
// rests on: the capability lives in the URL FRAGMENT, and qr-redirect must hand
// that fragment back to the browser untouched. A redirect that parsed,
// normalized or re-encoded the stored destination would drop the token and open
// an empty viewer, with nothing in a log to show why.
import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {chartShareShortUrl,validChartShareSlug,CHART_SHARE_SHORT_ORIGIN} from './chart-share-service.ts'
import {redirect} from '../../qr-redirect/index.ts'

const TOKEN='a'.repeat(64)
const DESTINATION=`https://thecontentforge.io/intel/shared-chart#${TOKEN}`

Deno.test('the short address is the tcfqr front door and nothing else',()=>{
 eq(chartShareShortUrl('Ab3xZ9kQ'),`${CHART_SHARE_SHORT_ORIGIN}/Ab3xZ9kQ`)
 eq(chartShareShortUrl('Ab3xZ9kQ'),'https://tcfqr.link/Ab3xZ9kQ')
 // Short enough to hand out, and it says nothing about the chart behind it.
 eq(chartShareShortUrl('Ab3xZ9kQ')!.length<32,true)
 for(const bad of [null,undefined,'','short','/etc/passwd','Ab3xZ9kQ/..','https://evil.test/x','A'.repeat(20),'ab-3xZ9k'])eq(chartShareShortUrl(bad),null)
 for(const bad of [null,'ab',' Ab3xZ9kQ','Ab3xZ9kQ '])eq(validChartShareSlug(bad),false)
})

Deno.test('qr-redirect copies the destination into Location byte for byte, fragment included',()=>{
 const response=redirect(DESTINATION)
 eq(response.status,302)
 eq(response.headers.get('Location'),DESTINATION)
 // The capability itself survived: no truncation at '#', no re-encoding of it.
 eq(response.headers.get('Location')!.endsWith(`#${TOKEN}`),true)
 eq(response.headers.get('Location')!.includes('%23'),false)
 // A scan-time redirect is never cached, or one reader's link would be served
 // to the next.
 eq(response.headers.get('Cache-Control'),'no-store')
})

Deno.test('a fragment with reserved characters is still not rewritten',()=>{
 for(const destination of ['https://thecontentforge.io/intel/shared-chart#a/b?c=d','https://thecontentforge.io/intel/shared-chart#'+'f'.repeat(64),'https://thecontentforge.io/intel/shared-chart'])
  eq(redirect(destination).headers.get('Location'),destination)
})
