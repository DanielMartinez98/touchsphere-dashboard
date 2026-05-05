// Generates a short ambient startup chime using the Web Audio API —
// no asset file needed. A C-major arpeggio (C5 E5 G5 C6) with a soft
// sub-bass swell, gentle attack/decay envelopes for a "system on" feel.

let cachedCtx: AudioContext | null = null

function getCtx(): AudioContext {
  if (cachedCtx && cachedCtx.state !== 'closed') return cachedCtx
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  cachedCtx = new Ctor()
  return cachedCtx
}

export async function playStartupSound(): Promise<void> {
  const ctx = getCtx()
  // Resume if the browser suspended it (autoplay policy — safe inside a user gesture).
  if (ctx.state === 'suspended') {
    try { await ctx.resume() } catch { /* ignore */ }
  }

  const now = ctx.currentTime
  const master = ctx.createGain()
  master.gain.value = 0.22
  master.connect(ctx.destination)

  // Bright arpeggio — sine waves layered with a touch of triangle for warmth.
  const notes = [523.25, 659.25, 783.99, 1046.50] // C5, E5, G5, C6
  notes.forEach((freq, i) => {
    const start = now + i * 0.11
    const stop  = start + 1.0

    const sine = ctx.createOscillator()
    sine.type = 'sine'
    sine.frequency.value = freq

    const tri = ctx.createOscillator()
    tri.type = 'triangle'
    tri.frequency.value = freq * 2 // shimmer harmonic

    const g = ctx.createGain()
    g.gain.setValueAtTime(0, start)
    g.gain.linearRampToValueAtTime(1.0, start + 0.02)
    g.gain.exponentialRampToValueAtTime(0.001, stop)

    const triGain = ctx.createGain()
    triGain.gain.value = 0.18

    sine.connect(g)
    tri.connect(triGain).connect(g)
    g.connect(master)

    sine.start(start); sine.stop(stop)
    tri.start(start);  tri.stop(stop)
  })

  // Sub-bass swell underneath.
  const sub = ctx.createOscillator()
  const subGain = ctx.createGain()
  sub.type = 'sine'
  sub.frequency.value = 130.81 // C3
  subGain.gain.setValueAtTime(0, now)
  subGain.gain.linearRampToValueAtTime(0.5, now + 0.08)
  subGain.gain.exponentialRampToValueAtTime(0.001, now + 1.4)
  sub.connect(subGain).connect(master)
  sub.start(now)
  sub.stop(now + 1.45)
}
