// The Mail panel: accounts, Gmail's own labels as the filters, the list, and
// one message open.
//
// Two layers rather than a split view, the same shape the guide uses: the list
// fills the panel, and opening a message replaces it rather than squeezing it,
// because a 7" portrait screen has room for one of those things at a time. The
// round X every expanded widget carries closes the panel; a labelled back pill
// leaves the message. Those must never be the same guess.
//
// The filters are Gmail's own labels, but not all of them at once. Three tabs
// sit on the wall — Primary, Updates, Starred — because that is where the mail
// a person opens lives (see MAIN_TABS in useMail for the measurement behind
// it), and everything else — Social, Promotions, Forums, Spam, the whole
// inbox, the user's own labels — is one tap away behind "More". The search
// box takes Gmail's own query syntax, and "Unread" is a switch rather than a
// search term because it is the one filter used on every visit.

import { useState } from 'react'
import {
  Mail, Search, RefreshCw, Star, ArrowLeft, CheckCheck, Loader2, AlertTriangle,
  Paperclip, Inbox, Tag, MailOpen, ChevronDown, ChevronUp, EyeOff, Eye,
} from 'lucide-react'
import { TouchInput } from '../../TouchInput'
import { useMailbox, MAIN_TABS, HIDDEN_TABS } from '../../../hooks/useMail'

