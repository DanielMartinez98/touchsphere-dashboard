// The collapsed Mail corner: how much is waiting, and who from.
//
// The pill answers the walking-past question and nothing else. One number when
// there is one account, and the count plus how many mailboxes it is spread
// across when there are several — because "12" and "12 across 3" are different
// answers to "do I need to sit down".

interface Props {
  /** Unread in Primary per account (and the whole inbox beside it), muted ones already excluded. */
  counts:  { email: string; unread: number; inbox?: number; error?: string }[]
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
        <>
          <span className="text-sm font-semibold text-sky-300">Primary clear</span>
          {counts.some(c => (c.inbox ?? 0) > 0) && (
            <span className="text-[11px] text-white/35 leading-tight text-center">
              {counts.reduce((n, c) => n + (c.inbox ?? 0), 0).toLocaleString()} elsewhere
            </span>
          )}
        </>
      ) : (
        <>
          <span className="text-2xl font-bold font-display tabular-nums text-white leading-none">
            {total}
          </span>
          {/* "Primary", named: the inbox as a whole was 26,540 unread on the
              mailbox this was built for, and a number that size on a wall means
              nothing. This is the count of mail a person might open. */}
          <span className="text-[11px] text-white/45 leading-tight text-center">
            {counts.length > 1
              ? `in Primary · ${withMail.length} of ${counts.length} inboxes`
              : 'in Primary'}
          </span>
        </>
      )}
    </>
  )
}
