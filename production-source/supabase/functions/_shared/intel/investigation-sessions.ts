import { finite, instant, safeSourceUrl } from './investigation-evidence.ts'

// Scheduled US equity CORE sessions only, verified 2026-09-10. Emergency
// closures, extended sessions, issuer calendars and token venues are separate.
export const EQUITY_CALENDAR_SOURCE = 'https://www.nyse.com/trade/hours-calendars'
const holidays = new Set([
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
  '2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25',
])
const early = new Set(['2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24'])
const eastern = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function parts(time: number) { return Object.fromEntries(eastern.formatToParts(time).map(p => [p.type,p.value])) }
function dateKey(time: number) { const p = parts(time); return `${p.year}-${p.month}-${p.day}` }
function localInstant(date: string, hour: number, minute = 0) {
  // Derive the actual IANA offset at midday, including DST; trading opens are
  // never inside the ambiguous/repeated transition hour.
  const midday = Date.parse(`${date}T17:00:00Z`), p = parts(midday)
  const offset = Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute)-midday
  return Date.parse(`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00Z`)-offset
}
export function equitySession(asOf: number, market: string | null) {
  const supported = ['XNYS','XNAS'].includes(market ?? '') && Number.isFinite(asOf)
  const date = supported ? dateKey(asOf) : null, year = date ? +date.slice(0,4) : 0
  if (!supported || year < 2026 || year > 2028) return { state:'unavailable', reason: 'A verified NYSE/Nasdaq core-session calendar for 2026–2028 is required.', sourceUrl:EQUITY_CALENDAR_SOURCE, sessions:[] }
  const sessions: {date:string;open:number;close:number;earlyClose:boolean}[] = []
  const midnight = Date.parse(`${date}T00:00:00Z`)
  for (let d=0;d<12;d++) {
    const day = new Date(midnight+d*86400000), key = day.toISOString().slice(0,10)
    if (day.getUTCDay()===0 || day.getUTCDay()===6 || holidays.has(key) || day.getUTCFullYear()>2028) continue
    sessions.push({date:key,open:localInstant(key,9,30),close:localInstant(key,early.has(key)?13:16),earlyClose:early.has(key)})
  }
  const current = sessions.find(s => asOf>=s.open && asOf<s.close) ?? null
  const next = sessions.find(s => s.open>asOf) ?? null
  return { state:current?'scheduled_open':'scheduled_closed', date, current, next, sessions,
    sourceUrl:EQUITY_CALENDAR_SOURCE, verifiedAt:'2026-09-10', timezone:'America/New_York',
    reason:'Scheduled core equity session only. Emergency halts, extended sessions, token venues and issuer redemption are separate.' }
}
/** Published conventional Ondo sessions, never live trading/redemption status.
 * Holiday/early-close exceptions and per-asset off-hours are not inferred. */
export function ondoConventionalSession(asOf:number) {
  const underlying=equitySession(asOf,'XNAS')
  const actualAvailability='Live availability is unverified. Asset-specific off-hours, limits and halts can change whether a quote is available.'
  if(underlying.state==='unavailable')return {state:'unavailable',windows:[],current:null,actualAvailability}
  const date=dateKey(asOf),midnight=Date.parse(`${date}T00:00:00Z`)
  const windows:{date:string;name:string;open:number;close:number}[]=[]
  for(let d=-1;d<7;d++) {
    const day=new Date(midnight+d*86400000),key=day.toISOString().slice(0,10)
    if([0,6].includes(day.getUTCDay())||holidays.has(key)||early.has(key)||day.getUTCFullYear()>2028||day.getUTCFullYear()<2026)continue
    for(const [name,oh,om,ch,cm]of [['Pre-market',4,1,9,29],['Core',9,31,15,59],['Post-market',16,1,19,59]] as const)
      windows.push({date:key,name,open:localInstant(key,oh,om),close:localInstant(key,ch,cm)})
    const previous=new Date(day.getTime()-86400000).toISOString().slice(0,10)
    if(!holidays.has(previous)&&!early.has(previous))windows.push({date:key,name:'Overnight',open:localInstant(previous,20,5),close:localInstant(key,3,55)})
  }
  windows.sort((a,b)=>a.open-b.open)
  const exception=holidays.has(date)||early.has(date)
  const current=exception?null:windows.find(w=>asOf>=w.open&&asOf<w.close)??null
  return {state:exception?'exception_rules_required':current?'within_conventional_window':'outside_conventional_windows',
    windows:windows.filter(w=>w.close>asOf).slice(0,12),current,actualAvailability}
}
export interface IssuerTerms {
  issuerId:string; subject:string; description:string; sourceUrl:string; verifiedAt:string; expiresAt:string;
  eligibility:string; redemptionWindows?:{from:number;to:number}[]; tokenTradingDescription?:string
}
export function rwaSessionContext(input: { subject:string; issuerId:string; market:string|null; terms:IssuerTerms|null;
  token:{price:number|null;currency:string;observedAt:string|null}|null;
  underlying:{price:number|null;currency:string;observedAt:string|null;sourceUrl:string;unitsPerToken:number|null;basis:'nav'|'market';subject:string}|null }, asOf:number) {
  const terms = input.terms, validTerms = terms && terms.subject===input.subject && terms.issuerId===input.issuerId && safeSourceUrl(terms.sourceUrl) &&
    (instant(terms.verifiedAt)??Infinity)<=asOf && (instant(terms.expiresAt)??-Infinity)>asOf
  const token = input.token, underlying = input.underlying
  const tokenTime = instant(token?.observedAt), underlyingTime = instant(underlying?.observedAt)
  const comparable = underlying?.subject===input.subject && token && underlying && token.currency===underlying.currency && safeSourceUrl(underlying.sourceUrl) &&
    finite(token.price)!=null && token.price!>0 && finite(underlying.price)!=null && underlying.price!>0 && finite(underlying.unitsPerToken)!=null && underlying.unitsPerToken!>0 &&
    tokenTime!=null && underlyingTime!=null && tokenTime<=asOf && underlyingTime<=asOf && asOf-tokenTime<=300000 && asOf-underlyingTime<=300000 && Math.abs(tokenTime-underlyingTime)<=60000
  const reference = comparable ? underlying!.price!*underlying!.unitsPerToken! : null
  return { underlyingSession:equitySession(asOf,input.market),
    tokenTrading:validTerms?terms!.tokenTradingDescription??'Token venue hours have not been verified.':'Token venue hours have not been verified.',
    redemption:validTerms?{state:terms!.redemptionWindows?.some(w=>asOf>=w.from&&asOf<w.to)?'within_published_window':terms!.redemptionWindows?.length?'outside_published_window':'terms_only',terms}: {state:'unavailable',terms:null},
    comparison:comparable?{differencePercent:(token!.price!/reference!-1)*100,basis:underlying!.basis,reference,sourceUrl:underlying!.sourceUrl}:null,
    comparisonReason:comparable?'Timestamp-aligned reference comparison; eligibility and executable redemption are separate.':'Comparison requires a verified per-token reference, matching currency, fresh observations and aligned timestamps.' }
}
