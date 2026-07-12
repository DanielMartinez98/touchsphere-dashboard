import { useEffect, useRef } from 'react'
import type { AppMode } from '../../hooks/useAppMode'
import { LIVE2D_MODEL_URL, type AvatarStatus } from '../../hooks/useAvatar'
import { getMouthLevel } from '../../utils/lipsync'

// Live2D avatar — a 2D rigged model (.moc3), the format VTubers actually use.
//
// Everything here is loaded lazily and on demand: the Cubism Core runtime is
// injected as a <script> only when this component mounts, and PIXI + the Live2D
// binding are dynamic imports. With the avatar setting off, none of it is
// fetched — which is the whole point of keeping the sphere as the default.
//
// Lip-sync reuses utils/lipsync.ts unchanged: it hands back a 0..1 level from
// the TTS waveform, which we write to ParamMouthOpenY (the parameter the model's
// own manifest nominates in its "LipSync" group).

interface Props {
  mode: AppMode
  voiceListening: boolean
  voiceSpeaking: boolean
  voiceVolume: number
  onStatus?: (status: AvatarStatus, detail?: string) => void
  onFps?: (fps: number) => void
}

/** Cubism Core is a proprietary Live2D runtime that only ships as a global script. */
const CUBISM_CORE_SRC = '/live2dcubismcore.min.js'

let corePromise: Promise<void> | null = null
function loadCubismCore(): Promise<void> {
  if (corePromise) return corePromise
  corePromise = new Promise<void>((resolve, reject) => {
    if ('Live2DCubismCore' in window) return resolve()
    const el = document.createElement('script')
    el.src = CUBISM_CORE_SRC
    el.async = true
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`failed to load ${CUBISM_CORE_SRC}`))
    document.head.appendChild(el)
  })
  // Cache the success, but never the failure: a rejected promise kept here would
  // mean one bad fetch (dev server not yet serving the file, a flaky network)
  // poisons every later attempt for the life of the page, so toggling the avatar
  // off and on again could never recover.
  corePromise.catch(() => { corePromise = null })
  return corePromise
}

// The model's mouth parameter, per its own model3.json "LipSync" group.
const PARAM_MOUTH = 'ParamMouthOpenY'
// Sways the body so she isn't statue-still between replies.
const PARAM_BODY_Y = 'ParamBodyAngleY'

/** How much to fill the screen. Raise for a closer, more VTuber-like crop. */
const ZOOM = 1.3

// The binding types `coreModel` as a bare `object` — it's Cubism's own type and
// isn't re-exported. We only ever poke one method on it.
interface CubismCoreModel {
  setParameterValueById(id: string, value: number): void
}

