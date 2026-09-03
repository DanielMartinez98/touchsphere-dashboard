import { useState, useRef, useEffect, lazy, Suspense, type ReactNode } from 'react'
import { Check, X as XIcon, RotateCw, ClipboardCopy, MessageSquare, Trash2, Volume2, Download, Pin } from 'lucide-react'
import { useAudioDevices } from '../hooks/useAudioDevices'
import { useDevice } from '../hooks/useDevice'
import { playSound, playRecordChime } from '../utils/sound'
import { useVolume, setVolume, getEffectiveGain, type VolumeCategory } from '../hooks/useVolume'
import { useWakeWordEnabled, setWakeWordEnabled, useWakeWordTranscript, useWakeWordStatus } from '../hooks/useWakeWord'
import { ASSISTANT_PROFILES, ASSISTANT_ORDER, AVATAR_MODELS, getAvatarModel, setAssistantId, useAssistant, type AssistantId, type AvatarSpec } from '../config/assistant'
import { useAvatarEnabled, setAvatarEnabled, useAvatarRuntime, useAvatarFps, useAvatarFraming, setAvatarFraming, resetAvatarFraming, useAvatarModelOverride, setAvatarModelId, ZOOM_MIN, ZOOM_MAX, OFFSET_MIN, OFFSET_MAX, type AvatarStatus } from '../hooks/useAvatar'
import { GESTURE_CUES, FACE_CUES, dispatchCue } from '../utils/avatarCues'
import { useVoicePitch, setVoicePitch, PITCH_MIN, PITCH_MAX } from '../hooks/useVoicePitch'
import { playVoicePreview } from '../utils/voicePreview'
import { useAutoSchedule, fireBedtimeAlert } from '../hooks/useAutoSchedule'
import { useRipple } from '../hooks/useRipple'
import { useDebugLog, clearDebugLog, getDebugLog } from '../utils/debugLog'
import { useMemory, MEMORY_TOPICS, type MemoryItem, type MemoryKind, type MemoryTopic } from '../hooks/useMemory'
import { useGuides } from '../hooks/useGuides'
import { useImages } from '../hooks/useImages'
import type { ParamsResponse } from '../hooks/useImages'
import { useGuideActivity, type ActivityLevel } from '../hooks/useGuideActivity'
import { useHost, useHostEnabled, type HostTask } from '../hooks/useHost'
import { TouchInput } from './TouchInput'

type Tab = 'assistant' | 'vtuber' | 'sounds' | 'hardware' | 'schedule' | 'memory' | 'guides' | 'drawing' | 'system' | 'server' | 'debug'

// The preview reuses the dashboard's own renderers. Lazy, same chunks App
// splits out — opening the VTuber tab is what pulls in the heavy deps, and
// only if the user actually goes there.
const AvatarRenderer = lazy(() => import('./Avatar/Avatar'))
const Live2DRenderer = lazy(() => import('./Avatar/Live2DAvatar'))

type SoundCategory = 'sfx' | 'music' | 'voice'

