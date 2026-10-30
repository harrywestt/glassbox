import { useEffect, useRef, type CSSProperties } from 'react'
import { hexToRgb, isHex } from '../colour'
import type { BackdropKind, PanelFrost } from '../appearance'

/** The moving backgrounds you can pick in Settings → Appearance, in the order offered. */
export const BACKDROPS: BackdropKind[] = ['none', 'lava', 'stars', 'fireflies', 'waves', 'aurora', 'snow', 'ripples']

const v = (vars: Record<string, string | number>) => vars as CSSProperties

/** Background strength, faint to strong: how visible the motion is, and how see-through the panels are over it. */
const STRENGTH = { 1: 0.4, 2: 0.65, 3: 0.85, 4: 1 }
/** How solid the panels are over the background, and how much they blur what's behind them. */
const FROST: Record<PanelFrost, { glass: number; blur: number }> = { clear: { glass: 62, blur: 0 }, frosted: { glass: 70, blur: 14 }, heavy: { glass: 76, blur: 32 }, solid: { glass: 100, blur: 0 } }
export const backdropStrength = (level: 1 | 2 | 3 | 4, panels: PanelFrost = 'frosted') => {
  const f = FROST[panels] ?? FROST.frosted
  // Light themes need a little more solid behind the text to read as well.
  return v({ '--bd-op': STRENGTH[level] ?? 0.65, '--glass-d': `${f.glass}%`, '--glass-l': `${Math.min(100, f.glass + 4)}%`, '--frost': `${f.blur}px` })
}

/** Four blobs, each built from five overlapping balls (body, two lumps, neck and tail), so the shapes are irregular. */
const MAX_WAX = 20

/*
 * Every background is a fragment shader (plain WebGL 1, so it runs the same on Windows, macOS and
 * Linux), drawn at screen resolution so edges stay crisp at any size. Shared uniforms:
 *   res   the canvas size in device pixels      dpr   device pixels per CSS pixel
 *   t     seconds
 *   col   the theme's accent                    ink   the theme's text colour, for starlight
 *   gain  1, or more in the small previews so they read at that size
 * Output is premultiplied alpha over the window's own background.
 */
const HEAD = `
precision mediump float;
uniform vec2 res;
uniform float dpr;
uniform float t;
uniform vec3 col;
uniform vec3 ink;
uniform float gain;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`

/**
 * Lava lamp. Each ball adds a compact bump to one field (zero beyond twice its radius, so blobs join
 * only when they're close, with a neck that thins and pinches off rather than everything merging into
 * one mass); balls are stretched upright as they rise, outlines wobble slightly. A shallow pool with
 * slow domes lies along the bottom, and the whole lamp is lit from below: wax brighter near the bulb
 * and in its thickest parts.
 */
const LAVA = `${HEAD}
uniform vec4 wax[${MAX_WAX}];
void main() {
  vec2 uv = gl_FragCoord.xy / res;
  uv.y = 1.0 - uv.y;
  float asp = res.x / res.y;
  vec2 p = vec2(uv.x * asp, uv.y);
  float f = 0.0;
  for (int i = 0; i < ${MAX_WAX}; i++) {
    vec4 q = wax[i];
    if (q.z <= 0.0) continue;
    vec2 d = p - vec2(q.x * asp, q.y);
    d.y /= q.w;
    float a = atan(d.y, d.x);
    float rr = q.z * (1.0 + 0.05 * sin(a * 3.0 + t * 0.5 + float(i) * 2.1));
    float k = clamp(1.0 - dot(d, d) / (4.0 * rr * rr), 0.0, 1.0);
    f += 2.0 * k * k * k;
  }
  // The pool: a shallow layer whose surface rises into slow domes where wax is about to lift off.
  float surface = 0.965 - 0.012 * (0.5 + 0.5 * sin(uv.x * 5.0 + t * 0.15)) - 0.008 * sin(uv.x * 11.0 - t * 0.1);
  float above = surface - uv.y;
  float kp = clamp(1.0 - above / 0.06, 0.0, 1.0);
  f += above < 0.0 ? 2.0 : 2.0 * kp * kp * kp;
  float body = smoothstep(0.95, 1.05, f);
  float glow = smoothstep(0.2, 1.0, f) * 0.14;
  // Lit from below: brighter near the bulb and where the wax is thick.
  float lit = 0.75 + 0.35 * uv.y + 0.25 * smoothstep(1.4, 2.0, f);
  vec3 c = mix(col, vec3(1.0), clamp((lit - 1.0) * 0.6, 0.0, 0.35)) * min(lit, 1.0);
  float alpha = clamp(max(body, glow) * 0.55 * gain, 0.0, 1.0);
  gl_FragColor = vec4(c * alpha, alpha);
}`

