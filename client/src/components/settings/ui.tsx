/**
 * The building blocks every Settings tab is drawn from, so the tabs read as one
 * screen rather than eighteen: a page intro, titled sections, cards, and one
 * switch. Each tab used to carry its own copy of the same class strings and two
 * different switch designs (a pill on the left with its state written beside
 * it, and a toggle on the right), which is most of why the panel looked
 * assembled rather than designed.
 *
 * Touch rules apply as everywhere: no hover-only affordances, 44px targets.
 */
import type { ReactNode } from 'react'

/** One sentence at the top of a tab: what this page is for. */
export function PageIntro({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-white/50 leading-relaxed px-1">{children}</p>
}

/** A titled group of settings. The title says what the settings inside DO. */
export function Section({ title, description, action, children, id }: {
  title:        ReactNode
  description?: ReactNode
  action?:      ReactNode
  children?:    ReactNode
  id?:          string
}) {
  return (
    <section id={id} className="space-y-2.5">
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h3 className="set-label">{title}</h3>
          {description && (
            <p className="text-[12.5px] text-white/45 leading-relaxed mt-1">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}

/** The surface settings sit on. */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`set-card ${className}`}>{children}</div>
}

/** The one switch. Right-aligned in a row; the row's text says what it does. */
export function Switch({ on, onChange, disabled, label }: {
  on: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative w-12 h-7 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        on ? 'bg-cyan-500/75' : 'bg-white/15'
      }`}
    >
      <span className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform ${
        on ? 'translate-x-5' : 'translate-x-0'
      }`} />
    </button>
  )
}

/**
 * A setting that is on or off: what it is, what it does, and the switch. The
 * whole row is the tap target, as on a phone's own settings screen.
 */
export function SwitchRow({ title, description, on, onChange, disabled, children }: {
  title:        ReactNode
  description?: ReactNode
  on:           boolean
  onChange:     (next: boolean) => void
  disabled?:    boolean
  children?:    ReactNode
}) {
  return (
    <Card className="p-4">
      <div
        className={`flex items-center justify-between gap-4 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
        onClick={e => {
          // The switch handles its own tap; the rest of the row forwards it.
          if (disabled || (e.target as HTMLElement).closest('[role="switch"]')) return
          onChange(!on)
        }}
      >
        <div className="min-w-0">
          <p className="text-white/85 text-sm font-medium">{title}</p>
          {description && <p className="text-white/40 text-xs mt-1 leading-relaxed">{description}</p>}
        </div>
        <Switch on={on} onChange={onChange} disabled={disabled} label={typeof title === 'string' ? title : 'Toggle'} />
      </div>
      {children}
    </Card>
  )
}

/** A small explanatory line under a control. */
export function Hint({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'warn' | 'error' }) {
  const cls = tone === 'warn' ? 'text-amber-300/75' : tone === 'error' ? 'text-red-300/90' : 'text-white/35'
  return <p className={`text-[11.5px] leading-relaxed ${cls}`}>{children}</p>
}
