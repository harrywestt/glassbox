/** Known vulnerabilities (OSV) and licences (npm) for dependencies Claude added. */
export type DepCheck = { name: string; version: string; ecosystem: string; license?: string; vulns: { id: string; summary?: string }[]; error?: string }

const cache = new Map<string, DepCheck>()

export async function checkDependencies(deps: { name: string; version: string; ecosystem: string }[]): Promise<DepCheck[]> {
  const todo = deps.filter((d) => !cache.has(`${d.ecosystem}:${d.name}@${d.version}`))
  if (todo.length) {
    let vulns: { id: string; summary?: string }[][] = todo.map(() => [])
    let error: string | undefined
    try {
      const res = await fetch('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queries: todo.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) }),
        signal: AbortSignal.timeout(10_000)
      })
      const body = (await res.json()) as { results?: { vulns?: { id: string; summary?: string }[] }[] }
      vulns = todo.map((_, i) => body.results?.[i]?.vulns ?? [])
    } catch (e) {
      error = `Couldn't reach the vulnerability database: ${String(e)}`
    }
    await Promise.all(
      todo.map(async (d, i) => {
        let license: string | undefined
        if (d.ecosystem === 'npm') {
          try {
            const r = await fetch(`https://registry.npmjs.org/${d.name.replace('/', '%2F')}/${encodeURIComponent(d.version)}`, { signal: AbortSignal.timeout(8_000) })
            const j = (await r.json()) as { license?: string | { type?: string } }
            license = typeof j.license === 'string' ? j.license : j.license?.type
          } catch {
            /* licence unknown */
          }
        }
        cache.set(`${d.ecosystem}:${d.name}@${d.version}`, { ...d, license, vulns: vulns[i], error })
      })
    )
  }
  return deps.map((d) => cache.get(`${d.ecosystem}:${d.name}@${d.version}`)!).filter(Boolean)
}
