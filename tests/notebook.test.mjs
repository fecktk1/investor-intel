import test from 'node:test'
import assert from 'node:assert/strict'
import { ASSET_KEY, heldQuantity, validMovement } from '../src/notebook.mjs'
test('recorded quantity uses successful movements of the selected asset',()=>{
  const rows=[{group:'portfolio',assetKey:ASSET_KEY,status:'success',quantity:1.25,direction:'in'},{group:'portfolio',assetKey:ASSET_KEY,status:'success',quantity:.25,direction:'out'},{group:'portfolio',assetKey:ASSET_KEY,status:'failed',quantity:5,direction:'in'},{group:'portfolio',assetKey:'eip155:1:0xother',status:'success',quantity:8,direction:'in'},{group:'thesis',quantity:7}]
  assert.equal(heldQuantity(rows),1)
  assert.equal(validMovement(.5,'out',1),true)
  assert.equal(validMovement(2,'out',1),false)
  assert.equal(validMovement('Infinity','in',1),false)
})
