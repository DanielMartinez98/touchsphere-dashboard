// Proves the local-AI provider chains — with no GPU, no models and no keys.
//
//   npm run test:local-ai        (from server/)
//
// Every AI service the app talks to is stood in for by a small HTTP server in
// this process: a Whisper that speaks OpenAI's transcription API, an
// ElevenLabs (Scribe, text-to-speech, /v1/user), a Kokoro, an Ollama that
// answers with a tool call and then a reply, and a SearXNG. The REAL server is
// then booted — src/index.ts, exactly as `npm run dev` runs it — with its
// environment pointed at those fakes, and asked the questions a kiosk asks:
// transcribe this, say this, answer this. Each fake can be told to fail, so
// the thing under test is the ORDER of each chain and what happens at every
// link, which is precisely what a real deployment cannot show you: on a box
// where everything works, "Whisper answered" and "ElevenLabs answered" are
// indistinguishable from the screen.
//
// Four boots, because the chains are decided at module load from the
// environment: local-first with the cloud behind it; local with no cloud keys
// at all; the pre-Whisper configuration (nothing must have changed for it);
// and nothing configured, which must say so rather than 502 on every word.
//
// Deliberately dependency-free (node:http, node:test-free asserts) so it runs
// wherever the server does.

import http from 'http'
import net from 'net'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { spawn, type ChildProcess } from 'child_process'

const SERVER_DIR = path.resolve(__dirname, '..')

// ── Tiny assertion runner ────────────────────────────────────────────────────
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else    { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── Fakes ────────────────────────────────────────────────────────────────────
interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
interface Fake { url: string; seen: Seen[]; fail: boolean; text: string; close(): Promise<void> }

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

async function fake(handler: (f: Fake, req: Seen, res: http.ServerResponse) => void): Promise<Fake> {
  const state = { seen: [] as Seen[], fail: false, text: '' }
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req)
    const seen: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }
    state.seen.push(seen)
    handler(f, seen, res)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  const f: Fake = {
    url: `http://127.0.0.1:${port}`,
    get seen() { return state.seen },
    get fail() { return state.fail }, set fail(v: boolean) { state.fail = v },
    get text() { return state.text }, set text(v: string) { state.text = v },
    close: () => new Promise<void>(r => server.close(() => r())),
  }
  return f
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** OpenAI-shaped Whisper (speaches, faster-whisper-server, whisper.cpp --convert). */
const fakeWhisper = () => fake((f, req, res) => {
  if (req.url !== '/v1/audio/transcriptions' || req.method !== 'POST') return json(res, 404, { detail: 'Not Found' })
  if (f.fail) return json(res, 500, { detail: 'model load failed (fake)' })
  json(res, 200, { text: f.text, language: 'en' })
})

/** ElevenLabs: Scribe, text-to-speech, and the /v1/user probe. */
const fakeEleven = (key: string) => fake((f, req, res) => {
  if (req.headers['xi-api-key'] !== key) return json(res, 401, { detail: { status: 'invalid_api_key', message: 'bad key (fake)' } })
  if (req.url === '/v1/user') return json(res, 200, { subscription: { tier: 'free', character_count: 10, character_limit: 10_000 } })
  if (req.url === '/v1/speech-to-text') {
    if (f.fail) return json(res, 401, { detail: { status: 'invalid_api_key', message: 'rejected (fake)' } })
    return json(res, 200, {
      text: f.text, language_code: 'en',
      words: f.text.split(' ').flatMap((w, i) => i === 0 ? [{ text: w, type: 'word' }] : [{ text: ' ', type: 'spacing' }, { text: w, type: 'word' }]),
    })
  }
  if (req.url?.startsWith('/v1/text-to-speech/')) {
    if (f.fail) return json(res, 500, { detail: 'synthesis failed (fake)' })
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    return res.end(Buffer.from('ID3-elevenlabs-fake-audio'))
  }
  json(res, 404, { detail: 'Not Found' })
})

/** Kokoro-FastAPI: OpenAI's /v1/audio/speech. */
const fakeKokoro = () => fake((f, req, res) => {
  if (req.url !== '/v1/audio/speech') return json(res, 404, {})
  if (f.fail) return json(res, 503, { detail: 'kokoro down (fake)' })
  res.writeHead(200, { 'content-type': 'audio/mpeg' })
  res.end(Buffer.from('ID3-kokoro-fake-audio'))
})

