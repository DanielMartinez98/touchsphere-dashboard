// Updating the machine this container runs on, from Settings → Server.
//
// A container cannot run apt, fwupd, tailscale or docker on its host, and the
// usual escape hatches are all worse than the problem: mounting the docker
// socket is root on the host in everything but name and still doesn't reach
// apt; a privileged container is the same with fewer steps. So the container
// talks to the host the way it talks to every other machine — over the
// network, with a credential of its own — and the host decides what that
// credential may do.
//
// The credential is an SSH key generated HERE, on the volume, on first use
// (nothing has to be copied into the container). On the host, that key's
// authorized_keys line is pinned with `restrict,command=` to one root-owned
// script, scripts/host/touchsphere-host, which accepts a fixed list of verbs
// and refuses anything else; a sudoers rule lets it run exactly those verbs
// as root. A compromised container can therefore reboot the box or install
// its updates; it cannot open a shell on it. scripts/host/install.sh puts all
// of that in place from the public key this module prints.
//
// Everything is gated on HOST_UPDATE_SSH (user@host[:port]) — unset, the tab
// is absent and none of this loads, the same rule as COMFYUI_URL and the Plex
// stack. The host is normally the docker bridge gateway (172.18.0.1), which
// is the host's own address as seen from inside the compose network.
//
// Tasks run ONE AT A TIME and stream their output over the existing SSE
// channel, line by line, so the screen shows apt's progress rather than a
// spinner for four minutes. The log is a ring buffer in memory like the guide
// activity feed: a window on work in progress, not a record.

import { execFileSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { broadcast } from './routes/system'

const TARGET = (process.env['HOST_UPDATE_SSH'] ?? '').trim()

/** The verbs the host script accepts, with the label the screen shows. */
export const HOST_TASKS = {
  'apt-refresh':      'Check for package updates',
  'apt-upgrade':      'Install package updates',
  'firmware-check':   'Check for firmware updates',
  'firmware-update':  'Install firmware updates',
  'tailscale-update': 'Update Tailscale',
  'containers':       'Update containers',
  'self-update':      'Update the dashboard',
  'disk-clean':       'Free up disk space',
  'reboot':           'Reboot the server',
} as const
export type HostTask = keyof typeof HOST_TASKS

export function isHostTask(v: unknown): v is HostTask {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(HOST_TASKS, v)
}

/** Tasks that must be asked for twice: they take the screen (or the box) down. */
export const CONFIRM_TASKS: ReadonlySet<HostTask> = new Set<HostTask>(['self-update', 'reboot'])

export function hostEnabled(): boolean {
  return TARGET.length > 0
}

/** `user@host`, for the screen. The port, if any, is not interesting there. */
export function hostTarget(): string {
  return TARGET.replace(/:\d+$/, '')
}

// ── the key ─────────────────────────────────────────────────────────────────

function keyDir(): string {
  const dir = path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'host')
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* exists */ }
  return dir
}

/**
 * Generate the key on first use. ed25519, no passphrase (nobody is there to
 * type one), comment `touchsphere-host` — which is the string the installer
 * uses to find and replace its own authorized_keys line on a re-run.
 */
function ensureKey(): string {
  const priv = path.join(keyDir(), 'id_ed25519')
  if (!fs.existsSync(priv)) {
    try {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'touchsphere-host', '-f', priv], { stdio: 'ignore' })
      console.log('[host] generated a new SSH key for host updates')
    } catch (err) {
      console.error('[host] ssh-keygen failed — is openssh-client in the image?', err)
    }
  }
  return priv
}

export function publicKey(): string {
  const pub = `${ensureKey()}.pub`
  try { return fs.readFileSync(pub, 'utf8').trim() } catch { return '' }
}

