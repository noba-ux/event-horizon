import { useEffect, useRef } from 'react'
import type { Telemetry } from '../telemetry'
import './HUD.css'

interface HUDProps {
  telemetry: React.RefObject<Telemetry>
  active: boolean
}

/** Formats a duration in seconds as (years/days) HH:MM:SS. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const years = Math.floor(s / 31_557_600)
  const days = Math.floor((s % 31_557_600) / 86_400)
  const hh = Math.floor((s % 86_400) / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  if (years > 0) return `${years}y ${days}d ${clock}`
  if (days > 0) return `${days}d ${clock}`
  return clock
}

const GLITCH_CHARS = '0123456789:#%&/\\'

/** Randomly corrupts a few characters — used only late-game. */
function glitchText(s: string, amount: number): string {
  let out = ''
  for (const ch of s) {
    if (ch !== ' ' && Math.random() < amount * 0.4) {
      out += GLITCH_CHARS[(Math.random() * GLITCH_CHARS.length) | 0]
    } else {
      out += ch
    }
  }
  return out
}

/**
 * Bottom spaceship dashboard. Reads the shared telemetry ref in its own rAF
 * loop and writes straight to the DOM / canvas, so it never re-renders React
 * per frame. Beyond ~0.5 distortion the whole panel starts to collapse: it
 * shakes, compresses toward center, flickers and glitches.
 */
export function HUD({ telemetry, active }: HUDProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const earthRef = useRef<HTMLSpanElement>(null)
  const shipRef = useRef<HTMLSpanElement>(null)
  const distRef = useRef<HTMLSpanElement>(null)
  const proxRef = useRef<HTMLSpanElement>(null)
  const proxBarRef = useRef<HTMLDivElement>(null)
  const signalRef = useRef<HTMLSpanElement>(null)
  const signalBarRef = useRef<HTMLDivElement>(null)
  const syncRef = useRef<HTMLSpanElement>(null)
  const radarRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = radarRef.current
    const ctx = canvas?.getContext('2d') ?? null
    let raf = 0

    const draw = () => {
      const tel = telemetry.current
      const paused = tel.simulationPaused // hold the HUD steady while paused
      const absorb = tel.absorb // singularity → compress + fade the HUD away
      const pulse = tel.spacetimePulse // brief shake at each 30s stage boundary
      const d = tel.distortionFactor
      const synced = tel.isSynced
      // Collapse intensity: ramps after 0.5 distortion (plus some mid-journey
      // unease), smoothly eased when the marker is synced.
      const calm = 1 - tel.syncEase * 0.4
      const base = Math.max(0, (d - 0.5) / 0.5)
      let g = Math.max(base, Math.max(0, d - 0.3) * 0.3)
      g = Math.min(1, g) * calm

      // Sync-lock readout.
      if (syncRef.current) {
        syncRef.current.textContent = synced ? 'LOCKED' : 'SEEKING'
        syncRef.current.className = `gauge-value sync ${synced ? 'locked' : 'seeking'}`
      }

      // --- Panel-wide collapse transform / flicker ---------------------------
      // While paused we leave the panel's last pose in place (no new jitter).
      const root = rootRef.current
      if (root && !paused && absorb > 0.001) {
        // Singularity: the panel is compressed toward centre and fades out.
        root.classList.remove('critical')
        root.style.transform = `translateY(${(-absorb * 46).toFixed(1)}px) scale(${(1 - absorb * 0.85).toFixed(3)})`
        root.style.opacity = Math.max(0, 1 - absorb * 1.2).toFixed(3)
        root.style.setProperty('--glitch', '0')
      } else if (root && !paused) {
        if (g > 0.001) {
          root.classList.add('critical')
          const jx = (Math.random() * 2 - 1) * g * 4
          const jy = (Math.random() * 2 - 1) * g * 3 - g * 5 // pulled up/inward
          root.style.transform = `translate(${jx.toFixed(2)}px, ${jy.toFixed(2)}px) scale(${(1 - g * 0.03).toFixed(3)}, ${(1 - g * 0.06).toFixed(3)})`
          root.style.opacity = (
            1 - (Math.random() < g * 0.25 ? Math.random() * 0.4 : 0)
          ).toFixed(3)
          root.style.setProperty('--glitch', g.toFixed(3))
        } else {
          // No collapse — but a stage pulse gives a brief shake (no red glitch).
          if (root.classList.contains('critical')) {
            root.classList.remove('critical')
            root.style.setProperty('--glitch', '0')
          }
          if (pulse > 0.02) {
            const jx = (Math.random() * 2 - 1) * pulse * 3
            const jy = (Math.random() * 2 - 1) * pulse * 2
            root.style.transform = `translate(${jx.toFixed(2)}px, ${jy.toFixed(2)}px)`
          } else {
            root.style.transform = ''
          }
          root.style.opacity = ''
        }
      }

      // --- Clocks (glitch/corrupt late-game) --------------------------------
      let earthStr = formatDuration(tel.earthSeconds)
      let shipStr = formatDuration(tel.shipSeconds)
      if (!paused && g > 0 && Math.random() < g * 0.25)
        earthStr = glitchText(earthStr, g)
      if (!paused && g > 0 && Math.random() < g * 0.25)
        shipStr = glitchText(shipStr, g)
      if (earthRef.current) earthRef.current.textContent = earthStr
      if (shipRef.current) shipRef.current.textContent = shipStr

      if (distRef.current)
        distRef.current.textContent = `${Math.round(tel.distanceToBlackHole * 1000).toLocaleString()} km`
      if (proxRef.current)
        proxRef.current.textContent = `${Math.round(d * 100)}%`
      if (proxBarRef.current) proxBarRef.current.style.width = `${d * 100}%`
      // Signal integrity: recovers while synced, decays otherwise; unstable
      // (jittery) late-game but never a hard failure.
      const integrity = tel.signal * 100
      if (signalRef.current)
        signalRef.current.textContent = `${Math.round(tel.signal * 100)}%`
      if (signalBarRef.current) {
        const jitter = paused ? 0 : (Math.random() * 2 - 1) * g * 16
        signalBarRef.current.style.width = `${Math.min(100, Math.max(0, integrity + jitter))}%`
      }

      if (ctx && canvas)
        drawRadar(ctx, canvas.width, canvas.height, d, tel.simTime, !paused)
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [telemetry])

  return (
    <div
      ref={rootRef}
      className={`hud${active ? ' active' : ''}`}
      aria-hidden="true"
    >
      <div className="hud-inner">
        <section className="hud-cell hud-radar">
          <div className="hud-cell-label">TACTICAL RADAR</div>
          <canvas ref={radarRef} width={150} height={150} className="radar-canvas" />
        </section>

        <section className="hud-cell hud-clocks">
          <div className="hud-cell-label">CHRONOMETRY</div>
          <div className="clock-row">
            <span className="clock-name">EARTH TIME</span>
            <span ref={earthRef} className="clock-value earth">00:00:00</span>
          </div>
          <div className="clock-row">
            <span className="clock-name">SHIP TIME</span>
            <span ref={shipRef} className="clock-value ship">00:00:00</span>
          </div>
          <div className="clock-note">Δτ // gravitational time dilation</div>
        </section>

        <section className="hud-cell hud-nav">
          <div className="hud-cell-label">NAV · HORIZON</div>
          <div className="gauge-row">
            <span className="gauge-name">SYNC LOCK</span>
            <span ref={syncRef} className="gauge-value sync seeking">SEEKING</span>
          </div>
          <div className="gauge-row">
            <span className="gauge-name">DISTANCE</span>
            <span ref={distRef} className="gauge-value">— km</span>
          </div>
          <div className="gauge-row">
            <span className="gauge-name">PROXIMITY</span>
            <span ref={proxRef} className="gauge-value warn">0%</span>
          </div>
          <div className="bar">
            <div ref={proxBarRef} className="bar-fill prox" />
          </div>
          <div className="gauge-row">
            <span className="gauge-name">SIGNAL INTEGRITY</span>
            <span ref={signalRef} className="gauge-value">100%</span>
          </div>
          <div className="bar">
            <div ref={signalBarRef} className="bar-fill signal" />
          </div>
        </section>
      </div>
    </div>
  )
}

