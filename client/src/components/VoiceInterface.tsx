import type { VoiceState } from '../hooks/useVoice'

interface Props {
  voice: VoiceState
}

export function VoiceInterface({ voice }: Props) {
  const { isListening, isSpeaking, isTranscribing, isThinking, transcript, reply, error, stopSpeaking } = voice

  return (
    <>
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

    </>
  )
}
