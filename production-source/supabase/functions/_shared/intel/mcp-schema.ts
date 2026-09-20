// One schema, two jobs: what tools/list publishes and what tools/call enforces.
//
// The codebase validates inbound shapes with hand-written guards (chartAlertConfig,
// validateDrawing, validScopes) rather than a schema library, and that is kept
// here. What changes is that an MCP tool ALSO has to publish its schema, and a
// published schema that drifts from the code that enforces it is worse than no
// schema at all: a model reads "maximum 50", asks for 50, and gets refused by a
// guard that says 20. So the object below is the literal JSON Schema sent to the
// client AND the thing the validator walks. There is one description of each
// bound and it cannot disagree with itself.
//
// EVERY BOUND IS CLOSED. additionalProperties is false on every object, every
// string has a maxLength, every array a maxItems, every integer a maximum. A
// model cannot ask for an unbounded page because there is no way to express one:
// `limit` has a maximum and an id array has maxItems, so the worst case of any
// tool call is a known number of rows rather than a table scan.
//
// The subset of JSON Schema implemented is exactly: type, enum, const, default,
// minLength, maxLength, pattern, minimum, maximum, minItems, maxItems, items,
// properties, required, additionalProperties. Nothing else is honoured, so
// nothing else appears in a tool definition.

export class SchemaError extends Error {
 constructor(message:string){super(message);this.name='SchemaError'}
}

export interface JsonSchema {
 type?:'string'|'integer'|'number'|'boolean'|'array'|'object'
 description?:string
 enum?:readonly (string|number)[]
 default?:unknown
 minLength?:number
 maxLength?:number
 pattern?:string
 minimum?:number
 maximum?:number
 minItems?:number
 maxItems?:number
 items?:JsonSchema
 properties?:Record<string,JsonSchema>
 required?:readonly string[]
 additionalProperties?:false
}

/** Control characters other than tab, newline and carriage return. A tool
 * argument carrying one is either a mistake or an attempt to smuggle a line
 * break into a log line, and neither is worth accepting. */
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

function fail(path:string,message:string):never {
 throw new SchemaError(`${path||'input'} ${message}`)
}

function validateValue(value:unknown,schema:JsonSchema,path:string):unknown {
 if(schema.enum&&!schema.enum.includes(value as string|number)){
  fail(path,`must be one of: ${schema.enum.join(', ')}.`)
 }
 switch(schema.type){
  case 'string':{
   if(typeof value!=='string')fail(path,'must be a string.')
   if(CONTROL.test(value))fail(path,'contains a control character.')
   // maxLength is checked before pattern so a megabyte of text is rejected by
   // length rather than handed to a regex engine.
   if(schema.maxLength!==undefined&&value.length>schema.maxLength)fail(path,`must be at most ${schema.maxLength} characters.`)
   if(schema.minLength!==undefined&&value.length<schema.minLength)fail(path,`must be at least ${schema.minLength} characters.`)
   if(schema.pattern&&!new RegExp(schema.pattern).test(value))fail(path,'is not in the expected format.')
   return value
  }
  case 'integer':{
   if(typeof value!=='number'||!Number.isInteger(value))fail(path,'must be a whole number.')
   if(schema.minimum!==undefined&&value<schema.minimum)fail(path,`must be ${schema.minimum} or more.`)
   if(schema.maximum!==undefined&&value>schema.maximum)fail(path,`must be ${schema.maximum} or less.`)
   return value
  }
  case 'number':{
   if(typeof value!=='number'||!Number.isFinite(value))fail(path,'must be a number.')
   if(schema.minimum!==undefined&&value<schema.minimum)fail(path,`must be ${schema.minimum} or more.`)
   if(schema.maximum!==undefined&&value>schema.maximum)fail(path,`must be ${schema.maximum} or less.`)
   return value
  }
  case 'boolean':
   if(typeof value!=='boolean')fail(path,'must be true or false.')
   return value
  case 'array':{
   if(!Array.isArray(value))fail(path,'must be an array.')
   // The length bound comes FIRST. Validating a million elements to then reject
   // the array for being too long is the denial of service the bound exists to
   // prevent.
   if(schema.maxItems!==undefined&&value.length>schema.maxItems)fail(path,`must have at most ${schema.maxItems} items.`)
   if(schema.minItems!==undefined&&value.length<schema.minItems)fail(path,`must have at least ${schema.minItems} items.`)
   if(!schema.items)return value
   return value.map((item,index)=>validateValue(item,schema.items!,`${path}[${index}]`))
  }
  case 'object':{
   if(!value||typeof value!=='object'||Array.isArray(value))fail(path,'must be an object.')
   return validateObject(value as Record<string,unknown>,schema,path)
  }
  default:
   return value
 }
}

