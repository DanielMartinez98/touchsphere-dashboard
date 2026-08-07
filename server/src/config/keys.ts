// Credential shape checks.
//
// "Is the variable set?" is a weaker question than it looks. A key that is
// present but malformed reads as configured everywhere — the startup banner,
// the Debug tab — while every request using it fails upstream. That gap cost a
// full debugging session once already, so the rule lives in one place and both
// readouts share it.

/** ElevenLabs keys are `sk_…`. Anything else is a paste of the wrong value. */
export function elevenLabsKeyState(raw = process.env['ELEVENLABS_API_KEY']): 'missing' | 'malformed' | 'ok' {
  const key = (raw ?? '').trim()
  if (!key) return 'missing'
  return key.startsWith('sk_') ? 'ok' : 'malformed'
}
