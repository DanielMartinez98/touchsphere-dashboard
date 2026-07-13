import { Router } from 'express'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { getSelectedProfile, ASSISTANT_PROFILES, type AssistantId } from '../config/assistant'

// GET /api/tts?text=hello[&voice=...]
//
// Synthesises speech and streams audio back to the client. Two providers:
//
//   1. "elevenlabs" — high-quality neural TTS via ElevenLabs HTTP API.
//      Requires ELEVENLABS_API_KEY (and optionally ELEVENLABS_VOICE_ID,
//      ELEVENLABS_MODEL_ID). Returns audio/mpeg.
//
//   2. "espeak"     — local, offline, robotic. Always available in the image.
//      Returns audio/wav.
//
// Selection is driven by env:
//   TTS_PROVIDER=elevenlabs|espeak   (default: elevenlabs if API key present,
//                                     else espeak)
//
// We do TTS server-side because TouchKio is built on Electron, which does
// NOT implement the Web Speech API (`speechSynthesis.speak()` is a silent
// no-op there). The client decodes the response with WebAudio so it routes
// correctly to the active sink (e.g. Bluetooth A2DP).
//
// Implementation note for espeak: we write to a temp file rather than
// `-w /dev/stdout` because espeak-ng's WAV writer needs a seekable output
// to patch the RIFF header at the end; piping gives 0-byte output.
const router = Router()

const MAX_TEXT_LEN = 500            // hard cap to keep synth time + cost bounded
const SYNTH_TIMEOUT_MS = 15_000     // kill runaway processes / slow API calls

// ── Config ───────────────────────────────────────────────────────────────────
const EL_KEY      = process.env['ELEVENLABS_API_KEY'] ?? ''
// A global voice override. When set it wins for every assistant profile;
// when unset, each assistant uses the voice from its profile (config/assistant.ts).
const EL_VOICE_ENV = process.env['ELEVENLABS_VOICE_ID']?.trim() || ''
// "eleven_turbo_v2_5" is fast + cheap. Use "eleven_multilingual_v2" for max quality.
const EL_MODEL_ID = process.env['ELEVENLABS_MODEL_ID'] ?? 'eleven_turbo_v2_5'

// ── RVC (local voice conversion) ─────────────────────────────────────────────
// For character voices no TTS service offers — Miku. RVC does NOT synthesise
// speech; it re-timbres existing speech. So her voice is a two-step LOCAL
// pipeline: Kokoro speaks the words, then RVC converts that audio into Miku.
// Free, offline, no API key, no per-word billing.
const RVC_URL = (process.env['RVC_URL'] ?? '').replace(/\/$/, '')
// Conversion is much slower than plain synthesis (it's a second model pass over
// the audio, on CPU), so it gets its own, longer budget.
const RVC_TIMEOUT_MS = Number(process.env['RVC_TIMEOUT_MS'] ?? 45_000)

// ── RVC conversion parameters ────────────────────────────────────────────────
// These two matter more than anything else, and rvc-python's defaults are wrong
// for us on both counts:
//
//   f0method — the pitch-extraction algorithm. The default, "harvest", is
//     famously slow: it was costing ~8s per reply on this CPU. "rmvpe" is both
//     faster AND more accurate, and is what the RVC community defaults to.
//
//   f0up_key — transpose, in semitones. The default of 0 keeps the SOURCE
//     voice's pitch and swaps only the timbre. Kokoro speaks in an adult
//     woman's register; a character like Miku sits far higher. With no
//     transposition you get "adult woman with a Miku-ish tone" — recognisably
//     not her. This is the single biggest lever on whether she sounds right.
const RVC_F0_METHOD = process.env['RVC_F0_METHOD'] ?? 'rmvpe'
// Fallback only. The live value is the one the user dialled in on the Settings
// slider, persisted by routes/state.ts — see savedPitch() below.
const RVC_F0_UP_KEY = Number(process.env['RVC_F0_UP_KEY'] ?? 4)

/**
 * The transpose the user has saved for this assistant, if any.
 *
 * Read from disk per request rather than cached: it's a tiny file, and the whole
 * point of the slider is that a change takes effect on the *next reply* — caching
 * it would mean restarting the container to hear your own adjustment, which
 * defeats the purpose.
 */
