// Settings → App Store, below the App Store key: which apps are listed, the
// currency money is shown in, and the two ad networks.
//
// AdMob is a Google sign-in (its API has no keys or service accounts), so it
// is the Mail tab's dance: a Google app with this dashboard's address as an
// allowed redirect, then "Sign in" in a real browser tab — from a phone or a
// computer, since Google refuses embedded browsers and the kiosk has no
// keyboard. When Mail already registered a Google app, that one is shared and
// only the redirect address and the AdMob API need adding to it. Unity Ads is
// two pasted values, proven with a one-day read before they are saved.

import { useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { AppStoreActions, AppStoreView } from '../hooks/useAppStore'
import { TouchInput } from './TouchInput'
import { Card, Hint, Section, Switch } from './settings/ui'
import { ago } from './widgets/AppStoreWidget/format'

const FIELD = 'w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[13px] placeholder:text-white/30 border border-hairline'
const BTN = 'h-11 px-4 rounded-xl text-[13px] font-semibold active:scale-95 disabled:opacity-40'
const CURRENCIES = ['USD', 'EUR', 'GBP', 'MXN', 'CAD', 'AUD', 'JPY', 'BRL']
const NETWORK_NAME: Record<string, string> = { admob: 'AdMob', unity: 'Unity Ads' }

function RunLine({ run, syncing }: { run: { at: string; ok: boolean; detail: string } | null; syncing: boolean }) {
  if (syncing && !run) return <Hint>Reading for the first time — about a minute.</Hint>
  if (!run) return <Hint>Not read yet.</Hint>
  return <Hint tone={run.ok ? 'plain' : 'error'}>{run.ok ? `Read ${ago(run.at)} · ${run.detail}` : `The last read failed ${ago(run.at)}: ${run.detail}`}</Hint>
}

function Forget({ label, onForget }: { label: string; onForget: () => void }) {
  const [sure, setSure] = useState(false)
  return sure ? (
    <div className="flex gap-2 shrink-0">
      <button type="button" onClick={() => setSure(false)} className={`${BTN} bg-white/10 text-white/60`}>Keep</button>
      <button type="button" onClick={() => { setSure(false); onForget() }} className={`${BTN} bg-red-500 text-white`}>{label}</button>
    </div>
  ) : (
    <button type="button" onClick={() => setSure(true)} className={`${BTN} bg-red-500/15 border border-red-400/30 text-red-300 shrink-0`}>Disconnect</button>
  )
}

export function AdsSettings({ view, store }: { view: AppStoreView; store: AppStoreActions }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [orgId, setOrgId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [editUnity, setEditUnity] = useState(false)
  const [copied, setCopied] = useState(false)
  const { admob, unity, googleApp } = view.ads
  const busy = store.busy === 'ads'

  return (
    <>
      <Section title="Which apps are listed"
        description="Switch off an app you do not want in the Apps corner — one that is not released yet, a test build. It leaves the list, every total and the assistant’s answers. Its figures are still kept, so switching it back on loses nothing.">
        <Card className="p-2 space-y-1">
          {view.apps.length === 0 && <p className="text-[13px] text-white/40 px-2 py-2">No apps have been read yet.</p>}
          {view.apps.map(a => (
            <div key={a.id} className="flex items-center justify-between gap-3 px-2.5 py-2">
              <div className="min-w-0">
                <div className={`text-sm font-medium truncate ${a.hidden ? 'text-white/40' : 'text-white/90'}`}>{a.name}</div>
                <div className="text-[11.5px] text-white/35 truncate">
                  {[a.store ? 'App Store' : null, ...a.networks.map(n => NETWORK_NAME[n]), a.bundleId].filter(Boolean).join(' · ')}
                </div>
              </div>
              <Switch on={!a.hidden} onChange={on => { void store.setHidden(a.id, !on) }} label={`Show ${a.name}`} />
            </div>
          ))}
        </Card>
      </Section>

      <Section title="Money is shown in"
        description="Apple states each sale in the currency the customer paid in, and the ad networks in theirs. Everything is converted to this one, at today’s rate, so it can be added up.">
        <div className="flex flex-wrap gap-2">
          {CURRENCIES.map(c => (
            <button key={c} type="button" onClick={() => { void store.setCurrency(c) }}
              className={`h-11 px-4 rounded-xl text-[13px] font-semibold border ${view.currency === c ? 'bg-cyan-500/20 border-cyan-400/40 text-cyan-100' : 'bg-white/5 border-hairline text-white/55'}`}>
              {c}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Google AdMob" description="What the AdMob ads in the apps earned, by app, ad unit, country and kind of ad. Read-only: the sign-in can see reports and nothing else.">
        {admob.connected ? (
          <Card className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-white text-sm font-semibold">Connected <span className="text-emerald-300 font-normal">· {admob.publisherId}</span></div>
                <div className="text-white/40 text-[11.5px]">reports in {admob.currency}</div>
              </div>
              <Forget label="Disconnect AdMob" onForget={() => { void store.forgetAdmob() }} />
            </div>
            <RunLine run={admob.lastRun} syncing={view.ads.syncing} />
          </Card>
        ) : (
          <Card className="p-4 space-y-3">
            <ol className="text-[12.5px] text-white/50 leading-relaxed space-y-1.5 list-decimal pl-4">
              {googleApp === 'mail' ? (
                <li>The Google app already registered for <span className="text-white/75">Mail</span> is used. Open its project at <span className="text-white/75">console.cloud.google.com</span>.</li>
              ) : (
                <li>At <span className="text-white/75">console.cloud.google.com</span>, make a project, then APIs &amp; Services → Credentials → Create credentials → <span className="text-white/75">OAuth client ID</span>, type “Web application”.</li>
              )}
              <li>APIs &amp; Services → Library → search <span className="text-white/75">AdMob API</span> → Enable.</li>
              <li>On the OAuth client, add this under <span className="text-white/75">Authorised redirect URIs</span>:</li>
            </ol>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 text-[11.5px] text-cyan-100/90 bg-black/30 rounded-lg px-3 py-2.5 break-all selectable-text">{view.admobRedirectUri}</code>
              <button type="button" className={`${BTN} bg-white/10 text-white/75 shrink-0`}
                onClick={() => { navigator.clipboard?.writeText(view.admobRedirectUri).then(() => setCopied(true)).catch(() => {}) }}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {googleApp !== 'mail' && (
              <>
                <Hint>{googleApp === 'ads' ? 'A Google app is saved. Paste another pair to replace it.' : 'Then paste the client’s ID and secret here:'}</Hint>
                <TouchInput value={clientId} onChange={setClientId} plain placeholder="Client ID — ends in .apps.googleusercontent.com" ariaLabel="Google client ID" className={FIELD} />
                <TouchInput value={clientSecret} onChange={setClientSecret} plain placeholder="Client secret" ariaLabel="Google client secret" className={FIELD} />
                <button type="button" disabled={busy || !clientId.trim() || !clientSecret.trim()} className={`${BTN} bg-white/10 border border-hairline text-white/80`}
                  onClick={() => { void store.saveGoogleApp(clientId, clientSecret).then(ok => { if (ok) { setClientId(''); setClientSecret('') } }) }}>
                  Save the Google app
                </button>
              </>
            )}
            <div className="pt-1 border-t border-white/8 space-y-2">
              <button type="button" disabled={!googleApp} className={`${BTN} bg-cyan-500/20 border border-cyan-400/30 text-cyan-100`}
                onClick={() => { window.open('/api/app-store/admob/oauth/start', '_blank', 'noopener') }}>
                Sign in with Google
              </button>
              <Hint>
                Do this from a phone or a computer, not the wall screen: Google will not sign in inside the kiosk’s browser. Use the Google account
                you open admob.google.com with. If the consent screen is in “Testing”, add that account as a test user first.
              </Hint>
            </div>
          </Card>
        )}
      </Section>

      <Section title="Unity Ads" description="What Unity Ads earned, by game, placement, country and platform, from Unity’s Monetization Stats API.">
        {unity.connected && !editUnity ? (
          <Card className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-white text-sm font-semibold">Connected <span className="text-emerald-300 font-normal">· key …{unity.keyTail}</span></div>
                <div className="text-white/40 text-[11.5px] truncate">organization {unity.orgId}</div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button type="button" onClick={() => { setOrgId(unity.orgId); setEditUnity(true) }} className={`${BTN} bg-white/10 border border-hairline text-white/70`}>Change</button>
                <Forget label="Disconnect Unity" onForget={() => { void store.forgetUnity() }} />
              </div>
            </div>
            <RunLine run={unity.lastRun} syncing={view.ads.syncing} />
          </Card>
        ) : (
          <Card className="p-4 space-y-3">
            <ol className="text-[12.5px] text-white/50 leading-relaxed space-y-1.5 list-decimal pl-4">
              <li>Open <span className="text-white/75">cloud.unity.com</span> → Monetization → Settings → <span className="text-white/75">API management</span> (older dashboards: Setup → API Access).</li>
              <li>Copy the key under <span className="text-white/75">Monetization Stats API Access</span> (or press Create API Key).</li>
              <li>Copy the <span className="text-white/75">Organization core ID</span> from the same page or the organization’s settings.</li>
            </ol>
            <TouchInput value={orgId} onChange={setOrgId} plain placeholder="Organization core ID" ariaLabel="Unity organization core ID" className={FIELD} />
            <TouchInput value={apiKey} onChange={setApiKey} plain placeholder={unity.connected ? 'API key — leave empty to keep the saved one' : 'Monetization Stats API key'} ariaLabel="Unity API key" className={FIELD} />
            <Hint>The key is tried against Unity before it is saved, and stays on this server — the browser only ever sees its last four characters.</Hint>
            <div className="flex gap-2">
              <button type="button" disabled={busy || !orgId.trim() || (!apiKey.trim() && !unity.connected)}
                className={`${BTN} bg-cyan-500/20 border border-cyan-400/30 text-cyan-100 flex items-center gap-2`}
                onClick={() => { void store.saveUnity(orgId, apiKey).then(ok => { if (ok) { setApiKey(''); setEditUnity(false) } }) }}>
                {busy && <RotateCw size={14} className="animate-spin" />}
                {busy ? 'Checking with Unity…' : 'Connect Unity Ads'}
              </button>
              {editUnity && <button type="button" onClick={() => setEditUnity(false)} className={`${BTN} bg-white/10 text-white/60`}>Cancel</button>}
            </div>
          </Card>
        )}
      </Section>
    </>
  )
}
