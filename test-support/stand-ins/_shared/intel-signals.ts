// TEST STAND-IN: not the production module; used only so the published Investor Intel tests can run without the private platform.
//
// Stands in for: supabase/functions/_shared/intel-signals.ts
// What that is:  The platform's news and signal-radar builders. It is not published.
//
// Every export throws when used (test-support/stand-ins/unavailable.ts), so a
// passing test never reached it. The names are the ones that published Intel
// modules import from the real module, and nothing else.

import { unavailable } from '../unavailable.ts'

export const buildNotable = unavailable('supabase/functions/_shared/intel-signals.ts buildNotable')
export const buildSignalRadar = unavailable('supabase/functions/_shared/intel-signals.ts buildSignalRadar')
export const clusterTitles = unavailable('supabase/functions/_shared/intel-signals.ts clusterTitles')