/** Shooting stars: a twinkling field (one star per cell, at a random spot), and three streaks crossing now and then. */
const STARS = `${HEAD}
float streak(vec2 px, float i) {
  float period = 9.0 + i * 5.0;
  float k = floor((t + i * 3.7) / period);
  float age = mod(t + i * 3.7, period);
  float life = 1.1;
  if (age > life) return 0.0;
  vec2 start = vec2(hash(vec2(k, i)) * 0.7 + 0.3, hash(vec2(i, k)) * 0.4) * res / dpr;
  vec2 dir = normalize(vec2(-1.0, 0.45));
  float len = 160.0;
  vec2 head = start + dir * (age / life) * 700.0;
  vec2 d = px - head;
  float along = -dot(d, dir);
  float across = abs(dot(d, vec2(-dir.y, dir.x)));
  if (along < 0.0 || along > len) return 0.0;
  float fade = (1.0 - along / len) * sin(3.1416 * age / life);
  return fade * smoothstep(1.4, 0.0, across);
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y) / dpr;
  float cell = 46.0;
  vec2 id = floor(px / cell);
  vec2 at = (id + vec2(hash(id), hash(id + 7.3)) * 0.8 + 0.1) * cell;
  float h = hash(id + 3.1);
  float size = h > 0.9 ? 1.3 : 0.8;
  float twinkle = 0.35 + 0.65 * (0.5 + 0.5 * sin(t * (0.5 + h * 1.5) + h * 40.0));
  float star = smoothstep(size + 0.8, size - 0.4, length(px - at)) * twinkle * (0.25 + 0.5 * step(0.55, h));
  float s = 0.0;
  for (int i = 0; i < 3; i++) s += streak(px, float(i));
  float alpha = clamp((star * 0.5 + s * 0.8) * gain, 0.0, 1.0);
  gl_FragColor = vec4(ink * alpha, alpha);
}`

/** Fireflies: little lights in the accent drifting upwards, each glowing, flickering and fading over its own cycle. */
const FIREFLIES = `${HEAD}
void main() {
  vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y) / dpr;
  vec2 size = res / dpr;
  float light = 0.0;
  for (int i = 0; i < 26; i++) {
    float fi = float(i);
    float period = 14.0 + hash(vec2(fi, 1.0)) * 14.0;
    float phase = mod(t + hash(vec2(fi, 2.0)) * period, period) / period;
    vec2 base = vec2(hash(vec2(fi, 3.0)), 0.25 + hash(vec2(fi, 4.0)) * 0.75) * size;
    vec2 p = base + vec2(sin(phase * 6.2832 + fi) * 30.0 + (hash(vec2(fi, 5.0)) - 0.5) * 80.0 * phase, -phase * 150.0);
    float on = sin(3.1416 * phase) * (0.6 + 0.4 * sin(t * 3.0 + fi * 1.7));
    float d = length(px - p);
    light += on * (exp(-d * d / 40.0) * 0.6 + exp(-d * d / 4.0));
  }
  vec3 c = mix(col, vec3(1.0), 0.35);
  float alpha = clamp(light * 0.8 * gain, 0.0, 1.0);
  gl_FragColor = vec4(c * alpha, alpha);
}`

