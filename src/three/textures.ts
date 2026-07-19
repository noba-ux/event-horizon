import * as THREE from 'three'

/**
 * Soft round sprite (white, radial alpha falloff). Tint it via a material's
 * `color`. Used for star points, dust billboards, light streaks and the sync
 * marker so nothing renders as a hard square.
 */
export function makeSoftDot(size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  )
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.5)')
  g.addColorStop(0.7, 'rgba(255,255,255,0.12)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * Tiny crisp star point: a near-solid white core with only a 1–2px
 * anti-aliased rim (no wide gradient halo). Rendered at a small point size it
 * reads as a sharp pinpoint of light rather than a soft blob, so dense fields
 * look like a real photographed starfield instead of enlarged dot-code.
 */
export function makeSharpStar(size = 32): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  )
  // Mostly-solid core → knife-thin falloff only at the very edge for AA.
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.95)')
  g.addColorStop(0.72, 'rgba(255,255,255,0.32)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
