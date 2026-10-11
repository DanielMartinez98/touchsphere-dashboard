// Proves the prompt improver's options — with no GPU and no language model.
//
//   npm run test:prompt-options        (from server/)
//
// The REAL server is booted (src/index.ts, as `npm run dev` runs it) with an
// Ollama and a ComfyUI stood in for by small HTTP servers in this process. The
// fake Ollama records the system prompt of every rewrite it is asked for, which
// is the one thing that says which option actually reached the model; the fake
// ComfyUI answers nothing useful, so each render fails right after its prompt
// is rewritten, which is all this needs.
//
// What it asks, in the order a person would: create options in Settings, edit
// and rename them, choose one from the Draw panel, draw with it, draw with a
// different one named in the request, delete the one in use, fill the list,
// and hand the server a corrupted store. Throughout, the original must never
// change.

import http from 'http'
import net from 'net'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { spawn, type ChildProcess } from 'child_process'

const SERVER_DIR = path.resolve(__dirname, '..')

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else    { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

// ── Fakes ────────────────────────────────────────────────────────────────────

interface Chat { system: string; user: string }

async function listen(handler: http.RequestListener): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) }
}

function body(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
  })
}

/** An Ollama that writes down what it was told and answers with the request plus a little. */
async function fakeOllama(chats: Chat[]) {
  return listen(async (req, res) => {
    const text = await body(req)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'test-model' }] })); return }
    if (req.url !== '/api/chat') { res.statusCode = 404; res.end('{}'); return }
    const j = JSON.parse(text) as { messages: { role: string; content: string }[] }
    const system = j.messages.find(m => m.role === 'system')?.content ?? ''
    const user = j.messages.find(m => m.role === 'user')?.content ?? ''
    chats.push({ system, user })
    // Every word of the request kept, commas so a tag-style guide accepts it.
    res.end(JSON.stringify({ message: { content: `${user}, soft evening light, detailed background` } }))
  })
}

/** A ComfyUI that is there and useless: every render fails after the improver has run. */
async function fakeComfy() {
  return listen((_req, res) => { res.statusCode = 500; res.setHeader('content-type', 'application/json'); res.end('{"error":"fake"}') })
}

// ── The real server ──────────────────────────────────────────────────────────

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>(r => s.close(() => r()))
  return port
}

