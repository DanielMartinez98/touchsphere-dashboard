// The collapsed Mail corner: how much is waiting, and who from.
//
// The pill answers the walking-past question and nothing else. One number when
// there is one account, and the count plus how many mailboxes it is spread
// across when there are several — because "12" and "12 across 3" are different
// answers to "do I need to sit down".

interface Props {
  /** Unread per account, muted ones already excluded by the server. */
  counts:  { email: string; unread: number; error?: string }[]
  total:   number
  /** null while unknown, false when no account is signed in. */
  enabled: boolean | null
}

export function MailCollapsed({ counts, total, enabled }: Props) {
  const broken = counts.filter(c => c.error)
  const withMail = counts.filter(c => c.unread > 0)

  return (
    <>
      <span className="text-xs font-medium text-white/50 uppercase tracking-[0.14em]">Mail</span>

      {enabled === null ? (
        <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-sky-400 animate-spin" />
      ) : enabled === false ? (
        <span className="text-sm text-ink-dim leading-tight">Not set up</span>
      ) : broken.length === counts.length && counts.length > 0 ? (
        <span className="text-sm text-amber-300/90 leading-tight">Sign in again</span>
      ) : total === 0 ? (
        <span className="text-sm font-semibold text-sky-300">All read</span>
      ) : (
        <>
          <span className="text-2xl font-bold font-display tabular-nums text-white leading-none">
            {total}
          </span>
          <span className="text-[11px] text-white/45 leading-tight text-center">
            {counts.length > 1
              ? `unread · ${withMail.length} of ${counts.length} inboxes`
              : 'unread'}
          </span>
        </>
      )}
    </>
  )
}
