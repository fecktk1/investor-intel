// TEST STAND-IN: not the production module; used only so the published Investor Intel tests can run without the private platform.
//
// Stands in for: supabase/functions/_shared/exchange-market/http.ts
// What that is:  The platform's exchange HTTP choke point. It is not published.
//
// Every export throws when used (test-support/stand-ins/unavailable.ts), so a
// passing test never reached it. The names are the ones that published Intel
// modules import from the real module, and nothing else.

import { unavailable } from '../../unavailable.ts'

export const callExchange = unavailable('supabase/functions/_shared/exchange-market/http.ts callExchange')
