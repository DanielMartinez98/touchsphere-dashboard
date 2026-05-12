import { useState, useEffect, useRef } from 'react'
import Widget from './components/widgets/Widget'
import ParticleSphere from './components/ParticleSphere/ParticleSphere'
import { CalendarCollapsed } from './components/widgets/CalendarWidget/CalendarWidget'
import CalendarExpanded from './components/widgets/CalendarWidget/CalendarExpanded'
import { ClockCollapsed } from './components/widgets/ClockWidget/ClockWidget'
import WorldClock from './components/widgets/ClockWidget/WorldClock'
import { WeatherCollapsed } from './components/widgets/WeatherWidget/WeatherWidget'
import WeatherMap from './components/widgets/WeatherWidget/WeatherMap'
import { MediaCollapsed } from './components/widgets/MediaListWidget/MediaListWidget'
import MediaListExpanded from './components/widgets/MediaListWidget/MediaListExpanded'
import { NotionCollapsed } from './components/widgets/NotionWidget/NotionWidget'
import NotionExpanded from './components/widgets/NotionWidget/NotionExpanded'
import { useMediaList } from './hooks/useMediaList'
import { useNotion } from './hooks/useNotion'
import { useAppMode } from './hooks/useAppMode'
import { useVoice } from './hooks/useVoice'
import { useWakeWord } from './hooks/useWakeWord'
import { StatusBar } from './components/StatusBar'
import { LockScreen } from './components/LockScreen'
import { SettingsPanel } from './components/SettingsPanel'
import { VoiceInterface } from './components/VoiceInterface'
import { BedtimeBanner } from './components/BedtimeBanner'
import { useAutoMode } from './hooks/useAutoSchedule'
import { playStartupSound } from './utils/sound'

type OpenWidget = 'calendar' | 'clock' | 'weather' | 'media' | 'notion' | null

// Distinct glowing accent colour per corner.
const ACCENT = {
  weather:  '#3b82f6', // blue
  calendar: '#facc15', // yellow
  media:    '#ef4444', // red  (collection)
  notion:   '#22c55e', // green (work tasks)
  clock:    '#a855f7', // purple (time)
} as const

