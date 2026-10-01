/**
 * Connections that aren't imports: a frontend calling a backend over HTTP. Server routes are read
 * from the code that declares them (ASP.NET [Route]/[HttpGet] attributes and minimal-API MapGet,
 * Express-style app.get, Python @app.get decorators); client calls are the URL strings in JS/TS
 * that look like API paths. A call links to a route when their paths line up (ignoring a proxy
 * prefix such as /api/backend, and treating {id}, :id and ${…} as wildcards).
 */

export type ServerRoute = { file: string; method: string; route: string; segs: string[] }
/** `method`: when the code next to the URL says (method: "POST", .post(…), http.put(…)). */
export type ClientCall = { file: string; path: string; segs: string[]; method?: string }

const METHODS = ['get', 'post', 'put', 'patch', 'delete']

/** Path segments, lower-cased, with parameters as '*'. */
export function routeSegs(path: string): string[] {
  return path
    .replace(/[?#].*$/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => (/^\{.*\}$|^:|^\*$|^\$\{/.test(s) || s.includes('${') ? '*' : s.toLowerCase()))
}

/** The routes a server file declares. */
export function serverRoutes(file: string, text: string): ServerRoute[] {
  const out: ServerRoute[] = []
  const add = (method: string, route: string) => {
    const segs = routeSegs(route)
    if (segs.length) out.push({ file, method: method.toUpperCase(), route: '/' + route.replace(/^[~/]+/, ''), segs })
  }
  if (file.endsWith('.cs')) {
    // [Route("api/v1/controls")] on the class, [HttpPost("{id}/evidence")] on each action.
    const cls = /\[Route\(\s*"([^"]*)"\s*\)\]/.exec(text)
    const className = /\bclass\s+(\w+?)(?:Controller)?\b/.exec(text)?.[1] ?? ''
    const base = (cls?.[1] ?? '').replace(/\[controller\]/gi, className.toLowerCase())
    let any = false
    for (const m of text.matchAll(/\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)"[^)]*\))?\]/g)) {
      any = true
      const sub = m[2] ?? ''
      add(m[1], sub.startsWith('/') || sub.startsWith('~/') ? sub : [base, sub].filter(Boolean).join('/'))
    }
    if (!any && cls) add('GET', base)
    for (const m of text.matchAll(/\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/g)) add(m[1], m[2])
  } else if (/\.(py)$/.test(file)) {
    for (const m of text.matchAll(/@\w+\.(get|post|put|patch|delete|route)\(\s*['"]([^'"]+)['"]/g)) add(m[1] === 'route' ? 'GET' : m[1], m[2])
  } else {
    for (const m of text.matchAll(/\b(?:app|router|server|api|routes)\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`]+)['"`]/g)) add(m[1], m[2])
  }
  return out
}

/** The API paths a client file calls ("/api/…", "/v1/…", including template strings). */
export function clientCalls(file: string, text: string): ClientCall[] {
  const out: ClientCall[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(/["'`]([^"'`\n]*\/(?:api|v\d+)\/[^"'`\s]*)["'`]/g)) {
    const raw = m[1]
    const at = raw.search(/\/(?:api|v\d+)\//)
    if (at < 0) continue
    const path = raw.slice(at).replace(/\$\{[^}]*\}/g, '*')
    // The method: an options object just after the URL, or a verb-named call just before it.
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 200)
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0)
    const method = (/method:\s*["'`](get|post|put|patch|delete)["'`]/i.exec(after)?.[1] ?? /\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\(\s*$/i.exec(before)?.[1])?.toUpperCase()
    const key = `${method ?? ''} ${path}`
    if (seen.has(key)) continue
    seen.add(key)
    const segs = routeSegs(path)
    if (segs.length >= 2) out.push({ file, path, segs, method: method ?? (/\bmethod:/.test(after) ? undefined : 'GET') })
  }
  return out
}

/**
 * How well a call's path fits a route (-1: not at all). Equal words score most; a route parameter
 * taking a word from the call is plausible; a call's variable filling a fixed route word is weak.
 * The HTTP method breaks ties.
 */
function fit(route: string[], call: string[], routeMethod: string, callMethod?: string): { score: number; sure: boolean } {
  if (route.length !== call.length) return { score: -1, sure: false }
  let score = 0
  let words = 0
  let loose = false
  for (let i = 0; i < route.length; i++) {
    const r = route[i], c = call[i]
    if (r === c && r !== '*') {
      score += 4
      if (!/^v\d+$/.test(r)) words++
    } else if (r === '*' && c === '*') score += 2
    else if (r === '*') score += 1
    else if (c === '*') (score += 0.5), (loose = true)
    else return { score: -1, sure: false }
  }
  const wrongMethod = !!callMethod && callMethod !== routeMethod
  if (callMethod) score += wrongMethod ? -1 : 3
  // Sure: two or more real words line up, no fixed route word is standing in for a variable, and
  // the method (when the code says) agrees. Anything less is a likely match, not a certain one.
  return { score, sure: words >= 2 && !loose && !wrongMethod }
}

/**
 * Each client call matched to the server route it hits. Leading segments of the call are dropped
 * one at a time (a proxy's /api/backend) until it lines up with a route, compared without a
 * leading "api" on either side.
 */
export function matchCalls(routes: ServerRoute[], calls: ClientCall[]): { call: ClientCall; route: ServerRoute; sure: boolean }[] {
  const strip = (s: string[]) => (s[0] === 'api' ? s.slice(1) : s)
  const byLen = new Map<number, ServerRoute[]>()
  for (const r of routes) {
    const s = strip(r.segs)
    byLen.set(s.length, [...(byLen.get(s.length) ?? []), r])
  }
  const out: { call: ClientCall; route: ServerRoute; sure: boolean }[] = []
  for (const call of calls) {
    for (let k = 0; k <= Math.min(3, call.segs.length - 1); k++) {
      const c = strip(call.segs.slice(k))
      // A call needs at least one fixed word besides the version to be trusted.
      if (!c.some((s) => s !== '*' && !/^v\d+$/.test(s))) break
      let hit: ServerRoute | undefined
      let best = -1
      let sure = false
      let rivals = 0
      for (const r of byLen.get(c.length) ?? []) {
        const f = fit(strip(r.segs), c, r.method, call.method)
        if (f.score > best) (best = f.score), (hit = r), (sure = f.sure), (rivals = 0)
        else if (f.score === best && f.score >= 0 && r.file !== hit?.file) rivals++
      }
      if (hit) {
        // Two routes in different files fitting equally well: the pick is a guess.
        out.push({ call, route: hit, sure: sure && rivals === 0 })
        break
      }
    }
  }
  return out
}

export const isHttpMethod = (s: string) => METHODS.includes(s.toLowerCase())
