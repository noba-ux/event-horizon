import { useEffect, useRef } from 'react'
import './CursorLens.css'

/**
 * A very subtle lens rim that follows the cursor, hinting at the local
 * gravitational well the mouse creates in the 3D field. Pure DOM, pointer-
 * events none; fades out quickly when the cursor stops so it never reads as UI.
 */
export function CursorLens() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let hideTimer = 0
    const onMove = (e: PointerEvent) => {
      el.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`
      el.style.opacity = '0.5'
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => {
        el.style.opacity = '0'
      }, 140)
    }
    window.addEventListener('pointermove', onMove)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.clearTimeout(hideTimer)
    }
  }, [])

  return <div ref={ref} className="cursor-lens" aria-hidden="true" />
}
