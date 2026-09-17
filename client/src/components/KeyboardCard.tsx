import { Keyboard } from 'lucide-react'
import {
  describeDevice, deviceHints, detectedKeyboardMode, setKeyboardChoice,
  useKeyboardChoice, useKeyboardMode, type KeyboardChoice,
} from '../hooks/useKeyboardMode'

// Settings → Hardware: which keyboard THIS device types with. The rule is
// automatic (the kiosk gets the on-screen board, anything with a keyboard of
// its own uses it — see useKeyboardMode), and this card shows what the rule
// decided and why, with a per-device override for the one time it is wrong.

const CHOICES: { id: KeyboardChoice; label: string }[] = [
  { id: 'auto',   label: 'Automatic' },
  { id: 'native', label: "This device's keyboard" },
  { id: 'touch',  label: 'The dashboard’s on-screen keyboard' },
]

export function KeyboardCard() {
  const choice = useKeyboardChoice()
  const mode = useKeyboardMode()
  const guess = detectedKeyboardMode()
  const device = describeDevice(deviceHints())
  const words = (m: 'touch' | 'native') => m === 'native' ? 'this device’s own keyboard' : 'the dashboard’s on-screen keyboard'

  return (
    <div className="rounded-2xl bg-white/5 border border-hairline p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Keyboard size={16} className="text-white/50" />
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">Typing on this device</span>
      </div>
      <p className="text-[12px] text-white/50 leading-relaxed">
        Text is typed with {words(mode)}. Automatic picks {words(guess)} here because this looks
        like {device}: the kiosk has no keyboard of its own, while a phone, a tablet or a computer
        has a better one than anything drawn on the page. Remembered on this device only.
      </p>
      <div className="flex flex-wrap gap-2">
        {CHOICES.map(c => (
          <button
            key={c.id}
            type="button"
            onClick={() => setKeyboardChoice(c.id)}
            className={`h-11 px-4 rounded-xl text-[13px] font-semibold transition active:scale-95 ${
              choice === c.id
                ? 'bg-cyan-500/20 text-cyan-100 border border-cyan-400/30'
                : 'bg-white/5 text-white/55 border border-transparent'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}
