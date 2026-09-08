import { Router } from 'express'
import multer from 'multer'

// POST /api/stt   ── multipart/form-data, field "audio"
//
// Transcribes the uploaded clip and returns { text, language_code, provider }.
// The client records via MediaRecorder (webm/opus), runs silence-detection
// (auto-stop on ~1.5s of silence), and POSTs the resulting blob here.
//
// Two providers behind one interface, chained the way /api/tts chains its
// voices, because speech-to-text used to be the ONE piece of the voice loop
// with no local option at all: ElevenLabs Scribe or nothing, and "nothing"
// looked exactly like the assistant ignoring you.
//
//   1. "whisper"    — LOCAL. Any server that speaks OpenAI's
//                     POST /v1/audio/transcriptions dialect: speaches (the
//                     `whisper` service in docker-compose.yml — faster-whisper
//                     behind an OpenAI-shaped API), faster-whisper-server,
//                     LocalAI, vLLM, or whisper.cpp's own server (path
//                     /inference, started with --convert so it accepts the
//                     browser's webm/opus). No key, no quota, works offline.
//                     Configured by WHISPER_URL.
//   2. "elevenlabs" — ElevenLabs Scribe. Configured by ELEVENLABS_API_KEY.
//
// Order: local first, cloud as the fallback — a cold or missing Whisper box
// costs a round trip, never the utterance. STT_PROVIDER=whisper|elevenlabs
// pins one (mainly to prove which is answering). X-STT-Provider on the
// response names the engine that actually produced the text, for the same
// reason X-TTS-Provider exists: a 200 from a chain proves nothing about
// which link answered.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB ≈ ~50 min opus
  fileFilter: (_req, file, cb) => cb(null, /^audio\//.test(file.mimetype)),
})

const router = Router()

// ── Config ───────────────────────────────────────────────────────────────────
const WHISPER_URL   = (process.env['WHISPER_URL'] ?? '').replace(/\/+$/, '')
// The `model` field of the request. speaches and faster-whisper-server take a
// Hugging Face repo id and download it on first use; whisper.cpp ignores the
// field (its model is a command-line flag); LocalAI wants its configured name.
const WHISPER_MODEL = process.env['WHISPER_MODEL'] ?? 'Systran/faster-whisper-small'
// OpenAI's path by default; whisper.cpp's server listens on /inference instead.
const WHISPER_PATH  = process.env['WHISPER_PATH'] ?? '/v1/audio/transcriptions'
// Longer than ElevenLabs' budget on purpose: a local model on CPU is a second
// or two per clip once warm, but the FIRST request after a container start
// loads the weights (and, on speaches, downloads them the very first time).
// The warm-up below spends that at boot so a real utterance rarely pays it.
const WHISPER_TIMEOUT_MS = Number(process.env['WHISPER_TIMEOUT_MS'] ?? 60_000)

const EL_KEY = process.env['ELEVENLABS_API_KEY'] ?? ''
// Where ElevenLabs is. Overridable so the chain can be proved against a mock
// (server/scripts/local-ai-test.ts) and so a proxy can sit in front of it.
const EL_API = (process.env['ELEVENLABS_API_URL'] ?? 'https://api.elevenlabs.io').replace(/\/+$/, '')
const STT_MODEL = process.env['ELEVENLABS_STT_MODEL'] ?? 'scribe_v1'
const STT_TIMEOUT_MS = 30_000

export type SttProvider = 'whisper' | 'elevenlabs'

const FORCED = process.env['STT_PROVIDER']?.trim().toLowerCase()

/** The providers /api/stt will try, in order. Empty = voice input is off. */
export function sttProviders(): SttProvider[] {
  if (FORCED === 'whisper')    return WHISPER_URL ? ['whisper'] : []
  if (FORCED === 'elevenlabs') return EL_KEY ? ['elevenlabs'] : []
  const chain: SttProvider[] = []
  if (WHISPER_URL) chain.push('whisper')
  if (EL_KEY) chain.push('elevenlabs')
  return chain
}

