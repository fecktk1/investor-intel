import {calculateStudy,STUDY_CATALOG,CHART_ANALYSIS_VERSION,type Study} from './chart-analysis.ts'
import {validateSavedOutcome,type SavedOutcomeAssumptions} from './chart-outcome-contract.ts'
/** The widest chart window any range can ask for: twenty years and a day.
 *
 * The chart's 'ALL' range is twenty years (`CHART_WINDOWS` in cmc-chart.ts),
 * which the stored candle archive can genuinely answer, and a window cap written
 * for a one-year chart refuses it — which is how the long ranges lost their
 * alert markers, their saved layouts and their position lane. The extra day is
 * slack for a request whose ends are clocks rather than exact boundaries. */
export const MAX_CHART_WINDOW_MS = 7301 * 86400000

export const CHART_LAYOUT_VERSION=1
export const DRAWING_TOOLS=['trendline','arrow','horizontal','ray','rectangle','price_range','fibonacci','text','extended','horizontal_ray','vertical','channel','arrow_up','arrow_down','price_label','measure','tweet'] as const
export type DrawingTool=typeof DRAWING_TOOLS[number]
// How many time/price anchors each tool stores. Everything not listed keeps the
// original two-anchor shape, so layouts saved before these tools still validate.
export const DRAWING_ANCHOR_COUNT:Record<string,number>={horizontal:1,text:1,horizontal_ray:1,vertical:1,arrow_up:1,arrow_down:1,price_label:1,tweet:1,channel:3}
export const drawingAnchorCount=(tool:string)=>DRAWING_ANCHOR_COUNT[tool]??2
export const DRAWING_DASHES=['solid','dashed','dotted'] as const
export type DrawingDash=typeof DRAWING_DASHES[number]
// The plot heights the size control cycles through, and the indicator presets the
// layout control offers. Both are carried ONLY by a working state, which is why
// they are written back only when they are present: a layout saved before these
// existed validates to exactly the object it validated to before.
export const CHART_SIZES=['default','tall','fullscreen'] as const
export const CHART_PRESETS=['Clean','Research','Momentum','Volume','Custom'] as const
// Candle widths, lower-cased. '1m' is ONE MINUTE and '1mo' is one month: the two
// are different widths and are never folded together.
export const CHART_INTERVALS=['auto','1m','5m','15m','30m','1h','4h','1d','1w','1mo'] as const
// A public post address on X. Query strings and the twitter.com host are accepted
// and normalized away so the same post caches under one key.
const TWEET_URL=/^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/([0-9]{1,25})(?:[/?#].*)?$/
export function tweetStatusUrl(value:unknown):string {
 const match=typeof value==='string'&&value.length<=500?TWEET_URL.exec(value.trim()):null
 if(!match)throw new Error('invalid_tweet_url')
 return `https://x.com/${match[1]}/status/${match[2]}`
}
export type ChartAnchor={t:number;price:number}
/** The size a member gave a post card, in CSS pixels. Only a post carries one;
 * every other drawing is sized by its anchors. Bounded so a saved layout can
 * never hold a card wider or taller than a chart. */
export type DrawingBox={width:number;height:number}
export const DRAWING_BOX_LIMITS={minWidth:200,maxWidth:640,minHeight:110,maxHeight:720}
export type ChartDrawing={id:string;tool:DrawingTool;anchors:ChartAnchor[];text:string;color:string;width:number;dash?:DrawingDash;url?:string;box?:DrawingBox;ratios?:number[];outcome?:SavedOutcomeAssumptions}
export type ChartComparison={assets:{asset:string;label:string}[];arrangement:'overlay'|'2x2'|'1x4';priceScale:'independent'|'shared'|'returns';period:string}
export type ChartLayout={purpose?:'study_template';replay?:{at:number;knownOnly:boolean};comparison?:ChartComparison;size?:string;preset?:string;schemaVersion:1;asset:string;interval:string;range:{from:number;to:number};mode:string;scale:string;autoScale:boolean;volume:boolean;theme:string;timezone:string;studies:Study[];drawings:ChartDrawing[];visibility:Record<string,boolean>}
export const isUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const string=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)
const choice=(value:any,values:string[],fallback:string)=>{if(value==null)return fallback;if(typeof value!=='string'||!values.includes(value))throw new Error('invalid_chart_option');return value}
export function chartAsset(value:unknown):string {
 if(!string(value,240)||!(/^(market:(coinmarketcap:[1-9][0-9]{0,11}|coingecko:[a-z0-9][a-z0-9-]{0,120})|rwa:coinmarketcap:[1-9][0-9]{0,11}|native:[a-z0-9_-]{1,50}|eip155:[1-9][0-9]*(\/native:[a-z0-9]+|\/erc20:0x[a-fA-F0-9]{40}|:native|:0x[a-fA-F0-9]{40})|solana:(native:SOL|mainnet\/(native:sol|spl:[1-9A-HJ-NP-Za-km-z]{32,44})|[1-9A-HJ-NP-Za-km-z]{32,44})|bip122:(native:BTC|mainnet\/native:btc))$/.test(value as string)))throw new Error('invalid_chart_asset')
 return value as string
}
export function chartAnchor(value:any):ChartAnchor {
 if(!object(value)||!finite(value.t)||value.t<0||value.t>4102444800000||!finite(value.price)||value.price<=0||value.price>1e18)throw new Error('invalid_drawing_anchor')
 return {t:value.t,price:value.price}
}
export function validateDrawing(value:any):ChartDrawing {
 if(!object(value)||!isUuid(value.id)||!DRAWING_TOOLS.includes(value.tool)||!Array.isArray(value.anchors)||value.anchors.length!==drawingAnchorCount(value.tool))throw new Error('invalid_drawing')
 const text=value.text??'',color=value.color??'#DFA647',width=value.width??2,dash=value.dash??'solid'
 if(!string(text,2000)||typeof color!=='string'||!/^#[a-f0-9]{6}$/i.test(color)||!Number.isInteger(width)||width<1||width>5||!(DRAWING_DASHES as readonly string[]).includes(dash))throw new Error('invalid_drawing_style')
 const drawing:ChartDrawing={id:value.id,tool:value.tool,anchors:value.anchors.map(chartAnchor),text,color,width}
 // Only a non-default dash is stored, so a layout saved before dashes existed keeps its exact fingerprint.
 if(dash!=='solid')drawing.dash=dash as DrawingDash
 if(value.tool==='tweet')drawing.url=tweetStatusUrl(value.url)
 else if(value.url!=null)throw new Error('invalid_tweet_url')
 if(value.box!=null){
  const {minWidth,maxWidth,minHeight,maxHeight}=DRAWING_BOX_LIMITS,box=value.box
  if(value.tool!=='tweet'||!object(box)||!Number.isInteger(box.width)||!Number.isInteger(box.height)||box.width<minWidth||box.width>maxWidth||box.height<minHeight||box.height>maxHeight)throw new Error('invalid_drawing_box')
  drawing.box={width:box.width,height:box.height}
 }
 if(value.outcome!=null){if(value.tool!=='text')throw new Error('invalid_chart_outcome_assumptions');drawing.outcome=validateSavedOutcome(value.outcome)}
 if(value.tool==='fibonacci'){
  const ratios=value.ratios??[0,0.236,0.382,0.5,0.618,0.786,1]
  if(!Array.isArray(ratios)||ratios.length<2||ratios.length>20||ratios.some(r=>!finite(r)||r< -5||r>5)||new Set(ratios).size!==ratios.length)throw new Error('invalid_fibonacci_ratios')
  drawing.ratios=[...ratios]
 }
 return drawing
}
export function validateChartLayout(value:any):ChartLayout {
 if(!object(value)||value.schemaVersion!==1||JSON.stringify(value).length>150000)throw new Error('invalid_chart_layout')
 const asset=chartAsset(value.asset),range=value.range
 if(!object(range)||!finite(range.from)||!finite(range.to)||range.from<0||range.to<=range.from||range.to>4102444800000||range.to-range.from>MAX_CHART_WINDOW_MS)throw new Error('invalid_chart_range')
 if(!Array.isArray(value.studies)||value.studies.length>20||!Array.isArray(value.drawings)||value.drawings.length>200)throw new Error('chart_layout_limit')
 const studies=value.studies.map((study:any)=>{
  if(!object(study)||!string(study.id,80)||!study.id||typeof study.type!=='string'||!Object.hasOwn(STUDY_CATALOG,study.type)||study.params!=null&&!object(study.params))throw new Error('invalid_chart_study')
  const spec=STUDY_CATALOG[study.type],params:Record<string,unknown>={}
  for(const [k,v]of Object.entries(study.params??{})){
   if(!(k in spec.defaults)&&!(study.type==='vwap'&&k==='anchor'))throw new Error('invalid_study_parameter')
   if(!finite(v))throw new Error('invalid_study_parameter')
   params[k]=v
  }
  const normalized={id:study.id,type:study.type,params};calculateStudy([],normalized);return normalized
 })
 if(new Set(studies.map((s:Study)=>s.id)).size!==studies.length)throw new Error('duplicate_study_id')
 const drawings=value.drawings.map(validateDrawing)
 if(new Set(drawings.map((d:ChartDrawing)=>d.id)).size!==drawings.length)throw new Error('duplicate_drawing_id')
 const timezone=value.timezone??'UTC'
 if(!string(timezone,80))throw new Error('invalid_chart_timezone')
 try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format(0)}catch{throw new Error('invalid_chart_timezone')}
 if(value.visibility!=null&&!object(value.visibility))throw new Error('invalid_chart_visibility')
 const visibility:Record<string,boolean>={}
 if(Object.keys(value.visibility??{}).length>40)throw new Error('invalid_chart_visibility')
 for(const [key,visible]of Object.entries(value.visibility??{})){if(!/^[a-z][a-z0-9_]{0,39}$/.test(key)||typeof visible!=='boolean')throw new Error('invalid_chart_visibility');visibility[key]=visible}
 for(const flag of ['autoScale','volume'])if(value[flag]!=null&&typeof value[flag]!=='boolean')throw new Error('invalid_chart_option')
 let comparison:ChartComparison|undefined
 if(value.comparison!=null){
  const c=value.comparison
  if(!object(c)||!Array.isArray(c.assets)||c.assets.length<2||c.assets.length>4)throw new Error('invalid_chart_comparison')
  const assets=c.assets.map((a:any)=>{if(!object(a)||!string(a.label,120)||!a.label.trim())throw new Error('invalid_chart_comparison');return {asset:chartAsset(a.asset),label:a.label.trim()}})
  if(assets[0].asset!==asset||new Set(assets.map(a=>a.asset)).size!==assets.length)throw new Error('invalid_chart_comparison')
  comparison={assets,arrangement:choice(c.arrangement,['overlay','2x2','1x4'],'overlay') as ChartComparison['arrangement'],priceScale:choice(c.priceScale,['independent','shared','returns'],'independent') as ChartComparison['priceScale'],period:choice(c.period,['24H','7D','1M','3M','1Y'],'7D')}
 }
 let replay:ChartLayout['replay']
 if(value.replay!=null){if(!object(value.replay)||!finite(value.replay.at)||value.replay.at<0||value.replay.at>4102444800000||typeof value.replay.knownOnly!=='boolean'||comparison)throw new Error('invalid_chart_replay');replay={at:value.replay.at,knownOnly:value.replay.knownOnly}}
 if(value.purpose!=null&&(value.purpose!=='study_template'||!studies.length||drawings.length||comparison||replay||Object.keys(visibility).length))throw new Error('invalid_chart_template')
 // Absent stays absent: a stored layout that never carried a size or a preset
 // validates to the same object it always did, so its fingerprint is unchanged.
 const size=value.size==null?undefined:choice(value.size,[...CHART_SIZES],'default')
 const preset=value.preset==null?undefined:choice(value.preset,[...CHART_PRESETS],'Clean')
 return {...(replay?{replay}:{}),...(value.purpose?{purpose:'study_template' as const}:{}),...(comparison?{comparison}:{}),...(size?{size}:{}),...(preset?{preset}:{}),schemaVersion:1,asset,range:{from:range.from,to:range.to},interval:choice(value.interval,[...CHART_INTERVALS],'auto'),
  mode:choice(value.mode,['line','candles','ohlc'],'line'),scale:choice(value.scale,['linear','log','percent','indexed'],'linear'),theme:choice(value.theme,['app','dark','light','gray'],'app'),timezone,
  autoScale:value.autoScale??true,volume:value.volume??false,studies,drawings,visibility}
}
export function chartStateFingerprint(layout:ChartLayout) {return JSON.stringify({version:CHART_ANALYSIS_VERSION,...validateChartLayout(layout)})}
