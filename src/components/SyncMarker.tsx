import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Telemetry } from '../telemetry'
import { makeSoftDot } from '../three/textures'

// Marker orbit: it hovers a fixed distance ahead of the camera, spiralling
// around the axis while its radius decays inward, then respawns.
const AHEAD = 95 // world units in front of the camera
const R_MAX = 68
const R_MIN = 7
const FALL_SPEED = 9 // radius units/sec toward the centre
const ANG_SPEED = 0.7 // orbital angular speed
const WOBBLE = 3.2 // irregular float amplitude

interface SyncMarkerProps {
  telemetry: React.RefObject<Telemetry>
}

/**
 * A 3D quantum-marker sphere the player tracks with the cursor. A Raycaster
 * from the mouse gives `syncDistance` (ray→marker distance); when it drops
 * under `syncThreshold` we set `isSynced`. Nothing here is a 2D UI icon.
 */
export function SyncMarker({ telemetry }: SyncMarkerProps) {
  const camera = useThree((s) => s.camera)
  const groupRef = useRef<THREE.Group>(null)
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null)
  const glowMatRef = useRef<THREE.MeshBasicMaterial>(null)
  const glowRef = useRef<THREE.Mesh>(null)

  const softDot = useMemo(() => makeSoftDot(128), [])
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const mouseNdc = useMemo(() => new THREE.Vector2(0, 0), [])
  const markerPos = useMemo(() => new THREE.Vector3(), [])
  const orbit = useRef({ angle: Math.random() * Math.PI * 2, radius: R_MAX })

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      mouseNdc.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1,
      )
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [mouseNdc])

  useEffect(() => {
    return () => softDot.dispose()
  }, [softDot])

  useFrame((_, delta) => {
    const tel = telemetry.current
    if (tel.simulationPaused) return // frozen while the music is paused
    const time = tel.simTime
    const o = orbit.current

    // Spiral inward, then respawn at the outer edge.
    o.angle += ANG_SPEED * delta
    o.radius -= FALL_SPEED * delta
    if (o.radius < R_MIN) {
      o.radius = R_MAX
      o.angle = Math.random() * Math.PI * 2
    }

    // Irregular float so it never sits perfectly still.
    const wobX = Math.sin(time * 2.3) * WOBBLE + Math.sin(time * 5.1) * 0.6
    const wobY = Math.cos(time * 1.9) * WOBBLE + Math.cos(time * 4.3) * 0.6
    const camZ = camera.position.z
    markerPos.set(
      Math.cos(o.angle) * o.radius + wobX,
      Math.sin(o.angle) * o.radius + wobY,
      camZ - AHEAD + Math.sin(time * 1.3) * 4,
    )
    groupRef.current?.position.copy(markerPos)
    glowRef.current?.lookAt(camera.position)

    // --- Tracking test ---------------------------------------------------
    raycaster.setFromCamera(mouseNdc, camera)
    // syncDistance: perpendicular distance from the cursor ray to the marker.
    const syncDistance = raycaster.ray.distanceToPoint(markerPos)
    // syncThreshold: scaled by depth so the target stays screen-consistent.
    const syncThreshold = 4 + 0.05 * camera.position.distanceTo(markerPos)
    const isSynced = syncDistance < syncThreshold

    tel.syncDistance = syncDistance
    tel.isSynced = isSynced

    // An unstable signal, not a game ball: it flickers and jitters. Locking on
    // steadies it into a clear cyan pulse; unlocked it's a nervous amber flicker.
    const flicker = 0.55 + 0.45 * Math.abs(Math.sin(time * 9.0 + Math.sin(time * 5.3)))
    const pulse = 1 + 0.12 * Math.sin(time * 5.0)
    const lock = isSynced ? 1 : 0
    if (groupRef.current) {
      // Steadier when locked; nervous micro-jitter when not.
      const jitter = (1 - lock) * (Math.sin(time * 41.0) * 0.06)
      groupRef.current.scale.setScalar(pulse * (1 + lock * 0.3) + jitter)
    }
    if (coreMatRef.current) {
      coreMatRef.current.color.setHex(isSynced ? 0xdffcff : 0xffb24a)
      coreMatRef.current.opacity = isSynced ? 0.95 : 0.55 + 0.4 * flicker
    }
    if (glowMatRef.current) {
      glowMatRef.current.color.setHex(isSynced ? 0x9fe8ff : 0xff8a3a)
      const base = isSynced ? 0.7 : 0.34
      glowMatRef.current.opacity = base * (0.6 + 0.4 * flicker)
    }
  })

  return (
    <group ref={groupRef}>
      {/* Unstable signal halo (camera-facing). */}
      <mesh ref={glowRef}>
        <planeGeometry args={[8, 8]} />
        <meshBasicMaterial
          ref={glowMatRef}
          map={softDot}
          color="#ff8a3a"
          transparent
          opacity={0.34}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {/* Small bright signal node. */}
      <mesh>
        <sphereGeometry args={[0.9, 20, 20]} />
        <meshBasicMaterial
          ref={coreMatRef}
          color="#ffb24a"
          transparent
          opacity={0.9}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}
