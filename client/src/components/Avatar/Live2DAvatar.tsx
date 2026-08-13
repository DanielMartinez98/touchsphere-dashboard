import { useEffect, useRef } from 'react'
import type { AppMode } from '../../hooks/useAppMode'
import type { AvatarStatus } from '../../hooks/useAvatar'
import { getMouthLevel } from '../../utils/lipsync'
import { onCue } from '../../utils/avatarCues'

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
  /** URL of the model3.json to load. Comes from the active assistant's profile. */
  modelUrl: string
  /** How close she sits to the camera. 1 = whole model fits on screen. */
  zoom: number
  /** Vertical shift as a fraction of screen height. Negative = up. */
  offsetY: number
  /** Follow the touch point with head and gaze. Default on.
   *
   *  Off for the Settings preview: there, every touch lands on a slider or a
   *  cue button right next to her, so tracking turns her head away from the
   *  camera exactly when you're trying to judge the expression you just fired.
   *  On the dashboard the same behaviour is the point — she looks at you. */
  trackPointer?: boolean
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

// The binding types `coreModel` as a bare `object` — it's Cubism's own type and
// isn't re-exported. We only ever poke these two methods on it.
interface CubismCoreModel {
  setParameterValueById(id: string, value: number): void
  getParameterValueById(id: string): number
}

