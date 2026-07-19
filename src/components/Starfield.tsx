import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Telemetry } from '../telemetry'
import { makeSharpStar } from '../three/textures'

// The field is now ONLY fine point-stars — no speed-lines, streaks or blobs.
// Motion is conveyed by the inflow spiral and, past the 60s mark, by subtle
// 1px motion-blur trails that follow each star's actual path into the hole.
const STAR_COUNT = 1300 // far fine stars (points)
const DUST_COUNT = 2800 // faint mid dust — fills the void with density (points)
const DEPTH = 640
const BEND = 0.72 // how far the field warps inward near the hole
// Gravitational inflow: each particle's own orbit radius decays toward the
// centre, faster as the fall deepens (fallIntensity) and faster the closer it
// already is — so the whole field spirals down the well, not just streams past.
const INFLOW = 7 // radius units/sec drained inward at full fall
const INFLOW_RESPAWN = 3 // consumed at this radius → respawn far out

// Motion-blur trails switch on when only ~60s of the ~120s fall remain
// (fallProgress ≥ 0.5) and lengthen organically toward the end.
const TRAIL_START = 0.5 // fallProgress at which trails begin to appear
const TRAIL_RAMP = 0.35 // ramps to full over the next 35% of the fall
const TRAIL_JUMP2 = 900 // per-frame jump² above this = a respawn → suppress trail

// Local cursor lens — a small well that nudges nearby mid-dust particles.
// It never changes global speed or rotation.
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

interface PointLayer {
  positions: Float32Array
  angle: Float32Array
  radius: Float32Array
  z: Float32Array
  speed: Float32Array
  omega: Float32Array // orbital angular drift → spiral, not radial-only motion
  swirlBias: Float32Array // per-star random swirl weight → irregular vortex
  inflowBias: Float32Array // per-star random suction weight → uneven inflow
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
  const swirlBias = new Float32Array(count)
  const inflowBias = new Float32Array(count)
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
    // Random per-star weights so the final vortex is uneven — each star whirls
    // in at its own rate/radius instead of one uniform, fake-looking spiral.
    swirlBias[i] = 0.5 + Math.random() * 1.6
    inflowBias[i] = 0.5 + Math.random() * 1.7
  }
  return { positions, angle, radius, z, speed, omega, swirlBias, inflowBias, isBand, maxR }
}

// Motion-blur trail buffers for a point layer: a LineSegments where each star
// contributes one segment (head = current position, tail = extrapolated back
// along its recent velocity). Vertex colours fade the tail to nothing.
interface TrailData {
  positions: Float32Array // count*2 * 3
  colors: Float32Array // count*2 * 3
  prev: Float32Array // count * 3 — previous-frame positions ("포지션 부모 값")
  tint: [number, number, number]
  inited: boolean
}

function makeTrail(count: number, tint: [number, number, number]): TrailData {
  return {
    positions: new Float32Array(count * 6),
    colors: new Float32Array(count * 6),
    prev: new Float32Array(count * 3),
    tint,
    inited: false,
  }
}

// Stellar spectrum for per-particle colour. Kept pastel / high-value / low-sat
// so nothing reads as a primary — mostly clean white-cream, a warm minority and
// a cool minority, mixed randomly at spawn. (Purely a colour buffer; it does not
// touch any motion/streaming logic.)
function fillStarColors(count: number): Float32Array {
  const arr = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const roll = Math.random()
    let r: number, g: number, b: number
    if (roll < 0.7) {
      // ~70% clean white → the faintest warm/cool cream drift.
      const w = 0.9 + Math.random() * 0.1
      r = w
      g = w * (0.97 + Math.random() * 0.03)
      b = w * (0.95 + Math.random() * 0.05)
    } else if (roll < 0.85) {
      // ~15% warm: soft, pastel amber/gold (never a saturated orange).
      r = 1.0
      g = 0.85 + Math.random() * 0.07
      b = 0.68 + Math.random() * 0.12
    } else {
      // ~15% cool: soft, pastel cyan / light blue.
      r = 0.7 + Math.random() * 0.12
      g = 0.87 + Math.random() * 0.08
      b = 1.0
    }
    arr[i * 3] = r
    arr[i * 3 + 1] = g
    arr[i * 3 + 2] = b
  }
  return arr
}

