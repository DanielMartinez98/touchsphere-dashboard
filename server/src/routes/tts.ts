import { Router } from 'express'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { getSelectedProfile } from '../config/assistant'

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

const PROVIDER = (process.env['TTS_PROVIDER'] ?? (EL_KEY ? 'elevenlabs' : 'espeak')).toLowerCase()
console.log(`[tts] provider=${PROVIDER}${PROVIDER === 'elevenlabs' ? ` voice=${EL_VOICE_ENV || 'per-assistant'} model=${EL_MODEL_ID}` : ''}`)

router.get('/', async (req, res) => {
  const text = String(req.query['text'] ?? '').trim()
  const voiceParam = String(req.query['voice'] ?? '')

  if (!text) {
    return res.status(400).json({ error: 'missing text' })
  }
  if (text.length > MAX_TEXT_LEN) {
    return res.status(413).json({ error: `text too long (max ${MAX_TEXT_LEN})` })
  }

  try {
    if (PROVIDER === 'elevenlabs') {
      if (!EL_KEY) {
        return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' })
      }
      // Voice precedence: explicit ?voice= override → global env override →
      // the selected assistant's profile voice. All whitelisted to alphanumerics
      // (ElevenLabs voice IDs are ~20-char base62 strings).
      const voiceId =
        voiceParam && /^[a-zA-Z0-9]+$/.test(voiceParam) ? voiceParam
        : EL_VOICE_ENV && /^[a-zA-Z0-9]+$/.test(EL_VOICE_ENV) ? EL_VOICE_ENV
        : getSelectedProfile().elevenVoiceId
      await synthesizeElevenLabs(text, voiceId, res)
    } else {
      const lang = voiceParam || getSelectedProfile().espeakVoice || 'en-us'
      if (!/^[a-z]{2}(-[a-z0-9]+)?$/i.test(lang)) {
        return res.status(400).json({ error: 'invalid voice (espeak expects e.g. "en-us")' })
      }
      await synthesizeEspeak(text, lang, res)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[tts] failed:', msg)
    if (!res.headersSent) {
      res.status(502).json({ error: 'tts failed', detail: msg })
    } else {
      res.end()
    }
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