function sshArgs(verb: HostTask | 'status'): string[] {
  const m = TARGET.match(/^(.+?)(?::(\d+))?$/)
  const userHost = m?.[1] ?? TARGET
  const port = m?.[2]
  return [
    '-i', ensureKey(),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    // Trust on first use: the host's key is pinned the first time it is
    // seen, on the volume, and a change after that is refused. The first
    // connection is to a box on the same machine, over the docker bridge.
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.join(keyDir(), 'known_hosts')}`,
    '-o', 'LogLevel=ERROR',
    '-o', 'ServerAliveInterval=15',
    ...(port ? ['-p', port] : []),
    userHost,
    verb,
  ]
}

/**
 * What an SSH failure means in words. Exit 255 is ssh itself — no route, no
 * key accepted — which on a fresh install is "you haven't run the installer
 * yet", and the screen should say so rather than print an exit code.
 */
function explainExit(code: number | null, stderr: string): string {
  const err = stderr.trim().split('\n').pop() ?? ''
  if (code === 255) {
    if (/Permission denied/i.test(err)) return 'The host refused the key — run scripts/host/install.sh with the public key shown here.'
    if (/Connection refused|timed out|No route/i.test(err)) return `Could not reach ${hostTarget()} — is sshd running on the host, and is HOST_UPDATE_SSH right?`
    return `SSH failed: ${err || 'no details'}`
  }
  if (code === 64) return 'The host script refused the command — it is older than this dashboard; re-run scripts/host/install.sh.'
  if (code === 78) return `The host script is not configured: ${err}`
  return err ? `exited ${code}: ${err}` : `exited ${code}`
}

// ── status ──────────────────────────────────────────────────────────────────

export interface HostStatusResult {
  ok:     boolean
  /** The host script's JSON, verbatim, when ok. */
  status: unknown
  error:  string
}

/** Run the `status` verb: one JSON document about the box. ~2–5 s. */
export function hostStatus(): Promise<HostStatusResult> {
  return new Promise(resolve => {
    let out = ''
    let err = ''
    const child = spawn('ssh', sshArgs('status'), { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); err += '\nstatus took too long' }, 90_000)
    child.stdout.on('data', (b: Buffer) => { out += b.toString() })
    child.stderr.on('data', (b: Buffer) => { err += b.toString() })
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, status: null, error: `could not run ssh: ${e.message}` }) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return resolve({ ok: false, status: null, error: explainExit(code, err) })
      try {
        resolve({ ok: true, status: JSON.parse(out), error: '' })
      } catch {
        resolve({ ok: false, status: null, error: 'the host script returned something that is not JSON' })
      }
    })
  })
}

// ── tasks ───────────────────────────────────────────────────────────────────

export interface HostLine {
  id:     number
  at:     string
  task:   HostTask
  line:   string
  stream: 'out' | 'err'
}

export interface HostState {
  running:   HostTask | null
  startedAt: string | null
  last: {
    task:    HostTask
    ok:      boolean
    code:    number | null
    endedAt: string
    /** One line for the card: the explanation on failure, the tail on success. */
    summary: string
  } | null
}

const MAX_LINES = 600
const lines: HostLine[] = []
let nextId = 1
let child: ChildProcess | null = null
const state: HostState = { running: null, startedAt: null, last: null }

export function hostState(): HostState {
  return { ...state, last: state.last ? { ...state.last } : null }
}

export function hostLog(): HostLine[] {
  return lines.slice()
}

function push(task: HostTask, stream: 'out' | 'err', text: string): void {
  const line = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd()
  if (!line.trim()) return
  const entry: HostLine = { id: nextId++, at: new Date().toISOString(), task, line, stream }
  lines.push(entry)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  broadcast('host-update', { type: 'line', line: entry })
}

function announce(): void {
  broadcast('host-update', { type: 'state', state: hostState() })
}

/**
 * Start one task. Refused while another runs — apt holds a lock and two
 * container updates at once is a race — and the refusal is the return value,
 * not a throw, so the route prints it under the button.
 */
export function startTask(task: HostTask): { ok: true } | { ok: false; error: string } {
  if (!hostEnabled()) return { ok: false, error: 'HOST_UPDATE_SSH is not set' }
  if (state.running) return { ok: false, error: `${HOST_TASKS[state.running]} is still running` }

  state.running = task
  state.startedAt = new Date().toISOString()
  push(task, 'out', `▶ ${HOST_TASKS[task]}`)
  announce()
  console.log(`[host] ${task} started`)

  // Lines arrive in chunks and apt draws progress with bare \r, so the
  // splitter treats \r, \n and \r\n alike and keeps the unfinished tail.
  const feed = (stream: 'out' | 'err') => {
    let buf = ''
    return (b: Buffer) => {
      buf += b.toString()
      const parts = buf.split(/\r\n|\n|\r/)
      buf = parts.pop() ?? ''
      for (const p of parts) push(task, stream, p)
    }
  }
  let lastLine = ''
  const outFeed = feed('out')
  const errFeed = feed('err')
  let stderrTail = ''

  try {
    child = spawn('ssh', sshArgs(task), { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    state.running = null
    const msg = err instanceof Error ? err.message : String(err)
    state.last = { task, ok: false, code: null, endedAt: new Date().toISOString(), summary: `could not run ssh: ${msg}` }
    announce()
    return { ok: false, error: state.last.summary }
  }

  // Nothing here should take longer than a full dist-upgrade on a slow disk.
  const timer = setTimeout(() => {
    push(task, 'err', 'Gave up waiting after 45 minutes; the host may still be working.')
    child?.kill('SIGKILL')
  }, 45 * 60_000)

  child.stdout?.on('data', (b: Buffer) => { outFeed(b); lastLine = b.toString().trim().split(/\r\n|\n|\r/).filter(Boolean).pop() ?? lastLine })
  child.stderr?.on('data', (b: Buffer) => { errFeed(b); stderrTail = (stderrTail + b.toString()).slice(-2000) })
  child.on('error', e => push(task, 'err', `could not run ssh: ${e.message}`))
  child.on('close', code => {
    clearTimeout(timer)
    const ok = code === 0
    const summary = ok
      ? (lastLine.replace(/^▶\s*/, '') || 'finished')
      : explainExit(code, stderrTail)
    state.last = { task, ok, code, endedAt: new Date().toISOString(), summary }
    state.running = null
    child = null
    push(task, ok ? 'out' : 'err', ok ? `✓ ${HOST_TASKS[task]} finished` : `✗ ${HOST_TASKS[task]} failed — ${summary}`)
    announce()
    console.log(`[host] ${task} ${ok ? 'finished' : `failed (${summary})`}`)
  })

  return { ok: true }
}
