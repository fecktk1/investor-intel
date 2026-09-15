import React from 'react'
import {useTranslation} from 'react-i18next'
import {DRAWING_COLORS} from '../lib/chart-drawing-tools'

// The floating style row for the selected drawing. Deferred: a chart with
// nothing selected never pays for it, and it is placed from the chart's own
// coordinate conversion, clamped to whatever the plot measures right now.
// A post card carries its own row inside the card (`inline`), under the post,
// so the row never covers the words; a post has no line, so the width and the
// line style are not offered for it, and the colour is the note's colour.
export default function ChartDrawingOptions({drawing,point,width,height,onChange,onEdit,onDelete,inline=false}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const left=Math.max(4,Math.min(Math.max(4,width-250),point?.x-40))
 const top=Math.max(4,Math.min(Math.max(4,height-40),point?.y+16))
 const line=drawing.tool!=='tweet'
 return <div className={inline?'intel-draw-options intel-draw-options-inline':'intel-draw-options'} role="group" aria-label={t('chart.draw.options',{defaultValue:'Drawing style'})} style={inline?undefined:{left,top}}>
  <span className="intel-draw-swatches">{DRAWING_COLORS.map(color=><button key={color} type="button" className="intel-draw-swatch" style={{background:color}}
   aria-pressed={drawing.color.toLowerCase()===color.toLowerCase()} aria-label={t('chart.draw.color_value',{defaultValue:'Color {{color}}',color})} onClick={()=>onChange({color})}/>)}</span>
  {line&&<label>{t('chart.draw.width',{defaultValue:'Width'})}<select value={drawing.width} onChange={event=>onChange({width:Number(event.target.value)})}>{[1,2,3,4,5].map(value=><option key={value} value={value}>{value}</option>)}</select></label>}
  {line&&<label>{t('chart.draw.dash',{defaultValue:'Line'})}<select value={drawing.dash||'solid'} onChange={event=>onChange({dash:event.target.value})}>
   <option value="solid">{t('chart.draw.dash_solid',{defaultValue:'Solid'})}</option>
   <option value="dashed">{t('chart.draw.dash_dashed',{defaultValue:'Dashed'})}</option>
   <option value="dotted">{t('chart.draw.dash_dotted',{defaultValue:'Dotted'})}</option>
  </select></label>}
  <button type="button" onClick={onEdit}>{t('chart.draw.edit',{defaultValue:'Edit drawing'})}</button>
  <button type="button" onClick={onDelete}>{t('chart.draw.delete',{defaultValue:'Delete drawing'})}</button>
 </div>
}
