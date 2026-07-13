import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import type { AppMode } from '../../hooks/useAppMode'
import type { AvatarStatus } from '../../hooks/useAvatar'
import { getMouthLevel } from '../../utils/lipsync'

// 3D "VTuber" avatar — the alternative centre visual to the particle sphere.
//
// Renders a VRM model that lip-syncs to the TTS reply, blinks, breathes, and
// tracks the user's touch. It reuses the same voice state the sphere does
// (listening / speaking / volume), so the two are drop-in swappable.
//
// The model is NOT bundled — it's named by the active assistant's profile (see
// config/assistant.ts) and served from client/public or the server's avatar
// mount. If it's absent or fails to parse we report 'error' and App falls back
// to the sphere, so a missing asset can never leave the kiosk with a blank centre.

// Companion JSON extracted from the model's Unity package: the artist's own
// facial expressions, as named morph-target weights. Unity stores these 0..100;
// the extractor normalises to 0..1.
//
// These are the expressions the VRM's own presets don't expose — 照れ (blush),
// ウィンク (wink), 星目 (star eyes) — so they add to, rather than fight, the
// standard happy/relaxed/blink/viseme set that three-vrm already drives.
interface AvatarAnimData {
  /** expression name → { morph target name: weight } */
  expressions?: Record<string, Record<string, number>>
}

interface Props {
  mode: AppMode
  voiceListening: boolean
  voiceSpeaking: boolean
  voiceVolume: number
  /** URL of the .vrm to load. Comes from the active assistant's profile. */
  modelUrl: string
  /** Optional pose + expression JSON that ships alongside the model. */
  animUrl?: string
  /** How close she sits to the camera. Higher = closer. */
  zoom: number
  /** Vertical shift as a fraction of the frame. Negative = up. */
  offsetY: number
  /** Reports load progress so the caller can fall back to the sphere on error. */
  onStatus?: (status: AvatarStatus, detail?: string) => void
  /** Measured framerate, emitted ~1×/s. Surfaced in Settings to check the Pi. */
  onFps?: (fps: number) => void
}

// Rim-light colours reuse the sphere's state language so the two visuals feel
// like the same assistant: green = listening, amber = speaking.
const WORK_RIM   = new THREE.Color(0x06b6d4)
const REST_RIM   = new THREE.Color(0x8b5cf6)
const LISTEN_RIM = new THREE.Color(0x00ff88)
const SPEAK_RIM  = new THREE.Color(0xf59e0b)

// The Pi's GPU is the constraint, not the desktop's. Cap the pixel ratio — a
// retina-density buffer of a 3D character is the fastest way to tank framerate.
const MAX_PIXEL_RATIO = 1.5

/** Resting brightness of the state-coloured rim light. */
const RIM_BASE = 1.2
/** Eye height as a fraction of total model height — standard human proportion. */
const EYE_RATIO = 0.93

/**
 * How strongly to hold an artist expression. Well under 1: these were authored
 * as full-face VRChat expressions, and at full weight they overpower the blink
 * and lip-sync happening underneath.
 */
const EXPRESSION_STRENGTH = 0.65

/** A morph target, located as (mesh, index) so we can set its influence. */
type MorphIndex = Map<string, Array<{ mesh: THREE.Mesh; index: number }>>

/**
 * Map every morph target name in the model to where it lives. The artist's
 * expressions reference morphs by their authored (Japanese) names — 笑い, ウィンク,
 * 照れ — and a name can appear on more than one mesh, so each maps to a list.
 */
function indexMorphTargets(vrm: VRM): MorphIndex {
  const index: MorphIndex = new Map()
  vrm.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return
    for (const [name, i] of Object.entries(mesh.morphTargetDictionary)) {
      const list = index.get(name) ?? []
      list.push({ mesh, index: i })
      index.set(name, list)
    }
  })
  return index
}