function savedPitch(assistantId: string): number | null {
  try {
    const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
    const raw = fs.readFileSync(path.join(dir, 'voice-pitch.json'), 'utf8')
    const all = JSON.parse(raw) as Record<string, number>
    const v = all[assistantId]
    return Number.isFinite(v) ? v! : null
  } catch {
    return null   // never saved, or unreadable — fall back to the env default
  }
}
// How strongly to pull toward the model's own timbre (the .index file). Higher
// is more "them", but too high smears consonants.
const RVC_INDEX_RATE = Number(process.env['RVC_INDEX_RATE'] ?? 0.66)
// How much of the source's loudness envelope to keep. Low = more of the target
// character's own dynamics.
const RVC_RMS_MIX_RATE = Number(process.env['RVC_RMS_MIX_RATE'] ?? 0.25)
// Protects breathy/unvoiced consonants from being over-converted into artefacts.
const RVC_PROTECT = Number(process.env['RVC_PROTECT'] ?? 0.33)

// ── Kokoro (local neural TTS) ────────────────────────────────────────────────
// Runs as a container next to us (Kokoro-FastAPI), so there's no API key, no
// credit balance to run dry, and it keeps working with the internet down. It's
// the preferred provider whenever it's configured — the cloud ones are only
// there for voices Kokoro can't do (Miku) or when it isn't deployed.
// It speaks the OpenAI /v1/audio/speech dialect.
const KOKORO_URL = (process.env['KOKORO_URL'] ?? '').replace(/\/$/, '')

type Provider = 'rvc' | 'kokoro' | 'elevenlabs' | 'espeak'

// An explicit TTS_PROVIDER pins every assistant to one backend. Otherwise we
// build an ordered CHAIN per assistant and try each in turn, because any single
// provider can fail for boring reasons — a cold RVC container, a dead network,
// an ElevenLabs 429. Falling through means a failure costs the assistant its
// *preferred voice*, not its ability to answer at all. espeak is the floor: it's
// local, always installed, and cannot fail for network reasons.
//
// ORDER MATTERS, and it's a taste call, not a technical one:
//   • Miku goes through the local kokoro→rvc pipeline. It's the only way to get
//     her actual character voice, and it's free and offline.
//   • Everyone else prefers ElevenLabs. Kokoro is local and free, but its stock
//     voices don't match these characters, and the voice IS the character here.
//   • Kokoro therefore sits BEHIND ElevenLabs as the fallback: it's what keeps
//     the dashboard talking when the network or the API key is unavailable,
//     which is a far better floor than espeak's robot.
const FORCED = process.env['TTS_PROVIDER']?.trim().toLowerCase()

function providerChain(profile: { rvcModel?: string }): Provider[] {
  if (FORCED === 'elevenlabs' || FORCED === 'espeak' || FORCED === 'kokoro' || FORCED === 'rvc') {
    return [FORCED, 'espeak']
  }
  const chain: Provider[] = []
  // RVC needs Kokoro to produce the source audio, so it's only viable with both.
  if (profile.rvcModel && RVC_URL && KOKORO_URL) chain.push('rvc')
  if (EL_KEY) chain.push('elevenlabs')
  if (KOKORO_URL) chain.push('kokoro')
  chain.push('espeak')
  return chain
}

console.log(
  `[tts] forced=${FORCED ?? 'no (per-assistant chain)'} kokoro=${KOKORO_URL || 'no'} ` +
  `rvc=${RVC_URL || 'no'} elevenlabs=${EL_KEY ? 'yes' : 'no'}`,
)

// ── Stage directions vs. spelled-out sounds ──────────────────────────────────
// The assistant is meant to PERFORM its noises, not narrate them. Two very
// different things arrive wrapped in asterisks and they need opposite handling:
//
//   *hiccup*   → a DESCRIPTION of an action. The voice would say the word
//                "hiccup", which is not a hiccup. Drop it entirely.
//   *eehuuup*  → the SOUND itself, spelled phonetically. The voice pronouncing
//                this actually sounds like a hiccup. Keep it — just unwrap the
//                asterisks so they aren't read out as punctuation.
//
// The tell is simply whether the span names an action. A short list of action
// verbs covers what models actually emit; anything else inside asterisks is
// treated as onomatopoeia and spoken.
const ACTION_WORDS = [
  'hiccup', 'hiccups', 'hiccough', 'sigh', 'sighs', 'sighing', 'laugh', 'laughs', 'laughing',
  'chuckle', 'chuckles', 'giggle', 'giggles', 'snort', 'snorts', 'burp', 'burps', 'belch', 'belches',
  'cough', 'coughs', 'clears', 'clearing', 'throat', 'groan', 'groans', 'grumble', 'grumbles',
  'mutter', 'mutters', 'mumbles', 'yawn', 'yawns', 'sniff', 'sniffs', 'slurp', 'slurps',
  'sips', 'sipping', 'gulps', 'rolls', 'eyes', 'shrugs', 'grins', 'smirks', 'winks', 'nods',
  'pauses', 'pause', 'beat', 'exhales', 'inhales', 'breathes', 'whispers', 'shouts', 'sarcastically',
  'wheezes', 'wheeze', 'stumbles', 'slurs', 'slurred', 'hums', 'taps', 'sniffles',
]
const ACTION_RE = new RegExp(`\\b(?:${ACTION_WORDS.join('|')})\\b`, 'i')