/** One line for the startup log and the Debug tab: "whisper (local) → elevenlabs". */
export function sttSummary(): string {
  const chain = sttProviders()
  if (chain.length === 0) return 'none — set WHISPER_URL (local) or ELEVENLABS_API_KEY'
  return chain.map(p => p === 'whisper' ? `whisper (local, ${WHISPER_URL})` : 'elevenlabs (cloud)').join(' → ')
    + (FORCED ? ` (pinned by STT_PROVIDER=${FORCED})` : '')
}

/** Where the local transcriber is, for diagnostics. Empty when not configured. */
export function whisperUrl(): string { return WHISPER_URL }

if (FORCED && FORCED !== 'whisper' && FORCED !== 'elevenlabs') {
  console.warn(`[stt] unrecognised STT_PROVIDER="${FORCED}" — using the per-config chain`)
}
console.log(`[stt] providers: ${sttSummary()}`)

// ── Errors ───────────────────────────────────────────────────────────────────
/** An upstream that answered, but not with a transcript. Carries the status so
 *  the client can tell "rejected key" from "over quota" from "unreachable". */
class SttUpstreamError extends Error {
  readonly provider: SttProvider
  readonly status: number
  readonly detail: string
  constructor(provider: SttProvider, status: number, detail: string) {
    super(`${provider} ${status}: ${detail.slice(0, 300)}`)
    this.name = 'SttUpstreamError'
    this.provider = provider
    this.status = status
    this.detail = detail
  }
}

// ── Text clean-up shared by both providers ───────────────────────────────────
/** Strip bracketed audio-event tags that survived ("[music]", "(laughter)",
 *  "<noise>", whisper.cpp's "[BLANK_AUDIO]") and collapse whitespace. */
function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Whisper was trained on captioned video, and on a clip of near-silence it
// does not answer "nothing" — it answers with the sentence that most often
// follows silence in that corpus. These are the well-known ones, matched only
// as the WHOLE transcript: "thanks for watching" spoken mid-sentence is
// still a sentence, and a genuine "thank you" to the assistant is kept, since
// dropping it would silently change what she replies to.
const WHISPER_PHANTOMS = [
  /^thanks? for watching[.!]?$/i,
  /^(please )?(like[,]? )?(and )?subscribe[.!]?$/i,
  /^subtitles? by .+$/i,
  /^subtitles? (created|provided|made) by .+$/i,
  /^(the )?end[.!]?$/i,
  /^you[.!]?$/i,
  /^bye[.!]?$/i,
  /^\.+$/,
]

function isWhisperPhantom(text: string): boolean {
  const t = text.trim()
  return t.length === 0 || WHISPER_PHANTOMS.some(re => re.test(t))
}

// ── Whisper (local, OpenAI-compatible) ───────────────────────────────────────
interface Clip { buffer: Buffer; mimetype: string; name: string }