const SOUNDS: { id: string; label: string; subtitle: string; url: string; bg: string; fg: string; category: SoundCategory }[] = [
  { id: 'startup',  label: 'Startup Chime',          subtitle: '/start.mp3',                  url: '/start.mp3',                  bg: 'bg-amber-500/15',   fg: 'text-amber-400',   category: 'sfx'   },
  { id: 'bouncin',  label: 'Sudoku Masters Bouncin', subtitle: '/sudoku-masters-bouncin.wav', url: '/sudoku-masters-bouncin.wav', bg: 'bg-fuchsia-500/15', fg: 'text-fuchsia-400', category: 'music' },
]

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function SettingsPanel({ hideButton = false }: { hideButton?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  // The phone layout has no gear of its own; its tab bar asks for the panel
  // by event, the same way the corners are asked for by voice.
  useEffect(() => {
    const on = () => setOpen(true)
    window.addEventListener('ts:open-settings', on)
    return () => window.removeEventListener('ts:open-settings', on)
  }, [])
  const [tab, setTab] = useState<Tab>('assistant')
  const hostEnabled = useHostEnabled()
  const [confirmClose, setConfirmClose] = useState(false)
  const [playingSoundId, setPlayingSoundId] = useState<string | null>(null)
  const [ttsTesting, setTtsTesting] = useState(false)
  const [ttsStatus,  setTtsStatus]  = useState<string | null>(null)

  // ── Transcription test state ─────────────────────────────────────────────
  const [sttRecording,  setSttRecording]  = useState(false)
  const [sttUploading,  setSttUploading]  = useState(false)
  const [sttTranscript, setSttTranscript] = useState<string>('')
  const [sttError,      setSttError]      = useState<string | null>(null)
  // Object URL for the most recent recording — used for the "tape playback".
  const [sttClipUrl,    setSttClipUrl]    = useState<string | null>(null)
  const [sttClipBytes,  setSttClipBytes]  = useState<number>(0)
  const [sttPlaying,    setSttPlaying]    = useState(false)
  const sttStreamRef   = useRef<MediaStream    | null>(null)
  const sttRecorderRef = useRef<MediaRecorder  | null>(null)
  const sttChunksRef   = useRef<Blob[]>([])
  const sttAudioRef    = useRef<HTMLAudioElement | null>(null)

  function stopSttStream() {
    sttStreamRef.current?.getTracks().forEach(t => t.stop())
    sttStreamRef.current = null
    sttRecorderRef.current = null
  }

  async function handleSttToggle() {
    // If currently recording → stop and let onstop handle the upload.
    if (sttRecording) {
      const rec = sttRecorderRef.current
      try {
        if (rec && rec.state !== 'inactive') rec.stop()
      } catch (err) {
        console.warn('[stt-test] stop failed:', err)
      }
      setSttRecording(false)
      void playRecordChime('down')
      return
    }
    if (sttUploading) return

    setSttError(null)
    setSttTranscript('')
    // Free any previous clip before starting a fresh recording.
    if (sttClipUrl) {
      try { URL.revokeObjectURL(sttClipUrl) } catch { /* ignore */ }
      setSttClipUrl(null)
    }
    if (sttAudioRef.current) {
      try { sttAudioRef.current.pause() } catch { /* ignore */ }
      sttAudioRef.current = null
    }
    setSttPlaying(false)

    if (!navigator.mediaDevices?.getUserMedia) {
      setSttError('getUserMedia unavailable — page must be HTTPS.')
      return
    }

    let stream: MediaStream
    try {
      // Honor the device selected in the Hardware tab. 'default' = let the OS pick.
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000,
      }
      if (selectedInputId && selectedInputId !== 'default') {
        audioConstraints.deviceId = { exact: selectedInputId }
      }
      console.log('[stt-test] requesting mic with constraints:', audioConstraints)
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      const track = stream.getAudioTracks()[0]
      console.log('[stt-test] got track:', track?.label, track?.getSettings?.())
    } catch (err) {
      setSttError(`Mic permission denied: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    sttStreamRef.current = stream

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    const rec  = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
    sttRecorderRef.current = rec
    sttChunksRef.current = []

    rec.ondataavailable = (e) => { if (e.data.size > 0) sttChunksRef.current.push(e.data) }
    rec.onstop = async () => {
      const blob = new Blob(sttChunksRef.current, { type: mime })
      stopSttStream()
      console.log('[stt-test] recording stopped — blob size:', blob.size, 'bytes,', 'type:', blob.type)
      if (blob.size === 0) {
        setSttError('No audio captured.')
        return
      }
      // Stash the recording so we can play it back after transcription.
      const clipUrl = URL.createObjectURL(blob)
      setSttClipUrl(clipUrl)
      setSttClipBytes(blob.size)
      setSttUploading(true)
      try {
        const API = (import.meta.env.VITE_AUDIO_API as string | undefined) ?? ''
        const fd  = new FormData()
        fd.append('audio', blob, `clip-${Date.now()}.webm`)
        const res = await fetch(`${API}/api/stt`, { method: 'POST', body: fd })
        if (!res.ok) {
          const detail = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`)
        }
        const json = (await res.json()) as { text?: string; language_code?: string }
        setSttTranscript((json.text ?? '').trim() || '(no speech detected)')
      } catch (err) {
        setSttError(err instanceof Error ? err.message : String(err))
      } finally {
        setSttUploading(false)
        // Auto-play the "tape" once transcription is done so you can verify
        // what the mic actually captured.
        playSttClip(clipUrl)
      }
    }
    rec.onerror = (e) => {
      console.warn('[stt-test] recorder error:', e)
      stopSttStream()
      setSttRecording(false)
      setSttError('Recorder error.')
    }

    setSttRecording(true)
    // Play the "start" chime first and wait for it to finish, otherwise the
    // beep ends up at the head of the recording and Scribe can mistake it for
    // (or be drowned out by) the actual speech.
    void playRecordChime('up')
    window.setTimeout(() => {
      try { rec.start(250) } catch (err) { console.warn('[stt-test] rec.start failed:', err) }
    }, 260)
  }

  // Plays the most recent recording back through the SELECTED audio output.
  // Uses an HTMLAudioElement (not WebAudio) so we can call setSinkId() to
  // route to whichever speaker is picked in the Hardware tab — WebAudio has
  // no equivalent. Falls back to default sink if setSinkId is unsupported.
  function playSttClip(url?: string | null) {
    const target = url ?? sttClipUrl
    if (!target) return
    // Stop any prior playback first.
    if (sttAudioRef.current) {
      try { sttAudioRef.current.pause() } catch { /* ignore */ }
      sttAudioRef.current = null
    }
    const audio = new Audio(target)
    // Volume slider integration: master * sfx (mic playback isn't "voice" TTS).
    audio.volume = Math.max(0, Math.min(1, getEffectiveGain('sfx')))
    audio.onended = () => {
      setSttPlaying(false)
      if (sttAudioRef.current === audio) sttAudioRef.current = null
    }
    audio.onerror = () => {
      setSttPlaying(false)
      if (sttAudioRef.current === audio) sttAudioRef.current = null
    }
    sttAudioRef.current = audio
    setSttPlaying(true)

    // Route to the selected output sink if the browser supports it.
    type AudioWithSink = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    const a = audio as AudioWithSink
    const startPlayback = () => {
      audio.play().catch(err => {
        console.warn('[stt-test] playback failed:', err)
        setSttPlaying(false)
        sttAudioRef.current = null
      })
    }
    if (selectedOutputId && selectedOutputId !== 'default' && typeof a.setSinkId === 'function') {
      console.log('[stt-test] routing playback to sink:', selectedOutputId)
      a.setSinkId(selectedOutputId)
        .then(startPlayback)
        .catch(err => {
          console.warn('[stt-test] setSinkId failed, falling back to default:', err)
          startPlayback()
        })
    } else {
      startPlayback()
    }
  }

  async function handlePlaySound(id: string, url: string, category: SoundCategory) {
    if (playingSoundId) return
    setPlayingSoundId(id)
    try {
      await playSound(url, category)
    } finally {
      window.setTimeout(() => setPlayingSoundId(null), 1200)
    }
  }

  // Speak "testing" three times via the server-side /api/tts endpoint.
  // Uses the same WebAudio path as playSound() (which is known to route to
  // the active output sink — e.g. Bluetooth A2DP). Surfaces every failure
  // mode in the UI so we can debug network / synth / decode issues live.
  async function handleTestTts() {
    if (ttsTesting) return
    setTtsTesting(true)
    setTtsStatus('Fetching…')
    try {
      const API = (import.meta.env.VITE_AUDIO_API as string | undefined) ?? ''
      const url = `${API}/api/tts?text=${encodeURIComponent('testing testing testing')}`
      console.log('[tts-test] GET', url)
      const res = await fetch(url)
      console.log('[tts-test] status', res.status, 'content-type', res.headers.get('content-type'))
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`)
      }
      const arrayBuf = await res.arrayBuffer()
      console.log('[tts-test] WAV bytes', arrayBuf.byteLength)
      if (arrayBuf.byteLength < 100) {
        throw new Error(`WAV too small (${arrayBuf.byteLength} bytes)`)
      }
      setTtsStatus(`Decoding (${arrayBuf.byteLength} bytes)…`)

      const Ctor = window.AudioContext
        || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor()
      if (ctx.state === 'suspended') {
        try { await ctx.resume() } catch { /* ignore */ }
      }
      const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
        try {
          const p = ctx.decodeAudioData(arrayBuf, resolve, reject)
          if (p && typeof (p as Promise<AudioBuffer>).then === 'function') {
            (p as Promise<AudioBuffer>).then(resolve, reject)
          }
        } catch (err) { reject(err as Error) }
      })
      console.log('[tts-test] decoded', buffer.duration.toFixed(2), 's,', buffer.sampleRate, 'Hz,', buffer.numberOfChannels, 'ch')
      setTtsStatus(`Playing (${buffer.duration.toFixed(1)}s @ ${buffer.sampleRate}Hz)…`)

      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource()
        src.buffer = buffer
        // Apply voice gain (master * voice) so the test reflects the slider.
        const gain = ctx.createGain()
        gain.gain.value = getEffectiveGain('voice')
        src.connect(gain)
        gain.connect(ctx.destination)
        src.onended = () => resolve()
        src.start(0)
      })
      setTtsStatus(`OK — played ${buffer.duration.toFixed(1)}s. If you heard nothing, the audio sink isn't your BT speaker.`)
      console.log('[tts-test] playback finished')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[tts-test] failed:', msg)
      setTtsStatus(`Error: ${msg}`)
    } finally {
      setTtsTesting(false)
    }
  }

  const { metrics: device } = useDevice()
  const wakeWordEnabled = useWakeWordEnabled()
  const wakeTranscript  = useWakeWordTranscript()
  const wakeStatus      = useWakeWordStatus()
  const assistant       = useAssistant()
  const voicePitch      = useVoicePitch(assistant.id)
  const [pitchPreviewing, setPitchPreviewing] = useState(false)
  const avatarEnabled   = useAvatarEnabled()
  const avatarRuntime   = useAvatarRuntime()

  // Speak the assistant's sample line at a specific transpose. Passes ?pitch=
  // explicitly rather than relying on the saved value, so you hear the slider's
  // CURRENT position immediately — the debounced save to the server may not have
  // landed yet, and waiting for it would make the preview feel broken.
  const previewPitch = async (semitones: number) => {
    setPitchPreviewing(true)
    try {
      const url = `/api/tts?as=${assistant.id}`
        + `&pitch=${semitones}`
        + `&text=${encodeURIComponent(assistant.sampleLine)}`
      const audio = new Audio(url)
      audio.volume = Math.max(0, Math.min(1, getEffectiveGain('voice')))
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve()
        audio.onerror = () => resolve()
        void audio.play().catch(() => resolve())
      })
    } finally {
      setPitchPreviewing(false)
    }
  }
  const modelOverride   = useAvatarModelOverride(assistant.id)
  const avatarModelId   = modelOverride ?? assistant.defaultModelId
  const avatarModel     = getAvatarModel(avatarModelId) ?? getAvatarModel(assistant.defaultModelId)!
  const avatarSpec      = avatarModel.spec
  const avatarIsSphere  = avatarSpec.kind === 'sphere'
  // Framing describes how a MODEL sits in frame, so it's keyed by model — two
  // assistants wearing the same face share the same good framing.
  const avatarFraming   = useAvatarFraming(avatarModel.id)
  const avatarFps       = useAvatarFps()
  const [previewingId, setPreviewingId] = useState<AssistantId | null>(null)

  // Select an assistant AND play a short in-character clip so the user hears the
  // voice + personality. The clip's onEnded clears the "playing" indicator.
  const handlePickAssistant = (id: AssistantId) => {
    setAssistantId(id)
    setPreviewingId(id)
    playVoicePreview(id, ASSISTANT_PROFILES[id].sampleLine, () =>
      setPreviewingId(cur => (cur === id ? null : cur)),
    )
  }

  const {
    inputDevices,
    outputDevices,
    selectedInputId,
    selectedOutputId,
    setSelectedInput,
    setSelectedOutput,
    loading: devicesLoading,
    error:   devicesError,
    refresh: refreshDevices,
  } = useAudioDevices()

  function handleCloseApp() {
    if (!confirmClose) {
      setConfirmClose(true)
      return
    }
    fetch('/api/system/restart', { method: 'POST' }).catch(() => {})
  }

  function closePanel() {
    setOpen(false)
    setConfirmClose(false)
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'assistant', label: 'Assistant' },
    { id: 'vtuber',    label: 'VTuber'    },
    { id: 'sounds',    label: 'Audio'     },
    { id: 'hardware',  label: 'Hardware'  },
    { id: 'schedule',  label: 'Schedule'  },
    { id: 'memory',    label: 'Memory'    },
    { id: 'guides',    label: 'Guides'    },
    { id: 'drawing',   label: 'Drawing'   },
    { id: 'system',    label: 'System'    },
    // Only when the server says it is set up: an "update the host" tab that
    // can't reach a host is a tab full of broken buttons.
    ...(hostEnabled ? [{ id: 'server' as const, label: 'Server' }] : []),
    { id: 'debug',     label: 'Debug'     },
  ]

  const { schedule, updateSchedule } = useAutoSchedule()
  const { onPointerDown: gearPointerDown, rippleLayer: gearRipple } = useRipple()

  return (
    <>
      {/* Settings gear button — bottom center, enlarged. Offset half a slot left
          so the gear + mic-mute pair reads as centered (see MicMuteButton). */}
      {!hideButton && <button
        onClick={() => setOpen(true)}
        onPointerDown={gearPointerDown}
        className="absolute bottom-3 sm:bottom-5 left-[calc(50%-30px)] sm:left-[calc(50%-38px)] -translate-x-1/2 z-20 w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-white/10 border-2 border-white/40 flex items-center justify-center text-white/70 hover:bg-white/20 hover:text-white active:scale-90 transition-all backdrop-blur-md shadow-lg overflow-hidden"
        aria-label="Settings"
      >
        {gearRipple}
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>}

      {/* Full-screen settings overlay */}
      {open && (
        <div className="fixed inset-0 z-[500] bg-black/90 backdrop-blur-md flex flex-col">

          {/* ── Header ── */}
          <div className="flex items-center justify-between px-6 pt-6 pb-4 flex-shrink-0">
            <h2 className="text-white/80 text-lg font-semibold tracking-wide">Settings</h2>
            <button
              onClick={closePanel}
              className="w-9 h-9 rounded-full bg-white/10 border border-white/15 flex items-center justify-center text-white/50 hover:text-white/90 hover:bg-white/15 active:scale-90 transition-all"
              aria-label="Close settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* ── Tab bar ──
              Wraps rather than squeezing: at nine tabs on a 720px screen, one
              row puts every label under a fingertip's width. min-w keeps a
              wrapped row from stretching two buttons across the panel. */}
          <div className="flex flex-wrap gap-1.5 px-6 pb-4 flex-shrink-0">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 min-w-[110px] py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95 ${
                  tab === t.id
                    ? 'bg-white/15 text-white border border-white/20'
                    : 'bg-white/5 text-white/40 border border-transparent hover:bg-white/8 hover:text-white/60'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* ── Tab content ── */}
          <div className="flex-1 overflow-y-auto px-6 pb-8">

            {/* Sounds tab (labeled "Audio" in the tab bar) */}
            {tab === 'sounds' && (
              <div className="space-y-4 max-w-lg mx-auto">
                {/* ── Volume sliders ── */}
                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">Volume</span>
                <div className="bg-white/5 rounded-2xl border border-white/8 p-5 space-y-4">
                  <VolumeSlider category="master" label="Master"        accent="text-white"        track="accent-white"          />
                  <VolumeSlider category="sfx"    label="Sound Effects" accent="text-amber-400"    track="accent-amber-400"      />
                  <VolumeSlider category="music"  label="Music"         accent="text-fuchsia-400"  track="accent-fuchsia-400"    />
                  <VolumeSlider category="voice"  label="Voice"         accent="text-emerald-400"  track="accent-emerald-400"    />
                </div>

                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mt-6 mb-2">Chimes</span>

                <div className="bg-white/5 rounded-2xl border border-white/8 overflow-hidden divide-y divide-white/8">
                  {SOUNDS.map(s => {
                    const isPlaying = playingSoundId === s.id
                    const disabled  = playingSoundId !== null && !isPlaying
                    return (
                      <button
                        key={s.id}
                        onClick={() => void handlePlaySound(s.id, s.url, s.category)}
                        disabled={isPlaying || disabled}
                        className="w-full flex items-center gap-4 px-5 py-5 text-white/80 hover:bg-white/8 active:bg-white/12 transition-colors disabled:opacity-50"
                      >
                        <div className={`w-9 h-9 rounded-xl ${s.bg} flex items-center justify-center flex-shrink-0`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={s.fg}>
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                        </div>
                        <div className="text-left flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{s.label}</p>
                          <p className="text-white/40 text-xs mt-0.5 truncate">{s.subtitle}</p>
                        </div>
                        <span className="text-white/40 text-xs flex-shrink-0">
                          {isPlaying ? 'Playing…' : 'Play'}
                        </span>
                      </button>
                    )
                  })}
                </div>

                {/* TTS test — hits /api/tts and plays via WebAudio.
                    Useful for debugging why voice replies aren't audible. */}
                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mt-6 mb-2">Voice (TTS)</span>
                <div className="bg-white/5 rounded-2xl p-5 space-y-3 border border-white/8">
                  <div className="flex items-center gap-2.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400 flex-shrink-0">
                      <path d="M3 10v4a1 1 0 0 0 1 1h3l4 4V5L7 9H4a1 1 0 0 0-1 1z" />
                      <path d="M16 8a5 5 0 0 1 0 8" />
                      <path d="M19 5a9 9 0 0 1 0 14" />
                    </svg>
                    <span className="text-white/70 text-sm font-medium">Server-side TTS</span>
                  </div>
                  <button
                    onClick={() => void handleTestTts()}
                    disabled={ttsTesting}
                    className="w-full py-3 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 active:bg-emerald-500/40 disabled:opacity-50 text-emerald-300 text-sm font-medium border border-emerald-500/30 transition-colors"
                  >
                    {ttsTesting ? 'Testing…' : 'Say “testing testing testing”'}
                  </button>
                  {ttsStatus && (
                    <p className="text-white/50 text-xs leading-relaxed font-mono break-words">
                      {ttsStatus}
                    </p>
                  )}
                </div>

                {/* Transcribe (STT) test — records mic audio, uploads to /api/stt,
                    and shows what ElevenLabs Scribe heard. Tap once to start,
                    again to stop and transcribe. */}
                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mt-6 mb-2">Transcribe (STT)</span>
                <div className="bg-white/5 rounded-2xl p-5 space-y-3 border border-white/8">
                  <div className="flex items-center gap-2.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-violet-400 flex-shrink-0">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                      <line x1="8" y1="23" x2="16" y2="23" />
                    </svg>
                    <span className="text-white/70 text-sm font-medium">Mic → ElevenLabs Scribe</span>
                  </div>
                  <button
                    onClick={() => void handleSttToggle()}
                    disabled={sttUploading}
                    className={`w-full py-3 rounded-xl text-sm font-medium border transition-colors active:scale-[0.99] disabled:opacity-50 ${
                      sttRecording
                        ? 'bg-red-500/25 hover:bg-red-500/35 text-red-200 border-red-500/40 animate-pulse'
                        : 'bg-violet-500/20 hover:bg-violet-500/30 active:bg-violet-500/40 text-violet-300 border-violet-500/30'
                    }`}
                  >
                    {sttRecording
                      ? 'Stop & Transcribe'
                      : sttUploading
                        ? 'Transcribing…'
                        : 'Start Recording'}
                  </button>
                  {sttTranscript && (
                    <div className="bg-violet-500/10 border border-violet-500/25 rounded-xl px-4 py-3">
                      <p className="text-violet-200 text-sm leading-relaxed break-words">
                        “{sttTranscript}”
                      </p>
                    </div>
                  )}
                  {sttClipUrl && (
                    <button
                      onClick={() => playSttClip()}
                      disabled={sttPlaying}
                      className="w-full py-2.5 rounded-xl bg-white/8 hover:bg-white/12 active:bg-white/15 disabled:opacity-50 text-white/70 text-xs font-medium border border-white/10 transition-colors flex items-center justify-center gap-2"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      {sttPlaying ? 'Playing recording…' : `Replay recording (${(sttClipBytes / 1024).toFixed(1)} KB)`}
                    </button>
                  )}
                  {sttError && (
                    <p className="text-red-400/80 text-xs leading-relaxed font-mono break-words">
                      {sttError}
                    </p>
                  )}
                  <p className="text-white/30 text-xs leading-relaxed">
                    Tap “Start Recording”, speak a sentence, then tap “Stop & Transcribe” to verify the mic and STT pipeline are working.
                  </p>
                </div>
              </div>
            )}

            {/* Assistant tab — everything about WHO the assistant is: identity,
                voice, face (avatar + animations), and how you summon it. Split
                out of the Audio tab, which had grown into a full-page scroll
                that buried all of this. */}
            {tab === 'assistant' && (
              <div className="space-y-4 max-w-lg mx-auto">
                {/* Assistant picker — selects the AI's name, wake word,
                    personality, and voice all at once. The choice is persisted
                    server-side so the chat persona and TTS voice follow it. */}
                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">Assistant</span>
                <div className="bg-white/5 rounded-2xl p-3 space-y-2 border border-white/8">
                  {ASSISTANT_ORDER.map(id => {
                    const p = ASSISTANT_PROFILES[id]
                    const active = assistant.id === id
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => handlePickAssistant(id)}
                        aria-pressed={active}
                        className={`w-full text-left rounded-xl px-4 py-3 border transition-colors flex items-center justify-between gap-3 ${
                          active ? 'bg-cyan-500/15 border-cyan-500/40' : 'bg-white/5 border-white/8 active:bg-white/10'
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block text-white/85 text-sm font-medium">{p.name}</span>
                          <span className="block text-white/40 text-xs mt-0.5 leading-relaxed">{p.tagline}</span>
                        </span>
                        {previewingId === id
                          ? <Volume2 size={18} className="text-cyan-300 flex-shrink-0 animate-pulse" />
                          : active
                            ? <Check size={18} className="text-cyan-300 flex-shrink-0" />
                            : null}
                      </button>
                    )
                  })}
                  <p className="text-white/30 text-xs leading-relaxed px-1 pt-1">
                    Switches the assistant's name, wake word, personality, and voice together.
                  </p>
                </div>

                {/* Voice pitch — only for assistants voiced through RVC. RVC swaps
                    timbre but inherits the source TTS voice's pitch, so a character
                    in a high register needs transposing to actually sit there. The
                    right value is ear-tuned, hence a slider with a live preview. */}
                {assistant.tunablePitch && (
                  <>
                    <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mt-6 mb-2">
                      {assistant.name}'s pitch
                    </span>
                    <div className="bg-white/5 rounded-2xl p-5 space-y-3 border border-white/8">
                      <div className="flex items-center justify-between">
                        <span className="text-white/70 text-sm font-medium">Transpose</span>
                        <span className="text-white/50 text-xs font-mono tabular-nums">
                          {voicePitch > 0 ? '+' : ''}{voicePitch} semitone{Math.abs(voicePitch) === 1 ? '' : 's'}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={PITCH_MIN}
                        max={PITCH_MAX}
                        step={1}
                        value={voicePitch}
                        onChange={e => setVoicePitch(assistant.id, Number(e.target.value))}
                        aria-label={`${assistant.name} voice pitch in semitones`}
                        className="w-full h-2 accent-cyan-400 cursor-pointer"
                      />

                      <button
                        type="button"
                        onClick={() => previewPitch(voicePitch)}
                        disabled={pitchPreviewing}
                        className="w-full rounded-xl px-4 py-3 bg-cyan-500/15 border border-cyan-500/40 active:bg-cyan-500/25 text-cyan-200 text-sm font-medium disabled:opacity-50"
                      >
                        {pitchPreviewing ? 'Synthesising…' : `Hear ${assistant.name} at this pitch`}
                      </button>

                      <p className="text-white/30 text-xs leading-relaxed">
                        Her voice is converted from a normal speaking voice, which sits lower
                        than she does — this lifts it into her range. 12 = one octave. Tune it
                        by ear: too low still sounds like an adult, too high goes squeaky.
                        Saved to the server, so the kiosk uses it too.
                      </p>
                    </div>
                  </>
                )}

              </div>
            )}

            {/* VTuber tab — the avatar as its own page, with a live preview
                beside the controls so you can SEE the character while flipping
                models, testing animations, and dialling in framing. (The
                fullscreen avatar is hidden behind this very overlay, which
                made all of that blind before.)

                Side by side rather than stacked: a preview tall enough to frame
                a character is most of a 1280px-high screen, so sitting it above
                the controls pushed them off the bottom and left the sliders you
                were adjusting invisible. Two columns give the character its
                height and the settings theirs. Stacks again below 640px, where
                there isn't width for both. */}
            {tab === 'vtuber' && (
              <div className="max-w-3xl mx-auto flex flex-col sm:flex-row items-start gap-4">
                {/* Left — live preview. Sticky, so the character stays in view
                    while the controls scroll past it. Mounted only while this
                    tab is open, so the kiosk never pays for a second renderer
                    in normal use. */}
                <div className="w-full sm:w-[280px] sm:flex-shrink-0 sticky top-0 z-10">
                  <VTuberPreview
                    spec={avatarSpec}
                    enabled={avatarEnabled}
                    zoom={avatarFraming.zoom}
                    offsetY={avatarFraming.offsetY}
                  />
                </div>

                {/* Right — every control, in its own scrolling column. */}
                <div className="w-full sm:flex-1 min-w-0 space-y-4">

                {/* Avatar — swaps the centre particle sphere for a 3D VRM model
                    that lip-syncs to the reply. Off by default. Turning it off
                    restores the sphere and leaves the audio path untouched. */}
                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">Avatar</span>
                <div className="bg-white/5 rounded-2xl p-5 space-y-3 border border-white/8">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-white/70 text-sm font-medium">Show avatar instead of the orb</p>
                      <p className="text-white/30 text-xs mt-0.5">
                        A character that lip-syncs to {assistant.name}'s replies, blinks, and follows your touch.
                      </p>
                    </div>
                    <button
                      onClick={() => setAvatarEnabled(!avatarEnabled)}
                      type="button"
                      aria-label={avatarEnabled ? 'Disable 3D avatar' : 'Enable 3D avatar'}
                      title={avatarEnabled ? 'Disable 3D avatar' : 'Enable 3D avatar'}
                      className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${
                        avatarEnabled ? 'bg-cyan-500/70' : 'bg-white/15'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform ${
                          avatarEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {/* Model picker — which face THIS assistant wears. Stored per
                      assistant, so each can have its own. "Orb" is a real choice,
                      not an absence: it's TouchSphere's actual identity. */}
                  {avatarEnabled && (
                    <div className="space-y-2">
                      <span className="text-white/40 text-xs">
                        {assistant.name}’s face
                      </span>
                      {AVATAR_MODELS.map(m => {
                        const active = avatarModelId === m.id
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => setAvatarModelId(assistant.id, m.id)}
                            aria-pressed={active}
                            className={`w-full text-left rounded-xl px-4 py-3 border transition-colors flex items-center justify-between gap-3 ${
                              active ? 'bg-cyan-500/15 border-cyan-500/40' : 'bg-white/5 border-white/8 active:bg-white/10'
                            }`}
                          >
                            <span className="min-w-0">
                              <span className="block text-white/85 text-sm font-medium">{m.label}</span>
                              <span className="block text-white/40 text-xs mt-0.5">{m.note}</span>
                            </span>
                            {active && <Check size={18} className="text-cyan-300 flex-shrink-0" />}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {avatarEnabled && avatarIsSphere && (
                    <p className="text-white/30 text-xs leading-relaxed">
                      The orb is {assistant.name}’s face. Pick a model above to give
                      it a character instead.
                    </p>
                  )}

                  {avatarEnabled && !avatarIsSphere && avatarRuntime.status === 'loading' && (
                    <p className="text-amber-300/80 text-xs leading-relaxed">Loading {assistant.name}'s model…</p>
                  )}

                  {/* The model isn't bundled — this is the "you still need to add
                      a .vrm" path, and the most likely thing a new user hits. */}
                  {avatarEnabled && !avatarIsSphere && avatarRuntime.status === 'error' && (
                    <div className="bg-black/30 rounded-xl px-4 py-3 border border-red-500/20 space-y-1">
                      <p className="text-red-300/90 text-xs font-medium">Couldn’t load {assistant.name}’s model — showing the orb.</p>
                      <p className="text-white/40 text-xs leading-relaxed">
                        Expected it at <span className="font-mono text-white/60">{avatarSpec.model}</span>,
                        served from <span className="font-mono text-white/60">client/public</span> in dev or the
                        server’s avatar mount in production.
                      </p>
                      {avatarRuntime.detail && (
                        <p className="text-white/30 text-xs font-mono break-words pt-1">{avatarRuntime.detail}</p>
                      )}
                    </div>
                  )}

                  {/* Animation test board — fires the exact cue events the LLM's
                      hidden [tags] produce, so tapping these exercises the same
                      code path as a real reply. Sits above framing because it's
                      the thing you come back for; framing is one-time setup. */}
                  {avatarEnabled && !avatarIsSphere && avatarRuntime.status === 'ready' && (
                    <div className="space-y-3 pt-1">
                      <span className="text-white/40 text-xs">Test animations</span>
                      <div className="grid grid-cols-3 gap-2">
                        {GESTURE_CUES.map(name => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => dispatchCue({ kind: 'gesture', name })}
                            className="rounded-xl px-2 py-2.5 bg-white/5 border border-white/8 active:bg-cyan-500/20 text-white/70 text-xs font-medium capitalize"
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                      <span className="text-white/40 text-xs">Test faces</span>
                      <div className="grid grid-cols-3 gap-2">
                        {FACE_CUES.map(name => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => dispatchCue({ kind: 'face', name })}
                            className="rounded-xl px-2 py-2.5 bg-white/5 border border-white/8 active:bg-cyan-500/20 text-white/70 text-xs font-medium capitalize"
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                      <p className="text-white/30 text-xs leading-relaxed">
                        Gestures play once; faces hold for a few seconds and fade.
                        These are the same cues the assistant sends invisibly inside
                        its replies.
                      </p>
                    </div>
                  )}

                  {/* Framing — models are authored at wildly different scales and
                      crops, so there's no default that suits every one of them.
                      Both sliders apply live, to whichever backend is active. */}
                  {avatarEnabled && !avatarIsSphere && avatarRuntime.status === 'ready' && (
                    <div className="space-y-3 pt-1">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-white/70 text-sm font-medium">Zoom</span>
                          <span className="text-white/50 text-xs font-mono tabular-nums">
                            {avatarFraming.zoom.toFixed(2)}×
                          </span>
                        </div>
                        <input
                          type="range"
                          min={ZOOM_MIN}
                          max={ZOOM_MAX}
                          step={0.05}
                          value={avatarFraming.zoom}
                          onChange={e => setAvatarFraming(avatarModel.id, { zoom: Number(e.target.value) })}
                          aria-label="Avatar zoom"
                          className="w-full h-2 accent-cyan-400 cursor-pointer"
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-white/70 text-sm font-medium">Vertical position</span>
                          <span className="text-white/50 text-xs font-mono tabular-nums">
                            {avatarFraming.offsetY > 0 ? '+' : ''}{Math.round(avatarFraming.offsetY * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min={OFFSET_MIN}
                          max={OFFSET_MAX}
                          step={0.01}
                          value={avatarFraming.offsetY}
                          onChange={e => setAvatarFraming(avatarModel.id, { offsetY: Number(e.target.value) })}
                          aria-label="Avatar vertical position"
                          className="w-full h-2 accent-cyan-400 cursor-pointer"
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => resetAvatarFraming(avatarModel.id)}
                        className="w-full rounded-xl px-3 py-2 bg-white/5 border border-white/8 active:bg-white/10 text-white/60 text-xs font-medium"
                      >
                        Reset framing
                      </button>
                      <p className="text-white/30 text-xs leading-relaxed">
                        Zooming in crops toward the middle of the model, so a full-body
                        character needs a positive vertical position to bring her face
                        back into frame. Try 2.4× and +28%.
                      </p>
                    </div>
                  )}

                  {/* Live framerate — the honest answer to "can the Pi run this?".
                      Anything below ~25 means turn it back off. */}
                  {avatarEnabled && !avatarIsSphere && avatarRuntime.status === 'ready' && (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-white/40 text-xs">Rendering at</span>
                      <span className={`text-xs font-mono px-2 py-1 rounded-md ${
                        avatarFps >= 40 ? 'bg-emerald-500/15 text-emerald-300' :
                        avatarFps >= 25 ? 'bg-amber-500/15   text-amber-300'   :
                                          'bg-red-500/15     text-red-300'
                      }`}>
                        {avatarFps} fps
                      </span>
                    </div>
                  )}
                </div>
                </div>
              </div>
            )}

            {/* Assistant tab, part two — wake word belongs with identity and
                voice, not with the avatar visuals. A second conditional block
                for the same tab: only one tab's blocks render at a time, and
                this keeps the big JSX sections intact. */}
            {tab === 'assistant' && (
              <div className="space-y-4 max-w-lg mx-auto">
                {/* Wake word — always-on offline detection via Vosk WASM. When
                    enabled, saying the selected assistant's wake phrase (e.g.
                    “Hey Martin”) activates it just like tapping the orb. The
                    model file (~40 MB) must be present at
                    /vosk-model-small-en-us-0.15.zip in public. */}
                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mt-6 mb-2">Wake Word</span>
                <div className="bg-white/5 rounded-2xl p-5 space-y-3 border border-white/8">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cyan-400 flex-shrink-0">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                        <line x1="9" y1="9" x2="9.01" y2="9" />
                        <line x1="15" y1="9" x2="15.01" y2="9" />
                      </svg>
                      <div className="min-w-0">
                        <p className="text-white/70 text-sm font-medium">Always listen for “{assistant.wakePhrase}”</p>
                        <p className="text-white/30 text-xs mt-0.5">Runs locally — audio never leaves the device until the wake word fires.</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setWakeWordEnabled(!wakeWordEnabled)}
                      type="button"
                      aria-label={wakeWordEnabled ? 'Disable wake word' : 'Enable wake word'}
                      title={wakeWordEnabled ? 'Disable wake word' : 'Enable wake word'}
                      className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${
                        wakeWordEnabled ? 'bg-cyan-500/70' : 'bg-white/15'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform ${
                          wakeWordEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                  {wakeWordEnabled && (
                    <p className="text-white/40 text-xs leading-relaxed">
                      First activation will download the speech model (~40 MB). Subsequent loads are instant.
                    </p>
                  )}
                </div>

                {/* Live wake-word diagnostics. Updates several times a second
                    while Vosk is listening so the user can see exactly what
                    the passive transcriber is hearing — useful for verifying
                    mic selection, distance, and pronunciation. */}
                {wakeWordEnabled && (
                  <div className="bg-white/5 rounded-2xl p-5 space-y-3 border border-white/8">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-white/70 text-sm font-medium">Live transcription</span>
                      <span className={`text-xs font-mono px-2 py-1 rounded-md ${
                        wakeStatus.status === 'listening' ? 'bg-emerald-500/15 text-emerald-300' :
                        wakeStatus.status === 'cooldown'  ? 'bg-cyan-500/15    text-cyan-300'    :
                        wakeStatus.status === 'loading'   ? 'bg-amber-500/15  text-amber-300 animate-pulse' :
                        wakeStatus.status === 'error'     ? 'bg-red-500/15    text-red-300'     :
                        wakeStatus.status === 'muted'     ? 'bg-red-500/15    text-red-300'     :
                                                            'bg-white/8       text-white/40'
                      }`}>
                        {wakeStatus.status === 'listening' ? '● listening'  :
                         wakeStatus.status === 'cooldown'  ? '● woke!'        :
                         wakeStatus.status === 'loading'   ? 'loading model…' :
                         wakeStatus.status === 'error'     ? 'error'           :
                         wakeStatus.status === 'muted'     ? 'muted'           :
                                                             'idle'}
                      </span>
                    </div>

                    {wakeStatus.error && (
                      <p className="text-red-400/80 text-xs leading-relaxed font-mono break-words">
                        {wakeStatus.error}
                      </p>
                    )}

                    {/* Final transcript: dim, last fully-committed phrase. */}
                    {wakeTranscript.final && (
                      <div className="bg-black/30 rounded-xl px-4 py-2 border border-white/5">
                        <p className="text-white/45 text-xs uppercase tracking-widest mb-1">Last phrase</p>
                        <p className="text-white/75 text-sm break-words">{wakeTranscript.final}</p>
                      </div>
                    )}

                    {/* Live partial: bright cyan, italic, updates in real time. */}
                    <div className="bg-cyan-500/8 rounded-xl px-4 py-3 border border-cyan-500/20 min-h-[3.5rem] flex items-center">
                      {wakeTranscript.partial ? (
                        <p className="text-cyan-200 text-sm leading-relaxed italic break-words">
                          {wakeTranscript.partial}…
                        </p>
                      ) : (
                        <p className="text-white/30 text-xs italic">
                          {wakeStatus.status === 'listening'
                            ? 'Speak — anything you say will appear here.'
                            : wakeStatus.status === 'loading'
                              ? 'Loading speech model…'
                              : '—'}
                        </p>
                      )}
                    </div>

                    <p className="text-white/30 text-xs leading-relaxed">
                      Audio is processed locally and never sent over the network. Say “{assistant.wakePhrase}” to trigger the assistant.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Hardware tab */}
            {tab === 'hardware' && (
              <div className="space-y-4 max-w-lg mx-auto">
                {/* ── Audio Devices (mic + speaker selectors) ── */}
                <div className="flex items-center justify-between">
                  <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">Audio Devices</span>
                  <button
                    onClick={() => void refreshDevices()}
                    disabled={devicesLoading}
                    className="flex items-center gap-1.5 text-white/30 hover:text-white/60 active:scale-90 transition-all disabled:opacity-30 text-xs"
                    aria-label="Refresh audio devices"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      className={devicesLoading ? 'animate-spin' : ''}>
                      <polyline points="23 4 23 10 17 10" />
                      <polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    Refresh
                  </button>
                </div>

                {/* Microphone */}
                <div className="bg-white/5 rounded-2xl p-5 space-y-3 border border-white/8">
                  <div className="flex items-center gap-2.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cyan-400 flex-shrink-0">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                      <line x1="8" y1="23" x2="16" y2="23" />
                    </svg>
                    <span className="text-white/70 text-sm font-medium">Microphone</span>
                  </div>
                  {devicesError ? (
                    <p className="text-red-400/70 text-sm leading-relaxed">{devicesError}</p>
                  ) : devicesLoading ? (
                    <p className="text-white/30 text-sm">Scanning…</p>
                  ) : inputDevices.length === 0 ? (
                    <p className="text-white/30 text-sm">No microphones found</p>
                  ) : (
                    <select
                      value={selectedInputId}
                      onChange={e => setSelectedInput(e.target.value)}
                      title="Select microphone"
                      className="w-full bg-white/8 border border-white/12 rounded-xl px-4 py-3 text-white/80 text-sm appearance-none cursor-pointer focus:outline-none focus:border-cyan-500/50 focus:bg-white/10"
                    >
                      {inputDevices.map(d => (
                        <option key={d.deviceId} value={d.deviceId} className="bg-[#1a1a1a]">
                          {d.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Speaker */}
                <div className="bg-white/5 rounded-2xl p-5 space-y-3 border border-white/8">
                  <div className="flex items-center gap-2.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400 flex-shrink-0">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                    <span className="text-white/70 text-sm font-medium">Speaker</span>
                  </div>
                  {devicesError ? (
                    <p className="text-red-400/70 text-sm leading-relaxed">{devicesError}</p>
                  ) : devicesLoading ? (
                    <p className="text-white/30 text-sm">Scanning…</p>
                  ) : outputDevices.length === 0 ? (
                    <p className="text-white/30 text-sm">No speakers found</p>
                  ) : (
                    <select
                      value={selectedOutputId}
                      onChange={e => setSelectedOutput(e.target.value)}
                      title="Select speaker"
                      className="w-full bg-white/8 border border-white/12 rounded-xl px-4 py-3 text-white/80 text-sm appearance-none cursor-pointer focus:outline-none focus:border-amber-500/50 focus:bg-white/10"
                    >
                      {outputDevices.map(d => (
                        <option key={d.deviceId} value={d.deviceId} className="bg-[#1a1a1a]">
                          {d.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mt-6 mb-2">Pi Metrics</span>

                {/* CPU Temp */}
                <div className="bg-white/5 rounded-2xl px-5 py-4 flex items-center justify-between border border-white/8">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-rose-500/15 flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-rose-400">
                        <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-white/70 text-sm font-medium">CPU Temperature</p>
                      <p className="text-white/30 text-xs">thermal_zone0</p>
                    </div>
                  </div>
                  <span className="text-white/80 text-base font-mono font-semibold">
                    {device ? (device.cpuTempC !== null ? `${device.cpuTempC}°C` : 'N/A') : '—'}
                  </span>
                </div>

                {/* Memory */}
                <div className="bg-white/5 rounded-2xl px-5 py-4 border border-white/8 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-sky-500/15 flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sky-400">
                        <rect x="2" y="6" width="20" height="12" rx="2" />
                        <line x1="6" y1="10" x2="6" y2="14" />
                        <line x1="10" y1="10" x2="10" y2="14" />
                        <line x1="14" y1="10" x2="14" y2="14" />
                        <line x1="18" y1="10" x2="18" y2="14" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <p className="text-white/70 text-sm font-medium">Memory</p>
                      <p className="text-white/30 text-xs">
                        {device ? `${device.memAvailableMB} MB free of ${device.memTotalMB} MB` : '—'}
                      </p>
                    </div>
                    <span className="text-white/80 text-base font-mono font-semibold">
                      {device ? `${device.memUsedPct}%` : '—'}
                    </span>
                  </div>
                  {device && (
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-sky-500/60 rounded-full transition-all"
                        style={{ width: `${device.memUsedPct}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Load Average */}
                <div className="bg-white/5 rounded-2xl px-5 py-4 flex items-center justify-between border border-white/8">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-violet-500/15 flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-violet-400">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-white/70 text-sm font-medium">Load Average</p>
                      <p className="text-white/30 text-xs">{device ? `${device.cpuCount} cores` : '—'}</p>
                    </div>
                  </div>
                  <span className="text-white/80 text-sm font-mono font-semibold">
                    {device ? `${device.loadAvg1} · ${device.loadAvg5} · ${device.loadAvg15}` : '—'}
                  </span>
                </div>

                {/* Uptime */}
                <div className="bg-white/5 rounded-2xl px-5 py-4 flex items-center justify-between border border-white/8">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-white/70 text-sm font-medium">Uptime</p>
                      <p className="text-white/30 text-xs">{device?.hostname ?? '—'}</p>
                    </div>
                  </div>
                  <span className="text-white/80 text-base font-mono font-semibold">
                    {device ? formatUptime(device.uptimeSeconds) : '—'}
                  </span>
                </div>
              </div>
            )}

            {/* Schedule tab — Work & Rest hours + bedtime alert */}
            {tab === 'schedule' && (
              <div className="space-y-4 max-w-lg mx-auto">
                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">Work &amp; Rest Hours</span>

                {/* Enable toggle */}
                <div className="bg-white/5 rounded-2xl p-5 border border-white/8 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-white/70 text-sm font-medium">Auto switch modes</p>
                    <p className="text-white/30 text-xs mt-0.5">
                      Flip between work and rest at the times below. Bedtime fires a one-time alert.
                    </p>
                  </div>
                  <button
                    onClick={() => updateSchedule({ enabled: !schedule.enabled })}
                    type="button"
                    aria-label={schedule.enabled ? 'Disable schedule' : 'Enable schedule'}
                    className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${
                      schedule.enabled ? 'bg-emerald-500/70' : 'bg-white/15'
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform ${
                        schedule.enabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Time inputs */}
                <div className={`bg-white/5 rounded-2xl p-5 border border-white/8 space-y-4 ${schedule.enabled ? '' : 'opacity-60'}`}>
                  <label className="block">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-white/70 text-sm font-medium">Work starts</span>
                      <span className="text-cyan-300/80 text-xs font-mono">{schedule.workStart}</span>
                    </div>
                    <input
                      type="time"
                      value={schedule.workStart}
                      onChange={e => updateSchedule({ workStart: e.target.value })}
                      className="w-full bg-white/8 border border-white/12 rounded-xl px-4 py-3 text-white/90 text-base font-mono focus:outline-none focus:border-cyan-500/50"
                    />
                  </label>

                  <label className="block">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-white/70 text-sm font-medium">Rest starts</span>
                      <span className="text-fuchsia-300/80 text-xs font-mono">{schedule.restStart}</span>
                    </div>
                    <input
                      type="time"
                      value={schedule.restStart}
                      onChange={e => updateSchedule({ restStart: e.target.value })}
                      className="w-full bg-white/8 border border-white/12 rounded-xl px-4 py-3 text-white/90 text-base font-mono focus:outline-none focus:border-fuchsia-500/50"
                    />
                  </label>

                  <label className="block">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-white/70 text-sm font-medium">Bedtime alert</span>
                      <span className="text-indigo-300/80 text-xs font-mono">{schedule.bedtime}</span>
                    </div>
                    <input
                      type="time"
                      value={schedule.bedtime}
                      onChange={e => updateSchedule({ bedtime: e.target.value })}
                      className="w-full bg-white/8 border border-white/12 rounded-xl px-4 py-3 text-white/90 text-base font-mono focus:outline-none focus:border-indigo-500/50"
                    />
                  </label>
                </div>

                {/* Test button */}
                <button
                  onClick={() => fireBedtimeAlert()}
                  className="w-full py-3 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 active:bg-indigo-500/40 text-indigo-200 text-sm font-medium border border-indigo-500/30 transition-colors"
                >
                  Test bedtime alert
                </button>

                <p className="text-white/30 text-xs leading-relaxed">
                  Times use the device's local clock. The bedtime alert fires once per day. Locked mode is never overridden — auto switching resumes after unlock.
                </p>
              </div>
            )}

            {/* System tab */}
            {tab === 'system' && (
              <div className="space-y-4 max-w-lg mx-auto">
                <NotionMePicker />

                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">Actions</span>

                <div className="bg-white/5 rounded-2xl border border-white/8 overflow-hidden">
                  {!confirmClose ? (
                    <button
                      onClick={handleCloseApp}
                      className="w-full flex items-center gap-4 px-5 py-5 text-red-400 hover:bg-red-500/10 active:bg-red-500/20 transition-colors"
                    >
                      <div className="w-9 h-9 rounded-xl bg-red-500/15 flex items-center justify-center flex-shrink-0">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                          <polyline points="16 17 21 12 16 7" />
                          <line x1="21" y1="12" x2="9" y2="12" />
                        </svg>
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-medium">Restart App</p>
                        <p className="text-red-400/50 text-xs mt-0.5">Reloads all connected screens</p>
                      </div>
                    </button>
                  ) : (
                    <div className="px-5 py-5 space-y-4">
                      <p className="text-white/70 text-sm">Reload the app on all connected screens?</p>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setConfirmClose(false)}
                          className="flex-1 py-3 rounded-xl bg-white/10 text-white/60 text-sm font-medium"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleCloseApp}
                          className="flex-1 py-3 rounded-xl bg-red-500 text-white font-bold text-sm"
                        >
                          Restart
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Memory tab — what the assistant knows about you */}
            {tab === 'memory' && <MemoryTab />}

            {/* Guides tab — what the guide researcher is doing, and why */}
            {tab === 'guides' && <GuidesTab />}

            {/* Drawing tab — how the prompt improver is told to rewrite prompts */}
            {tab === 'drawing' && <DrawingTab />}

            {/* Server tab — updating the machine this runs on */}
            {tab === 'server' && <ServerTab />}

            {/* Debug tab — config visibility, endpoint checks, error log */}
            {tab === 'debug' && <DebugTab />}

          </div>
        </div>
      )}
    </>
  )
}

// ── Guides tab ────────────────────────────────────────────────────────────────
// What the guide system is doing, and what it did. Building a guide is a dozen
// model calls and twice as many page fetches over several minutes, and until
// this tab existed the only account of it was one overwritten `phase` line and
// the container log. When a chapter comes back empty the useful question is
// *why* — no wiki page, a throttled search, the model returning nothing twice —
// and every one of those answers was being logged and thrown away.

const ACTIVITY_LEVEL: Record<ActivityLevel, { dot: string; text: string }> = {
  info:  { dot: 'bg-white/30',      text: 'text-white/60'    },
  good:  { dot: 'bg-emerald-400',   text: 'text-white/75'    },
  warn:  { dot: 'bg-amber-400',     text: 'text-amber-100/80' },
  error: { dot: 'bg-red-400',       text: 'text-red-200/90'  },
}

const GUIDE_STATUS: Record<string, { label: string; cls: string }> = {
  generating: { label: 'working',  cls: 'bg-cyan-500/20 text-cyan-200'      },
  ready:      { label: 'ready',    cls: 'bg-emerald-500/20 text-emerald-200' },
  failed:     { label: 'failed',   cls: 'bg-red-500/20 text-red-200'        },
}

function clockTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '--:--:--'
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/**
 * Settings → Drawing: the prompt improver's own system prompt.
 *
 * The reason this screen exists rather than a constant in the server is that
 * how you ask a model to write a prompt is a matter of taste, it changes faster
 * than this app ships, and the person using it has opinions. What is NOT
 * editable, and is shown read-only below the box, is the model-specific half:
 * {{style}} and {{guidance}} are substituted from the selected style's own
 * published guidance, so the same template does the right thing whether the
 * next picture goes to FLUX's T5-XXL or to a booru-tag model. Getting that
 * wrong is the one failure the user cannot debug from here, so it is not theirs
 * to get wrong.
 *
 * The preview underneath is the whole point of the layout: a template full of
 * placeholders cannot be judged on its own, and seeing it expanded for the
 * style that is actually selected is what makes the model-awareness visible
 * rather than a claim.
 */
/**
 * Settings → Drawing → the per-model text: what this style avoids, and what is
 * silently added to every prompt for it.
 *
 * PER MODEL rather than global, for exactly the reason cfg is: this is
 * model-specific text. The booru terms NoobAI's card asks for are wasted on
 * FLUX, which has no negative at all; the house English prose is wasted on a
 * tag-trained model. One global negative would be quietly wrong for whichever
 * model it was not written for — which is the failure the whole per-style store
 * exists to prevent.
 *
 * Each field's PLACEHOLDER is the string that is actually in effect when you
 * leave it blank, not a hint. A blank box over a model that has a published
 * negative would read as "there isn't one", and the natural response to that is
 * to type a worse one from memory.
 */
function StyleTextSection({ styles }: { styles: { id: string; label: string }[] }) {
  const { fetchParams, setParamsForStyle } = useImages()
  const [style, setStyle] = useState('')
  const [data, setData] = useState<ParamsResponse | null>(null)
  const [draft, setDraft] = useState<Overrides>(BLANK)
  const [saved, setSaved] = useState(true)

  // Settle on the first style once the list arrives. Derived in the render body
  // rather than an effect, the pattern this file already uses elsewhere.
  if (!style && styles.length > 0) setStyle(styles[0]!.id)

  // Load whichever style is being edited. The cancelled guard is load-bearing
  // for the same reason as the Draw panel's: tapping through three models fires
  // three requests, and the slowest one winning would leave the fields
  // describing one model while the next save wrote them against another.
  useEffect(() => {
    if (!style) return
    let cancelled = false
    void fetchParams(style).then(j => {
      if (cancelled) return
      setData(j)
      setDraft({
        prefix:         j?.values?.prefix         ?? null,
        optimizations:  j?.values?.optimizations  ?? null,
        negative:       j?.values?.negative       ?? null,
        negativePrefix: j?.values?.negativePrefix ?? null,
      })
      setSaved(true)
    })
    return () => { cancelled = true }
  }, [style, fetchParams])

  const text = data?.text
  // A style sampled at cfg 1 is not doing classifier-free guidance, so its
  // negative is encoded and then ignored. Saying so beats a field that looks
  // live and silently isn't — the same rule the Quality row follows when a
  // distilled style takes it out of play.
  const cfgOne = data?.defaults?.cfg === 1
  // A model with no second text encode at all — FLUX zeroes the positive out
  // instead. Undefined from a server that predates the field, which must read
  // as "it has one", the behaviour every style had before this existed.
  const hasNegative = text?.usesNegative !== false

  const set = (key: keyof Overrides, v: string | null) => {
    setDraft(d => ({ ...d, [key]: v }))
    setSaved(false)
  }

  return (
    <div className="space-y-5">
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Per-model text
        </span>
        <p className="text-[12px] text-white/45 leading-relaxed mb-3">
          Everything this app adds to a render for you, for one model at a time. A box left
          alone uses what that model's own documentation recommends — shown greyed inside it.
          Type to replace it, or empty a box you have taken over to add nothing at all.
        </p>
        {/* A horizontal scroller, not a dropdown: a native select opens an OS
            popup TouchKio renders badly, and this is the same control the Draw
            panel's Style row already uses. */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {styles.map(st => (
            <button
              key={st.id}
              type="button"
              onClick={() => setStyle(st.id)}
              className={`shrink-0 px-3 h-10 rounded-xl text-[12px] font-semibold border transition ${
                style === st.id
                  ? 'bg-white/20 text-white border-white/25'
                  : 'bg-white/5 text-white/45 border-transparent'
              }`}
            >
              {st.label}
            </button>
          ))}
        </div>
      </div>

      <OverrideField
        label="Added in front of your prompt"
        hint={"Used exactly as written, with a comma put in for you \u2014 unless it ends in " +
              "punctuation like \u201c>\u201d, which some models use as a separator that must not " +
              "be followed by one."}
        value={draft.prefix}
        fallback={text?.prefix ?? ''}
        rows={2}
        onChange={v => set('prefix', v)}
        onReset={() => set('prefix', null)}
      />

      <OverrideField
        label="Added after your prompt"
        hint="Where quality tags go for models whose documentation puts them at the end."
        value={draft.optimizations}
        fallback={text?.optimizations ?? ''}
        rows={2}
        onChange={v => set('optimizations', v)}
        onReset={() => set('optimizations', null)}
      />

      {/* Not disabled — absent. A model that cannot have a negative gets a
          sentence saying so instead of editable boxes whose contents could never
          reach a picture, which is the same silent-override failure the
          per-style params exist to prevent. */}
      {hasNegative ? (
        <>
          <OverrideField
            label="Negative prompt"
            hint={cfgOne
              ? 'This style samples at guidance 1, so it does no classifier-free guidance and ' +
                'this has no effect on the picture yet. It is kept for the moment you raise ' +
                "Guidance in the Draw panel's Advanced section."
              : ''}
            hintTone={cfgOne ? 'warn' : 'plain'}
            value={draft.negative}
            fallback={text?.negative ?? ''}
            rows={3}
            onChange={v => set('negative', v)}
            onReset={() => set('negative', null)}
          />

          <OverrideField
            label="Added in front of the negative"
            hint="Only instruction-tuned models ship one of these; most leave it empty."
            value={draft.negativePrefix}
            fallback={text?.negativePrefix ?? ''}
            rows={2}
            onChange={v => set('negativePrefix', v)}
            onReset={() => set('negativePrefix', null)}
          />
        </>
      ) : (
        <p className="text-[12px] text-white/45 leading-relaxed rounded-xl bg-white/[0.04]
                      border border-hairline px-3 py-2.5">
          This model has no negative prompt at all — its own guidance is to describe what
          you want rather than what you don't, and there is nowhere in its pipeline for a
          negative to go. Put anything you were going to avoid into the prompt as a
          positive description instead.
        </p>
      )}

      <button
        type="button"
        disabled={saved}
        onClick={() => { void setParamsForStyle(style, draft).then(() => setSaved(true)) }}
        className={`w-full h-12 rounded-xl text-sm font-semibold transition ${
          saved ? 'bg-white/5 text-white/30' : 'bg-violet-500/80 text-white active:scale-95'
        }`}
      >
        {saved ? 'Saved' : `Save for ${data?.styleLabel || 'this model'}`}
      </button>
    </div>
  )
}

/** The four overridable strings, as the editor holds them. */
interface Overrides {
  prefix:         string | null
  optimizations:  string | null
  negative:       string | null
  negativePrefix: string | null
}

const BLANK: Overrides = {
  prefix: null, optimizations: null, negative: null, negativePrefix: null,
}

/**
 * One overridable piece of text, with its way back.
 *
 * The three states have to be visibly different or the field lies. `null` shows
 * the model's own string as a greyed placeholder, because a blank box over a
 * model that HAS a published prefix reads as "there isn't one". An override of
 * '' must NOT show that same placeholder — it would look like the built-in was
 * still in effect when the whole point of emptying the box was to switch it
 * off — so the placeholder changes to say what will actually happen.
 */
function OverrideField({
  label, hint, hintTone = 'plain', value, fallback, rows, onChange, onReset,
}: {
  label:     string
  hint?:     string
  hintTone?: 'plain' | 'warn'
  /** null = no override. */
  value:     string | null
  /** What the model itself specifies, shown when there is no override. */
  fallback:  string
  rows:      number
  onChange:  (v: string) => void
  onReset:   () => void
}) {
  const overridden = value !== null
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">
          {label}
        </span>
        {/* Absent rather than disabled while nothing is overridden: a dead
            control on a touchscreen is a tap that looks broken. */}
        {overridden && (
          <button
            type="button"
            onClick={onReset}
            className="shrink-0 text-[11px] font-semibold text-violet-300/80 px-2 py-1
                       rounded-lg active:bg-white/10"
          >
            Use the model's own
          </button>
        )}
      </div>
      <TouchInput
        value={value ?? ''}
        onChange={onChange}
        // Each value is saved to the server and shown back as "overridden";
        // half-typed text must not be.
        commitOn="done"
        multiline
        rows={rows}
        placeholder={overridden ? 'nothing will be added' : (fallback || 'nothing by default')}
        ariaLabel={label}
        className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[13px] leading-relaxed
                   placeholder:text-white/30 border border-hairline"
      />
      {overridden && value === '' && (
        <p className="text-[11px] text-amber-300/70 leading-snug mt-1.5">
          Switched off — nothing will be added here. Tap "Use the model's own" to put it back.
        </p>
      )}
      {hint && (
        <p className={`text-[11px] leading-snug mt-1.5 ${
          hintTone === 'warn' ? 'text-amber-300/70' : 'text-white/30'
        }`}>
          {hint}
        </p>
      )}
    </div>
  )
}

function DrawingTab() {
  const { prompter, setPrompter, styles } = useImages()
  // Edited locally and saved explicitly. A template is a paragraph typed on an
  // on-screen keyboard, and saving per keystroke would write the store forty
  // times and re-fetch the preview on each one.
  const [draft, setDraft] = useState<{ text: string; seeded: boolean }>({ text: '', seeded: false })
  if (!draft.seeded && prompter) setDraft({ text: prompter.template, seeded: true })
  const dirty = prompter !== null && draft.text !== prompter.template
  // The redraw's own template, edited the same way. A second draft rather than
  // one shared one because the two are saved separately and a half-typed edit
  // in one must not be lost by saving the other.
  const [visionDraft, setVisionDraft] = useState<{ text: string; seeded: boolean }>({ text: '', seeded: false })
  if (!visionDraft.seeded && prompter) setVisionDraft({ text: prompter.visionTemplate, seeded: true })
  const visionDirty = prompter !== null && visionDraft.text !== prompter.visionTemplate

  if (!prompter) {
    return (
      <div className="max-w-lg mx-auto py-8 text-center text-white/40 text-sm">
        Loading the drawing settings…
      </div>
    )
  }

  return (
    <div className="space-y-5 max-w-lg mx-auto pb-4">
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Improve my prompt
        </span>
        <p className="text-[12px] text-white/45 leading-relaxed mb-3">
          When this is on, a separate model rewrites what you type before the picture is
          drawn — on a brand new conversation every time, so nothing you have said to the
          assistant can colour it. The switch is also in the Draw panel; this is the same
          setting.
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={prompter.enabled}
          onClick={() => { void setPrompter({ enabled: !prompter.enabled }) }}
          className={`w-full flex items-center gap-3 rounded-2xl px-3 py-3 border text-left
                      transition-colors active:scale-[0.99] ${
            prompter.enabled ? 'bg-violet-500/15 border-violet-400/40' : 'bg-white/5 border-hairline'
          }`}
        >
          <span className={`w-11 h-6 shrink-0 rounded-full p-0.5 flex transition-colors ${
            prompter.enabled ? 'bg-violet-400/80 justify-end' : 'bg-white/15 justify-start'
          }`}>
            <span className="w-5 h-5 rounded-full bg-white shadow" />
          </span>
          <span className="text-[13px] font-semibold text-white/85">
            {prompter.enabled ? 'On by default' : 'Off by default'}
          </span>
        </button>
      </div>

      {/* The template itself */}
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          How it is asked — one prompt, every model
        </span>
        <p className="text-[12px] text-white/45 leading-relaxed mb-2">
          This is the whole system prompt. Two placeholders are filled in for you from
          whichever style is selected:{' '}
          <code className="text-violet-300">{'{{style}}'}</code> becomes its name, and{' '}
          <code className="text-violet-300">{'{{guidance}}'}</code> becomes that model's own
          published advice on how to prompt it. What you type is sent as the user message.
        </p>
        <TouchInput
          value={draft.text}
          onChange={text => setDraft({ text, seeded: true })}
          multiline
          rows={10}
          ariaLabel="The prompt improver's instructions"
          className="w-full bg-white/10 text-white rounded-2xl px-4 py-3 text-[13px] leading-relaxed
                     placeholder:text-white/30 border border-hairline font-mono"
        />
        <div className="flex gap-2 mt-2">
          <button
            type="button"
            disabled={!dirty}
            onClick={() => { void setPrompter({ template: draft.text }); setDraft({ text: draft.text, seeded: true }) }}
            className={`flex-1 h-12 rounded-xl text-sm font-semibold transition ${
              dirty ? 'bg-violet-500/80 text-white active:scale-95' : 'bg-white/5 text-white/30'
            }`}
          >
            {dirty ? 'Save' : 'Saved'}
          </button>
          <button
            type="button"
            onClick={() => setDraft({ text: prompter.defaultTemplate, seeded: true })}
            className="px-4 h-12 rounded-xl bg-white/10 text-white/70 text-sm font-semibold active:scale-95"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Which model does it */}
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Which model
        </span>
        <p className="text-[12px] text-white/45 leading-relaxed mb-2">
          Leave this empty to use whatever <code className="text-white/60">OLLAMA_IMAGE_MODEL</code>{' '}
          is set to on the server, and the chat model after that. Nobody is waiting on this
          call the way they are on a spoken reply, so a slower, better model costs nothing
          you can perceive.
        </p>
        <TouchInput
          value={prompter.model}
          onChange={model => { void setPrompter({ model }) }}
          commitOn="done"
          placeholder="(the server's default)"
          ariaLabel="Model that rewrites prompts"
          className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-sm
                     placeholder:text-white/30 border border-hairline"
        />
      </div>

      {/* What it actually turns into, for the style that is selected now */}
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Right now, for {prompter.styleLabel || 'this style'}
        </span>
        <p className="text-[12px] text-white/45 leading-relaxed mb-2">
          Exactly what the model is told before your prompt. Switch the style in the Draw
          panel and this changes with it — that is the model-specific half doing its job.
        </p>
        <pre className="selectable-text whitespace-pre-wrap break-words text-[11px] leading-relaxed
                        text-white/60 bg-black/30 border border-hairline rounded-2xl p-3
                        max-h-72 overflow-y-auto">
          {prompter.preview}
        </pre>
      </div>

      {/* The redraw's look-at-the-picture step. It is a different prompt for a
          different job — describing a picture that exists rather than
          embellishing words — and it runs whenever a picture is changed with
          Improve on, or an uploaded one is redrawn at all, so it deserves to be
          readable in the same place as the improver's rather than buried in
          the server. Absent for an editing style (FLUX Kontext), which never
          runs it: the instruction goes to the model verbatim. */}
      <div className="border-t border-hairline pt-5">
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Looking at the picture — before a redraw
        </span>
        <p className="text-[12px] text-white/45 leading-relaxed mb-2">
          When you change a picture with a drawing style, the picture model never sees the
          original: it only reads a prompt. So before the redraw, a model that can see is
          shown the original and what you asked to change, and writes the description of the
          whole result. This is what it is told. It runs whenever Improve is on, and always for
          a picture of your own, since a photo has no prompt to start from. The same two
          placeholders are filled in for you.
        </p>
        <TouchInput
          value={visionDraft.text}
          onChange={text => setVisionDraft({ text, seeded: true })}
          multiline
          rows={10}
          ariaLabel="Instructions for the model that looks at the picture before a redraw"
          className="w-full bg-white/10 text-white rounded-2xl px-4 py-3 text-[13px] leading-relaxed
                     placeholder:text-white/30 border border-hairline font-mono"
        />
        <div className="flex gap-2 mt-2">
          <button
            type="button"
            disabled={!visionDirty}
            onClick={() => {
              void setPrompter({ visionTemplate: visionDraft.text })
              setVisionDraft({ text: visionDraft.text, seeded: true })
            }}
            className={`flex-1 h-12 rounded-xl text-sm font-semibold transition ${
              visionDirty ? 'bg-violet-500/80 text-white active:scale-95' : 'bg-white/5 text-white/30'
            }`}
          >
            {visionDirty ? 'Save' : 'Saved'}
          </button>
          <button
            type="button"
            onClick={() => setVisionDraft({ text: prompter.defaultVisionTemplate, seeded: true })}
            className="px-4 h-12 rounded-xl bg-white/10 text-white/70 text-sm font-semibold active:scale-95"
          >
            Reset
          </button>
        </div>
        <p className="text-[12px] text-white/45 leading-relaxed mt-3 mb-2">
          Right now, for {prompter.styleLabel || 'this style'}, the model{' '}
          <code className="text-white/60">{prompter.visionModel}</code> is told this, then
          shown the picture with the message{' '}
          <code className="text-violet-300">{prompter.visionUserMessage}</code>. Set{' '}
          <code className="text-white/60">OLLAMA_VISION_MODEL</code> on the server to use a
          different model for this step; it has to be one that can see.
        </p>
        <pre className="selectable-text whitespace-pre-wrap break-words text-[11px] leading-relaxed
                        text-white/60 bg-black/30 border border-hairline rounded-2xl p-3
                        max-h-72 overflow-y-auto">
          {prompter.visionPreview}
        </pre>
      </div>

      {/* Everything above this line is ONE prompt shared by every model — the
          generalised optimizer. Everything below is per model. Keeping them on
          the same screen but visibly separated is the whole point: the reason
          one template can serve every model is that the model-specific text
          lives down here and is appended for you. */}
      <div className="border-t border-hairline pt-5">
        <StyleTextSection styles={styles} />
      </div>
    </div>
  )
}

// ── Server tab ────────────────────────────────────────────────────────────────
// The machine this runs on, and updating it: apt, firmware, Tailscale, the
// other docker stacks, the dashboard itself, and reboot. See server/src/host.ts
// for how a container gets to do any of that. The tab is three things: cards
// that answer "is anything waiting?", one button per job, and the live log —
// because "install updates" on a kiosk with no keyboard has to show apt working
// rather than a spinner for four minutes, and a failure has to be readable
// from the couch.

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

function ServerTab() {
  const { info, status, statusError, statusBusy, refreshStatus, lines, state, run, runError } = useHost()
  // The two destructive tasks are asked for twice. One slot rather than one
  // flag per task: opening a second confirmation closes the first.
  const [confirming, setConfirming] = useState<HostTask | null>(null)
  const [copied, setCopied] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const running = state.running
  const busy = running !== null

  // Follow the log as it grows — the interesting line is always the last one.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  // A self-update replaces the container and a reboot takes the box down: the
  // server that would tell us "done" is the thing going away. So once either
  // has started, watch the API go dark and come back, then reload the page —
  // the new build is what should be on screen.
  const leaving = running === 'self-update' || running === 'reboot'
  useEffect(() => {
    if (!leaving) return
    let down = false
    const t = setInterval(() => {
      fetch('/api/system/version', { cache: 'no-store' })
        .then(r => { if (r.ok && down) window.location.reload(); if (!r.ok) down = true })
        .catch(() => { down = true })
    }, 5000)
    return () => clearInterval(t)
  }, [leaving])

  const copyKey = () => {
    const key = info?.publicKey ?? ''
    if (!key) return
    navigator.clipboard?.writeText(key).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) }).catch(() => {})
  }

  const taskButton = (task: HostTask, label: string, opts: { tone?: 'normal' | 'danger'; hint?: string } = {}) => {
    const needsConfirm = info?.confirm.includes(task) ?? false
    const isRunning = running === task
    const danger = opts.tone === 'danger'
    if (needsConfirm && confirming === task) {
      return (
        <div className="flex gap-2 flex-1 min-w-0">
          <button type="button" onClick={() => setConfirming(null)}
            className="flex-1 h-11 rounded-xl bg-white/10 text-white/60 text-sm font-medium">
            Cancel
          </button>
          <button type="button"
            onClick={() => { setConfirming(null); void run(task, true) }}
            className={`flex-1 h-11 rounded-xl text-sm font-bold text-white ${danger ? 'bg-red-500' : 'bg-cyan-500/80'}`}>
            Yes, {label.toLowerCase()}
          </button>
        </div>
      )
    }
    return (
      <button type="button"
        disabled={busy}
        onClick={() => { if (needsConfirm) setConfirming(task); else void run(task) }}
        className={`h-11 px-4 rounded-xl text-sm font-semibold flex items-center gap-2 transition active:scale-95 ${
          isRunning ? 'bg-cyan-500/20 text-cyan-200'
          : busy ? 'bg-white/5 text-white/25'
          : danger ? 'bg-red-500/15 text-red-300 border border-red-400/30'
          : 'bg-white/10 text-white/80'
        }`}>
        {isRunning && <RotateCw size={14} className="animate-spin" />}
        {isRunning ? 'Running…' : label}
      </button>
    )
  }

  const card = (title: string, body: ReactNode, actions?: ReactNode) => (
    <div>
      <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">{title}</span>
      <div className="bg-white/5 rounded-2xl px-5 py-4 border border-white/8 space-y-3">
        {body}
        {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
      </div>
    </div>
  )

  if (!info) {
    return <div className="max-w-lg mx-auto py-8 text-center text-white/40 text-sm">Loading…</div>
  }

  const h = status?.host
  const reboot = status?.reboot
  const apt = status?.apt
  const ts = status?.tailscale
  const fw = status?.firmware
  const ct = status?.containers
  const dash = status?.dashboard
  const rebootNeeded = !!(reboot?.required || reboot?.kernelPending)

  return (
    <div className="space-y-5 max-w-lg mx-auto pb-4">
      {/* Not reachable yet: the setup card, with the key. Shown INSTEAD of the
          cards rather than above them, because until the installer has run
          every button below would fail the same way. */}
      {!status && (
        <div>
          <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
            {statusBusy ? 'Asking the server…' : 'Not connected'}
          </span>
          <div className="bg-white/5 rounded-2xl px-5 py-4 border border-white/8 space-y-3">
            {statusError && <p className="text-amber-200/80 text-sm leading-snug">{statusError}</p>}
            <p className="text-white/50 text-[12px] leading-relaxed">
              The dashboard reaches <span className="text-white/80">{info.target}</span> over SSH with a key
              of its own. On the server, as the user who owns the docker stacks, run this once from the
              dashboard's checkout, then set <code className="text-white/70">HOST_UPDATE_SSH</code> in
              its .env if the installer says to:
            </p>
            <pre className="selectable-text whitespace-pre-wrap break-all text-[11px] leading-relaxed text-white/70
                            bg-black/30 border border-hairline rounded-xl p-3">
              {`sudo bash scripts/host/install.sh '${info.publicKey}'`}
            </pre>
            <div className="flex gap-2">
              <button type="button" onClick={copyKey}
                className="h-11 px-4 rounded-xl bg-white/10 text-white/80 text-sm font-semibold flex items-center gap-2 active:scale-95">
                {copied ? <Check size={14} className="text-emerald-300" /> : <ClipboardCopy size={14} />}
                {copied ? 'Copied' : 'Copy the key'}
              </button>
              <button type="button" onClick={() => { void refreshStatus() }} disabled={statusBusy}
                className="h-11 px-4 rounded-xl bg-cyan-500/20 text-cyan-200 text-sm font-semibold flex items-center gap-2 active:scale-95">
                <RotateCw size={14} className={statusBusy ? 'animate-spin' : ''} />
                Try again
              </button>
            </div>
          </div>
        </div>
      )}

      {status && h && card(
        h.hostname,
        <>
          <p className="text-white/80 text-sm leading-snug">{h.os}{h.model ? ` · ${h.model}` : ''}</p>
          <p className="text-white/40 text-xs leading-relaxed">
            {h.kernel} · {h.arch} · up {fmtUptime(h.uptimeSec)} · load {h.load} · disk {h.diskUsedPct}% · memory {h.memUsedPct}%
            {status.at ? ` · checked ${ago(status.at)}` : ''}
          </p>
          {statusError && <p className="text-amber-200/80 text-xs">{statusError}</p>}
        </>,
        <button type="button" onClick={() => { void refreshStatus() }} disabled={statusBusy || busy}
          className="h-11 px-4 rounded-xl bg-white/10 text-white/80 text-sm font-semibold flex items-center gap-2 active:scale-95">
          <RotateCw size={14} className={statusBusy ? 'animate-spin' : ''} />
          Refresh
        </button>,
      )}

      {status && rebootNeeded && (
        <div className="bg-amber-500/10 border border-amber-400/30 rounded-2xl px-5 py-4 space-y-3">
          <p className="text-amber-100 text-sm font-medium">A reboot is needed to finish an update.</p>
          <p className="text-amber-100/60 text-xs leading-relaxed">
            {reboot?.kernelPending ? 'A newer kernel is installed but not running. ' : ''}
            {reboot?.packages.length ? `Waiting on: ${reboot.packages.join(', ')}.` : ''}
          </p>
          <div className="flex gap-2">{taskButton('reboot', 'Reboot the server', { tone: 'danger' })}</div>
        </div>
      )}

      {status && card(
        'Packages',
        <>
          <p className="text-white/80 text-sm">
            {apt?.error ? <span className="text-amber-200/80">{apt.error}</span>
              : apt?.pending ? `${apt.pending} update${apt.pending === 1 ? '' : 's'} waiting`
              : 'Everything is up to date'}
          </p>
          <p className="text-white/35 text-xs leading-relaxed">
            Last checked {apt?.lastRefresh ? ago(apt.lastRefresh) : 'never'}.
            {apt?.packages.length ? ` ${apt.packages.slice(0, 8).map(p => p.name).join(', ')}${apt.packages.length > 8 ? `, +${apt.packages.length - 8} more` : ''}` : ''}
          </p>
        </>,
        <>
          {taskButton('apt-refresh', 'Check')}
          {taskButton('apt-upgrade', apt?.pending ? `Install ${apt.pending}` : 'Install updates')}
        </>,
      )}

      {status && fw && card(
        'Firmware',
        fw.installed ? (
          <>
            <p className="text-white/80 text-sm">
              {fw.updates.length ? `${fw.updates.length} device${fw.updates.length === 1 ? '' : 's'} can be updated` : `${fw.devices} devices, nothing waiting`}
            </p>
            {fw.updates.length > 0 && (
              <p className="text-white/35 text-xs leading-relaxed">
                {fw.updates.map(u => `${u.device} ${u.current} → ${u.to}`).join(' · ')}
              </p>
            )}
            <p className="text-white/25 text-xs">Through fwupd and the LVFS. "Check" fetches the latest list; the status above is from the last one.</p>
          </>
        ) : <p className="text-white/40 text-sm">fwupd is not installed on this server.</p>,
        fw.installed ? <>{taskButton('firmware-check', 'Check')}{taskButton('firmware-update', 'Install firmware')}</> : undefined,
      )}

      {status && ts && card(
        'Tailscale',
        ts.installed ? (
          <>
            <p className="text-white/80 text-sm">
              {ts.version || '?'}
              {ts.updateAvailable ? <span className="text-cyan-200"> → {ts.latest} available</span>
                : ts.latest ? <span className="text-white/40"> · latest</span> : ''}
            </p>
            <p className="text-white/35 text-xs leading-relaxed">
              {ts.online === false ? 'Offline' : 'Online'}{ts.ip ? ` · ${ts.ip}` : ''}
              {ts.health?.length ? ` · ${ts.health.join(' · ')}` : ''}
            </p>
          </>
        ) : <p className="text-white/40 text-sm">Tailscale is not installed on this server.</p>,
        ts.installed ? taskButton('tailscale-update', 'Update Tailscale') : undefined,
      )}

      {status && ct && card(
        'Containers',
        <>
          {ct.projects.length === 0
            ? <p className="text-white/40 text-sm">No other compose stacks were found when the installer ran.</p>
            : ct.projects.map(p => (
              <div key={p.file}>
                <p className="text-white/80 text-sm">{p.name} <span className="text-white/35">· {p.running}/{p.total} running</span></p>
                <p className="text-white/30 text-xs leading-relaxed truncate">
                  {p.services.map(s => s.name).join(', ')}
                </p>
              </div>
            ))}
          <p className="text-white/25 text-xs">Pulls the newest image for every service and restarts the ones that changed. Docker {ct.docker || '?'}.</p>
        </>,
        ct.projects.length > 0 ? taskButton('containers', 'Pull and restart') : undefined,
      )}

      {status && dash && card(
        'This dashboard',
        <>
          <p className="text-white/80 text-sm">
            {dash.commit ? `Checkout at ${dash.commit}` : 'Checkout not found'}
            {dash.behind != null && dash.behind > 0 ? <span className="text-cyan-200"> · {dash.behind} commit{dash.behind === 1 ? '' : 's'} behind</span>
              : dash.behind === 0 ? <span className="text-white/40"> · up to date with the last fetch</span> : ''}
          </p>
          <p className="text-white/25 text-xs leading-relaxed">
            Pulls the newest published image (or rebuilds it here if there is none) and replaces this container. The screen goes dark for a few
            minutes and comes back on its own.{dash.lastSelfUpdate ? ` Last done ${ago(dash.lastSelfUpdate)}.` : ''}
          </p>
        </>,
        dash.commit ? taskButton('self-update', 'Update the dashboard') : undefined,
      )}

      {status && !rebootNeeded && card(
        'Power',
        <p className="text-white/40 text-xs leading-relaxed">Restarts the whole server, every container included. Plex, downloads and the assistant are back once it is.</p>,
        taskButton('reboot', 'Reboot the server', { tone: 'danger' }),
      )}

      {/* The log. Present whenever there is anything in it. */}
      {(lines.length > 0 || busy) && (
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">
              {busy ? `Running: ${info.tasks[running]}` : state.last ? `Last: ${info.tasks[state.last.task]}` : 'Log'}
            </span>
            {state.last && !busy && (
              <span className={`text-xs ${state.last.ok ? 'text-emerald-300/80' : 'text-red-300/90'}`}>
                {state.last.ok ? 'finished' : 'failed'} · {ago(state.last.endedAt)}
              </span>
            )}
          </div>
          {leaving && (
            <p className="text-cyan-200/80 text-xs mb-2 leading-relaxed">
              This screen will lose the server for a while and reload itself when it is back.
            </p>
          )}
          <div ref={logRef}
            className="selectable-text bg-black/40 border border-hairline rounded-2xl p-3 max-h-72 overflow-y-auto
                       font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
            {lines.map(l => (
              <div key={l.id} className={l.stream === 'err' ? 'text-red-200/90' : l.line.startsWith('▶') || l.line.startsWith('✓') ? 'text-cyan-200' : 'text-white/60'}>
                {l.line}
              </div>
            ))}
            {busy && <div className="text-white/30">…</div>}
          </div>
        </div>
      )}

      {runError && <p className="text-red-300/90 text-sm px-1">{runError}</p>}
    </div>
  )
}

