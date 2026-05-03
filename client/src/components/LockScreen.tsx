import { useState, useEffect } from 'react'
import { TouchKeyboard } from './widgets/MediaListWidget/TouchKeyboard'

interface Props {
  verifyPassword: (input: string) => Promise<boolean>
  unlock: () => void
}

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function LockScreen({ verifyPassword, unlock }: Props) {
  const now = useClock()
  const [input, setInput] = useState('')
  const [error, setError] = useState(false)
  const [checking, setChecking] = useState(false)

  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const dateStr = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

  async function handleSubmit() {
    if (!input || checking) return
    setChecking(true)
    setError(false)
    const ok = await verifyPassword(input)
    setChecking(false)
    if (ok) {
      unlock()
    } else {
      setError(true)
      setInput('')
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-black/95 backdrop-blur-xl flex flex-col items-center justify-start pt-16 select-none">
      {/* Clock */}
      <div className="flex flex-col items-center gap-1 mb-12">
        <span className="text-white font-thin text-8xl tracking-tight">{timeStr}</span>
        <span className="text-white/50 text-lg">{dateStr}</span>
      </div>

      {/* Lock icon */}
      <svg className="mb-6 text-white/30" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>

      {/* Password entry display */}
      <div className="w-72 mb-3">
        <div
          className={`bg-white/8 border rounded-xl px-4 py-3 text-white text-center text-xl tracking-widest min-h-[52px] flex items-center justify-center transition-colors ${
            error ? 'border-red-500/60 bg-red-500/10' : 'border-white/20'
          }`}
        >
          {input
            ? '•'.repeat(input.length)
            : <span className="text-white/25 text-sm font-normal">Enter password</span>}
        </div>
        {error && (
          <p className="text-red-400 text-sm text-center mt-2">Incorrect password</p>
        )}
      </div>

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={!input || checking}
        className="w-72 py-3 rounded-xl bg-[var(--accent,#06b6d4)] text-black font-bold text-base disabled:opacity-40 active:scale-95 transition-transform mb-4"
      >
        {checking ? 'Checking…' : 'Unlock'}
      </button>

      {/* Touch keyboard pinned to bottom */}
      <TouchKeyboard value={input} onChange={setInput} onDone={handleSubmit} />
    </div>
  )
}
