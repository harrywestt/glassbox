import type { Tally } from '../tally'

const LAMP: Record<Tally, string> = { live: 'var(--tally-live)', wait: 'var(--warn)', ok: 'var(--ok)', idle: 'transparent', err: 'transparent' }

/**
 * The Glassbox mark: code brackets holding the on-air lamp. In the titlebar the lamp shows every
 * session at once: red while any works, amber when one needs you, green when they're done.
 */
export function Logo({ size = 18, state = 'live' }: { size?: number; state?: Tally }) {
  const hollow = state === 'idle' || state === 'err'
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" className="logo">
      <g fill="none" stroke="currentColor" strokeWidth="46" strokeLinecap="round" strokeLinejoin="round">
        <path d="M196 118 H170 a40 40 0 0 0 -40 40 V354 a40 40 0 0 0 40 40 H196" />
        <path d="M316 118 H342 a40 40 0 0 1 40 40 V354 a40 40 0 0 1 -40 40 H316" />
      </g>
      <circle cx="256" cy="256" r="54" fill={LAMP[state]} stroke={hollow ? (state === 'err' ? 'var(--err)' : 'currentColor') : 'none'} strokeWidth={hollow ? 22 : 0} />
    </svg>
  )
}