/** Waves: three swells, back to front, each a lit crest over a body fading downwards, rolling and slowly rising and falling. */
const WAVES = `${HEAD}
float swell(float x, float periods, float speed, float phase) {
  float a = x * 6.2832 * periods + t * speed + phase;
  return 0.75 * sin(a) + 0.25 * sin(a * 3.0 + phase);
}
void main() {
  vec2 uv = gl_FragCoord.xy / res;
  uv.y = 1.0 - uv.y;
  float px = 1.0 / res.y;
  float alpha = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float mid = 0.38 + fi * 0.16 + 0.025 * sin(t * (0.45 - fi * 0.08) + fi);
    float amp = 0.05 - fi * 0.008;
    float dir = i == 1 ? -1.0 : 1.0;
    float y = mid + amp * swell(uv.x, 1.0 + fi * 0.5, (0.42 + fi * 0.3) * dir, fi * 1.7);
    float depth = uv.y - y;
    float body = smoothstep(-1.5 * px * dpr, 1.5 * px * dpr, depth) * (1.0 - smoothstep(0.0, 0.45, depth)) * (0.16 + fi * 0.04);
    float crest = smoothstep(2.0 * px * dpr, 0.0, abs(depth)) * (0.3 + fi * 0.12);
    float layer = max(body, crest) * (0.55 + fi * 0.22);
    alpha = layer + alpha * (1.0 - layer);
  }
  alpha = clamp(alpha * gain, 0.0, 1.0);
  gl_FragColor = vec4(col * alpha, alpha);
}`

/** Aurora: curtains of light in the accent hanging from the top, sharp along their upper edge and fading downwards, shimmering in fine rays. */
const AURORA = `${HEAD}
void main() {
  vec2 uv = gl_FragCoord.xy / res;
  uv.y = 1.0 - uv.y;
  float x = uv.x * res.x / res.y;
  float light = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float top = 0.1 + fi * 0.07 + 0.05 * sin(x * (1.1 + fi * 0.4) + t * (0.06 + fi * 0.03) + fi * 2.0) + 0.02 * sin(x * 3.3 - t * 0.1 + fi);
    float below = uv.y - top;
    float curtain = below < 0.0 ? exp(below / 0.012) : exp(-below / (0.16 + fi * 0.05));
    float rays = 0.55 + 0.45 * sin(x * (38.0 + fi * 11.0) + 3.0 * sin(x * 2.0 + t * 0.15 + fi));
    light += curtain * rays * (0.5 - fi * 0.1);
  }
  vec3 c = mix(col, vec3(1.0), 0.15);
  float alpha = clamp(light * 0.45 * gain, 0.0, 1.0);
  gl_FragColor = vec4(c * alpha, alpha);
}`

/** Snowfall: three layers of flakes in the text colour, the nearer ones bigger, brighter and quicker, each swaying as it falls. */
const SNOW = `${HEAD}
float flakes(vec2 px, float cell, float fall, float radius, float seed) {
  vec2 p = px;
  p.y -= t * fall;
  p.x += sin(t * 0.4 + px.y * 0.012 + seed) * cell * 0.25;
  vec2 id = floor(p / cell);
  if (hash(id + seed) < 0.45) return 0.0;
  vec2 at = (id + 0.2 + 0.6 * vec2(hash(id + seed + 1.3), hash(id + seed + 2.7))) * cell;
  return smoothstep(radius + 0.9, radius - 0.5, length(p - at));
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y) / dpr;
  float s = flakes(px, 70.0, 9.0, 0.9, 0.0) * 0.35 + flakes(px, 110.0, 16.0, 1.4, 5.0) * 0.55 + flakes(px, 170.0, 26.0, 2.1, 11.0) * 0.8;
  float alpha = clamp(s * 0.6 * gain, 0.0, 1.0);
  gl_FragColor = vec4(ink * alpha, alpha);
}`

