import { useState } from 'react'
import type { AppMode } from '../hooks/useAppMode'
import { TouchKeyboard } from './widgets/MediaListWidget/TouchKeyboard'

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
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
    </svg>
  )
}
function RestIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}
function LockIcon({ open = false }: { open?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    if (pw.length < 4) { setError('Password must be at least 4 characters'); return }
    if (step === 'create-pw') {
      setStep('confirm-pw')
      setError('')
      return
    }
    // confirm-pw step
    if (pw !== pwConfirm) { setError('Passwords do not match'); return }
    await createPassword(pw)
    setMode('locked')
    closePicker()
  }

  const activeInput = step === 'confirm-pw' ? pwConfirm : pw
  const setActiveInput = step === 'confirm-pw' ? setPwConfirm : setPw

  return (
    <>
      {/* Pill */}
      <button
        onClick={() => setStep(s => s === 'idle' ? 'picker' : 'idle')}
        className={`absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold backdrop-blur-md transition-colors ${MODE_COLORS[mode]}`}
      >
        {MODE_ICON[mode]}
        {MODE_LABEL[mode]}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Mode picker dropdown */}
      {step === 'picker' && (
        <>
          <div className="fixed inset-0 z-[150]" onClick={closePicker} />
          <div className="absolute top-10 left-1/2 -translate-x-1/2 z-[200] bg-black/90 border border-white/15 rounded-2xl p-2 flex flex-col gap-1 min-w-[160px] backdrop-blur-xl shadow-2xl">
            {(['work', 'rest', 'locked'] as AppMode[]).map(m => (
              <button
                key={m}
                onClick={() => handleModeSelect(m)}
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

      {/* Password creation modal */}
      {(step === 'create-pw' || step === 'confirm-pw') && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-[#111] border border-white/15 rounded-2xl p-6 w-80 flex flex-col gap-4 shadow-2xl">
            <div>
              <h2 className="text-white font-bold text-lg">
                {step === 'create-pw' ? 'Create Lock Password' : 'Confirm Password'}
              </h2>
              <p className="text-white/40 text-xs mt-1">
                {step === 'create-pw'
                  ? 'This password will be required to unlock the screen.'
                  : 'Enter the same password again to confirm.'}
              </p>
            </div>

            {/* Read-only display that shows stars — keyboard fills it */}
            <div
              className="bg-white/10 rounded-xl px-4 py-3 text-white text-sm tracking-widest cursor-pointer focus:outline-none border border-white/20 min-h-[44px]"
            >
              {activeInput ? '•'.repeat(activeInput.length) : <span className="text-white/30">tap keyboard below…</span>}
            </div>

            {error && <p className="text-red-400 text-xs">{error}</p>}

            <div className="flex gap-2">
              <button onClick={closePicker} className="flex-1 py-2.5 rounded-xl bg-white/10 text-white/70 text-sm">
                Cancel
              </button>
              <button onClick={handleCreateSubmit} className="flex-1 py-2.5 rounded-xl bg-cyan-500 text-black font-bold text-sm">
                {step === 'create-pw' ? 'Next' : 'Lock'}
              </button>
            </div>
          </div>

          {/* Touch keyboard for password input */}
          <TouchKeyboard
            value={activeInput}
            onChange={setActiveInput}
            onDone={handleCreateSubmit}
          />
        </div>
      )}
    </>
  )
}
