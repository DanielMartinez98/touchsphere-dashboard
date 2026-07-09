import { StrictMode, Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted variable fonts (offline kiosk — no CDN at runtime).
// Inter for body text, Space Grotesk for display/numerals.
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/space-grotesk/index.css'
import './index.css'
import App from './App.tsx'
// Eagerly import data singletons so fetching starts before any widget mounts
import './hooks/useWeather'
import './hooks/useAirQuality'
import './hooks/useForecast'
// Capture runtime errors early so Settings → Debug can display them
import { installDebugLog } from './utils/debugLog'
// Suppress the phantom tap that a scroll gesture fires when the finger lifts
import { installTapGuard } from './utils/tapGuard'

installDebugLog()
installTapGuard()

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen bg-black text-white">
          <p>Something went wrong. Please reload the page.</p>
        </div>
      )
    }
    return this.props.children
  }
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found in document')

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
