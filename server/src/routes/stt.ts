import { Router } from 'express'
import multer from 'multer'

// POST /api/stt   ── multipart/form-data, field "audio"
//
// Forwards the uploaded audio clip to ElevenLabs Scribe and returns the
// transcribed text as JSON: { text, language_code }.
//
// The client records via MediaRecorder (webm/opus), runs silence-detection
// (auto-stop on ~1.5s of silence), and POSTs the resulting blob here.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB ≈ ~50 min opus
  fileFilter: (_req, file, cb) => cb(null, /^audio\//.test(file.mimetype)),
})

const router = Router()

const EL_KEY = process.env['ELEVENLABS_API_KEY'] ?? ''
const STT_MODEL = process.env['ELEVENLABS_STT_MODEL'] ?? 'scribe_v1'
const STT_TIMEOUT_MS = 30_000

router.post('/', upload.single('audio'), async (req, res) => {
  if (!EL_KEY) {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' })
  }
  if (!req.file) {
    return res.status(400).json({ error: 'no audio file' })
  }

  const lang = String(req.query['lang'] ?? '').trim()

  console.log(`[stt] uploading ${req.file.size} bytes (${req.file.mimetype}) to ElevenLabs Scribe`)

  try {
    const fd = new FormData()
    // Web FormData (Node 22) accepts Blob — wrap the buffer.
    const blob = new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype })
    fd.append('file', blob, req.file.originalname || 'clip.webm')
    fd.append('model_id', STT_MODEL)
    if (lang && /^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(lang)) {
      fd.append('language_code', lang)
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), STT_TIMEOUT_MS)

    const apiRes = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': EL_KEY },
      body: fd,
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer))

    const bodyText = await apiRes.text()
    if (!apiRes.ok) {
      console.error(`[stt] elevenlabs ${apiRes.status}: ${bodyText.slice(0, 300)}`)
      return res.status(502).json({ error: 'stt failed', status: apiRes.status, detail: bodyText.slice(0, 500) })
    }

    let parsed: { text?: string; language_code?: string } = {}
    try { parsed = JSON.parse(bodyText) } catch { /* fall through */ }
    const text = (parsed.text ?? '').trim()
    console.log(`[stt] OK lang=${parsed.language_code ?? '?'} chars=${text.length} → "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`)

    res.json({ text, language_code: parsed.language_code ?? null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[stt] error:', msg)
    if (!res.headersSent) {
      res.status(500).json({ error: 'stt error', detail: msg })
    }
  }
})

export default router
