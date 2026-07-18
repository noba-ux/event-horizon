/** Ending sequence phases. */
export type Phase = 'intro' | 'falling' | 'singularity' | 'whitehole'

/**
 * Shared, mutable simulation state written once per frame by the 3D scene
 * (CameraRig / SyncMarker / PhaseController) and read by the particle fields,
 * the lens pass and the HUD overlay. Kept in a single ref object so per-frame
 * updates never trigger React re-renders.
 *
 * `distortionFactor` is the one common 0→1 driver for visuals, audio and HUD.
 */
export interface Telemetry {
  distortionFactor: number // 0 far away → 1 at the event horizon
  journeyProgress: number // 0→1 over the whole fall
  fallIntensity: number // eased 0→1 over the 120s fall (spacetime pressure)
  fallStage: number // 0..3 — which 30s band of the fall we're in
  spacetimePulse: number // brief 0→1 surge at each 30s stage boundary
  distanceToBlackHole: number // world units from camera to singularity
  earthSeconds: number // external clock — accelerates as we approach
  shipSeconds: number // ship's proper time — slows toward a freeze

  // Sync Marker tracking (stage 3).
  isSynced: boolean // cursor is currently locked onto the marker
  syncDistance: number // world distance from the cursor ray to the marker
  syncEase: number // smoothed 0→1 toward isSynced; eases distortion when locked
  signal: number // 0→1 signal integrity; recovers when synced, decays when not

  // Playback sync (stage 4): when the music pauses the whole simulation freezes.
  simulationPaused: boolean // true while the music is paused
  simTime: number // accumulated sim seconds; stops advancing while paused

  // Ending sequence (stage 5).
  phase: Phase // current ending phase
  absorb: number // 0→1 singularity pull (screen-eating)
  blackout: number // 0→1 black overlay opacity
  whiteFlash: number // 0→1 white overlay opacity
  whiteT: number // seconds elapsed inside the whitehole phase
}

export function createTelemetry(): Telemetry {
  return {
    distortionFactor: 0,
    journeyProgress: 0,
    fallIntensity: 0,
    fallStage: 0,
    spacetimePulse: 0,
    distanceToBlackHole: 320, // starts far; shrinks the on-screen hole at intro
    earthSeconds: 0,
    shipSeconds: 0,
    isSynced: false,
    syncDistance: Infinity,
    syncEase: 0,
    signal: 1,
    simulationPaused: false,
    simTime: 0,
    phase: 'intro',
    absorb: 0,
    blackout: 0,
    whiteFlash: 0,
    whiteT: 0,
  }
}
