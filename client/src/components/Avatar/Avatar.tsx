import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import type { AppMode } from '../../hooks/useAppMode'
import type { AvatarStatus } from '../../hooks/useAvatar'
import { getMouthLevel } from '../../utils/lipsync'
import { onCue } from '../../utils/avatarCues'

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

// ── Resting pose ─────────────────────────────────────────────────────────────
// A bare VRM loads in a T-pose; the old fix dropped the arms with two straight
// rotations, which reads as a mannequin. This stance adds settled shoulders, a
// real elbow bend, relaxed wrists, a hint of slouch, and (in the animate loop)
// a slow weight shift + arm sway so she's never statue-still.
//
// All angles are authored in VRM 1.0's normalized-bone convention; Z-axis
// values are mirrored per side and per spec version at apply time (`flip`).
const IDLE_POSE = {
  shoulderZ: 0.06,   // shoulders settled down from the T-pose shrug
  upperArmZ: 1.27,   // ~73° down — arms hang with a little clearance from the body
  upperArmX: -0.17,  // rest forward (VRM 1.0 forward is −x) so the hands settle in
                     // FRONT of the thighs instead of clipping into them
  lowerArmZ: 0.34,   // a softer elbow bend — relaxed, not planks, and swings the
                     // forearms slightly forward to keep the hands off the hips
  handZ:     0.10,   // relaxed wrists
  spineX:    0.02,   // barely-there slouch
}

// ── Gestures — the LLM's body language ───────────────────────────────────────
// Cues arrive as window events (see utils/avatarCues) fired by useVoice in sync
// with the sentence being spoken. Each gesture is procedural — pure additive
// bone offsets over time — so it works on ANY humanoid VRM, needs no animation
// files, and can never break a model that lacks them.

/** Additive offsets a gesture writes for one frame. Left/right in VRM 1.0 terms. */
interface GestureFrame {
  lUpperZ: number; rUpperZ: number   // + raises the left arm, − raises the right
  lUpperX: number; rUpperX: number
  lLowerZ: number; rLowerZ: number
  lHandZ: number;  rHandZ: number
  spineX: number
  headYaw: number; headPitch: number
  rootY: number                      // vertical hop, as a fraction of model height
}

const zeroFrame = (): GestureFrame => ({
  lUpperZ: 0, rUpperZ: 0, lUpperX: 0, rUpperX: 0, lLowerZ: 0, rLowerZ: 0,
  lHandZ: 0, rHandZ: 0, spineX: 0, headYaw: 0, headPitch: 0, rootY: 0,
})

interface GestureDef {
  duration: number   // seconds
  apply: (p: number, env: number, out: GestureFrame) => void   // p = progress 0..1
}

/** Smooth attack/release so limbs ease in and out instead of snapping. */
function envelope(p: number, attack = 0.18, release = 0.25): number {
  const s = (x: number) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c) }
  return s(p / attack) * s((1 - p) / release)
}

const GESTURES: Record<string, GestureDef> = {
  wave: {
    duration: 2.0,
    apply(p, env, o) {
      o.rUpperZ  = -1.75 * env                                          // arm up and out
      o.rUpperX  = 0.15 * env
      o.rLowerZ  = (-0.35 + Math.sin(p * Math.PI * 7) * 0.45) * env     // the wave itself
      o.rHandZ   = Math.sin(p * Math.PI * 7) * 0.25 * env
      o.headYaw  = -0.06 * env
    },
  },
  nod:   { duration: 1.0, apply(p, env, o) { o.headPitch = Math.sin(p * Math.PI * 3) * 0.22 * env } },
  shake: { duration: 1.1, apply(p, env, o) { o.headYaw   = Math.sin(p * Math.PI * 4) * 0.28 * env } },
  bow: {
    duration: 1.7,
    apply(_p, env, o) {
      o.spineX    = 0.38 * env
      o.headPitch = 0.22 * env
      o.lUpperZ   = -0.10 * env; o.rUpperZ = 0.10 * env   // arms tucked slightly in
    },
  },
  cheer: {
    duration: 1.6,
    apply(p, env, o) {
      o.lUpperZ = 2.5 * env; o.rUpperZ = -2.5 * env       // both arms overhead
      o.lLowerZ = IDLE_POSE.lowerArmZ * env; o.rLowerZ = -IDLE_POSE.lowerArmZ * env  // elbows straighten
      o.rootY   = Math.abs(Math.sin(p * Math.PI * 2)) * 0.02 * env      // two little bounces
      o.headPitch = -0.10 * env                                          // chin up
    },
  },
  think: {
    duration: 2.6,
    apply(_p, env, o) {
      o.rUpperZ   = -0.35 * env
      o.rUpperX   = -0.55 * env                            // forearm swings toward the chin
      o.rLowerZ   = -1.55 * env
      o.headYaw   = 0.12 * env
      o.headPitch = 0.08 * env
    },
  },
  jump: {
    duration: 1.3,
    apply(p, env, o) {
      const hop = Math.abs(Math.sin(p * Math.PI * 2))
      o.rootY   = hop * 0.035 * env
      o.lUpperZ = hop * 0.3 * env; o.rUpperZ = -hop * 0.3 * env   // arms flare on the hops
    },
  },
}