function App() {
  const [open, setOpen] = useState<OpenWidget>(null)
  const toggle = (w: OpenWidget) => setOpen(prev => prev === w ? null : w)
  const { items, nextItem, addItem, removeItem, markDone } = useMediaList()
  const {
    schema:      notionSchema,
    tasks:       notionTasks,
    projects:    notionProjects,
    loading:     notionLoading,
    error:       notionError,
    refresh:     notionRefresh,
    createTask:  notionCreate,
    updateTask:  notionUpdate,
  } = useNotion()
  const { mode, hasCred, setMode, createPassword, verifyPassword, unlock } = useAppMode()
  const voice = useVoice()
  const startupPlayedRef = useRef(false)

  // Drives automatic work/rest mode switching and the bedtime alert
  // based on the user's configured schedule (Settings → Schedule tab).
  useAutoMode(mode, setMode)

  // Wake-word listener — fully offline, runs in a Web Worker. When the user
  // says "jarvis" the orb starts listening just like a manual tap. Paused
  // while the assistant itself is talking or already capturing audio so we
  // don't trigger on the TTS reply or fight for the mic device.
  useWakeWord({
    pause:  voice.isListening || voice.isSpeaking || voice.isTranscribing,
    onWake: () => {
      if (!startupPlayedRef.current) {
        startupPlayedRef.current = true
        void playStartupSound()
      }
      voice.startListening()
    },
  })

  // Listen for server-sent reload event and refresh the page
  useEffect(() => {
    const es = new EventSource('/api/system/events')
    es.addEventListener('reload', () => window.location.reload())
    return () => es.close()
  }, [])

  // Close bottom-left widget when mode changes so stale panels don't linger
  useEffect(() => {
    if (mode === 'work' && open === 'media')   setOpen(null)
    if (mode !== 'work' && open === 'notion')  setOpen(null)
  }, [mode])

  const isRest = mode === 'rest' || mode === 'locked'

  /**
   * Central orb tap — primary voice trigger now that the mic button is gone.
   * On the very first activation in this session we also play a startup chime
   * (a generated C-major arpeggio — see `utils/sound.ts`).
   */
  async function handleSphereTap() {
    if (!startupPlayedRef.current) {
      startupPlayedRef.current = true
      try { await playStartupSound() } catch { /* ignore audio errors */ }
    }
    if (voice.isListening) voice.stopListening()
    else voice.startListening()
  }

  return (
    <div className={`relative w-screen h-screen bg-black overflow-hidden ${isRest ? '[--accent:#8b5cf6]' : '[--accent:#06b6d4]'}`}>
      {/* Background gradient — blue tint for work, purple tint for rest/locked */}
      <div
        className={`absolute inset-0 ${
          isRest
            ? 'bg-[radial-gradient(ellipse_at_center,#16082e_0%,#000000_70%)]'
            : 'bg-[radial-gradient(ellipse_at_center,#0a0f2e_0%,#000000_70%)]'
        }`}
      />

      {/* Particle Sphere */}
      <ParticleSphere
        mode={mode}
        voiceListening={voice.isListening}
        voiceSpeaking={voice.isSpeaking}
        voiceVolume={voice.volume}
      />

      {/* Central tap target — invisible circle covering the orb that toggles voice */}
      <button
        type="button"
        onClick={handleSphereTap}
        aria-label={voice.isListening ? 'Stop listening' : 'Start voice input'}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 w-[360px] h-[360px] max-w-[60vmin] max-h-[60vmin] rounded-full bg-transparent active:scale-95 transition-transform focus:outline-none"
      />

      {/* Top-Left — Weather (blue glow) */}
      <Widget
        position="top-left"
        accent={ACCENT.weather}
        isOpen={open === 'weather'}
        onToggle={() => toggle('weather')}
        collapsed={<WeatherCollapsed />}
        expanded={<WeatherMap />}
      />

      {/* Top-Right — Calendar (yellow glow) */}
      <Widget
        position="top-right"
        accent={ACCENT.calendar}
        isOpen={open === 'calendar'}
        onToggle={() => toggle('calendar')}
        collapsed={<CalendarCollapsed />}
        expanded={<CalendarExpanded />}
      />

      {/* Bottom-Left — Notion tasks in work mode, Media collection in rest/locked */}
      {mode === 'work' ? (
        <Widget
          position="bottom-left"
          accent={ACCENT.notion}
          isOpen={open === 'notion'}
          onToggle={() => toggle('notion')}
          collapsed={<NotionCollapsed tasks={notionTasks} loading={notionLoading} error={notionError} />}
          expanded={
            <NotionExpanded
              schema={notionSchema}
              tasks={notionTasks}
              projects={notionProjects}
              loading={notionLoading}
              error={notionError}
              onUpdate={notionUpdate}
              onCreate={notionCreate}
              onRefresh={notionRefresh}
            />
          }
        />
      ) : (
        <Widget
          position="bottom-left"
          accent={ACCENT.media}
          isOpen={open === 'media'}
          onToggle={() => toggle('media')}
          collapsed={<MediaCollapsed nextItem={nextItem} />}
          expanded={<MediaListExpanded items={items} addItem={addItem} removeItem={removeItem} markDone={markDone} />}
        />
      )}

      {/* Bottom-Right — Clock / Time (purple glow) */}
      <Widget
        position="bottom-right"
        accent={ACCENT.clock}
        isOpen={open === 'clock'}
        onToggle={() => toggle('clock')}
        collapsed={<ClockCollapsed />}
        expanded={<WorldClock />}
      />

      {/* Top-Center — Status / Mode selector */}
      <StatusBar
        mode={mode}
        hasCred={hasCred}
        setMode={setMode}
        createPassword={createPassword}
      />

      {/* Bottom-Center — Settings */}
      <SettingsPanel />

      {/* Voice interface — transcript + reply overlays (mic button removed; tap the orb) */}
      <VoiceInterface voice={voice} />

      {/* Bedtime alert toast — driven by the schedule in settings */}
      <BedtimeBanner />

      {/* Lock screen — covers everything when mode is 'locked' */}
      {mode === 'locked' && (
        <LockScreen verifyPassword={verifyPassword} unlock={unlock} />
      )}
    </div>
  )
}

export default App
