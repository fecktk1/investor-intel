import React,{lazy,Suspense,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {createChart,CandlestickSeries,BarSeries,LineSeries,HistogramSeries,PriceScaleMode} from '../vendor/lightweight-charts-5.2.0/renderer.mjs'

import {STUDY_CATALOG,calculateStudy} from '../../../supabase/functions/_shared/intel/chart-analysis'

import {rendererData,studyRendererData,chartPriceFormat,writeChartSeries,continuousChartTime,continuousChartLogical,refreshedChartViewport} from '../lib/chart-renderer-data'

import {useChartStudies} from '../lib/useChartStudies'

import {useChartDrawings} from './ChartDrawings'

import ChartLayoutLibrary from './ChartLayoutLibrary'
import ChartAssetNavigator from './ChartAssetNavigator'
import ChartSnapshotSave from './ChartSnapshotSave'
import ChartAlertEditor from './ChartAlertEditor'
import ResponsiveChartTools from './ResponsiveChartTools'
import ChartIndicatorMenu from './ChartIndicatorMenu'
import {validateChartLayout} from '../../../supabase/functions/_shared/intel/chart-workspace-contract'
const ChartStructurePanel=lazy(()=>import('./ChartStructurePanel'))



const studyColors=['#DFA647','#82ABD2','#B4A0DC','#6CC6A2','#E3AEBC']

const presets={Clean:[],Research:[{id:'research-sma',type:'sma',params:{period:50}}],Momentum:[{id:'momentum-rsi',type:'rsi'},{id:'momentum-macd',type:'macd'}],Volume:[{id:'volume-vwap',type:'vwap'},{id:'volume-obv',type:'obv'}]}

const price=n=>n==null?'—':Number(n).toLocaleString(undefined,{maximumFractionDigits:n<1?8:2})

const spacing=ms=>ms>=86400000?`${ms/86400000}d`:ms>=3600000?`${ms/3600000}h`:`${ms/60000}m`

const barTime=(t,timeZone)=>new Date(t).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short',timeZone})



function PriceWorkstationBody({bars,timeWindow=null,viewKey='',chartSource=null,seriesCapture=null,replay=false,knownOnly=false,readOnly=false,height=340,cursorTime,onCursorChange,onViewportChange,clusters=[],renderMarker,keyLevels=[],drawdown=null,onFailure,persistence=null,visibility={},onVisibilityChange,initialState={},onWorkspaceChange,onReplayRestore}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const host=useRef(null),api=useRef(null),main=useRef(null),mainData=useRef([]),lastMode=useRef(null),fitted=useRef(false),gridRef=useRef(null),fitFrame=useRef(null),previousWindow=useRef(null)

 const callbacks=useRef({onCursorChange,onViewportChange,onFailure});callbacks.current={onCursorChange,onViewportChange,onFailure}

 const [ready,setReady]=useState(0),[mode,setMode]=useState(initialState.mode||(bars.every(b=>b.o!=null)?'candles':'line')),[scale,setScale]=useState(initialState.scale||'linear'),[autoScale,setAutoScale]=useState(initialState.autoScale??true)

 const [studies,setStudies]=useState(initialState.studies||[]),[volume,setVolume]=useState(initialState.volume||false),[preset,setPreset]=useState(initialState.preset||'Clean'),[legend,setLegend]=useState(null),[geometry,setGeometry]=useState({width:0,height})

 const deviceZone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'

 const [timezone,setTimezone]=useState(initialState.timezone||deviceZone),[layoutNote,setLayoutNote]=useState(null),[theme,setTheme]=useState(initialState.theme||'app')
 const [structureOpen,setStructureOpen]=useState(false),[structureSelection,setStructureSelection]=useState(null)
 const analysisNow=useMemo(()=>Date.now(),[bars])
 const selectedStructure=structureSelection?.bars===bars&&structureOpen?structureSelection.finding:null

 const sourceBounds=useRef(null),plottedGrid=useRef(null),initialView=useRef(initialState.range)

 const [palette,setPalette]=useState(null),[studyDialog,setStudyDialog]=useState(false),[draftType,setDraftType]=useState('sma'),[draftParams,setDraftParams]=useState({period:50}),[studyError,setStudyError]=useState(null)

 const dialog=useRef(null),returnFocus=useRef(null),studySeries=useRef([])

 const ohlc=bars.every(b=>b.o!=null),hasVolume=bars.some(b=>b.v!=null)
 const volumeLabel=bars.some(b=>b.volumeKind==='snapshot')?'Volume snapshot (USD)':bars.some(b=>b.volumeUnit==='USD')?'Volume (USD)':'Volume'

 const source=useMemo(()=>rendererData(bars,ohlc?mode:'line',chartSource?.intervalMs??undefined,timeWindow),[bars,mode,ohlc,chartSource?.intervalMs,timeWindow?.from,timeWindow?.to]);gridRef.current=source?.grid

 useEffect(()=>{if(!source)callbacks.current.onFailure?.()},[source])

 const drawings=useChartDrawings({width:geometry.width,height:geometry.height,scale,readOnly,initialItems:initialState.drawings||[],
  project:anchor=>{const x=api.current?.timeScale().logicalToCoordinate(continuousChartLogical(gridRef.current,anchor.t)),y=main.current?.priceToCoordinate(anchor.price);return x==null||y==null?null:{x,y}},

  unproject:point=>{const logical=api.current?.timeScale().coordinateToLogical(point.x),t=continuousChartTime(gridRef.current,logical),price=main.current?.coordinateToPrice(point.y);return t!=null&&Number.isFinite(price)&&price>0?{t:Math.round(t),price}:null}})

 useEffect(()=>{onWorkspaceChange?.({mode,scale,autoScale,studies,volume,preset,timezone,theme,drawings:drawings.items,replay:replay?{at:cursorTime,knownOnly}:undefined})},[mode,scale,autoScale,studies,volume,preset,timezone,theme,drawings.items,replay,cursorTime,knownOnly]) // eslint-disable-line react-hooks/exhaustive-deps

 const studyResult=useChartStudies(bars,studies,chartSource?.intervalMs??null)

 const paneNames=[...new Set(studyResult.results.filter(r=>r.pane!=='price'&&r.series.some(s=>s.points.length)).map(r=>r.pane)),...(volume&&hasVolume?['volume']:[])]

 const totalHeight=height+paneNames.length*96

 const refreshGeometry=useCallback(()=>{

  const chart=api.current;if(!chart)return

  const range=chart.timeScale().getVisibleLogicalRange(),grid=gridRef.current

  const width=chart.timeScale().width()

  setGeometry({width,height:chart.panes()[0]?.getHeight()||height})

  if(range&&grid)callbacks.current.onViewportChange?.({from:continuousChartTime(grid,range.from),to:continuousChartTime(grid,range.to),width})

 },[height])

 const gestureFrame=useRef(null)

 const refreshAfterGesture=()=>{if(gestureFrame.current!=null)return;gestureFrame.current=requestAnimationFrame(()=>{gestureFrame.current=requestAnimationFrame(()=>{gestureFrame.current=null;refreshGeometry();const actual=api.current?.priceScale('right').options().autoScale;if(typeof actual==='boolean')setAutoScale(actual)})})}

 useEffect(()=>()=>cancelAnimationFrame(gestureFrame.current),[])

 useEffect(()=>{

  const read=()=>{const style=getComputedStyle(host.current);setPalette({background:style.getPropertyValue('--bg-1').trim()||'#14171C',text:style.getPropertyValue('--fg-3').trim()||'#A7AFBC',border:style.getPropertyValue('--border-default').trim()||'#343B46',green:style.getPropertyValue('--signal-green').trim()||'#6CC6A2',red:style.getPropertyValue('--signal-red').trim()||'#D98788',accent:style.getPropertyValue('--accent').trim()||'#DFA647'})}

  read();const observer=new MutationObserver(read);observer.observe(document.documentElement,{attributes:true,attributeFilter:['class','data-theme','style']});return()=>observer.disconnect()

 },[theme])

 useEffect(()=>{

  if(!host.current)return

  let chart

  try{

   chart=createChart(host.current,{width:host.current.clientWidth,height,layout:{background:{color:'#14171C'},textColor:'#A7AFBC',fontFamily:'Inter, sans-serif',fontSize:11,attributionLogo:true,panes:{separatorColor:'#343B46',separatorHoverColor:'#DFA647',enableResize:true}},grid:{vertLines:{visible:false},horzLines:{color:'#343B4633'}},rightPriceScale:{borderVisible:false,minimumWidth:72},timeScale:{timeVisible:true,secondsVisible:false,borderVisible:false,rightOffset:1},crosshair:{mode:0},handleScroll:{vertTouchDrag:false},localization:{locale:navigator.language}})

   api.current=chart;mainData.current=[];lastMode.current=null;fitted.current=false;sourceBounds.current=null;studySeries.current=[];setReady(v=>v+1)

  }catch{callbacks.current.onFailure?.();return}

  const resize=new ResizeObserver(entries=>{chart.applyOptions({width:Math.floor(entries[0].contentRect.width)});refreshGeometry()});resize.observe(host.current)

  const crosshair=event=>{const row=event.seriesData.get(main.current);setLegend(row?.close!=null||row?.value!=null?{t:Number(event.time)*1000,o:row.open,h:row.high,l:row.low,c:row.close??row.value}:null)}

  const click=event=>{if(event.point){const logical=chart.timeScale().coordinateToLogical(event.point.x),time=continuousChartTime(gridRef.current,logical);if(time!=null)callbacks.current.onCursorChange?.(Math.round(time))}}

  chart.subscribeCrosshairMove(crosshair);chart.subscribeClick(click);chart.timeScale().subscribeVisibleLogicalRangeChange(refreshGeometry)

  return()=>{cancelAnimationFrame(fitFrame.current);resize.disconnect();chart.unsubscribeCrosshairMove(crosshair);chart.unsubscribeClick(click);chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshGeometry);chart.remove();api.current=null;main.current=null}

 },[]) // eslint-disable-line react-hooks/exhaustive-deps

 useEffect(()=>{if(!api.current||!palette)return;api.current.applyOptions({layout:{background:{color:palette.background},textColor:palette.text},grid:{horzLines:{color:palette.border}}});main.current?.applyOptions({upColor:palette.green,downColor:palette.red,wickUpColor:palette.green,wickDownColor:palette.red,color:palette.accent})},[palette,ready,mode])

 useLayoutEffect(()=>{
  const chart=api.current;if(!chart||!source)return
  const actualMode=ohlc?mode:'line'

  try{

   if(!main.current||lastMode.current!==actualMode){

    if(main.current)chart.removeSeries(main.current)

    main.current=chart.addSeries(actualMode==='candles'?CandlestickSeries:actualMode==='ohlc'?BarSeries:LineSeries,{upColor:palette?.green||'#6CC6A2',downColor:palette?.red||'#D98788',borderVisible:false,wickUpColor:palette?.green||'#6CC6A2',wickDownColor:palette?.red||'#D98788',color:palette?.accent||'#DFA647',lineWidth:2,priceLineVisible:true,priceFormat:chartPriceFormat(bars)},0)

    mainData.current=[];lastMode.current=actualMode

   }

   main.current.applyOptions({priceFormat:chartPriceFormat(bars)})
   const oldRange=chart.timeScale().getVisibleLogicalRange(),oldGrid=plottedGrid.current
   mainData.current=writeChartSeries(main.current,mainData.current,source.data)
   const bounds=`${viewKey}:${source.grid.step}:${replay}`
   if(sourceBounds.current!==bounds){fitted.current=false;sourceBounds.current=bounds}
   else if(fitted.current){
    const nextRange=refreshedChartViewport(oldRange,oldGrid,source.grid,previousWindow.current,timeWindow,!readOnly&&!replay)
    if(nextRange)chart.timeScale().setVisibleLogicalRange(nextRange)
   }
   previousWindow.current=timeWindow?{...timeWindow}:null
   plottedGrid.current=source.grid
   if(!fitted.current){cancelAnimationFrame(fitFrame.current);fitFrame.current=requestAnimationFrame(()=>{fitFrame.current=requestAnimationFrame(()=>{if(api.current===chart){if(initialView.current){chart.timeScale().setVisibleLogicalRange({from:continuousChartLogical(gridRef.current,initialView.current.from),to:continuousChartLogical(gridRef.current,initialView.current.to)});initialView.current=null}else if(timeWindow){chart.timeScale().setVisibleLogicalRange({from:continuousChartLogical(gridRef.current,timeWindow.from),to:continuousChartLogical(gridRef.current,timeWindow.to)})}else chart.timeScale().fitContent();fitted.current=true;refreshGeometry()}})})}

   refreshGeometry()

  }catch{callbacks.current.onFailure?.()}

 },[source,mode,ready,ohlc,refreshGeometry,replay,viewKey])
 useEffect(()=>{

  if(!api.current)return

  api.current.priceScale('right').applyOptions({mode:({linear:PriceScaleMode.Normal,log:PriceScaleMode.Logarithmic,percent:PriceScaleMode.Percentage,indexed:PriceScaleMode.IndexedTo100})[scale],autoScale})

  refreshGeometry()

 },[scale,autoScale,ready,refreshGeometry])

 useEffect(()=>{api.current?.applyOptions({localization:{timeFormatter:time=>barTime(Number(time)*1000,timezone)},timeScale:{tickMarkFormatter:(time,type)=>new Date(Number(time)*1000).toLocaleString(undefined,{timeZone:timezone,...(type<=2?{month:'short',day:'numeric'}:{hour:'2-digit',minute:'2-digit',hour12:false})})}})},[timezone,ready])

 useLayoutEffect(()=>{
  const chart=api.current;if(!chart||!source)return
  for(const series of studySeries.current)chart.removeSeries(series)

  studySeries.current=[]

  const panes=new Map();let paneIndex=1

  const addPane=name=>{if(!panes.has(name))panes.set(name,paneIndex++);return panes.get(name)}

  for(const [studyIndex,result]of studyResult.results.entries()){

   for(const [seriesIndex,line]of result.series.entries()){

    if(!line.points.length)continue

   const pane=result.pane==='price'?0:addPane(result.pane),series=chart.addSeries(line.kind==='histogram'?HistogramSeries:LineSeries,{color:studyIndex===0&&seriesIndex===0?palette?.accent||studyColors[0]:studyColors[(studyIndex+seriesIndex)%studyColors.length],lineWidth:1,priceLineVisible:false,lastValueVisible:false,title:line.name,...(['rsi','vwrsi','stoch_rsi'].includes(result.pane)?{autoscaleInfoProvider:()=>({priceRange:{minValue:0,maxValue:100}})}:{})},pane)

    series.setData(studyRendererData(line.points,source.grid));studySeries.current.push(series)

   }

  }

  if(volume&&hasVolume){const series=chart.addSeries(HistogramSeries,{priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false},addPane('volume'));series.setData(bars.filter(b=>b.v!=null).map(b=>({time:b.t/1000,value:b.v,color:b.c>=(b.o??b.c)?'#6CC6A299':'#D9878899'})));studySeries.current.push(series)}

  chart.applyOptions({height:height+panes.size*96});chart.panes().forEach((pane,index)=>pane.setStretchFactor(index===0?height:96));refreshGeometry()

 },[studyResult.results,volume,hasVolume,ready,source,height,refreshGeometry,palette]) // eslint-disable-line react-hooks/exhaustive-deps

 useEffect(()=>{

  if(!main.current)return

  const levels=[...keyLevels,...(selectedStructure?[{price:selectedStructure.price,label:selectedStructure.label}]:[])]
  const series=main.current,lines=levels.filter(l=>Number.isFinite(Number(l.price))&&Number(l.price)>0).map(l=>series.createPriceLine({price:Number(l.price),color:'#A7AFBC',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:l.label||''}))

  return()=>{if(main.current===series)for(const line of lines)series.removePriceLine(line)}

 },[keyLevels,selectedStructure,ready,mode])

 useEffect(()=>{if(studyDialog){returnFocus.current=document.activeElement;dialog.current?.showModal()}},[studyDialog])

 const closeStudies=()=>{setStudyDialog(false);setStudyError(null);returnFocus.current?.focus?.()}

 // One admission gate for both entry points: the checkbox list and Advanced.
 // A refused indicator always answers with a reason rather than nothing.
 const prepareIndicator=(type,params)=>{
  const study={id:crypto.randomUUID(),type,params}
  try{calculateStudy(bars,study)}catch(error){return {study:null,reason:error.message}}
  if(studies.length>=20)return {study:null,reason:t('chart.indicators.limit_count',{defaultValue:'A chart carries up to 20 indicators. Remove one to add another.'})}
  const panes=new Set([...studies.map(s=>STUDY_CATALOG[s.type].pane),STUDY_CATALOG[type].pane].filter(p=>p!=='price'))
  if(panes.size>3)return {study:null,reason:t('chart.indicators.limit_panes',{defaultValue:'Use up to three indicator panes per chart. Remove one to add another.'})}
  return {study,reason:null}
 }

 const addStudy=()=>{
  const {study,reason}=prepareIndicator(draftType,draftParams)
  if(reason){setStudyError(reason);return}
  setStudies(previous=>[...previous,study]);setPreset('Custom');closeStudies()
 }

 /** Returns null when the change was applied, or the reason it was refused. */
 const toggleIndicator=(type,on)=>{
  if(!on){setStudies(rows=>rows.filter(row=>row.type!==type));setPreset('Custom');return null}
  const {study,reason}=prepareIndicator(type,{...STUDY_CATALOG[type].defaults})
  if(reason)return reason
  setStudies(previous=>[...previous,study]);setPreset('Custom');return null
 }

 const xFor=t=>api.current?.timeScale().logicalToCoordinate(continuousChartLogical(source?.grid,t))

 const highlightTime=selectedStructure?.confirmedAt??cursorTime
 const current=bars.find(b=>b.t===legend?.t)||bars.at(-1),cursorX=Number.isFinite(highlightTime)?xFor(highlightTime):null
 const zoom=factor=>{const s=api.current?.timeScale(),r=s?.getVisibleLogicalRange();if(r){const mid=(r.from+r.to)/2,half=(r.to-r.from)*factor/2;s.setVisibleLogicalRange({from:mid-half,to:mid+half})}}

 const pan=direction=>{const s=api.current?.timeScale(),r=s?.getVisibleLogicalRange();if(r){const delta=(r.to-r.from)*0.25*direction;s.setVisibleLogicalRange({from:r.from+delta,to:r.to+delta})}}

 const captureLayout=()=>{

  const range=api.current?.timeScale().getVisibleLogicalRange(),grid=gridRef.current

  return validateChartLayout({schemaVersion:1,...(replay?{replay:{at:cursorTime,knownOnly}}:{}),asset:persistence.asset,interval:persistence.interval?.toLowerCase()||'auto',range:{from:Math.max(0,continuousChartTime(grid,range?.from)??grid.start),to:continuousChartTime(grid,range?.to)??grid.end},mode,scale,autoScale,volume,timezone,theme,visibility,studies:studies.map(s=>({...s,params:Object.fromEntries(Object.entries(s.params||{}).filter(([,v])=>v!=null).map(([k,v])=>[k,Number(v)]))})),drawings:drawings.items})

 }

 const restoreLayout=input=>{

  const layout=validateChartLayout(input);if(layout.comparison)throw new Error('Open this linked chart layout in Compare to restore every asset.');if(layout.asset!==persistence?.asset)throw new Error('Open this layout from its original asset.')

  setMode(layout.mode);setScale(layout.scale);setAutoScale(layout.autoScale);setVolume(layout.volume);setStudies(layout.studies);setPreset('Custom');setTimezone(layout.timezone);setTheme(layout.theme);drawings.reset(layout.drawings);onVisibilityChange?.(layout.visibility);onReplayRestore?.(layout.replay??null)

  cancelAnimationFrame(fitFrame.current);fitted.current=true

  fitFrame.current=requestAnimationFrame(()=>{const grid=gridRef.current;if(api.current&&grid)api.current.timeScale().setVisibleLogicalRange({from:continuousChartLogical(grid,layout.range.from),to:continuousChartLogical(grid,layout.range.to)})})

  setLayoutNote(layout.range.to<(source?.grid.start??0)||layout.range.from>(source?.grid.end??Infinity)?t('chart.workstation.layout_outside',{defaultValue:'This saved view is outside the loaded price period. Choose a longer period to load its market history.'}):t('chart.workstation.layout_restored',{defaultValue:'Saved view, drawings and indicators restored.'}))

 }

 const chartTheme=theme==='app'?undefined:theme==='light'?{
  colorScheme:'light','--bg-1':'#f6f5f1','--bg-2':'#eeede8','--bg-3':'#e5e3dc','--fg-1':'#202630','--fg-2':'#343c49','--fg-3':'#505966','--fg-4':'#5e6876','--fg-5':'#65707e',
  '--border-default':'#c8cbd0','--border-subtle':'#c8cbd0','--signal-green':'#16724d','--signal-red':'#b23439','--accent':'#8b5d12','--forge-gold':'#8b5d12',
 }:{colorScheme:'dark','--bg-1':theme==='gray'?'#23262c':'#14171c','--bg-2':theme==='gray'?'#2d3139':'#1d222a','--bg-3':'#343b46','--fg-1':'#eef0f3','--fg-2':'#d7dbe2','--fg-3':'#b8bfca','--fg-4':'#a7afbc','--fg-5':'#9aa4b4',
  '--border-default':theme==='gray'?'#464b55':'#343b46','--border-subtle':'#464b55','--signal-green':'#6cc6a2','--signal-red':'#e89a9d','--accent':'#dfa647','--forge-gold':'#dfa647'}


 return <div className="intel-price-workstation" style={chartTheme}>

  <ResponsiveChartTools label="Chart tools">
  <div className="intel-workstation-toolbar" role="group" aria-label="Chart display controls">

   <label>View<select value={ohlc?mode:'line'} onChange={e=>setMode(e.target.value)}><option value="line">Line</option><option value="candles" disabled={!ohlc}>Candles</option><option value="ohlc" disabled={!ohlc}>OHLC bars</option></select></label>

   <label>Scale<select value={scale} onChange={e=>setScale(e.target.value)}><option value="linear">Linear</option><option value="log">Logarithmic</option><option value="percent">Percent</option><option value="indexed">Indexed to 100</option></select></label>

   <label>Layout<select disabled={readOnly} value={preset} onChange={e=>{setPreset(e.target.value);setStudies(presets[e.target.value]);setVolume(e.target.value==='Volume')}}>{Object.keys(presets).map(p=><option key={p}>{p}</option>)}{preset==='Custom'&&<option>Custom</option>}</select></label>

   <label>Time<select value={timezone} onChange={e=>setTimezone(e.target.value)}><option value="UTC">UTC</option>{deviceZone!=='UTC'&&<option value={deviceZone}>Device time</option>}{!['UTC',deviceZone].includes(timezone)&&<option value={timezone}>{timezone}</option>}</select></label>

   <ChartIndicatorMenu studies={studies} disabled={readOnly} onToggle={toggleIndicator} onAdvanced={()=>setStudyDialog(true)}/>
   <button type="button" aria-expanded={structureOpen} onClick={()=>{setStructureOpen(v=>!v);setStructureSelection(null)}}>Structure</button>

   <label className="intel-workstation-check"><input type="checkbox" checked={volume} disabled={!hasVolume} onChange={e=>setVolume(e.target.checked)}/>{volumeLabel}</label>

   <button type="button" aria-pressed={autoScale} onClick={()=>setAutoScale(v=>!v)}>Auto scale</button>

   <button type="button" onClick={()=>{if(timeWindow&&gridRef.current)api.current?.timeScale().setVisibleLogicalRange({from:continuousChartLogical(gridRef.current,timeWindow.from),to:continuousChartLogical(gridRef.current,timeWindow.to)});else api.current?.timeScale().fitContent();setAutoScale(true)}}>Reset view</button>

   {persistence&&!readOnly&&<ChartLayoutLibrary context={persistence} capture={captureLayout} onLoad={restoreLayout} onStudies={next=>{setStudies(next);setPreset('Custom')}}/>}{persistence&&!readOnly&&<ChartSnapshotSave context={persistence} captureLayout={()=>{const layout=captureLayout();return replay?{...layout,drawings:[],visibility:{}}:layout}} seriesCapture={seriesCapture}/>} {persistence&&!replay&&!readOnly&&<><ChartAssetNavigator context={persistence}/><ChartAlertEditor context={persistence} getAnchors={()=>[{label:'Selected close',t:current?.t,price:current?.c},...drawings.items.map(d=>({label:d.text?.slice(0,80)||d.tool.replaceAll('_',' '),...d.anchors[0],note:d.text}))]}/></>}
  </div>

  {!replay&&!readOnly&&drawings.controls}
  </ResponsiveChartTools>

  {chartSource&&<p className="intel-analysis-caption intel-chart-source">{chartSource.provider === 'coinmarketcap' ? 'CoinMarketCap' : chartSource.provider === 'coingecko' ? 'CoinGecko' : chartSource.provider} · {chartSource.currency}{chartSource.intervalMs?` · ${spacing(chartSource.intervalMs)}`:''}<span> · {chartSource.timestampMeaning==='close'?'Times mark candle closes':chartSource.timestampMeaning==='open'?'Times mark candle opens':'Source observation times'}{chartSource.observedAt?` · latest observation ${barTime(chartSource.observedAt,timezone)}`:''}</span></p>}

  <div className="intel-crosshair-legend" aria-live="off"><time dateTime={current?new Date(current.t).toISOString():undefined}>{current?barTime(current.t,timezone):'No observations'}</time>{[['O',current?.o],['H',current?.h],['L',current?.l],['C',current?.c]].map(([label,v])=><span key={label}>{label} <b>{price(v)}</b></span>)}</div>

  <div className="intel-workstation-canvas" style={{height:totalHeight}} onPointerMoveCapture={e=>{if(e.buttons)refreshAfterGesture()}} onPointerUpCapture={refreshAfterGesture} onWheelCapture={refreshAfterGesture}>

   <div ref={host} style={{height:totalHeight}} role="img" aria-label={`${mode==='line'?'Price':mode==='candles'?'Candlestick':'OHLC'} chart, ${bars.length} observations. Use chart navigation controls or read price data below.`}/>

   <svg className="intel-workstation-overlay" width={geometry.width} height={totalHeight} aria-label="Chart research markers" style={{pointerEvents:'none'}}>

    {cursorX!=null&&cursorX>=0&&cursorX<=geometry.width&&<line x1={cursorX} x2={cursorX} y1={0} y2={totalHeight-24} stroke="#DFA647" strokeDasharray="3 3"/>}

    {drawdown&&<rect x={Math.max(0,xFor(drawdown.fromT)||0)} y={0} width={Math.max(0,Math.min(geometry.width,xFor(drawdown.toT)||0)-Math.max(0,xFor(drawdown.fromT)||0))} height={geometry.height} fill="#D9878812"/>}

    {clusters.map(cluster=>{const bar=bars.find(b=>b.t===cluster.t),x=xFor(cluster.t),y=bar&&main.current?.priceToCoordinate(bar.c);return bar&&x!=null&&y!=null&&x>=0&&x<=geometry.width&&renderMarker?.(cluster,{cx:x,cy:y})})}

   </svg>

   {!replay&&drawings.overlay}

  </div>

  <div className="intel-chart-navigation" role="group" aria-label="Chart navigation"><button type="button" onClick={()=>pan(-1)}>Earlier</button><button type="button" onClick={()=>zoom(0.7)}>Zoom in</button><button type="button" onClick={()=>zoom(1.4)}>Zoom out</button><button type="button" onClick={()=>pan(1)}>Later</button><span>{source?.grid.step?`${spacing(source.grid.step)} observation spacing · `:''}Gaps remain empty</span></div>

  {studyResult.loading&&<p role="status" className="intel-analysis-caption">{t('chart.indicators.calculating',{defaultValue:'Calculating indicators…'})}</p>}{studyResult.error&&<p role="alert">{studyResult.error}</p>}

  {studyResult.results.filter(r=>r.reason).map(r=><p className="intel-analysis-caption" key={r.id}>{STUDY_CATALOG[r.type].label}: {r.reason}</p>)}
  {structureOpen&&<Suspense fallback={<p role="status">Loading structure tools…</p>}><ChartStructurePanel bars={bars} at={replay?cursorTime:analysisNow} knownOnly={replay&&knownOnly} intervalMs={chartSource?.intervalMs??null} timezone={timezone} source={`${chartSource?.provider||'Source unavailable'} · ${chartSource?.currency||'Currency unavailable'}`} readOnly={readOnly||replay} savedNotes={replay?[]:drawings.items} onInspect={finding=>{setStructureSelection(finding?{bars,finding}:null);if(finding)onCursorChange?.(finding.confirmedAt)}} onKeep={drawings.add}/></Suspense>}

  <details className="intel-chart-readings"><summary>{t('chart.workstation.readings_summary',{defaultValue:'Read price data and indicator definitions'})}</summary><div className="intel-table-scroll"><table><thead><tr><th>Time</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th></tr></thead><tbody>{bars.slice(-30).map(b=><tr key={b.t}><th>{barTime(b.t,timezone)}</th>{[b.o,b.h,b.l,b.c,b.v].map((v,i)=><td key={i}>{price(v)}</td>)}</tr>)}</tbody></table></div><p className="intel-analysis-caption">{t('chart.workstation.readings_note',{observations:30,timezone,defaultValue:'Latest {{observations}} loaded observations · {{timezone}}. Indicators use observed bars; missing bars are not synthesized.'})}</p>{studyResult.results.map(r=><p key={r.id}>{STUDY_CATALOG[r.type].label}: {r.definition} Warm-up: {r.warmup} observations.{r.coverage?.resets>0&&` Reset after ${r.coverage.resets} missing-period boundaries; ${r.coverage.latestBars} bars in the latest continuous segment.`}</p>)}</details>

  {!replay&&drawings.list}{!replay&&!readOnly&&drawings.editor}{layoutNote&&<p role="status" className="intel-analysis-caption">{layoutNote}</p>}

  {studyDialog&&<dialog ref={dialog} className="intel-chart-study-dialog" aria-labelledby="chart-study-title" onCancel={e=>{e.preventDefault();closeStudies()}}><div className="intel-investigation-analysis-heading"><h2 id="chart-study-title">{t('chart.indicators.dialog_title',{defaultValue:'Chart indicators'})}</h2><button type="button" onClick={closeStudies}>{t('common.close',{defaultValue:'Close'})}</button></div>

   <p className="intel-analysis-caption">{t('chart.indicators.dialog_intro',{defaultValue:'Choose an indicator and set its parameters. The list in Chart tools turns the same indicators on and off with their defaults.'})}</p>

   <label>{t('chart.indicators.dialog_choose',{defaultValue:'Indicator'})}<select className="select" value={draftType} onChange={e=>{setDraftType(e.target.value);setDraftParams({...STUDY_CATALOG[e.target.value].defaults});setStudyError(null)}}>{Object.entries(STUDY_CATALOG).map(([id,s])=><option key={id} value={id}>{s.label}</option>)}</select></label>

   <p className="intel-analysis-caption">{STUDY_CATALOG[draftType].definition}</p><div className="intel-study-parameters">{Object.keys(STUDY_CATALOG[draftType].defaults).map(key=><label key={key}>{key.charAt(0).toUpperCase()+key.slice(1)}<input type="number" min="1" max={key==='multiplier'?10:500} step={key==='multiplier'?0.25:1} value={draftParams[key]??''} onChange={e=>setDraftParams(p=>({...p,[key]:e.target.value}))}/></label>)}</div>

   <label>Chart appearance<select value={theme} onChange={e=>setTheme(e.target.value)}><option value="app">Follow app theme</option><option value="dark">Charcoal</option><option value="light">Light</option><option value="gray">Neutral gray</option></select></label>

   {draftType==='vwap'&&<label>Optional anchor (UTC)<input type="datetime-local" onChange={e=>setDraftParams(p=>({...p,anchor:e.target.value?Date.parse(`${e.target.value}Z`):undefined}))}/></label>}

   {studyError&&<p role="alert">{studyError}</p>}<button type="button" className="btn btn--primary" onClick={addStudy}>{t('chart.indicators.add',{defaultValue:'Add indicator'})}</button>

   {studies.length>0&&<ul className="intel-study-list">{studies.map(s=><li key={s.id}><span>{STUDY_CATALOG[s.type].label} · {Object.entries(s.params||STUDY_CATALOG[s.type].defaults).filter(([,v])=>v!=null).map(([k,v])=>`${k}: ${v}`).join(', ')}</span><button type="button" onClick={()=>{setStudies(rows=>rows.filter(r=>r.id!==s.id));setPreset('Custom')}}>{t('chart.indicators.remove',{defaultValue:'Remove'})}</button></li>)}</ul>}

  </dialog>}

 </div>

}

export default function PriceWorkstation(props) {return <PriceWorkstationBody key={`${props.persistence?.userId}:${props.persistence?.orgId}:${props.persistence?.asset}`} {...props}/>}
