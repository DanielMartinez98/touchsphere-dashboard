import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppMode } from '../hooks/useAppMode'

const PIN_LEN = 4

interface Props {
  mode: AppMode
  hasCred: boolean
  setMode: (m: AppMode) => void
  createPassword: (pw: string) => Promise<void>
}

const MODE_LABEL: Record<AppMode, string> = {
  work: 'Work',
  rest: 'Rest',
  locked: 'Locked',
}

const MODE_COLORS: Record<AppMode, string> = {
  work:   'bg-cyan-500/20 border-cyan-500/50 text-cyan-300',
  rest:   'bg-emerald-500/20 border-emerald-500/50 text-emerald-300',
  locked: 'bg-amber-500/20 border-amber-500/50 text-amber-300',
}

function WorkIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
    </svg>
  )
}
function RestIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}
function LockIcon({ open = false }: { open?: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      {open
        ? <path d="M7 11V7a5 5 0 0 1 9.9-1" />
        : <path d="M7 11V7a5 5 0 0 1 10 0v4" />}
    </svg>
  )
}

const MODE_ICON: Record<AppMode, React.ReactElement> = {
  work:   <WorkIcon />,
  rest:   <RestIcon />,
  locked: <LockIcon />,
}

type Step = 'idle' | 'picker' | 'create-pw' | 'confirm-pw'

export function StatusBar({ mode, hasCred, setMode, createPassword }: Props) {
  const [step, setStep] = useState<Step>('idle')
  const [pw, setPw] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [error, setError] = useState('')

  function closePicker() {
    setStep('idle')
    setPw('')
    setPwConfirm('')
    setError('')
  }

  async function handleModeSelect(m: AppMode) {
    if (m === 'locked') {
      if (!hasCred) {
        // First time — guide user to create a password
        setStep('create-pw')
      } else {
        setMode('locked')
        setStep('idle')
      }
    } else {
      setMode(m)
      setStep('idle')
    }
  }

  async function handleCreateSubmit() {
    if (pw.length !== PIN_LEN) { setError(`Passcode must be ${PIN_LEN} digits`); return }
    if (step === 'create-pw') {
      setStep('confirm-pw')
      setError('')
      return
    }
    // confirm-pw step
    if (pw !== pwConfirm) { setError('Passcodes do not match'); return }
    await createPassword(pw)
    setMode('locked')
    closePicker()
  }

  const activeInput = step === 'confirm-pw' ? pwConfirm : pw
  const setActiveInput = step === 'confirm-pw' ? setPwConfirm : setPw

  function pressDigit(d: string) {
    if (activeInput.length >= PIN_LEN) return
    if (error) setError('')
    setActiveInput(activeInput + d)
  }

  function pressDelete() {
    if (error) setError('')
    setActiveInput(activeInput.slice(0, -1))
  }

  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
  const padKeyClass =
    'w-16 h-16 rounded-full bg-white/10 hover:bg-white/15 active:bg-white/25 text-white text-2xl font-light flex items-center justify-center transition-colors'

  return (
    <>
      {/* Pill — large, prominent top-center status badge */}
      <button
        onClick={() => setStep(s => s === 'idle' ? 'picker' : 'idle')}
        className={`absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-7 py-3.5 rounded-full border-2 text-lg font-semibold backdrop-blur-md transition-colors active:scale-95 shadow-lg ${MODE_COLORS[mode]}`}
      >
        {MODE_ICON[mode]}
        <span className="tracking-wide">{MODE_LABEL[mode]}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Mode picker dropdown */}
      {step === 'picker' && (
        <>
          <div className="fixed inset-0 z-[150]" onClick={closePicker} />
          <div className="absolute top-20 left-1/2 -translate-x-1/2 z-[200] bg-black/90 border border-white/15 rounded-2xl p-2 flex flex-col gap-1 min-w-[200px] backdrop-blur-xl shadow-2xl">
            {(['work', 'rest', 'locked'] as AppMode[]).map(m => (
              <button
                key={m}
                onClick={(e) => { e.stopPropagation(); handleModeSelect(m) }}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors ${
                  mode === m ? MODE_COLORS[m] + ' border' : 'text-white/70 hover:bg-white/10'
                }`}
              >
                {MODE_ICON[m]}
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Password creation modal — portalled to body so it sits above widgets (z-9000) */}
      {(step === 'create-pw' || step === 'confirm-pw') && createPortal(
        <div className="fixed inset-0 z-[9500] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-[#111] border border-white/15 rounded-2xl p-6 w-80 flex flex-col gap-4 shadow-2xl">
            <div>
              <h2 className="text-white font-bold text-lg">
                {step === 'create-pw' ? 'Create Lock Passcode' : 'Confirm Passcode'}
              </h2>
              <p className="text-white/40 text-xs mt-1">
                {step === 'create-pw'
                  ? `Enter a ${PIN_LEN}-digit passcode to unlock the screen.`
                  : 'Enter the same passcode again to confirm.'}
              </p>
            </div>

            {/* PIN dots */}
            <div className="flex items-center justify-center gap-4 py-2">
              {Array.from({ length: PIN_LEN }).map((_, i) => {
                const filled = i < activeInput.length
                return (
                  <div
                    key={i}
                    className={`w-3.5 h-3.5 rounded-full border-2 transition-colors ${
                      filled ? 'border-white bg-white' : 'border-white/40 bg-transparent'
                    }`}
                  />
                )
              })}
            </div>

            {/* Numeric keypad */}
            <div className="grid grid-cols-3 gap-3 justify-items-center">
              {digits.map((k) => (
                <button
                  key={k}
                  onPointerDown={(e) => { e.preventDefault(); pressDigit(k) }}
                  className={padKeyClass}
                >
                  {k}
                </button>
              ))}
              <div className="w-16 h-16" />
              <button
                onPointerDown={(e) => { e.preventDefault(); pressDigit('0') }}
                className={padKeyClass}
              >
                0
              </button>
              <button
                onPointerDown={(e) => { e.preventDefault(); pressDelete() }}
                disabled={activeInput.length === 0}
                className="w-16 h-16 rounded-full text-white/80 text-xs font-medium flex items-center justify-center transition-colors disabled:opacity-30 active:bg-white/10"
              >
                Delete
              </button>
            </div>

            {error && <p className="text-red-400 text-xs text-center">{error}</p>}

            <div className="flex gap-2">
              <button onClick={closePicker} className="flex-1 py-2.5 rounded-xl bg-white/10 text-white/70 text-sm">
                Cancel
              </button>
              <button
                onClick={handleCreateSubmit}
                disabled={activeInput.length !== PIN_LEN}
                className="flex-1 py-2.5 rounded-xl bg-[var(--accent,#06b6d4)] text-black font-bold text-sm disabled:opacity-40"
              >
                {step === 'create-pw' ? 'Next' : 'Lock'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
