import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Telemetry } from '../telemetry'
import { makeSoftDot } from '../three/textures'

// Real-space particles dominate; code glyphs are a small minority elsewhere.
const STAR_COUNT = 1300 // far fine stars (points)
const DUST_COUNT = 2800 // faint mid dust — fills the void with density (points)
const FORE_COUNT = 520 // near volumetric soft particles (instanced) — the rush
const STREAK_COUNT = 220 // elongating light streaks (instanced)
const DEPTH = 640
const BEND = 0.72 // how far the field warps inward near the hole

// Local cursor lens — a small well that nudges nearby particles (foreground +
// mid dust). It never changes global speed or rotation.
const F_LENS_R = 30
const F_LENS_PLANE = 120
const F_LENS_BASE = 0.55
const F_LENS_VEL = 1.6
const F_LENS_MAX = 0.9
const F_LENS_CURL = 0.7
const F_LENS_PUSH = 0.45

// A single spiral "arm": band particles cluster along angle = base + wind·radius
// so ~20% of the field reads as a galactic band rather than a uniform tunnel.
const ARM_BASE = 0.7
const ARM_WIND = 0.02

function seedAngleRadius(band: boolean, maxR: number): [number, number] {
  if (band) {
    const rad = 10 + Math.random() * maxR
    const arm = ARM_BASE + rad * ARM_WIND + (Math.random() * 2 - 1) * 0.22
    return [arm, rad]
  }
  return [Math.random() * Math.PI * 2, 8 + Math.random() * maxR]
}

// ---- Milky band: a visible, tilted galactic ribbon --------------------------
const MILKY_COUNT = 850
const BAND_TILT = 0.7 // diagonal across the view
const BAND_LEN = 260 // ribbon length
const BAND_WIDTH = 20 // ribbon thickness (kept narrow)
const BAND_ARC = 42 // gentle curvature so it reads as a 3D arm
const BAND_OFFX = 34 // offset off-axis so it sweeps past to the side
const BAND_OFFY = -20

interface BandLayer {
  positions: Float32Array
  base: Float32Array // count*2 transverse (x,y) base positions
  z: Float32Array
  speed: Float32Array
}

function seedBand(base: Float32Array, i: number, ct: number, st: number) {
  const u = Math.random() * 2 - 1
  const across = (Math.random() * 2 - 1) * Math.random() // concentrate → thin
  const along = u * BAND_LEN
  const acr = across * BAND_WIDTH
  const bx = along * ct - acr * st
  const by = along * st + acr * ct + Math.sin((u * 0.5 + 0.5) * Math.PI) * BAND_ARC
  base[i * 2] = bx + BAND_OFFX
  base[i * 2 + 1] = by + BAND_OFFY
}

function makeBand(count: number): BandLayer {
  const positions = new Float32Array(count * 3)
  const base = new Float32Array(count * 2)
  const z = new Float32Array(count)
  const speed = new Float32Array(count)
  const ct = Math.cos(BAND_TILT)
  const st = Math.sin(BAND_TILT)
  for (let i = 0; i < count; i++) {
    seedBand(base, i, ct, st)
    z[i] = -Math.random() * DEPTH
    speed[i] = 10 * (0.6 + Math.random() * 0.8)
  }
  return { positions, base, z, speed }
}

// Foreground is restricted to faint blue-white (no grey, no cyan flood).
const FORE_TINTS = [
  [0.85, 0.92, 1.0],
  [0.72, 0.85, 1.0],
  [0.9, 0.95, 1.0],
  [0.66, 0.88, 0.98],
]

