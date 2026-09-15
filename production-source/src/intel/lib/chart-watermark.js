/** Brand watermark helpers.
 *
 * The shipped wordmark (public/logo-light.png) is white, meant for dark
 * surfaces. The chart carries its own theme, which is not always the app
 * theme, so the mark decides from the surface colour it is actually drawn on
 * rather than from the document attribute. */

export const WATERMARK_SOURCE='logo-light.png'

/** Parses the CSS colours the workspace tokens actually use: #rgb, #rrggbb,
 * rgb()/rgba(). Returns null for anything else, which keeps the dark default. */
export function parseSurfaceColor(value) {
 const input=String(value||'').trim()
 if(!input)return null
 const hex=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input)
 if(hex){
  const digits=hex[1].length===3?[...hex[1]].map(d=>d+d).join(''):hex[1]
  return [0,2,4].map(offset=>parseInt(digits.slice(offset,offset+2),16))
 }
 const rgb=/^rgba?\(([^)]+)\)$/i.exec(input)
 if(rgb){
  const parts=rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0,3).map(Number)
  if(parts.length===3&&parts.every(Number.isFinite))return parts.map(part=>Math.min(255, Math.max(0,part)))
 }
 return null
}

/** Relative luminance, 0 (black) to 1 (white). A valid zero stays a zero. */
export function surfaceLuminance(value) {
 const parsed=parseSurfaceColor(value)
 if(!parsed)return null
 const [r,g,b]=parsed.map(channel=>{const c=channel/255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4})
 return 0.2126*r+0.7152*g+0.0722*b
}

/** True when the wordmark must be inverted to stay legible. */
export function watermarkNeedsInvert(background) {
 const luminance=surfaceLuminance(background)
 return luminance==null?false:luminance>0.45
}

export const WATERMARK_WORDMARK='THECONTENTFORGE'

/** Stamps the same brand mark into a rendered export.
 *
 * The export image is produced by the chart-image service, not by the canvas on
 * screen, so the on-screen overlay cannot reach it. The mark is drawn as text
 * in the brand gold rather than as an embedded bitmap, which keeps the SVG
 * self-contained and survives the SVG-to-PNG pass unchanged. Returns the input
 * untouched when there is no SVG to stamp, so an export never fails over a
 * decoration. */
export function watermarkedChartSvg(svg,width,height) {
 if(typeof svg!=='string'||!svg.includes('</svg>'))return svg
 if(svg.includes('data-chart-watermark'))return svg
 const w=Number(width),h=Number(height)
 if(!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0)return svg
 const size=Math.max(24,Math.round(w/14)),y=Math.round(Math.min(h/2,420))
 const mark=`<g data-chart-watermark="1" aria-hidden="true" opacity="0.08"><text x="${Math.round(w/2)}" y="${y}" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="${size}" letter-spacing="${Math.round(size/10)}" fill="#DFA647">${WATERMARK_WORDMARK}</text></g>`
 return svg.replace(/<\/svg>\s*$/,`${mark}</svg>`)
}