/** Top-down radar: range rings, a sweep, and the black-hole contact. */
function drawRadar(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  distortion: number,
  time: number,
  live: boolean,
) {
  const cx = w / 2
  const cy = h / 2
  const maxR = Math.min(w, h) / 2 - 4
  ctx.clearRect(0, 0, w, h)

  ctx.strokeStyle = 'rgba(90, 220, 255, 0.28)'
  ctx.lineWidth = 1
  for (let ring = 1; ring <= 3; ring++) {
    ctx.beginPath()
    ctx.arc(cx, cy, (maxR * ring) / 3, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.moveTo(cx - maxR, cy)
  ctx.lineTo(cx + maxR, cy)
  ctx.moveTo(cx, cy - maxR)
  ctx.lineTo(cx, cy + maxR)
  ctx.stroke()

  const sweep = time * 1.6 // sim time → freezes with the simulation
  ctx.strokeStyle = 'rgba(120, 255, 190, 0.5)'
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx + Math.cos(sweep) * maxR, cy + Math.sin(sweep) * maxR)
  ctx.stroke()

  // Black-hole contact closes toward center as proximity rises.
  const contactDist = (1 - distortion) * maxR * 0.92
  const jitter = live ? distortion * 3 : 0
  const bx = cx + (Math.random() * 2 - 1) * jitter
  const by = cy - contactDist + (Math.random() * 2 - 1) * jitter
  ctx.fillStyle = `rgba(255, 120, 60, ${0.5 + distortion * 0.5})`
  ctx.beginPath()
  ctx.arc(bx, by, 3 + distortion * 4, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(180, 255, 210, 0.95)'
  ctx.beginPath()
  ctx.arc(cx, cy, 2.5, 0, Math.PI * 2)
  ctx.fill()
}
