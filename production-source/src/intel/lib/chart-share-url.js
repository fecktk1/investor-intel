export function chartShareUrl(share,origin,previewEnabled=false){
 if(!/^[a-f0-9]{64}$/.test(share?.token||''))return ''
 return previewEnabled&&['public','unlisted'].includes(share.audience)?`${origin}/intel/chart-link/${share.token}`:`${origin}/intel/shared-chart#${share.token}`
}
