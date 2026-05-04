import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { AppMode } from '../../hooks/useAppMode'

const PARTICLE_COUNT = 3000
const SPHERE_RADIUS = 120

// Work = cyan/blue tint on vertex colours; rest/locked = violet tint.
// THREE.Color is used as a per-channel multiplier on the vertex colours.
const WORK_TINT    = new THREE.Color(1.0, 1.0, 1.0)   // neutral → shows full cyan
const REST_TINT    = new THREE.Color(0.85, 0.2, 1.0)  // cuts green → shifts to violet
const WORK_TORUS   = new THREE.Color(0x00cfff)          // cyan ring
const REST_TORUS   = new THREE.Color(0x8b5cf6)          // violet ring
const LISTEN_TINT  = new THREE.Color(0.0, 1.0, 0.55)   // green → listening
const LISTEN_TORUS = new THREE.Color(0x00ff88)          // green ring
const SPEAK_TINT   = new THREE.Color(1.0, 0.65, 0.0)   // amber → speaking
const SPEAK_TORUS  = new THREE.Color(0xf59e0b)          // amber ring

interface Props {
  mode: AppMode
  voiceListening: boolean
  voiceSpeaking: boolean
  voiceVolume: number
}

export default function ParticleSphere({ mode, voiceListening, voiceSpeaking, voiceVolume }: Props) {
  const mountRef       = useRef<HTMLDivElement>(null)
  const modeRef        = useRef(mode)
  const voiceListenRef = useRef(voiceListening)
  const voiceSpeakRef  = useRef(voiceSpeaking)
  const voiceVolRef    = useRef(voiceVolume)

  // Keep refs up-to-date without recreating the Three.js scene.
  useEffect(() => { modeRef.current       = mode           }, [mode])
  useEffect(() => { voiceListenRef.current = voiceListening }, [voiceListening])
  useEffect(() => { voiceSpeakRef.current  = voiceSpeaking  }, [voiceSpeaking])
  useEffect(() => { voiceVolRef.current    = voiceVolume    }, [voiceVolume])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    // Scene
    const scene = new THREE.Scene()

    // Camera
    const camera = new THREE.PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 0.1, 2000)
    camera.position.z = 320

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    // Particles on sphere surface
    const positions = new Float32Array(PARTICLE_COUNT * 3)
    const colors    = new Float32Array(PARTICLE_COUNT * 3)
    const sizes     = new Float32Array(PARTICLE_COUNT)

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Fibonacci sphere distribution for even spread
      const phi   = Math.acos(1 - (2 * (i + 0.5)) / PARTICLE_COUNT)
      const theta = Math.PI * (1 + Math.sqrt(5)) * i

      const x = SPHERE_RADIUS * Math.sin(phi) * Math.cos(theta)
      const y = SPHERE_RADIUS * Math.sin(phi) * Math.sin(theta)
      const z = SPHERE_RADIUS * Math.cos(phi)

      positions[i * 3]     = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z

      // Cyan/blue gradient based on y position (base vertex colour)
      const t = (y / SPHERE_RADIUS + 1) / 2
      colors[i * 3]     = t * 0.1 + 0.0  // R
      colors[i * 3 + 1] = t * 0.5 + 0.4  // G
      colors[i * 3 + 2] = 1.0             // B

      sizes[i] = Math.random() * 2 + 1
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color',    new THREE.BufferAttribute(colors, 3))
    geometry.setAttribute('size',     new THREE.BufferAttribute(sizes, 1))

    // Circular particle texture
    const canvas  = document.createElement('canvas')
    canvas.width  = 64
    canvas.height = 64
    const ctx      = canvas.getContext('2d')!
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    gradient.addColorStop(0,   'rgba(255,255,255,1)')
    gradient.addColorStop(0.4, 'rgba(100,200,255,0.8)')
    gradient.addColorStop(1,   'rgba(0,80,255,0)')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(32, 32, 32, 0, Math.PI * 2)
    ctx.fill()
    const texture = new THREE.CanvasTexture(canvas)

    // Initialise tint to current mode so there's no pop on load.
    const initialIsRest = modeRef.current !== 'work'
    const material = new THREE.PointsMaterial({
      size: 3,
      map: texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      color: initialIsRest ? REST_TINT.clone() : WORK_TINT.clone(),
    })

    const points = new THREE.Points(geometry, material)
    scene.add(points)

    // Subtle glow ring (torus)
    const torusGeo = new THREE.TorusGeometry(SPHERE_RADIUS + 4, 1.5, 8, 120)
    const torusMat = new THREE.MeshBasicMaterial({
      color: initialIsRest ? REST_TORUS.clone() : WORK_TORUS.clone(),
      transparent: true,
      opacity: 0.18,
    })
    const torus = new THREE.Mesh(torusGeo, torusMat)
    torus.rotation.x = Math.PI / 2
    scene.add(torus)

    // Mouse/touch proximity effect (throttled via requestAnimationFrame)
    let mouseX = 0
    let mouseY = 0
    let pendingClientX = 0
    let pendingClientY = 0
    let pointerRafId: number | null = null
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      pendingClientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      pendingClientY = 'touches' in e ? e.touches[0].clientY : e.clientY
      if (pointerRafId !== null) return
      pointerRafId = requestAnimationFrame(() => {
        pointerRafId = null
        const bounds = mount.getBoundingClientRect()
        mouseX = ((pendingClientX - bounds.left) / bounds.width  - 0.5) * 2
        mouseY = -((pendingClientY - bounds.top)  / bounds.height - 0.5) * 2
      })
    }
    window.addEventListener('mousemove', handlePointer)
    window.addEventListener('touchmove', handlePointer, { passive: true })

    // Animation loop â€” smoothly lerps material tints when mode changes.
    let frameId: number
    let time = 0
    const scaleVec = new THREE.Vector3(1, 1, 1)
    const animate = () => {
      frameId = requestAnimationFrame(animate)
      time += 0.004

      const listening = voiceListenRef.current
      const speaking  = voiceSpeakRef.current
      const vol       = voiceVolRef.current

      // Faster rotation while voice is active
      const rotSpeed = (listening || speaking) ? 2.5 : 1.0
      points.rotation.y = time * 0.4  * rotSpeed
      points.rotation.x = time * 0.12 * rotSpeed
      torus.rotation.z  = time * 0.25 * rotSpeed

      // Scale: mic volume drives pulse when listening; gentle wave when speaking; idle otherwise
      const targetScale = listening
        ? 1.0 + vol * 0.45
        : speaking
          ? 1.0 + Math.sin(time * 8) * 0.06
          : 1.0 + Math.sin(time * 2.5) * 0.012
      scaleVec.set(targetScale, targetScale, targetScale)
      points.scale.lerp(scaleVec, 0.14)
      torus.scale.lerp(scaleVec, 0.14)

      // Smooth camera lean toward pointer
      camera.position.x += (mouseX * 20 - camera.position.x) * 0.04
      camera.position.y += (mouseY * 20 - camera.position.y) * 0.04
      camera.lookAt(scene.position)

      // Lerp colours toward voice or mode target
      const isRest      = modeRef.current !== 'work'
      const tintTarget  = listening ? LISTEN_TINT  : speaking ? SPEAK_TINT  : (isRest ? REST_TINT  : WORK_TINT)
      const torusTarget = listening ? LISTEN_TORUS : speaking ? SPEAK_TORUS : (isRest ? REST_TORUS : WORK_TORUS)
      material.color.lerp(tintTarget,  0.04)
      torusMat.color.lerp(torusTarget, 0.04)

      renderer.render(scene, camera)
    }
    animate()

    // Resize
    const handleResize = () => {
      if (!mount) return
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      if (pointerRafId !== null) cancelAnimationFrame(pointerRafId)
      cancelAnimationFrame(frameId)
      window.removeEventListener('mousemove', handlePointer)
      window.removeEventListener('touchmove', handlePointer)
      window.removeEventListener('resize', handleResize)
      geometry.dispose()
      material.dispose()
      texture.dispose()
      torusGeo.dispose()
      torusMat.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, []) // scene created once; mode changes handled via modeRef + lerp

  return (
    <div
      ref={mountRef}
      className="absolute inset-0 pointer-events-none"
      aria-hidden="true"
    />
  )
}
