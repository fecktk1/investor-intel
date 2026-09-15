// The brand stamp for rendered exports, kept out of the on-screen watermark
// module so the asset route does not carry export-only code.
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
