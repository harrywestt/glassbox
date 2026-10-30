import type { Spinner } from '../appearance'

/** The spinners you can pick in Settings → Appearance, in the order they're offered. */
export const SPINNERS: Spinner[] = ['spark', 'orbit', 'heartbeat', 'equaliser', 'shapeshift', 'snake', 'ripple', 'bounce']

/** The perimeter of a 3×3 grid, clockwise from the top-left, for the snake. */
const RING = [
  [0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]
]

/**
 * The little animation beside "Working…" while Claude works, in the accent colour.
 * Each one is drawn on a 16-unit square and sized by the CSS around it.
 */
export function WorkingMark({ kind }: { kind: Spinner }) {
  const cls = `working-mark wm-${kind}`
  switch (kind) {
    case 'orbit':
      // A core with two moons on different paths and speeds.
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden>
          <circle className="wm-track" cx="8" cy="8" r="6" />
          <circle cx="8" cy="8" r="1.8" />
          <g className="wm-moon a"><circle cx="8" cy="2" r="1.5" /></g>
          <g className="wm-moon b"><circle cx="8" cy="12.5" r="1.1" /></g>
        </svg>
      )
    case 'heartbeat':
      // A pulse trace that draws itself across, then runs off.
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden>
          <path className="wm-trace-dim" d="M0.5 8.5 H4 L5.5 5 L7.5 13 L9.5 2.5 L11.2 8.5 H15.5" />
          <path className="wm-trace" pathLength={40} d="M0.5 8.5 H4 L5.5 5 L7.5 13 L9.5 2.5 L11.2 8.5 H15.5" />
        </svg>
      )
    case 'equaliser':
      // Four level bars, each bouncing to its own beat.
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden>
          {[1.5, 5.5, 9.5, 13.5].map((x, i) => (
            <rect key={i} className={`wm-bar b${i}`} x={x - 1.2} y="2" width="2.4" height="12.5" rx="1.2" />
          ))}
        </svg>
      )
    case 'shapeshift':
      // A square that rounds into a circle and back as it tumbles.
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden>
          <rect className="wm-shape" x="3" y="3" width="10" height="10" rx="1.5" />
        </svg>
      )
    case 'ripple':
      // A drop in the middle sending out rings, one after another.
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden>
          <circle className="wm-drop" cx="8" cy="8" r="1.6" />
          {[0, 1, 2].map((i) => (
            <circle key={i} className="wm-ring" cx="8" cy="8" r="6.5" style={{ animationDelay: `${-i * 0.6}s` }} />
          ))}
        </svg>
      )
    case 'bounce':
      // Three balls hopping in turn, squashing as they land.
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden>
          {[2.5, 8, 13.5].map((x, i) => (
            <circle key={i} className="wm-ball" cx={x} cy="12" r="1.9" style={{ animationDelay: `${i * 0.14 - 0.9}s` }} />
          ))}
        </svg>
      )
    case 'snake':
      // A lit cell chasing its tail round a 3×3 grid.
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden>
          <rect className="wm-cell-dim" x="6.4" y="6.4" width="3.2" height="3.2" rx="0.8" />
          {RING.map(([cx, cy], i) => (
            <rect key={i} className="wm-cell" x={1.2 + cx * 5.2} y={1.2 + cy * 5.2} width="3.2" height="3.2" rx="0.8" style={{ animationDelay: `${(i - RING.length) * 0.13}s` }} />
          ))}
        </svg>
      )
    default:
      // A six-spoked spark, turning slowly.
      return (
        <svg className={cls} viewBox="0 0 14 14" aria-hidden>
          {[0, 60, 120].map((a) => (
            <line key={a} x1="7" y1="1.5" x2="7" y2="12.5" transform={`rotate(${a} 7 7)`} />
          ))}
        </svg>
      )
  }
}
