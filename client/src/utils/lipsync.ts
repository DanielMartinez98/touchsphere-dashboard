// Lip-sync tap for the VRM avatar.
//
// Reads the amplitude of the assistant's TTS reply so the avatar's mouth can
// open in time with it. The reply is an HTMLAudioElement (see useVoice's
// speakText), which we route through a WebAudio AnalyserNode.
//
// ── The speaker-routing hazard ───────────────────────────────────────────────
// The moment an element is passed to createMediaElementSource(), its audio no
// longer leaves via the element — it leaves via the AudioContext. That means
// HTMLAudioElement.setSinkId() stops selecting the speaker, and the context's
// own sink takes over. useVoice relies on element.setSinkId() to honour the
// output device picked in Settings → Hardware, so tapping the audio naively
// would silently send the reply to the wrong speaker.
//
// So: we only tap when we can guarantee routing still works — either the user
// is on the default output (nothing to route), or AudioContext.setSinkId is
// available (Chromium 110+) and we move the routing there. If neither holds,
// attach() returns false and the caller keeps the untapped path: correct audio
// output beats a moving mouth.

type ContextWithSink = AudioContext & { setSinkId?: (id: string) => Promise<void> }

let ctx: ContextWithSink | null = null
let analyser: AnalyserNode | null = null
// Explicitly ArrayBuffer-backed: a bare `Float32Array` annotation widens to
// ArrayBufferLike, which getFloatTimeDomainData won't accept.
let buf: Float32Array<ArrayBuffer> | null = null
let smoothed = 0

/** Envelope tuning — attack fast enough to catch consonants, release slow
 *  enough that the jaw doesn't chatter between syllables. */
const ATTACK = 0.5
const RELEASE = 0.15
/** Speech RMS is small; scale it into a usable 0..1 mouth-open range. */
const GAIN = 6

/**
 * Route `audio` through an analyser so getMouthLevel() tracks it.
 *
 * @param outputDeviceId the sink the caller wants ('default' = OS default)
 * @returns true if the tap was attached AND routing is handled here (caller must
 *          NOT call element.setSinkId); false if the caller should proceed with
 *          its normal untapped playback path.
 */
export async function attachLipSync(audio: HTMLAudioElement, outputDeviceId: string): Promise<boolean> {
  const wantsSpecificSink = Boolean(outputDeviceId) && outputDeviceId !== 'default'

  try {
    if (!ctx) {
      const Ctor = window.AudioContext
        || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      ctx = new Ctor() as ContextWithSink
    }

    // A specific speaker was chosen but this engine can't move an AudioContext
    // to it — refuse the tap so element.setSinkId stays in charge.
    if (wantsSpecificSink && typeof ctx.setSinkId !== 'function') {
      console.warn('[lipsync] AudioContext.setSinkId unavailable — skipping tap to preserve speaker routing')
      return false
    }

    if (ctx.state === 'suspended') await ctx.resume()

    if (!analyser) {
      analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.2
      analyser.connect(ctx.destination)
      buf = new Float32Array(analyser.fftSize)
    }

    // Follow the user's speaker choice on the context instead of the element.
    if (typeof ctx.setSinkId === 'function') {
      try {
        await ctx.setSinkId(wantsSpecificSink ? outputDeviceId : '')
      } catch (err) {
        console.warn('[lipsync] AudioContext.setSinkId failed:', err)
        // Couldn't honour an explicit device choice — don't tap.
        if (wantsSpecificSink) return false
      }
    }

    // An element can only be adopted by one MediaElementSource ever; speakText
    // builds a fresh Audio() per utterance, so this is always a new element.
    ctx.createMediaElementSource(audio).connect(analyser)
    return true
  } catch (err) {
    console.warn('[lipsync] tap failed, falling back to untapped playback:', err)
    return false
  }
}

/**
 * Current mouth openness, 0..1. Called once per animation frame by the avatar.
 * Returns 0 when nothing is playing (the analyser just reads silence).
 */
export function getMouthLevel(): number {
  if (!analyser || !buf) return 0
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
  const rms = Math.sqrt(sum / buf.length)
  const target = Math.min(1, rms * GAIN)
  // Asymmetric envelope: snap open, ease closed.
  const k = target > smoothed ? ATTACK : RELEASE
  smoothed += (target - smoothed) * k
  return smoothed
}

/** Drop the mouth to closed immediately (playback interrupted / turn ended). */
export function resetLipSync() {
  smoothed = 0
}
