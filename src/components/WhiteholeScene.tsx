import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Telemetry } from '../telemetry'

const SP = 7 // spacing between corridor frames
const RINGS = 62 // number of frames
const CORRIDOR_DEPTH = SP * RINGS
const HALF = 22 // square half-size
const TWIST = 0.13 // per-frame rotation → a folded, helical square tunnel
const RUSH = 2.6 // seconds of accelerating dash before it settles
const START_Z = 18

const DARK = new THREE.Color('#05070c')
const OFF_WHITE = new THREE.Color('#e9eef4')

/** A twisting corridor of square line-frames + diagonal folds (no rings). */
function buildCorridor(): THREE.BufferGeometry {
  const pos: number[] = []
  const corner = (k: number, tw: number, z: number): [number, number, number] => {
    const base = [
      [-HALF, -HALF],
      [HALF, -HALF],
      [HALF, HALF],
      [-HALF, HALF],
    ][k]
    const x = base[0] * Math.cos(tw) - base[1] * Math.sin(tw)
    const y = base[0] * Math.sin(tw) + base[1] * Math.cos(tw)
    return [x, y, z]
  }
  for (let i = 0; i < RINGS; i++) {
    const z = -i * SP
    const tw = i * TWIST
    for (let k = 0; k < 4; k++) {
      const a = corner(k, tw, z)
      const b = corner((k + 1) % 4, tw, z)
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2])
    }
    if (i < RINGS - 1) {
      const nz = -(i + 1) * SP
      const ntw = (i + 1) * TWIST
      for (const k of [0, 2]) {
        const a = corner(k, tw, z)
        const b = corner(k, ntw, nz)
        pos.push(a[0], a[1], a[2], b[0], b[1], b[2])
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return g
}

/** Thin floating line fragments — abstract geometry for the calm space. */
function buildScatter(count = 80): THREE.BufferGeometry {
  const pos: number[] = []
  for (let i = 0; i < count; i++) {
    const x = (Math.random() * 2 - 1) * 60
    const y = (Math.random() * 2 - 1) * 60
    const z = -Math.random() * CORRIDOR_DEPTH
    const len = 4 + Math.random() * 12
    const ax = Math.random() * 2 - 1
    const ay = Math.random() * 2 - 1
    const az = Math.random() * 2 - 1
    const n = Math.hypot(ax, ay, az) || 1
    pos.push(x, y, z, x + (ax / n) * len, y + (ay / n) * len, z + (az / n) * len)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return g
}

interface WhiteholeSceneProps {
  telemetry: React.RefObject<Telemetry>
}

/**
 * The whitehole space: the camera dashes down a twisting line corridor with
 * exponentially building speed, the void brightens to off-white, then it
 * settles into a slow drift through calm floating geometry.
 */
export function WhiteholeScene({ telemetry }: WhiteholeSceneProps) {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const corridorRef = useRef<THREE.LineSegments>(null)
  const scatterRef = useRef<THREE.Group>(null)
  const flow = useRef(0)

  const corridorGeo = useMemo(buildCorridor, [])
  const scatterGeo = useMemo(() => buildScatter(80), [])
  const bg = useMemo(() => DARK.clone(), [])

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    cam.position.set(0, 0, START_Z)
    cam.rotation.set(0, 0, 0) // look straight down −Z into the corridor
    if (cam.isPerspectiveCamera) {
      cam.fov = 74
      cam.updateProjectionMatrix()
    }
    const prevBg = scene.background
    const prevFog = scene.fog
    scene.background = bg
    scene.fog = new THREE.Fog(bg.getHex(), 40, CORRIDOR_DEPTH)
    return () => {
      corridorGeo.dispose()
      scatterGeo.dispose()
      scene.background = prevBg
      scene.fog = prevFog
    }
  }, [camera, scene, bg, corridorGeo, scatterGeo])

  useFrame((_, delta) => {
    const tel = telemetry.current
    if (tel.simulationPaused) return
    const wt = tel.whiteT

    // Speed: cubic ease-in during the rush, exponential settle to a slow drift.
    const rush = Math.min(wt / RUSH, 1)
    const factor = wt <= RUSH ? rush * rush * rush : Math.exp(-(wt - RUSH) * 1.6)
    const speed = 8 + 250 * factor
    flow.current += speed * delta

    // Dash forward (−Z) through the corridor.
    camera.position.z = START_Z - flow.current

    if (corridorRef.current) corridorRef.current.rotation.z = flow.current * 0.0015
    if (scatterRef.current) {
      scatterRef.current.rotation.y += delta * 0.02
      scatterRef.current.rotation.x += delta * 0.008
    }

    // The void brightens to off-white as we arrive.
    const bright = THREE.MathUtils.smoothstep(wt, 0.3, RUSH)
    bg.copy(DARK).lerp(OFF_WHITE, bright)
    scene.background = bg // assert every frame (wins over any re-render)
    if (scene.fog) (scene.fog as THREE.Fog).color.copy(bg)
  })

  return (
    <>
      <lineSegments ref={corridorRef} geometry={corridorGeo}>
        <lineBasicMaterial
          color="#8aa0bd"
          transparent
          opacity={0.55}
          depthWrite={false}
        />
      </lineSegments>
      <group ref={scatterRef}>
        <lineSegments geometry={scatterGeo}>
          <lineBasicMaterial
            color="#9fb2cc"
            transparent
            opacity={0.4}
            depthWrite={false}
          />
        </lineSegments>
      </group>
    </>
  )
}
