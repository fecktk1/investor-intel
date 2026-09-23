// TEST STAND-IN: not the production module; used only so the published Investor Intel tests can run without the private platform.
//
// Stands in for: supabase/functions/_shared/entity-resolver.ts
// What that is:  The platform's entity identity resolver. It is not published.
//
// Every export throws when used (test-support/stand-ins/unavailable.ts), so a
// passing test never reached it. The names are the ones that published Intel
// modules import from the real module, and nothing else. The demo fetch
// (src/intel/demo/demo-fetch.js) checks a caught error with `instanceof
// EntityResolveRefusal`; that stays false for every real value, and
// constructing one throws.

import { unavailable, unavailableClass } from '../unavailable.ts'

export const normalizeEntity = unavailable('supabase/functions/_shared/entity-resolver.ts normalizeEntity')
export const EntityResolveRefusal = unavailableClass('supabase/functions/_shared/entity-resolver.ts EntityResolveRefusal')
