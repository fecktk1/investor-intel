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
