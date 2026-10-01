/**
 * The Jira key in a branch name, e.g. "NSD-4256-identity-etl" or "feature/nsd-4256_etl" -> "NSD-4256".
 * Shared by main and renderer. Lookarounds rather than \b so "NSD-4256_etl" (underscore) still matches.
 */
export function ticketKeyFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null
  const m = /(?<![A-Z0-9])([A-Z][A-Z0-9]+-\d+)(?!\d)/i.exec(branch)
  return m ? m[1].toUpperCase() : null
}
