import { useCallback, useRef, useState } from 'react'

// One-shot dictation. Lighter than useVoice — no chat loop, no TTS — just
// browser SpeechRecognition resolving with the transcribed text. Used for
// quick-capture flows like "speak a task title".

interface SR extends EventTarget {
  continuous:     boolean
  interimResults: boolean
  lang:           string
  onresult:       ((e: any) => void) | null
  onerror:        ((e: any) => void) | null
  onend:          ((e: any) => void) | null
  start():        void
  stop():         void
  abort():        void
}
type SRCtor = new () => SR

function getRecognition(): SR | null {
  const w = window as any
  const Ctor: SRCtor | undefined = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) return null
  const r = new Ctor()
  r.continuous     = false
  r.interimResults = true
  r.lang           = navigator.language || 'en-US'
  return r
}

export function useVoiceCapture() {
  const [listening, setListening] = useState(false)
  const [interim,   setInterim]   = useState('')
  const recRef = useRef<SR | null>(null)
  const resolveRef = useRef<((text: string) => void) | null>(null)

  const supported = typeof window !== 'undefined' &&
    !!((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition)

  const start = useCallback((): Promise<string> => {
    return new Promise<string>((resolve) => {
      const rec = getRecognition()
      if (!rec) { resolve(''); return }
      let finalText = ''
      rec.onresult = (e: any) => {
        let interimText = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i]
          if (res.isFinal) finalText += res[0].transcript
          else interimText += res[0].transcript
        }
        setInterim(finalText + interimText)
      }
      rec.onerror = () => { /* surfaced via onend */ }
      rec.onend = () => {
        setListening(false)
        setInterim('')
        recRef.current = null
        resolve(finalText.trim())
      }
      recRef.current = rec
      resolveRef.current = resolve
      try {
        rec.start()
        setListening(true)
      } catch {
        setListening(false)
        resolve('')
      }
    })
  }, [])

  const stop = useCallback(() => {
    recRef.current?.stop()
  }, [])

  const cancel = useCallback(() => {
    recRef.current?.abort()
    setListening(false)
    setInterim('')
  }, [])

  return { supported, listening, interim, start, stop, cancel }
}
