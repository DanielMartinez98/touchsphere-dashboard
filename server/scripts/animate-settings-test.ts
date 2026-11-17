// Proves the Animate settings reach the AniSora graph — with no GPU.
//
//   npm run test:animate          (from server/)
//
// A fake ComfyUI in this process records the prompts it is sent. Each case
// saves knobs for the AniSora style exactly as the Animate sheet does
// (setParamsFor), queues a clip from a gallery picture (startImage), and reads
// the shot prompt back: steps, the expert switch, cfg, shift, sampler,
// scheduler, size, frames per shot and the seed. The fake then fails the
// render, which is all this needs.

import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'

const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-animate-'))
process.env['CACHE_DIR'] = cache

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else    { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>
const prompts: Graph[] = []
let waiting: ((g: Graph) => void) | null = null

const FILES = [
  'Wan2_2-I2V_AniSoraV3_2_HIGH_14B_fp8_e4m3fn_scaled_KJ.safetensors',
  'Wan2_2-I2V_AniSoraV3_2_LOW_14B_fp8_e4m3fn_scaled_KJ.safetensors',
  'umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'wan_2.1_vae.safetensors',
]

function fake(req: http.IncomingMessage, res: http.ServerResponse): void {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    const url = req.url ?? ''
    const json = (o: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) }
    if (url.startsWith('/object_info/')) {
      const cls = url.slice('/object_info/'.length)
      return json({ [cls]: { input: { required: {
        unet_name: [FILES], clip_name: [FILES], vae_name: [FILES],
        sampler_name: [['euler', 'uni_pc', 'dpmpp_2m']], scheduler: [['simple', 'normal', 'beta']],
      } } } })
    }
    if (url.startsWith('/upload/image')) return json({ name: 'src.png', subfolder: '', type: 'input' })
    if (url === '/prompt') {
      const g = (JSON.parse(body) as { prompt: Graph }).prompt
      prompts.push(g)
      waiting?.(g)
      res.statusCode = 400
      return json({ error: { message: 'fake ComfyUI draws nothing' } })
    }
    if (url === '/queue') return json({ queue_running: [], queue_pending: [] })
    if (url === '/system_stats') return json({ devices: [{ vram_free: 24e9, vram_total: 24e9 }] })
    return json({})
  })
}

/** A 2:3 PNG, which is all the gallery needs. */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0
  const raw = Buffer.alloc((w + 1) * h)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

async function main(): Promise<void> {
  const server = http.createServer(fake)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  process.env['COMFYUI_URL'] = `http://127.0.0.1:${port}`

  const image = await import('../src/image')
  const params = await import('../src/image-params')
  const style = 'wf:anisora-v3.2'
  const src = image.addUploadedImage(png(64, 96), 'test picture')

  const shot = async (seconds: number): Promise<Graph> => {
    const got = new Promise<Graph>((resolve, reject) => {
      waiting = resolve
      setTimeout(() => reject(new Error('no prompt reached ComfyUI in 30 s')), 30_000)
    })
    image.startImage({ prompt: 'she waves', source: src.id, model: style, seconds })
    const g = await got
    waiting = null
    return g
  }
  const of = (g: Graph, cls: string) => Object.values(g).filter(n => n.class_type === cls)
  const high = (g: Graph) => of(g, 'KSamplerAdvanced').find(n => n.inputs['add_noise'] === 'enable')!
  const low  = (g: Graph) => of(g, 'KSamplerAdvanced').find(n => n.inputs['add_noise'] === 'disable')!

  console.log('Defaults (nothing saved): the graph as it was')
  let g = await shot(3)
  check('8 steps on both experts', high(g).inputs['steps'] === 8 && low(g).inputs['steps'] === 8)
  check('switch after step 3', high(g).inputs['end_at_step'] === 3 && low(g).inputs['start_at_step'] === 3)
  check('cfg 1, shift 5', high(g).inputs['cfg'] === 1 && of(g, 'ModelSamplingSD3').every(n => n.inputs['shift'] === 5))
  check('euler / simple', high(g).inputs['sampler_name'] === 'euler' && low(g).inputs['scheduler'] === 'simple')
  const wan = of(g, 'WanImageToVideo')[0]!.inputs
  check('768×1152 for a portrait', wan['width'] === 768 && wan['height'] === 1152, `${wan['width']}×${wan['height']}`)
  check('3 s = 49 frames in one shot', wan['length'] === 49, String(wan['length']))

  console.log('Saved settings')
  params.setParamsFor(style, {
    steps: 12, cfg: 3.5, shift: 7.5, sampler: 'uni_pc', scheduler: 'beta',
    videoRes: 576, shotSeconds: 3, seedMode: 'fixed', seed: 1234,
  })
  g = await shot(5)
  check('12 steps on both experts', high(g).inputs['steps'] === 12 && low(g).inputs['steps'] === 12)
  check('auto switch keeps the 3/8 share (12 → 5)', high(g).inputs['end_at_step'] === 5 && low(g).inputs['start_at_step'] === 5,
    String(high(g).inputs['end_at_step']))
  check('cfg 3.5 on both', high(g).inputs['cfg'] === 3.5 && low(g).inputs['cfg'] === 3.5)
  check('shift 7.5 on both experts', of(g, 'ModelSamplingSD3').every(n => n.inputs['shift'] === 7.5))
  check('uni_pc / beta', high(g).inputs['sampler_name'] === 'uni_pc' && low(g).inputs['scheduler'] === 'beta')
  const wan2 = of(g, 'WanImageToVideo')[0]!.inputs
  check('576p portrait = 576×864', wan2['width'] === 576 && wan2['height'] === 864, `${wan2['width']}×${wan2['height']}`)
  check('5 s in 3 s shots → first shot 2.5 s = 41 frames', wan2['length'] === 41, String(wan2['length']))
  check('fixed seed 1234', high(g).inputs['noise_seed'] === 1234)

  console.log('A typed switch, and one past the end')
  params.setParamsFor(style, { highSteps: 2 })
  g = await shot(3)
  check('switch at 2', high(g).inputs['end_at_step'] === 2 && low(g).inputs['start_at_step'] === 2)
  params.setParamsFor(style, { highSteps: 40 })
  g = await shot(3)
  check('switch past the end is kept inside the run (11 of 12)', high(g).inputs['end_at_step'] === 11)

  console.log('A sampler the box lacks')
  params.setParamsFor(style, { sampler: 'not_a_sampler', scheduler: 'nope' })
  g = await shot(3)
  check('falls back to euler / simple', high(g).inputs['sampler_name'] === 'euler' && high(g).inputs['scheduler'] === 'simple')

  console.log('Back to defaults (the sheet\'s reset)')
  params.setParamsFor(style, { steps: 0, highSteps: 0, cfg: 0, shift: 0, videoRes: 0, shotSeconds: 0, sampler: '', scheduler: '', seedMode: 'random' })
  g = await shot(3)
  check('8 steps, switch 3, cfg 1, shift 5, 768×1152',
    high(g).inputs['steps'] === 8 && high(g).inputs['end_at_step'] === 3 && high(g).inputs['cfg'] === 1
      && of(g, 'ModelSamplingSD3').every(n => n.inputs['shift'] === 5)
      && of(g, 'WanImageToVideo')[0]!.inputs['width'] === 768)

  console.log(`\n${passed} passed, ${failed} failed`)
  fs.rmSync(cache, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
