export const ASSET_KEY = 'eip155:1:native'
export function heldQuantity(records) {
  return records.filter(r=>r.group==='portfolio' && r.status==='success' && (!r.assetKey || r.assetKey===ASSET_KEY))
    .reduce((sum,r)=>{const quantity=Number(r.quantity);return Number.isFinite(quantity)&&quantity>0?sum+(r.direction==='out'?-quantity:quantity):sum},0)
}
export function validMovement(quantity,direction,held) {
  const parsed=Number(quantity)
  return Number.isFinite(parsed) && parsed>0 && (direction!=='out' || parsed<=held)
}