function GuidesTab() {
  const { byItem } = useGuides()
  const { entries, live } = useGuideActivity()
  // One game's story at a time: a run interleaves research, model calls and
  // video lookups, and with two guides in the buffer the feed stops reading as
  // a sequence. Tapping a guide row filters to it.
  const [only, setOnly] = useState<string | null>(null)

  const guides = Object.values(byItem).sort((a, b) => {
    if ((a.status === 'generating') !== (b.status === 'generating')) return a.status === 'generating' ? -1 : 1
    return a.title.localeCompare(b.title)
  })
  const working = guides.filter(g => g.status === 'generating')
  const shown = only ? entries.filter(e => e.itemId === only) : entries

  return (
    <div className="space-y-5 max-w-lg mx-auto pb-4">
      {/* Working now — the answer to "is it doing anything?" without reading a log */}
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Working now
        </span>
        <div className="bg-white/5 rounded-2xl px-5 py-4 border border-white/8">
          {working.length === 0 ? (
            <p className="text-white/25 text-sm">
              Nothing being generated. Guides are built from the Watch/Play list, or by asking out loud.
            </p>
          ) : working.map(g => (
            <div key={g.itemId} className="py-2 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2">
                <RotateCw size={14} className="text-cyan-300 animate-spin flex-shrink-0" />
                <span className="text-white/85 text-sm font-medium truncate">{g.title}</span>
                <span className="text-cyan-200/70 text-xs tabular-nums ml-auto flex-shrink-0">{g.percent}%</span>
              </div>
              <p className="text-white/45 text-xs mt-1 pl-6 leading-snug">{g.phase ?? 'starting…'}</p>
              <div className="h-1 mt-2 ml-6 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-cyan-400/70 rounded-full transition-all duration-500"
                     style={{ width: `${Math.min(100, Math.max(0, g.percent))}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Every guide on disk, with its state */}
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Guides {guides.length > 0 && <span className="text-white/25 normal-case">· {guides.length}</span>}
        </span>
        <div className="bg-white/5 rounded-2xl px-5 py-2 border border-white/8">
          {guides.length === 0 ? (
            <p className="text-white/25 text-sm py-4">No guides yet.</p>
          ) : guides.map(g => {
            const chip = GUIDE_STATUS[g.status] ?? GUIDE_STATUS['ready']!
            const selected = only === g.itemId
            return (
              <button key={g.itemId} type="button"
                onClick={() => setOnly(selected ? null : g.itemId)}
                className={`w-full text-left flex items-center gap-3 py-3 border-b border-white/6 last:border-0 active:bg-white/5 rounded-lg px-1 -mx-1 ${
                  selected ? 'bg-white/[0.06]' : ''
                }`}>
                <div className="flex-1 min-w-0">
                  <p className="text-white/80 text-sm leading-snug truncate">{g.title}</p>
                  <p className="text-white/25 text-xs mt-1">
                    {g.sections} chapters · {g.counted.done}/{g.counted.total} steps done
                    {selected ? ' · showing only this below' : ''}
                  </p>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider flex-shrink-0 ${chip.cls}`}>
                  {chip.label}
                </span>
                <span className="text-white/50 text-sm tabular-nums w-10 text-right flex-shrink-0">{g.percent}%</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* The feed */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">
            Activity {shown.length > 0 && <span className="text-white/25 normal-case">· {shown.length}</span>}
          </span>
          {only && (
            <button type="button" onClick={() => setOnly(null)}
              className="text-cyan-300/70 text-xs active:text-cyan-200">show all</button>
          )}
        </div>
        <div className="bg-white/5 rounded-2xl px-5 py-2 border border-white/8">
          {!live ? (
            <p className="text-white/25 text-sm py-4">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="text-white/25 text-sm py-4">
              Nothing recorded yet. This fills in as a guide is researched — each page read, each
              chapter written, and why any of them came up empty.
            </p>
          ) : shown.map(e => {
            const tone = ACTIVITY_LEVEL[e.level] ?? ACTIVITY_LEVEL.info
            return (
              <div key={e.id} className="flex items-start gap-3 py-2.5 border-b border-white/6 last:border-0">
                <span className={`w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 ${tone.dot}`} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm leading-snug ${tone.text}`}>{e.message}</p>
                  <p className="text-white/25 text-xs mt-1 truncate">
                    <span className="tabular-nums">{clockTime(e.at)}</span>
                    {' · '}{e.stage}
                    {only ? '' : ` · ${e.title}`}
                    {e.section ? ` · ${e.section}` : ''}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
        <p className="text-white/25 text-xs mt-2 leading-relaxed px-1">
          Kept in memory only, newest first — a restart clears it. The same lines go to the server log.
        </p>
      </div>
    </div>
  )
}

// ── Memory tab ────────────────────────────────────────────────────────────────
// Everything the assistant knows about you, in the order it forgets it: the
// current conversation window (12h), then facts and preferences (forever),
// then loose recent context (24h). Every row has a delete button — the whole
// point of this tab is that memory stops being something you can only inspect
// by asking out loud and hoping the answer is honest.

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48)  return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}


const TOPIC_LABEL: Record<MemoryTopic, string> = {
  people: 'People', food: 'Food & drink', home: 'Home', media: 'Films, shows & music', games: 'Games',
  work: 'Work & study', schedule: 'Routine & schedule', health: 'Health', other: 'Other',
}

/**
 * One remembered thing. Tap the text to correct it (the on-screen keyboard
 * opens on the current wording), the pin to keep it above the cap, the topic
 * chip to re-file it. Correcting from here rather than by saying "forget
 * that, actually…" is the point: the memory that is wrong is the one you
 * notice while reading the list.
 */
function MemoryRow({ item, onDelete, onUpdate }: {
  item: MemoryItem
  onDelete: (id: string) => void
  onUpdate?: (id: string, patch: { content?: string; topic?: MemoryTopic; pinned?: boolean }) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.content)
  const [picking, setPicking] = useState(false)
  const save = () => {
    setEditing(false)
    if (onUpdate && draft.trim() && draft.trim() !== item.content) onUpdate(item.id, { content: draft.trim() })
  }
  return (
    <div className="py-3 border-b border-white/6 last:border-0">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {editing ? (
            <TouchInput value={draft} onChange={setDraft} multiline rows={2} ariaLabel="Correct this memory"
              className="w-full bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-hairline" />
          ) : (
            <button type="button" onClick={() => { if (onUpdate) { setDraft(item.content); setEditing(true) } }}
              className="text-left w-full">
              <p className="text-white/80 text-sm leading-snug">{item.content}</p>
            </button>
          )}
          <p className="text-white/25 text-xs mt-1 flex items-center gap-2 flex-wrap">
            <span>{ago(item.createdAt)}</span>
            {item.source === 'auto' && <span>· auto</span>}
            {item.source === 'user' && <span>· typed in</span>}
            {onUpdate && item.kind !== 'preference' && !item.expiresAt && (
              <button type="button" onClick={() => setPicking(p => !p)}
                className="px-2 py-0.5 rounded-md bg-white/8 text-white/45 active:bg-white/15">
                {TOPIC_LABEL[item.topic ?? 'other']}
              </button>
            )}
          </p>
          {picking && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {MEMORY_TOPICS.map(t => (
                <button key={t} type="button" onClick={() => { setPicking(false); onUpdate?.(item.id, { topic: t }) }}
                  className={`px-2.5 h-8 rounded-full text-xs border ${
                    (item.topic ?? 'other') === t ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40' : 'bg-white/5 text-white/50 border-transparent'}`}>
                  {TOPIC_LABEL[t]}
                </button>
              ))}
            </div>
          )}
          {editing && (
            <div className="flex gap-2 mt-2">
              <button type="button" onClick={save} className="h-10 px-4 rounded-xl bg-cyan-500/80 text-white text-sm font-semibold active:scale-95">Save</button>
              <button type="button" onClick={() => setEditing(false)} className="h-10 px-4 rounded-xl bg-white/10 text-white/60 text-sm active:scale-95">Cancel</button>
            </div>
          )}
        </div>
        {onUpdate && !item.expiresAt && (
          <button type="button" onClick={() => onUpdate(item.id, { pinned: !item.pinned })}
            aria-label={item.pinned ? 'Unpin' : 'Pin'} aria-pressed={!!item.pinned}
            className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center active:scale-90 ${
              item.pinned ? 'bg-amber-500/20 text-amber-300' : 'bg-white/5 text-white/30'}`}>
            <Pin size={15} className={item.pinned ? 'fill-current' : ''} />
          </button>
        )}
        <button type="button" onClick={() => onDelete(item.id)} aria-label="Forget this"
          className="w-10 h-10 shrink-0 rounded-full bg-white/5 text-white/40 flex items-center justify-center active:bg-red-500/30 active:text-red-300 active:scale-90">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  )
}

function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => void }) {
  const [draft, setDraft] = useState('')
  const value = draft.trim()
  return (
    <div className="flex items-stretch gap-2 pt-3">
      <TouchInput
        value={draft}
        onChange={setDraft}
        placeholder={placeholder}
        ariaLabel={placeholder}
        className="flex-1 bg-white/8 border border-white/12 rounded-xl px-4 py-3 text-white/90 text-sm focus:outline-none focus:border-cyan-500/50"
      />
      <button
        type="button"
        disabled={!value}
        onClick={() => { onAdd(value); setDraft('') }}
        className="px-5 rounded-xl bg-cyan-500/20 border border-cyan-400/30 text-cyan-200 text-sm font-medium active:scale-95 disabled:opacity-30 disabled:active:scale-100 transition-all flex-shrink-0"
      >
        Add
      </button>
    </div>
  )
}

function MemorySection({
  title, hint, items, empty, onDelete, onUpdate, addPlaceholder, onAdd,
}: {
  title: string
  hint?: string
  items: MemoryItem[]
  empty: string
  onDelete: (id: string) => void
  onUpdate?: (id: string, patch: { content?: string; topic?: MemoryTopic; pinned?: boolean }) => void
  addPlaceholder?: string
  onAdd?: (v: string, kind: MemoryKind) => void
}) {
  return (
    <div>
      <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
        {title} {items.length > 0 && <span className="text-white/25 normal-case">· {items.length}</span>}
      </span>
      <div className="bg-white/5 rounded-2xl px-5 py-2 border border-white/8">
        {hint && <p className="text-white/30 text-xs pt-3 pb-1 leading-relaxed">{hint}</p>}
        {items.length === 0
          ? <p className="text-white/25 text-sm py-4">{empty}</p>
          : items.map(m => <MemoryRow key={m.id} item={m} onDelete={onDelete} onUpdate={onUpdate} />)}
        {addPlaceholder && onAdd && (
          <div className="pb-4">
            <AddRow placeholder={addPlaceholder} onAdd={v => onAdd(v, 'fact')} />
          </div>
        )}
      </div>
    </div>
  )
}

function MemoryTab() {
  const { facts, preferences, shortTerm, session, loading, error, add, update, remove, forgetSession } = useMemory()
  const [busy, setBusy] = useState<string | null>(null)
  const edit = (id: string, patch: { content?: string; topic?: MemoryTopic; pinned?: boolean }) => void run(id, () => update(id, patch))
  // Facts by topic, pinned first inside each, topics in the fixed order and
  // empty ones skipped: a heading with nothing under it is noise.
  const grouped = MEMORY_TOPICS
    .map(t => ({ topic: t, items: facts.filter(f => (f.topic ?? 'other') === t).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)) }))
    .filter(g => g.items.length > 0)

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label)
    try { await fn() } catch (err) { console.warn('[memory] action failed:', err) }
    finally { setBusy(null) }
  }

  const del = (id: string) => void run(id, () => remove(id))

  if (loading) return <p className="text-white/40 text-sm text-center py-10">Loading memory…</p>

  return (
    <div className="space-y-5 max-w-lg mx-auto pb-4">
      {error && <p className="text-amber-300/80 text-sm">{error}</p>}

      {/* Current conversation window */}
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Last conversation
        </span>
        <div className="bg-white/5 rounded-2xl p-5 border border-white/8">
          {session ? (
            <>
              <p className="text-white/80 text-sm leading-snug">
                {session.summary ?? session.opener ?? `${session.turns} turns`}
              </p>
              <p className="text-white/30 text-xs mt-1.5">
                ended {ago(session.endedAt)} · {session.turns} turns · kept for 12h
              </p>
              {session.keywords.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {session.keywords.map(k => (
                    <span key={k} className="px-2 py-0.5 rounded-md bg-white/8 text-white/40 text-xs">{k}</span>
                  ))}
                </div>
              )}
              <p className="text-white/25 text-xs mt-3 leading-relaxed">
                If your next question looks like it continues this, these turns are added back in
                automatically. Otherwise the conversation starts clean.
              </p>
              <button
                type="button"
                disabled={busy === 'session'}
                onClick={() => void run('session', forgetSession)}
                className="mt-4 w-full py-3 rounded-xl bg-white/8 border border-white/12 text-white/60 text-sm font-medium active:scale-95 active:bg-red-500/20 active:text-red-300 disabled:opacity-40 transition-all"
              >
                Forget this conversation
              </button>
            </>
          ) : (
            <p className="text-white/25 text-sm">
              Nothing carried over. The next thing you say starts a fresh conversation.
            </p>
          )}
        </div>
      </div>

      {/* Facts, by topic. Tap a line to correct it, the pin to keep it, the
          topic chip to re-file it. */}
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Facts {facts.length > 0 && <span className="text-white/25 normal-case">· {facts.length}</span>}
        </span>
        <div className="bg-white/5 rounded-2xl px-5 py-2 border border-white/8">
          {grouped.length === 0 && <p className="text-white/25 text-sm py-4">Nothing saved yet.</p>}
          {grouped.map(g => (
            <div key={g.topic} className="pt-3">
              <p className="text-[11px] uppercase tracking-widest text-cyan-200/60 font-semibold">{TOPIC_LABEL[g.topic]}</p>
              {g.items.map(m => <MemoryRow key={m.id} item={m} onDelete={del} onUpdate={edit} />)}
            </div>
          ))}
          <div className="pb-4">
            <AddRow placeholder="e.g. I'm allergic to peanuts" onAdd={v => void run('add-fact', () => add(v, 'fact'))} />
          </div>
        </div>
      </div>

      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Preferences {preferences.length > 0 && <span className="text-white/25 normal-case">· {preferences.length}</span>}
        </span>
        <div className="bg-white/5 rounded-2xl px-5 py-2 border border-white/8">
          <p className="text-white/30 text-xs pt-3 pb-1 leading-relaxed">
            How you like answers shaped. She learns these from what you ask for, and offers
            them rather than assuming — you always get the chance to say no.
          </p>
          {preferences.length === 0
            ? <p className="text-white/25 text-sm py-4">Nothing learned yet.</p>
            : preferences.map(m => <MemoryRow key={m.id} item={m} onDelete={del} onUpdate={edit} />)}
          <div className="pb-4">
            <AddRow
              placeholder="When I ask about a game, show a video"
              onAdd={v => void run('add-pref', () => add(v, 'preference'))}
            />
          </div>
        </div>
      </div>

      <MemorySection
        title="Recent context"
        hint="Auto-written at the end of each conversation. Clears itself after 24 hours."
        items={shortTerm}
        empty="Nothing recent."
        onDelete={del}
      />
    </div>
  )
}

// ── Volume slider row (bound to the global volume store) ─────────────────────
interface VolumeSliderProps {
  category: VolumeCategory
  label:    string
  accent:   string  // Tailwind text color for the label/value (e.g. "text-amber-400")
  track:    string  // Tailwind accent-* class for the native slider thumb/track
}

// ── Notion "who am I" picker ──────────────────────────────────────────────────
// Task databases are often shared, so without this the widget lists the whole
// team's rows. Notion's /users/me returns the integration bot rather than the
// human, so the user has to point at themselves once. The choice is persisted
// server-side (notion-me.json) and shared across devices.

interface NotionUser { id: string; name: string; type: string; avatarUrl: string | null }

function NotionMePicker() {
  const [users, setUsers]   = useState<NotionUser[] | null>(null)
  const [meId, setMeId]     = useState<string | null>(null)
  const [error, setError]   = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`${DEBUG_API}/api/notion/users`).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
      fetch(`${DEBUG_API}/api/notion/me`).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
    ])
      .then(([u, m]: [{ users: NotionUser[] }, { me: { id: string } | null }]) => {
        if (cancelled) return
        // Bot users are integrations, not people — never a valid "me".
        setUsers(u.users.filter(x => x.type === 'person'))
        setMeId(m.me?.id ?? null)
      })
      .catch(err => { if (!cancelled) setError(String(err.message ?? err)) })
    return () => { cancelled = true }
  }, [])

  function pick(user: NotionUser | null) {
    setSaving(true)
    const prev = meId
    setMeId(user?.id ?? null)
    fetch(`${DEBUG_API}/api/notion/me`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user ? { id: user.id, name: user.name } : { id: null }),
    })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`) })
      // The task list filters server-side, so it has to refetch to reflect this.
      .then(() => window.dispatchEvent(new CustomEvent('ts:task-dbs-changed')))
      .catch(err => {
        console.error('[Settings] failed to set Notion user:', err)
        setMeId(prev)
      })
      .finally(() => setSaving(false))
  }

  // Notion isn't configured on this server — say nothing rather than show a
  // broken control.
  if (error) return null

  return (
    <div className="mb-6">
      <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">Notion tasks</span>
      <div className="bg-white/5 rounded-2xl border border-white/8 p-5 space-y-3">
        <div>
          <p className="text-white/80 text-sm font-medium">Show only my tasks</p>
          <p className="text-white/40 text-xs mt-0.5">
            Pick yourself and the task widget lists only rows assigned to you. Databases with no
            assignee property stay fully visible.
          </p>
        </div>

        {users === null && <p className="text-white/40 text-sm py-2">Loading…</p>}

        {users?.length === 0 && (
          <p className="text-white/40 text-sm py-2">No workspace members visible to the integration.</p>
        )}

        {users && users.length > 0 && (
          <div className="flex flex-col gap-2">
            {users.map(u => (
              <button
                key={u.id}
                type="button"
                disabled={saving}
                onClick={() => pick(u.id === meId ? null : u)}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors disabled:opacity-50 ${
                  u.id === meId
                    ? 'bg-[var(--accent,#06b6d4)]/20 text-[var(--accent,#06b6d4)] ring-1 ring-[var(--accent,#06b6d4)]/40'
                    : 'bg-white/[0.06] text-white/70 active:bg-white/10'
                }`}
              >
                {u.avatarUrl
                  ? <img src={u.avatarUrl} alt="" className="w-7 h-7 rounded-full shrink-0" />
                  : <span className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-xs shrink-0">
                      {u.name?.[0]?.toUpperCase() ?? '?'}
                    </span>}
                <span className="truncate">{u.name || 'Unnamed'}</span>
                {u.id === meId && <span className="ml-auto text-xs opacity-70">That’s me</span>}
              </button>
            ))}
          </div>
        )}

        {meId === null && users && users.length > 0 && (
          <p className="text-amber-300/70 text-xs">
            Nobody selected — the widget is showing everyone’s tasks.
          </p>
        )}
      </div>
    </div>
  )
}

function VolumeSlider({ category, label, accent, track }: VolumeSliderProps) {
  const volumes = useVolume()
  const value = volumes[category]
  const pct = Math.round(value * 100)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className={`text-sm font-medium ${accent}`}>{label}</span>
        <span className="text-white/50 text-xs font-mono tabular-nums">{pct}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        onChange={e => setVolume(category, Number(e.target.value) / 100)}
        aria-label={`${label} volume`}
        className={`w-full h-2 ${track} cursor-pointer`}
      />
    </div>
  )
}

// ── Debug tab ─────────────────────────────────────────────────────────────────
// Kiosk-friendly diagnostics: what config the server actually sees, whether
// each backend integration responds (and how fast), an LLM round-trip test,
// client environment facts, and the recent runtime error log.

const DEBUG_API = (import.meta.env.VITE_AUDIO_API as string | undefined) ?? ''

interface ServerDebug {
  uptimeSec: number
  node:      string
  platform:  string
  nodeEnv:   string
  cacheDir:  string
  config:    Record<string, boolean>
  ollama:    { url: string; model: string }
  // Faults a boolean can't express — e.g. a key that is present but the wrong
  // shape. Absent on servers older than this field.
  warnings?: string[]
}

interface CheckResult { state: 'ok' | 'fail'; ms: number; detail?: string }

// Stamped into the image at build time; null outside Docker or when a local
// build didn't export GIT_SHA.
interface VersionInfo {
  sha: string | null
  shortSha: string | null
  builtAt: string | null
  repo: string
  branch: string
}

interface UpdateCheck {
  status: 'up-to-date' | 'behind' | 'unknown'
  // Which comparison produced `status` — an exact commit match, or the weaker
  // "was this built before the newest commit landed?". Worth showing, because
  // the two justify different amounts of confidence.
  basis: 'sha' | 'build-time' | 'none'
  behindBy: number | null
  current: { sha: string | null; shortSha: string | null; builtAt: string | null }
  latest: { sha: string; shortSha: string; date: string | null; message: string }
  repo: string
  branch: string
}

/** Coarse "how long ago" for a timestamp. Days is as fine-grained as anyone
 *  cares about for a deployment, and it has to read at arm's length. */
function formatAgo(iso: string | null): string {
  if (!iso) return 'unknown'
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'unknown'
  const mins = Math.floor((Date.now() - then) / 60_000)
  if (mins < 1)     return 'just now'
  if (mins < 60)    return `${mins}m ago`
  if (mins < 1440)  return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

// Display order for the checks list. Paths are resolved at run time because
// weather/air need coordinates (from the geoip check, same as the app itself)
// and calendar needs the current month.
const CHECK_LABELS: { id: string; label: string }[] = [
  { id: 'health',   label: 'Server health' },
  { id: 'geoip',    label: 'Location (GeoIP)' },
  { id: 'weather',  label: 'Weather (OpenWeather)' },
  { id: 'calendar', label: 'Calendar (iCal)' },
  { id: 'air',      label: 'Air quality' },
  { id: 'notion',   label: 'Notion tasks' },
  { id: 'device',   label: 'Device stats (Pi)' },
  // Voice input dies completely when this key is bad, and nothing else in this
  // list would notice — so it gets its own probe rather than being inferred
  // from a TTS test that quietly falls back to espeak and passes.
  { id: 'eleven',   label: 'ElevenLabs key (voice in/out)' },
  // Image generation has no fallback renderer the way TTS has espeak, so "the
  // GPU box is off" is the whole failure and there is nothing else in this list
  // that would hint at it.
  { id: 'comfy',    label: 'ComfyUI (image generation)' },
]

const CONFIG_LABELS: Record<string, string> = {
  OPENWEATHER_API_KEY: 'OpenWeather key',
  CALENDAR_ICAL_URL:   'Calendar iCal URL',
  ELEVENLABS_API_KEY:  'ElevenLabs key',
  NOTION_API_KEY:      'Notion key',
  NOTION_DATABASE_ID:  'Notion database ID',
  OLLAMA_API_KEY:      'Ollama API key',
  DEFAULT_LAT_LON:     'Default coordinates',
  TMDB_API_KEY:        'TMDB key (movie/show art)',
  IGDB_CREDENTIALS:    'IGDB keys (game art)',
}

async function timedFetch(path: string, init?: RequestInit, timeoutMs = 10_000): Promise<{ result: CheckResult; json?: any }> {
  const t0 = performance.now()
  const ctrl = new AbortController()
  const to = window.setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${DEBUG_API}${path}`, { ...init, signal: ctrl.signal })
    const ms = Math.round(performance.now() - t0)
    if (res.ok) {
      let json: any
      try { json = await res.json() } catch { /* non-JSON body is fine */ }
      return { result: { state: 'ok', ms }, json }
    }
    let detail = `HTTP ${res.status}`
    try {
      const j = await res.json() as { error?: string }
      if (j.error) detail += ` — ${j.error}`
    } catch { /* body wasn't JSON */ }
    return { result: { state: 'fail', ms, detail } }
  } catch (err) {
    const ms = Math.round(performance.now() - t0)
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    return { result: { state: 'fail', ms, detail: aborted ? `Timeout after ${timeoutMs / 1000}s` : (err instanceof Error ? err.message : String(err)) } }
  } finally {
    window.clearTimeout(to)
  }
}

function StatusChip({ result }: { result: CheckResult | undefined }) {
  if (!result) return <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-white/60 animate-spin shrink-0" />
  return result.state === 'ok'
    ? <span className="flex items-center gap-1.5 text-emerald-400 text-sm tabular-nums shrink-0"><Check size={15} /> {result.ms}ms</span>
    : <span className="flex items-center gap-1.5 text-red-400 text-sm shrink-0"><XIcon size={15} /> failed</span>
}

function BoolChip({ ok }: { ok: boolean }) {
  return ok
    ? <span className="flex items-center gap-1 text-emerald-400 text-sm"><Check size={14} /> set</span>
    : <span className="flex items-center gap-1 text-white/35 text-sm"><XIcon size={14} /> not set</span>
}

function DebugTab() {
  const [server,    setServer]    = useState<ServerDebug | null>(null)
  const [serverErr, setServerErr] = useState<string | null>(null)
  const [checks,    setChecks]    = useState<Record<string, CheckResult>>({})
  const [checking,  setChecking]  = useState(false)
  const [llm,       setLlm]       = useState<{ state: 'idle' | 'running' | 'done' | 'fail'; ms?: number; text?: string }>({ state: 'idle' })
  const [voices,    setVoices]    = useState<Record<string, CheckResult>>({})
  const [testingVoices, setTestingVoices] = useState(false)
  const [copied,    setCopied]    = useState<string | null>(null)
  const [version,   setVersion]   = useState<VersionInfo | null>(null)
  const [update,    setUpdate]    = useState<{ state: 'idle' | 'checking' | 'done' | 'fail'; data?: UpdateCheck; error?: string }>({ state: 'idle' })
  const errors = useDebugLog()

  async function loadVersion() {
    try {
      const res = await fetch(`${DEBUG_API}/api/system/version`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setVersion(await res.json() as VersionInfo)
    } catch {
      // Endpoint is missing on servers older than this feature, which is itself
      // the answer to "am I up to date?" — handled in the render below.
      setVersion(null)
    }
  }

  // Hits GitHub (through the server, which caches for 5 min). Runs once on open
  // so the answer is just there, and again on demand.
  async function checkUpdate() {
    setUpdate({ state: 'checking' })
    try {
      const res = await fetch(`${DEBUG_API}/api/system/version/check`)
      if (!res.ok) {
        // A 404 isn't a failed check so much as the answer to it: this server
        // is old enough to predate the endpoint, so it is definitely behind.
        if (res.status === 404) throw new Error('This server predates the update check — it is out of date. Rebuild the container.')
        const j = await res.json().catch(() => ({})) as { detail?: string; error?: string }
        throw new Error(j.detail ?? j.error ?? `HTTP ${res.status}`)
      }
      setUpdate({ state: 'done', data: await res.json() as UpdateCheck })
    } catch (err) {
      setUpdate({ state: 'fail', error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function loadServer() {
    setServerErr(null)
    try {
      const res = await fetch(`${DEBUG_API}/api/system/debug`)
      if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 404 ? ' — server predates this endpoint; rebuild the container' : ''}`)
      setServer(await res.json() as ServerDebug)
    } catch (err) {
      setServerErr(err instanceof Error ? err.message : String(err))
    }
  }

  async function runChecks() {
    if (checking) return
    setChecking(true)
    setChecks({})

    // GeoIP first — its coordinates feed the weather/air probes, exactly like
    // the widgets do. Falls back to 0,0 so the OpenWeather key still gets
    // exercised even when geoip is down.
    const geo = await timedFetch('/api/geoip')
    setChecks(prev => ({ ...prev, geoip: geo.result }))
    const lat = typeof geo.json?.lat === 'number' ? geo.json.lat : 0
    const lon = typeof geo.json?.lon === 'number' ? geo.json.lon : 0
    const now = new Date()

    const endpoints: { id: string; path: string }[] = [
      { id: 'health',   path: '/api/health' },
      { id: 'weather',  path: `/api/weather?lat=${lat}&lon=${lon}` },
      { id: 'calendar', path: `/api/calendar/month?year=${now.getFullYear()}&month=${now.getMonth() + 1}` },
      { id: 'air',      path: `/api/airquality?lat=${lat}&lon=${lon}` },
      { id: 'notion',   path: '/api/notion/tasks' },
      { id: 'device',   path: '/api/device' },
      { id: 'eleven',   path: '/api/system/check/elevenlabs' },
      { id: 'comfy',    path: '/api/image/check' },
    ]
    await Promise.all(endpoints.map(async ep => {
      const { result, json } = await timedFetch(ep.path)
      // A valid key that has burned its whole quota passes authentication and
      // then fails every synthesis — reported here rather than shown as a
      // clean pass, since the symptom is identical to a dead key.
      if (ep.id === 'eleven' && result.state === 'ok' && json?.quotaExhausted) {
        setChecks(prev => ({ ...prev, [ep.id]: { ...result, state: 'fail', detail: `quota exhausted (${json.charactersUsed}/${json.characterLimit} characters)` } }))
        return
      }
      // The ComfyUI probe reports the card and its free VRAM. That's the number
      // you want when a render fails, so keep it rather than a bare "ok".
      if (ep.id === 'comfy' && result.state === 'ok' && typeof json?.detail === 'string') {
        setChecks(prev => ({ ...prev, [ep.id]: { ...result, detail: json.detail } }))
        return
      }
      setChecks(prev => ({ ...prev, [ep.id]: result }))
    }))
    setChecking(false)
  }

  useEffect(() => {
    void loadVersion()
    void checkUpdate()
    void loadServer()
    void runChecks()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function testLlm() {
    if (llm.state === 'running') return
    setLlm({ state: 'running' })
    const t0 = performance.now()
    try {
      const ctrl = new AbortController()
      const to = window.setTimeout(() => ctrl.abort(), 60_000)
      const res = await fetch(`${DEBUG_API}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }] }),
        signal:  ctrl.signal,
      })
      window.clearTimeout(to)
      const ms = Math.round(performance.now() - t0)
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        setLlm({ state: 'fail', ms, text: `HTTP ${res.status} ${detail.slice(0, 160)}` })
        return
      }
      const json = await res.json() as { reply?: string }
      setLlm({ state: 'done', ms, text: (json.reply ?? '').trim().slice(0, 160) || '(empty reply)' })
    } catch (err) {
      const ms = Math.round(performance.now() - t0)
      const aborted = err instanceof DOMException && err.name === 'AbortError'
      setLlm({ state: 'fail', ms, text: aborted ? 'Timeout after 60s' : (err instanceof Error ? err.message : String(err)) })
    }
  }

  // Synthesize a 1-word clip for each assistant to see which voices actually
  // work. Surfaces the exact TTS error (e.g. an unavailable ElevenLabs voice)
  // per profile. Sequential so we don't fire five ElevenLabs calls at once.
  async function testVoices() {
    if (testingVoices) return
    setTestingVoices(true)
    setVoices({})
    for (const id of ASSISTANT_ORDER) {
      const t0 = performance.now()
      try {
        const res = await fetch(`${DEBUG_API}/api/tts?as=${id}&text=hi`)
        const ms = Math.round(performance.now() - t0)
        if (res.ok) {
          // A 200 only means *something* spoke. The provider chain falls back
          // silently, so record which engine it actually was — "ok (espeak)"
          // is a failure of the configured voice, not a pass.
          const engine = res.headers.get('x-tts-provider') ?? ''
          setVoices(prev => ({ ...prev, [id]: { state: 'ok', ms, detail: engine } }))
        } else {
          let detail = `HTTP ${res.status}`
          try {
            const j = await res.json() as { error?: string; detail?: string }
            if (j.detail) detail += ` — ${j.detail}`
            else if (j.error) detail += ` — ${j.error}`
          } catch { /* non-JSON body */ }
          setVoices(prev => ({ ...prev, [id]: { state: 'fail', ms, detail } }))
        }
      } catch (err) {
        const ms = Math.round(performance.now() - t0)
        setVoices(prev => ({ ...prev, [id]: { state: 'fail', ms, detail: err instanceof Error ? err.message : String(err) } }))
      }
    }
    setTestingVoices(false)
  }

  async function copyDiagnostics() {
    const payload = {
      at:      new Date().toISOString(),
      version,
      update:  update.state === 'fail' ? { error: update.error } : update.data,
      server:  serverErr ? { error: serverErr } : server,
      checks,
      llm,
      voices,
      client: {
        secureContext: window.isSecureContext,
        online:        navigator.onLine,
        viewport:      `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`,
        userAgent:     navigator.userAgent,
        audioApi:      DEBUG_API || '(same origin)',
      },
      recentErrors: getDebugLog().slice(-20),
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setCopied('Copied to clipboard')
    } catch {
      setCopied('Clipboard unavailable — needs HTTPS')
    }
    window.setTimeout(() => setCopied(null), 2500)
  }

  const rowClass = 'flex items-center justify-between gap-3 px-5 py-3.5'

  const upd = update.data

  return (
    <div className="space-y-4 max-w-lg mx-auto">
      {/* ── Version / update ──
          Top of the tab on purpose: with Watchtower swapping images silently,
          "which build is this?" is the first thing you need when something on
          screen doesn't match the code you just pushed. */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">Version</span>
        <button
          onClick={() => { void loadVersion(); void checkUpdate() }}
          disabled={update.state === 'checking'}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 text-white/60 text-xs font-medium active:bg-white/20 disabled:opacity-40"
        >
          <RotateCw size={13} className={update.state === 'checking' ? 'animate-spin' : ''} /> Check
        </button>
      </div>
      <div className="bg-white/5 rounded-2xl border border-white/8 overflow-hidden divide-y divide-white/8">
        <div className={rowClass}>
          <span className="text-sm text-white/70">Running build</span>
          <span className="text-sm text-white/60 text-right">
            {version?.shortSha
              ? <span className="font-mono">{version.shortSha}</span>
              : <span className="text-white/35">unknown commit</span>}
            {version?.builtAt && <><br /><span className="text-white/40 text-xs">built {formatAgo(version.builtAt)}</span></>}
          </span>
        </div>

        {/* Update verdict */}
        <div className="px-5 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-white/70">Update status</span>
            {update.state === 'checking' && <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-white/60 animate-spin shrink-0" />}
            {update.state === 'fail' && <span className="flex items-center gap-1.5 text-red-400 text-sm shrink-0"><XIcon size={15} /> check failed</span>}
            {update.state === 'done' && upd?.status === 'up-to-date' && (
              <span className="flex items-center gap-1.5 text-emerald-400 text-sm shrink-0"><Check size={15} /> up to date</span>
            )}
            {update.state === 'done' && upd?.status === 'behind' && (
              <span className="flex items-center gap-1.5 text-amber-400 text-sm shrink-0">
                <Download size={15} /> {upd.behindBy !== null ? `${upd.behindBy} commit${upd.behindBy === 1 ? '' : 's'} behind` : 'update available'}
              </span>
            )}
            {update.state === 'done' && upd?.status === 'unknown' && (
              <span className="text-white/35 text-sm shrink-0">can’t tell</span>
            )}
          </div>

          {update.state === 'fail' && (
            <p className="text-xs text-red-400/80 mt-1 break-all">{update.error}</p>
          )}
          {update.state === 'done' && upd && (
            <p className="text-xs text-white/40 mt-1 break-words">
              {upd.status === 'up-to-date'
                ? `Matches ${upd.branch} — “${upd.latest.message}”`
                : upd.status === 'behind'
                  ? <>Latest on {upd.branch}: <span className="font-mono text-white/50">{upd.latest.shortSha}</span> {formatAgo(upd.latest.date)} — “{upd.latest.message}”</>
                  : 'This build carries no commit stamp and no build time, so it can’t be compared. Rebuild the image to enable the check.'}
              {/* An image built without GIT_SHA can only be dated, not
                  identified — say so, or "up to date" reads stronger than it is. */}
              {upd.basis === 'build-time' && (
                <><br /><span className="text-white/30">Compared by build time — no commit stamp in this image.</span></>
              )}
            </p>
          )}
        </div>
      </div>

      {/* ── Server configuration ── */}
      <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">Server configuration</span>
      <div className="bg-white/5 rounded-2xl border border-white/8 overflow-hidden divide-y divide-white/8">
        {serverErr && (
          <p className="px-5 py-4 text-sm text-red-400">{serverErr}</p>
        )}
        {!serverErr && !server && (
          <p className="px-5 py-4 text-sm text-white/40">Loading…</p>
        )}
        {server?.warnings?.map((w, i) => (
          <p key={i} className="px-5 py-3.5 text-sm text-amber-300/90 bg-amber-500/10 leading-snug">{w}</p>
        ))}
        {server && (
          <>
            <div className={rowClass}>
              <span className="text-sm text-white/70">Server uptime</span>
              <span className="text-sm text-white/60 tabular-nums">{formatUptime(server.uptimeSec)} · {server.nodeEnv}</span>
            </div>
            <div className={rowClass}>
              <span className="text-sm text-white/70">Runtime</span>
              <span className="text-sm text-white/60">{server.node} · {server.platform}</span>
            </div>
            {Object.entries(server.config).map(([key, ok]) => (
              <div key={key} className={rowClass}>
                <span className="text-sm text-white/70">{CONFIG_LABELS[key] ?? key}</span>
                <BoolChip ok={ok} />
              </div>
            ))}
            <div className={rowClass}>
              <span className="text-sm text-white/70 shrink-0">Ollama</span>
              <span className="text-sm text-white/60 text-right break-all">{server.ollama.model}<br /><span className="text-white/40 text-xs">{server.ollama.url}</span></span>
            </div>
          </>
        )}
      </div>

      {/* ── Endpoint checks ── */}
      <div className="flex items-center justify-between mt-6 mb-2">
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">Connection checks</span>
        <button
          onClick={() => { void loadServer(); void runChecks() }}
          disabled={checking}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 text-white/60 text-xs font-medium active:bg-white/20 disabled:opacity-40"
        >
          <RotateCw size={13} className={checking ? 'animate-spin' : ''} /> Re-run
        </button>
      </div>
      <div className="bg-white/5 rounded-2xl border border-white/8 overflow-hidden divide-y divide-white/8">
        {CHECK_LABELS.map(ep => {
          const result = checks[ep.id]
          return (
            <div key={ep.id} className="px-5 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-white/70">{ep.label}</span>
                <StatusChip result={result} />
              </div>
              {result?.state === 'fail' && result.detail && (
                <p className="text-xs text-red-400/80 mt-1 break-all">{result.detail}</p>
              )}
            </div>
          )
        })}
        {/* LLM round-trip — separate button because it costs an inference call */}
        <div className="px-5 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-white/70">LLM chat (Ollama)</span>
            {llm.state === 'idle' && (
              <button onClick={() => void testLlm()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-500/20 text-blue-300 text-xs font-medium active:bg-blue-500/35">
                <MessageSquare size={13} /> Test
              </button>
            )}
            {llm.state === 'running' && <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-blue-400 animate-spin" />}
            {llm.state === 'done' && <span className="flex items-center gap-1.5 text-emerald-400 text-sm tabular-nums"><Check size={15} /> {llm.ms}ms</span>}
            {llm.state === 'fail' && (
              <button onClick={() => void testLlm()} className="flex items-center gap-1.5 text-red-400 text-sm active:opacity-70">
                <XIcon size={15} /> failed — retry
              </button>
            )}
          </div>
          {llm.text && llm.state !== 'running' && (
            <p className={`text-xs mt-1 break-all ${llm.state === 'fail' ? 'text-red-400/80' : 'text-white/50'}`}>
              {llm.state === 'done' ? `Reply: “${llm.text}”` : llm.text}
            </p>
          )}
        </div>
      </div>

      {/* ── Voices (TTS) ── */}
      <div className="flex items-center justify-between mt-6 mb-2">
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">Voices (TTS)</span>
        <button onClick={() => void testVoices()} disabled={testingVoices}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-500/20 text-blue-300 text-xs font-medium active:bg-blue-500/35 disabled:opacity-50">
          <Volume2 size={13} className={testingVoices ? 'animate-pulse' : ''} /> {testingVoices ? 'Testing…' : 'Test voices'}
        </button>
      </div>
      {(testingVoices || Object.keys(voices).length > 0) ? (
        <div className="bg-white/5 rounded-2xl border border-white/8 overflow-hidden divide-y divide-white/8">
          {ASSISTANT_ORDER.map(id => {
            const result = voices[id]
            return (
              <div key={id} className="px-5 py-3.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-white/70">{ASSISTANT_PROFILES[id].name} <span className="text-white/30 font-mono text-xs">{id}</span></span>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* espeak is the floor of the fallback chain — reaching it
                        means the configured voice failed, so it reads amber
                        rather than passing quietly as green. */}
                    {result?.state === 'ok' && result.detail && (
                      <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${result.detail === 'espeak' ? 'bg-amber-500/20 text-amber-300' : 'bg-white/10 text-white/50'}`}>
                        {result.detail}
                      </span>
                    )}
                    <StatusChip result={result} />
                  </div>
                </div>
                {result?.state === 'ok' && result.detail === 'espeak' && (
                  <p className="text-xs text-amber-400/70 mt-1">Fell back to the offline robot voice — the configured provider failed.</p>
                )}
                {result?.state === 'fail' && result.detail && (
                  <p className="text-xs text-red-400/80 mt-1 break-all font-mono">{result.detail}</p>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-white/30 text-xs leading-relaxed bg-white/5 rounded-2xl border border-white/8 px-5 py-4">
          Synthesizes a one-word clip for each assistant to check its voice. Reveals TTS errors — e.g. an ElevenLabs voice that isn't available to this server's account.
        </p>
      )}

      {/* ── Client environment ── */}
      <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mt-6 mb-2">This screen</span>
      <div className="bg-white/5 rounded-2xl border border-white/8 overflow-hidden divide-y divide-white/8">
        <div className={rowClass}>
          <span className="text-sm text-white/70">Secure context (mic/camera)</span>
          <BoolChip ok={window.isSecureContext} />
        </div>
        <div className={rowClass}>
          <span className="text-sm text-white/70">Network</span>
          <span className={`text-sm ${navigator.onLine ? 'text-emerald-400' : 'text-red-400'}`}>{navigator.onLine ? 'online' : 'offline'}</span>
        </div>
        <div className={rowClass}>
          <span className="text-sm text-white/70">Viewport</span>
          <span className="text-sm text-white/60 tabular-nums">{window.innerWidth}×{window.innerHeight} @{window.devicePixelRatio}x</span>
        </div>
        <div className={rowClass}>
          <span className="text-sm text-white/70 shrink-0">Audio API base</span>
          <span className="text-sm text-white/60 break-all text-right">{DEBUG_API || '(same origin)'}</span>
        </div>
        <div className="px-5 py-3.5">
          <span className="text-sm text-white/70 block mb-1">User agent</span>
          <span className="text-xs text-white/40 break-all">{navigator.userAgent}</span>
        </div>
      </div>

      {/* ── Runtime errors ── */}
      <div className="flex items-center justify-between mt-6 mb-2">
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">Runtime errors ({errors.length})</span>
        {errors.length > 0 && (
          <button onClick={clearDebugLog}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 text-white/60 text-xs font-medium active:bg-white/20">
            <Trash2 size={13} /> Clear
          </button>
        )}
      </div>
      <div className="bg-white/5 rounded-2xl border border-white/8 overflow-hidden divide-y divide-white/8 max-h-64 overflow-y-auto">
        {errors.length === 0 && (
          <p className="px-5 py-4 text-sm text-white/35">No errors captured since load.</p>
        )}
        {[...errors].reverse().map((e, i) => (
          <div key={`${e.ts}-${i}`} className="px-5 py-3">
            <div className="flex items-center gap-2">
              <span className={`text-[11px] font-semibold uppercase tracking-wider ${e.kind === 'console' ? 'text-amber-400/80' : 'text-red-400/80'}`}>{e.kind}</span>
              <span className="text-xs text-white/35 tabular-nums">{new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            </div>
            <p className="text-xs text-white/60 mt-1 break-all">{e.message}</p>
          </div>
        ))}
      </div>

      {/* ── Copy diagnostics ── */}
      <button
        onClick={() => void copyDiagnostics()}
        className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-white/10 border border-white/10 text-white/70 text-sm font-medium active:bg-white/20 mt-4"
      >
        <ClipboardCopy size={16} /> {copied ?? 'Copy full diagnostics'}
      </button>
    </div>
  )
}

// ── VTuber preview ────────────────────────────────────────────────────────────
// A live window onto the character, inside the settings overlay. It's a second,
// settings-scoped instance of the exact renderer the dashboard uses, so what
// you see here — model, framing, gestures fired from the test board — is what
// the kiosk shows. It keeps its own status/fps state rather than reporting into
// the global stores: those belong to the REAL avatar behind this overlay, and
// two writers would fight over them.
interface VTuberPreviewProps {
  spec: AvatarSpec
  enabled: boolean
  zoom: number
  offsetY: number
}

function VTuberPreview({ spec, enabled, zoom, offsetY }: VTuberPreviewProps) {
  const [status, setStatus] = useState<AvatarStatus>('loading')
  const [detail, setDetail] = useState<string | undefined>(undefined)
  const [fps, setFps]       = useState(0)

  const showModel = enabled && spec.kind !== 'sphere'

  // Taller in the two-column layout: the frame is a portrait column there, and
  // the extra height is free — it no longer pushes any controls down.
  return (
    <div className="relative h-[380px] sm:h-[440px] rounded-2xl border border-white/10 bg-[#0b0b12] overflow-hidden shadow-lg">
      {showModel && (
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-white/40 text-xs">Loading renderer…</p>
            </div>
          }
        >
          {spec.kind === 'live2d' ? (
            <Live2DRenderer
              key={spec.model}
              mode="work"
              voiceListening={false}
              voiceSpeaking={false}
              voiceVolume={0}
              modelUrl={spec.model}
              zoom={zoom}
              offsetY={offsetY}
              // The controls sit right beside her here, so head-tracking would
              // turn her away from the camera on every slider drag and cue tap
              // — exactly when you're trying to look at the face.
              trackPointer={false}
              onStatus={(s, d) => { setStatus(s); setDetail(d) }}
              onFps={setFps}
            />
          ) : spec.kind === 'vrm' ? (
            <AvatarRenderer
              key={spec.model}
              mode="work"
              voiceListening={false}
              voiceSpeaking={false}
              voiceVolume={0}
              modelUrl={spec.model}
              animUrl={spec.anim}
              zoom={zoom}
              offsetY={offsetY}
              trackPointer={false}
              onStatus={(s, d) => { setStatus(s); setDetail(d) }}
              onFps={setFps}
            />
          ) : null}
        </Suspense>
      )}

      {/* Guidance overlays for every state where there's nothing to show. */}
      {!enabled && (
        <div className="absolute inset-0 flex items-center justify-center px-8">
          <p className="text-white/40 text-sm text-center leading-relaxed">
            The avatar is off — flip the toggle below to bring the character in.
          </p>
        </div>
      )}
      {enabled && spec.kind === 'sphere' && (
        <div className="absolute inset-0 flex items-center justify-center px-8">
          <p className="text-white/40 text-sm text-center leading-relaxed">
            The orb has no character to preview — pick a model below.
          </p>
        </div>
      )}
      {showModel && status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-amber-300/80 text-xs animate-pulse">Loading model…</p>
        </div>
      )}
      {showModel && status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <div className="text-center space-y-1">
            <p className="text-red-300/90 text-xs font-medium">Couldn’t load the model.</p>
            {detail && <p className="text-white/30 text-xs font-mono break-words">{detail}</p>}
          </div>
        </div>
      )}
      {showModel && status === 'ready' && (
        <span className="absolute bottom-2 right-3 text-[10px] font-mono text-white/35">{fps} fps</span>
      )}
    </div>
  )
}
