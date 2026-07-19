import { useRef, useState } from 'react'
import { extractVideoId } from '../audio/youtube'
import titleImage from '../assets/event-horizon_title.png'
import titleImageMobile from '../assets/event-horizon_title_mobile.png'

export type IntroSource =
  | { mode: 'youtube'; videoId: string }
  | { mode: 'file'; file: File }
  | { mode: 'demo' }

interface IntroPanelProps {
  onEnter: (source: IntroSource) => void
}

export function IntroPanel({ onEnter }: IntroPanelProps) {
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const acceptFile = (candidate: File | undefined | null) => {
    if (!candidate) return

    const isAudio =
      candidate.type.startsWith('audio/') || /\.mp3$/i.test(candidate.name)

    if (!isAudio) {
      setError('오디오 파일 또는 MP3 파일만 사용할 수 있습니다.')
      return
    }

    setError(null)
    setFile(candidate)
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    acceptFile(event.dataTransfer.files?.[0])
  }

  const handleEnter = () => {
    if (url.trim()) {
      const videoId = extractVideoId(url)
      if (!videoId) {
        setError('유효한 YouTube 주소가 아닙니다.')
        return
      }
      onEnter({ mode: 'youtube', videoId })
      return
    }

    if (file) {
      onEnter({ mode: 'file', file })
      return
    }

    onEnter({ mode: 'demo' })
  }

  return (
    <div className="intro">
      {/* Developer credit — top-right, with a blinking terminal cursor. */}
      <a className="dev-credit" href="mailto:uxui98@gmail.com">
        developer_Bogyeong Kang<span className="dev-cursor">_</span>
      </a>

      {/* Hero — sub-copy pinned above a dead-centre title. */}
      <div className="intro-hero">
        <p className="intro-body">
          우리는 소멸을 거스를 수 없다.
          <br />
          그러나 소멸을 향한 여정은 가장 격렬한 삶의 증거가 된다.
          <br />
          지금, 당신의 가장 뜨거운 순간을 온전히 감각하십시오.
        </p>
        <h1 className="intro-title">
          {/* Small tablets and below get the taller, more legible mobile title.
              Layout is unchanged — both render at the same .intro-title width. */}
          <picture>
            <source media="(max-width: 768px)" srcSet={titleImageMobile} />
            <img src={titleImage} alt="EVENT HORIZON" />
          </picture>
        </h1>
      </div>

      {/* Slim entry console at the bottom — inputs kept, but understated. */}
      <div className="intro-console">
        <div className="intro-tag">// DEEP-SPACE PROBE · SIGNAL LINK</div>

        <div className="intro-controls">
          <div className="intro-field">
            <label htmlFor="yt-url">외부 음원 · YOUTUBE URL</label>
            <input
              id="yt-url"
              type="text"
              inputMode="url"
              placeholder="https://www.youtube.com/watch?v=..."
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                setError(null)
              }}
            />
          </div>

          <div className="intro-field intro-field-file">
            <label>로컬 음원 · MP3</label>
            <div
              className={`dropzone${dragActive ? ' drag' : ''}${file ? ' has-file' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault()
                setDragActive(true)
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
            >
              {file ? (
                <span className="drop-file">선택됨 · {file.name}</span>
              ) : (
                <span className="drop-hint">파일 드롭 · 클릭 선택</span>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.mp3"
              hidden
              onChange={(event) => acceptFile(event.target.files?.[0])}
            />
          </div>
        </div>

        <div className="intro-actions">
          <button
            type="button"
            className="demo-link"
            onClick={() => onEnter({ mode: 'demo' })}
          >
            기본 데모 음원으로 시작하기
          </button>
          <button type="button" className="enter-btn" onClick={handleEnter}>
            궤적 진입
          </button>
        </div>

        {error && <p className="intro-error">{error}</p>}
      </div>
    </div>
  )
}
