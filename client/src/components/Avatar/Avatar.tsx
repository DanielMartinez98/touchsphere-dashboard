import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import type { AppMode } from '../../hooks/useAppMode'
import { AVATAR_MODEL_URL } from '../../hooks/useAvatar'
import { getMouthLevel } from '../../utils/lipsync'

// 3D "VTuber" avatar — the alternative centre visual to the particle sphere.
//
// Renders a VRM model that lip-syncs to the TTS reply, blinks, breathes, and
// tracks the user's touch. It reuses the same voice state the sphere does
// (listening / speaking / volume), so the two are drop-in swappable.
//
// The model is NOT bundled: drop a .vrm at client/public/avatar.vrm. If it's
// absent or fails to parse we report 'error' and App falls back to the sphere,
// so a missing/broken asset can never leave the kiosk with a blank centre.

export type AvatarStatus = 'loading' | 'ready' | 'error'

interface Props {
  mode: AppMode
  voiceListening: boolean
  voiceSpeaking: boolean
  voiceVolume: number
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

/** Approximate eye height of a VRM in metres — models are authored at human scale. */
const EYE_Y = 1.35
/** Resting brightness of the state-coloured rim light. */
const RIM_BASE = 1.2

export default function Avatar({ mode, voiceListening, voiceSpeaking, voiceVolume, onStatus, onFps }: Props) {
  const mountRef       = useRef<HTMLDivElement>(null)
  const modeRef        = useRef(mode)
  const voiceListenRef = useRef(voiceListening)
  const voiceSpeakRef  = useRef(voiceSpeaking)
  const voiceVolRef    = useRef(voiceVolume)
  // Callbacks live in refs so a caller passing an inline arrow doesn't tear
  // down and rebuild the whole scene on every render.
  const onStatusRef    = useRef(onStatus)
  const onFpsRef       = useRef(onFps)

  useEffect(() => { modeRef.current        = mode           }, [mode])
  useEffect(() => { voiceListenRef.current = voiceListening }, [voiceListening])
  useEffect(() => { voiceSpeakRef.current  = voiceSpeaking  }, [voiceSpeaking])
  useEffect(() => { voiceVolRef.current    = voiceVolume    }, [voiceVolume])
  useEffect(() => { onStatusRef.current    = onStatus       }, [onStatus])
  useEffect(() => { onFpsRef.current       = onFps          }, [onFps])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let disposed = false

    const scene = new THREE.Scene()

    // Framing: portrait screen, so we frame head-and-chest. Positions are in
    // metres — a VRM is authored at human scale, eyes at roughly 1.35 m. Framed
    // to sit clear of the mode pill up top and the settings row below.
    const camera = new THREE.PerspectiveCamera(30, mount.clientWidth / mount.clientHeight, 0.1, 20)
    camera.position.set(0, 1.22, 1.85)
    camera.lookAt(0, 1.12, 0)

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
    // gaze, then nudged by touch below.
    const lookTarget = new THREE.Object3D()
    lookTarget.position.set(0, EYE_Y, 2.2)
    scene.add(lookTarget)

    let vrm: VRM | null = null
    // Set when the model can't be loaded. App swaps the sphere back in, so this
    // scene has nothing left to draw — stop the loop rather than spin on empty
    // frames forever.
    let loadFailed = false

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

    // ── Load the VRM ────────────────────────────────────────────────────────
    onStatusRef.current?.('loading')
    const loader = new GLTFLoader()
    loader.register(parser => new VRMLoaderPlugin(parser))

    loader.load(
      AVATAR_MODEL_URL,
      (gltf) => {
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
        // mannequin, not a character. There's no animation clip to fall back on,
        // so drop the arms into a relaxed pose by hand. These rotations persist:
        // vrm.update() drives expressions, look-at and spring bones, but never
        // resets humanoid bone rotations we've set ourselves.
        const humanoid = loaded.humanoid
        if (humanoid) {
          const ARM_DROP = 1.25  // radians; ~72° down from horizontal
          const ELBOW    = 0.12  // a touch of bend so the arms aren't planks
          const pose: [Parameters<typeof humanoid.getNormalizedBoneNode>[0], number][] = [
            ['leftUpperArm',  -ARM_DROP],
            ['rightUpperArm',  ARM_DROP],
            ['leftLowerArm',  -ELBOW],
            ['rightLowerArm',  ELBOW],
          ]
          for (const [name, z] of pose) {
            const node = humanoid.getNormalizedBoneNode(name)
            if (node) node.rotation.z = z
          }
        }

        if (loaded.lookAt) loaded.lookAt.target = lookTarget
        scene.add(loaded.scene)
        vrm = loaded
        onStatusRef.current?.('ready')
      },
      undefined,
      (err) => {
        if (disposed) return
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('[avatar] failed to load VRM:', msg)
        loadFailed = true
        onStatusRef.current?.('error', `Couldn’t load ${AVATAR_MODEL_URL}`)
      },
    )

    // ── Animation loop ──────────────────────────────────────────────────────
    const clock = new THREE.Clock()
    let frameId: number
    let time = 0

    // Blink: hold the eyes open for a random beat, then close fast.
    let nextBlinkAt = 2 + Math.random() * 3
    let blinkStartedAt = -1
    const BLINK_MS = 0.12

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

        lookTarget.position.set(pointerX * 0.8, EYE_Y + pointerY * 0.4, 2.2)

        // Drives expressions, look-at, and spring bones (hair/clothing physics).
        vrm.update(delta)
      }

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
