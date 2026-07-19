import { loadYouTubeApi } from './youtube'
import type { YTPlayer } from './youtube'

export type AudioMode = 'demo' | 'file' | 'youtube' | 'ambient'

// How aggressively currentPlaybackRate chases the target each update (per call).
const SMOOTHING = 0.08
// YouTube's setPlaybackRate is coarse and janky if spammed — throttle it.
const YT_APPLY_INTERVAL_MS = 250

/**
 * Unified audio engine. Regardless of source (synth demo / local file / YouTube)
 * it exposes a single `setTargetPlaybackRate` used by the 3D scene to slow the
 * audio as the camera falls toward the black hole.
 */
export class AudioEngine {
  mode: AudioMode | null = null

  // Playback state. `onPlayStateChanged` lets the app mirror pause/resume into
  // the simulation (so the whole scene freezes when the music pauses).
  isPlaying = false
  onPlayStateChanged: ((playing: boolean) => void) | null = null
  // Mobile browsers block the YouTube iframe's audio unless play() is called
  // inside a direct tap. When we detect playback never actually began, this
  // fires so the app can show a "tap to play" affordance that starts it in a
  // fresh user gesture.
  onAutoplayBlocked: (() => void) | null = null

  // currentPlaybackRate: the smoothed rate actually applied to the source each
  // update. It eases toward the target set by the scene (see setTargetPlaybackRate).
  private currentPlaybackRate = 1
  private targetPlaybackRate = 1

  // Web Audio (demo + file) --------------------------------------------------
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  // Global low-pass: distortion muffles the highs as we approach the horizon.
  private lowpass: BiquadFilterNode | null = null
  private fileSource: AudioBufferSourceNode | null = null
  // Demo oscillators paired with their base frequencies so we can scale pitch
  // down as a stand-in for "slowing" a synthesized source.
  private demoVoices: { osc: OscillatorNode; baseFreq: number }[] = []
  private demoNoise: AudioBufferSourceNode | null = null

  // Whitehole ambient pad (stage 5) — its own gain, independent of masterGain.
  private ambientGain: GainNode | null = null
  private ambientNodes: (OscillatorNode | AudioBufferSourceNode)[] = []

