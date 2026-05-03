import { useState } from 'react'
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

type OpenWidget = 'calendar' | 'clock' | 'weather' | 'media' | null

function App() {
  const [open, setOpen] = useState<OpenWidget>(null)
  const toggle = (w: OpenWidget) => setOpen(prev => prev === w ? null : w)
  const { items, nextItem, addItem, removeItem, markDone } = useMediaList()

  return (
    <div className="relative w-screen h-screen bg-black overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_#0a0f2e_0%,_#000000_70%)]" />

      {/* Particle Sphere */}
      <ParticleSphere />

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
    </div>
  )
}

export default App
