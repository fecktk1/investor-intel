/** The full address of a shared chart: the capability lives in the fragment, so
 * it is never sent to a server on the first request. */
export function chartShareUrl(share,origin,previewEnabled=false){
 if(!/^[a-f0-9]{64}$/.test(share?.token||''))return ''
 return previewEnabled&&['public','unlisted'].includes(share.audience)?`${origin}/intel/chart-link/${share.token}`:`${origin}/intel/shared-chart#${share.token}`
}
/** The short address, minted on tcfqr.link when the link is created.
 *
 * This is the address a member hands out: eight base62 characters instead of
 * sixty-four hex ones, uniqueness enforced by the slug index rather than
 * assumed, and nothing about the chart readable from the address itself.
 * The service already builds the absolute form; the slug is accepted too so a
 * stored row is enough. */
const SHORT_ORIGIN='https://tcfqr.link'
export function chartShareShortUrl(share){
 if(typeof share?.shortUrl==='string'&&/^https:\/\/[a-z0-9.-]+\/[0-9A-Za-z]{6,16}$/.test(share.shortUrl))return share.shortUrl
 return /^[0-9A-Za-z]{6,16}$/.test(share?.short_slug||'')?`${SHORT_ORIGIN}/${share.short_slug}`:''
}
