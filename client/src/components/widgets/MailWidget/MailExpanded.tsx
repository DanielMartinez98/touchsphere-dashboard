// The Mail panel: accounts, Gmail's own labels as the filters, the list, and
// one message open.
//
// Two layers rather than a split view, the same shape the guide uses: the list
// fills the panel, and opening a message replaces it rather than squeezing it,
// because a 7" portrait screen has room for one of those things at a time. The
// round X every expanded widget carries closes the panel; a labelled back pill
// leaves the message. Those must never be the same guess.
//
// The filters are NOT invented here. They are the label list Gmail returns —
// the system ones, the category tabs, and everything the user made — so the
// filtering on the wall is the filtering they already keep in Gmail. The
// search box takes Gmail's own query syntax for the same reason.

import { useState } from 'react'
import {
  Mail, Search, RefreshCw, Star, ArrowLeft, CheckCheck, Loader2, AlertTriangle,
  Paperclip, Inbox, Tag, MailOpen,
} from 'lucide-react'
import { TouchInput } from '../../TouchInput'
import { useMailbox } from '../../../hooks/useMail'

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

  const accounts = m.status.accounts.filter(a => !a.muted)

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

      {/* Gmail's labels, in Gmail's own order, with their unread counts. */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 shrink-0">
        {m.labels.map(l => (
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
            {l.id === 'INBOX' ? <Inbox size={12} /> : l.type === 'user' ? <Tag size={12} /> : null}
            {l.name}
            {l.unread > 0 && (
              <span className="text-[10px] tabular-nums text-sky-300 font-bold">{l.unread}</span>
            )}
          </button>
        ))}
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
          {m.query ? 'Nothing matches that search.' : 'Nothing here.'}
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
    </div>
  )
}
