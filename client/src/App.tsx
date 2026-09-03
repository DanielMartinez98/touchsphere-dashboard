import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import Widget from './components/widgets/Widget'
import ParticleSphere from './components/ParticleSphere/ParticleSphere'
import { TimeCollapsed } from './components/widgets/TimeWidget/TimeWidget'
import TimeExpanded from './components/widgets/TimeWidget/TimeExpanded'
import { PlexCollapsed, usePlexSummary } from './components/widgets/PlexWidget/PlexWidget'
import PlexExpanded from './components/widgets/PlexWidget/PlexExpanded'
import { PlexPlayer } from './components/PlexPlayer'
import { onPlexPanelRequest, usePlexStatus } from './hooks/usePlex'
import { MediaCollapsed } from './components/widgets/MediaListWidget/MediaListWidget'
import MediaListExpanded from './components/widgets/MediaListWidget/MediaListExpanded'
import { ImageCollapsed } from './components/widgets/ImageWidget/ImageWidget'
import ImageExpanded from './components/widgets/ImageWidget/ImageExpanded'
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
import { GuideOverlay } from './components/GuideOverlay'
import { ImageOverlay } from './components/ImageOverlay'
import { openGuide } from './hooks/useGuideOverlay'
import { openImage } from './hooks/useImageOverlay'
import { onDrawPanelRequest } from './hooks/useImagePrompt'
import { useImages, type Orientation } from './hooks/useImages'
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

// 'time' is the merged calendar+clock corner; 'images' is the ComfyUI corner.
type OpenWidget = 'time' | 'plex' | 'media' | 'notion' | 'images' | null

// Distinct glowing accent colour per corner.
const ACCENT = {
  plex:    '#e5a00d', // Plex amber (library, downloads, requests)
  time:    '#facc15', // yellow (calendar, clock and now the weather)
  media:   '#ef4444', // red  (collection)
  notion:  '#22c55e', // green (work tasks)
  images:  '#ec4899', // pink (drawing)
} as const

