// The bounds, and the fact that they are the SAME object the client is shown.
//
// The property this file is really testing is that a model cannot ask for an
// unbounded page. That is not one assertion, it is a sweep over every published
// tool schema, which is the last test below.

import {assert,assertEquals,assertThrows} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {parseToolArguments,SchemaError,type JsonSchema} from './mcp-schema.ts'
import {MCP_TOOLS,toolDefinitions} from './mcp-tools.ts'

const schema=(properties:Record<string,JsonSchema>,required:string[]=[]):JsonSchema=>
 ({type:'object',properties,required,additionalProperties:false})

Deno.test('a bounded integer refuses anything outside its range, including the wrong type',()=>{
 const s=schema({limit:{type:'integer',minimum:1,maximum:50,default:20}})
 assertEquals(parseToolArguments(s,{limit:50}),{limit:50})
 assertEquals(parseToolArguments(s,{limit:1}),{limit:1})
 // The whole point: an oversize page is refused, and the message names the bound
 // so a model can correct itself rather than retry the same number.
 const over=assertThrows(()=>parseToolArguments(s,{limit:51}),SchemaError)
 assert((over as SchemaError).message.includes('50'),'the refusal must name the ceiling')
 assertThrows(()=>parseToolArguments(s,{limit:0}),SchemaError)
 assertThrows(()=>parseToolArguments(s,{limit:1e9}),SchemaError)
 for(const bad of [1.5,'20',true,[],{},NaN,Infinity]){
  assertThrows(()=>parseToolArguments(s,{limit:bad}),SchemaError,undefined,`${String(bad)} is not a whole number`)
 }
 // A default is APPLIED, so the handler never reads undefined and no bound
 // depends on the handler remembering one.
 assertEquals(parseToolArguments(s,{}),{limit:20})
 assertEquals(parseToolArguments(s,{limit:null}),{limit:20})
})

Deno.test('a string is bounded by length before it is matched by pattern',()=>{
 const s=schema({query:{type:'string',minLength:2,maxLength:8,pattern:'^[A-Z]+$'}},['query'])
 assertEquals(parseToolArguments(s,{query:'BTC'}),{query:'BTC'})
 assertThrows(()=>parseToolArguments(s,{query:'B'}),SchemaError)
 const long=assertThrows(()=>parseToolArguments(s,{query:'A'.repeat(9)}),SchemaError)
 assert((long as SchemaError).message.includes('at most 8 characters'),'length, not pattern, must be the reported reason')
 assertThrows(()=>parseToolArguments(s,{query:'btc'}),SchemaError)
 // A control character is refused outright: it is either a mistake or an attempt
 // to break a log line in two.
 assertThrows(()=>parseToolArguments(s,{query:'AB\u0000'}),SchemaError)
 assertThrows(()=>parseToolArguments(s,{query:'AB'}),SchemaError)
 assertThrows(()=>parseToolArguments(s,{}),SchemaError)
})

Deno.test('an array is bounded by maxItems BEFORE its elements are validated',()=>{
 const s=schema({tags:{type:'array',maxItems:3,items:{type:'string',maxLength:4}}})
 assertEquals(parseToolArguments(s,{tags:['a','bb']}),{tags:['a','bb']})
 const over=assertThrows(()=>parseToolArguments(s,{tags:['a','b','c','d']}),SchemaError)
 assert((over as SchemaError).message.includes('at most 3 items'))
 // Validating a huge array to then reject it for being huge is the denial of
 // service the bound exists to prevent, so the length is checked first: this
 // array's elements would each fail, yet the reported reason is the length.
 const huge=assertThrows(()=>parseToolArguments(s,{tags:new Array(10000).fill('toolong')}),SchemaError)
 assert((huge as SchemaError).message.includes('at most 3 items'))
 assertThrows(()=>parseToolArguments(s,{tags:'a'}),SchemaError)
 assertThrows(()=>parseToolArguments(s,{tags:['toolong']}),SchemaError)
})

Deno.test('an undeclared argument is refused, and the refusal lists what is allowed',()=>{
 const s=schema({a:{type:'string',maxLength:4}})
 const error=assertThrows(()=>parseToolArguments(s,{a:'x',b:'y'}),SchemaError)
 assert((error as SchemaError).message.includes('b'),'the unknown key must be named')
 assert((error as SchemaError).message.includes('Allowed: a'),'and the allowed keys listed, so a model can correct itself')
 // The returned object holds only declared properties, so a handler cannot use a
 // field the schema never bounded.
 assertEquals(parseToolArguments(s,{a:'x'}),{a:'x'})
})

