import { app, net } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** GBP per one unit of each currency, e.g. { USD: 0.74, EUR: 0.86 }. */
export type FxRates = { base: 'GBP'; perUnit: Record<string, number>; date: string; fetchedAt: number }

const TTL_MS = 12 * 60 * 60 * 1000
const file = () => join(app.getPath('userData'), 'fx-rates.json')
let cached: FxRates | null = null

/** ECB reference rates via frankfurter.dev, cached in memory and on disk so it works offline. */
export async function getRates(): Promise<FxRates | null> {
  if (!cached) {
    try {
      cached = JSON.parse(readFileSync(file(), 'utf8')) as FxRates
    } catch {
      /* first run: nothing saved yet */
    }
  }
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached
  try {
    const res = await net.fetch('https://api.frankfurter.dev/v1/latest?base=GBP&symbols=USD,EUR')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { date: string; rates: Record<string, number> }
    const perUnit = Object.fromEntries(Object.entries(body.rates).map(([code, perGbp]) => [code, 1 / perGbp]))
    cached = { base: 'GBP', perUnit: { ...perUnit, GBP: 1 }, date: body.date, fetchedAt: Date.now() }
    writeFileSync(file(), JSON.stringify(cached))
  } catch {
    // Offline or the service is down: keep using the last saved rates, however old.
  }
  return cached
}