// ── LLM-driven faces ─────────────────────────────────────────────────────────
// A face cue is held for a few seconds and drives BOTH layers: the VRM's own
// expression presets (guaranteed to exist-ish on any model) and — when this
// model kept them through export — the artist's authored morph expressions,
// which look far more like *her*.
const FACE_HOLD_S = 4.5
const WINK_HOLD_S = 1.4

/** cue name → VRM preset candidates (first the model has, wins) + weight.
 *  This is the PRIMARY expression layer: a VRM's own presets are complete and
 *  reliable, whereas the artist morphs below (ARTIST_FOR) are routinely stripped
 *  on export. On miku-nt these presets resolve to — happy→joy (ワ+はぅ, a bright
 *  OPEN-eyed smile), relaxed→fun (笑い, the closed-eye ^_^ smile), sad→sorrow
 *  (with tears), angry, and blinkLeft→ウィンク２ (a real wink). VRM 0.x has no
 *  'surprised' preset, so those fall through to the 'oh' viseme — an open
 *  O-mouth is a decent surprise on any rig. */
const PRESET_FOR: Record<string, [name: string, weight: number][]> = {
  happy:     [['happy', 0.85]],
  excited:   [['happy', 1.0]],
  shy:       [['happy', 0.35]],
  wink:      [['blinkLeft', 1.0]],
  sad:       [['sad', 0.85]],
  angry:     [['angry', 0.9]],
  surprised: [['surprised', 0.95], ['oh', 0.85]],
  calm:      [['relaxed', 0.8]],
  shocked:   [['surprised', 1.0], ['oh', 0.9]],
}

/** cue name → the artist's own morph expressions (see miku-nt.anim.json), used
 *  ONLY where they beat the VRM preset. Most of this model's authored set was
 *  stripped on export (16 morphs survived) and what remains either duplicates a
 *  preset (Smile == fun/relaxed, Anger == angry) or closes her eyes — crucially
 *  'Smile' is 笑い, which shuts her eyes, so mapping it to 'happy' made them
 *  vanish. The one uniquely-useful survivor is はぅ (Hau): a flustered blush the
 *  presets don't offer, so shy is the only cue kept here. Everything else
 *  deliberately falls through to the PRESET_FOR layer above. */
