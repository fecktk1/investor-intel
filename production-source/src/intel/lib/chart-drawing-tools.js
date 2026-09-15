// The drawing tools offered by the chart toolbar, in the order they are docked.
// `id` matches DRAWING_TOOLS in the workspace contract, except 'select', which is
// the pointer, and 'crosshair', which is a chart toggle rather than a drawing.
// `shortcut` is the letter pressed with Alt. `icon` is a 16x16 stroke path.
export const DRAWING_TOOLBAR=[
 {id:'select',key:'chart.draw.tool_select',label:'Pointer',shortcut:'Q',icon:'M4 2 L4 13 L7 10.2 L8.8 14 L10.7 13.1 L8.9 9.6 L12.6 9.4 Z'},
 {id:'crosshair',key:'chart.draw.tool_crosshair',label:'Crosshair',shortcut:'C',toggle:true,icon:'M8 1.5 V14.5 M1.5 8 H14.5 M11 8 a3 3 0 1 0 -6 0 a3 3 0 1 0 6 0'},
 {id:'trendline',key:'chart.draw.tool_trendline',label:'Trend line',shortcut:'T',icon:'M2.5 13 L13.5 3'},
 {id:'ray',key:'chart.draw.tool_ray',label:'Ray',shortcut:'R',icon:'M3 13 L14.5 3 M5 13 a2 2 0 1 0 -4 0 a2 2 0 1 0 4 0'},
 {id:'extended',key:'chart.draw.tool_extended',label:'Extended line',shortcut:'E',icon:'M1 14.5 L15 1.5 M6.6 10.5 a1.6 1.6 0 1 0 -3.2 0 a1.6 1.6 0 1 0 3.2 0 M12.6 5 a1.6 1.6 0 1 0 -3.2 0 a1.6 1.6 0 1 0 3.2 0'},
 {id:'horizontal',key:'chart.draw.tool_horizontal',label:'Horizontal line',shortcut:'H',icon:'M1 8 H15'},
 {id:'horizontal_ray',key:'chart.draw.tool_horizontal_ray',label:'Horizontal ray',shortcut:'J',icon:'M4 8 H15 M6 8 a2 2 0 1 0 -4 0 a2 2 0 1 0 4 0'},
 {id:'vertical',key:'chart.draw.tool_vertical',label:'Vertical line',shortcut:'I',icon:'M8 1 V15'},
 {id:'rectangle',key:'chart.draw.tool_rectangle',label:'Rectangle',shortcut:'B',icon:'M2.5 4 H13.5 V12 H2.5 Z'},
 {id:'channel',key:'chart.draw.tool_channel',label:'Parallel channel',shortcut:'P',icon:'M1 11 L15 4 M1 14.5 L15 7.5'},
 {id:'fibonacci',key:'chart.draw.tool_fibonacci',label:'Fibonacci retracement',shortcut:'F',icon:'M1 3 H15 M1 6.5 H15 M1 9.5 H15 M1 13 H15'},
 {id:'text',key:'chart.draw.tool_text',label:'Text note',shortcut:'N',icon:'M3 3 H13 M8 3 V13 M5.5 13 H10.5'},
 {id:'arrow_up',key:'chart.draw.tool_arrow_up',label:'Arrow up',shortcut:'U',icon:'M8 14 V5 M4 9 L8 4 L12 9'},
 {id:'arrow_down',key:'chart.draw.tool_arrow_down',label:'Arrow down',shortcut:'D',icon:'M8 2 V11 M4 7 L8 12 L12 7'},
 {id:'arrow',key:'chart.draw.tool_arrow',label:'Arrow line',shortcut:'A',icon:'M3 13 L13 3 M8.5 3 H13 V7.5'},
 {id:'price_label',key:'chart.draw.tool_price_label',label:'Price label',shortcut:'L',icon:'M1.5 5 H10 L14 8 L10 11 H1.5 Z'},
 {id:'price_range',key:'chart.draw.tool_price_range',label:'Price range',shortcut:'G',icon:'M8 2 V14 M5 5 L8 2 L11 5 M5 11 L8 14 L11 11'},
 {id:'measure',key:'chart.draw.tool_measure',label:'Measure',shortcut:'M',icon:'M2 6 H14 V10 H2 Z M5 6 V8 M8 6 V9 M11 6 V8'},
 {id:'tweet',key:'chart.draw.tool_tweet',label:'Post from X',shortcut:'X',icon:'M2.5 2.5 L13.5 13.5 M13.5 2.5 L2.5 13.5'},
]
export const DRAWING_TOOL_BY_ID=Object.fromEntries(DRAWING_TOOLBAR.map(tool=>[tool.id,tool]))
// Groups shown along the top of the plot, separated by a hairline. The trailing
// group of actions is assembled by the toolbar itself.
export const DRAWING_TOOL_GROUPS=[
 ['pointer',['select','crosshair']],
 ['lines',['trendline','ray','extended','horizontal','horizontal_ray','vertical']],
 ['shapes',['rectangle','channel','fibonacci']],
 ['annotations',['text','arrow_up','arrow_down','arrow','price_label','tweet']],
 ['measure',['measure','price_range']],
]
// A button occupies 30px of a row and a group hairline 9px, so the number of rows
// follows from the measured width without a layout pass. The strip NEVER scrolls:
// whatever would spill past two rows moves into the More disclosure instead.
// These live here, not in the toolbar module, so the deferred toolbar's
// placeholder can reserve exactly the height the strip will take.
export const BUTTON_WIDTH=30,SEPARATOR_WIDTH=9,MORE_WIDTH=74,ROW_LIMIT=2
/** Items in the trailing actions group the toolbar assembles itself. */
export const DRAWING_ACTION_COUNT=7
export function toolbarRows(groups,width,hasMore) {
 if(!width)return 1
 let rows=1,used=0
 const place=size=>{
  const needed=size+(used?SEPARATOR_WIDTH:0)
  if(used&&used+needed>width){rows++;used=size}else used+=needed
 }
 for(const group of groups)place(group.items.length*BUTTON_WIDTH)
 if(hasMore)place(MORE_WIDTH)
 return rows
}
/** Rows the full strip takes at a width, capped at the two the toolbar allows. */
export function drawingStripRows(width) {
 const groups=[...DRAWING_TOOL_GROUPS.map(([name,ids])=>({name,items:ids})),{name:'actions',items:new Array(DRAWING_ACTION_COUNT).fill(null)}]
 return Math.min(ROW_LIMIT,toolbarRows(groups,width,false))
}
export const drawingToolLabel=(t,id)=>{const tool=DRAWING_TOOL_BY_ID[id];return tool?t(tool.key,{defaultValue:tool.label}):id}
// Alt+letter arms a tool. Alt is required so a letter typed in a note never arms one.
export const drawingShortcutTool=event=>{
 if(!event.altKey||event.ctrlKey||event.metaKey||typeof event.key!=='string'||event.key.length!==1)return null
 const letter=event.key.toUpperCase()
 return DRAWING_TOOLBAR.find(tool=>tool.shortcut===letter)?.id||null
}
// The palette a drawing may be coloured from: the Intel chart accents plus a neutral.
export const DRAWING_COLORS=['#DFA647','#82ABD2','#B4A0DC','#6CC6A2','#E3AEBC','#A7AFBC','#EEF0F3']
export const DRAWING_DASH_PATTERN={solid:undefined,dashed:'7 5',dotted:'1 4'}
