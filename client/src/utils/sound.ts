// Plays the bundled startup chime (`/start.mp3`).
//
// Implementation notes:
//   We deliberately AVOID a single cached <audio> element here. On Chromium
//   builds shipped with the Raspberry Pi kiosk image, reusing one HTMLAudio
//   element after it has finished often fails silently on the second `play()`
//   (the promise resolves but no audio comes out). Decoding the file once
//   into an AudioBuffer and starting a fresh AudioBufferSourceNode for every
//   play sidesteps that entirely — buffer sources are one-shot and cannot
//   get into a stuck state.

const SOUND_URL = '/start.mp3'

let ctx: AudioContext | null = null
let bufferPromise: Promise<AudioBuffer> | null = null

function getCtx(): AudioContext {
  if (ctx && ctx.state !== 'closed') return ctx
  const Ctor = window.AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  ctx = new Ctor()
  return ctx
}

async function loadBuffer(): Promise<AudioBuffer> {
  if (bufferPromise) return bufferPromise
  bufferPromise = (async () => {
    const res = await fetch(SOUND_URL, { cache: 'force-cache' })
    if (!res.ok) throw new Error(`Failed to fetch ${SOUND_URL}: ${res.status}`)
    const arrayBuf = await res.arrayBuffer()
    // decodeAudioData on older Chromium needs the callback form — wrap to be safe.
    return new Promise<AudioBuffer>((resolve, reject) => {
      try {
        const p = getCtx().decodeAudioData(arrayBuf, resolve, reject)
        // Modern browsers return a Promise too — chain it as a fallback.
        if (p && typeof (p as Promise<AudioBuffer>).then === 'function') {
          (p as Promise<AudioBuffer>).then(resolve, reject)
        }
      } catch (err) {
        reject(err as Error)
      }
    })
  })()
  // If decoding fails, clear the cache so a future call can retry.
  bufferPromise.catch(() => { bufferPromise = null })
  return bufferPromise
}

export async function playStartupSound(): Promise<void> {
  try {
    const c = getCtx()
    // Browsers suspend the context until a user gesture — resume inside one.
    if (c.state === 'suspended') {
      try { await c.resume() } catch { /* ignore */ }
    }
    const buffer = await loadBuffer()
    const src    = c.createBufferSource()
    src.buffer   = buffer
    src.connect(c.destination)
    src.start(0)
  } catch (err) {
    // Surface the failure in dev tools so we can debug Pi-only issues.
    console.warn('[sound] playStartupSound failed:', err)
  }
}
