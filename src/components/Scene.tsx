import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { Starfield } from './Starfield'
import { BlackHole } from './BlackHole'
import { SyncMarker } from './SyncMarker'
import { LensPass } from './LensPass'
import { NebulaBackdrop } from './NebulaBackdrop'
import { WhiteholeScene } from './WhiteholeScene'
import type { AudioEngine } from '../audio/AudioEngine'
import type { Telemetry, Phase } from '../telemetry'

const LOOK_TARGET = new THREE.Vector3() // reused each frame (off-axis look point)
const START_DISTANCE = 320
const MIN_DISTANCE = 10
const FAR_THRESHOLD = 300
const NEAR_THRESHOLD = 24

// A long fall: ~2.5 minutes, slow to enter and explosive near the end.
const JOURNEY_DURATION = 145
const EASE_POWER = 2.45
const SHAKE_AMP = 0.95
const BASE_FOV = 74 // widens with distortion for the plunge

// Time-dilation shaping for the HUD clocks.
const EARTH_ACCEL = 620 // external clock speed-up at the horizon
const SHIP_SLOWDOWN = 0.94 // ship proper-time slowdown fraction at the horizon

// Ending sequence timing (seconds, all sim-time so pause freezes them).
const FALL_TO_SING = 120 // fall for at least 120s before the singularity
const SING_DURATION = 0.7 // final convergence: stars snap into the vanishing point
const BLACKOUT = 0.5 // full black hold once everything is swallowed
const WHITE_RUSH = 2.6 // whitehole dash length

/**
 * Ending state machine. Runs on sim time (freezes with the music), grows the
 * absorb/blackout/whiteFlash values and fires the audio + phase transitions.
 */
function PhaseController({
  telemetry,
  active,
  engine,
  onPhaseChange,
}: {
  telemetry: React.RefObject<Telemetry>
  active: boolean
  engine: AudioEngine | null
  onPhaseChange: (p: Phase) => void
}) {
  const s = useRef({ phase: 'falling' as Phase, singT: 0, fallT: 0, whiteT: 0 })

  useFrame((_, delta) => {
    if (!active) return
    const tel = telemetry.current
    if (tel.simulationPaused) return
    const st = s.current
    tel.phase = st.phase

    if (st.phase === 'falling') {
      st.fallT += delta
      if (st.fallT >= FALL_TO_SING) {
        st.phase = 'singularity'
        st.singT = 0
        tel.phase = 'singularity'
        engine?.enterSingularity()
        onPhaseChange('singularity')
      }
    } else if (st.phase === 'singularity') {
      st.singT += delta
      const t = st.singT
      // absorb: cubic ease-in 0→1 — the final, explosive convergence of all
      // remaining starlight into the (now invisible) centre.
      const a = Math.min(t / SING_DURATION, 1)
      tel.absorb = a * a * a
      // blackout rises as the convergence completes → the screen reaches pure
      // black exactly as the last light is swallowed, then holds for BLACKOUT.
      tel.blackout = THREE.MathUtils.smoothstep(t, SING_DURATION * 0.55, SING_DURATION)
      if (t >= SING_DURATION + BLACKOUT) {
        st.phase = 'whitehole'
        st.whiteT = 0
        tel.phase = 'whitehole'
        tel.whiteT = 0
        engine?.enterWhitehole()
        onPhaseChange('whitehole')
      }
    } else if (st.phase === 'whitehole') {
      st.whiteT += delta
      const wt = st.whiteT
      tel.whiteT = wt
      // reveal: the blackout fades off quickly to show the dash.
      tel.blackout = THREE.MathUtils.clamp(1 - wt / 0.4, 0, 1)
      // white flash: opens as we arrive, then settles to the calm off-white.
      const rise = THREE.MathUtils.smoothstep(wt, WHITE_RUSH * 0.55, WHITE_RUSH)
      const fall =
        1 - THREE.MathUtils.smoothstep(wt, WHITE_RUSH + 0.2, WHITE_RUSH + 1.6)
      tel.whiteFlash = 0.92 * rise * fall
    }
  })

  return null
}

