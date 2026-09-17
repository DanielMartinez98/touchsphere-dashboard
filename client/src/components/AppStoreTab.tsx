// Settings → Apps: the App Store Connect key, and nothing else.
//
// The numbers live in the Apps corner (bottom-left while the screen is set to
// work; the Apps tab on the phone) — this tab is the chore done once: an API
// key from App Store Connect, the vendor number from the payments page, the
// .p8 file. The key file can be picked from the phone's Files or pasted whole,
// and it is proven against Apple before it is saved. Afterwards the whole thing
// folds away behind a "Connected" line with the read status.

import { useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { useAppStore } from '../hooks/useAppStore'
import { TouchInput } from './TouchInput'
import { ago, inMinutes, prettyDay } from './widgets/AppStoreWidget/format'

export function AppStoreTab() {
  const { view, error, busy, save, forget, sync } = useAppStore()
  const [editing, setEditing] = useState(false)
  const [issuerId, setIssuerId] = useState({ v: '', seeded: false })
  const [keyId, setKeyId] = useState({ v: '', seeded: false })
  const [vendor, setVendor] = useState({ v: '', seeded: false })
  const [pem, setPem] = useState('')
  const [pemName, setPemName] = useState<string | null>(null)
  const [confirmForget, setConfirmForget] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  if (view && !issuerId.seeded && view.issuerId) setIssuerId({ v: view.issuerId, seeded: true })
  if (view && !keyId.seeded && view.keyId) setKeyId({ v: view.keyId, seeded: true })
  if (view && !vendor.seeded && view.vendorNumber) setVendor({ v: view.vendorNumber, seeded: true })

  const pickFile = (file: File | undefined) => {
    if (!file) return
    file.text().then(text => { setPem(text); setPemName(file.name) }).catch(() => {})
  }

  const canSave = !!issuerId.v.trim() && !!keyId.v.trim() && !!vendor.v.trim() && (!!pem.trim() || !!view?.configured)

  const onSave = () => {
    void save({ issuerId: issuerId.v, keyId: keyId.v, vendorNumber: vendor.v, privateKey: pem })
      .then(ok => { if (ok) { setPem(''); setPemName(null); setEditing(false) } })
  }

  if (!view) {
    return (
      <div className="max-w-lg mx-auto py-8 text-center text-white/40 text-sm">
        {error ? `Could not ask the server: ${error}` : 'Loading…'}
      </div>
    )
  }

  const showForm = !view.configured || editing

  return (
    <div className="space-y-5 max-w-lg mx-auto pb-4">
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Your apps on the App Store
        </span>
        <p className="text-[12px] text-white/45 leading-relaxed">
          Downloads, what each app earned, and how often it was seen — read from App Store Connect
          with a key you make once. The numbers are in the <span className="text-white/70">Apps corner</span> while
          the screen is set to work (and the Apps tab on the phone), and the assistant answers “how are
          my apps doing”. This tab only holds the key.
        </p>
      </div>

      {error && (
        <p className="text-[12px] text-red-300 leading-snug rounded-xl bg-red-500/10
                      border border-red-400/30 px-3 py-2">{error}</p>
      )}

      {view.configured && !editing && (
        <div className="rounded-2xl bg-white/5 border border-hairline p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-white text-sm font-semibold">
                Connected <span className="text-emerald-300 font-normal">· key {view.keyId}</span>
              </div>
              <div className="text-white/40 text-[11px] truncate">
                vendor {view.vendorNumber}{view.source === 'env' ? ' · from .env' : ''}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button type="button" onClick={() => setEditing(true)}
                className="h-10 px-3 rounded-xl bg-white/10 border border-hairline text-white/70 text-[12px] font-semibold active:scale-95">
                Change
              </button>
              {view.source === 'settings' && (confirmForget ? (
                <>
                  <button type="button" onClick={() => setConfirmForget(false)}
                    className="h-10 px-3 rounded-xl bg-white/10 text-white/60 text-[12px] font-medium">Keep</button>
                  <button type="button" disabled={busy === 'forget'}
                    onClick={() => { setConfirmForget(false); void forget() }}
                    className="h-10 px-3 rounded-xl bg-red-500 text-white text-[12px] font-bold">Forget key</button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmForget(true)}
                  className="h-10 px-3 rounded-xl bg-red-500/15 border border-red-400/30 text-red-300 text-[12px] font-semibold active:scale-95">
                  Forget
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 text-[11px]">
            <span className={view.lastRun && !view.lastRun.ok ? 'text-red-300' : 'text-white/40'}>
              {view.syncing
                ? 'Reading from Apple…'
                : view.lastRun
                  ? (view.lastRun.ok ? `Read ${ago(view.lastRun.at)}` : `Failed ${ago(view.lastRun.at)}: ${view.lastRun.detail}`)
                  : 'Not read yet'}
              {!view.syncing && view.nextRunAt ? ` · next in ${inMinutes(view.nextRunAt)}` : ''}
            </span>
            <button type="button" disabled={busy === 'sync' || view.syncing} onClick={() => { void sync() }}
              className="h-9 px-3 rounded-xl bg-white/10 text-white/70 text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-50 shrink-0">
              <RotateCw size={13} className={busy === 'sync' || view.syncing ? 'animate-spin' : ''} />
              Read now
            </button>
          </div>
          {view.lastRun?.ok && <p className="text-white/30 text-[11px] leading-snug">{view.lastRun.detail}</p>}
          <p className="text-white/45 text-[12px] leading-snug pt-1 border-t border-white/8">
            {view.apps.length === 0
              ? (view.syncing || !view.lastRun ? 'Reading the first three months from Apple — a minute or two.' : 'Apple lists no apps for this key yet.')
              : `${view.apps.map(a => a.name).join(', ')} · figures up to ${prettyDay(view.asOf)}. Open the Apps corner for the detail.`}
          </p>
        </div>
      )}

      {showForm && (
        <div>
          <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
            {view.configured ? 'Change the key' : '1 · An App Store Connect key'}
          </span>
          {!view.configured && (
            <ol className="text-[12px] text-white/45 leading-relaxed space-y-1 mb-3 list-decimal pl-4">
              <li>Open <span className="text-white/70">appstoreconnect.apple.com</span> → Users and Access → <span className="text-white/70">Integrations</span> → App Store Connect API.</li>
              <li>Generate a <span className="text-white/70">team key</span> with the Admin role (the analytics reports need it). Download the .p8 file — Apple lets you download it once.</li>
              <li>Copy the <span className="text-white/70">Issuer ID</span> from the top of that page and the key’s <span className="text-white/70">Key ID</span>.</li>
              <li>The <span className="text-white/70">vendor number</span> is at the top of Payments and Financial Reports.</li>
            </ol>
          )}
          <div className="space-y-2">
            <TouchInput
              value={issuerId.v}
              onChange={v => setIssuerId({ v, seeded: true })}
              plain
              placeholder="Issuer ID — 8-4-4-4-12 characters"
              ariaLabel="App Store Connect issuer id"
              className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[13px] placeholder:text-white/30 border border-hairline"
            />
            <div className="grid grid-cols-2 gap-2">
              <TouchInput
                value={keyId.v}
                onChange={v => setKeyId({ v, seeded: true })}
                plain
                placeholder="Key ID — 10 characters"
                ariaLabel="App Store Connect key id"
                className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[13px] placeholder:text-white/30 border border-hairline"
              />
              <TouchInput
                value={vendor.v}
                onChange={v => setVendor({ v, seeded: true })}
                numeric
                plain
                placeholder="Vendor number"
                ariaLabel="Vendor number"
                className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[13px] placeholder:text-white/30 border border-hairline"
              />
            </div>
            <div className="flex items-center gap-2">
              <input ref={fileRef} type="file" accept=".p8,.pem,text/plain" className="hidden"
                onChange={e => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
              <button type="button" onClick={() => fileRef.current?.click()}
                className="h-11 px-4 rounded-xl bg-white/10 border border-hairline text-white/80 text-[13px] font-semibold active:scale-95 shrink-0">
                Choose the .p8 file
              </button>
              <span className="text-[12px] text-white/45 truncate min-w-0">
                {pemName ? pemName : view.configured ? 'Saved key kept unless you pick or paste another' : 'AuthKey_XXXXXXXXXX.p8, or paste it below'}
              </span>
            </div>
            <TouchInput
              value={pem}
              onChange={setPem}
              multiline
              rows={3}
              plain
              placeholder="…or paste the key file here, BEGIN line to END line"
              ariaLabel="Private key"
              className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[12px] font-mono placeholder:text-white/30 border border-hairline"
            />
            <p className="text-[11px] text-white/35 leading-snug">
              The key is checked against Apple before it is saved, and it stays on this server’s volume — the browser only ever sees its id.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy === 'save' || !canSave}
                onClick={onSave}
                className="h-11 px-5 rounded-xl bg-cyan-500/20 border border-cyan-400/30 text-cyan-100 text-[13px] font-semibold flex items-center gap-2 active:scale-95 disabled:opacity-40"
              >
                {busy === 'save' && <RotateCw size={14} className="animate-spin" />}
                {busy === 'save' ? 'Checking with Apple…' : view.configured ? 'Save changes' : 'Connect'}
              </button>
              {view.configured && (
                <button type="button" onClick={() => { setEditing(false); setPem(''); setPemName(null) }}
                  className="h-11 px-4 rounded-xl bg-white/10 text-white/60 text-[13px] font-medium">Cancel</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
