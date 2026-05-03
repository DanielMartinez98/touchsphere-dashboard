import { useState, useEffect } from 'react'
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
import { useMediaList } from './hooks/useMediaList'
import { useAppMode } from './hooks/useAppMode'
import { StatusBar } from './components/StatusBar'
import { LockScreen } from './components/LockScreen'
import { SettingsPanel } from './components/SettingsPanel'

type OpenWidget = 'calendar' | 'clock' | 'weather' | 'media' | null

function App() {
  const [open, setOpen] = useState<OpenWidget>(null)
  const toggle = (w: OpenWidget) => setOpen(prev => prev === w ? null : w)
  const { items, nextItem, addItem, removeItem, markDone } = useMediaList()
  const { mode, hasCred, setMode, createPassword, verifyPassword, unlock } = useAppMode()
  const [offline, setOffline] = useState(false)

  // Listen for server-sent shutdown event
  useEffect(() => {
    const es = new EventSource('/api/system/events')
    es.addEventListener('shutdown', () => setOffline(true))
    return () => es.close()
  }, [])

  if (offline) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center gap-4 select-none">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="opacity-30">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <p className="text-white/25 text-sm tracking-widest uppercase">System offline</p>
      </div>
    )
  }

  const isRest = mode === 'rest' || mode === 'locked'

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
      <ParticleSphere mode={mode} />

      {/* Top-Left — Weather */}
      <Widget
        position="top-left"
        isOpen={open === 'weather'}
        onToggle={() => toggle('weather')}
        collapsed={<WeatherCollapsed />}
        expanded={<WeatherMap />}
      />

      {/* Top-Right — Calendar */}
      <Widget
        position="top-right"
        isOpen={open === 'calendar'}
        onToggle={() => toggle('calendar')}
        collapsed={<CalendarCollapsed />}
        expanded={<CalendarExpanded />}
      />

      {/* Bottom-Left — Media List */}
      <Widget
        position="bottom-left"
        isOpen={open === 'media'}
        onToggle={() => toggle('media')}
        collapsed={<MediaCollapsed nextItem={nextItem} />}
        expanded={<MediaListExpanded items={items} addItem={addItem} removeItem={removeItem} markDone={markDone} />}
      />

      {/* Bottom-Right — Clock */}
      <Widget
        position="bottom-right"
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

      {/* Lock screen — covers everything when mode is 'locked' */}
      {mode === 'locked' && (
        <LockScreen verifyPassword={verifyPassword} unlock={unlock} />
      )}
    </div>
  )
}

export default App