/** Advances the shared simulation clock, freezing it while the music is paused. */
function SimClock({ telemetry }: { telemetry: React.RefObject<Telemetry> }) {
  useFrame((_, delta) => {
    const tel = telemetry.current
    if (!tel.simulationPaused) tel.simTime += delta
  })
  return null
}

interface CameraRigProps {
  engine: AudioEngine | null
  active: boolean
  telemetry: React.RefObject<Telemetry>
}

/** Drives the eased plunge and publishes the shared telemetry every frame. */
function CameraRig({ engine, active, telemetry }: CameraRigProps) {
  // Journey time accumulates by delta (not the wall clock) so a pause freezes it
  // and a resume continues from the same point.
  const journeyTime = useRef(0)

  useFrame((state, delta) => {
    if (!active) return
    const tel = telemetry.current
    if (tel.simulationPaused) return // music paused → freeze the fall

    const camera = state.camera
    journeyTime.current += delta
    const elapsed = journeyTime.current

    // journeyProgress: 0→1 linearly over the whole fall...
    const journeyProgress = THREE.MathUtils.clamp(
      elapsed / JOURNEY_DURATION,
      0,
      1,
    )
    // ...then eased so we crawl in early and plunge late.
    const easedProgress = Math.pow(journeyProgress, EASE_POWER)

    // distanceToBlackHole: current camera-to-singularity distance.
    const distanceToBlackHole =
      START_DISTANCE + (MIN_DISTANCE - START_DISTANCE) * easedProgress

    // distortionFactor: the single 0→1 driver for visuals, audio and HUD.
    const distortionFactor = THREE.MathUtils.clamp(
      (FAR_THRESHOLD - distanceToBlackHole) / (FAR_THRESHOLD - NEAR_THRESHOLD),
      0,
      1,
    )

    // Publish telemetry for the particle fields and the HUD.
    const synced = tel.isSynced // set by SyncMarker earlier this frame
    tel.journeyProgress = journeyProgress
    tel.distanceToBlackHole = distanceToBlackHole
    tel.distortionFactor = distortionFactor
    // Earth clock races ahead (a locked sync steadies it slightly); ship clock
    // freezes (gravitational time dilation).
    const earthAccel = distortionFactor * distortionFactor * EARTH_ACCEL
    tel.earthSeconds += delta * (1 + earthAccel * (synced ? 0.82 : 1))
    tel.shipSeconds += delta * (1 - SHIP_SLOWDOWN * distortionFactor)

    // Signal integrity: recovers while synced, decays (faster near the hole)
    // otherwise — but never bottoms out to a hard failure.
    tel.signal = THREE.MathUtils.clamp(
      tel.signal +
        (synced ? 0.06 : -0.03 * (0.5 + distortionFactor)) * delta,
      0.08,
      1,
    )

    // fallProgress over the 120s fall, eased so spacetime pressure builds up
    // over time rather than linearly (calm early, tense late).
    const fallProgress = THREE.MathUtils.clamp(elapsed / 120, 0, 1)
    const fallIntensity = Math.pow(fallProgress, 1.6)
    tel.fallProgress = fallProgress
    tel.fallIntensity = fallIntensity
    // Horizon dissolve: over the final ~15s (fallProgress 0.875→0.99) the black
    // event-horizon sphere fades out (1→0). Instead of growing the mesh to
    // swallow the frame, the sphere melts into the natural dark while the star
    // field converges — the "spacetime cross-fade" pass-through.
    tel.horizonFade = 1 - THREE.MathUtils.clamp((fallProgress - 0.875) / 0.115, 0, 1)

    // Stage events every 30s: a short pulse surges at each 30/60/90s boundary.
    const fallStage = Math.min(Math.floor(elapsed / 30), 3)
    const stageLocalT = elapsed - fallStage * 30
    tel.fallStage = fallStage
    // No pulse in the first calm stage; then a 2–4s ease-out at each boundary.
    tel.spacetimePulse = fallStage >= 1 ? Math.exp(-stageLocalT * 1.1) : 0
    const pulse = tel.spacetimePulse

    // syncEase: smoothed toward isSynced. When locked it eases the collapse
    // (shake/lens/curl/glitch) by up to ~40% — a moment of stabilisation.
    tel.syncEase += ((tel.isSynced ? 1 : 0) - tel.syncEase) * 0.06
    const calm = 1 - tel.syncEase * 0.4

    const t = tel.simTime
    // Orbital approach: the camera circles the axis while the orbit radius
    // tightens as we fall → a spiral descent, not a head-on straight line.
    const orbitAngle = t * 0.12 + fallIntensity * 2.0
    const orbitRadius = THREE.MathUtils.lerp(30, 7, fallProgress)
    const shake =
      SHAKE_AMP *
      (distortionFactor * distortionFactor + fallIntensity * 0.4 + pulse * 0.5) *
      calm
    camera.position.set(
      Math.cos(orbitAngle) * orbitRadius + Math.sin(t * 31) * shake,
      Math.sin(orbitAngle) * orbitRadius * 0.45 + Math.cos(t * 27) * shake,
      distanceToBlackHole,
    )
    // Look toward a tangent-offset point (not dead-centre), so the hole slides
    // gently near the middle as the camera swings around it. The offset is kept
    // small AND hard-capped in absolute world units, so the hole only *drifts*
    // near centre and can never slide out of frame during the orbital descent.
    const tanOff = Math.min(
      (0.02 + 0.025 * fallIntensity) * distanceToBlackHole * calm,
      6 + fallIntensity * 4,
    )
    LOOK_TARGET.set(
      -Math.sin(orbitAngle) * tanOff,
      Math.cos(orbitAngle) * tanOff * 0.4,
      0,
    )
    camera.lookAt(LOOK_TARGET)
    // A gentle roll around the view axis, building late and jolting on pulses.
    camera.rotation.z +=
      (Math.sin(t * 0.17) * 0.05 * fallIntensity + fallIntensity * 0.03 + pulse * 0.04) *
      calm

    // Widen the FOV as we plunge → a growing sense of speed and being pulled in.
    const perspective = camera as THREE.PerspectiveCamera
    if (perspective.isPerspectiveCamera) {
      const targetFov = BASE_FOV + distortionFactor * 14
      if (Math.abs(perspective.fov - targetFov) > 0.02) {
        perspective.fov = targetFov
        perspective.updateProjectionMatrix()
      }
    }

    // Audio only during the fall; the singularity slams the music itself.
    if (tel.phase === 'falling') {
      // Slow playback and muffle the highs as we approach — but the floor keeps
      // rhythm/low-end alive. A locked sync opens the low-pass back up.
      const targetPlaybackRate = 1.0 - 0.72 * distortionFactor
      engine?.setTargetPlaybackRate(targetPlaybackRate)
      engine?.setLowpass(distortionFactor, synced)
    }
  })

  return null
}