interface StarfieldProps {
  telemetry: React.RefObject<Telemetry>
}

/**
 * Deep-space backdrop built entirely from fine point-stars (no streaks/blobs).
 * The field spirals inward under gravitational inflow; once the fall passes its
 * midpoint each star grows a subtle 1px motion-blur trail that traces its curved
 * path toward the vanishing point, lengthening as the end approaches.
 */
export function Starfield({ telemetry }: StarfieldProps) {
  const camera = useThree((s) => s.camera)
  const starsRef = useRef<THREE.Points>(null)
  const dustRef = useRef<THREE.Points>(null)
  const starTrailRef = useRef<THREE.LineSegments>(null)
  const dustTrailRef = useRef<THREE.LineSegments>(null)
  const milkyRef = useRef<THREE.Points>(null)
  const sharpStar = useMemo(() => makeSharpStar(32), [])
  const syncGlow = useRef(0)
  // Local cursor-lens state (mid dust only).
  const mouseNdc = useMemo(() => new THREE.Vector2(0, 0), [])
  const worldMouse = useMemo(() => new THREE.Vector3(), [])
  const rayDir = useMemo(() => new THREE.Vector3(), [])
  const mouse = useMemo(() => ({ velocity: 0, influence: 0, lastT: 0 }), [])
  // Per-frame shared state: cursor well + the eased sync-calm factor.
  const lensState = useMemo(() => ({ strength: 0, planeZ: 0, calm: 1 }), [])

  const stars = useMemo(() => makeLayer(STAR_COUNT, 12, 220, 0.02, 0), [])
  const dust = useMemo(() => makeLayer(DUST_COUNT, 8, 240, 0.05, 0), [])
  const milky = useMemo(() => makeBand(MILKY_COUNT), [])

  const starTrail = useMemo(() => makeTrail(STAR_COUNT, [0.9, 0.94, 1.0]), [])
  const dustTrail = useMemo(() => makeTrail(DUST_COUNT, [0.48, 0.58, 0.76]), [])

  // Per-particle stellar colours (spectrum). Static buffers — no motion impact.
  const starColors = useMemo(() => fillStarColors(STAR_COUNT), [])
  const milkyColors = useMemo(() => fillStarColors(MILKY_COUNT), [])

  useEffect(() => {
    return () => sharpStar.dispose()
  }, [sharpStar])

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
    endRush: number,
    trail: TrailData | null,
    line: THREE.LineSegments | null,
    trailSeconds: number,
    trailBright: number,
  ) => {
    if (!points) return
    const attr = points.geometry.attributes.position as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    const lensR2 = F_LENS_R * F_LENS_R
    const invDelta = delta > 0 ? 1 / delta : 0
    for (let i = 0; i < layer.z.length; i++) {
      // Orbital drift (spirals in) — grows late, with a jolt at each stage pulse
      // and an explosive whirl in the final convergence. The endRush/absorb whirl
      // is weighted per-star (swirlBias) so the vortex is uneven, not uniform.
      const sB = layer.swirlBias[i]
      layer.angle[i] +=
        layer.omega[i] *
        (1 + fi * 1.6 + d * 0.8 + pulse * 3 + (endRush * 8 + a * 12) * sB) *
        delta
      layer.z[i] += layer.speed[i] * (1 + d * speedMul + a * 8 + endRush * 4) * delta

      // Gravitational inflow: the star's own orbit radius decays toward the
      // centre (drained faster the deeper the fall and the closer it already is),
      // and ferociously in the final ~15s — weighted per-star (inflowBias) so
      // each is sucked in at its own rate for a chaotic cosmic-storm feel.
      const closeness = 1 - THREE.MathUtils.clamp(layer.radius[i] / layer.maxR, 0, 1)
      layer.radius[i] -=
        INFLOW *
        (fi + (a * 1.5 + endRush * 6) * layer.inflowBias[i]) *
        (0.35 + closeness * 2.4) *
        delta

      // Recycle: swept behind the camera OR fully consumed by the hole.
      if (layer.z[i] > camZ + 6 || layer.radius[i] < INFLOW_RESPAWN) {
        if (layer.z[i] > camZ + 6) layer.z[i] -= DEPTH
        const [na, nr] = seedAngleRadius(layer.isBand[i] === 1, layer.maxR)
        layer.angle[i] = na
        layer.radius[i] = nr
      }
      const ahead = THREE.MathUtils.clamp((camZ - layer.z[i]) / DEPTH, 0, 1)
      // Center attraction: funnel inward with distortion; absorb yanks harder.
      const r = layer.radius[i] * (1 - BEND * d * ahead) * (1 - 0.9 * a)
      // Spiral swirl: winding increases sharply as particles near the centre
      // (eased by a sync lock), so the inflow whirls into a vortex rather than
      // falling straight in — the closer to the hole, the tighter the wind.
      const nearC = 1 - THREE.MathUtils.clamp(r / 40, 0, 1)
      const ang =
        layer.angle[i] +
        (d + fi * 0.8 + (endRush * 3 + a * 4) * sB) *
          (nearC * nearC * 2.4 + 0.2) *
          lensState.calm
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
      const pz = layer.z[i]
      arr[i * 3] = px
      arr[i * 3 + 1] = py
      arr[i * 3 + 2] = pz

      // Motion-blur trail: head at the current position, tail extrapolated back
      // along the star's recent velocity (remembered from the previous frame).
      if (trail) {
        const pr = trail.prev
        const h = i * 6
        const t = h + 3
        if (!trail.inited) {
          pr[i * 3] = px
          pr[i * 3 + 1] = py
          pr[i * 3 + 2] = pz
        }
        const jx = px - pr[i * 3]
        const jy = py - pr[i * 3 + 1]
        const jz = pz - pr[i * 3 + 2]
        // Per-second velocity → frame-rate-independent trail length.
        const vx = jx * invDelta
        const vy = jy * invDelta
        const vz = jz * invDelta
        // A respawn teleports the point; suppress the trail that frame.
        const ts = jx * jx + jy * jy + jz * jz > TRAIL_JUMP2 ? 0 : trailSeconds
        const tp = trail.positions
        const tc = trail.colors
        tp[h] = px
        tp[h + 1] = py
        tp[h + 2] = pz
        tp[t] = px - vx * ts
        tp[t + 1] = py - vy * ts
        tp[t + 2] = pz - vz * ts
        const b = ts > 0 ? trailBright : 0
        tc[h] = trail.tint[0] * b
        tc[h + 1] = trail.tint[1] * b
        tc[h + 2] = trail.tint[2] * b
        tc[t] = 0
        tc[t + 1] = 0
        tc[t + 2] = 0
        pr[i * 3] = px
        pr[i * 3 + 1] = py
        pr[i * 3 + 2] = pz
      }
    }
    attr.needsUpdate = true
    if (trail && line) {
      ;(line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
      ;(line.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true
      trail.inited = true
    }
  }

  useFrame((_, delta) => {
    const tel = telemetry.current
    if (tel.simulationPaused) return // frozen while the music is paused
    const d = tel.distortionFactor
    const a = tel.absorb // 0→1 during the singularity
    const fi = tel.fallIntensity // eased 0→1 over the fall
    const fp = tel.fallProgress // linear 0→1 over the fall
    const pulse = tel.spacetimePulse // brief surge at each 30s boundary
    const calm = 1 - tel.syncEase * 0.4 // a sync lock eases the swirl/lens
    const camZ = camera.position.z

    // Cursor well (relaxes fast when the mouse stops); used by the mid dust.
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
    lensState.strength = lensStrength
    lensState.planeZ = planeZ
    lensState.calm = calm

    // endRush: 0 until the final ~15s (inverse of the horizon dissolve), then
    // ramps to 1 as the sphere melts away — the trigger for the explosive
    // convergence of all starlight into the vanishing point.
    const endRush = 1 - tel.horizonFade

    // Trail envelope: off until the 60s mark, then ramps in and lengthens toward
    // the end, exploding in the final convergence — organic 1px suction tails.
    const trailAmt = THREE.MathUtils.clamp((fp - TRAIL_START) / TRAIL_RAMP, 0, 1)
    const trailSeconds = trailAmt * (0.05 + fp * 0.12 + a * 0.25 + endRush * 0.4)
    const trailBright = trailAmt * (0.7 + endRush * 0.4)

    // Milky band ribbon — streams past, curves toward the hole late in the fall.
    const bmesh = milkyRef.current
    if (bmesh) {
      const attr = bmesh.geometry.attributes.position as THREE.BufferAttribute
      const arr = attr.array as Float32Array
      const ct = Math.cos(BAND_TILT)
      const st = Math.sin(BAND_TILT)
      for (let i = 0; i < MILKY_COUNT; i++) {
        milky.z[i] += milky.speed[i] * (1 + d * 2 + a * 8 + endRush * 4) * delta
        if (milky.z[i] > camZ + 6) {
          milky.z[i] -= DEPTH
          seedBand(milky.base, i, ct, st)
        }
        const ahead = THREE.MathUtils.clamp((camZ - milky.z[i]) / DEPTH, 0, 1)
        const pull = THREE.MathUtils.clamp((BEND * d + fi * 0.35 + endRush * 0.8) * ahead, 0, 0.95)
        const bx = milky.base[i * 2] * (1 - pull)
        const by = milky.base[i * 2 + 1] * (1 - pull)
        const rr = Math.hypot(bx, by)
        const nearC = 1 - THREE.MathUtils.clamp(rr / 45, 0, 1)
        // Wind the ribbon tightly around the horizon as it passes behind — the
        // band curls into the Einstein ring, then whirls violently into the
        // vanishing point during the final convergence.
        const sw = (d + fi * 0.8 + endRush * 3 + a * 4) * (nearC * nearC * 2.2 + 0.2) * calm
        const cs = Math.cos(sw)
        const sn = Math.sin(sw)
        arr[i * 3] = bx * cs - by * sn
        arr[i * 3 + 1] = bx * sn + by * cs
        arr[i * 3 + 2] = milky.z[i]
      }
      attr.needsUpdate = true
    }

    updatePoints(
      stars, starsRef.current, camZ, d, a, fi, pulse, delta, 2.2, false, endRush,
      starTrail, starTrailRef.current, trailSeconds, trailBright,
    )
    updatePoints(
      dust, dustRef.current, camZ, d, a, fi, pulse, delta, 2.0, true, endRush,
      dustTrail, dustTrailRef.current, trailSeconds, trailBright * 0.7,
    )

    // Sync bloom: brighten the starlight when locked.
    const syncTarget = tel.isSynced ? 1 : 0
    syncGlow.current += (syncTarget - syncGlow.current) * 0.08
    const sg = syncGlow.current
    const starMat = starsRef.current?.material as THREE.PointsMaterial | undefined
    if (starMat) starMat.opacity = 0.78 + sg * 0.22
  })

  return (
    <>
      {/* Galactic band ribbon — fine points, opacity-limited. */}
      <points ref={milkyRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[milky.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[milkyColors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          map={sharpStar}
          vertexColors
          color="#ffffff"
          size={1.6}
          sizeAttenuation={false}
          transparent
          opacity={0.72}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {/* Motion-blur trails (1px lines) — under the point heads. */}
      <lineSegments ref={dustTrailRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[dustTrail.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[dustTrail.colors, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={0.5}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>

      <lineSegments ref={starTrailRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[starTrail.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[starTrail.colors, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={0.85}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>

      <points ref={starsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[stars.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[starColors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          map={sharpStar}
          vertexColors
          color="#ffffff"
          size={1.8}
          sizeAttenuation={false}
          transparent
          opacity={0.8}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      <points ref={dustRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[dust.positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          map={sharpStar}
          color="#8fa0bd"
          size={1.1}
          sizeAttenuation={false}
          transparent
          opacity={0.32}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </>
  )
}
