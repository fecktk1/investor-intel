type Register=(task:Promise<void>)=>void
/** Only supplementary context runs here, after the owned artifact is persisted.
 * EdgeRuntime retains this task within its normal execution limits. Local
 * runtimes without that facility await it, rather than silently abandoning it.
 */
export async function continuePortfolioContext(work:()=>Promise<void>,register?:Register){
 const runtime=(globalThis as unknown as {EdgeRuntime?:{waitUntil:Register}}).EdgeRuntime
 const retain=register||runtime?.waitUntil?.bind(runtime)
 const task=Promise.resolve().then(work).catch(()=>{console.warn('[intel-portfolio] private context continuation failed')})
 if(retain){try{retain(task);return}catch{/* Preserve the work if registration fails. */}}
 await task
}
