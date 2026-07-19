import { useEffect, useRef, useState } from 'react'
import { Scene } from './components/Scene'
import { IntroPanel } from './components/IntroPanel'
import type { IntroSource } from './components/IntroPanel'
import { HUD } from './components/HUD'
import { CursorLens } from './components/CursorLens'
import { Overlays } from './components/Overlays'
import { AudioEngine } from './audio/AudioEngine'
import { loadYouTubeApi } from './audio/youtube'
import { createTelemetry } from './telemetry'
import type { Phase } from './telemetry'
import './App.css'

function App() {
  const [phase, setPhase] = useState<Phase>('intro')
  const [fading, setFading] = useState(false)
  const [started, setStarted] = useState(false)
  const [ytMode, setYtMode] = useState(false)
  const [paused, setPaused] = useState(false)
  // Mobile blocks YouTube audio autoplay → show a tap-to-play prompt when caught.
  const [audioBlocked, setAudioBlocked] = useState(false)

  const engineRef = useRef<AudioEngine | null>(null)
  const ytHostRef = useRef<HTMLDivElement>(null)
  // Shared simulation state, written by the scene and read by the HUD.
  const telemetryRef = useRef(createTelemetry())

  // Tear down audio if the app unmounts.
  useEffect(() => {
    return () => engineRef.current?.dispose()
  }, [])

  // Preload the YouTube IFrame API early so the player is ready sooner after the
  // user enters (shrinks the mobile autoplay-blocked window).
  useEffect(() => {
    void loadYouTubeApi().catch(() => {})
  }, [])

  // Space toggles play/pause once the simulation has started. Pausing the music
  // freezes the whole simulation (handled via telemetry.simulationPaused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && engineRef.current) {
        e.preventDefault()
        engineRef.current.togglePlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleEnter = (source: IntroSource) => {
    if (engineRef.current) return // guard against double entry

    // The AudioEngine (and its AudioContext) is created here, inside the
    // user-gesture click handler, to satisfy browser autoplay policies.
    const engine = new AudioEngine()
    engineRef.current = engine

    // Mirror playback state into the simulation: paused music → frozen sim.
    engine.onPlayStateChanged = (playing) => {
      telemetryRef.current.simulationPaused = !playing
      setPaused(!playing)
    }

    // Mobile autoplay was blocked → surface a tap-to-play prompt.
    engine.onAutoplayBlocked = () => setAudioBlocked(true)

    switch (source.mode) {
      case 'demo':
        engine.startDemo()
        break
      case 'file':
        void engine.startFile(source.file)
        break
      case 'youtube':
        setYtMode(true)
        if (ytHostRef.current) {
          void engine.startYouTube(source.videoId, ytHostRef.current)
        }
        break
    }

    // Begin the plunge and fade the intro out, then unmount it. The ending
    // phases (singularity/whitehole) are driven later by the PhaseController.
    setStarted(true)
    setFading(true)
    window.setTimeout(() => setPhase('falling'), 1200)
  }

  return (
    <div className="app">
      <Scene
        engine={engineRef.current}
        active={started}
        telemetry={telemetryRef}
        phase={phase}
        onPhaseChange={setPhase}
      />

      {started && <Overlays telemetry={telemetryRef} />}

      {started && phase !== 'whitehole' && (
        <HUD telemetry={telemetryRef} active={started} />
      )}
      {started && phase !== 'whitehole' && <CursorLens />}

      {started && paused && (
        <div
          style={{
            position: 'absolute',
            top: '46%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 7,
            fontFamily: 'var(--mono)',
            fontSize: '13px',
            letterSpacing: '3px',
            color: '#9fb3c8',
            opacity: 0.82,
            pointerEvents: 'none',
            textShadow: '0 0 12px rgba(0,0,0,0.8)',
          }}
        >
          ❚❚ SIGNAL HELD · SPACE TO RESUME
        </div>
      )}

      {/* Mobile autoplay unlock: a full-screen tap layer that starts the audio
          inside a direct user gesture (the only way iOS/Android will allow it). */}
      {started && audioBlocked && phase !== 'whitehole' && (
        <button
          type="button"
          className="audio-unlock"
          onClick={() => {
            engineRef.current?.retryYouTubePlay()
            setAudioBlocked(false)
          }}
        >
          <span className="audio-unlock-icon">►</span>
          <span className="audio-unlock-text">탭하여 사운드 재생</span>
        </button>
      )}

      {/* YouTube host: a small, unobtrusive corner panel; hidden until used. */}
      <div className={`yt-panel${ytMode ? ' visible' : ''}`}>
        <div className="yt-label">// AUDIO LINK</div>
        <div ref={ytHostRef} className="yt-host" />
      </div>

      {phase === 'intro' && (
        <div className={`intro-overlay${fading ? ' fading' : ''}`}>
          <IntroPanel onEnter={handleEnter} />
        </div>
      )}
    </div>
  )
}

export default App
