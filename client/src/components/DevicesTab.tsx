// Settings → Devices — which machine does each piece of AI work.
//
// Every AI service the dashboard uses is a URL, so the choice of machine is a
// choice, not a deployment: the GPU desktop draws the pictures while the box
// under the TV hears and speaks, or the whole lot moves to the laptop for a
// week. Two things on this screen: for each SERVICE, which device does it
// (with "the server's .env" always one of the answers, so nothing here can
// take a working setup away), and the DEVICES themselves — a name, a host,
// and a Test that asks the box which of the five services it is running.
//
// Chips rather than <select>: a native dropdown opens an OS popup TouchKio
// renders badly, and the longest list here is a handful of machines.

import { useState } from 'react'
import { Check, X as XIcon, Plus, Trash2, RotateCw } from 'lucide-react'
import { TouchInput } from './TouchInput'
import { useAiDevices, type AiDevice, type AiService, type ProbeResult, type ResolvedService } from '../hooks/useAiDevices'

const SOURCE_TEXT: Record<ResolvedService['source'], string> = {
  device:  'chosen here',
  env:     'from the server’s .env',
  default: 'the built-in default',
  off:     'not configured — this service is off',
}

export default function DevicesTab() {
  const { data, error, busy, reload, addDevice, removeDevice, assign, probe } = useAiDevices()

  if (!data && !error) {
    return <p className="text-white/40 text-sm text-center py-8">Loading…</p>
  }

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      <p className="text-[12px] text-white/45 leading-relaxed">
        Each AI service is plain HTTP, so it can run on whichever machine has the hardware for it.
        Pick per service below. <span className="text-white/65">As in .env</span> is what the server was
        started with, and stays the answer for anything not chosen here — so nothing on this screen
        can take a working setup away. A change takes effect on the next request, no restart.
      </p>

      {error && (
        <p className="text-red-400/80 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">{error}</p>
      )}

      {/* ── Which device does what ── */}
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Which device does what
        </span>
        <div className="space-y-3">
          {(data?.services ?? []).map(s => (
            <ServiceCard
              key={s.id}
              service={s}
              devices={data?.devices ?? []}
              chosen={data?.assign[s.id] ?? ''}
              busy={busy}
              onPick={id => void assign(s.id, id)}
            />
          ))}
        </div>
      </div>

      {/* ── The devices ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">Devices</span>
          <button
            type="button"
            onClick={() => void reload()}
            className="flex items-center gap-1.5 text-white/30 active:text-white/60 text-xs"
            aria-label="Refresh devices"
          >
            <RotateCw size={12} /> Refresh
          </button>
        </div>
        {(data?.devices.length ?? 0) === 0 ? (
          <p className="text-[12px] text-white/40 leading-relaxed bg-white/5 border border-white/8 rounded-2xl px-4 py-3">
            No devices yet. Run <code className="text-white/60">scripts/local-ai/install.sh</code> on a
            machine to set the whole stack up there — given <code className="text-white/60">--dashboard</code>{' '}
            with this dashboard&rsquo;s address it adds itself here. Or add one by hand below.
          </p>
        ) : (
          <div className="space-y-3">
            {data!.devices.map(d => (
              <DeviceCard
                key={d.id}
                device={d}
                uses={(data!.services).filter(s => s.device?.id === d.id).map(s => s.label)}
                busy={busy}
                onProbe={() => probe(d.id)}
                onRemove={() => void removeDevice(d.id)}
              />
            ))}
          </div>
        )}
      </div>

      <AddDevice busy={busy} onAdd={addDevice} />
    </div>
  )
}

// ── One service: its chips ───────────────────────────────────────────────────

function ServiceCard({ service, devices, chosen, busy, onPick }: {
  service: ResolvedService
  devices: AiDevice[]
  chosen:  string
  busy:    boolean
  onPick:  (deviceId: string) => void
}) {
  const s = service
  return (
    <div className="bg-white/5 rounded-2xl p-4 border border-white/8 space-y-2.5">
      <div>
        <div className="text-white/85 text-sm font-medium">{s.label}</div>
        <div className="text-[12px] text-white/40 leading-relaxed">{s.hint}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Chip
          selected={chosen === '' || !devices.some(d => d.id === chosen)}
          disabled={busy}
          onClick={() => onPick('')}
          label="As in .env"
          sub={s.envUrl ? s.envUrl.replace(/^https?:\/\//, '') : 'off'}
        />
        {devices.map(d => (
          <Chip
            key={d.id}
            selected={chosen === d.id}
            disabled={busy}
            onClick={() => onPick(d.id)}
            label={d.name}
            sub={d.host}
          />
        ))}
      </div>
      <div className={`text-[12px] leading-relaxed ${s.source === 'off' ? 'text-amber-300/80' : 'text-white/45'}`}>
        {s.source === 'off'
          ? SOURCE_TEXT.off
          : <>Now: <span className="text-white/65 break-all">{s.url}</span> · {SOURCE_TEXT[s.source]}</>}
      </div>
    </div>
  )
}

function Chip({ selected, disabled, onClick, label, sub }: {
  selected: boolean; disabled: boolean; onClick: () => void; label: string; sub: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-xl px-3.5 py-2 text-left border transition-colors active:scale-[0.98] disabled:opacity-60 ${
        selected ? 'bg-violet-500/20 border-violet-400/50 text-white' : 'bg-white/5 border-white/10 text-white/60'
      }`}
    >
      <span className="block text-[13px] font-semibold leading-tight">{label}</span>
      <span className="block text-[11px] opacity-70 leading-tight mt-0.5 max-w-[180px] truncate">{sub}</span>
    </button>
  )
}

// ── One device: test and remove ──────────────────────────────────────────────

function DeviceCard({ device, uses, busy, onProbe, onRemove }: {
  device:   AiDevice
  uses:     string[]
  busy:     boolean
  onProbe:  () => Promise<ProbeResult[] | string>
  onRemove: () => void
}) {
  const [probing, setProbing]   = useState(false)
  const [results, setResults]   = useState<ProbeResult[] | null>(null)
  const [probeErr, setProbeErr] = useState<string | null>(null)
  const [confirm, setConfirm]   = useState(false)

  async function runProbe() {
    setProbing(true)
    setProbeErr(null)
    const r = await onProbe()
    if (typeof r === 'string') { setProbeErr(r); setResults(null) } else setResults(r)
    setProbing(false)
  }

  const labels: Record<AiService, string> = {
    chat: 'Language model', image: 'Pictures', tts: 'Voice out', stt: 'Voice in', rvc: 'Miku’s voice',
  }

  return (
    <div className="bg-white/5 rounded-2xl p-4 border border-white/8 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-white/85 text-sm font-medium truncate">{device.name}</div>
          <div className="text-[12px] text-white/45 break-all">{device.host}</div>
          <div className="text-[12px] text-white/35 mt-0.5">
            {uses.length > 0 ? `Does: ${uses.join(', ')}` : 'Not chosen for anything yet'}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void runProbe()}
            disabled={probing}
            className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-blue-500/20 text-blue-300 text-[13px] font-medium active:bg-blue-500/35 disabled:opacity-50"
          >
            {probing ? <span className="w-3.5 h-3.5 rounded-full border-2 border-blue-300/30 border-t-blue-300 animate-spin" /> : <Check size={14} />}
            Test
          </button>
          <button
            type="button"
            onClick={() => { if (confirm) { onRemove(); setConfirm(false) } else setConfirm(true) }}
            onBlur={() => setConfirm(false)}
            disabled={busy}
            aria-label={confirm ? `Confirm removing ${device.name}` : `Remove ${device.name}`}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-[13px] font-medium disabled:opacity-50 ${
              confirm ? 'bg-red-500/30 text-red-200' : 'bg-white/8 text-white/50 active:bg-white/15'
            }`}
          >
            <Trash2 size={14} /> {confirm ? 'Sure?' : 'Remove'}
          </button>
        </div>
      </div>

      {probeErr && <p className="text-[12px] text-red-400/80">{probeErr}</p>}
      {results && (
        <div className="rounded-xl border border-white/8 divide-y divide-white/8 overflow-hidden">
          {results.map(r => (
            <div key={r.service} className="px-3 py-2 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] text-white/70">{labels[r.service]}</div>
                <div className={`text-[11px] break-all ${r.ok ? 'text-white/45' : 'text-white/30'}`}>{r.detail}</div>
              </div>
              {r.ok
                ? <span className="flex items-center gap-1 text-emerald-400 text-[13px] tabular-nums shrink-0"><Check size={14} /> {r.ms}ms</span>
                : <span className="flex items-center gap-1 text-white/35 text-[13px] shrink-0"><XIcon size={14} /> no</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Add one by hand ──────────────────────────────────────────────────────────

function AddDevice({ busy, onAdd }: {
  busy:  boolean
  onAdd: (name: string, host: string, assign?: AiService[] | 'answering') => Promise<boolean>
}) {
  const [name, setName]       = useState('')
  const [host, setHost]       = useState('')
  const [useIt, setUseIt]     = useState(true)
  const canAdd = name.trim().length > 0 && host.trim().length > 0 && !busy

  async function submit() {
    if (!canAdd) return
    if (await onAdd(name.trim(), host.trim(), useIt ? 'answering' : undefined)) {
      setName(''); setHost('')
    }
  }

  return (
    <div>
      <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
        Add a device
      </span>
      <div className="bg-white/5 rounded-2xl p-4 border border-white/8 space-y-3">
        <TouchInput
          value={name}
          onChange={setName}
          placeholder="Name — e.g. Office PC"
          ariaLabel="Device name"
          className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[14px]"
        />
        <TouchInput
          value={host}
          onChange={setHost}
          placeholder="Address — e.g. 192.168.1.20 or gpu-box.local"
          ariaLabel="Device address"
          className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[14px]"
        />
        <p className="text-[12px] text-white/40 leading-relaxed">
          Just the machine&rsquo;s address; each service is reached on its usual port (Ollama 11434,
          ComfyUI 8188, Kokoro 8880, Whisper 8000, RVC 5050). A full URL with its own port names one
          service behind a proxy instead.
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={useIt}
          onClick={() => setUseIt(v => !v)}
          className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 border text-left transition-colors ${
            useIt ? 'bg-violet-500/15 border-violet-400/40' : 'bg-white/5 border-white/10'
          }`}
        >
          <span className={`w-11 h-6 shrink-0 rounded-full p-0.5 flex transition-colors ${
            useIt ? 'bg-violet-400/80 justify-end' : 'bg-white/15 justify-start'
          }`}>
            <span className="w-5 h-5 rounded-full bg-white shadow" />
          </span>
          <span className="text-[13px] font-semibold text-white/85">
            Use it for everything it answers
          </span>
        </button>
        <button
          type="button"
          disabled={!canAdd}
          onClick={() => void submit()}
          className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 bg-violet-500/25 text-violet-100 text-[14px] font-semibold active:bg-violet-500/40 disabled:opacity-40"
        >
          <Plus size={16} /> Add device
        </button>
      </div>
    </div>
  )
}
