// TouchSphere AI power agent — runs on a GPU box, answers the dashboard.
//
// The dashboard (on lokloserver) can switch this PC's AI on and off:
//   on  → Ollama is started and the GPU containers (Kokoro, Whisper, RVC,
//         ComfyUI) are brought up
//   off → loaded Ollama models are unloaded and Ollama is stopped, and the
//         containers are stopped — every process holding VRAM for the AI is
//         gone, so the memory goes back to whatever else the PC is doing (a game)
//
// Two shapes of box, one agent (2026-09-19 — until then only lokloComputer had
// the switch, because this file knew only its layout):
//   • Windows (lokloComputer): the Ollama app, and the containers inside a WSL
//     distro that WSL shuts down once nothing is attached to it — so "on" holds
//     the distro open and "off" terminates it.
//   • Linux (loklo-pc): Ollama as a systemd service (or one of the containers,
//     or not on this box at all), and the containers straight from
//     docker-compose.voice.yml with `docker compose up -d` / `stop`.
// Which shape is read from process.platform. Everything else that differs
// between boxes comes from agent.json beside this file, and every key has a
// default, so lokloComputer's install runs with no file at all:
//
//   {
//     "port": 8190,
//     "bind": "127.0.0.1",                 // or the box's tailnet IP, to skip `tailscale serve`
//     "distro": "touchsphere-ai",          // Windows: the WSL distro the containers live in
//     "ollama": "app",                     // app (the Windows app) | systemd | compose | none
//     "compose": {                         // Linux: what on/off brings up and stops
//       "dir": "/srv/touchsphere",         //   default: the checkout this file is in
//       "file": "docker-compose.voice.yml",
//       "profile": "gpu"
//     },
//     "services": { "comfyui": 8188 },     // the ports "on" waits for (merged over the defaults)
//     "modelsScript": "../scripts/comfy-models.sh",   // the ComfyUI download, for its progress
//     "modelsLog": "../scripts/comfy-models.log"      //   (both optional; found beside this file)
//   }
//
// Listens on 127.0.0.1 only; `tailscale serve --tcp=8190` puts it on the
// tailnet. Every request needs `Authorization: Bearer <token.txt>`.
// Started at logon by start-agent.vbs on Windows (Startup folder), at boot by
// touchsphere-ai-agent.service on Linux (install-agent-linux.sh). No dependencies.
//
//   GET  /status          what is running, VRAM in use, model download progress
//   POST /power {on:bool} switch; answers at once, the work continues behind it

'use strict'
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')

const DIR = __dirname
const WINDOWS = process.platform === 'win32'

// ── Configuration ────────────────────────────────────────────────────────────

let cfg = {}
try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'agent.json'), 'utf8')) || {} } catch { /* no file: the defaults are lokloComputer's */ }

const PORT = Number(cfg.port) || 8190
const BIND = typeof cfg.bind === 'string' && cfg.bind ? cfg.bind : '127.0.0.1'
const DISTRO = typeof cfg.distro === 'string' && cfg.distro ? cfg.distro : 'touchsphere-ai'
// How Ollama runs on this box. The Windows app on Windows, a systemd service
// on Linux, unless the file says otherwise.
const OLLAMA = ['app', 'systemd', 'compose', 'none'].includes(cfg.ollama) ? cfg.ollama : (WINDOWS ? 'app' : 'systemd')
const COMPOSE = {
  dir: typeof cfg.compose?.dir === 'string' && cfg.compose.dir ? cfg.compose.dir : path.resolve(DIR, '..', '..'),
  file: typeof cfg.compose?.file === 'string' && cfg.compose.file ? cfg.compose.file : 'docker-compose.voice.yml',
  profile: typeof cfg.compose?.profile === 'string' && cfg.compose.profile ? cfg.compose.profile : 'gpu',
}
const TOKEN = fs.readFileSync(path.join(DIR, 'token.txt'), 'utf8').trim()
const STATE_FILE = path.join(DIR, 'state.json')
const LOG_FILE = path.join(DIR, 'agent.log')
// The ComfyUI download script and its log: beside this folder in ../scripts on
// lokloComputer (E:\ai\agent + E:\ai\scripts), in this folder when the agent
// runs from the repo checkout. Absent on a box whose models are already there,
// and then there is simply no progress to report.
function firstExisting(candidates) {
  return candidates.find(p => { try { return fs.existsSync(p) } catch { return false } }) || ''
}
const MODELS_SCRIPT = typeof cfg.modelsScript === 'string' && cfg.modelsScript
  ? path.resolve(DIR, cfg.modelsScript)
  : firstExisting([path.join(DIR, '..', 'scripts', 'comfy-models.sh'), path.join(DIR, 'comfy-models.sh')])
