import { Router } from 'express'
import multer from 'multer'
import fs from 'fs'
import path from 'path'

const AUDIO_DIR = process.env['AUDIO_DIR'] ?? '/tmp/touchsphere-audio'
fs.mkdirSync(AUDIO_DIR, { recursive: true })

// Disk storage with a sane filename + size limit (10 MB ≈ ~50 min of 24 kbps Opus)
const upload = multer({
  storage: multer.diskStorage({
    destination: AUDIO_DIR,
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, `${Date.now()}-${safe}`)
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^audio\//.test(file.mimetype))
  },
})

const router = Router()

// POST /api/audio/upload  ── multipart form, field name "clip"
router.post('/upload', upload.single('clip'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' })
  res.json({ ok: true, name: req.file.filename, url: `/api/audio/file/${req.file.filename}` })
})

// GET /api/audio/list
router.get('/list', (_req, res) => {
  const files = fs.readdirSync(AUDIO_DIR)
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const s = fs.statSync(path.join(AUDIO_DIR, f))
      return { name: f, size: s.size, mtime: s.mtimeMs, url: `/api/audio/file/${f}` }
    })
    .sort((a, b) => b.mtime - a.mtime)
  res.json(files)
})

// GET /api/audio/file/:name   — Range-aware streaming (required for <audio> seeking)
router.get('/file/:name', (req, res) => {
  const name = path.basename(req.params.name) // prevent traversal
  const full = path.join(AUDIO_DIR, name)
  if (!fs.existsSync(full)) return res.status(404).end()

  const stat = fs.statSync(full)
  const range = req.headers.range
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', 'audio/webm')

  if (!range) {
    res.setHeader('Content-Length', stat.size)
    return fs.createReadStream(full).pipe(res)
  }
  const m = /bytes=(\d+)-(\d*)/.exec(range)
  if (!m) return res.status(416).end()
  const start = Number(m[1])
  const end = m[2] ? Number(m[2]) : stat.size - 1
  res.status(206)
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
  res.setHeader('Content-Length', end - start + 1)
  fs.createReadStream(full, { start, end }).pipe(res)
})

export default router
