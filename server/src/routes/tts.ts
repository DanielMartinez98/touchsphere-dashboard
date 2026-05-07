import { Router } from 'express'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

// GET /api/tts?text=hello
//
// Synthesises speech using `espeak-ng` and streams a WAV back to the client.
// We do this server-side because TouchKio is built on Electron, which does
// NOT implement the Web Speech API (`speechSynthesis.speak()` is a silent
// no-op there). The client plays the returned WAV through WebAudio, which
// routes correctly to the system default sink (e.g. Bluetooth A2DP).
//
// Implementation note: we write to a temp file rather than `-w /dev/stdout`
// + `--stdin`. That combo silently produces 0 bytes on Alpine espeak-ng
// (1.51) — espeak's WAV writer seeks back to patch the RIFF header at the
// end, which fails on a non-seekable pipe.
const router = Router()

const MAX_TEXT_LEN = 500            // hard cap to keep synth time bounded
const SYNTH_TIMEOUT_MS = 10_000     // kill runaway processes

router.get('/', async (req, res) => {
  const text = String(req.query['text'] ?? '').trim()
  const voice = String(req.query['voice'] ?? 'en-us')

  if (!text) {
    return res.status(400).json({ error: 'missing text' })
  }
  if (text.length > MAX_TEXT_LEN) {
    return res.status(413).json({ error: `text too long (max ${MAX_TEXT_LEN})` })
  }
  // Whitelist voice codes — espeak-ng accepts e.g. "en-us", "en-gb", "fr"
  if (!/^[a-z]{2}(-[a-z0-9]+)?$/i.test(voice)) {
    return res.status(400).json({ error: 'invalid voice' })
  }

  // Unique temp file per request — avoid collisions between concurrent calls.
  const tmpFile = path.join(os.tmpdir(), `tts-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`)

  // IMPORTANT: text passed as final argv element (no shell), so it can never
  // be interpreted as shell metacharacters.
  const args = [
    '-v', voice,
    '-s', '170',          // speed (words per minute)
    '-p', '55',           // pitch
    '-a', '180',          // amplitude (0-200)
    '-w', tmpFile,
    text,
  ]
  console.log('[tts] espeak-ng', args.map(a => a === text ? `"${a}"` : a).join(' '))

  const child = spawn('espeak-ng', args, { stdio: ['ignore', 'pipe', 'pipe'] })

  let stderr = ''
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
  let stdout = ''
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })

  const timer = setTimeout(() => {
    console.warn('[tts] timeout — killing espeak-ng')
    child.kill('SIGKILL')
  }, SYNTH_TIMEOUT_MS)

  const cleanup = () => { fs.promises.unlink(tmpFile).catch(() => {}) }

  child.on('error', (err) => {
    clearTimeout(timer)
    console.error('[tts] spawn failed:', err.message)
    cleanup()
    if (!res.headersSent) {
      res.status(500).json({ error: 'tts spawn failed', detail: err.message })
    }
  })

  child.on('close', (code) => {
    clearTimeout(timer)
    if (code !== 0) {
      console.error(`[tts] espeak-ng exit=${code} stderr="${stderr.trim()}" stdout="${stdout.trim()}"`)
      cleanup()
      if (!res.headersSent) {
        res.status(500).json({ error: 'tts failed', code, stderr: stderr.trim() })
      }
      return
    }

    fs.stat(tmpFile, (statErr, stat) => {
      if (statErr || stat.size === 0) {
        console.error(`[tts] output file missing/empty: ${tmpFile} (size=${stat?.size ?? 'n/a'}) stderr="${stderr.trim()}"`)
        cleanup()
        if (!res.headersSent) {
          res.status(500).json({ error: 'tts produced empty wav', stderr: stderr.trim() })
        }
        return
      }
      console.log(`[tts] OK ${stat.size} bytes → "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`)
      res.setHeader('Content-Type', 'audio/wav')
      res.setHeader('Content-Length', stat.size)
      res.setHeader('Cache-Control', 'no-store')
      const stream = fs.createReadStream(tmpFile)
      stream.on('close', cleanup)
      stream.on('error', cleanup)
      stream.pipe(res)
    })
  })
})

export default router
