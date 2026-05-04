import { useCallback, useRef, useState } from 'react'

// Server base URL — comes from Vite env so the Pi can hit a different host.
// Set in client/.env:   VITE_AUDIO_API=http://192.168.1.50:3001
const API = import.meta.env.VITE_AUDIO_API ?? ''

export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const start = useCallback(async () => {
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('getUserMedia unavailable — page must be HTTPS or origin must be whitelisted in Chromium.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          sampleRate: 48000,
        },
      })
      streamRef.current = stream

      // Opus in WebM is universally supported by Chromium and tiny on the wire.
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 24000 })
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mime })
        stream.getTracks().forEach((t) => t.stop())
        await uploadClip(blob)
      }
      rec.start(250) // emit chunks every 250ms
      recorderRef.current = rec
      setIsRecording(true)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const stop = useCallback(() => {
    recorderRef.current?.stop()
    recorderRef.current = null
    setIsRecording(false)
  }, [])

  return { isRecording, error, start, stop }
}

async function uploadClip(blob: Blob) {
  const fd = new FormData()
  fd.append('clip', blob, `clip-${Date.now()}.webm`)
  const res = await fetch(`${API}/api/audio/upload`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
}

/** Play an audio file served by the remote API. */
export function playRemoteAudio(path: string) {
  const url = path.startsWith('http') ? path : `${API}${path}`
  const a = new Audio(url)
  a.crossOrigin = 'anonymous'
  // Returns a promise; surface failure so caller can prompt a tap if autoplay is blocked.
  return a.play().then(() => a)
}