async function transcribeWhisper(clip: Clip, lang: string, timeoutMs = WHISPER_TIMEOUT_MS): Promise<{ text: string; language: string | null }> {
  const fd = new FormData()
  // Web FormData (Node 22) accepts Blob — wrap the buffer.
  const blob = new Blob([new Uint8Array(clip.buffer)], { type: clip.mimetype })
  fd.append('file', blob, clip.name)
  fd.append('model', WHISPER_MODEL)
  // `json` rather than `verbose_json`: every server above answers it, and the
  // client only reads `text`. Temperature 0 keeps a small model from inventing.
  fd.append('response_format', 'json')
  fd.append('temperature', '0')
  if (lang) fd.append('language', lang)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${WHISPER_URL}${WHISPER_PATH}`, { method: 'POST', body: fd, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
  const bodyText = await res.text()
  if (!res.ok) throw new SttUpstreamError('whisper', res.status, bodyText)

  // { text, language? } normally; a server set to plain-text answers with the
  // transcript itself, which is also fine.
  try {
    const parsed = JSON.parse(bodyText) as { text?: string; language?: string }
    return { text: (parsed.text ?? '').trim(), language: parsed.language ?? null }
  } catch {
    return { text: bodyText.trim(), language: null }
  }
}

// ── ElevenLabs Scribe ────────────────────────────────────────────────────────
async function transcribeElevenLabs(clip: Clip, lang: string): Promise<{ text: string; language: string | null }> {
  const fd = new FormData()
  const blob = new Blob([new Uint8Array(clip.buffer)], { type: clip.mimetype })
  fd.append('file', blob, clip.name)
  fd.append('model_id', STT_MODEL)
  // Ask Scribe to *tag* non-speech sounds (laughter, music, applause, etc.)
  // so we can strip them out below. Without this they sometimes leak in as
  // transcribed words ("uh", "hmm", random noise → bogus tokens).
  fd.append('tag_audio_events', 'true')
  // Disable speaker diarization — we have a single user, and the extra pass
  // occasionally inserts speaker tokens we'd then need to scrub.
  fd.append('diarize', 'false')
  if (lang) fd.append('language_code', lang)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), STT_TIMEOUT_MS)
  let apiRes: Response
  try {
    apiRes = await fetch(`${EL_API}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': EL_KEY },
      body: fd,
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  const bodyText = await apiRes.text()
  if (!apiRes.ok) throw new SttUpstreamError('elevenlabs', apiRes.status, bodyText)

  // Scribe returns:
  //   { text, language_code, words: [{ text, type, start, end, ... }] }
  // where `type` is "word" | "spacing" | "audio_event". `audio_event` items
  // are noise tags like "[laughter]" / "[music]" — we drop them entirely
  // and rebuild the text from real word + spacing tokens only.
  interface ScribeWord { text?: string; type?: string }
  interface ScribeResponse { text?: string; language_code?: string; words?: ScribeWord[] }
  let parsed: ScribeResponse = {}
  try { parsed = JSON.parse(bodyText) as ScribeResponse } catch { /* fall through */ }

  const text = Array.isArray(parsed.words) && parsed.words.length > 0
    ? parsed.words.filter(w => w.type === 'word' || w.type === 'spacing').map(w => w.text ?? '').join('').trim()
    : (parsed.text ?? '').trim()
  return { text, language: parsed.language_code ?? null }
}

// ── The route ────────────────────────────────────────────────────────────────
router.post('/', upload.single('audio'), async (req, res) => {
  const chain = sttProviders()
  if (chain.length === 0) {
    return res.status(500).json({
      error: 'no speech-to-text provider configured — set WHISPER_URL (local Whisper) or ELEVENLABS_API_KEY',
    })
  }
  if (!req.file) {
    return res.status(400).json({ error: 'no audio file' })
  }

  const lang = String(req.query['lang'] ?? '').trim()
  const langOk = lang && /^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(lang) ? lang : ''
  const clip: Clip = { buffer: req.file.buffer, mimetype: req.file.mimetype, name: req.file.originalname || 'clip.webm' }

  // Try each provider in turn. Nothing is written to `res` until one has
  // answered, so a failure always falls cleanly through to the next.
  const failures: string[] = []
  for (const provider of chain) {
    const t0 = Date.now()
    try {
      console.log(`[stt][${provider}] transcribing ${clip.buffer.length} bytes (${clip.mimetype})`)
      const out = provider === 'whisper'
        ? await transcribeWhisper(clip, langOk)
        : await transcribeElevenLabs(clip, langOk)
      let text = cleanTranscript(out.text)
      if (provider === 'whisper' && isWhisperPhantom(text)) {
        if (text) console.log(`[stt][whisper] dropped a silence hallucination: "${text}"`)
        text = ''
      }
      console.log(`[stt][${provider}] OK in ${Date.now() - t0}ms lang=${out.language ?? '?'} chars=${text.length} → "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`)
      res.setHeader('X-STT-Provider', provider)
      return res.json({ text, language_code: out.language, provider })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failures.push(`${provider}: ${msg}`)
      console.warn(`[stt] ${provider} failed after ${Date.now() - t0}ms — ${msg.slice(0, 300)}`)
    }
  }

  console.error('[stt] every provider failed:', failures.join(' | '))
  // The status of the LAST upstream answer, when there was one: the client
  // turns 401 and 429 into "check the key" and "out of quota" respectively,
  // and a transport failure into "couldn't reach".
  const last = failures[failures.length - 1] ?? ''
  const statusMatch = last.match(/\b(4\d\d|5\d\d)\b/)
  res.status(502).json({
    error: 'stt failed',
    status: statusMatch ? Number(statusMatch[1]) : undefined,
    detail: failures.join(' | ').slice(0, 500),
    tried: chain,
  })
})

