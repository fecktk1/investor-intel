import {STUDY_CATALOG} from '../../../supabase/functions/_shared/intel/chart-analysis'

// Indicator vocabulary for the chart tools. The catalogue itself is shared with
// the edge functions and keyed by study id; this file only decides how the list
// reads to a person: four named families, then anything the catalogue gains
// later, so a new study is never silently missing from the menu.
export const INDICATOR_FAMILIES=[
 ['trend',['sma','ema','dema','ichimoku','weekly']],
 ['momentum',['rsi','macd','stoch_rsi','vwrsi']],
 ['volatility',['bollinger','atr']],
 ['volume',['obv','vwap']],
]
export const FAMILY_LABELS={trend:'Trend',momentum:'Momentum',volatility:'Volatility',volume:'Volume',other:'Other indicators'}

export function indicatorFamilies(catalog=STUDY_CATALOG) {
 const placed=new Set(INDICATOR_FAMILIES.flatMap(([,types])=>types))
 const rest=Object.keys(catalog).filter(type=>!placed.has(type))
 return [...INDICATOR_FAMILIES.map(([family,types])=>[family,types.filter(type=>Object.hasOwn(catalog,type))]).filter(([,types])=>types.length),...(rest.length?[['other',rest]]:[])]
}

/** Parameters as they stand right now: the active instances if the indicator is
 * on, otherwise the defaults it would be added with. A zero is a value. */
export function indicatorParameters(type,studies,catalog=STUDY_CATALOG) {
 const active=studies.filter(study=>study.type===type)
 const sets=active.length?active.map(study=>({...catalog[type].defaults,...study.params})):[{...catalog[type].defaults}]
 return sets.map(params=>Object.entries(params).filter(([,value])=>value!=null).map(([key,value])=>`${key} ${value}`).join(', ')).filter(Boolean)
}