/** True when a bracketed span narrates an action rather than spelling a sound. */
function isStageDirection(inner: string): boolean {
  return ACTION_RE.test(inner)
}

export function stripStageDirections(input: string): string {
  const handle = (_m: string, inner: string) =>
    isStageDirection(inner) ? ' ' : ` ${inner.trim()} `

  return input
    .replace(/\*+([^*]*)\*+/g, handle)        // *hiccup* → gone;  *eehuuup* → spoken
    .replace(/_([^_\n]{1,40})_/g, handle)     // _mutters_ / _uuuugh_
    .replace(/\*/g, '')                       // stray unmatched asterisk
    // Parentheticals: same rule, but only for short verb-ish asides. A longer
    // aside — "(higher tonight)" — is a real remark and is left alone.
    .replace(/\(([a-z]+(?:\s+[a-z]+){0,2})\)/gi, (m, inner: string) =>
      isStageDirection(inner) ? ' ' : m)
    .replace(/\s+([,.!?;:])/g, '$1')          // tidy the space a removed span left behind
    .replace(/\s{2,}/g, ' ')
    .trim()
}

router.get('/', async (req, res) => {
  const raw = String(req.query['text'] ?? '').trim()
  const text = stripStageDirections(raw)
  if (text !== raw) {
    console.log(`[tts] stripped stage directions: "${raw.slice(0, 80)}" → "${text.slice(0, 80)}"`)
  }
  const voiceParam = String(req.query['voice'] ?? '')
  // ?as=<assistantId> voices a SPECIFIC profile (used by the Settings preview),
  // independent of whichever assistant is currently selected. Falls back to the
  // selected profile when absent/unknown.
  const asParam = String(req.query['as'] ?? '')
  const profile = asParam && asParam in ASSISTANT_PROFILES
    ? ASSISTANT_PROFILES[asParam as AssistantId]
    : getSelectedProfile()

  if (!text) {
    // Either nothing was sent, or the whole reply was stage directions — in which
    // case there is genuinely nothing to say, and silence beats narrating actions.
    return res.status(400).json({ error: raw ? 'no speakable text' : 'missing text' })
  }
  if (text.length > MAX_TEXT_LEN) {
    return res.status(413).json({ error: `text too long (max ${MAX_TEXT_LEN})` })
  }

  // Try each provider in turn. Once one starts streaming (headersSent) we're
  // committed — we can't retry a half-written response, so a mid-stream failure
  // just ends the response. Only a clean pre-stream failure falls through.
  const chain = providerChain(profile)
  const failures: string[] = []

  for (const provider of chain) {
    try {
      switch (provider) {
        case 'rvc': {
          const model = voiceParam && /^[a-zA-Z0-9_-]+$/.test(voiceParam)
            ? voiceParam
            : profile.rvcModel
          if (!model) throw new Error(`assistant "${profile.id}" has no rvcModel`)
          // Transpose precedence: an explicit ?pitch= (used by the Settings
          // slider's live preview) → the value the user saved for this assistant
          // → the env default. ±24 is two octaves; beyond that is a typo.
          const pitchRaw = Number(req.query['pitch'])
          const pitch = Number.isFinite(pitchRaw)
            ? Math.max(-24, Math.min(24, Math.round(pitchRaw)))
            : (savedPitch(profile.id) ?? RVC_F0_UP_KEY)
          await synthesizeKokoroRVC(text, profile.kokoroVoice, model, res, pitch)
          break
        }
        case 'kokoro': {
          // Kokoro voice names are lowercase letters + underscore (e.g. af_sky).
          const voice = voiceParam && /^[a-z_]+$/.test(voiceParam)
            ? voiceParam
            : profile.kokoroVoice
          await synthesizeKokoro(text, voice, res)
          break
        }
        case 'elevenlabs': {
          // Voice precedence: explicit ?voice= override → global env override →
          // the selected assistant's profile voice. All whitelisted to alphanumerics
          // (ElevenLabs voice IDs are ~20-char base62 strings).
          const voiceId =
            voiceParam && /^[a-zA-Z0-9]+$/.test(voiceParam) ? voiceParam
            : EL_VOICE_ENV && /^[a-zA-Z0-9]+$/.test(EL_VOICE_ENV) ? EL_VOICE_ENV
            : profile.elevenVoiceId
          await synthesizeElevenLabs(text, voiceId, res)
          break
        }
        case 'espeak': {
          const lang = voiceParam && /^[a-z]{2}(-[a-z0-9]+)?$/i.test(voiceParam)
            ? voiceParam
            : (profile.espeakVoice || 'en-us')
          await synthesizeEspeak(text, lang, res)
          break
        }
      }
      return  // synthesised + streamed successfully
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failures.push(`${provider}: ${msg}`)
      console.warn(`[tts] ${provider} failed — ${msg}`)
      if (res.headersSent) {
        // Already streaming; can't start over with a different provider.
        return res.end()
      }
      // else: fall through and try the next provider in the chain
    }
  }

  console.error('[tts] every provider failed:', failures.join(' | '))
  if (!res.headersSent) {
    res.status(502).json({ error: 'tts failed', detail: failures.join(' | ') })
  }
})