export default function Live2DAvatar({ voiceListening, voiceSpeaking, voiceVolume, onStatus, onFps }: Props) {
  const mountRef       = useRef<HTMLDivElement>(null)
  const voiceListenRef = useRef(voiceListening)
  const voiceSpeakRef  = useRef(voiceSpeaking)
  const voiceVolRef    = useRef(voiceVolume)
  const onStatusRef    = useRef(onStatus)
  const onFpsRef       = useRef(onFps)

  useEffect(() => { voiceListenRef.current = voiceListening }, [voiceListening])
  useEffect(() => { voiceSpeakRef.current  = voiceSpeaking  }, [voiceSpeaking])
  useEffect(() => { voiceVolRef.current    = voiceVolume    }, [voiceVolume])
  useEffect(() => { onStatusRef.current    = onStatus       }, [onStatus])
  useEffect(() => { onFpsRef.current       = onFps          }, [onFps])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let disposed = false
    let cleanupScene: (() => void) | null = null

    void (async () => {
      try {
        onStatusRef.current?.('loading')

        await loadCubismCore()
        const PIXI = await import('pixi.js')
        const { Live2DModel } = await import('pixi-live2d-display-lipsyncpatch/cubism4')
        if (disposed) return

        // The binding drives models off PIXI's shared ticker; it has to be told
        // which Ticker class to use when PIXI is bundled rather than global.
        Live2DModel.registerTicker(PIXI.Ticker)

        const app = new PIXI.Application({
          width: mount.clientWidth,
          height: mount.clientHeight,
          backgroundAlpha: 0,
          antialias: true,
          // The Pi's GPU is the constraint. A full-density buffer of an 8192px
          // texture is the fastest way to tank the framerate.
          resolution: Math.min(window.devicePixelRatio, 1.5),
          autoDensity: true,
        })
        const canvas = app.view as unknown as HTMLCanvasElement
        mount.appendChild(canvas)

        const model = await Live2DModel.from(LIVE2D_MODEL_URL, { autoInteract: false })
        if (disposed) {
          model.destroy()
          app.destroy(true)
          return
        }
        app.stage.addChild(model)

        // Fit to the model's *drawn* bounds, not its canvas height — a Live2D
        // canvas usually has generous empty margins, so scaling by internalModel
        // .height leaves the character small and floating. Measure the real art,
        // scale that to the screen, then recentre on it.
        const fit = () => {
          const W = mount.clientWidth
          const H = mount.clientHeight
          const cx = W / 2
          const cy = H / 2

          model.anchor.set(0.5, 0.5)
          model.scale.set(1)
          model.position.set(cx, cy)

          const raw = model.getBounds()
          if (raw.height === 0 || raw.width === 0) return
          // Fit to height, but never so wide that she overruns the corner widgets.
          // ZOOM compensates for the model's invisible drawables — they inflate
          // getBounds(), so a pure bounds-fit leaves the character undersized.
          const scale = Math.min((H * 0.96) / raw.height, (W * 1.1) / raw.width) * ZOOM
          model.scale.set(scale)

          // Re-measure at the final scale and nudge so the artwork's centre —
          // rather than the canvas's — lands in the middle of the screen.
          const b = model.getBounds()
          model.position.set(
            cx + (cx - (b.x + b.width / 2)),
            cy + (cy - (b.y + b.height / 2)),
          )
        }
        fit()

        // ── Lip sync ────────────────────────────────────────────────────────
        // Writing to coreModel from an outside ticker doesn't stick: Cubism
        // finalises parameters inside internalModel.update(), so a value set
        // after that call is overwritten before it's ever drawn. Wrapping
        // motionManager.update puts our write *inside* that cycle, after any
        // motion/expression has had its say but before the frame is committed.
        const im = model.internalModel
        const core = im.coreModel as CubismCoreModel
        const motionManager = im.motionManager
        const originalUpdate = motionManager.update.bind(motionManager)
        motionManager.update = (...args: Parameters<typeof originalUpdate>) => {
          const result = originalUpdate(...args)
          const mouth = voiceSpeakRef.current ? getMouthLevel() : 0
          core.setParameterValueById(PARAM_MOUTH, mouth)
          return result
        }

        // Blinking is handled for us — the model3.json declares an EyeBlink
        // group, and the binding drives it automatically.

        // ── Touch tracking ──────────────────────────────────────────────────
        // focus() turns a screen point into head/eye angles for us.
        const handlePointer = (e: MouseEvent | TouchEvent) => {
          const x = 'touches' in e ? e.touches[0]?.clientX : e.clientX
          const y = 'touches' in e ? e.touches[0]?.clientY : e.clientY
          if (x === undefined || y === undefined) return
          model.focus(x, y)
        }
        window.addEventListener('mousemove', handlePointer)
        window.addEventListener('touchmove', handlePointer, { passive: true })

        // ── Idle breathing + a lean toward the user while listening ─────────
        let t = 0
        let frames = 0
        let fpsWindowStart = performance.now()
        const tick = () => {
          t += app.ticker.deltaMS / 1000
          const listening = voiceListenRef.current
          const vol = voiceVolRef.current
          // A gentle sway so she isn't statue-still, plus a subtle lift when
          // she's listening to you.
          const breathe = Math.sin(t * 1.6) * 0.4
          core.setParameterValueById(PARAM_BODY_Y, breathe + (listening ? vol * 2 : 0))

          frames++
          const now = performance.now()
          if (now - fpsWindowStart >= 1000) {
            onFpsRef.current?.(Math.round((frames * 1000) / (now - fpsWindowStart)))
            frames = 0
            fpsWindowStart = now
          }
        }
        app.ticker.add(tick)

        const handleResize = () => {
          app.renderer.resize(mount.clientWidth, mount.clientHeight)
          fit()
        }
        window.addEventListener('resize', handleResize)

        onStatusRef.current?.('ready')

        cleanupScene = () => {
          window.removeEventListener('mousemove', handlePointer)
          window.removeEventListener('touchmove', handlePointer)
          window.removeEventListener('resize', handleResize)
          app.ticker.remove(tick)
          model.destroy()
          app.destroy(true)
          if (mount.contains(canvas)) mount.removeChild(canvas)
        }
      } catch (err) {
        if (disposed) return
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('[live2d] failed to load model:', msg)
        onStatusRef.current?.('error', msg.slice(0, 160))
      }
    })()

    return () => {
      disposed = true
      cleanupScene?.()
    }
  }, [])

  return (
    <div
      ref={mountRef}
      className="absolute inset-0 pointer-events-none"
      aria-hidden="true"
    />
  )
}