/** Ollama: a tool call on the first turn, a reply once the tool's result is in. */
const fakeOllama = () => fake((f, req, res) => {
  if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'qwen3:8b' }] })
  if (req.url !== '/api/chat') return json(res, 404, {})
  if (f.fail) return json(res, 500, { error: 'ollama down (fake)' })
  const body = JSON.parse(req.body.toString('utf8')) as { messages: Array<{ role: string; content: string }> }
  const hasToolResult = body.messages.some(m => m.role === 'tool')
  if (!hasToolResult) {
    return json(res, 200, { model: 'qwen3:8b', done: true, message: {
      role: 'assistant', content: '',
      tool_calls: [{ function: { name: 'web_search', arguments: { query: 'touchsphere dashboard' } } }],
    } })
  }
  json(res, 200, { model: 'qwen3:8b', done: true, message: { role: 'assistant', content: f.text } })
})

/** SearXNG: /search?format=json. */
const fakeSearxng = () => fake((f, req, res) => {
  if (!req.url?.startsWith('/search')) return json(res, 404, {})
  if (f.fail) return json(res, 200, { results: [], unresponsive_engines: [['google', 'suspended (fake)']] })
  json(res, 200, { results: [
    { title: 'TouchSphere test page', url: 'https://example.com/touchsphere', content: 'A page about the TouchSphere dashboard, found by the local engine.' },
  ] })
})

// ── The real server ──────────────────────────────────────────────────────────
interface Booted { port: number; log: () => string; stop(): Promise<void> }

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
  })
}

