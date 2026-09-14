/** Preserve an Intel deep link through workspace bootstrap without open redirects. */
export function intelReturnPath(value) {
 if(typeof value!=='string'||value.length>8000||!value.startsWith('/intel')||/[\\\r\n\u0000]/.test(value))return null
 try{
  const url=new URL(value,'https://intel.invalid')
  if(url.origin!=='https://intel.invalid'||!/^\/intel(?:\/|$)/.test(url.pathname)||/^\/intel\/(?:start|signup)(?:\/|$)/.test(url.pathname))return null
  return url.pathname+url.search+url.hash
 }catch{return null}
}