const MODELS_LOG = typeof cfg.modelsLog === 'string' && cfg.modelsLog
  ? path.resolve(DIR, cfg.modelsLog)
  : (MODELS_SCRIPT ? MODELS_SCRIPT.replace(/\.sh$/, '.log') : '')
const OLLAMA_APP = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe')
const SERVICES = { ollama: 11434, kokoro: 8880, whisper: 8000, rvc: 5050, comfyui: 8188 }
for (const [k, v] of Object.entries(cfg.services || {})) {
  if (Number.isInteger(v) && v > 0) SERVICES[k] = v
  else delete SERVICES[k]           // "kokoro": null — this box does not run it
}
// A box that does not run Ollama is not waited on for it.
if (OLLAMA === 'none') delete SERVICES.ollama
const START_BUDGET_MS = 6 * 60_000

// ── Log ──────────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1')
    fs.appendFileSync(LOG_FILE, line)
  } catch { /* logging must never stop the agent */ }
}

// ── State ────────────────────────────────────────────────────────────────────

let desired = 'on'
try { desired = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).desired === 'off' ? 'off' : 'on' } catch { /* first run */ }

let phase = 'off'        // on | off | starting | stopping
let since = new Date().toISOString()
let detail = ''

function setPhase(p, d = '') {
  phase = p
  since = new Date().toISOString()
  detail = d
  log(`phase ${p}${d ? ` — ${d}` : ''}`)
}

function saveDesired(v) {
  desired = v
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ desired: v }, null, 2)) } catch (e) { log(`could not save state: ${e.message}`) }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, args, timeoutMs = 60_000, cwd = undefined) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: timeoutMs, env: { ...process.env, WSL_UTF8: '1' } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }))
  })
}

/** docker compose against this box's voice stack, run in its checkout. */
function compose(args, timeoutMs = 120_000) {
  return run('docker', ['compose', '-f', COMPOSE.file, '--profile', COMPOSE.profile, ...args], timeoutMs, COMPOSE.dir)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Any HTTP answer counts, as in the dashboard's own probe. */
function answers(port, timeoutMs = 2500) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'HEAD', timeout: timeoutMs }, res => { res.on('error', () => {}); res.resume(); resolve(true) })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

function httpJson(method, port, pathname, body, timeoutMs = 10_000) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, res => {
      let s = ''
      // A response cut off mid-body emits 'error'; unheard, that kills the process.
      res.on('error', () => resolve(null))
      res.on('data', c => { s += c })
      res.on('end', () => { try { resolve(JSON.parse(s)) } catch { resolve(null) } })
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
    if (data) req.write(data)
    req.end()
  })
}

/** The containers' host is up: the WSL distro on Windows, a running compose service on Linux. */
async function containersRunning() {
  if (WINDOWS) {
    // `-l --running` only lists; it never starts a distro (any `-d` call would).
    const r = await run('wsl.exe', ['-l', '--running', '-q'], 15_000)
    return r.stdout.replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).includes(DISTRO)
  }
  const r = await compose(['ps', '--status', 'running', '-q'], 30_000)
  return r.code === 0 && r.stdout.trim().length > 0
}

async function ollamaProcesses() {
  const r = await run('tasklist.exe', ['/FO', 'CSV', '/NH'], 15_000)
  return r.stdout.split(/\r?\n/).filter(l => /^"ollama( app)?\.exe"/i.test(l)).length
}

async function ollamaRunning() {
  if (OLLAMA === 'app') return (await ollamaProcesses()) > 0
  if (OLLAMA === 'systemd') return (await run('systemctl', ['is-active', 'ollama'], 15_000)).stdout.trim() === 'active'
  if (OLLAMA === 'compose') return SERVICES.ollama ? answers(SERVICES.ollama) : false
  return false
}

async function startOllama() {
  if (OLLAMA === 'app') {
    try {
      const app = spawn(OLLAMA_APP, [], { detached: true, stdio: 'ignore', windowsHide: true })
      app.on('error', e => log(`could not start Ollama: ${e.message}`))
      app.unref()
      log('Ollama app started')
    } catch (e) { log(`could not start Ollama: ${e.message}`) }
  } else if (OLLAMA === 'systemd') {
    const r = await run('systemctl', ['start', 'ollama'], 60_000)
    log(r.code === 0 ? 'ollama service started' : `could not start the ollama service (${r.code}): ${r.stderr.trim()}`)
  }
  // compose: it comes up with the rest of the stack. none: nothing to start.
}

