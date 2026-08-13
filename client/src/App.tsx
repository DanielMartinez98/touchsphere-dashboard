import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
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
import { useGuides } from './hooks/useGuides'
import { useServerEvent } from './hooks/useServerEvents'
import { useNotion } from './hooks/useNotion'
import { useAppMode } from './hooks/useAppMode'
import { useVoice } from './hooks/useVoice'
import { useWakeWord } from './hooks/useWakeWord'
import { useTimers } from './hooks/useTimers'
import { useStopwatch } from './hooks/useStopwatch'
import { StatusBar } from './components/StatusBar'
import { LockScreen } from './components/LockScreen'
import { SettingsPanel } from './components/SettingsPanel'
import { MicMuteButton } from './components/MicMuteButton'
import { VoiceInterface } from './components/VoiceInterface'
import { BedtimeBanner } from './components/BedtimeBanner'
import { TimersOverlay } from './components/TimersOverlay'
import { BrowserOverlay } from './components/BrowserOverlay'
import { useAutoMode } from './hooks/useAutoSchedule'
import { useMuted } from './hooks/useMuted'
import { useAvatarEnabled, useAvatarRuntime, useAvatarFraming, useAvatarModelOverride, setAvatarRuntime, setAvatarFps, loadAvatarFramingFromServer } from './hooks/useAvatar'
import { loadAssistantFromServer, useAssistant, getAvatarModel } from './config/assistant'
import { loadVoicePitchFromServer } from './hooks/useVoicePitch'
import { playStartupSound } from './utils/sound'