async function boot(env: Record<string, string>): Promise<Booted> {
  const port = await freePort()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-local-ai-'))
  let out = ''
  // cwd is a fresh temp dir, NOT server/: dotenv.config() reads .env from the
  // cwd, and a developer's real keys must not leak into a test that asserts
  // which provider answered. The register hook is named by absolute path for
  // the same reason (nothing resolves from the temp dir).
  const child: ChildProcess = spawn(process.execPath, [
    '-r', path.join(SERVER_DIR, 'node_modules/ts-node/register/transpile-only'),
    path.join(SERVER_DIR, 'src/index.ts'),
  ], {
    cwd: tmp,
    env: {
      PATH: process.env['PATH'] ?? '', HOME: tmp,
      TS_NODE_PROJECT: path.join(SERVER_DIR, 'tsconfig.json'),
      NODE_ENV: 'development', PORT: String(port), CACHE_DIR: path.join(tmp, 'cache'),
      AUDIO_DIR: path.join(tmp, 'audio'), AVATAR_DIR: path.join(tmp, 'avatar'),
      OPENWEATHER_API_KEY: 'test-key-not-real', DEFAULT_LAT: '0', DEFAULT_LON: '0',
      OLLAMA_MODEL: 'qwen3:8b', OLLAMA_THINK: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
  child.stderr?.on('data', (d: Buffer) => { out += d.toString() })

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${out.slice(-2000)}`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) break
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  if (child.exitCode !== null) throw new Error(`server exited early:\n${out.slice(-2000)}`)
  return {
    port,
    log: () => out,
    stop: () => new Promise<void>(resolve => {
      child.once('exit', () => { fs.rmSync(tmp, { recursive: true, force: true }); resolve() })
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }),
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
/** A second of 16 kHz silence in a RIFF header — the same clip the app probes with. */
function silentWav(): Buffer {
  const rate = 16_000, data = rate * 2
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(data, 40)
  return b
}

async function stt(port: number): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const fd = new FormData()
  fd.append('audio', new Blob([new Uint8Array(silentWav())], { type: 'audio/wav' }), 'clip.wav')
  const r = await fetch(`http://127.0.0.1:${port}/api/stt`, { method: 'POST', body: fd })
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

async function get(port: number, p: string): Promise<{ status: number; headers: Headers; body: Record<string, unknown>; bytes: number }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`)
  const buf = Buffer.from(await r.arrayBuffer())
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(buf.toString('utf8')) } catch { /* audio */ }
  return { status: r.status, headers: r.headers, body, bytes: buf.length }
}

const has = (buf: Buffer, s: string) => buf.toString('latin1').includes(s)

// ── Scenarios ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const EL_KEY = 'sk_fake_elevenlabs_key'
  const whisper = await fakeWhisper()
  const eleven  = await fakeEleven(EL_KEY)
  const kokoro  = await fakeKokoro()
  const ollama  = await fakeOllama()
  const searx   = await fakeSearxng()
  whisper.text = 'the quick brown fox'
  eleven.text  = 'the quick brown fox via scribe'
  ollama.text  = 'Pong: the search found the TouchSphere test page.'
  const fakes = [whisper, eleven, kokoro, ollama, searx]

  try {
    // ── A. Local first, cloud behind it — the configuration .env.example recommends ──
    console.log('\nA. local first, cloud kept as the fallback')
    let s = await boot({
      WHISPER_URL: whisper.url, ELEVENLABS_API_KEY: EL_KEY, ELEVENLABS_API_URL: eleven.url,
      KOKORO_URL: kokoro.url, TTS_PROVIDER: 'local',
      OLLAMA_URL: ollama.url, SEARXNG_URL: searx.url, SEARCH_PREFER_LOCAL: '1',
    })
    try {
      const log = s.log()
      check('startup banner names Whisper first for speech-to-text', /speech-to-text\s+: whisper \(local/.test(log))
      check('startup banner puts Kokoro ahead of ElevenLabs for speech', /text-to-speech\s+: kokoro \(local\) → elevenlabs \(cloud\) → espeak \(local\)/.test(log))
      check('startup banner puts SearXNG first for web search', /web search\s+: searxng → duckduckgo → wikipedia/.test(log))

      const dbg = await get(s.port, '/api/system/debug')
      const chains = dbg.body['chains'] as Record<string, string> | undefined
      const config = dbg.body['config'] as Record<string, boolean>
      check('/api/system/debug reports the STT chain local-first', !!chains && chains['stt']!.startsWith('whisper (local'), JSON.stringify(chains))
      check('/api/system/debug reports the TTS chain local-first', !!chains && chains['tts']!.startsWith('kokoro (local) → elevenlabs (cloud)'))
      check('/api/system/debug reports the search chain local-first', !!chains && chains['search']!.startsWith('searxng (local)'))
      check('/api/system/debug flags WHISPER_URL / KOKORO_URL / SEARXNG_URL as set', config['WHISPER_URL'] === true && config['KOKORO_URL'] === true && config['SEARXNG_URL'] === true)
      check('no STT warning when a provider is configured', !((dbg.body['warnings'] as string[]) ?? []).some(w => /speech-to-text/i.test(w)))

      // Hearing: Whisper answers, ElevenLabs is never asked.
      let r = await stt(s.port)
      check('/api/stt answers 200 from Whisper', r.status === 200 && r.body['provider'] === 'whisper', JSON.stringify(r.body))
      check('X-STT-Provider names whisper and is exposed to the browser', r.headers.get('x-stt-provider') === 'whisper' && /X-STT-Provider/i.test(r.headers.get('access-control-expose-headers') ?? ''))
      check('the transcript is what Whisper said', r.body['text'] === 'the quick brown fox')
      const w = whisper.seen[whisper.seen.length - 1]!
      check('Whisper was sent an OpenAI-shaped multipart request (file + model + response_format)',
        /multipart\/form-data/.test(String(w.headers['content-type'])) && has(w.body, 'name="file"') && has(w.body, 'name="model"') && has(w.body, 'Systran/faster-whisper-small') && has(w.body, 'name="response_format"'))
      check('ElevenLabs Scribe was not asked while Whisper answers', !eleven.seen.some(x => x.url === '/v1/speech-to-text'))

      // Whisper down → Scribe catches it.
      whisper.fail = true
      r = await stt(s.port)
      check('with Whisper failing, /api/stt falls back to ElevenLabs Scribe', r.status === 200 && r.body['provider'] === 'elevenlabs' && r.headers.get('x-stt-provider') === 'elevenlabs', JSON.stringify(r.body))
      check('the fallback transcript is Scribe\'s', r.body['text'] === 'the quick brown fox via scribe')
      check('Scribe was sent the key', eleven.seen.some(x => x.url === '/v1/speech-to-text' && x.headers['xi-api-key'] === EL_KEY))

      // Both down → an honest 502 that names both.
      eleven.fail = true
      r = await stt(s.port)
      check('with both failing, /api/stt answers 502 and lists what it tried', r.status === 502 && JSON.stringify(r.body['tried']) === '["whisper","elevenlabs"]', JSON.stringify(r.body))
      check('the 502 carries each provider\'s own error', /whisper 500/.test(String(r.body['detail'])) && /elevenlabs 401/.test(String(r.body['detail'])))
      check('the 502 status field is the last upstream status (401 → "check the key" on the kiosk)', r.body['status'] === 401)
      whisper.fail = false; eleven.fail = false

      // A silence hallucination is dropped; a real sentence containing the words is kept.
      whisper.text = 'Thanks for watching.'
      r = await stt(s.port)
      check('a whole-transcript Whisper hallucination ("Thanks for watching.") becomes silence', r.status === 200 && r.body['text'] === '')
      whisper.text = 'thanks for watching my talk tomorrow'
      r = await stt(s.port)
      check('…but the same words inside a sentence are kept', r.body['text'] === 'thanks for watching my talk tomorrow')
      whisper.text = '[BLANK_AUDIO] hello there (laughter)'
      r = await stt(s.port)
      check('audio-event tags are stripped from Whisper output too', r.body['text'] === 'hello there')
      whisper.text = 'the quick brown fox'

      // The probe.
      r = await get(s.port, '/api/stt/check')
      check('/api/stt/check round-trips a second of silence through Whisper', r.status === 200 && r.body['ok'] === true && /Systran\/faster-whisper-small/.test(String(r.body['detail'])), JSON.stringify(r.body))
      whisper.fail = true
      r = await get(s.port, '/api/stt/check')
      check('/api/stt/check reports a failing Whisper with its own words', r.status === 502 && /model load failed/.test(String(r.body['error'])))
      whisper.fail = false

      // Speaking: Kokoro first, ElevenLabs behind it.
      let t = await get(s.port, '/api/tts?as=jarvis&text=hello%20there')
      check('/api/tts with TTS_PROVIDER=local is voiced by Kokoro', t.status === 200 && t.headers.get('x-tts-provider') === 'kokoro' && t.bytes > 0, `${t.status} ${t.headers.get('x-tts-provider')}`)
      check('ElevenLabs TTS was not asked while Kokoro answers', !eleven.seen.some(x => x.url.startsWith('/v1/text-to-speech/')))
      kokoro.fail = true
      t = await get(s.port, '/api/tts?as=jarvis&text=hello%20there')
      check('with Kokoro failing, /api/tts falls back to ElevenLabs', t.status === 200 && t.headers.get('x-tts-provider') === 'elevenlabs' && t.bytes > 0)
      kokoro.fail = false

      // Thinking: the tool loop against a local, keyless Ollama, searching through SearXNG.
      const c = await fetch(`http://127.0.0.1:${s.port}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Search the web for touchsphere and tell me what you found.' }] }),
      })
      const cb = await c.json() as { reply?: string; tools?: string[]; by?: string; model?: string }
      check('/api/chat answers through the local Ollama', c.status === 200 && /Pong/.test(cb.reply ?? ''), JSON.stringify(cb).slice(0, 300))
      check('the model\'s web_search tool call was run', Array.isArray(cb.tools) && cb.tools.includes('web_search'))
      check('the reply came from the primary model, not a fallback', cb.by === undefined && cb.model === 'qwen3:8b')
      const chats = ollama.seen.filter(x => x.url === '/api/chat')
      check('Ollama was called twice (tool round, then reply)', chats.length === 2, String(chats.length))
      check('no Authorization header went to the local Ollama', chats.every(x => !x.headers['authorization']))
      const first = JSON.parse(chats[0]!.body.toString('utf8')) as { model: string; tools?: unknown[]; options?: { num_ctx?: number } }
      check('the request carried the tool schemas and the 32k context', (first.tools?.length ?? 0) > 20 && first.options?.num_ctx === 32768, `tools=${first.tools?.length} num_ctx=${first.options?.num_ctx}`)
      const second = JSON.parse(chats[1]!.body.toString('utf8')) as { messages: Array<{ role: string; content: string }> }
      const toolMsg = second.messages.find(m => m.role === 'tool')
      check('the search went to SearXNG, not the hosted search, and its result reached the model',
        searx.seen.length > 0 && !!toolMsg && /TouchSphere test page/.test(toolMsg.content) && /Results from searxng/.test(toolMsg.content), toolMsg?.content.slice(0, 200))

      const el = await get(s.port, '/api/system/check/elevenlabs')
      check('/api/system/check/elevenlabs probes the (fake) account', el.status === 200 && el.body['tier'] === 'free')
    } finally { await s.stop() }

    // ── B. Local only — no cloud keys at all ──
    console.log('\nB. local only, no cloud keys')
    for (const f of fakes) { f.seen.length = 0; f.fail = false }
    s = await boot({ WHISPER_URL: whisper.url, KOKORO_URL: kokoro.url, TTS_PROVIDER: 'local', OLLAMA_URL: ollama.url, SEARXNG_URL: searx.url })
    try {
      const dbg = await get(s.port, '/api/system/debug')
      const chains = dbg.body['chains'] as Record<string, string>
      check('STT chain is Whisper alone', chains['stt'] === `whisper (local, ${whisper.url})`, chains['stt'])
      check('TTS chain is Kokoro then espeak, no cloud link', chains['tts'] === 'kokoro (local) → espeak (local) (TTS_PROVIDER=local)', chains['tts'])
      check('ElevenLabs reads as not set', (dbg.body['config'] as Record<string, boolean>)['ELEVENLABS_API_KEY'] === false)
      let r = await stt(s.port)
      check('/api/stt works with no ElevenLabs key', r.status === 200 && r.body['provider'] === 'whisper' && r.body['text'] === 'the quick brown fox')
      whisper.fail = true
      r = await stt(s.port)
      check('with Whisper failing and no cloud key, /api/stt 502s naming only Whisper', r.status === 502 && JSON.stringify(r.body['tried']) === '["whisper"]', JSON.stringify(r.body))
      whisper.fail = false
      const el = await get(s.port, '/api/system/check/elevenlabs')
      check('the ElevenLabs check says the cloud is off, not that voice is disabled', el.status === 502 && /cloud voice is off/.test(String(el.body['error'])), String(el.body['error']))
      const t = await get(s.port, '/api/tts?as=jarvis&text=hello')
      check('/api/tts is voiced by Kokoro', t.status === 200 && t.headers.get('x-tts-provider') === 'kokoro')
    } finally { await s.stop() }

    // ── C. As it was before Whisper existed — nothing must have changed ──
    console.log('\nC. the pre-Whisper configuration (ElevenLabs only)')
    for (const f of fakes) { f.seen.length = 0; f.fail = false }
    s = await boot({ ELEVENLABS_API_KEY: EL_KEY, ELEVENLABS_API_URL: eleven.url, KOKORO_URL: kokoro.url, OLLAMA_URL: ollama.url })
    try {
      const dbg = await get(s.port, '/api/system/debug')
      const chains = dbg.body['chains'] as Record<string, string>
      check('STT chain is ElevenLabs alone', chains['stt'] === 'elevenlabs (cloud)', chains['stt'])
      check('TTS chain keeps ElevenLabs ahead of Kokoro by default', chains['tts'] === 'elevenlabs (cloud) → kokoro (local) → espeak (local)', chains['tts'])
      const r = await stt(s.port)
      check('/api/stt goes to Scribe as before', r.status === 200 && r.body['provider'] === 'elevenlabs' && r.body['text'] === 'the quick brown fox via scribe')
      check('Whisper was never asked', whisper.seen.length === 0)
      const chk = await get(s.port, '/api/stt/check')
      check('/api/stt/check explains that hearing goes to the cloud', chk.status === 502 && /WHISPER_URL not set/.test(String(chk.body['error'])))
      const t = await get(s.port, '/api/tts?as=jarvis&text=hello')
      check('/api/tts is voiced by ElevenLabs by default', t.status === 200 && t.headers.get('x-tts-provider') === 'elevenlabs')
      const s2 = await get(s.port, '/api/tts?as=jarvis&text=hello%20again')
      check('a pinned STT_PROVIDER is not needed for that', s2.status === 200)
    } finally { await s.stop() }

    // ── D. Nothing configured — say so, once, clearly ──
    console.log('\nD. no speech-to-text provider at all')
    s = await boot({ OLLAMA_URL: ollama.url })
    try {
      const r = await stt(s.port)
      check('/api/stt answers 500 naming both ways to fix it', r.status === 500 && /WHISPER_URL/.test(String(r.body['error'])) && /ELEVENLABS_API_KEY/.test(String(r.body['error'])), JSON.stringify(r.body))
      const dbg = await get(s.port, '/api/system/debug')
      check('/api/system/debug carries the warning', ((dbg.body['warnings'] as string[]) ?? []).some(w => /No speech-to-text provider/.test(w)))
      check('the STT chain reads "none"', /^none/.test((dbg.body['chains'] as Record<string, string>)['stt'] ?? ''))
    } finally { await s.stop() }
  } finally {
    await Promise.all(fakes.map(f => f.close()))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('\nlocal-ai-test crashed:', err instanceof Error ? err.stack ?? err.message : err)
  process.exit(2)
})
