// Minimal typings + loader for the YouTube IFrame Player API.
// We deliberately hand-roll a tiny subset so `tsc` passes without pulling in
// the full @types/youtube package.

export interface YTPlayer {
  playVideo(): void
  pauseVideo(): void
  setPlaybackRate(rate: number): void
  getPlaybackRate(): number
  getAvailablePlaybackRates(): number[]
  setVolume(volume: number): void
  destroy(): void
}

interface YTPlayerVars {
  autoplay?: 0 | 1
  controls?: 0 | 1
  disablekb?: 0 | 1
  fs?: 0 | 1
  modestbranding?: 0 | 1
  rel?: 0 | 1
  playsinline?: 0 | 1
}

interface YTPlayerOptions {
  videoId: string
  playerVars?: YTPlayerVars
  events?: {
    onReady?: (event: { target: YTPlayer }) => void
    onStateChange?: (event: { data: number; target: YTPlayer }) => void
  }
}

interface YTNamespace {
  Player: new (element: HTMLElement | string, options: YTPlayerOptions) => YTPlayer
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number; BUFFERING: number }
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

/**
 * Extracts an 11-character YouTube videoId from the common URL shapes:
 * watch?v=, youtu.be/, /embed/, /shorts/. Returns null if none match.
 */
export function extractVideoId(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  // Bare id already?
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed

  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/, // watch?v=ID
    /youtu\.be\/([a-zA-Z0-9_-]{11})/, // youtu.be/ID
    /\/embed\/([a-zA-Z0-9_-]{11})/, // /embed/ID
    /\/shorts\/([a-zA-Z0-9_-]{11})/, // /shorts/ID
  ]
  for (const re of patterns) {
    const match = trimmed.match(re)
    if (match) return match[1]
  }
  return null
}

let apiPromise: Promise<YTNamespace> | null = null

/**
 * Loads the IFrame API script once and resolves with window.YT when ready.
 * Subsequent calls reuse the same promise.
 */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise

  apiPromise = new Promise<YTNamespace>((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT)
      return
    }

    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      if (window.YT) resolve(window.YT)
    }

    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
  })

  return apiPromise
}
