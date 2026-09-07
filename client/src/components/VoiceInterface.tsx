import { useState } from 'react'
import { Keyboard, Send, X } from 'lucide-react'
import type { VoiceState } from '../hooks/useVoice'
import { TouchInput } from './TouchInput'

interface Props {
  voice: VoiceState
  /** Offer the keyboard button beside the sphere. Off on the phone layout, which has its own field. */
  typing?: boolean
}

/**
 * Typing to the assistant. A sheet at the bottom of the screen with one
 * field and a Send button; the on-screen keyboard rises under it, and the
 * sheet sits on the keyboard's top edge (`--ts-keyboard-h`) so the field is
 * never covered. Sending runs the same turn the microphone would — the reply
 * is spoken and shown exactly as for a spoken question — so this is the way
 * to ask in a noisy room, or to ask something long and exact.
 */
function TypeSheet({ onSend, onClose, busy }: { onSend: (t: string) => void; onClose: () => void; busy: boolean }) {
  const [text, setText] = useState('')
  const send = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
    onClose()
  }
  return (
    <div
      className="fixed left-0 right-0 z-[9050] px-3 pb-3 kb-room"
      style={{ bottom: 'var(--ts-keyboard-h, 0px)' }}
      onPointerDown={e => e.stopPropagation()}
    >
      <div className="mx-auto w-[min(96vw,640px)] rounded-3xl bg-[#101014]/95 backdrop-blur-md border border-white/15 shadow-2xl p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <p className="text-[13px] text-white/60 font-semibold tracking-wide">Type to her</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center active:scale-95 transition"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1 min-w-0">
            <TouchInput
              value={text}
              onChange={setText}
              multiline
              rows={2}
              placeholder="Ask her anything…"
              ariaLabel="Type a message to the assistant"
              className="w-full bg-white/10 text-white rounded-2xl px-4 py-3 text-[16px] leading-relaxed
                         placeholder:text-white/30 border border-hairline"
            />
          </div>
          <button
            type="button"
            onClick={send}
            disabled={!text.trim()}
            aria-label="Send"
            className="h-12 px-5 rounded-2xl bg-amber-400/25 border border-amber-300/40 text-amber-100
                       font-semibold flex items-center gap-2 active:scale-95 transition disabled:opacity-40"
          >
            <Send size={16} />
            {busy ? 'Interrupt' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function VoiceInterface({ voice, typing = false }: Props) {
  const { isListening, isSpeaking, isTranscribing, isThinking, transcript, reply, error, stopSpeaking, cancelListening, sendText } = voice
  const [typeOpen, setTypeOpen] = useState(false)

  return (
    <>
      {/* ── Keyboard: type instead of speaking. Sits just outside the sphere's
             tap circle, lower-right, so it is reachable without touching the
             orb; hidden while the sheet is up. ── */}
      {typing && !typeOpen && (
        <button
          type="button"
          onClick={() => setTypeOpen(true)}
          aria-label="Type to the assistant"
          className="absolute left-1/2 top-1/2 z-20 translate-x-[140px] translate-y-[140px] w-14 h-14 rounded-full
                     bg-black/55 backdrop-blur-md border border-white/20 text-white/80 flex items-center justify-center
                     active:scale-95 transition shadow-lg"
        >
          <Keyboard size={22} />
        </button>
      )}
      {typing && typeOpen && (
        <TypeSheet onSend={sendText} onClose={() => setTypeOpen(false)} busy={isSpeaking || isThinking} />
      )}

      {/* ── Error toast (mic blocked / not secure) ── */}
      {error && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-28 z-40 w-[min(88vw,500px)] pointer-events-none">
          <div className="bg-red-500/20 backdrop-blur-md rounded-2xl px-5 py-3 border border-red-500/40 w-full flex items-center gap-3">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-300 flex-shrink-0">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <p className="text-red-200 text-sm leading-snug">{error}</p>
          </div>
        </div>
      )}

      {/* ── Text overlay (transcript + reply) ── */}
      {(transcript || reply || isTranscribing || isThinking) && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-28 z-30 w-[min(88vw,500px)] flex flex-col items-center gap-3 pointer-events-none">
          {/* Transcript from ElevenLabs Scribe — distinct violet color so it
              reads as "what you said" vs. the amber AI reply below. */}
          {isTranscribing && !transcript && (
            <div className="bg-black/65 backdrop-blur-md rounded-2xl px-5 py-3 border border-violet-500/25 w-full">
              <p className="text-violet-300/70 text-[15px] text-center leading-relaxed tracking-wide italic">
                Transcribing…
              </p>
            </div>
          )}
          {/* Thinking — between transcript shown and the reply arriving. */}
          {isThinking && !isTranscribing && transcript && !reply && (
            <div className="bg-black/65 backdrop-blur-md rounded-2xl px-5 py-3 border border-amber-500/20 w-full">
              <p className="text-amber-300/60 text-[15px] text-center leading-relaxed tracking-wide italic">
                Thinking…
              </p>
            </div>
          )}
          {transcript && (
            <div className="bg-black/65 backdrop-blur-md rounded-2xl px-5 py-3 border border-violet-500/30 w-full">
              <p className="text-violet-300 text-[15px] text-center leading-relaxed tracking-wide">
                {transcript}
              </p>
            </div>
          )}
          {reply && (
            <div className="bg-black/65 backdrop-blur-md rounded-2xl px-5 py-3 border border-amber-500/25 w-full">
              <p className="text-amber-400 text-[15px] text-center leading-relaxed tracking-wide">
                {reply}
              </p>
            </div>
          )}
          {/* Stop button — shows only while the assistant is talking so a spoken
              reply can be cut off with one tap. Sits just under the reply and
              well clear of the settings gear below. */}
          {isSpeaking && (
            <button
              type="button"
              onClick={stopSpeaking}
              aria-label="Stop talking"
              className="voice-stop pointer-events-auto flex items-center gap-2 rounded-full bg-red-500/25 backdrop-blur-md border border-red-400/45 px-6 py-3 text-red-100 text-[15px] font-medium active:scale-95 transition-transform shadow-lg"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <rect x="6" y="6" width="12" height="12" rx="2.5" />
              </svg>
              Stop
            </button>
          )}
        </div>
      )}

      {/* ── Listening ring animation — centered around the orb ── */}
      {isListening && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 pointer-events-none">
          <div className="voice-ping w-24 h-24 rounded-full border-2 border-green-400/60" />
        </div>
      )}

      {/* ── "Stop listening" — shows only while the mic is open, so the user can
             shut it up mid-sentence. Discards the capture rather than sending
             it. Sits in the same slot as the speaking "Stop" button, which is
             never on screen at the same time. ── */}
      {isListening && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-28 z-30 flex justify-center">
          <button
            type="button"
            onClick={cancelListening}
            aria-label="Stop listening"
            className="voice-stop flex items-center gap-2 rounded-full bg-green-500/20 backdrop-blur-md border border-green-400/45 px-6 py-3 text-green-100 text-[15px] font-medium active:scale-95 transition-transform shadow-lg whitespace-nowrap"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="2" y1="2" x2="22" y2="22" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
              <line x1="12" y1="19" x2="12" y2="23" />
            </svg>
            Stop listening
          </button>
        </div>
      )}
    </>
  )
}