/** Relative for the last day, then the date — a mail list is scanned, not read. */
function when(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const mins = (Date.now() - d.getTime()) / 60_000
  if (mins < 1) return 'now'
  if (mins < 60) return `${Math.round(mins)}m`
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h`
  const days = mins / (24 * 60)
  if (days < 7) return `${Math.round(days)}d`
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

export default function MailExpanded({ open }: { open: boolean }) {
  const m = useMailbox(open)
  const [searching, setSearching] = useState(false)
  const [draft, setDraft] = useState('')
  const [more, setMore] = useState(false)

  const accounts = m.status.accounts.filter(a => !a.muted)
  const byId = new Map(m.labels.map(l => [l.id, l]))
  const mainTabs = MAIN_TABS.map(id => byId.get(id)).filter((l): l is NonNullable<typeof l> => !!l)
  // Behind "More": the noisy categories, the whole inbox, Important, and the
  // user's own labels — in that order, since the first four are the same on
  // every account and the labels are theirs.
  const moreTabs = [
    ...HIDDEN_TABS.map(id => byId.get(id)).filter((l): l is NonNullable<typeof l> => !!l),
    ...['INBOX', 'IMPORTANT'].map(id => byId.get(id)).filter((l): l is NonNullable<typeof l> => !!l),
    ...m.labels.filter(l => l.type === 'user'),
  ]
  const onMoreTab = !!m.label && !MAIN_TABS.includes(m.label as typeof MAIN_TABS[number])
  const currentName = byId.get(m.label)?.name ?? m.label

  if (!m.status.configured) {
    return (
      <div className="flex flex-col gap-3 py-6 px-1 text-center">
        <Mail size={28} className="mx-auto text-sky-300/70" />
        <p className="text-[15px] font-semibold text-white/85">Mail isn't set up yet</p>
        <p className="text-[13px] text-white/45 leading-relaxed">
          Settings → Mail walks through it: create a Google app once, then sign in to as many
          Gmail accounts as you like. Your labels become the filters here.
        </p>
      </div>
    )
  }

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col gap-3 py-6 px-1 text-center">
        <Mail size={28} className="mx-auto text-sky-300/70" />
        <p className="text-[15px] font-semibold text-white/85">No accounts signed in</p>
        <p className="text-[13px] text-white/45 leading-relaxed">
          Settings → Mail → Add an account. The sign-in opens in a browser, so it is easiest
          from a phone or a computer rather than the kiosk.
        </p>
      </div>
    )
  }

  // ── One message, open ──
  if (m.body || m.bodyLoading) {
    const b = m.body
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={m.closeMessage}
            className="h-11 px-3 rounded-xl bg-white/10 border border-hairline text-white/75
                       text-[13px] font-semibold flex items-center gap-1.5 active:scale-95"
          >
            <ArrowLeft size={15} /> Mail
          </button>
          {b && (
            <>
              <button
                type="button"
                onClick={() => void m.setFlag(b.id, { starred: !b.starred })}
                aria-label={b.starred ? 'Unstar' : 'Star'}
                className={`w-11 h-11 rounded-xl border border-hairline flex items-center justify-center
                            active:scale-90 ${b.starred ? 'bg-amber-400/20 text-amber-300' : 'bg-white/5 text-white/45'}`}
              >
                <Star size={16} fill={b.starred ? 'currentColor' : 'none'} />
              </button>
              <button
                type="button"
                onClick={() => void m.setFlag(b.id, { read: b.unread })}
                className="h-11 px-3 rounded-xl bg-white/5 border border-hairline text-white/60
                           text-[12px] font-semibold flex items-center gap-1.5 active:scale-95"
              >
                <MailOpen size={15} /> {b.unread ? 'Mark read' : 'Mark unread'}
              </button>
            </>
          )}
        </div>

        {m.bodyLoading || !b ? (
          <div className="py-10 flex justify-center text-white/40"><Loader2 size={22} className="animate-spin" /></div>
        ) : (
          <div className="flex flex-col gap-2">
            <h2 className="text-[17px] font-semibold text-white leading-snug">{b.subject}</h2>
            <div className="text-[12px] text-white/50 leading-snug">
              <span className="text-white/80">{b.fromName}</span>
              {b.fromName !== b.from && <span> · {b.from}</span>}
              <br />
              <span>to {b.to || 'you'}{b.cc ? ` · cc ${b.cc}` : ''}</span>
              <br />
              <span>{new Date(b.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
            </div>

            {b.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {b.attachments.map(a => (
                  <span key={a.filename}
                        className="text-[11px] text-white/55 bg-white/5 border border-hairline rounded-lg
                                   px-2 py-1 flex items-center gap-1.5">
                    <Paperclip size={11} /> {a.filename}
                  </span>
                ))}
              </div>
            )}

            {/* The words, not the layout. Remote HTML on a wall display means
                loading every tracking pixel in it, so the server flattens it
                and this shows the text. */}
            <p className="selectable-text whitespace-pre-wrap break-words text-[13px] leading-relaxed
                          text-white/75 bg-black/20 border border-hairline rounded-2xl p-3">
              {b.text || '(no text in this message)'}
            </p>
            {b.fromHtml && (
              <p className="text-[11px] text-white/30 leading-snug">
                This message was HTML. It is shown as text so nothing in it can load from the web.
              </p>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── The list ──
  return (
    <div className="flex flex-col gap-3">
      {/* Accounts, when there is more than one. A scroller, like every other
          horizontal chooser in this app, and never a native select. */}
      {accounts.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 shrink-0">
          {accounts.map(a => (
            <button
              key={a.email}
              type="button"
              onClick={() => m.setAccount(a.email)}
              className={`shrink-0 h-10 px-3 rounded-xl text-[12px] font-semibold border transition-colors ${
                m.account === a.email
                  ? 'bg-sky-500/25 text-white border-sky-400/40'
                  : 'bg-white/5 text-white/45 border-transparent'}`}
            >
              {a.email.split('@')[0]}
            </button>
          ))}
        </div>
      )}

      {/* The three tabs that matter, then "More" for the rest. A tab from
          behind More, once chosen, is shown in its place so the row still says
          where you are. */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 shrink-0">
        {mainTabs.map(l => (
          <button
            key={l.id}
            type="button"
            onClick={() => m.setLabel(l.id)}
            className={`shrink-0 h-10 px-3 rounded-xl text-[12px] font-semibold border flex items-center gap-1.5
                        transition-colors ${
              m.label === l.id
                ? 'bg-white/20 text-white border-white/25'
                : 'bg-white/5 text-white/45 border-transparent'}`}
          >
            {l.id === 'STARRED' ? <Star size={12} /> : <Inbox size={12} />}
            {l.name}
            {l.unread > 0 && (
              <span className="text-[10px] tabular-nums text-sky-300 font-bold">{l.unread.toLocaleString()}</span>
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setMore(v => !v)}
          aria-expanded={more}
          className={`shrink-0 h-10 px-3 rounded-xl text-[12px] font-semibold border flex items-center gap-1.5
                      transition-colors ${
            onMoreTab && !more
              ? 'bg-white/20 text-white border-white/25'
              : 'bg-white/5 text-white/45 border-transparent'}`}
        >
          {onMoreTab && !more ? currentName : 'More'}
          {more ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      {more && (
        <div className="flex flex-wrap gap-2 -mt-1 shrink-0">
          {moreTabs.map(l => (
            <button
              key={l.id}
              type="button"
              onClick={() => { m.setLabel(l.id); setMore(false) }}
              className={`h-9 px-3 rounded-xl text-[12px] font-semibold border flex items-center gap-1.5
                          transition-colors ${
                m.label === l.id
                  ? 'bg-white/20 text-white border-white/25'
                  : 'bg-white/5 text-white/45 border-transparent'}`}
            >
              {l.type === 'user' ? <Tag size={12} /> : null}
              {l.name}
              {l.unread > 0 && (
                <span className="text-[10px] tabular-nums text-white/40 font-bold">{l.unread.toLocaleString()}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* All / Unread. A switch, not a search term: it is the one filter used
          on every visit, and it is remembered per device. */}
      <div role="radiogroup" aria-label="Show" className="h-10 p-1 rounded-xl bg-white/5 border border-hairline flex shrink-0 self-start">
        <button type="button" role="radio" aria-checked={!m.unreadOnly} onClick={() => m.setUnreadOnly(false)}
          className={`h-8 px-4 rounded-lg text-[12px] font-semibold transition ${!m.unreadOnly ? 'bg-white/20 text-white' : 'text-white/45'}`}>
          All
        </button>
        <button type="button" role="radio" aria-checked={m.unreadOnly} onClick={() => m.setUnreadOnly(true)}
          className={`h-8 px-4 rounded-lg text-[12px] font-semibold transition ${m.unreadOnly ? 'bg-sky-500/30 text-sky-100' : 'text-white/45'}`}>
          Unread
        </button>
      </div>

      {/* Search, in Gmail's own syntax. Collapsed to an icon until wanted:
          typing on this device is expensive and the label row covers most of
          what anyone filters by. */}
      <div className="flex items-center gap-2 shrink-0">
        {searching ? (
          <>
            <TouchInput
              value={draft}
              onChange={setDraft}
              commitOn="done"
              placeholder='Gmail search — from:bank is:unread'
              ariaLabel="Search mail"
              className="flex-1 h-11 rounded-xl bg-white/10 border border-hairline px-3 text-[14px]"
            />
            <button
              type="button"
              onClick={() => { m.setQuery(draft); }}
              className="h-11 px-3 rounded-xl bg-sky-500/25 border border-sky-400/40 text-white
                         text-[13px] font-semibold active:scale-95"
            >
              Go
            </button>
            <button
              type="button"
              onClick={() => { setSearching(false); setDraft(''); m.setQuery('') }}
              className="h-11 px-3 rounded-xl bg-white/5 border border-hairline text-white/50
                         text-[13px] font-semibold active:scale-95"
            >
              Clear
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setSearching(true)}
              className="h-11 px-3 rounded-xl bg-white/5 border border-hairline text-white/60
                         text-[13px] font-semibold flex items-center gap-1.5 active:scale-95"
            >
              <Search size={15} /> Search
            </button>
            <button
              type="button"
              onClick={() => void m.markAllRead()}
              className="h-11 px-3 rounded-xl bg-white/5 border border-hairline text-white/60
                         text-[13px] font-semibold flex items-center gap-1.5 active:scale-95"
            >
              <CheckCheck size={15} /> Mark all read
            </button>
            <button
              type="button"
              onClick={m.refresh}
              aria-label="Refresh"
              className="w-11 h-11 ml-auto rounded-xl bg-white/5 border border-hairline text-white/50
                         flex items-center justify-center active:scale-90"
            >
              <RefreshCw size={15} className={m.loading ? 'animate-spin' : ''} />
            </button>
          </>
        )}
      </div>

      {m.query && (
        <p className="text-[11px] text-white/40 -mt-1">
          Searching <span className="text-white/70 font-mono">{m.query}</span>
        </p>
      )}

      {m.error && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 border border-amber-400/30 p-3">
          <AlertTriangle size={14} className="text-amber-300 shrink-0 mt-0.5" />
          <span className="text-[12px] text-amber-100/85 leading-snug">{m.error}</span>
        </div>
      )}

      {m.loading && m.messages.length === 0 ? (
        <div className="py-10 flex justify-center text-white/40"><Loader2 size={22} className="animate-spin" /></div>
      ) : m.messages.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-white/40">
          {m.query ? 'Nothing matches that search.'
            : m.hiddenBulk > 0 ? `Only marketing here — ${m.hiddenBulk} hidden.`
            : m.unreadOnly ? 'Nothing unread.' : 'Nothing here.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {m.messages.map(msg => (
            <li key={msg.id}>
              {/* Two tap targets, the split this app uses everywhere: the row
                  opens the message, the star is its own button. */}
              <div className={`flex items-stretch gap-1.5 rounded-xl border ${
                msg.unread ? 'bg-sky-500/[0.08] border-sky-400/25' : 'bg-white/[0.04] border-transparent'}`}>
                <button
                  type="button"
                  onClick={() => void m.openMessage(msg.id)}
                  className="min-w-0 flex-1 text-left px-3 py-2.5 active:bg-white/5 rounded-l-xl"
                >
                  <div className="flex items-baseline gap-2">
                    <span className={`text-[13px] truncate ${
                      msg.unread ? 'text-white font-semibold' : 'text-white/70'}`}>
                      {msg.fromName || msg.from}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-white/35">
                      {when(msg.date)}
                    </span>
                  </div>
                  <div className={`text-[13px] truncate ${msg.unread ? 'text-white/90' : 'text-white/55'}`}>
                    {msg.subject}
                  </div>
                  <div className="text-[11px] text-white/35 truncate">{msg.snippet}</div>
                </button>
                <button
                  type="button"
                  onClick={() => void m.setFlag(msg.id, { starred: !msg.starred })}
                  aria-label={msg.starred ? 'Unstar' : 'Star'}
                  className={`w-10 shrink-0 flex items-center justify-center rounded-r-xl active:scale-90 ${
                    msg.starred ? 'text-amber-300' : 'text-white/20'}`}
                >
                  <Star size={15} fill={msg.starred ? 'currentColor' : 'none'} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Marketing that reached a people tab, folded away rather than deleted:
          one line says how much, and shows it on request. */}
      {(m.hiddenBulk > 0 || m.showBulk) && !m.query && (
        <button
          type="button"
          onClick={() => m.setShowBulk(!m.showBulk)}
          className="h-10 rounded-xl bg-white/[0.03] border border-dashed border-white/15 text-white/45
                     text-[12px] flex items-center justify-center gap-2 active:bg-white/5"
        >
          {m.showBulk
            ? <><EyeOff size={13} /> Hide marketing again</>
            : <><Eye size={13} /> {m.hiddenBulk} marketing email{m.hiddenBulk === 1 ? '' : 's'} hidden · show</>}
        </button>
      )}

      {m.nextPage && (
        <button
          type="button"
          onClick={() => void m.loadMore()}
          disabled={m.loadingMore}
          className="h-11 rounded-xl bg-white/5 border border-hairline text-white/60 text-[13px] font-semibold
                     flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
        >
          {m.loadingMore ? <Loader2 size={15} className="animate-spin" /> : <ChevronDown size={15} />}
          Older mail
        </button>
      )}
    </div>
  )
}
