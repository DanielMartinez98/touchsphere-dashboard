import { useState, useRef } from 'react'
import { useAudioDevices } from '../hooks/useAudioDevices'
import { useDevice } from '../hooks/useDevice'
import { playSound, playRecordChime } from '../utils/sound'
import { useVolume, setVolume, getEffectiveGain, type VolumeCategory } from '../hooks/useVolume'
import { useWakeWordEnabled, setWakeWordEnabled, useWakeWordTranscript, useWakeWordStatus } from '../hooks/useWakeWord'

type Tab = 'sounds' | 'hardware' | 'system'

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

export function SettingsPanel() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('sounds')
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
    { id: 'sounds',   label: 'Audio'    },
    { id: 'hardware', label: 'Hardware' },
    { id: 'system',   label: 'System'   },
  ]

  return (
    <>
      {/* Settings gear button — bottom center, enlarged */}
      <button
        onClick={() => setOpen(true)}
        className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 w-16 h-16 rounded-full bg-white/10 border-2 border-white/40 flex items-center justify-center text-white/70 hover:bg-white/20 hover:text-white active:scale-90 transition-all backdrop-blur-md shadow-lg"
        aria-label="Settings"
      >
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

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

          {/* ── Tab bar ── */}
          <div className="flex gap-1 px-6 pb-4 flex-shrink-0">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95 ${
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

                {/* Wake word — always-on offline detection via Vosk WASM. When
                    enabled, saying “Jarvis” activates the assistant just like
                    tapping the orb. The model file (~40 MB) must be present at
                    /vosk-model-small-en-us-0.15.zip in the public folder. */}
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
                        <p className="text-white/70 text-sm font-medium">Always listen for “Jarvis”</p>
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
                                                            'bg-white/8       text-white/40'
                      }`}>
                        {wakeStatus.status === 'listening' ? '● listening'  :
                         wakeStatus.status === 'cooldown'  ? '● woke!'        :
                         wakeStatus.status === 'loading'   ? 'loading model…' :
                         wakeStatus.status === 'error'     ? 'error'           :
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
                      Audio is processed locally and never sent over the network. Say “Jarvis” to trigger the assistant.
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

            {/* System tab */}
            {tab === 'system' && (
              <div className="space-y-4 max-w-lg mx-auto">
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

          </div>
        </div>
      )}
    </>
  )
}

// ── Volume slider row (bound to the global volume store) ─────────────────────
interface VolumeSliderProps {
  category: VolumeCategory
  label:    string
  accent:   string  // Tailwind text color for the label/value (e.g. "text-amber-400")
  track:    string  // Tailwind accent-* class for the native slider thumb/track
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
