import type { VoiceState } from '../hooks/useVoice'

interface Props {
  voice: VoiceState
}

export function VoiceInterface({ voice }: Props) {
  const { isListening, transcript, reply } = voice

  return (
    <>
      {/* ── Text overlay (transcript + reply) ── */}
      {(transcript || reply) && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-28 z-30 w-[min(88vw,500px)] flex flex-col items-center gap-3 pointer-events-none">
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

      {/* ── Listening ring animation — centered around the orb ── */}
      {isListening && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 pointer-events-none">
          <div className="voice-ping w-24 h-24 rounded-full border-2 border-green-400/60" />
        </div>
      )}

    </>
  )
}