const ARTIST_FOR: Record<string, string[]> = {
  shy: ['Hau'],
}

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

    // Bones the per-frame pose/gesture system drives, cached at load. The
    // resting stance is re-applied every frame so gesture offsets can layer on
    // top and always land back exactly at rest.
    let bones: Record<
      'lShoulder' | 'rShoulder' | 'lUpper' | 'rUpper' | 'lLower' | 'rLower' |
      'lHand' | 'rHand' | 'spine' | 'hips',
      THREE.Object3D | null
    > | null = null
    let flip = 1           // VRM 0.x mirrors Z rotations — see onModelLoaded
    let modelHeight = 1.5  // real bounding-box height; scales gesture hops
    let baseSceneY = 0

    // ── LLM cue state ────────────────────────────────────────────────────────
    // Gestures queue (shallowly — a burst of cues should read as expressive,
    // not as a ten-second interpretive-dance backlog); a face cue is held for a
    // few seconds. Both arrive via window events from useVoice, timed to the
    // sentence being spoken.
    const gestureQueue: string[] = []
    let activeGesture: { def: GestureDef; startedAt: number } | null = null
    let cueFace: { name: string; until: number } | null = null
    // VRM preset-expression weights, lerped so faces fade rather than snap.
    const presetWeights = new Map<string, number>()
    // Head tracking is integrated separately from the bone it drives, so the
    // gesture offsets composed onto the neck never feed back into the damping.
    let trackedYaw = 0
    let trackedPitch = 0

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
        // mannequin, not a character. The resting stance (IDLE_POSE) plus any
        // active gesture is applied to these bones EVERY FRAME in animate(),
        // which is what lets gestures be purely additive and still always land
        // back exactly at rest.
        //
        // NOT taken from the model's own AFK pose, even though it ships one: that
        // clip stores absolute local rotations in the FBX rig's space, where rest
        // rotations are non-identity (its Hips carries the 90° Blender Z-up→Y-up
        // root). UniVRM T-pose-normalises on export — every node in this VRM has
        // an identity rest rotation — so replaying those quaternions folds the
        // model in half. Porting it would mean parsing the FBX for its rest pose
        // and applying deltas, which isn't worth it for a static stance.
        //
        // Rotations we set persist: vrm.update() drives expressions, look-at and
        // spring bones, but never resets bone rotations we've written ourselves.
        const humanoid = loaded.humanoid
        if (humanoid) {
          // VRM 0.x rigs come through three-vrm's normalization mirrored about Y
          // relative to 1.0 (0.x models face -Z, and rotateVRM0 turns them round).
          // The upshot is that the same Z rotation that drops a 1.0 model's arms
          // *raises* a 0.x model's, so the sign has to follow the spec version.
          flip = loaded.meta?.metaVersion === '0' ? -1 : 1
          bones = {
            lShoulder: humanoid.getNormalizedBoneNode('leftShoulder'),
            rShoulder: humanoid.getNormalizedBoneNode('rightShoulder'),
            lUpper:    humanoid.getNormalizedBoneNode('leftUpperArm'),
            rUpper:    humanoid.getNormalizedBoneNode('rightUpperArm'),
            lLower:    humanoid.getNormalizedBoneNode('leftLowerArm'),
            rLower:    humanoid.getNormalizedBoneNode('rightLowerArm'),
            lHand:     humanoid.getNormalizedBoneNode('leftHand'),
            rHand:     humanoid.getNormalizedBoneNode('rightHand'),
            spine:     humanoid.getNormalizedBoneNode('spine'),
            hips:      humanoid.getNormalizedBoneNode('hips'),
          }
        }

        // Index the model's morph targets by name so the artist's facial
        // expressions can be driven directly.
        //
        // Then keep whatever parts of each expression the model can actually
        // PERFORM. UniVRM strips any morph the VRM's own presets don't
        // reference, so a Unity package's expression set is routinely wider
        // than the exported .vrm's — on this model only 3 of 11 expressions
        // survived whole. An expression that kept SOME of its morphs is still
        // worth having (Star Eyes without 星目 still opens her mouth in an
        // "oh"), so keep the surviving subset rather than demanding all-or-
        // nothing; only fully-stripped expressions are dropped.
        if (animData?.expressions) {
          const index = indexMorphTargets(loaded)
          const usable: Record<string, Record<string, number>> = {}
          const partial: string[] = []
          for (const [name, targets] of Object.entries(animData.expressions)) {
            const kept = Object.fromEntries(
              Object.entries(targets).filter(([m]) => index.has(m)),
            )
            const survived = Object.keys(kept).length
            if (survived === 0) continue
            usable[name] = kept
            if (survived < Object.keys(targets).length) {
              partial.push(`${name} (${survived}/${Object.keys(targets).length})`)
            }
          }
          morphs = index
          animData = { expressions: usable }
          console.log(
            `[avatar] artist expressions usable: ${Object.keys(usable).join(', ') || '(none)'}` +
            (partial.length ? ` — partial: ${partial.join(', ')}` : ''),
          )
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
        modelHeight = height
        baseSceneY = loaded.scene.position.y
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

    // ── LLM cues → gestures + held faces ────────────────────────────────────
    // useVoice fires these in sync with the sentence chunk being spoken.
    const offCue = onCue((cue) => {
      if (cue.kind === 'gesture') {
        if (GESTURES[cue.name] && gestureQueue.length < 2) gestureQueue.push(cue.name)
      } else if (PRESET_FOR[cue.name] || ARTIST_FOR[cue.name]) {
        cueFace = { name: cue.name, until: time + (cue.name === 'wink' ? WINK_HOLD_S : FACE_HOLD_S) }
      }
    })

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

        // The face the LLM asked for, while its hold lasts — and the artist's
        // version of it when this model kept those morphs. The artist version
        // REPLACES the preset fallback rather than stacking on it: both tend to
        // bind the same underlying morphs (the VRM 'happy' preset and the
        // artist's Smile both drive 笑い), and 0.7 + 0.65 of the same morph
        // extrapolates the mesh past its authored shape into a crushed grimace.
        const face = cueFace && time < cueFace.until ? cueFace.name : null
        const artistHave = (n: string) => !!(morphs && animData?.expressions && n in animData.expressions)
        const artistFace = face ? ARTIST_FOR[face]?.find(artistHave) ?? null : null

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
          // pleased while speaking, neutral at rest — unless the LLM chose a
          // face, which wins while it's held. Weights are lerped so expressions
          // fade in and out rather than snapping. The preset layer only carries
          // a cue face when the artist layer can't (see artistFace above).
          const presetTarget = new Map<string, number>()
          presetTarget.set('relaxed', listening && !face ? 0.35 + vol * 0.2 : 0)
          presetTarget.set('happy',   speaking  && !face ? 0.25 : 0)

          // Idle wink — a small flourish so she has some life between replies.
          // Driven off the VRM's blinkLeft preset (ウィンク２ on this model): the
          // artist's own ウィンク morph didn't survive export, so the old artist-
          // layer flourish fell through to はぅ and made her look flustered at
          // random instead of winking.
          if (!speaking && !listening && !face && time > nextWinkAt) {
            winkUntil  = time + 0.5
            nextWinkAt = time + 25 + Math.random() * 35
          }
          if (winkUntil > time) presetTarget.set('blinkLeft', 1)

          const cuePreset = face && !artistFace
            ? PRESET_FOR[face]?.find(([name]) => expr.getExpression(name))
            : undefined
          if (cuePreset) {
            presetTarget.set(cuePreset[0], Math.max(presetTarget.get(cuePreset[0]) ?? 0, cuePreset[1]))
          }
          // Anything held from an earlier cue but absent from this frame's
          // targets decays back to zero — a sad face must not outlive its hold.
          for (const name of presetWeights.keys()) {
            if (!presetTarget.has(name)) presetTarget.set(name, 0)
          }
          for (const [name, target] of presetTarget) {
            const cur  = presetWeights.get(name) ?? 0
            const next = Math.abs(target - cur) < 0.001 ? target : cur + (target - cur) * 0.15
            if (next === 0 && cur === 0) { presetWeights.delete(name); continue }
            presetWeights.set(name, next)
            if (expr.getExpression(name)) expr.setValue(name, next)
          }
        }

        // ── Gesture playback ─────────────────────────────────────────────────
        if (!activeGesture && gestureQueue.length > 0) {
          const def = GESTURES[gestureQueue.shift()!]
          if (def) activeGesture = { def, startedAt: time }
        }
        const g = zeroFrame()
        if (activeGesture) {
          const p = (time - activeGesture.startedAt) / activeGesture.def.duration
          if (p >= 1) activeGesture = null
          else activeGesture.def.apply(p, envelope(p), g)
        }

        // ── Pose — resting stance + gesture offsets, re-applied every frame ──
        // Idle micro-motion rides on top: a slow weight shift, out-of-phase arm
        // sway, and (below) head drift + breathing. Two out-of-sync sines are
        // summed for the weight shift so it drifts like a person settling their
        // balance rather than ticking like a metronome — the single-sine version
        // read as statue-still.
        const shiftPhase = Math.sin(time * 0.22) * 0.7 + Math.sin(time * 0.11 + 0.6) * 0.3
        const swayL = Math.sin(time * 0.5) * 0.022
        const swayR = Math.sin(time * 0.5 + 1.7) * 0.022
        if (bones) {
          bones.lShoulder?.rotation.set(0, 0, flip * -IDLE_POSE.shoulderZ)
          bones.rShoulder?.rotation.set(0, 0, flip *  IDLE_POSE.shoulderZ)
          if (bones.lUpper) {
            bones.lUpper.rotation.x = flip * (IDLE_POSE.upperArmX + g.lUpperX)
            bones.lUpper.rotation.z = flip * (-IDLE_POSE.upperArmZ + swayL + g.lUpperZ)
          }
          if (bones.rUpper) {
            bones.rUpper.rotation.x = flip * (IDLE_POSE.upperArmX + g.rUpperX)
            bones.rUpper.rotation.z = flip * (IDLE_POSE.upperArmZ + swayR + g.rUpperZ)
          }
          if (bones.lLower) bones.lLower.rotation.z = flip * (-IDLE_POSE.lowerArmZ + g.lLowerZ)
          if (bones.rLower) bones.rLower.rotation.z = flip * ( IDLE_POSE.lowerArmZ + g.rLowerZ)
          if (bones.lHand)  bones.lHand.rotation.z  = flip * (-IDLE_POSE.handZ + g.lHandZ)
          if (bones.rHand)  bones.rHand.rotation.z  = flip * ( IDLE_POSE.handZ + g.rHandZ)
          if (bones.spine) {
            bones.spine.rotation.x = flip * (IDLE_POSE.spineX + g.spineX)
            bones.spine.rotation.z = flip * shiftPhase * 0.03              // weight shift…
          }
          if (bones.hips) bones.hips.rotation.z = flip * -shiftPhase * 0.02   // …hips counter it
        }

        // Idle breathing + a gentle lean toward the user while listening. The
        // breath is deliberately visible — the chest rises and falls enough to
        // catch the eye, which is most of what sells "alive" on an otherwise
        // still model.
        const chest = vrm.humanoid?.getNormalizedBoneNode('chest')
        if (chest) {
          chest.rotation.x = flip * (Math.sin(time * 1.5) * 0.035 + (listening ? 0.05 : 0))
        }

        // Head follows the touch point, damped so it doesn't snap. Tracking is
        // integrated in its own variables and composed with the gesture's
        // nod/shake and a slow idle drift, so none of them feed back into the
        // damping of the others.
        //
        // NOTE the flip on pitch: X-axis rotations mirror between VRM 0.x and
        // 1.0 exactly like Z (conjugating by rotateVRM0's 180° Y-turn negates
        // both), which is why the un-flipped original made her look UP at a
        // touch near the bottom of the screen and threw her head back whenever
        // the pointer sat on the on-screen buttons. Yaw is preserved by that
        // same conjugation, so it stays un-flipped.
        const head = vrm.humanoid?.getNormalizedBoneNode('neck')
        if (head) {
          trackedYaw   += (pointerX * 0.35 - trackedYaw)   * 0.06
          trackedPitch += (-pointerY * 0.2 - trackedPitch) * 0.06
          // Two out-of-sync sines per axis so the head wanders instead of
          // sweeping on a fixed cycle — a slow look-around that never repeats.
          head.rotation.y = trackedYaw + g.headYaw + Math.sin(time * 0.19) * 0.035 + Math.sin(time * 0.077) * 0.02
          head.rotation.x = flip * (trackedPitch + g.headPitch + Math.sin(time * 0.31) * 0.02)
        }

        // Vertical hop (cheer/jump), scaled by the model's real height so any
        // authoring scale hops the same apparent amount.
        vrm.scene.position.y = baseSceneY + g.rootY * modelHeight

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
          // The artist morph layer now carries ONLY the held cue faces that
          // ARTIST_FOR keeps (just はぅ/Hau — see that table). Speaking, listening
          // and idle faces are the VRM presets' job now: the surviving artist
          // morphs either duplicate a preset or close her eyes, so driving them
          // here is what made 'happy' blank her eyes and the idle flourish look
          // flustered. `artistFace` is computed once, above, and also suppresses
          // the preset fallback for whatever it does cover.
          const want = artistFace

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
      offCue()
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