export default function Live2DAvatar({ voiceListening, voiceSpeaking, voiceVolume, modelUrl, zoom, offsetY, trackPointer = true, onStatus, onFps }: Props) {
  const mountRef       = useRef<HTMLDivElement>(null)
  const voiceListenRef = useRef(voiceListening)
  const voiceSpeakRef  = useRef(voiceSpeaking)
  const voiceVolRef    = useRef(voiceVolume)
  const zoomRef        = useRef(zoom)
  const offsetYRef     = useRef(offsetY)
  const onStatusRef    = useRef(onStatus)
  const onFpsRef       = useRef(onFps)
  // In a ref, not the effect's deps: flipping tracking must not tear down and
  // reload the model (and with it the Cubism scene).
  const trackRef       = useRef(trackPointer)
  // Set once the model is on stage. Lets the framing effect below re-run the
  // fit without tearing down and rebuilding the whole PIXI scene.
  const refitRef       = useRef<(() => void) | null>(null)

  useEffect(() => { voiceListenRef.current = voiceListening }, [voiceListening])
  useEffect(() => { voiceSpeakRef.current  = voiceSpeaking  }, [voiceSpeaking])
  useEffect(() => { voiceVolRef.current    = voiceVolume    }, [voiceVolume])
  useEffect(() => { onStatusRef.current    = onStatus       }, [onStatus])
  useEffect(() => { onFpsRef.current       = onFps          }, [onFps])
  useEffect(() => { trackRef.current       = trackPointer   }, [trackPointer])

  // Live framing — dragging the sliders in Settings repositions her immediately.
  useEffect(() => {
    zoomRef.current    = zoom
    offsetYRef.current = offsetY
    refitRef.current?.()
  }, [zoom, offsetY])

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
        const { Live2DModel, MotionPriority } = await import('pixi-live2d-display-lipsyncpatch/cubism4')
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

        const model = await Live2DModel.from(modelUrl, { autoInteract: false })
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
          // The zoom multiplier also compensates for the model's invisible
          // drawables, which inflate getBounds() and leave a pure bounds-fit
          // undersized — hence a default above 1.
          const scale = Math.min((H * 0.96) / raw.height, (W * 1.1) / raw.width) * zoomRef.current
          model.scale.set(scale)

          // Re-measure at the final scale and nudge so the artwork's centre —
          // rather than the canvas's — lands where we want it. Zooming in on a
          // full-body model mostly wants to push her *down* (you're zooming
          // toward the face), which is what offsetY is for.
          const b = model.getBounds()
          model.position.set(
            cx + (cx - (b.x + b.width / 2)),
            cy + (cy - (b.y + b.height / 2)) + offsetYRef.current * H,
          )
        }
        fit()
        refitRef.current = fit

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
        let t = 0
        motionManager.update = (...args: Parameters<typeof originalUpdate>) => {
          const result = originalUpdate(...args)

          const mouth = voiceSpeakRef.current ? getMouthLevel() : 0
          core.setParameterValueById(PARAM_MOUTH, mouth)

          // A subtle sway, ADDED to whatever the model's idle motion already did
          // rather than replacing it — these models ship with real Idle motions,
          // and clobbering the body angle would fight them. Lifts a little while
          // she's listening to you.
          t += 1 / 60
          const listening = voiceListenRef.current
          const sway = Math.sin(t * 1.6) * 0.4 + (listening ? voiceVolRef.current * 2 : 0)
          core.setParameterValueById(PARAM_BODY_Y, core.getParameterValueById(PARAM_BODY_Y) + sway)

          return result
        }

        // Blinking is handled for us — the model3.json declares an EyeBlink
        // group, and the binding drives it automatically.

        // ── LLM cues ────────────────────────────────────────────────────────
        // A 2D rig can't wave on command, but playing one of its own authored
        // motions at the cue's moment reads as a reaction all the same — so
        // gestures map onto whatever non-Idle motion groups the model ships
        // (Miku: Tap / Flick / FlickUp). Face cues use the model's expression
        // list when it has one; with none (Miku), they no-op gracefully.
        const definitions =
          (motionManager as unknown as { definitions?: Record<string, unknown[] | undefined> }).definitions ?? {}
        const motionGroups = Object.keys(definitions)
          .filter(gp => gp.toLowerCase() !== 'idle' && (definitions[gp]?.length ?? 0) > 0)
        const GROUP_PREFERENCE: Record<string, string[]> = {
          wave:  ['Tap', 'TapBody'],
          nod:   ['Tap', 'TapBody'],
          bow:   ['Tap', 'TapBody'],
          shake: ['Flick', 'FlickDown'],
          think: ['Flick', 'FlickDown'],
          cheer: ['FlickUp', 'Flick'],
          jump:  ['FlickUp', 'Flick'],
          show:  ['FlickUp', 'Flick'],
          shoot: ['Tap', 'TapBody'],
        }
        const expressions =
          (motionManager as unknown as { expressionManager?: { definitions: unknown[] } }).expressionManager
        const offCue = onCue((cue) => {
          if (cue.kind === 'gesture') {
            const group = GROUP_PREFERENCE[cue.name]?.find(gp => motionGroups.includes(gp)) ?? motionGroups[0]
            // Random motion within the group; FORCE so it pre-empts the idle.
            if (group) void model.motion(group, undefined, MotionPriority.FORCE)
          } else if ((expressions?.definitions.length ?? 0) > 0) {
            // No name mapping — expression names are model-specific. A random
            // one still makes her face react at the moment the cue lands.
            void model.expression()
          }
        })

        // ── Touch tracking ──────────────────────────────────────────────────
        // focus() turns a screen point into head/eye angles for us.
        const handlePointer = (e: MouseEvent | TouchEvent) => {
          const x = 'touches' in e ? e.touches[0]?.clientX : e.clientX
          const y = 'touches' in e ? e.touches[0]?.clientY : e.clientY
          if (x === undefined || y === undefined) return
          // Tracking off: aim her at the centre of her own frame instead of
          // ignoring the event. focus() holds its last target, so simply
          // skipping would freeze her mid-turn wherever the last touch left
          // her — the opposite of facing the camera.
          if (!trackRef.current) {
            const b = mount.getBoundingClientRect()
            model.focus(b.left + b.width / 2, b.top + b.height / 2)
            return
          }
          model.focus(x, y)
        }
        window.addEventListener('mousemove', handlePointer)
        window.addEventListener('touchmove', handlePointer, { passive: true })

        // Idle motion, blinking and physics all come from the model's own
        // manifest; the sway and lip-sync ride along inside the update wrapper
        // above (writes from out here don't survive Cubism's update cycle — the
        // same trap the lip-sync had to work around). All that's left is the
        // framerate probe.
        let frames = 0
        let fpsWindowStart = performance.now()
        const tick = () => {
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
          refitRef.current = null
          offCue()
          window.removeEventListener('mousemove', handlePointer)
          window.removeEventListener('touchmove', handlePointer)
          window.removeEventListener('resize', handleResize)
          app.ticker.remove(tick)

          // ORDER IS LOAD-BEARING. Live2DModel registers itself on PIXI's SHARED
          // ticker (not app.ticker), so destroying it while autoUpdate is still on
          // leaves the shared ticker calling update() on a model whose internals
          // are gone — "Cannot read properties of undefined (reading 'update')",
          // which escapes to the ErrorBoundary and takes the whole page down.
          // Switching model or assistant runs this path, so it has to be exact:
          //   1. unhook from the shared ticker
          //   2. take it off the stage
          //   3. destroy the model (releases the Cubism WebGL renderer)
          //   4. only then tear down the PIXI app and its GL context
          try {
            // `autoUpdate` is installed at runtime by Live2DModel.registerTicker
            // but is missing from the fork's type declarations, hence the cast.
            (model as unknown as { autoUpdate: boolean }).autoUpdate = false
            app.stage.removeChild(model)
            model.destroy()
          } catch (err) {
            console.warn('[live2d] model teardown:', err)
          }

          // Teardown must never be able to crash the dashboard: an exception here
          // is unrecoverable noise, not something the user can act on.
          try {
            app.destroy(true)
          } catch (err) {
            console.warn('[live2d] app teardown:', err)
          }

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
