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

import { getEffectiveGain } from '../hooks/useVolume'

const STARTUP_SOUND_URL = '/start.mp3'

let ctx: AudioContext | null = null
const bufferPromises = new Map<string, Promise<AudioBuffer>>()

function getCtx(): AudioContext {
  if (ctx && ctx.state !== 'closed') return ctx
  const Ctor = window.AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  ctx = new Ctor()
  return ctx
}

async function loadBuffer(url: string): Promise<AudioBuffer> {
  const cached = bufferPromises.get(url)
  if (cached) return cached
  const promise = (async () => {
    const res = await fetch(url, { cache: 'force-cache' })
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
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
  promise.catch(() => { bufferPromises.delete(url) })
  bufferPromises.set(url, promise)
  return promise
}

export async function playSound(url: string, category: 'sfx' | 'music' | 'voice' = 'sfx'): Promise<void> {
  try {
    const c = getCtx()
    // Browsers suspend the context until a user gesture — resume inside one.
    if (c.state === 'suspended') {
      try { await c.resume() } catch { /* ignore */ }
    }
    const buffer = await loadBuffer(url)
    const src    = c.createBufferSource()
    src.buffer   = buffer
    // Per-category gain (master * category, both 0..1). A fresh GainNode each
    // play means changing the slider during playback won't retroactively
    // affect already-started sounds, which is the expected UX.
    const gain = c.createGain()
    gain.gain.value = getEffectiveGain(category)
    src.connect(gain)
    gain.connect(c.destination)
    src.start(0)
  } catch (err) {
    // Surface the failure in dev tools so we can debug Pi-only issues.
    console.warn('[sound] playSound failed:', url, err)
  }
}

export function playStartupSound(): Promise<void> {
  return playSound(STARTUP_SOUND_URL, 'sfx')
}

// ── Synth chimes for the recorder ────────────────────────────────────────────
// Plays a short two-tone beep (no asset file needed). `direction='up'` is the
// "start recording" cue, `direction='down'` is the "stop recording" cue. Routed
// through the sfx category so it follows the user's volume sliders.
export async function playRecordChime(direction: 'up' | 'down' = 'up'): Promise<void> {
  try {
    const c = getCtx()
    if (c.state === 'suspended') {
      try { await c.resume() } catch { /* ignore */ }
    }
    const now    = c.currentTime
    const tones  = direction === 'up' ? [660, 990] : [990, 660]
    const tDur   = 0.09           // each tone length (s)
    const gap    = 0.02           // gap between tones (s)
    const peak   = 0.25 * getEffectiveGain('sfx')

    tones.forEach((freq, i) => {
      const start = now + i * (tDur + gap)
      const end   = start + tDur
      const osc   = c.createOscillator()
      const gain  = c.createGain()
      osc.type         = 'sine'
      osc.frequency.value = freq
      // Quick attack/decay envelope so the beep doesn't click on edges.
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(peak, start + 0.01)
      gain.gain.linearRampToValueAtTime(0,    end)
      osc.connect(gain)
      gain.connect(c.destination)
      osc.start(start)
      osc.stop(end + 0.02)
    })
  } catch (err) {
    console.warn('[sound] playRecordChime failed:', err)
  }
}
