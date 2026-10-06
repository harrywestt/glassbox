import { AUTOMATION_DEFAULTS, type Automation } from '../shared/events'

/** The automatic features as you've set them (Settings, Automation); the app sends them at start and on each change. */
let current: Automation = { ...AUTOMATION_DEFAULTS }

export const automation = () => current
export function setAutomation(next: Partial<Automation>) {
  current = { ...current, ...next }
}
