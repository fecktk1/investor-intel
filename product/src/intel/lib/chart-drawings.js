import {validateDrawing} from '../../../supabase/functions/_shared/intel/chart-workspace-contract'
export const drawingHistory=items=>({items:items.map(validateDrawing),past:[],future:[]})
export function drawingReducer(state,action) {
 if(action.type==='reset')return drawingHistory(action.items||[])
 if(action.type==='undo')return state.past.length?{items:state.past.at(-1),past:state.past.slice(0,-1),future:[state.items,...state.future].slice(0,50)}:state
 if(action.type==='redo')return state.future.length?{items:state.future[0],past:[...state.past,state.items].slice(-50),future:state.future.slice(1)}:state
 let items=state.items
 if(action.type==='put'){
  const drawing=validateDrawing(action.drawing),found=items.some(d=>d.id===drawing.id)
  if(!found&&items.length>=200)throw new Error('A chart supports up to 200 drawings.')
  items=found?items.map(d=>d.id===drawing.id?drawing:d):[...items,drawing]
 }else if(action.type==='delete')items=items.filter(d=>d.id!==action.id)
 else if(action.type==='clear')items=[]
 if(items===state.items||JSON.stringify(items)===JSON.stringify(state.items))return state
 return {items,past:[...state.past,state.items].slice(-50),future:[]}
}
export function translateDrawing(drawing,from,to,scale='linear') {
 const dt=to.t-from.t,ratio=to.price/from.price
 if(!Number.isFinite(ratio)||ratio<=0)throw new Error('invalid_drawing_move')
 return validateDrawing({...drawing,anchors:drawing.anchors.map(a=>({t:a.t+dt,price:scale==='log'?a.price*ratio:a.price+to.price-from.price}))})
}
export {drawingGeometry} from '../../../supabase/functions/_shared/intel/chart-drawing-geometry'
