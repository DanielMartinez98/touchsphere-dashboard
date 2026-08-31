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

class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error: unknown) {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  // Without this the boundary swallows the error silently and all anyone ever
  // sees is "something went wrong" — which is unactionable, and on a kiosk with
  // no devtools it's the only clue there is. Log it, and show it.
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[fatal] uncaught render error:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 h-dvh bg-black text-white px-8 text-center">
          <p>Something went wrong.</p>
          {this.state.message && (
            <p className="text-white/40 text-xs font-mono break-words max-w-full">
              {this.state.message}
            </p>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-xl px-5 py-3 bg-white/10 border border-white/15 active:bg-white/20 text-sm"
          >
            Reload
          </button>
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