async function boot(env: Record<string, string>, cache: string) {
  const port = await freePort()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-prompt-options-'))
  let out = ''
  // cwd in a temp dir so dotenv cannot read a developer's real .env.
  const child: ChildProcess = spawn(process.execPath, [
    '-r', path.join(SERVER_DIR, 'node_modules/ts-node/register/transpile-only'),
    path.join(SERVER_DIR, 'src/index.ts'),
  ], {
    cwd: tmp,
    env: {
      PATH: process.env['PATH'] ?? '', HOME: tmp,
      TS_NODE_PROJECT: path.join(SERVER_DIR, 'tsconfig.json'),
      NODE_ENV: 'development', PORT: String(port), CACHE_DIR: cache,
      AUDIO_DIR: path.join(tmp, 'audio'), AVATAR_DIR: path.join(tmp, 'avatar'),
      OPENWEATHER_API_KEY: 'test-key-not-real', DEFAULT_LAT: '0', DEFAULT_LON: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
  child.stderr?.on('data', (d: Buffer) => { out += d.toString() })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${out.slice(-2000)}`)
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  return {
    base: `http://127.0.0.1:${port}`,
    log: () => out,
    stop: () => new Promise<void>(resolve => {
      child.once('exit', () => { fs.rmSync(tmp, { recursive: true, force: true }); resolve() })
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }),
  }
}

interface View {
  template: string; preview: string; active: string; activeName: string
  options: { id: string; name: string; template: string }[]
  maxOptions: number; created?: string; error?: string
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const chats: Chat[] = []
  const ollama = await fakeOllama(chats)
  const comfy = await fakeComfy()
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-prompt-options-cache-'))
  const s = await boot({
    COMFYUI_URL: comfy.url, OLLAMA_URL: ollama.url, OLLAMA_IMAGE_URL: ollama.url,
    OLLAMA_MODEL: 'test-model', OLLAMA_IMAGE_MODEL: 'test-model',
  }, cache)

  const call = async (method: string, p: string, b?: unknown): Promise<{ status: number; j: View }> => {
    const res = await fetch(`${s.base}${p}`, {
      method, headers: b === undefined ? {} : { 'content-type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    })
    return { status: res.status, j: await res.json().catch(() => ({})) as View }
  }

  // Every server event, to see the panel being told and the render naming its option.
  const events: { event: string; data: string }[] = []
  const ctrl = new AbortController()
  void (async () => {
    try {
      const res = await fetch(`${s.base}/api/system/events`, { signal: ctrl.signal })
      const reader = res.body!.getReader()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += Buffer.from(value).toString('utf8')
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          const ev = /^event: (.+)$/m.exec(frame)?.[1]
          const data = /^data: (.*)$/m.exec(frame)?.[1] ?? ''
          if (ev) events.push({ event: ev, data })
        }
      }
    } catch { /* aborted at the end */ }
  })()
  await new Promise(r => setTimeout(r, 300))

  /** Wait for the fake Ollama to be asked something about `word`. */
  const chatAbout = async (word: string): Promise<Chat | undefined> => {
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      const c = chats.find(x => x.user.includes(word))
      if (c) return c
      await new Promise(r => setTimeout(r, 100))
    }
    return undefined
  }

  try {
    console.log('\nSettings: creating and editing options')
    let r = await call('GET', '/api/image/prompter')
    const original = r.j.template
    check('a fresh box has no options and uses the original', r.status === 200 && r.j.options.length === 0 && r.j.active === 'original' && r.j.activeName === 'Original', JSON.stringify({ active: r.j.active, n: r.j.options?.length }))
    check('the limit is eight besides the original', r.j.maxOptions === 8)

    r = await call('POST', '/api/image/prompter/options', {})
    const b = r.j.created ?? ''
    check('a new option is called "Option B" and starts as a copy of the original',
      r.status === 201 && r.j.options[0]?.name === 'Option B' && r.j.options[0]?.template === original, JSON.stringify(r.j.options))

    r = await call('PATCH', `/api/image/prompter/options/${b}`, { template: 'MARKER-B for {{style}}. Reply with the prompt only.' })
    check('changing the option changes the option', r.status === 200 && r.j.options[0]?.template.startsWith('MARKER-B'))
    check('…and leaves the original exactly as it was', r.j.template === original)

    r = await call('PATCH', `/api/image/prompter/options/${b}`, { name: 'Cinematic' })
    check('an option can be renamed', r.status === 200 && r.j.options[0]?.name === 'Cinematic')
    r = await call('PATCH', `/api/image/prompter/options/${b}`, { name: 'original' })
    check('"Original" is refused as a name, with a sentence', r.status === 400 && /name of the original/.test(r.j.error ?? ''), r.j.error)

    r = await call('POST', '/api/image/prompter/options', {})
    const c = r.j.created ?? ''
    check('a renamed option frees its letter: the next one is "Option B" again', r.j.options[1]?.name === 'Option B', JSON.stringify(r.j.options.map(o => o.name)))
    r = await call('PATCH', `/api/image/prompter/options/${c}`, { name: 'cinematic' })
    check('two options cannot share a name', r.status === 400 && /already an option/.test(r.j.error ?? ''), r.j.error)
    await call('PATCH', `/api/image/prompter/options/${c}`, { template: 'MARKER-C for {{style}}. Reply with the prompt only.' })
    r = await call('PATCH', `/api/image/prompter/options/${c}`, { template: '   ' })
    check('cleared instructions fall back to the house default, as the original does', r.j.options[1]?.template.startsWith('You rewrite a short image request'))
    await call('PATCH', `/api/image/prompter/options/${c}`, { template: 'MARKER-C for {{style}}. Reply with the prompt only.' })

    console.log('\nDraw panel: choosing one')
    r = await call('POST', '/api/image/prompter/active', { id: b })
    check('choosing an option makes it the one in use', r.status === 200 && r.j.active === b && r.j.activeName === 'Cinematic')
    check('the preview shows what the chosen option will be told', r.j.preview.startsWith('MARKER-B for '), r.j.preview.slice(0, 60))
    r = await call('POST', '/api/image/prompter/active', { id: 'opt-ffffff' })
    check('choosing one that does not exist is refused', r.status === 400)
    const told = events.some(e => e.event === 'image-prompter')
    check('every open screen is told the improver changed', told, events.map(e => e.event).join(','))

    console.log('\nDrawing with them')
    let g = await call('POST', '/api/image/generate', { prompt: 'a red fox', improve: true })
    check('a picture can be asked for', g.status === 202, JSON.stringify(g.j).slice(0, 200))
    let chat = await chatAbout('a red fox')
    check('with nothing named, the improver is told the option chosen in the panel', !!chat && chat.system.startsWith('MARKER-B for '), chat?.system.slice(0, 80))
    await new Promise(r2 => setTimeout(r2, 300))
    const said = events.some(e => e.event === 'image' && /with \\"Cinematic\\"/.test(e.data))
    check('the render says which option it is rewriting with', said)

    g = await call('POST', '/api/image/generate', { prompt: 'a blue owl', improve: true, promptOption: 'original' })
    chat = await chatAbout('a blue owl')
    check('a picture can ask for the original by name, whatever is chosen', !!chat && chat.system.startsWith('You rewrite a short image request'), chat?.system.slice(0, 80))

    g = await call('POST', '/api/image/generate', { prompt: 'a green frog', improve: true, promptOption: c })
    chat = await chatAbout('a green frog')
    check('…or another option by its id', !!chat && chat.system.startsWith('MARKER-C for '), chat?.system.slice(0, 80))

    g = await call('POST', '/api/image/generate', { prompt: 'a grey wolf', improve: true, promptOption: 'opt-abcdef' })
    chat = await chatAbout('a grey wolf')
    check('an option that no longer exists draws with the original rather than failing', g.status === 202 && !!chat && chat.system.startsWith('You rewrite a short image request'))

    g = await call('POST', '/api/image/generate', { prompt: 'a black cat', improve: false, promptOption: c })
    await new Promise(r2 => setTimeout(r2, 1500))
    check('with Improve off, no option is asked anything', !chats.some(x => x.user.includes('a black cat')))

    const prompts = await fetch(`${s.base}/api/prompts`).then(x => x.json()) as { prompts: { id: string; label: string; text: string }[] }
    const imp = prompts.prompts.find(p => p.id === 'improver')
    check('the Prompts tab shows the option in use', !!imp && imp.label.includes('Cinematic') && imp.text.startsWith('MARKER-B'), imp?.label)

    console.log('\nDeleting, and the limit')
    r = await call('DELETE', `/api/image/prompter/options/${b}`)
    check('deleting the option in use puts the original back in use', r.status === 200 && r.j.active === 'original' && r.j.options.length === 1)
    r = await call('DELETE', `/api/image/prompter/options/${b}`)
    check('deleting it again is a 404', r.status === 404)
    r = await call('POST', '/api/image/prompter/options', {})
    check('default names never repeat: with "Option B" taken the next is "Option C"', r.j.options[1]?.name === 'Option C', JSON.stringify(r.j.options.map(o => o.name)))
    await call('DELETE', `/api/image/prompter/options/${c}`)
    r = await call('POST', '/api/image/prompter/options', {})
    check('a deleted letter is used again: "Option B" comes back', r.j.options.some(o => o.name === 'Option B') && r.j.options.length === 2, JSON.stringify(r.j.options.map(o => o.name)))
    for (let i = 0; i < 6; i++) r = await call('POST', '/api/image/prompter/options', {})
    check('eight options can exist', r.status === 201 && r.j.options.length === 8, String(r.j.options?.length))
    r = await call('POST', '/api/image/prompter/options', {})
    check('a ninth is refused with a sentence', r.status === 400 && /at most 8/.test(r.j.error ?? ''), r.j.error)
    r = await call('GET', '/api/image/prompter')
    check('the original never changed', r.j.template === original)

    console.log('\nA damaged store')
    const file = path.join(cache, 'image-prompter.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(file, JSON.stringify({
      ...stored,
      options: [
        { id: 'opt-111111', name: 'Kept', template: 'KEEP' },
        { id: 'opt-111111', name: 'Duplicate id', template: 'X' },
        { id: 'not-an-id', name: 'Bad id', template: 'X' },
        { id: 'opt-222222', name: '', template: '' },
        'nonsense',
      ],
      active: 'opt-999999',
    }))
    r = await call('GET', '/api/image/prompter')
    check('duplicate and malformed options are dropped', r.j.options.length === 2 && r.j.options[0]?.name === 'Kept', JSON.stringify(r.j.options))
    check('a nameless one is given a name, and empty instructions the default', !!r.j.options[1]?.name && r.j.options[1]?.template.startsWith('You rewrite'))
    check('a choice pointing at nothing reads as the original', r.j.active === 'original')
  } finally {
    ctrl.abort()
    await s.stop()
    await ollama.close()
    await comfy.close()
    fs.rmSync(cache, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('\nprompt-options-test crashed:', err instanceof Error ? err.stack ?? err.message : err)
  process.exit(2)
})