/** Ripples: drops landing on still water at random spots, each sending out a pair of rings that spread and fade. */
const RIPPLES = `${HEAD}
void main() {
  vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y) / dpr;
  vec2 size = res / dpr;
  float light = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float period = 7.0 + fi * 1.3;
    float k = floor((t + fi * 2.9) / period);
    float age = mod(t + fi * 2.9, period);
    vec2 at = vec2(hash(vec2(k, fi)), hash(vec2(fi, k + 4.0))) * size;
    float d = length(px - at);
    float fade = pow(1.0 - age / period, 2.0);
    float r1 = age * 34.0;
    float r2 = age * 22.0;
    light += fade * (exp(-pow((d - r1) / 1.6, 2.0)) + 0.6 * exp(-pow((d - r2) / 1.4, 2.0)));
  }
  float alpha = clamp(light * 0.5 * gain, 0.0, 1.0);
  gl_FragColor = vec4(col * alpha, alpha);
}`

const SHADERS: Record<Exclude<BackdropKind, 'none'>, string> = { lava: LAVA, stars: STARS, fireflies: FIREFLIES, waves: WAVES, aurora: AURORA, snow: SNOW, ripples: RIPPLES }

type Wax = { x: number; y: number; r: number; vy: number; heat: number; sway: number; tail: number; lump: number }

const smooth = (a: number, b: number, x: number) => {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return k * k * (3 - 2 * k)
}

/**
 * The lava's wax, as a real lamp behaves: the bulb warms wax only while it lies at the bottom; warm
 * wax swells and rises, losing heat all the way (faster near the cooler top), so it slows, spreads a
 * little at the top and sinks back into the pool, which warms it again. A rising blob trails a neck
 * down to the pool that thins and pinches off; a sinking one trails a short tail above it.
 */
function makeWax() {
  const wax: Wax[] = Array.from({ length: 4 }, (_, i) => ({
    x: 0.2 + (i / 3) * 0.6,
    y: [0.97, 0.45, 0.97, 0.22][i],
    r: 0.07 + ((i * 13) % 4) / 120,
    vy: 0,
    heat: [0.4, 0.55, 0.2, 0.3][i],
    sway: i * 1.7,
    tail: [0.97, 0.6, 0.97, 0.2][i],
    lump: i
  }))
  const packed = new Float32Array(MAX_WAX * 4)
  return (t: number, dt: number) => {
    wax.forEach((b, i) => {
      // Heat from the bulb at the bottom; heat lost everywhere else, more the higher it is.
      b.heat += (b.y > 0.9 ? 0.09 : -(0.012 + 0.04 * (1 - b.y))) * dt
      b.heat = Math.max(0, Math.min(1, b.heat))
      b.vy += ((0.5 - b.heat) * 0.07 - b.vy * 0.9) * dt
      b.y += b.vy * dt
      if (b.y < 0.14) (b.y = 0.14), (b.vy = Math.max(0, b.vy))
      if (b.y > 0.97) (b.y = 0.97), (b.vy = Math.min(0, b.vy))
      // Drift sideways slowly, more so at the top where the wax spreads before it sinks.
      b.x = Math.max(0.1, Math.min(0.9, b.x + Math.sin(t / 11 + b.sway) * (b.y < 0.3 ? 0.01 : 0.004) * dt))
      b.tail += (b.y - b.tail) * Math.min(1, dt * 0.45)
      b.lump += dt * 0.12
      const r = b.r * (0.85 + 0.3 * b.heat)
      const sep = Math.abs(b.y - b.tail)
      const rising = Math.max(0, -b.vy)
      const stretch = b.y < 0.2 && Math.abs(b.vy) < 0.01 ? 0.8 : 1 + Math.min(0.8, rising * 14 + Math.max(0, b.vy) * 5)
      const neck = 1 - smooth(0.06, 0.24, sep)
      const tailR = 1 - smooth(0.12, 0.32, sep)
      const balls = [
        [b.x, b.y, r, stretch],
        [b.x + Math.cos(b.lump) * r * 0.55, b.y + Math.sin(b.lump) * r * 0.4, r * 0.62, 1],
        [b.x - Math.cos(b.lump * 1.3) * r * 0.5, b.y - Math.sin(b.lump * 0.8) * r * 0.35, r * 0.48, 1],
        [b.x, (b.y + b.tail) / 2, r * 0.42 * neck, 1 + sep * 7],
        [b.x, b.tail, r * 0.6 * tailR, 1 + sep * 2]
      ]
      balls.forEach((q, j) => packed.set(q, (i * 5 + j) * 4))
    })
    return packed
  }
}

