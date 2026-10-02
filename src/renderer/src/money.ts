import { useEffect, useState } from 'react'
import { tr } from '../../shared/i18n'

/** Currency Glassbox shows money in. Source amounts are converted from whatever they're reported in. */
export const DISPLAY_CURRENCY = 'GBP'

type Rates = Awaited<ReturnType<typeof window.glassbox.fx.rates>>

let pending: Promise<Rates> | null = null
const loadRates = () => (pending ??= window.glassbox.fx.rates().catch(() => null))

export function useFx(): Rates {
  const [rates, setRates] = useState<Rates>(null)
  useEffect(() => {
    void loadRates().then(setRates)
  }, [])
  return rates
}

const fmt = (amount: number, currency: string) => new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)

/**
 * Format money in GBP. `title` explains the conversion for a tooltip. When no rate is available
 * the original currency is shown rather than a wrong number.
 */
export function money(amount: number, currency: string, rates: Rates): { text: string; title: string } {
  const code = currency.toUpperCase()
  const original = fmt(amount, code)
  if (code === DISPLAY_CURRENCY) return { text: original, title: original }
  const rate = rates?.perUnit[code]
  if (!rate) return { text: original, title: tr('money.noRate', { original }) }
  return { text: fmt(amount * rate, DISPLAY_CURRENCY), title: tr('money.converted', { original, rate: rate.toFixed(4), date: rates!.date }) }
}