// ── ElevenLabs ───────────────────────────────────────────────────────────────
async function synthesizeElevenLabs(text: string, voiceId: string, res: import('express').Response) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SYNTH_TIMEOUT_MS)

  console.log(`[tts][elevenlabs] POST voice=${voiceId} model=${EL_MODEL_ID} chars=${text.length}`)
  const apiRes = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key':   EL_KEY,
      'Content-Type': 'application/json',
      'Accept':       'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: EL_MODEL_ID,
      voice_settings: {
        stability:        0.5,
        similarity_boost: 0.75,
      },
    }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer))

  if (!apiRes.ok) {
    const body = await apiRes.text().catch(() => '')
    throw new Error(`elevenlabs ${apiRes.status}: ${body.slice(0, 300)}`)
  }
  if (!apiRes.body) {
    throw new Error('elevenlabs returned empty body')
  }

  res.setHeader('Content-Type', 'audio/mpeg')
  res.setHeader('Cache-Control', 'no-store')
  const lenHeader = apiRes.headers.get('content-length')
  if (lenHeader) res.setHeader('Content-Length', lenHeader)

  const reader = apiRes.body.getReader()
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (!res.write(Buffer.from(value))) {
      await new Promise<void>(r => res.once('drain', r))
    }
  }
  res.end()
  console.log(`[tts][elevenlabs] OK ${total} bytes`)
}

// ── Kokoro (local) ───────────────────────────────────────────────────────────
// Kokoro-FastAPI implements OpenAI's /v1/audio/speech, so this is the same
// request shape you'd send to OpenAI — just pointed at the container next door.
// No key: it's on our own network, and reaching the internet isn't required.
async function kokoroSynth(text: string, voice: string, format: 'mp3' | 'wav'): Promise<Buffer> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SYNTH_TIMEOUT_MS)

  console.log(`[tts][kokoro] POST voice=${voice} format=${format} chars=${text.length}`)
  const apiRes = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kokoro',
      input: text,
      voice,
      response_format: format,
    }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer))

  if (!apiRes.ok) {
    const body = await apiRes.text().catch(() => '')
    throw new Error(`kokoro ${apiRes.status}: ${body.slice(0, 300)}`)
  }
  const buf = Buffer.from(await apiRes.arrayBuffer())
  if (buf.length === 0) throw new Error('kokoro returned empty audio')
  console.log(`[tts][kokoro] OK ${buf.length} bytes`)
  return buf
}

async function synthesizeKokoro(text: string, voice: string, res: import('express').Response) {
  const audio = await kokoroSynth(text, voice, 'mp3')
  res.setHeader('Content-Type', 'audio/mpeg')
  res.setHeader('Content-Length', audio.length)
  res.setHeader('Cache-Control', 'no-store')
  res.end(audio)
}

// ── Kokoro → RVC (Miku's local voice) ────────────────────────────────────────
// RVC re-timbres speech; it can't create it. So we synthesise the words with
// Kokoro first (as WAV — RVC wants raw audio, not a lossy MP3), then push that
// through the conversion model to come out sounding like the character.
//
// Both hops are local containers, so this costs nothing and works offline. It IS
// slower than plain TTS, though: it's a second neural pass over the whole clip,
// on CPU. Hence the longer timeout.
//
// Nothing is written to `res` until the conversion has succeeded, so a failure
// here falls cleanly through to the next provider in the chain.
let rvcLoadedModel: string | null = null
// The params currently set on the RVC server. Re-sent only when they change, so
// a ?pitch= override costs one extra call rather than one per reply.
let rvcAppliedPitch: number | null = null

