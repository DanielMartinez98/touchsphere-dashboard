import { useState, useEffect } from 'react'

interface Props {
  verifyPassword: (input: string) => Promise<boolean>
  unlock: () => void
}

const MAX_LEN = 4

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

  async function submit(code: string) {
    if (checking) return
    setChecking(true)
    setError(false)
    const ok = await verifyPassword(code)
    setChecking(false)
    if (ok) {
      unlock()
    } else {
      setError(true)
      setInput('')
    }
  }

  function pressDigit(d: string) {
    if (checking) return
    if (error) setError(false)
    if (input.length >= MAX_LEN) return
    const next = input + d
    setInput(next)
    if (next.length === MAX_LEN) {
      submit(next)
    }
  }

  function pressDelete() {
    if (checking) return
    if (error) setError(false)
    setInput((v) => v.slice(0, -1))
  }

  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
  const keyClass =
    'w-16 h-16 rounded-full bg-white/10 hover:bg-white/15 active:bg-white/25 text-white text-2xl font-light flex items-center justify-center transition-colors disabled:opacity-40'

  return (
    <div className="fixed inset-0 z-[9999] bg-black/95 backdrop-blur-xl flex flex-col items-center justify-start pt-6 select-none">
      {/* Clock */}
      <div className="flex flex-col items-center gap-1 mb-4">
        <span className="text-white font-thin text-6xl tracking-tight">{timeStr}</span>
        <span className="text-white/50 text-sm">{dateStr}</span>
      </div>

      {/* Lock icon */}
      <svg className="mb-3 text-white/30" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>

      {/* PIN dots */}
      <div className="mb-1">
        <div className="flex items-center justify-center gap-4 min-h-[24px]">
          {Array.from({ length: MAX_LEN }).map((_, i) => {
            const filled = i < input.length
            return (
              <div
                key={i}
                className={`w-3.5 h-3.5 rounded-full border-2 transition-colors ${
                  error
                    ? 'border-red-500/70 bg-red-500/30'
                    : filled
                      ? 'border-white bg-white'
                      : 'border-white/40 bg-transparent'
                }`}
              />
            )
          })}
        </div>
        <p className={`text-xs text-center mt-2 transition-opacity ${error ? 'text-red-400 opacity-100' : 'opacity-0'}`}>
          Incorrect passcode
        </p>
      </div>

      {/* Numeric keypad */}
      <div className="mt-1 grid grid-cols-3 gap-3">
        {digits.map((k) => (
          <button
            key={k}
            onPointerDown={(e) => {
              e.preventDefault()
              pressDigit(k)
            }}
            disabled={checking}
            className={keyClass}
          >
            {k}
          </button>
        ))}
        <div className="w-16 h-16" />
        <button
          onPointerDown={(e) => {
            e.preventDefault()
            pressDigit('0')
          }}
          disabled={checking}
          className={keyClass}
        >
          0
        </button>
        <button
          onPointerDown={(e) => {
            e.preventDefault()
            pressDelete()
          }}
          disabled={checking || input.length === 0}
          className="w-16 h-16 rounded-full text-white/80 text-xs font-medium flex items-center justify-center transition-colors disabled:opacity-30 active:bg-white/10"
        >
          Delete
        </button>
      </div>
    </div>
  )
}