// Both avatar renderers pull in heavy, single-purpose dependencies (three-vrm;
// PIXI + Live2D Cubism) that most sessions never touch — the sphere is the
// default. Loading them lazily keeps both out of the boot path entirely unless
// the setting is actually on.
const Avatar = lazy(() => import('./components/Avatar/Avatar'))
const Live2DAvatar = lazy(() => import('./components/Avatar/Live2DAvatar'))

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
  // Bumped on each orb tap; used as a React key so the burst ring remounts and
  // replays its one-shot animation every time.
  const [orbBurst, setOrbBurst] = useState(0)
  const toggle = (w: OpenWidget) => setOpen(prev => prev === w ? null : w)
  const { items, nextItem, addItem, removeItem, markDone, toggleStar, setStatus, setCover, renameItem } = useMediaList()
  const { byItem: guides, generate: generateGuide, remove: removeGuide } = useGuides()
  // Announcement for a guide that finished while the user was doing something
  // else — generation takes minutes, so nobody is watching the widget for it.
  const [guideReady, setGuideReady] = useState<string | null>(null)
  const {
    schema:      notionSchema,
    schemas:     notionSchemas,
    taskDbs:     notionTaskDbs,
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
  const muted = useMuted()
  // The assistant owns its own face: it names a model from the catalogue, so
  // changing assistant changes the avatar along with the voice. The user can
  // override that choice per assistant in Settings.
  const assistant     = useAssistant()
  const avatarEnabled = useAvatarEnabled()
  const avatarRuntime = useAvatarRuntime()
  const modelOverride = useAvatarModelOverride(assistant.id)
  // Fall back to the profile default if the override names a model that no
  // longer exists (e.g. one removed from the catalogue after being selected).
  const avatarModel   = getAvatarModel(modelOverride ?? assistant.defaultModelId)
                     ?? getAvatarModel(assistant.defaultModelId)!
  const avatarSpec    = avatarModel.spec
  // Framing is keyed by MODEL, not assistant: it describes how that particular
  // model sits in frame, so two assistants wearing the same face share it.
  const avatarFraming = useAvatarFraming(avatarModel.id)
  const showAvatar    = avatarEnabled && avatarSpec.kind !== 'sphere'
  const timers = useTimers()
  const stopwatch = useStopwatch()
  const startupPlayedRef = useRef(false)

  // Drives automatic work/rest mode switching and the bedtime alert
  // based on the user's configured schedule (Settings → Schedule tab).
  useAutoMode(mode, setMode)

  // Wake-word listener — fully offline, runs in a Web Worker. When the user
  // says the wake word ("Martin" — see config/assistant.ts) the orb starts
  // listening just like a manual tap. Paused
  // while the assistant itself is talking or already capturing audio so we
  // don't trigger on the TTS reply or fight for the mic device.
  useWakeWord({
    pause:  voice.isListening || voice.isSpeaking || voice.isTranscribing || voice.isThinking,
    onWake: () => {
      if (!startupPlayedRef.current) {
        startupPlayedRef.current = true
        void playStartupSound()
      }
      voice.startListening()
    },
  })

  // Reconcile the selected assistant (name/wake word/persona/voice) and each
  // avatar's framing with the server on mount — the server is the source of
  // truth across devices/reloads, so framing dialled in on a laptop shows up
  // on the kiosk.
  useEffect(() => {
    loadAssistantFromServer()
    loadAvatarFramingFromServer()
    loadVoicePitchFromServer()
  }, [])

  // Server-sent events, over one shared connection (see useServerEvents).
  useServerEvent('reload', useCallback(() => window.location.reload(), []))
  useServerEvent('guide', useCallback((raw: unknown) => {
    const e = (raw ?? {}) as { status?: string; title?: string }
    if (e.status !== 'ready' || !e.title) return
    setGuideReady(e.title)
    // Long enough to notice from across the room, short enough not to sit on the
    // sphere. Tapping it opens the list, where the game now shows a guide.
    window.setTimeout(() => setGuideReady(null), 20_000)
  }, []))

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
    // Fire a one-shot ring the instant the orb is tapped. The mic-permission /
    // getUserMedia round-trip adds latency before the listening ring appears,
    // so this burst confirms the primary voice trigger landed right away.
    setOrbBurst(n => n + 1)
    // Muted — startListening() will surface the "mic is muted" toast for us.
    // Bail before the startup chime so a tap that can't do anything stays quiet.
    if (muted) {
      voice.startListening()
      return
    }
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
      {/* Ambient drift — a second hue breathing in over ~90s so the backdrop
          feels alive without costing the Pi anything (opacity-only animation) */}
      <div
        aria-hidden
        className={`absolute inset-0 bg-drift ${
          isRest
            ? 'bg-[radial-gradient(ellipse_at_center,#2a0a3e_0%,transparent_70%)]'
            : 'bg-[radial-gradient(ellipse_at_center,#062434_0%,transparent_70%)]'
        }`}
      />

      {/* Centre visual — the VRM avatar when enabled in Settings, otherwise the
          particle sphere. The sphere also stays up while the avatar is still
          loading, and permanently if its model is missing or fails to parse, so
          a bad/absent .vrm can never leave the kiosk staring at a blank centre.
          Note the Avatar stays mounted on failure (it just stops rendering) —
          unmounting it on 'error' would remount it and retry in a loop. */}
      {showAvatar && (
        <Suspense fallback={null}>
          {/* Keyed by model URL so switching assistant tears the old scene down
              and loads the new face, rather than trying to reuse the scene. */}
          {avatarSpec.kind === 'live2d' ? (
            <Live2DAvatar
              key={avatarSpec.model}
              mode={mode}
              voiceListening={voice.isListening}
              voiceSpeaking={voice.isSpeaking}
              voiceVolume={voice.volume}
              modelUrl={avatarSpec.model}
              zoom={avatarFraming.zoom}
              offsetY={avatarFraming.offsetY}
              onStatus={setAvatarRuntime}
              onFps={setAvatarFps}
            />
          ) : (
            <Avatar
              key={avatarSpec.model}
              mode={mode}
              voiceListening={voice.isListening}
              voiceSpeaking={voice.isSpeaking}
              voiceVolume={voice.volume}
              modelUrl={avatarSpec.model}
              animUrl={avatarSpec.anim}
              motions={avatarSpec.motions}
              zoom={avatarFraming.zoom}
              offsetY={avatarFraming.offsetY}
              onStatus={setAvatarRuntime}
              onFps={setAvatarFps}
            />
          )}
        </Suspense>
      )}

      {(!showAvatar || avatarRuntime.status !== 'ready') && (
        <ParticleSphere
          mode={mode}
          voiceListening={voice.isListening}
          voiceSpeaking={voice.isSpeaking}
          voiceVolume={voice.volume}
        />
      )}

      {/* Central tap target — invisible circle covering the orb that toggles voice */}
      <button
        type="button"
        onClick={handleSphereTap}
        aria-label={voice.isListening ? 'Stop listening' : 'Start voice input'}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 w-[360px] h-[360px] max-w-[60vmin] max-h-[60vmin] rounded-full bg-transparent active:scale-95 transition-transform focus:outline-none"
      />

      {/* Orb tap burst — one-shot ring in the active accent, replays per tap */}
      {orbBurst > 0 && (
        <span
          key={orbBurst}
          aria-hidden
          className="orb-burst absolute left-1/2 top-1/2 z-10 w-40 h-40 rounded-full border-2 pointer-events-none"
          style={{ borderColor: 'var(--accent)' }}
        />
      )}

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
              schemas={notionSchemas}
              taskDbs={notionTaskDbs}
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
          collapsed={<MediaCollapsed nextItem={nextItem} guide={nextItem ? guides[nextItem.id] : undefined} />}
          expanded={<MediaListExpanded items={items} addItem={addItem} removeItem={removeItem} markDone={markDone} toggleStar={toggleStar} setStatus={setStatus} setCover={setCover} renameItem={renameItem} guides={guides} generateGuide={generateGuide} deleteGuide={removeGuide} />}
        />
      )}

      {/* Bottom-Right — Clock / Time (purple glow) */}
      <Widget
        position="bottom-right"
        accent={ACCENT.clock}
        isOpen={open === 'clock'}
        onToggle={() => toggle('clock')}
        collapsed={<ClockCollapsed timers={timers} stopwatch={stopwatch} />}
        expanded={<WorldClock timers={timers} stopwatch={stopwatch} />}
      />

      {/* Top-Center — Status / Mode selector */}
      <StatusBar
        mode={mode}
        hasCred={hasCred}
        setMode={setMode}
        createPassword={createPassword}
      />

      {/* Bottom-Center — Settings, with the virtual mic mute beside it */}
      <SettingsPanel />
      <MicMuteButton />

      {/* Voice interface — transcript + reply overlays (mic button removed; tap the orb) */}
      <VoiceInterface voice={voice} />

      {/* Bedtime alert toast — driven by the schedule in settings */}
      <BedtimeBanner />

      {/* A game guide finished researching. Generation runs for minutes in the
          background, so this is the only moment the user is told — tapping opens
          the list, where the game now carries its progress bar. */}
      {guideReady && (
        <button
          type="button"
          onClick={() => { setGuideReady(null); setOpen('media') }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[600] max-w-[92%] w-[480px] bg-cyan-500/20 border border-cyan-400/45 backdrop-blur-md rounded-2xl px-5 py-4 shadow-xl flex items-center gap-4 text-left active:scale-[0.98] transition-transform"
        >
          <span className="w-10 h-10 rounded-xl bg-cyan-400/25 flex items-center justify-center flex-shrink-0 text-cyan-100">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h1v1H4zM4 12h1v1H4zM4 18h1v1H4z" />
            </svg>
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-cyan-50 text-sm font-semibold truncate">Guide ready</span>
            <span className="block text-cyan-100/80 text-xs mt-0.5 truncate">{guideReady} — tap to open</span>
          </span>
        </button>
      )}

      {/* Countdown timers & alarms — glanceable pills + ringing banner */}
      <TimersOverlay timers={timers} stopwatch={stopwatch} />

      {/* Browser window — pages and videos the assistant put on screen. `hold`
          keeps a video paused for as long as she has the floor, so playback and
          the voice loop never talk over each other. */}
      <BrowserOverlay hold={voice.isListening || voice.isThinking || voice.isSpeaking} />

      {/* Lock screen — covers everything when mode is 'locked' */}
      {mode === 'locked' && (
        <LockScreen verifyPassword={verifyPassword} unlock={unlock} />
      )}
    </div>
  )
}

export default App