interface SceneProps {
  engine: AudioEngine | null
  active: boolean
  telemetry: React.RefObject<Telemetry>
  phase: Phase
  onPhaseChange: (p: Phase) => void
}

export function Scene({
  engine,
  active,
  telemetry,
  phase,
  onPhaseChange,
}: SceneProps) {
  const inWhitehole = phase === 'whitehole'

  return (
    <Canvas
      camera={{ position: [0, 0, START_DISTANCE], fov: BASE_FOV, near: 0.1, far: 1400 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      style={{ position: 'absolute', inset: 0 }}
    >
      {!inWhitehole && <color attach="background" args={['#02030a']} />}
      {!inWhitehole && <fog attach="fog" args={['#02030a', 110, 620]} />}
      <SimClock telemetry={telemetry} />
      <PhaseController
        telemetry={telemetry}
        active={active}
        engine={engine}
        onPhaseChange={onPhaseChange}
      />

      {!inWhitehole && (
        <>
          <NebulaBackdrop />
          <Starfield telemetry={telemetry} />
          <BlackHole telemetry={telemetry} />
          <SyncMarker telemetry={telemetry} />
          <CameraRig engine={engine} active={active} telemetry={telemetry} />
        </>
      )}

      {inWhitehole && <WhiteholeScene telemetry={telemetry} />}

      <LensPass telemetry={telemetry} />
    </Canvas>
  )
}