export default function Avatar({ mode, voiceListening, voiceSpeaking, voiceVolume, modelUrl, animUrl, zoom, offsetY, onStatus, onFps }: Props) {
  const mountRef       = useRef<HTMLDivElement>(null)
  const modeRef        = useRef(mode)
  const voiceListenRef = useRef(voiceListening)
  const voiceSpeakRef  = useRef(voiceSpeaking)
  const voiceVolRef    = useRef(voiceVolume)
  const zoomRef        = useRef(zoom)
  const offsetYRef     = useRef(offsetY)
  // Callbacks live in refs so a caller passing an inline arrow doesn't tear
  // down and rebuild the whole scene on every render.
  const onStatusRef    = useRef(onStatus)
  const onFpsRef       = useRef(onFps)

  useEffect(() => { modeRef.current        = mode           }, [mode])
  useEffect(() => { voiceListenRef.current = voiceListening }, [voiceListening])
  useEffect(() => { voiceSpeakRef.current  = voiceSpeaking  }, [voiceSpeaking])
  useEffect(() => { voiceVolRef.current    = voiceVolume    }, [voiceVolume])
  useEffect(() => { zoomRef.current        = zoom           }, [zoom])
  useEffect(() => { offsetYRef.current     = offsetY        }, [offsetY])
  useEffect(() => { onStatusRef.current    = onStatus       }, [onStatus])
  useEffect(() => { onFpsRef.current       = onFps          }, [onFps])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let disposed = false

    const scene = new THREE.Scene()

    // Framing is derived from the model's own bounding box once it loads (see
    // below) rather than hard-coded: VRMs are *supposed* to be authored at human
    // scale (~1.5 m) but plenty aren't, and a fixed camera then ends up staring
    // at the model's knees. Far clip is generous for the same reason.
    const camera = new THREE.PerspectiveCamera(30, mount.clientWidth / mount.clientHeight, 0.01, 500)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    // MToon (the VRM toon shader) clips to white easily, so these are dimmer
    // than they'd be for a PBR model — a soft key plus a coloured rim from
    // behind that carries the voice/mode state.
    const key = new THREE.DirectionalLight(0xffffff, 0.9)
    key.position.set(0.5, 1.6, 1.4)
    scene.add(key)
    scene.add(new THREE.AmbientLight(0xffffff, 0.35))
    const rim = new THREE.DirectionalLight(WORK_RIM.clone(), RIM_BASE)
    rim.position.set(-0.8, 1.4, -1.2)
    scene.add(rim)

    // Where the avatar's eyes point — placed out at the viewer so she meets your
    // gaze, then nudged by touch below. Positioned once the model's real scale
    // is known.
    const lookTarget = new THREE.Object3D()
    scene.add(lookTarget)

    // Measured from the loaded model. Until then there's nothing to draw anyway.
    let eyeY = 1.35      // world Y of the eyes
    let centreY = 1.0    // world Y the camera frames on at zoom 1
    let baseDist = 2.0   // camera distance that fits the whole model at zoom 1

    let vrm: VRM | null = null
    // Set when the model can't be loaded. App swaps the sphere back in, so this
    // scene has nothing left to draw — stop the loop rather than spin on empty
    // frames forever.
    let loadFailed = false

    // The artist's pose + expressions, if this model ships them. Optional: a
    // missing or broken file just means we fall back to the hand-authored pose
    // and the VRM's own expression presets, so it can't break the avatar.
    let animData: AvatarAnimData | null = null
    let morphs: MorphIndex | null = null
    // Currently-held facial expression, lerped so it doesn't snap on/off.
    const morphWeights = new Map<string, number>()

    // ── Pointer tracking (same approach as ParticleSphere) ──────────────────
    let pointerX = 0
    let pointerY = 0
    let pendingClientX = 0
    let pendingClientY = 0
    let pointerRafId: number | null = null
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      pendingClientX = 'touches' in e ? e.touches[0]!.clientX : e.clientX
      pendingClientY = 'touches' in e ? e.touches[0]!.clientY : e.clientY
      if (pointerRafId !== null) return
      pointerRafId = requestAnimationFrame(() => {
        pointerRafId = null
        const bounds = mount.getBoundingClientRect()
        pointerX = ((pendingClientX - bounds.left) / bounds.width  - 0.5) * 2
        pointerY = -((pendingClientY - bounds.top) / bounds.height - 0.5) * 2
      })
    }
    window.addEventListener('mousemove', handlePointer)
    window.addEventListener('touchmove', handlePointer, { passive: true })

    // ── Load the pose/expression companion file, if this model has one ──────
    // Kicked off before the model so it's usually resolved by the time the (far
    // larger) .vrm finishes. Failure is non-fatal by design.
    const animReady: Promise<void> = animUrl
      ? fetch(animUrl)
          .then(r => (r.ok ? r.json() as Promise<AvatarAnimData> : null))
          .then(d => { animData = d })
          .catch(err => { console.warn('[avatar] no pose/expression data:', err) })
      : Promise.resolve()

    // ── Load the VRM ────────────────────────────────────────────────────────
    onStatusRef.current?.('loading')
    const loader = new GLTFLoader()
    loader.register(parser => new VRMLoaderPlugin(parser))

    loader.load(
      modelUrl,
      (gltf) => { void onModelLoaded(gltf) },
      undefined,
      (err) => {
        if (disposed) return
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('[avatar] failed to load VRM:', msg)
        loadFailed = true
        onStatusRef.current?.('error', `Couldn’t load ${modelUrl}`)
      },
    )

    async function onModelLoaded(gltf: { scene: THREE.Group; userData: Record<string, unknown> }) {
      // The pose/expression file is tiny next to the .vrm, so this has almost
      // always resolved already — but the model must not be posed before it lands.
      await animReady
      {
        if (disposed) return
        const loaded = gltf.userData['vrm'] as VRM | undefined
        if (!loaded) {
          loadFailed = true
          onStatusRef.current?.('error', 'File loaded but contains no VRM data')
          return
        }

        // VRM0 models face -Z; this turns them to face the camera. No-op on VRM1.
        VRMUtils.rotateVRM0(loaded)
        // Strip geometry the model never uses — meaningful on the Pi.
        VRMUtils.removeUnnecessaryVertices(gltf.scene)
        VRMUtils.combineSkeletons(gltf.scene)

        // Frustum culling on a skinned mesh whose bounds move can pop the model
        // out of view mid-animation; the avatar is always on screen anyway.
        loaded.scene.traverse((obj) => { obj.frustumCulled = false })

        // A bare VRM loads in a T-pose — arms straight out — which reads as a
        // mannequin, not a character, so drop the arms by hand.
        //
        // NOT taken from the model's own AFK pose, even though it ships one: that
        // clip stores absolute local rotations in the FBX rig's space, where rest
        // rotations are non-identity (its Hips carries the 90° Blender Z-up→Y-up
        // root). UniVRM T-pose-normalises on export — every node in this VRM has
        // an identity rest rotation — so replaying those quaternions folds the
        // model in half. Porting it would mean parsing the FBX for its rest pose
        // and applying deltas, which isn't worth it for a static stance.
        //
        // These rotations persist: vrm.update() drives expressions, look-at and
        // spring bones, but never resets bone rotations we've set ourselves.
        const humanoid = loaded.humanoid
        if (humanoid) {
          const ARM_DROP = 1.25  // radians; ~72° down from horizontal
          const ELBOW    = 0.12  // a touch of bend so the arms aren't planks
          // VRM 0.x rigs come through three-vrm's normalization mirrored about Y
          // relative to 1.0 (0.x models face -Z, and rotateVRM0 turns them round).
          // The upshot is that the same Z rotation that drops a 1.0 model's arms
          // *raises* a 0.x model's, so the sign has to follow the spec version.
          const flip = loaded.meta?.metaVersion === '0' ? -1 : 1
          const pose: [Parameters<typeof humanoid.getNormalizedBoneNode>[0], number][] = [
            ['leftUpperArm',  -ARM_DROP * flip],
            ['rightUpperArm',  ARM_DROP * flip],
            ['leftLowerArm',  -ELBOW    * flip],
            ['rightLowerArm',  ELBOW    * flip],
          ]
          for (const [name, z] of pose) {
            const node = humanoid.getNormalizedBoneNode(name)
            if (node) node.rotation.z = z
          }
        }

        // Index the model's morph targets by name so the artist's facial
        // expressions can be driven directly.
        //
        // Then keep only the expressions the model can actually PERFORM. UniVRM
        // strips any morph the VRM's own presets don't reference, so a Unity
        // package's expression set is routinely wider than the exported .vrm's:
        // this model ships Wink / Blush / Star Eyes clips, but the morphs behind
        // them (ウィンク, 照れ, 星目) didn't survive the export. Applying those
        // would silently do nothing, so drop them rather than pretend.
        if (animData?.expressions) {
          const index = indexMorphTargets(loaded)
          const usable: Record<string, Record<string, number>> = {}
          for (const [name, targets] of Object.entries(animData.expressions)) {
            if (Object.keys(targets).every(m => index.has(m))) usable[name] = targets
          }
          morphs = index
          animData = { expressions: usable }
          console.log(`[avatar] artist expressions usable: ${Object.keys(usable).join(', ') || '(none)'}`)
        }

        if (loaded.lookAt) loaded.lookAt.target = lookTarget
        scene.add(loaded.scene)

        // Measure the model to derive the camera framing. A VRM's units are only
        // conventionally metres — this one ("Cortana") is authored several times
        // human scale, so anything hard-coded frames her knees. Deriving from the
        // bounding box means any model, at any scale, lands correctly.
        loaded.scene.updateMatrixWorld(true)
        const box = new THREE.Box3().setFromObject(loaded.scene)
        const height = Math.max(box.max.y - box.min.y, 0.001)
        eyeY = box.min.y + height * EYE_RATIO
        centreY = (box.min.y + box.max.y) / 2
        // Distance at which the full height fits the viewport → zoom 1 = whole
        // model, matching what "zoom" means for the Live2D backend.
        const vFov = (camera.fov * Math.PI) / 180
        baseDist = (height * 1.05) / (2 * Math.tan(vFov / 2))
        console.log(`[avatar] model height=${height.toFixed(2)} → baseDist=${baseDist.toFixed(2)}`)

        vrm = loaded
        onStatusRef.current?.('ready')
      }
    }

    // ── Animation loop ──────────────────────────────────────────────────────
    const clock = new THREE.Clock()
    let frameId: number
    let time = 0

    // Blink: hold the eyes open for a random beat, then close fast.
    let nextBlinkAt = 2 + Math.random() * 3
    let blinkStartedAt = -1
    const BLINK_MS = 0.12

    // Idle wink — a small flourish so she has some life between replies.
    let nextWinkAt = 20 + Math.random() * 20
    let winkUntil = -1

    // FPS sampling.
    let frames = 0
    let fpsWindowStart = performance.now()

    const animate = () => {
      if (loadFailed) return
      frameId = requestAnimationFrame(animate)
      const delta = clock.getDelta()
      time += delta

      const listening = voiceListenRef.current
      const speaking  = voiceSpeakRef.current
      const vol       = voiceVolRef.current
      const isRest    = modeRef.current !== 'work'

      if (vrm) {
        const expr = vrm.expressionManager

        if (expr) {
          // Lip sync — the mouth follows the actual TTS waveform while speaking.
          // When the tap isn't attached (see utils/lipsync) this reads 0 and the
          // mouth simply stays shut rather than flapping out of time.
          expr.setValue('aa', speaking ? getMouthLevel() : 0)

          // Blink.
          if (blinkStartedAt < 0 && time > nextBlinkAt) blinkStartedAt = time
          if (blinkStartedAt >= 0) {
            const t = (time - blinkStartedAt) / BLINK_MS
            if (t >= 1) {
              expr.setValue('blink', 0)
              blinkStartedAt = -1
              nextBlinkAt = time + 2 + Math.random() * 4
            } else {
              // Triangle wave: shut, then open.
              expr.setValue('blink', 1 - Math.abs(t * 2 - 1))
            }
          }

          // A little life in the face for each state: attentive while listening,
          // pleased while speaking, neutral at rest.
          expr.setValue('relaxed', listening ? 0.35 + vol * 0.2 : 0)
          expr.setValue('happy',   speaking  ? 0.25 : 0)
        }

        // Idle breathing + a gentle lean toward the user while listening.
        const chest = vrm.humanoid?.getNormalizedBoneNode('chest')
        if (chest) {
          chest.rotation.x = Math.sin(time * 1.6) * 0.02 + (listening ? 0.05 : 0)
        }

        // Head follows the touch point, damped so it doesn't snap.
        const head = vrm.humanoid?.getNormalizedBoneNode('neck')
        if (head) {
          head.rotation.y += (pointerX * 0.35 - head.rotation.y) * 0.06
          head.rotation.x += (-pointerY * 0.2 - head.rotation.x) * 0.06
        }

        // Keep the gaze target out in front of the camera and scaled to the
        // model, so head-tracking behaves the same at any authoring scale.
        lookTarget.position.set(
          pointerX * baseDist * 0.3,
          eyeY + pointerY * baseDist * 0.15,
          baseDist,
        )

        // Drives expressions, look-at, and spring bones (hair/clothing physics).
        vrm.update(delta)

        // ── The artist's facial expressions ──────────────────────────────────
        // Applied AFTER vrm.update(), because the expression manager writes morph
        // influences during it — anything set beforehand is overwritten. These use
        // morphs the VRM presets don't expose at all (照れ / blush, ウィンク / wink,
        // 星目 / star eyes), so they don't fight the lip-sync visemes above.
        if (morphs && animData?.expressions) {
          const have = (name: string) => name in animData!.expressions!

          // Occasional flourish while idle, so she isn't a waxwork between
          // replies. Whichever of these the model actually kept on export.
          if (!speaking && !listening && time > nextWinkAt) {
            winkUntil  = time + 0.6
            nextWinkAt = time + 25 + Math.random() * 35
          }
          const flourish = ['Wink', 'Hau', 'Star Eyes'].find(have)

          // Fall through to nothing if the model can't do the expression — the
          // VRM's own happy/relaxed presets are still driving underneath, so she
          // never ends up expressionless.
          const want =
              speaking  && have('Smile') ? 'Smile'
            : listening && have('Calm')  ? 'Calm'
            : !speaking && !listening && winkUntil > time && flourish ? flourish
            : null

          // Ease every known expression toward its target weight — snapping a face
          // on and off looks robotic, and a lerp costs nothing.
          for (const [name, targets] of Object.entries(animData.expressions)) {
            const target = name === want ? EXPRESSION_STRENGTH : 0
            const current = morphWeights.get(name) ?? 0
            if (current === 0 && target === 0) continue
            const next = current + (target - current) * 0.12
            morphWeights.set(name, next)
            if (next < 0.001) { morphWeights.set(name, 0) }
            for (const [morph, weight] of Object.entries(targets)) {
              for (const t of morphs.get(morph) ?? []) {
                t.mesh.morphTargetInfluences![t.index] = weight * next
              }
            }
          }
        }
      }

      // Framing — driven live by the Settings sliders. Zoom pulls the camera in
      // along Z; offsetY slides the framing up/down. offsetY is a fraction of the
      // visible frame, so it means the same thing here as it does for Live2D even
      // though this camera works in metres.
      const dist      = baseDist / zoomRef.current
      const visibleH  = 2 * dist * Math.tan((camera.fov * Math.PI) / 360)
      const shift     = offsetYRef.current * visibleH
      camera.position.set(0, centreY + shift, dist)
      camera.lookAt(0, centreY + shift, 0)

      // Rim light carries the same state colours as the sphere.
      const rimTarget = listening ? LISTEN_RIM : speaking ? SPEAK_RIM : (isRest ? REST_RIM : WORK_RIM)
      rim.color.lerp(rimTarget, 0.05)
      // Pulse the rim with the mic level so a quiet room looks quiet.
      rim.intensity += ((listening ? RIM_BASE + vol * 1.5 : RIM_BASE) - rim.intensity) * 0.1

      renderer.render(scene, camera)

      frames++
      const now = performance.now()
      if (now - fpsWindowStart >= 1000) {
        onFpsRef.current?.(Math.round((frames * 1000) / (now - fpsWindowStart)))
        frames = 0
        fpsWindowStart = now
      }
    }
    animate()

    const handleResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      disposed = true
      if (pointerRafId !== null) cancelAnimationFrame(pointerRafId)
      cancelAnimationFrame(frameId)
      window.removeEventListener('mousemove', handlePointer)
      window.removeEventListener('touchmove', handlePointer)
      window.removeEventListener('resize', handleResize)
      if (vrm) {
        scene.remove(vrm.scene)
        VRMUtils.deepDispose(vrm.scene)
      }
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, []) // built once; state arrives via refs, exactly like ParticleSphere

  return (
    <div
      ref={mountRef}
      className="absolute inset-0 pointer-events-none"
      aria-hidden="true"
    />
  )
}