function rgb(el: Element, prop: string, fallback: [number, number, number]): [number, number, number] {
  const value = getComputedStyle(el).getPropertyValue(prop).trim()
  return isHex(value) ? (hexToRgb(value).map((n) => n / 255) as [number, number, number]) : fallback
}

/**
 * Draws one background's shader into a canvas filling its parent, about 30 frames a second and none
 * while it's off screen or the window is hidden. Without WebGL (hardware acceleration off) it draws
 * nothing and the app looks as it would with no background.
 */
function ShaderCanvas({ kind, preview }: { kind: Exclude<BackdropKind, 'none'>; preview?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // A new canvas each time: a context given back on cleanup can't be used again, and React may run this twice.
    const box = host.current
    if (!box) return
    const el = document.createElement('canvas')
    el.className = 'bd-canvas'
    box.appendChild(el)
    const gl = el.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false })
    if (!gl) return () => el.remove()
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.warn('backdrop shader:', gl.getShaderInfoLog(sh))
      return sh
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, SHADERS[kind]))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return () => el.remove()
    gl.useProgram(prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const at = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(at)
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0)
    const loc = (n: string) => gl.getUniformLocation(prog, n)
    const u = { res: loc('res'), dpr: loc('dpr'), t: loc('t'), col: loc('col'), ink: loc('ink'), gain: loc('gain'), wax: loc('wax') }

    // The previews in Settings move at the real speed, a little brighter so they read at that size.
    const speed = 1
    gl.uniform1f(u.gain, preview ? 1.6 : 1)
    const wax = kind === 'lava' ? makeWax() : null
    let colour = rgb(el, '--accent', [0.3, 0.6, 1])
    let ink = rgb(el, '--bd-ink', [0.9, 0.9, 0.9])
    let dpr = 1
    const size = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(el.clientWidth * dpr))
      const h = Math.max(1, Math.round(el.clientHeight * dpr))
      if (el.width !== w || el.height !== h) {
        el.width = w
        el.height = h
        gl.viewport(0, 0, w, h)
      }
    }
    let clock = 0
    let last = 0
    let frame = 0
    let raf = 0
    const draw = (dt: number) => {
      clock += dt * speed
      size()
      if (wax) gl.uniform4fv(u.wax, wax(clock, dt * speed))
      // The theme can change under it; check its colours every couple of seconds.
      if (++frame % 60 === 0) {
        colour = rgb(el, '--accent', colour)
        ink = rgb(el, '--bd-ink', ink)
      }
      gl.uniform2f(u.res, el.width, el.height)
      gl.uniform1f(u.dpr, dpr)
      gl.uniform1f(u.t, clock)
      gl.uniform3f(u.col, ...colour)
      gl.uniform3f(u.ink, ...ink)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (document.hidden || !el.offsetParent || now - last < 33) return
      draw(Math.min(0.1, (now - last) / 1000 || 0.033))
      last = now
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Settle into a shape, then hold it.
      for (let i = 0; i < 300; i++) wax?.(i * 0.033, 0.033)
      draw(0)
    } else raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      // Give the context back now rather than when it's collected; Settings can show several at once.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      el.remove()
    }
  }, [kind, preview])
  return <div ref={host} className="bd-canvas" />
}

/**
 * A slow, faint moving background behind the whole app, seen through the frosted panels and on the
 * dashboard: lava lamp, shooting stars, fireflies, waves, aurora, snowfall or ripples, all in the theme's own colours.
 */
export function Backdrop({ kind, preview }: { kind: BackdropKind; preview?: boolean }) {
  if (!BACKDROPS.includes(kind) || kind === 'none') return null
  return (
    <div className={`backdrop bd-${kind}${preview ? ' preview' : ''}`} aria-hidden>
      {kind === 'lava' && <span className="bd-lava-glow" />}
      <ShaderCanvas key={kind} kind={kind} preview={preview} />
    </div>
  )
}