/** A tight spark: small bright core, fast falloff → reads as dust, not a bubble. */
function makeSpark(size = 64): THREE.CanvasTexture {
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
  g.addColorStop(0.18, 'rgba(255,255,255,0.5)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.1)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

interface PointLayer {
  positions: Float32Array
  angle: Float32Array
  radius: Float32Array
  z: Float32Array
  speed: Float32Array
  omega: Float32Array // orbital angular drift → spiral, not radial-only motion
  isBand: Uint8Array // 1 = clustered on the galactic band
  maxR: number
}

function makeLayer(
  count: number,
  speedBase: number,
  maxR: number,
  omegaScale: number,
  bandFraction: number,
): PointLayer {
  const positions = new Float32Array(count * 3)
  const angle = new Float32Array(count)
  const radius = new Float32Array(count)
  const z = new Float32Array(count)
  const speed = new Float32Array(count)
  const omega = new Float32Array(count)
  const isBand = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    const band = Math.random() < bandFraction
    isBand[i] = band ? 1 : 0
    const [ang, rad] = seedAngleRadius(band, maxR)
    angle[i] = ang
    radius[i] = rad
    z[i] = -Math.random() * DEPTH
    speed[i] = speedBase * (0.5 + Math.random() * 1.0)
    // Band particles hold their shape (no orbit); the rest swirl coherently.
    omega[i] = band ? 0 : omegaScale * (0.5 + Math.random())
  }
  return { positions, angle, radius, z, speed, omega, isBand, maxR }
}

interface StarfieldProps {
  telemetry: React.RefObject<Telemetry>
}

/**
 * Layered deep-space backdrop with real depth. The foreground layer is small,
 * fast dust sparks and thin light streaks (not blobs) that drift past the
 * camera: depth drives their opacity, speed and streak length while the width
 * stays tiny and capped — faint blue-white, still bending toward the hole so
 * the black hole stays the visual centre.
 */
export function Starfield({ telemetry }: StarfieldProps) {
  const camera = useThree((s) => s.camera)
  const starsRef = useRef<THREE.Points>(null)
  const dustRef = useRef<THREE.Points>(null)
  const foreRef = useRef<THREE.InstancedMesh>(null)
  const streaksRef = useRef<THREE.InstancedMesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const color = useMemo(() => new THREE.Color(), [])
  const softDot = useMemo(() => makeSoftDot(64), [])
  const spark = useMemo(() => makeSpark(64), [])
  const syncGlow = useRef(0)
  // Local cursor-lens state (foreground only).
  const mouseNdc = useMemo(() => new THREE.Vector2(0, 0), [])
  const worldMouse = useMemo(() => new THREE.Vector3(), [])
  const rayDir = useMemo(() => new THREE.Vector3(), [])
  const mouse = useMemo(() => ({ velocity: 0, influence: 0, lastT: 0 }), [])
  // Per-frame shared state: cursor well + the eased sync-calm factor.
  const lensState = useMemo(() => ({ strength: 0, planeZ: 0, calm: 1 }), [])
  const milkyRef = useRef<THREE.Points>(null)

  // Deeper stars drift slowest; nearer layers orbit a touch faster. The visible
  // galactic band is a dedicated layer (below), so these stay uniform.
  const stars = useMemo(() => makeLayer(STAR_COUNT, 12, 220, 0.02, 0), [])
  const dust = useMemo(() => makeLayer(DUST_COUNT, 8, 240, 0.05, 0), [])
  const fore = useMemo(() => makeLayer(FORE_COUNT, 40, 150, 0.06, 0), [])
  const streaks = useMemo(() => makeLayer(STREAK_COUNT, 16, 200, 0.05, 0), [])
  const milky = useMemo(() => makeBand(MILKY_COUNT), [])

  // Per-instance foreground traits. Mostly thin streaks + small dust; the width
  // stays tiny and hard-capped so nothing reads as a sphere/blob.
  const foreTraits = useMemo(() => {
    const isStreak = new Uint8Array(FORE_COUNT)
    const width = new Float32Array(FORE_COUNT)
    const baseLen = new Float32Array(FORE_COUNT)
    const phase = new Float32Array(FORE_COUNT)
    const tint = new Float32Array(FORE_COUNT * 3)
    for (let i = 0; i < FORE_COUNT; i++) {
      const streaky = Math.random() < 0.62 // majority are thin streaks
      isStreak[i] = streaky ? 1 : 0
      width[i] = streaky ? 0.09 + Math.random() * 0.12 : 0.2 + Math.random() * 0.24
      baseLen[i] = streaky ? 1.6 + Math.random() * 2.0 : 1.0
      phase[i] = Math.random() * Math.PI * 2
      const c = FORE_TINTS[(Math.random() * FORE_TINTS.length) | 0]
      tint[i * 3] = c[0]
      tint[i * 3 + 1] = c[1]
      tint[i * 3 + 2] = c[2]
    }
    return { isStreak, width, baseLen, phase, tint }
  }, [])

  useEffect(() => {
    return () => {
      softDot.dispose()
      spark.dispose()
    }
  }, [softDot, spark])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1
      const ny = -(e.clientY / window.innerHeight) * 2 + 1
      const now = performance.now()
      const dt = Math.max((now - mouse.lastT) / 1000, 1 / 240)
      const dx = nx - mouseNdc.x
      const dy = ny - mouseNdc.y
      const speed = Math.sqrt(dx * dx + dy * dy) / dt
      mouse.velocity = Math.min(mouse.velocity * 0.6 + speed * 0.4, 2.2)
      mouse.influence = 1
      mouse.lastT = now
      mouseNdc.set(nx, ny)
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [mouse, mouseNdc])

  const updatePoints = (
    layer: PointLayer,
    points: THREE.Points | null,
    camZ: number,
    d: number,
    a: number,
    fi: number,
    pulse: number,
    delta: number,
    speedMul: number,
    applyLens: boolean,
  ) => {
    if (!points) return
    const attr = points.geometry.attributes.position as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    const lensR2 = F_LENS_R * F_LENS_R
    for (let i = 0; i < layer.z.length; i++) {
      // Orbital drift (spirals in) — grows late, with a jolt at each stage pulse.
      layer.angle[i] += layer.omega[i] * (1 + fi * 1.6 + d * 0.8 + pulse * 3) * delta
      layer.z[i] += layer.speed[i] * (1 + d * speedMul + a * 8) * delta
      if (layer.z[i] > camZ + 6) {
        layer.z[i] -= DEPTH
        const [na, nr] = seedAngleRadius(layer.isBand[i] === 1, layer.maxR)
        layer.angle[i] = na
        layer.radius[i] = nr
      }
      const ahead = THREE.MathUtils.clamp((camZ - layer.z[i]) / DEPTH, 0, 1)
      // Center attraction: funnel inward with distortion; absorb yanks harder;
      // band particles curve toward the hole more as the fall deepens.
      let r = layer.radius[i] * (1 - BEND * d * ahead) * (1 - 0.9 * a)
      if (layer.isBand[i] === 1) r *= 1 - 0.25 * fi
      // Spiral swirl: winding increases as particles near the centre (eased by
      // a sync lock), so the inflow spirals rather than falling straight in.
      const nearC = 1 - THREE.MathUtils.clamp(r / 40, 0, 1)
      const ang = layer.angle[i] + (d + fi * 0.5) * nearC * 1.3 * lensState.calm
      let px = Math.cos(ang) * r
      // Slight vertical curvature so the field reads as a curved surface.
      let py =
        Math.sin(ang) * r + Math.sin(layer.z[i] * 0.012 + ang) * r * 0.05 * (0.4 + fi)

      // Optional local cursor lens (mid dust): a small gravitational well.
      if (applyLens && lensState.strength > 0.001) {
        const dx = px - worldMouse.x
        const dy = py - worldMouse.y
        const dist2 = dx * dx + dy * dy
        if (dist2 < lensR2) {
          const infl =
            (1 - Math.sqrt(dist2) / F_LENS_R) *
            THREE.MathUtils.clamp(1 - Math.abs(layer.z[i] - lensState.planeZ) / 200, 0, 1) *
            lensState.strength
          const cs = Math.cos(infl * F_LENS_CURL)
          const sn = Math.sin(infl * F_LENS_CURL)
          const mag = 1 + infl * F_LENS_PUSH
          px = worldMouse.x + (dx * cs - dy * sn) * mag
          py = worldMouse.y + (dx * sn + dy * cs) * mag
        }
      }
      arr[i * 3] = px
      arr[i * 3 + 1] = py
      arr[i * 3 + 2] = layer.z[i]
    }
    attr.needsUpdate = true
  }

  useFrame((_, delta) => {
    const tel = telemetry.current
    if (tel.simulationPaused) return // frozen while the music is paused
    const d = tel.distortionFactor
    const a = tel.absorb // 0→1 during the singularity
    const fi = tel.fallIntensity // eased 0→1 over the fall
    const pulse = tel.spacetimePulse // brief surge at each 30s boundary
    const calm = 1 - tel.syncEase * 0.4 // a sync lock eases the swirl/lens
    const camZ = camera.position.z
    const time = tel.simTime

    // Cursor well (relaxes fast when the mouse stops); shared by dust + foreground.
    mouse.velocity *= 0.85
    mouse.influence *= 0.86
    const planeZ = camZ - F_LENS_PLANE
    worldMouse.set(mouseNdc.x, mouseNdc.y, 0.5).unproject(camera)
    rayDir.copy(worldMouse).sub(camera.position).normalize()
    const tHit = rayDir.z !== 0 ? (planeZ - camera.position.z) / rayDir.z : 0
    worldMouse.copy(camera.position).addScaledVector(rayDir, tHit)
    const lensStrength =
      Math.min(F_LENS_BASE * mouse.influence * (1 + mouse.velocity * F_LENS_VEL), F_LENS_MAX) *
      calm
    const lensR2 = F_LENS_R * F_LENS_R
    lensState.strength = lensStrength
    lensState.planeZ = planeZ
    lensState.calm = calm

    // Milky band ribbon — streams past, curves toward the hole late in the fall.
    const bmesh = milkyRef.current
    if (bmesh) {
      const attr = bmesh.geometry.attributes.position as THREE.BufferAttribute
      const arr = attr.array as Float32Array
      const ct = Math.cos(BAND_TILT)
      const st = Math.sin(BAND_TILT)
      for (let i = 0; i < MILKY_COUNT; i++) {
        milky.z[i] += milky.speed[i] * (1 + d * 2 + a * 8) * delta
        if (milky.z[i] > camZ + 6) {
          milky.z[i] -= DEPTH
          seedBand(milky.base, i, ct, st)
        }
        const ahead = THREE.MathUtils.clamp((camZ - milky.z[i]) / DEPTH, 0, 1)
        const pull = THREE.MathUtils.clamp((BEND * d + fi * 0.35) * ahead, 0, 0.9)
        const bx = milky.base[i * 2] * (1 - pull)
        const by = milky.base[i * 2 + 1] * (1 - pull)
        const rr = Math.hypot(bx, by)
        const nearC = 1 - THREE.MathUtils.clamp(rr / 45, 0, 1)
        const sw = (d + fi * 0.5) * nearC * 1.5 * calm
        const cs = Math.cos(sw)
        const sn = Math.sin(sw)
        arr[i * 3] = bx * cs - by * sn
        arr[i * 3 + 1] = bx * sn + by * cs
        arr[i * 3 + 2] = milky.z[i]
      }
      attr.needsUpdate = true
    }

    updatePoints(stars, starsRef.current, camZ, d, a, fi, pulse, delta, 2.2, false)
    updatePoints(dust, dustRef.current, camZ, d, a, fi, pulse, delta, 2.0, true)

    // Sync bloom: brighten the starlight toward cyan when locked.
    const syncTarget = telemetry.current.isSynced ? 1 : 0
    syncGlow.current += (syncTarget - syncGlow.current) * 0.08
    const sg = syncGlow.current
    const starMat = starsRef.current?.material as THREE.PointsMaterial | undefined
    if (starMat) starMat.opacity = 0.52 + sg * 0.35
    const streakMat = streaksRef.current?.material as
      | THREE.MeshBasicMaterial
      | undefined
    if (streakMat) streakMat.opacity = 0.26 + sg * 0.3

    // Foreground: small fast dust + thin streaks. Depth drives everything, but
    // the width stays tiny and capped so nothing looks like a sphere/blob.
    const fmesh = foreRef.current
    if (fmesh) {
      const jp = telemetry.current.journeyProgress
      const { isStreak, width, baseLen, phase, tint } = foreTraits
      for (let i = 0; i < FORE_COUNT; i++) {
        fore.angle[i] += fore.omega[i] * (1 + fi * 1.6 + d * 0.8 + pulse * 3) * delta
        fore.z[i] += fore.speed[i] * (1 + d * 3.4 + a * 8) * delta
        if (fore.z[i] > camZ + 6) {
          fore.z[i] -= DEPTH
          fore.angle[i] = Math.random() * Math.PI * 2
          fore.radius[i] = 8 + Math.random() * fore.maxR
        }
        const ahead = THREE.MathUtils.clamp((camZ - fore.z[i]) / DEPTH, 0, 1)
        const near = 1 - ahead
        const r = fore.radius[i] * (1 - BEND * d * ahead) * (1 - 0.9 * a)
        const ang = fore.angle[i]

        // Width: only a slight parallax growth, hard-capped very small.
        const w = Math.min(width[i] * (0.75 + near * 0.5), 0.5)
        // Length: dust round (≈w); streaks grow with journey/intensity/absorb.
        const streakLen =
          baseLen[i] * (0.8 + near * 0.5) * (1 + jp * 0.7 + d * ahead * 4.5 + fi * ahead * 1.4)
        const len = (isStreak[i] ? streakLen : w) + a * a * 22

        // Local cursor lens: nudge foreground particles around the well.
        let fx = Math.cos(ang) * r
        let fy = Math.sin(ang) * r
        if (lensStrength > 0.001) {
          const dx = fx - worldMouse.x
          const dy = fy - worldMouse.y
          const dist2 = dx * dx + dy * dy
          if (dist2 < lensR2) {
            const infl =
              (1 - Math.sqrt(dist2) / F_LENS_R) *
              THREE.MathUtils.clamp(1 - Math.abs(fore.z[i] - planeZ) / 200, 0, 1) *
              lensStrength
            const cs = Math.cos(infl * F_LENS_CURL)
            const sn = Math.sin(infl * F_LENS_CURL)
            const mag = 1 + infl * F_LENS_PUSH
            fx = worldMouse.x + (dx * cs - dy * sn) * mag
            fy = worldMouse.y + (dx * sn + dy * cs) * mag
          }
        }
        dummy.position.set(fx, fy, fore.z[i])
        dummy.rotation.set(0, 0, ang + Math.PI / 2)
        dummy.scale.set(w, len, 1)
        dummy.updateMatrix()
        fmesh.setMatrixAt(i, dummy.matrix)

        // Opacity as a depth bell: fades in from afar, fades out at the camera;
        // a faint flicker grows a little with distortion. Kept dim overall.
        const fadeIn = 1 - THREE.MathUtils.smoothstep(ahead, 0.72, 1.0)
        const fadeOut = THREE.MathUtils.smoothstep(ahead, 0.0, 0.07)
        const flicker = 1 - (0.1 + d * 0.2) * (0.5 + 0.5 * Math.sin(time * 3 + phase[i]))
        // Particles pulled to the centre brighten just before being swallowed.
        const nearHole = 1 - THREE.MathUtils.clamp(r / 28, 0, 1)
        const bright = 0.3 * fadeIn * fadeOut * flicker * (1 + nearHole * (0.4 + d) * 1.4)
        color.setRGB(
          tint[i * 3] * bright,
          tint[i * 3 + 1] * bright,
          tint[i * 3 + 2] * bright,
        )
        fmesh.setColorAt(i, color)
      }
      fmesh.instanceMatrix.needsUpdate = true
      if (fmesh.instanceColor) fmesh.instanceColor.needsUpdate = true
    }

    // Light streaks: stretch longer and bend inward near the hole.
    const smesh = streaksRef.current
    if (smesh) {
      for (let i = 0; i < STREAK_COUNT; i++) {
        streaks.angle[i] += streaks.omega[i] * (1 + fi * 1.6 + d * 0.8 + pulse * 3) * delta
        streaks.z[i] += streaks.speed[i] * (1 + d * 2.8 + a * 8) * delta
        if (streaks.z[i] > camZ + 6) {
          streaks.z[i] -= DEPTH
          streaks.angle[i] = Math.random() * Math.PI * 2
          streaks.radius[i] = 8 + Math.random() * streaks.maxR
        }
        const ahead = THREE.MathUtils.clamp((camZ - streaks.z[i]) / DEPTH, 0, 1)
        const r = streaks.radius[i] * (1 - BEND * d * ahead) * (1 - 0.9 * a)
        const ang = streaks.angle[i]
        const len = 3 + d * ahead * 44 + fi * ahead * 20 + a * a * 60
        dummy.position.set(Math.cos(ang) * r, Math.sin(ang) * r, streaks.z[i])
        dummy.rotation.set(0, 0, ang + Math.PI / 2)
        dummy.scale.set(0.3, len, 1)
        dummy.updateMatrix()
        smesh.setMatrixAt(i, dummy.matrix)
      }
      smesh.instanceMatrix.needsUpdate = true
    }
  })

  return (
    <>
      {/* Galactic band ribbon — a bit brighter/denser but opacity-limited. */}
      <points ref={milkyRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[milky.positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          map={softDot}
          color="#cdd8ee"
          size={1.3}
          sizeAttenuation
          transparent
          opacity={0.5}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      <points ref={starsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[stars.positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          map={softDot}
          color="#b6cde8"
          size={1.0}
          sizeAttenuation
          transparent
          opacity={0.52}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      <points ref={dustRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[dust.positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          map={softDot}
          color="#7488a4"
          size={0.42}
          sizeAttenuation
          transparent
          opacity={0.2}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      <instancedMesh
        ref={foreRef}
        args={[undefined, undefined, FORE_COUNT]}
        frustumCulled={false}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          map={spark}
          transparent
          opacity={1}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </instancedMesh>

      <instancedMesh
        ref={streaksRef}
        args={[undefined, undefined, STREAK_COUNT]}
        frustumCulled={false}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          map={softDot}
          color="#cfe0ff"
          transparent
          opacity={0.26}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </instancedMesh>
    </>
  )
}
