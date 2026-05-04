import type { VoiceState } from '../hooks/useVoice'

interface Props {
  voice: VoiceState
}

export function VoiceInterface({ voice }: Props) {
  const { isListening, isSpeaking, transcript, reply, startListening, stopListening } = voice

  return (
    <>
      {/* ── Text overlay (transcript + reply) ── */}
      {(transcript || reply) && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-20 z-30 w-[min(88vw,500px)] flex flex-col items-center gap-3 pointer-events-none">
          {transcript && (
            <div className="bg-black/65 backdrop-blur-md rounded-2xl px-5 py-3 border border-white/10 w-full">
              <p className="text-cyan-300 text-[15px] text-center leading-relaxed tracking-wide">
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
        </div>
      )}

      {/* ── Listening ring animation ── */}
      {isListening && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-3 z-10 pointer-events-none">
          <div className="voice-ping w-10 h-10 rounded-full border-2 border-green-400/60" />
        </div>
      )}

      {/* ── Microphone button — left of settings ── */}
      <button
        onClick={isListening ? stopListening : startListening}
        className={[
          'absolute bottom-3 right-[calc(50%+28px)] z-20 w-10 h-10 rounded-full flex items-center justify-center',
          'backdrop-blur-md transition-all duration-200 active:scale-90',
          isListening
            ? 'bg-green-500/25 border border-green-400/60 text-green-300 shadow-[0_0_18px_rgba(74,222,128,0.45)]'
            : isSpeaking
              ? 'bg-amber-500/20 border border-amber-400/50 text-amber-300'
              : 'bg-white/8 border border-white/15 text-white/40 hover:bg-white/15 hover:text-white/70',
        ].join(' ')}
        aria-label={isListening ? 'Stop listening' : 'Start voice input'}
      >
        {isListening ? (
          /* Mic-off / stop icon */
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        ) : (
          /* Mic icon */
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        )}
      </button>

      {/* ── Speaker indicator — right of settings (only while speaking) ── */}
      {isSpeaking && (
        <button
          onClick={() => window.speechSynthesis.cancel()}
          className="absolute bottom-3 left-[calc(50%+28px)] z-20 w-10 h-10 rounded-full flex items-center justify-center backdrop-blur-md bg-amber-500/20 border border-amber-400/50 text-amber-300 hover:bg-amber-500/30 active:scale-90 transition-all duration-200"
          aria-label="Stop speaking"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-pulse">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        </button>
      )}

    </>
  )
}
