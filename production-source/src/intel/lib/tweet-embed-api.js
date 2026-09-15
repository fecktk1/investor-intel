import {tweetStatusUrl} from '../../../supabase/functions/_shared/intel/chart-workspace-contract'

// Read one post from X through the Intel edge function. The browser never calls
// X. This never throws and never returns a blank card: a post that could not be
// read comes back as `{state:'unavailable', reason}` so the card can say so.
export async function readTweetEmbed(context,url,{signal}={}) {
 let canonical
 try{canonical=tweetStatusUrl(url)}catch{return {url:typeof url==='string'?url:'',state:'unavailable',reason:'invalid_tweet_url'}}
 if(!context?.supabase||!context.orgId)return {url:canonical,state:'unavailable',reason:'tweet_embed_unavailable'}
 try{
  const {data,error}=await context.supabase.functions.invoke('intel-tweet-embed',{body:{orgId:context.orgId,url:canonical},...(signal?{signal}:{})})
  if(error){
   const details=await error.context?.json?.().catch(()=>null)
   return {url:canonical,state:'unavailable',reason:details?.error||'tweet_embed_unavailable'}
  }
  if(!data||data.error||typeof data.text!=='string')return {url:canonical,state:'unavailable',reason:data?.error||'tweet_embed_unavailable'}
  return {
   url:canonical,state:'ready',reason:null,
   author:typeof data.author==='string'?data.author.slice(0,120):null,
   handle:typeof data.handle==='string'?data.handle.slice(0,15):null,
   text:data.text.slice(0,1000),
   postedAt:typeof data.postedAt==='string'&&Number.isFinite(Date.parse(data.postedAt))?data.postedAt:null,
  }
 }catch(e){
  if(e?.name==='AbortError')throw e
  return {url:canonical,state:'unavailable',reason:'tweet_embed_unavailable'}
 }
}