  // YouTube ------------------------------------------------------------------
  private ytPlayer: YTPlayer | null = null
  private ytAvailableRates: number[] = [1]
  private ytSlowestRate = 1
  private ytLastAppliedRate = 1
  private ytLastApplyTime = 0
  // True once the iframe actually reaches a playing/buffering state — used to
  // tell "playing" apart from "autoplay was blocked".
  private ytStarted = false

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext
      this.ctx = new Ctor()
      this.masterGain = this.ctx.createGain()
      this.masterGain.gain.value = 0.0
      // Web Audio sources route through the low-pass, then the master gain.
      this.lowpass = this.ctx.createBiquadFilter()
      this.lowpass.type = 'lowpass'
      this.lowpass.frequency.value = 18000
      this.lowpass.connect(this.masterGain)
      this.masterGain.connect(this.ctx.destination)
    }
    // Autoplay policy: resume() must run inside/after a user gesture.
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  private setPlaying(v: boolean) {
    if (this.isPlaying === v) return
    this.isPlaying = v
    this.onPlayStateChanged?.(v)
  }

  /** Pause playback (and, via the callback, the simulation) from this point. */
  pause() {
    if (this.mode === 'youtube') this.ytPlayer?.pauseVideo()
    // Always suspend the Web Audio clock too, so any SFX/ambient/pad freezes in
    // lock-step with the visuals (keeps the ending sound in sync).
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend()
    this.setPlaying(false)
  }

  /** Resume playback from where it was paused. */
  resume() {
    if (this.mode === 'youtube') this.ytPlayer?.playVideo()
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume()
    this.setPlaying(true)
  }

  togglePlay() {
    if (this.isPlaying) this.pause()
    else this.resume()
  }

  /**
   * Start (or restart) YouTube playback from a direct user gesture — the only
   * reliable way to begin iframe audio on mobile after autoplay was blocked.
   */
  retryYouTubePlay() {
    if (this.mode !== 'youtube') return
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume()
    this.ytPlayer?.setVolume(80)
    this.ytPlayer?.playVideo()
  }

  private fadeMasterTo(value: number, seconds: number) {
    if (!this.ctx || !this.masterGain) return
    const now = this.ctx.currentTime
    this.masterGain.gain.cancelScheduledValues(now)
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now)
    this.masterGain.gain.linearRampToValueAtTime(value, now + seconds)
  }

  /** Dark ambient drone: layered low oscillators + filtered noise bed. */
  startDemo() {
    this.mode = 'demo'
    const ctx = this.ensureContext()
    const out = this.lowpass!

    // Low sine drone + a detuned partial + a low fifth for an uneasy beat.
    const specs: { freq: number; type: OscillatorType; gain: number }[] = [
      { freq: 55, type: 'sine', gain: 0.5 },
      { freq: 55.4, type: 'sine', gain: 0.35 },
      { freq: 82.4, type: 'triangle', gain: 0.18 },
    ]
    for (const spec of specs) {
      const osc = ctx.createOscillator()
      osc.type = spec.type
      osc.frequency.value = spec.freq
      const g = ctx.createGain()
      g.gain.value = spec.gain
      osc.connect(g).connect(out)
      osc.start()
      this.demoVoices.push({ osc, baseFreq: spec.freq })
    }

    // Filtered white-noise bed = distant space wind / rumble.
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    const noise = ctx.createBufferSource()
    noise.buffer = noiseBuffer
    noise.loop = true
    const noiseFilter = ctx.createBiquadFilter()
    noiseFilter.type = 'lowpass'
    noiseFilter.frequency.value = 220
    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0.12
    noise.connect(noiseFilter).connect(noiseGain).connect(out)
    noise.start()
    this.demoNoise = noise

    this.fadeMasterTo(0.6, 2.5)
    this.setPlaying(true)
  }

  /** Decodes an uploaded audio file and plays it as a looping buffer source. */
  async startFile(file: File) {
    this.mode = 'file'
    const ctx = this.ensureContext()

    const arrayBuffer = await file.arrayBuffer()
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.loop = true
    source.connect(this.lowpass!)
    source.start()
    this.fileSource = source

    this.fadeMasterTo(0.9, 1.5)
    this.setPlaying(true)
  }

  /** Builds a hidden YouTube player and records its supported playback rates. */
  async startYouTube(videoId: string, container: HTMLElement) {
    this.mode = 'youtube'
    // Unlock a Web Audio context during the user gesture so the ending SFX /
    // ambient pad can play later even though YouTube audio is in the iframe.
    this.ensureContext()
    const YT = await loadYouTubeApi()

    await new Promise<void>((resolve) => {
      this.ytPlayer = new YT.Player(container, {
        videoId,
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
        },
        events: {
          onReady: (event) => {
            const player = event.target
            player.setVolume(80)
            player.playVideo()
            const rates = player.getAvailablePlaybackRates()
            if (rates && rates.length) {
              this.ytAvailableRates = [...rates].sort((a, b) => a - b)
              this.ytSlowestRate = this.ytAvailableRates[0]
            }
            this.setPlaying(true)
            resolve()
            // Mobile autoplay guard: if the iframe hasn't actually begun playing
            // shortly after ready (blocked outside a direct tap), ask the app to
            // surface a tap-to-play prompt.
            window.setTimeout(() => {
              if (this.mode === 'youtube' && !this.ytStarted) {
                this.onAutoplayBlocked?.()
              }
            }, 2000)
          },
          onStateChange: (event) => {
            // Ignore YouTube events once we've switched to the ambient pad.
            if (this.mode !== 'youtube') return
            // YouTube PlayerState: 1 = playing, 3 = buffering, 2 = paused, 0 = ended.
            if (event.data === 1 || event.data === 3) {
              this.ytStarted = true
              this.setPlaying(true)
            } else if (event.data === 2 || event.data === 0) this.setPlaying(false)
          },
        },
      })
    })
  }

  /**
   * Called every frame by the scene with the desired playback rate (1.0 far →
   * 0.1 near the horizon). We smooth currentPlaybackRate toward it and apply to
   * whichever source is active.
   */
  setTargetPlaybackRate(rate: number) {
    this.targetPlaybackRate = rate
    this.currentPlaybackRate +=
      (this.targetPlaybackRate - this.currentPlaybackRate) * SMOOTHING
    this.applyPlaybackRate()
  }

  /**
   * Muffles the highs as distortion (0→1) rises, by lowering the global
   * low-pass cutoff. Web Audio modes only — YouTube has no Web Audio graph, so
   * we never force filtering there (its slowdown is playbackRate-only).
   *
   * When `synced` (cursor locked on the marker) the cutoff opens back up so the
   * music reads clearer; when not synced it closes a little further (murkier).
   *
   * TODO(stage 3+): mouse-triggered glitch bursts and short reverse-playback
   * stutters are intentionally NOT implemented in this stage.
   */
  setLowpass(distortionFactor: number, synced = false) {
    if (this.mode === 'youtube' || !this.ctx || !this.lowpass) return
    const d = Math.min(Math.max(distortionFactor, 0), 1)
    const min = 480 // floor keeps low-mids/rhythm present — never fully dead
    const max = 18000
    // Exponential sweep so the muffling feels natural across the range.
    let freq = min * Math.pow(max / min, 1 - d)
    // Sync opens the filter (×2.2), un-sync closes it a touch (×0.72).
    freq *= synced ? 2.2 : 0.72
    freq = Math.min(Math.max(freq, 320), max)
    this.lowpass.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.12)
  }

  private applyPlaybackRate() {
    const rate = this.currentPlaybackRate
    switch (this.mode) {
      case 'file':
        if (this.fileSource) this.fileSource.playbackRate.value = rate
        break
      case 'demo':
        // Skeleton "slowdown" for synth: scale pitch + noise playback rate.
        for (const { osc, baseFreq } of this.demoVoices) {
          osc.frequency.value = baseFreq * rate
        }
        if (this.demoNoise) this.demoNoise.playbackRate.value = rate
        break
      case 'youtube':
        this.applyYouTubeRate(rate)
        break
    }
  }

  /** Snap to the nearest supported rate (never below the slowest), throttled. */
  private applyYouTubeRate(rate: number) {
    if (!this.ytPlayer) return
    const now = performance.now()
    if (now - this.ytLastApplyTime < YT_APPLY_INTERVAL_MS) return

    // YouTube cannot go below ~0.25; clamp to the slowest it reports.
    const wanted = Math.max(rate, this.ytSlowestRate)
    let nearest = this.ytAvailableRates[0]
    let bestDelta = Infinity
    for (const candidate of this.ytAvailableRates) {
      const delta = Math.abs(candidate - wanted)
      if (delta < bestDelta) {
        bestDelta = delta
        nearest = candidate
      }
    }

    this.ytLastApplyTime = now
    if (nearest !== this.ytLastAppliedRate) {
      this.ytLastAppliedRate = nearest
      this.ytPlayer.setPlaybackRate(nearest)
    }
  }

  // ---- Ending sequence (stage 5) -------------------------------------------

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    return buf
  }

  private fadeYtVolume(target: number, ms: number) {
    if (!this.ytPlayer) return
    const steps = 12
    const start = 80
    let i = 0
    const id = window.setInterval(() => {
      i++
      this.ytPlayer?.setVolume(Math.max(0, start + (target - start) * (i / steps)))
      if (i >= steps) window.clearInterval(id)
    }, ms / steps)
  }

  /**
   * Singularity: a "sucked in" whoosh — noise sweeping down through a closing
   * low-pass with a swell-then-cut gain envelope, plus a pitch-down drone. The
   * falling music is slammed shut (fade + low-pass) into the blackout.
   */
  enterSingularity() {
    const ctx = this.ensureContext()
    const t0 = ctx.currentTime
    const dur = 2.9

    // Noise sweep.
    const noise = ctx.createBufferSource()
    noise.buffer = this.makeNoise(ctx, dur)
    const nf = ctx.createBiquadFilter()
    nf.type = 'lowpass'
    nf.frequency.setValueAtTime(8000, t0)
    nf.frequency.exponentialRampToValueAtTime(80, t0 + dur)
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.0001, t0)
    ng.gain.exponentialRampToValueAtTime(0.6, t0 + dur * 0.72)
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    noise.connect(nf).connect(ng).connect(ctx.destination)
    noise.start(t0)
    noise.stop(t0 + dur)

    // Pitch-down drone.
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(160, t0)
    osc.frequency.exponentialRampToValueAtTime(28, t0 + dur)
    const og = ctx.createGain()
    og.gain.setValueAtTime(0.0001, t0)
    og.gain.exponentialRampToValueAtTime(0.28, t0 + dur * 0.6)
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(og).connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + dur)

    // Slam the falling music shut.
    if (this.mode === 'youtube') {
      this.ytPlayer?.setPlaybackRate(this.ytSlowestRate)
      this.fadeYtVolume(0, 2600)
    } else {
      this.fadeMasterTo(0, dur)
      this.lowpass?.frequency.setTargetAtTime(110, t0, 0.4)
    }
  }

  /**
   * Whitehole arrival: pressure releasing — a rising, brightening noise shimmer
   * and a soft chime — then a calm synthesized ambient pad fades in. The old
   * music is silenced; from here pause/resume acts on the ambient pad (ctx).
   */
  enterWhitehole() {
    const ctx = this.ensureContext()
    const t0 = ctx.currentTime

    // Silence the falling source.
    if (this.mode === 'youtube') this.fadeYtVolume(0, 1000)
    else this.fadeMasterTo(0, 1.5)
    this.mode = 'ambient' // pause/resume now act on the ctx; YT events ignored

    // Rising shimmer (filtered noise burst).
    const noise = ctx.createBufferSource()
    noise.buffer = this.makeNoise(ctx, 3.2)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.setValueAtTime(300, t0)
    hp.frequency.exponentialRampToValueAtTime(5000, t0 + 2.2)
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.0001, t0)
    ng.gain.exponentialRampToValueAtTime(0.1, t0 + 0.7)
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.0)
    noise.connect(hp).connect(ng).connect(ctx.destination)
    noise.start(t0)
    noise.stop(t0 + 3.2)

    // Soft chime (gentle high partials, slow-ish attack).
    const chime = [783.99, 1046.5, 1318.5] // G5 · C6 · E6
    chime.forEach((f, i) => {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f
      const g = ctx.createGain()
      const start = t0 + i * 0.12
      g.gain.setValueAtTime(0.0001, start)
      g.gain.exponentialRampToValueAtTime(0.05, start + 0.4)
      g.gain.exponentialRampToValueAtTime(0.0001, start + 2.6)
      o.connect(g).connect(ctx.destination)
      o.start(start)
      o.stop(start + 2.8)
    })

    this.startAmbientPad(ctx, t0)
    this.setPlaying(true)
  }

  /** A soft, slowly-swelling ambient chord — the calm of the whitehole. */
  private startAmbientPad(ctx: AudioContext, t0: number) {
    const pad = ctx.createGain()
    pad.gain.setValueAtTime(0.0001, t0)
    pad.gain.exponentialRampToValueAtTime(0.2, t0 + 5) // fade in over ~5s
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1300
    lp.connect(pad)
    pad.connect(ctx.destination)
    this.ambientGain = pad

    // Soft, wide chord (A minor-ish, low + calm).
    const chord = [110, 164.81, 220, 277.18] // A2 · E3 · A3 · C#4
    chord.forEach((f, i) => {
      const o = ctx.createOscillator()
      o.type = i % 2 === 0 ? 'sine' : 'triangle'
      o.frequency.value = f
      o.detune.value = (Math.random() * 2 - 1) * 6
      const g = ctx.createGain()
      g.gain.value = 0.25 - i * 0.03
      o.connect(g).connect(lp)
      o.start(t0)
      this.ambientNodes.push(o)
    })

    // Very faint shimmer.
    const shimmer = ctx.createBufferSource()
    shimmer.buffer = this.makeNoise(ctx, 4)
    shimmer.loop = true
    const sf = ctx.createBiquadFilter()
    sf.type = 'bandpass'
    sf.frequency.value = 6000
    const sg = ctx.createGain()
    sg.gain.value = 0.015
    shimmer.connect(sf).connect(sg).connect(lp)
    shimmer.start(t0)
    this.ambientNodes.push(shimmer)
  }

  dispose() {
    try {
      this.fileSource?.stop()
    } catch {
      /* already stopped */
    }
    try {
      this.demoNoise?.stop()
    } catch {
      /* already stopped */
    }
    for (const { osc } of this.demoVoices) {
      try {
        osc.stop()
      } catch {
        /* already stopped */
      }
    }
    this.demoVoices = []
    for (const node of this.ambientNodes) {
      try {
        node.stop()
      } catch {
        /* already stopped */
      }
    }
    this.ambientNodes = []
    this.ambientGain?.disconnect()
    this.ambientGain = null
    this.ytPlayer?.destroy()
    this.ytPlayer = null
    void this.ctx?.close()
    this.ctx = null
  }
}
