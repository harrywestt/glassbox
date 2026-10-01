export type DiffLine = { t: ' ' | '+' | '-'; s: string }

const MAX_CELLS = 400_000

/**
 * Line diff (longest common subsequence). Good for the snippet-sized edits Claude makes; for very
 * large inputs it falls back to "all removed, all added" rather than doing unbounded work.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (!before) return b.map((s) => ({ t: '+', s }))
  if (a.length * b.length > MAX_CELLS) return [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))]
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ t: ' ', s: a[i++] }), j++
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: a[i++] })
    else out.push({ t: '+', s: b[j++] })
  }
  while (i < n) out.push({ t: '-', s: a[i++] })
  while (j < m) out.push({ t: '+', s: b[j++] })
  return out
}

/** Keep changed lines plus `context` lines around them; gaps become a single "…" marker (null). */
export function withContext(lines: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = new Set<number>()
  lines.forEach((l, i) => {
    if (l.t !== ' ') for (let k = i - context; k <= i + context; k++) keep.add(k)
  })
  const out: (DiffLine | null)[] = []
  let gap = false
  lines.forEach((l, i) => {
    if (keep.has(i)) {
      out.push(l)
      gap = false
    } else if (!gap) {
      out.push(null)
      gap = true
    }
  })
  return out[0] === null ? out.slice(1) : out
}

export const counts = (lines: DiffLine[]) => ({ added: lines.filter((l) => l.t === '+').length, removed: lines.filter((l) => l.t === '-').length })
