import { Router } from 'express'
import { spawn } from 'child_process'

// GET /api/tts?text=hello
//
// Synthesises speech using `espeak-ng` and streams a WAV back to the client.
// We do this server-side because TouchKio is built on Electron, which does
// NOT implement the Web Speech API (`speechSynthesis.speak()` is a silent
// no-op there). The client plays the returned WAV through WebAudio, which
// routes correctly to the system default sink (e.g. Bluetooth A2DP).
//
// Quality is robotic but reliable. Swap `espeak-ng` for `piper` later if you
// want neural TTS — the route signature stays the same.
const router = Router()

const MAX_TEXT_LEN = 500            // hard cap to keep synth time bounded
const SYNTH_TIMEOUT_MS = 10_000     // kill runaway processes

router.get('/', (req, res) => {
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

  // IMPORTANT: pass text as an argv element (no shell), so it cannot be
  // interpreted as shell metacharacters. -w - writes WAV to stdout.
  const child = spawn('espeak-ng', [
    '-v', voice,
    '-s', '170',          // speed (words per minute)
    '-p', '55',           // pitch
    '-a', '180',          // amplitude (max 200)
    '-w', '/dev/stdout',
    '--stdin',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  const timer = setTimeout(() => {
    child.kill('SIGKILL')
  }, SYNTH_TIMEOUT_MS)

  let stderr = ''
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

  child.on('error', (err) => {
    clearTimeout(timer)
    console.error('[tts] spawn failed:', err.message)
    if (!res.headersSent) {
      res.status(500).json({ error: 'tts spawn failed', detail: err.message })
    }
  })

  child.on('close', (code) => {
    clearTimeout(timer)
    if (code !== 0 && !res.headersSent) {
      console.error(`[tts] espeak-ng exited ${code}: ${stderr}`)
      res.status(500).json({ error: 'tts failed', code, stderr })
    }
  })

  // Pipe stdin (the text to speak) → stream stdout (WAV) → response
  res.setHeader('Content-Type', 'audio/wav')
  res.setHeader('Cache-Control', 'no-store')
  child.stdout.pipe(res)
  child.stdin.end(text)
})

export default router