async function stopOllama() {
  if (OLLAMA === 'app') {
    await run('taskkill.exe', ['/IM', 'ollama app.exe', '/F'], 15_000)
    await run('taskkill.exe', ['/IM', 'ollama.exe', '/F'], 15_000)
  } else if (OLLAMA === 'systemd') {
    const r = await run('systemctl', ['stop', 'ollama'], 60_000)
    log(r.code === 0 ? 'ollama service stopped' : `could not stop the ollama service (${r.code}): ${r.stderr.trim()}`)
  }
  // compose: it goes down with the rest of the stack. none: nothing to stop.
}

async function gpu() {
  const r = await run('nvidia-smi', ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader,nounits'], 15_000)
  const [name, used, total] = r.stdout.split(/\r?\n/)[0]?.split(',').map(s => s.trim()) ?? []
  return name ? { name, usedMb: Number(used), totalMb: Number(total) } : null
}

function modelsProgress() {
  const none = { total: 0, done: 0, current: null, failed: [] }
  let lines = []
  // No log means the download has never run here — nothing to report, rather
  // than "0 of 12" on a box whose models were put there some other way.
  try { lines = fs.readFileSync(MODELS_LOG, 'utf8').split(/\r?\n/) } catch { return none }
  let total = 0
  try {
    total = fs.readFileSync(MODELS_SCRIPT, 'utf8').split(/\r?\n/).filter(l => /^[a-z_]+\|[^|]+\|/.test(l)).length
  } catch { return none }
  const have = new Set()
  const failed = new Set()
  let current = null
  for (const l of lines) {
    const m = /^(have|get|done|FAIL)\s+(\S+)/.exec(l)
    if (!m) continue
    if (m[1] === 'have' || m[1] === 'done') { have.add(m[2]); if (current === m[2]) current = null }
    else if (m[1] === 'FAIL') { failed.add(m[2]); if (current === m[2]) current = null }
    else current = m[2]
  }
  return { total, done: have.size, current, failed: [...failed] }
}

// ── Keeping the distro open (Windows) ────────────────────────────────────────
// WSL terminates a distro once no wsl.exe client is attached, services and all.

let keeper = null

function ensureKeeper() {
  if (keeper) return
  keeper = spawn('wsl.exe', ['-d', DISTRO, '--exec', '/bin/sleep', 'infinity'], { windowsHide: true, stdio: 'ignore' })
  keeper.on('error', e => log(`keeper could not start: ${e.message}`))
  log(`keeper started (pid ${keeper.pid})`)
  keeper.on('exit', code => {
    log(`keeper exited (${code})`)
    keeper = null
    if (desired === 'on' && phase !== 'stopping') setTimeout(() => { if (desired === 'on') ensureKeeper() }, 5000)
  })
}

// ── Switching ────────────────────────────────────────────────────────────────

let queue = Promise.resolve()
function serial(fn) {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

async function turnOn() {
  if (desired !== 'on') return
  setPhase('starting', 'starting Ollama and the GPU services')
  if (!(await ollamaRunning())) await startOllama()
  if (WINDOWS) {
    // The distro's own systemd brings dockerd and the containers back.
    ensureKeeper()
  } else {
    const r = await compose(['up', '-d'], 5 * 60_000)
    if (r.code !== 0) log(`docker compose up failed (${r.code}): ${r.stderr.trim().slice(-400)}`)
  }
  const deadline = Date.now() + START_BUDGET_MS
  let down = []
  while (Date.now() < deadline) {
    if (desired !== 'on') return
    const up = await Promise.all(Object.entries(SERVICES).map(async ([k, p]) => [k, await answers(p)]))
    down = up.filter(([, ok]) => !ok).map(([k]) => k)
    if (down.length === 0) break
    detail = `waiting for ${down.join(', ')}`
    await sleep(5000)
  }
  setPhase('on', down.length ? `on, but not answering: ${down.join(', ')}` : '')
}

async function turnOff() {
  if (desired !== 'off') return
  setPhase('stopping', 'unloading models and stopping the GPU services')
  // Unload first so Ollama gives the VRAM back even if stopping it misbehaves.
  if (SERVICES.ollama) {
    const ps = await httpJson('GET', SERVICES.ollama, '/api/ps', null, 5000)
    for (const m of ps?.models ?? []) {
      await httpJson('POST', SERVICES.ollama, '/api/generate', { model: m.name, keep_alive: 0 }, 20_000)
      log(`unloaded ${m.name}`)
    }
  }
  await stopOllama()
  if (WINDOWS) {
    if (keeper) { try { keeper.kill() } catch { /* already gone */ } }
    await run('wsl.exe', ['--terminate', DISTRO], 60_000)
  } else {
    // stop, not down: the containers keep their state and come back in
    // seconds, and a volume is never at risk from a switch.
    const r = await compose(['stop'], 3 * 60_000)
    if (r.code !== 0) log(`docker compose stop failed (${r.code}): ${r.stderr.trim().slice(-400)}`)
  }
  for (let i = 0; i < 20 && await containersRunning(); i++) await sleep(1500)
  const g = await gpu()
  setPhase('off', g ? `VRAM in use now: ${(g.usedMb / 1024).toFixed(1)} of ${(g.totalMb / 1024).toFixed(0)} GB` : '')
}

function power(on) {
  saveDesired(on ? 'on' : 'off')
  if (on) setPhase('starting', 'queued')
  else setPhase('stopping', 'queued')
  void serial(on ? turnOn : turnOff).catch(e => { log(`power ${on ? 'on' : 'off'} failed: ${e.stack || e}`); detail = String(e.message || e) })
}

// ── Status ───────────────────────────────────────────────────────────────────

async function status() {
  const [containers, ollamaUp, g, ps, ...ports] = await Promise.all([
    containersRunning(),
    ollamaRunning(),
    gpu(),
    SERVICES.ollama ? httpJson('GET', SERVICES.ollama, '/api/ps', null, 3000) : Promise.resolve(null),
    ...Object.values(SERVICES).map(p => answers(p)),
  ])
  const services = Object.fromEntries(Object.keys(SERVICES).map((k, i) => [k, ports[i]]))
  return {
    host: os.hostname(),
    platform: WINDOWS ? 'windows' : 'linux',
    desired,
    phase,
    since,
    detail,
    containersRunning: containers,
    ollamaRunning: ollamaUp,
    ollamaLoaded: (ps?.models ?? []).map(m => ({ name: m.name, vramMb: Math.round((m.size_vram ?? 0) / 1024 / 1024) })),
    services,
    gpu: g,
    models: modelsProgress(),
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function authorized(req) {
  const got = Buffer.from(String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, ''))
  const want = Buffer.from(TOKEN)
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

function send(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(s)
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, await status())
    if (req.method === 'POST' && req.url === '/power') {
      let raw = ''
      for await (const c of req) { raw += c; if (raw.length > 1000) break }
      let on
      try { on = JSON.parse(raw).on } catch { /* bad body */ }
      if (typeof on !== 'boolean') return send(res, 400, { error: 'body must be {"on": true|false}' })
      log(`power ${on ? 'on' : 'off'} requested by ${req.socket.remoteAddress}`)
      power(on)
      return send(res, 202, await status())
    }
    send(res, 404, { error: 'not found' })
  } catch (e) {
    log(`request failed: ${e.stack || e}`)
    send(res, 500, { error: String(e.message || e) })
  }
})

// ── Staying up, and saying why when it doesn't ───────────────────────────────
// The agent once disappeared with nothing in this log and nothing in Windows'
// event logs — an uncaught exception ends Node quietly. Every way out is now
// written down, and start-agent.vbs (or systemd) starts it again when it exits.
process.on('uncaughtException', e => { log(`uncaught exception: ${e && e.stack || e}`); process.exit(1) })
process.on('unhandledRejection', e => { log(`unhandled rejection: ${e && e.stack || e}`) })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => { log(`received ${sig}`); process.exit(0) })
}
process.on('exit', code => log(`exiting with code ${code}`))

server.on('error', e => {
  log(`listen failed: ${e.message}`)
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1)
})

server.listen(PORT, BIND, async () => {
  log(`agent listening on ${BIND}:${PORT} (${WINDOWS ? `windows, distro ${DISTRO}` : `linux, ${path.join(COMPOSE.dir, COMPOSE.file)} --profile ${COMPOSE.profile}`}, ollama: ${OLLAMA}); desired=${desired}`)
  const [containers, ollamaUp] = await Promise.all([containersRunning(), ollamaRunning()])
  if (desired === 'on') {
    serial(turnOn).catch(e => log(`start-up turn on failed: ${e && e.stack || e}`))
  } else {
    setPhase(containers || ollamaUp ? 'on' : 'off')
    // Left off: Ollama starts itself at boot (the Windows app at logon, the
    // service with the system), so once it has had time to come up, put it
    // back down — the PC should come back from a reboot the way it was left.
    setTimeout(() => { if (desired === 'off') serial(turnOff).catch(e => log(`start-up turn off failed: ${e && e.stack || e}`)) }, 90_000)
  }
})
