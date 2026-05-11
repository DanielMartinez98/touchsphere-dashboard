import { useState } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { DatabaseSchema } from './notion-types'
import { TouchInput } from '../../TouchInput'
import EmojiPicker from './EmojiPicker'
import { colorBg, colorFg } from './notion-colors'
import { richTextWrite } from './notion-types'

// Edit a database's title, icon, and properties. Reuses the Notion API's PATCH
// /databases/:id endpoint via the server proxy. Property edits also flow
// through dedicated routes for clarity.

export default function DatabaseSettingsSheet({
  schema, client, onClose, onChanged,
}: {
  schema:    DatabaseSchema
  client:    NotionClient
  onClose:   () => void
  onChanged: () => void   // caller refreshes the DB after each change
}) {
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState<string | null>(null)

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true)
    setErr(null)
    try { const r = await fn(); onChanged(); return r }
    catch (e: any) { setErr(e.message ?? 'Failed'); return undefined }
    finally { setBusy(false) }
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl z-40 max-h-[88vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-3 pb-8">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
          <h3 className="text-sm font-bold text-white mb-4">Database settings</h3>

          <TitleAndIcon schema={schema} client={client} run={run} />

          <div className="border-t border-white/[0.06] my-5" />

          <h4 className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-3">Properties</h4>
          <div className="flex flex-col gap-2">
            {Object.entries(schema.properties).map(([name, p]) => (
              <PropertyRow key={name}
                name={name}
                type={(p as any).type}
                options={(p as any)[(p as any).type]?.options ?? []}
                client={client}
                dbId={schema.id}
                run={run}
                isTitle={(p as any).type === 'title'} />
            ))}
          </div>

          {err && <p className="text-xs text-red-400 mt-3">{err}</p>}
          {busy && <p className="text-xs text-white/40 mt-3">Saving…</p>}

          <button type="button" onClick={onClose}
            className="mt-6 w-full h-11 rounded-xl bg-white/[0.04] text-white/65 text-sm font-semibold active:bg-white/10">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Title + icon ─────────────────────────────────────────────────────────────

function TitleAndIcon({
  schema, client, run,
}: {
  schema: DatabaseSchema
  client: NotionClient
  run:    <T>(fn: () => Promise<T>) => Promise<T | undefined>
}) {
  const [name, setName] = useState(schema.title)
  const [pick, setPick] = useState(false)

  async function saveTitle() {
    if (!name.trim() || name.trim() === schema.title) return
    await run(() => client.updateDatabase(schema.id, { title: richTextWrite(name.trim()) }))
  }
  async function setIcon(emoji: string | null) {
    await run(() => client.updateDatabase(schema.id, { icon: emoji ? { type: 'emoji', emoji } : null }))
    setPick(false)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 items-center">
        <button type="button" onClick={() => setPick(true)}
          className="flex-shrink-0 w-11 h-11 rounded-lg bg-white/[0.06] active:bg-white/10 text-2xl">
          {schema.icon?.type === 'emoji' ? schema.icon.value
            : schema.icon?.type === 'url' ? <img src={schema.icon.value} alt="" className="w-6 h-6 rounded inline" />
            : '🗄️'}
        </button>
        <TouchInput value={name} onChange={setName} commitOn="change"
          placeholder="Database name"
          ariaLabel="Database name"
          className="flex-1 bg-white/10 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-400" />
        <button type="button" onClick={saveTitle} disabled={!name.trim() || name.trim() === schema.title}
          className="px-3 h-11 rounded-lg bg-green-500 text-black text-xs font-bold disabled:opacity-30 active:bg-green-400">
          Save
        </button>
      </div>
      {pick && (
        <EmojiPicker current={schema.icon?.type === 'emoji' ? schema.icon.value : null}
          onPick={setIcon}
          onClear={() => setIcon(null)}
          onClose={() => setPick(false)} />
      )}
    </div>
  )
}

// ── Property row (rename / delete / edit options) ────────────────────────────

function PropertyRow({
  name, type, options, client, dbId, run, isTitle,
}: {
  name:    string
  type:    string
  options: { id: string; name: string; color: string }[]
  client:  NotionClient
  dbId:    string
  run:     <T>(fn: () => Promise<T>) => Promise<T | undefined>
  isTitle: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [draft,    setDraft]    = useState(name)
  const [confirm,  setConfirm]  = useState(false)
  const [editingOptions, setEditingOptions] = useState(false)

  // Local copy of options so the user can edit + reorder before saving.
  const [opts, setOpts] = useState(options)

  async function rename() {
    if (!draft.trim() || draft.trim() === name) return
    await run(() => client.editProperty(dbId, name, { rename: draft.trim() }))
    setExpanded(false)
  }
  async function remove() {
    await run(() => client.deleteProperty(dbId, name))
    setExpanded(false)
  }
  async function saveOptions() {
    await run(() => client.editProperty(dbId, name, { options: opts.map(o => ({ name: o.name, color: o.color })) }))
    setEditingOptions(false)
  }
  function addOption() {
    setOpts(prev => [...prev, { id: `tmp_${prev.length}`, name: 'New option', color: 'gray' }])
  }
  function removeOption(i: number) {
    setOpts(prev => prev.filter((_, j) => j !== i))
  }
  function editOptionName(i: number, n: string) {
    setOpts(prev => prev.map((o, j) => j === i ? { ...o, name: n } : o))
  }
  function setOptionColor(i: number, c: string) {
    setOpts(prev => prev.map((o, j) => j === i ? { ...o, color: c } : o))
  }

  const hasOptions = type === 'select' || type === 'multi_select' || type === 'status'

  return (
    <div className="bg-white/[0.025] border border-white/[0.05] rounded-xl p-3">
      <button type="button" onClick={() => setExpanded(o => !o)}
        className="w-full flex items-center gap-2 text-left active:opacity-70">
        <span className="text-sm text-white truncate flex-1">{name}</span>
        <span className="text-[10px] text-white/35 uppercase tracking-wider">{type}</span>
        <span className="text-white/35 text-sm">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 mt-3">
          {/* Rename */}
          {!isTitle && (
            <div className="flex gap-1.5">
              <TouchInput value={draft} onChange={setDraft} commitOn="change"
                placeholder="Rename property"
                ariaLabel="Property name"
                className="flex-1 bg-white/10 text-white rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-green-400" />
              <button type="button" onClick={rename} disabled={!draft.trim() || draft.trim() === name}
                className="px-3 rounded-lg bg-green-500 text-black text-xs font-bold disabled:opacity-30 active:bg-green-400">Rename</button>
            </div>
          )}

          {/* Options editor */}
          {hasOptions && (
            editingOptions ? (
              <div className="flex flex-col gap-1.5 bg-white/[0.025] rounded-lg p-2">
                {opts.map((o, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <TouchInput value={o.name} onChange={v => editOptionName(i, v)} commitOn="change"
                      placeholder="Option name"
                      ariaLabel="Option name"
                      className="flex-1 bg-white/10 text-white rounded-md px-2 py-1.5 text-[11px] outline-none focus:ring-1 focus:ring-white/30" />
                    <ColorDot color={o.color} onClick={() => {
                      const cycle = ['default','gray','brown','orange','yellow','green','blue','purple','pink','red']
                      const idx = cycle.indexOf(o.color)
                      setOptionColor(i, cycle[(idx + 1) % cycle.length]!)
                    }} />
                    <button type="button" onClick={() => removeOption(i)}
                      className="w-6 h-6 rounded-full bg-red-500/20 text-red-300 text-[10px] active:bg-red-500/40">×</button>
                  </div>
                ))}
                <button type="button" onClick={addOption}
                  className="self-start px-2.5 py-1 rounded-full text-[10px] bg-white/[0.06] text-white/55 active:bg-white/10">+ Add option</button>
                <div className="grid grid-cols-2 gap-1.5 mt-1">
                  <button type="button" onClick={() => { setOpts(options); setEditingOptions(false) }}
                    className="h-8 rounded-md bg-white/10 text-white/60 text-[11px] active:bg-white/15">Cancel</button>
                  <button type="button" onClick={saveOptions}
                    className="h-8 rounded-md bg-green-500 text-black text-[11px] font-bold active:bg-green-400">Save options</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setEditingOptions(true)}
                className="self-start px-2.5 py-1.5 rounded-full text-[11px] bg-white/[0.06] text-white/55 active:bg-white/10">
                Edit {options.length} option{options.length === 1 ? '' : 's'}
              </button>
            )
          )}

          {/* Delete */}
          {!isTitle && (
            confirm ? (
              <div className="grid grid-cols-2 gap-1.5">
                <button type="button" onClick={() => setConfirm(false)}
                  className="h-8 rounded-md bg-white/10 text-white/60 text-[11px] active:bg-white/15">Cancel</button>
                <button type="button" onClick={remove}
                  className="h-8 rounded-md bg-red-500 text-white text-[11px] font-bold active:bg-red-600">Delete property</button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirm(true)}
                className="self-start px-2.5 py-1.5 rounded-full text-[11px] bg-red-500/10 text-red-300/70 active:bg-red-500/20">
                Delete property…
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}

function ColorDot({ color, onClick }: { color: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={`color ${color}`}
      className="w-6 h-6 rounded-full border-2 border-white/20 active:scale-90"
      style={{ background: colorBg(color, 0.5), borderColor: colorFg(color) }} />
  )
}