Deno.test('enum, boolean and number are each enforced',()=>{
 const s=schema({
  status:{type:'string',enum:['flagged','inspected','all'],default:'all'},
  days:{type:'integer',enum:[7,30,90],default:7},
  active:{type:'boolean',default:false},
  price:{type:'number',minimum:0,maximum:1000},
 })
 assertEquals(parseToolArguments(s,{}),{status:'all',days:7,active:false})
 assertEquals(parseToolArguments(s,{status:'flagged',days:90,active:true,price:12.5}),{status:'flagged',days:90,active:true,price:12.5})
 const bad=assertThrows(()=>parseToolArguments(s,{status:'FLAGGED'}),SchemaError)
 assert((bad as SchemaError).message.includes('flagged, inspected, all'),'the allowed values must be listed')
 assertThrows(()=>parseToolArguments(s,{days:14}),SchemaError)
 assertThrows(()=>parseToolArguments(s,{active:'yes'}),SchemaError)
 assertThrows(()=>parseToolArguments(s,{price:-1}),SchemaError)
 assertThrows(()=>parseToolArguments(s,{price:1001}),SchemaError)
 assertThrows(()=>parseToolArguments(s,{price:Infinity}),SchemaError)
})

Deno.test('a nested object is validated and closed too',()=>{
 const s=schema({filter:{type:'object',properties:{chain:{type:'string',maxLength:8}},required:['chain'],additionalProperties:false}})
 assertEquals(parseToolArguments(s,{filter:{chain:'solana'}}),{filter:{chain:'solana'}})
 const error=assertThrows(()=>parseToolArguments(s,{filter:{chain:'solana',extra:1}}),SchemaError)
 assert((error as SchemaError).message.startsWith('filter '),'the path must say where the problem is')
 assertThrows(()=>parseToolArguments(s,{filter:{}}),SchemaError)
 assertThrows(()=>parseToolArguments(s,{filter:[]}),SchemaError)
})

Deno.test('a tool schema must describe an object',()=>{
 assertThrows(()=>parseToolArguments({type:'string'},{}),SchemaError)
})

Deno.test('EVERY published tool schema is closed and every bound is finite',()=>{
 assert(MCP_TOOLS.length>=15,`expected the full catalogue, saw ${MCP_TOOLS.length}`)
 for(const tool of MCP_TOOLS){
  const s=tool.schema
  assertEquals(s.type,'object',`${tool.name} must take an object`)
  assertEquals(s.additionalProperties,false,`${tool.name} must refuse undeclared arguments`)
  for(const [name,property] of Object.entries(s.properties??{})){
   const where=`${tool.name}.${name}`
   assert(typeof property.description==='string'&&property.description.length>0,`${where} needs a description: a model choosing an argument cannot see our docs`)
   // The property this sweep exists for. Anything that could be unbounded has to
   // carry its ceiling, or a model can ask for a page we never meant to serve.
   if(property.type==='string'){
    // An enum is a tighter bound than a maxLength, so either satisfies this.
    const bounded=Array.isArray(property.enum)
     ||(typeof property.maxLength==='number'&&property.maxLength<=20000)
    assert(bounded,`${where} needs a finite maxLength or an enum`)
   }
   if(property.type==='array'){
    assert(typeof property.maxItems==='number'&&property.maxItems<=50,`${where} needs a finite maxItems`)
    assert(property.items,`${where} must say what its items are`)
   }
   if(property.type==='integer'||property.type==='number'){
    const bounded=typeof property.maximum==='number'||Array.isArray(property.enum)
    assert(bounded,`${where} needs a maximum or an enum`)
   }
   // A limit-shaped property must default to something, so a call that omits it
   // does not fall through to whatever the read module's own default happens to be.
   if(name==='limit')assert(typeof property.default==='number',`${where} needs a default`)
  }
  // required must only name properties that exist, or a tool is unusable by
  // anything that reads its schema.
  for(const name of s.required??[])assert(Object.hasOwn(s.properties??{},name),`${tool.name} requires ${name}, which it does not declare`)
 }
})

Deno.test('tools/list publishes exactly the schema that is enforced, plus the gate in words',()=>{
 const definitions=toolDefinitions()
 assertEquals(definitions.length,MCP_TOOLS.length)
 for(const definition of definitions){
  const tool=MCP_TOOLS.find(t=>t.name===definition.name)!
  // One object, not a copy: a published bound cannot drift from an enforced one.
  assert(definition.inputSchema===tool.schema as unknown,`${definition.name} must publish the object it enforces`)
  assert(definition.title.length>0)
  assert(definition.description.includes(tool.description),'the published description must contain the tool description')
  if(tool.scope)assert(definition.description.includes(tool.scope),`${definition.name} must name the scope it needs`)
  if(tool.surface!=='agent_access')assert(definition.description.includes(tool.surface),`${definition.name} must name its plan surface`)
 }
 // Names are unique and machine-safe, because a client keys its tool table on them.
 const names=definitions.map(d=>d.name)
 assertEquals(new Set(names).size,names.length,'tool names must be unique')
 for(const name of names)assert(/^[a-z][a-z0-9_]{2,63}$/.test(name),`${name} is not a usable tool name`)
})
