import { useState, useCallback, useEffect } from 'react'

const LS_INPUT_KEY  = 'ts_audio_input_device'
const LS_OUTPUT_KEY = 'ts_audio_output_device'

export interface AudioDevice {
  deviceId: string
  label: string
  kind: 'audioinput' | 'audiooutput'
}

export interface UseAudioDevicesReturn {
  inputDevices:      AudioDevice[]
  outputDevices:     AudioDevice[]
  selectedInputId:   string
  selectedOutputId:  string
  setSelectedInput:  (id: string) => void
  setSelectedOutput: (id: string) => void
  loading: boolean
  error:   string | null
  refresh: () => Promise<void>
}

export function useAudioDevices(): UseAudioDevicesReturn {
  const [inputDevices, setInputDevices]   = useState<AudioDevice[]>([])
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([])
  const [selectedInputId, setSelectedInputId]   = useState(() =>
    localStorage.getItem(LS_INPUT_KEY) ?? 'default'
  )
  const [selectedOutputId, setSelectedOutputId] = useState(() =>
    localStorage.getItem(LS_OUTPUT_KEY) ?? 'default'
  )
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  const enumerate = useCallback(async () => {
    // navigator.mediaDevices is only available in secure contexts (https://).
    // When the app is served over plain http:// from a LAN IP, browsers block it.
    // The fix: use the Caddy HTTPS proxy — access the app via https://SERVER_IP
    if (!window.isSecureContext) {
      const msg = `Requires HTTPS. Open the app via https:// instead of http:// (current: ${window.location.origin})`
      console.warn('[AudioDevices]', msg)
      setError(msg)
      setLoading(false)
      return
    }

    if (!navigator.mediaDevices?.enumerateDevices) {
      const msg = 'Audio device enumeration is not supported in this browser / runtime.'
      console.warn('[AudioDevices]', msg)
      setError(msg)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    console.log('[AudioDevices] enumerating devices…')

    try {
      let devices = await navigator.mediaDevices.enumerateDevices()

      // Chromium only returns real labels after mic permission is granted.
      // If labels are empty, request a brief getUserMedia to unlock them.
      const hasLabels = devices.some(d => d.label !== '')
      if (!hasLabels) {
        console.log('[AudioDevices] no labels found — requesting mic permission to unlock device names')
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach(t => t.stop()) // immediately release
          devices = await navigator.mediaDevices.enumerateDevices()
          console.log('[AudioDevices] permission granted — re-enumerated with labels')
        } catch (permErr) {
          console.warn('[AudioDevices] mic permission not granted — showing generic labels:', permErr)
        }
      }

      const inputs: AudioDevice[] = devices
        .filter(d => d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label:    d.label || `Microphone ${i + 1}`,
          kind:     'audioinput',
        }))

      const outputs: AudioDevice[] = devices
        .filter(d => d.kind === 'audiooutput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label:    d.label || `Speaker ${i + 1}`,
          kind:     'audiooutput',
        }))

      console.log(`[AudioDevices] ${inputs.length} input(s):`, inputs.map(d => d.label))
      console.log(`[AudioDevices] ${outputs.length} output(s):`, outputs.map(d => d.label))

      setInputDevices(inputs)
      setOutputDevices(outputs)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[AudioDevices] enumeration error:', msg)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  // Enumerate on mount and re-enumerate if devices change (plug/unplug)
  useEffect(() => {
    void enumerate()
    const md = navigator.mediaDevices
    if (md) {
      md.addEventListener('devicechange', enumerate)
      return () => md.removeEventListener('devicechange', enumerate)
    }
  }, [enumerate])

  const setSelectedInput = useCallback((id: string) => {
    console.log(`[AudioDevices] selected input → ${id}`)
    setSelectedInputId(id)
    localStorage.setItem(LS_INPUT_KEY, id)
  }, [])

  const setSelectedOutput = useCallback((id: string) => {
    console.log(`[AudioDevices] selected output → ${id}`)
    setSelectedOutputId(id)
    localStorage.setItem(LS_OUTPUT_KEY, id)
  }, [])

  return {
    inputDevices,
    outputDevices,
    selectedInputId,
    selectedOutputId,
    setSelectedInput,
    setSelectedOutput,
    loading,
    error,
    refresh: enumerate,
  }
}