// ── A clip of silence, for probing and warming the local transcriber ─────────
// One second of 16 kHz mono 16-bit PCM in a RIFF header: the smallest thing
// every Whisper server accepts without an audio decoder, and enough to make
// it load the model. 44 bytes of header, 32 000 of zeros.
function silentWav(seconds = 1): Buffer {
  const rate = 16_000
  const samples = rate * seconds
  const data = samples * 2
  const buf = Buffer.alloc(44 + data)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(data, 40)
  return buf
}

/** Send a second of silence through the local transcriber. Resolves with the
 *  round-trip time; rejects with the upstream's own words. */
export async function probeWhisper(timeoutMs: number): Promise<{ ms: number; text: string }> {
  if (!WHISPER_URL) throw new Error('WHISPER_URL not set')
  const t0 = Date.now()
  const out = await transcribeWhisper({ buffer: silentWav(), mimetype: 'audio/wav', name: 'silence.wav' }, '', timeoutMs)
  return { ms: Date.now() - t0, text: out.text }
}

// GET /api/stt/check — is the LOCAL transcriber actually transcribing?
//
// A real round trip rather than a version ping, because every server this
// supports has a different idle endpoint and none of them proves the model
// loads. The budget is generous for the same reason the timeout above is: a
// cold box spends its first call loading weights, and "took 20 s" is a more
// useful answer than "timed out at 10".
router.get('/check', async (_req, res) => {
  if (!WHISPER_URL) {
    return res.status(502).json({
      error: EL_KEY
        ? 'WHISPER_URL not set — voice input goes to ElevenLabs Scribe (cloud)'
        : 'WHISPER_URL not set and no ElevenLabs key — voice input is disabled',
    })
  }
  try {
    const { ms, text } = await probeWhisper(45_000)
    res.json({
      ok: true,
      url: WHISPER_URL,
      model: WHISPER_MODEL,
      ms,
      detail: `${WHISPER_MODEL} answered in ${(ms / 1000).toFixed(1)}s${text ? ` (heard "${text.slice(0, 40)}" in silence)` : ''}`,
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn('[stt] whisper check failed:', detail)
    res.status(502).json({ error: `${WHISPER_URL}: ${detail.slice(0, 300)}` })
  }
})

// ── Warm-up ──────────────────────────────────────────────────────────────────
// The first transcription after a container start loads the model inside the
// request — and on speaches the very first one ever downloads it, which is a
// minute or more for `small`. Nobody is talking at boot, so that is spent now
// rather than on someone's first question. Quiet and non-fatal, like RVC's:
// if the box isn't up yet the first real utterance pays the load, as before.
if (WHISPER_URL && sttProviders().includes('whisper')) {
  setTimeout(() => {
    void probeWhisper(10 * 60_000)
      .then(({ ms }) => console.log(`[stt][whisper] warm: ${WHISPER_MODEL} ready (first transcription took ${ms}ms)`))
      .catch(err => console.warn('[stt][whisper] warm-up failed — the first utterance will be slower:',
        err instanceof Error ? err.message : err))
  }, 15_000).unref()
}

export default router
