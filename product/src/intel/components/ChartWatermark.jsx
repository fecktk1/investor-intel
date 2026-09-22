import React from 'react'
import {WATERMARK_SOURCE,watermarkNeedsInvert} from '../lib/chart-watermark'

/** The TheContentForge wordmark, centred on a chart surface: decorative, never
 * interactive, and scaled to the plot rather than to a fixed pixel size.
 *
 * `background` is the colour the mark sits on. Pass the chart's own resolved
 * surface where the chart carries a theme of its own; leave it out and the mark
 * follows the app theme through the shared logo-invert-on-light rule. */
export default function ChartWatermark({background=undefined}) {
 const follows=background===undefined
 return <div className={`intel-chart-watermark${follows?' logo-invert-on-light':watermarkNeedsInvert(background)?' intel-chart-watermark--invert':''}`} aria-hidden="true">
  <img src={import.meta.env.BASE_URL+WATERMARK_SOURCE} alt="" draggable="false"/>
 </div>
}
