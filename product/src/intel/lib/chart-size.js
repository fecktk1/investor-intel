/** Workstation height presets.
 *
 * The chart cycles through three sizes: the height the page asked for, a tall
 * reading height, and full screen. Full screen is requested through the
 * Fullscreen API; where the browser refuses it the workstation covers the
 * viewport in place instead, and both states use the same height here. */

export const CHART_SIZES=['default','tall','fullscreen']
export const TALL_FACTOR=1.8
/** Room kept for the toolbar, legend, navigation row and readings. */
export const FULLSCREEN_CHROME=220

export const isChartSize=size=>CHART_SIZES.includes(size)
/** Unknown input starts the cycle again rather than throwing. */
export const nextChartSize=size=>CHART_SIZES[(CHART_SIZES.indexOf(size)+1)%CHART_SIZES.length]

export function chartSizeHeight(size,base,viewportHeight) {
 const floor=Math.max(200,Math.round(Number(base)>0?Number(base):340))
 if(size==='tall')return Math.round(floor*TALL_FACTOR)
 if(size==='fullscreen')return Math.max(floor,Math.round((Number(viewportHeight)||0)-FULLSCREEN_CHROME))
 return floor
}