function validateObject(input:Record<string,unknown>,schema:JsonSchema,path:string):Record<string,unknown> {
 const properties=schema.properties??{}
 if(schema.additionalProperties===false){
  const unknown=Object.keys(input).filter(key=>!Object.hasOwn(properties,key))
  // Named, because "unexpected argument" without the name sends a model
  // guessing, and a guessing model retries.
  if(unknown.length)fail(path,`does not accept ${unknown.join(', ')}. Allowed: ${Object.keys(properties).join(', ')||'nothing'}.`)
 }
 const out:Record<string,unknown>={}
 for(const name of schema.required??[]){
  if(input[name]===undefined||input[name]===null)fail(path?`${path}.${name}`:name,'is required.')
 }
 for(const [name,propertySchema] of Object.entries(properties)){
  const raw=input[name]
  const where=path?`${path}.${name}`:name
  if(raw===undefined||raw===null){
   // A default is applied rather than left absent, so every handler reads a
   // resolved value and no bound depends on the handler remembering one.
   if(propertySchema.default!==undefined)out[name]=propertySchema.default
   continue
  }
  out[name]=validateValue(raw,propertySchema,where)
 }
 return out
}

/**
 * Validate one tool's arguments against its published schema and return the
 * parsed, defaulted object.
 *
 * The return value, not the input, is what a handler reads: it contains only
 * declared properties, with defaults filled, so a handler cannot accidentally
 * use an undeclared field that the schema never bounded.
 */
export function parseToolArguments(schema:JsonSchema,args:Record<string,unknown>):Record<string,unknown> {
 if(schema.type!=='object')throw new SchemaError('A tool schema must describe an object.')
 return validateObject(args,schema,'')
}

// ── Reusable property bounds ────────────────────────────────────────────────
// Declared once so two tools cannot advertise different ceilings for the same
// idea, which is how a page limit quietly becomes unbounded in one place.

/** Rows a single call may return. 50 is the widest board any Intel page shows at
 * once, so nothing a member can see in the app needs more. */
export const LIMIT_PROPERTY=(max:number,fallback:number,description:string):JsonSchema=>
 ({type:'integer',minimum:1,maximum:max,default:fallback,description})

export const UUID_PATTERN='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
/** Letters, digits and the punctuation a ticker, a name or a contract address
 * actually contains. Deliberately narrow: a query is matched against stored
 * identity strings, never interpolated anywhere, and a narrow class keeps it
 * that way even if a future caller forgets. */
export const QUERY_PATTERN='^[A-Za-z0-9 ._:$/()+-]{1,64}$'
export const SYMBOL_PATTERN='^[A-Za-z0-9._$-]{1,32}$'
export const CHAIN_PATTERN='^[a-z0-9-]{1,32}$'
export const CONTRACT_PATTERN='^[A-Za-z0-9:_-]{20,128}$'
export const ISO_DAYS=(max:number,fallback:number):JsonSchema=>
 ({type:'integer',minimum:1,maximum:max,default:fallback,description:`How many days back to look. At most ${max}.`})