function App() {
  const [open, setOpen] = useState<OpenWidget>(null)
  // Bumped on each orb tap; used as a React key so the burst ring remounts and
  // replays its one-shot animation every time.
  const [orbBurst, setOrbBurst] = useState(0)
  const toggle = (w: OpenWidget) => setOpen(prev => prev === w ? null : w)
  const { items, nextItem, addItem, removeItem, markDone, toggleStar, setStatus, setCover, renameItem } = useMediaList()
  const {
    images, enabled: imagesEnabled, busy: imageBusy,
    styles: imageStyles, model: imageModel, setModel: setImageModel,
    quality: imageQuality, setQuality: setImageQuality,
    params: imageParams, defaults: imageDefaults, loras: imageLoras,
    autoLora: imageAutoLora, setParams: setImageParams, resetParams: resetImageParams,
    generate: generateImage, remove: removeImage,
    queue: imageQueue, queueMax: imageQueueMax, drawError: imageDrawError,
    cancel: cancelImage,
    drawingEtaMs: imageEtaMs, drawingElapsedMs: imageElapsedMs,
    prompter: imagePrompter, setPrompter: setImagePrompter, upload: uploadImage,
  } = useImages()

  // Drawing from the widget opens the same full-screen frame the assistant's
  // generate_image opens, on the same job. Without this the picture would land
  // silently in the grid behind the panel — and the twenty seconds it takes are
  // exactly when someone needs to see that something is happening.
  const drawImage = useCallback(async (
    prompt: string, orientation: Orientation, source: string, denoise: number, improve: boolean,
  ) => {
    const id = await generateImage(prompt, orientation, source, denoise, improve)
    // The prompt handed to the frame is the one the user typed. When the
    // improver is on, the server replaces it a second later and the frame picks
    // the new one up off the job's own SSE frames — so what is on screen while
    // it thinks is still recognisably the request that was made.
    if (id) openImage(id, prompt)
  }, [generateImage])
  const { byItem: guides } = useGuides()
  // Announcement for a guide that finished while the user was doing something
  // else — generation takes minutes, so nobody is watching the widget for it.
  const [guideReady, setGuideReady] = useState<{ itemId: string; title: string } | null>(null)
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
    const e = (raw ?? {}) as { status?: string; title?: string; itemId?: string }
    if (e.status !== 'ready' || !e.title || !e.itemId) return
    setGuideReady({ itemId: e.itemId, title: e.title })
    // Long enough to notice from across the room, short enough to not sit on the
    // sphere. Tapping it opens that guide.
    window.setTimeout(() => setGuideReady(null), 20_000)
  }, []))

  // "Use as prompt" in the full-screen picture viewer. It has already put the
  // prompt in the compose field; the Draw corner has to come up on it, because a
  // field nobody can see is not a prompt anyone can edit. A subscription rather
  // than a piece of derived state, because this is an event — asking twice in a
  // row has to open the panel twice, and nothing should reopen it at boot.
  useEffect(() => onDrawPanelRequest(() => setOpen('images')), [])
  useEffect(() => onPlexPanelRequest(() => setOpen('plex')), [])

  const plexStatus = usePlexStatus()
  const plexSummary = usePlexSummary(plexStatus)

  // Close the mode-dependent widget when mode changes so stale panels don't
  // linger. That pair lives in the bottom-RIGHT corner now (it moved when the
  // merged Time corner freed the slot), but the rule is unchanged.
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
    // h-dvh, not h-screen: on iOS Safari 100vh counts the URL bar as visible
    // space, so the bottom row of widgets sits permanently below the fold and
    // the "fixed" canvas is taller than the window. dvh tracks the bar as it
    // hides and shows. Identical to 100vh on the kiosk, which has no chrome.
    <div className={`relative w-screen h-dvh bg-black overflow-hidden ${isRest ? '[--accent:#8b5cf6]' : '[--accent:#06b6d4]'}`}>
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

      {/* Top-Left — Plex (amber glow): the library, what's downloading, and
          what's been asked for. The weather lived here until the media stack
          needed a corner; it moved in with the clock, whose corner already
          answers "what's the day looking like". */}
      <Widget
        position="top-left"
        accent={ACCENT.plex}
        isOpen={open === 'plex'}
        onToggle={() => toggle('plex')}
        collapsed={<PlexCollapsed status={plexStatus} summary={plexSummary} />}
        expanded={<PlexExpanded status={plexStatus} />}
      />

      {/* Top-Right — Time: calendar, clock and weather (yellow glow).
          Calendar and clock were two corners until image generation needed
          one; the weather joined when Plex needed another. All three answer
          the same question from different sides — "what's today like, what's
          next" — so one corner carries them without feeling crowded. */}
      <Widget
        position="top-right"
        accent={ACCENT.time}
        isOpen={open === 'time'}
        onToggle={() => toggle('time')}
        collapsed={<TimeCollapsed timers={timers} stopwatch={stopwatch} />}
        expanded={<TimeExpanded timers={timers} stopwatch={stopwatch} />}
      />

      {/* Bottom-Left — Draw a picture (pink glow). The tap half of the
          assistant's generate_image: same job engine, same store, same
          full-screen viewer, so a picture looks identical however it was asked
          for. */}
      <Widget
        position="bottom-left"
        accent={ACCENT.images}
        isOpen={open === 'images'}
        onToggle={() => toggle('images')}
        collapsed={
          <ImageCollapsed
            images={images}
            enabled={imagesEnabled}
            busy={imageBusy}
            queued={Math.max(0, imageQueue.length - 1)}
            etaMs={imageEtaMs}
            elapsedMs={imageElapsedMs}
          />
        }
        expanded={
          <ImageExpanded
            images={images}
            enabled={imagesEnabled}
            busy={imageBusy}
            queue={imageQueue}
            queueMax={imageQueueMax}
            drawError={imageDrawError}
            styles={imageStyles}
            model={imageModel}
            quality={imageQuality}
            params={imageParams}
            defaults={imageDefaults}
            loras={imageLoras}
            autoLora={imageAutoLora}
            onModel={setImageModel}
            onQuality={setImageQuality}
            onParams={setImageParams}
            onResetParams={resetImageParams}
            onGenerate={drawImage}
            onDelete={removeImage}
            onCancel={cancelImage}
            improveDefault={imagePrompter ? imagePrompter.enabled : null}
            onImproveChange={on => { void setImagePrompter({ enabled: on }) }}
            onUpload={uploadImage}
          />
        }
      />

      {/* Bottom-Right — Notion tasks in work mode, Media collection in
          rest/locked. This pair moved here from bottom-left when the merged
          Time corner freed the slot; the mode switch between them is unchanged. */}
      {mode === 'work' ? (
        <Widget
          position="bottom-right"
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
          position="bottom-right"
          accent={ACCENT.media}
          isOpen={open === 'media'}
          onToggle={() => toggle('media')}
          collapsed={<MediaCollapsed nextItem={nextItem} guide={nextItem ? guides[nextItem.id] : undefined} />}
          expanded={<MediaListExpanded items={items} addItem={addItem} removeItem={removeItem} markDone={markDone} toggleStar={toggleStar} setStatus={setStatus} setCover={setCover} renameItem={renameItem} guides={guides} />}
        />
      )}

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
          onClick={() => { openGuide(guideReady.itemId); setGuideReady(null) }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[600] max-w-[92%] w-[480px] bg-cyan-500/20 border border-cyan-400/45 backdrop-blur-md rounded-2xl px-5 py-4 shadow-xl flex items-center gap-4 text-left active:scale-[0.98] transition-transform"
        >
          <span className="w-10 h-10 rounded-xl bg-cyan-400/25 flex items-center justify-center flex-shrink-0 text-cyan-100">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h1v1H4zM4 12h1v1H4zM4 18h1v1H4z" />
            </svg>
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-cyan-50 text-sm font-semibold truncate">Guide ready</span>
            <span className="block text-cyan-100/80 text-xs mt-0.5 truncate">{guideReady.title} — tap to open</span>
          </span>
        </button>
      )}

      {/* Countdown timers & alarms — glanceable pills + ringing banner */}
      <TimersOverlay timers={timers} stopwatch={stopwatch} />

      {/* Browser window — pages and videos the assistant put on screen. `hold`
          keeps a video paused for as long as she has the floor, so playback and
          the voice loop never talk over each other. */}
      <BrowserOverlay hold={voice.isListening || voice.isThinking || voice.isSpeaking} />

      {/* Plex playback — a film or episode playing on the kiosk, from a tap in
          the Plex corner or a spoken play_media. Same `hold` as the browser
          window: it pauses while the assistant has the floor. Above the browser
          window and the guide, below a generated picture. */}
      <PlexPlayer hold={voice.isListening || voice.isThinking || voice.isSpeaking} />

      {/* Game guide — opened by a tap in the Watch/Play list or by the assistant
          (show_game_guide). Top-level so it can be up with every widget closed. */}
      <GuideOverlay />

      {/* Above the browser window and the guide — a picture is the thing that
          was just asked for, and it can be asked for while a video is playing. */}
      <ImageOverlay />

      {/* Lock screen — covers everything when mode is 'locked' */}
      {mode === 'locked' && (
        <LockScreen verifyPassword={verifyPassword} unlock={unlock} />
      )}
    </div>
  )
}

export default App