async function synthesizeKokoroRVC(
  text: string,
  kokoroVoice: string,
  model: string,
  res: import('express').Response,
  pitch: number = RVC_F0_UP_KEY,
) {
  const t0 = Date.now()
  const wav = await kokoroSynth(text, kokoroVoice, 'wav')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), RVC_TIMEOUT_MS)

  try {
    // The RVC server holds one model in memory at a time; only reload on change.
    if (rvcLoadedModel !== model) {
      console.log(`[tts][rvc] loading model "${model}"`)
      const loadRes = await fetch(`${RVC_URL}/models/${encodeURIComponent(model)}`, {
        method: 'POST',
        signal: ctrl.signal,
      })
      if (!loadRes.ok) {
        const body = await loadRes.text().catch(() => '')
        throw new Error(`rvc load ${loadRes.status}: ${body.slice(0, 200)} (is the model in the rvc-models volume?)`)
      }
      rvcLoadedModel = model
      rvcAppliedPitch = null   // a fresh model means fresh (default) params
    }

    // Set conversion params whenever they change. Without this the server keeps
    // its defaults — harvest (slow) and no transposition (wrong pitch), which is
    // the difference between "sounds like her" and "doesn't".
    if (rvcAppliedPitch !== pitch) {
      const params = {
        f0method:      RVC_F0_METHOD,
        f0up_key:      pitch,
        index_rate:    RVC_INDEX_RATE,
        rms_mix_rate:  RVC_RMS_MIX_RATE,
        protect:       RVC_PROTECT,
        filter_radius: 3,
        resample_sr:   0,
      }
      const paramRes = await fetch(`${RVC_URL}/params`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params }),
        signal: ctrl.signal,
      })
      if (!paramRes.ok) {
        // Non-fatal: the model still converts, just with the slow defaults.
        console.warn(`[tts][rvc] could not set params (${paramRes.status}) — using server defaults`)
      } else {
        console.log(`[tts][rvc] params: f0=${RVC_F0_METHOD} transpose=${pitch}st index=${RVC_INDEX_RATE}`)
        rvcAppliedPitch = pitch
      }
    }

    console.log(`[tts][rvc] converting ${wav.length} bytes with "${model}"`)
    const convRes = await fetch(`${RVC_URL}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_data: wav.toString('base64') }),
      signal: ctrl.signal,
    })

    if (!convRes.ok) {
      const body = await convRes.text().catch(() => '')
      throw new Error(`rvc convert ${convRes.status}: ${body.slice(0, 200)}`)
    }

    const out = Buffer.from(await convRes.arrayBuffer())
    if (out.length === 0) throw new Error('rvc returned empty audio')

    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('Content-Length', out.length)
    res.setHeader('Cache-Control', 'no-store')
    res.end(out)
    console.log(`[tts][rvc] OK ${out.length} bytes in ${Date.now() - t0}ms`)
  } catch (err) {
    // A failed load leaves the server's state unknown — force a reload next time.
    rvcLoadedModel = null
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ── espeak-ng (offline fallback) ─────────────────────────────────────────────
function synthesizeEspeak(text: string, lang: string, res: import('express').Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `tts-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`)
    const args = [
      '-v', lang,
      '-s', '170',          // speed (words per minute)
      '-p', '55',           // pitch
      '-a', '180',          // amplitude (0-200)
      '-w', tmpFile,
      text,                 // text as final argv element — no shell, no injection
    ]
    console.log('[tts][espeak]', args.map(a => a === text ? `"${a}"` : a).join(' '))

    const child = spawn('espeak-ng', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const cleanup = () => { fs.promises.unlink(tmpFile).catch(() => {}) }
    const timer = setTimeout(() => { child.kill('SIGKILL') }, SYNTH_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer); cleanup()
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        cleanup()
        return reject(new Error(`espeak-ng exit=${code}: ${stderr.trim()}`))
      }
      fs.stat(tmpFile, (statErr, stat) => {
        if (statErr || stat.size === 0) {
          cleanup()
          return reject(new Error(`espeak-ng produced empty wav (stderr="${stderr.trim()}")`))
        }
        console.log(`[tts][espeak] OK ${stat.size} bytes`)
        res.setHeader('Content-Type', 'audio/wav')
        res.setHeader('Content-Length', stat.size)
        res.setHeader('Cache-Control', 'no-store')
        const stream = fs.createReadStream(tmpFile)
        stream.on('close', () => { cleanup(); resolve() })
        stream.on('error', (err) => { cleanup(); reject(err) })
        stream.pipe(res)
      })
    })
  })
}

export default router
