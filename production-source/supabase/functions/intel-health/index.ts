// Investor Intel: a free, public health route. GET only, no auth (deployed with
// verify_jwt = false), no provider call, no credit spent, and nothing in the
// answer that a provider sells: capture clocks, lane states and counts only.
// See docs/investor-intel/intel-health.md and ./health.ts for what it reads.
import { createHealthHandler } from './health.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

Deno.serve(createHealthHandler(supabaseUrl && serviceKey ? { supabaseUrl, serviceKey } : null))
