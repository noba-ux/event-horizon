import { useEffect, useRef } from 'react'
import type { Telemetry } from '../telemetry'

interface OverlaysProps {
  telemetry: React.RefObject<Telemetry>
}

/**
 * Full-screen fade overlays driven from telemetry each frame: a short black
 * blackout at the singularity, and a white flash that opens as the whitehole
 * arrives. Pure DOM opacity — no per-frame React re-render.
 */
export function Overlays({ telemetry }: OverlaysProps) {
  const blackRef = useRef<HTMLDivElement>(null)
  const whiteRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    const loop = () => {
      const t = telemetry.current
      if (blackRef.current) blackRef.current.style.opacity = String(t.blackout)
      if (whiteRef.current) whiteRef.current.style.opacity = String(t.whiteFlash)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [telemetry])

  return (
    <>
      <div
        ref={blackRef}
        style={{
          position: 'absolute',
          inset: 0,
          background: '#000',
          opacity: 0,
          pointerEvents: 'none',
          zIndex: 8,
        }}
      />
      <div
        ref={whiteRef}
        style={{
          position: 'absolute',
          inset: 0,
          background: '#eef2f7',
          opacity: 0,
          pointerEvents: 'none',
          zIndex: 9,
        }}
      />
    </>
  )
}
