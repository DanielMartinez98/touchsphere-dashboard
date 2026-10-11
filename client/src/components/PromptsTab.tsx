/**
 * Settings → Prompts: every piece of text this app hands a model, in one
 * place, and every one of them editable.
 *
 * Two kinds live here. The SYSTEM PROMPTS — what the assistant, the prompt
 * improver, the picture-reading model, the edit rewriter and the edit planner
 * are each told before they are asked anything — come from /api/prompts, which
 * composes each with the same function the real request uses, so the "sent
 * right now" preview cannot drift from what is sent. And the PER-MODEL TEXT —
 * what is glued in front of and after every picture prompt, and the negative —
 * which is per drawing style because it is model-specific text.
 *
 * Parts in {{braces}} are filled in by the server on every request. They are
 * the structural half (which tools exist, which styles are installed, the
 * planner's answer format), and one deleted by mistake is appended back rather
 * than dropped, so an edit here can change the wording but never break a tool.
 *
 * The behaviour switches that used to share a page with these (Improve on by
 * default, safety tags, the inpainting patch, keeping the pose) are under
 * Drawing: those are what the picture tools DO, this is what they SAY.
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { useImages, type PromptOption, type ParamsResponse } from '../hooks/useImages'
import { useServerEvent } from '../hooks/useServerEvents'
import { TouchInput } from './TouchInput'
import { AutosaveInput } from './AutosaveInput'
import { Card, Hint, PageIntro, Section } from './settings/ui'
import { btn } from './settings/buttons'

interface Placeholder { name: string; means: string }
interface Persona { id: string; name: string; text: string; defaultText: string; overridden: boolean; selected: boolean }

interface SystemPrompt {
  id:    string
  group: 'conversation' | 'pictures'
  label: string
  what:  string
  model: string
  /** The env var the model comes from, when it is not set here. */
  modelFrom?: string
  /** Present when the model is chosen on this screen ('' = server default). */
  modelSetting?: string
  modelPlaceholder?: string
  template: string
  defaultTemplate: string
  overridden: boolean
  placeholders: Placeholder[]
  personas?: Persona[]
  previewName?: string
  text: string
  followedBy?: string
  note?: string
}

interface PromptsView { prompts: SystemPrompt[]; style: { label: string } }

async function post(id: string, body: Record<string, unknown>): Promise<PromptsView | string> {
  try {
    const r = await fetch(`/api/prompts/${id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => ({})) as PromptsView & { error?: string }
    return r.ok ? j : (j.error ?? `HTTP ${r.status}`)
  } catch (e) {
    return e instanceof Error ? e.message : 'could not save'
  }
}

export function PromptsTab() {
  const [data, setData] = useState<PromptsView | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string>('assistant')

  const load = useCallback(() => {
    fetch('/api/prompts')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: PromptsView) => { setData(j); setError('') })
      .catch(e => setError(e instanceof Error ? e.message : 'could not load them'))
  }, [])
  useEffect(load, [load])
  // The improver's options are edited through the Draw store; its preview
  // here follows the same broadcast the Draw panel does.
  useServerEvent('image-prompter', load)

  const save = useCallback(async (id: string, body: Record<string, unknown>): Promise<string> => {
    const r = await post(id, body)
    if (typeof r === 'string') return r
    setData(r)
    return ''
  }, [])

  if (error && !data) return <p className="max-w-lg mx-auto py-8 text-center text-sm text-red-300">{error}</p>
  if (!data) return <p className="max-w-lg mx-auto py-8 text-center text-sm text-white/40">Loading the prompts…</p>

  const card = (p: SystemPrompt) => (
    <PromptCard key={p.id} prompt={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? '' : p.id)} onSave={save} />
  )

  return (
    <div className="space-y-7 max-w-lg mx-auto pb-6">
      <PageIntro>
        <span className="text-white/75">Reset to built-in</span> puts the original wording back. Words in <code className="text-cyan-200/90">{'{{braces}}'}</code> are filled in for you on every
        request, from what is set up on this server and the style selected now ({data.style.label || 'none'}).
      </PageIntro>

      <Section title="Conversation" description="What the assistant is told before every conversation.">
        {data.prompts.filter(p => p.group === 'conversation').map(card)}
      </Section>

      <Section title="Pictures" description="The models that help the picture tools: rewriting a prompt, reading a picture, fixing an edit, planning one.">
        {data.prompts.filter(p => p.group === 'pictures').map(card)}
      </Section>

      <StyleTextSection />
    </div>
  )
}

// ── One system prompt ─────────────────────────────────────────────────────────

function PromptCard({ prompt: p, open, onToggle, onSave }: {
  prompt: SystemPrompt
  open: boolean
  onToggle: () => void
  onSave: (id: string, body: Record<string, unknown>) => Promise<string>
}) {
  const edited = p.overridden || (p.personas?.some(x => x.overridden) ?? false)
  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full px-4 py-3.5 flex items-start gap-3 text-left active:bg-white/5">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-semibold text-white/90">{p.label}</span>
            {edited && (
              <span className="text-[10px] uppercase tracking-widest font-semibold text-cyan-200 bg-cyan-500/15 rounded-full px-2 py-0.5">
                edited
              </span>
            )}
          </span>
          <span className="block text-[12.5px] text-white/45 leading-snug mt-1">{p.what}</span>
          <span className="block text-[11px] text-white/30 mt-1.5 tabular-nums">
            {p.model || 'the server default'} · {p.text.length.toLocaleString()} characters sent
          </span>
        </span>
        {open ? <ChevronDown size={18} className="text-white/40 mt-0.5 shrink-0" />
              : <ChevronRight size={18} className="text-white/40 mt-0.5 shrink-0" />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-5 border-t border-white/8 pt-4">
          {p.personas && <PersonaEditor personas={p.personas} onSave={(profile, text) => onSave(p.id, { profile, text })} />}

          <TemplateEditor
            key={`${p.id}-tpl`}
            title={p.personas ? 'Instructions every assistant shares' : p.id === 'improver' && p.previewName !== undefined ? 'Instructions — the original' : 'Instructions'}
            value={p.template}
            defaultValue={p.defaultTemplate}
            placeholders={p.placeholders}
            rows={p.id === 'assistant' || p.id === 'planner' ? 16 : 10}
            onSave={text => onSave(p.id, { text })}
          />

          {p.id === 'improver' && <ImproverOptions />}

          {p.modelSetting !== undefined ? (
            <div className="space-y-1.5">
              <span className="set-label">Model</span>
              <AutosaveInput
                value={p.modelSetting}
                onSave={model => { void onSave(p.id, { model }) }}
                plain
                placeholder={p.modelPlaceholder ? `same as above: ${p.modelPlaceholder}` : `the server's default (${p.model || p.modelFrom})`}
                ariaLabel={`Model for ${p.label}`}
                className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-sm placeholder:text-white/30 border border-hairline"
              />
              <Hint>
                {p.modelPlaceholder
                  ? 'Leave empty to use the picture-reading model. It must be one that can see a picture.'
                  : <>Leave empty to use <code className="text-white/60">{p.modelFrom}</code> from the server. Nobody waits on this call the way they do on a spoken reply, so a slower, better model costs nothing you can feel.</>}
              </Hint>
            </div>
          ) : p.modelFrom ? (
            <Hint>Runs on <code className="text-white/60">{p.model || 'the server default'}</code>, set by <code className="text-white/60">{p.modelFrom}</code> on the server.</Hint>
          ) : null}

          <SentNow prompt={p} />
          {p.note && <Hint>{p.note}</Hint>}
        </div>
      )}
    </Card>
  )
}

/**
 * A template with a draft, Save and Reset. Edited locally and saved
 * explicitly: a paragraph typed on an on-screen keyboard saved per keystroke
 * would rewrite the store forty times. The draft follows the server while
 * nothing is being typed, so a save made on the phone shows up on the kiosk.
 */
function TemplateEditor({ title, value, defaultValue, placeholders, rows, onSave }: {
  title: string
  value: string
  defaultValue: string
  placeholders: Placeholder[]
  rows: number
  onSave: (text: string | null) => Promise<string>
}) {
  const [draft, setDraft] = useState({ text: value, base: value })
  if (draft.base !== value && draft.text === draft.base) setDraft({ text: value, base: value })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = draft.text !== value
  const isDefault = draft.text === defaultValue

  async function save() {
    setBusy(true)
    // Saving the built-in text verbatim is a reset, so it keeps following the
    // built-in when this app updates it.
    const err = await onSave(isDefault ? null : draft.text)
    setBusy(false)
    setError(err)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="set-label">{title}</span>
        {!isDefault && (
          <button type="button" onClick={() => setDraft(d => ({ ...d, text: defaultValue }))}
            className="text-[12px] font-semibold text-cyan-300/85 px-2 py-1 rounded-lg active:bg-white/10">
            Reset to built-in
          </button>
        )}
      </div>
      {placeholders.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {placeholders.map(ph => (
            <span key={ph.name} className="text-[11px] rounded-lg bg-white/5 border border-white/8 px-2 py-1 text-white/50">
              <code className="text-cyan-200/90">{`{{${ph.name}}}`}</code> {ph.means}
            </span>
          ))}
        </div>
      )}
      <TouchInput
        value={draft.text}
        onChange={text => setDraft(d => ({ ...d, text }))}
        multiline
        rows={rows}
        ariaLabel={title}
        className="w-full max-h-[24rem] overflow-y-auto bg-black/25 text-white rounded-xl px-3.5 py-3 text-[12.5px] leading-relaxed
                   placeholder:text-white/30 border border-hairline font-mono"
      />
      <div className="flex gap-2">
        <button type="button" disabled={!dirty || busy} onClick={() => void save()} className={`flex-1 ${btn.primary}`}>
          {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        {dirty && (
          <button type="button" onClick={() => setDraft(d => ({ ...d, text: value }))} className={btn.secondary}>
            Undo changes
          </button>
        )}
      </div>
      {error && <Hint tone="error">{error}</Hint>}
    </div>
  )
}

/** The assistant's personality, per profile. Opens on the one in use. */
function PersonaEditor({ personas, onSave }: {
  personas: Persona[]
  onSave: (profile: string, text: string | null) => Promise<string>
}) {
  const [pick, setPick] = useState(() => personas.find(x => x.selected)?.id ?? personas[0]?.id ?? '')
  const persona = personas.find(x => x.id === pick) ?? personas[0]
  if (!persona) return null
  return (
    <div className="space-y-2">
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {personas.map(x => (
          <button key={x.id} type="button" onClick={() => setPick(x.id)} className={`shrink-0 ${btn.chip(x.id === pick)}`}>
            {x.name}{x.selected ? ' · in use' : ''}{x.overridden ? ' *' : ''}
          </button>
        ))}
      </div>
      <TemplateEditor
        key={persona.id}
        title={`${persona.name}'s personality`}
        value={persona.text}
        defaultValue={persona.defaultText}
        placeholders={[]}
        rows={6}
        onSave={text => onSave(persona.id, text)}
      />
    </div>
  )
}

/** What the model is actually given right now, collapsed until asked for. */
function SentNow({ prompt: p }: { prompt: SystemPrompt }) {
  const [show, setShow] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button type="button" onClick={() => setShow(!show)} className={`flex-1 ${btn.secondary}`}>
          {show ? 'Hide what is sent' : `Show what is sent right now${p.previewName ? ` (${p.previewName})` : ''}`}
        </button>
        <button type="button" className={btn.secondary}
          onClick={() => { navigator.clipboard?.writeText(p.text).then(() => setCopied(true)).catch(() => setCopied(false)) }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {show && (
        <>
          <pre className="selectable-text whitespace-pre-wrap break-words text-[11px] leading-relaxed
                          text-white/60 bg-black/30 border border-hairline rounded-xl p-3 max-h-[26rem] overflow-y-auto">
            {p.text}
          </pre>
          {p.followedBy && (
            <>
              <span className="set-label">Then, as the user's message</span>
              <pre className="selectable-text whitespace-pre-wrap break-words text-[11px] text-white/50
                              bg-black/30 border border-hairline rounded-xl p-3">
                {p.followedBy}
              </pre>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── Improve my prompt: more ways of asking ───────────────────────────────────

/**
 * Extra instructions beside the original. Made and edited here; CHOSEN in the
 * Draw panel under Improve my prompt, because which way suits a picture is
 * decided while composing it. Each starts as a copy of the original and
 * nothing done to it reaches the original.
 */
function ImproverOptions() {
  const { prompter, addPromptOption, updatePromptOption, removePromptOption } = useImages()
  const [error, setError] = useState('')
  if (!prompter) return null
  const full = prompter.options.length >= prompter.maxOptions
  return (
    <div className="space-y-2.5">
      <span className="set-label">Other ways of asking</span>
      <Hint>
        Try different instructions without touching the original: each starts as a copy of it. Choose
        which one rewrites your prompts in the Draw panel, under Improve my prompt.
      </Hint>
      {prompter.options.map(option => (
        <PromptOptionEditor
          key={option.id}
          option={option}
          inUse={prompter.active === option.id}
          onSave={patch => updatePromptOption(option.id, patch)}
          onDelete={() => removePromptOption(option.id)}
        />
      ))}
      <button type="button" disabled={full} onClick={() => { void addPromptOption().then(setError) }}
        className={`w-full flex items-center justify-center gap-2 ${btn.secondary}`}>
        <Plus size={16} />
        {full ? `${prompter.maxOptions} is the most there can be` : 'New way of asking — a copy of the original'}
      </button>
      {error && <Hint tone="error">{error}</Hint>}
    </div>
  )
}

/**
 * One of the improver's extra ways of asking. Name and instructions are saved
 * together by one Save, not autosaved: a rename typed on an on-screen keyboard
 * passes through names that clash with another option on its way to the one
 * meant, and each would be a refusal.
 */
function PromptOptionEditor({ option, inUse, onSave, onDelete }: {
  option: PromptOption
  inUse:  boolean
  onSave:   (patch: { name?: string; template?: string }) => Promise<string>
  onDelete: () => Promise<string>
}) {
  const [name, setName] = useState({ text: option.name, base: option.name })
  const [text, setText] = useState({ text: option.template, base: option.template })
  if (name.base !== option.name && name.text === name.base) setName({ text: option.name, base: option.name })
  if (text.base !== option.template && text.text === text.base) setText({ text: option.template, base: option.template })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const nameChanged = name.text.trim() !== option.name
  const textChanged = text.text !== option.template
  const dirty = nameChanged || textChanged

  async function save() {
    setBusy(true)
    const err = await onSave({
      ...(nameChanged ? { name: name.text } : {}),
      ...(textChanged ? { template: text.text } : {}),
    })
    setBusy(false)
    setError(err)
    if (!err) {
      setName(n => ({ text: n.text.trim(), base: n.text.trim() }))
      setText(t => ({ text: t.text, base: t.text }))
    }
  }

  return (
    <div className={`rounded-xl p-3 border space-y-2 ${inUse ? 'bg-cyan-500/10 border-cyan-400/35' : 'bg-white/[0.03] border-hairline'}`}>
      <div className="flex items-center gap-2">
        <TouchInput
          value={name.text}
          onChange={t => setName(n => ({ ...n, text: t }))}
          ariaLabel="Name of this option"
          placeholder="A name for the Draw panel"
          className="flex-1 min-w-0 bg-white/10 text-white rounded-xl px-3 py-2.5 text-sm font-semibold
                     placeholder:text-white/30 border border-hairline"
        />
        {inUse && (
          <span className="shrink-0 text-[11px] font-semibold text-cyan-100 bg-cyan-500/20 rounded-full px-2.5 py-1">
            In use
          </span>
        )}
      </div>
      <TouchInput
        value={text.text}
        onChange={t => setText(x => ({ ...x, text: t }))}
        multiline
        rows={8}
        ariaLabel={`Instructions for ${option.name}`}
        className="w-full bg-black/25 text-white rounded-xl px-3.5 py-3 text-[12.5px] leading-relaxed
                   placeholder:text-white/30 border border-hairline font-mono"
      />
      <div className="flex gap-2">
        <button type="button" disabled={!dirty || busy} onClick={() => { void save() }} className={`flex-1 ${btn.primary}`}>
          {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        {confirmDelete ? (
          <>
            <button type="button" onClick={() => setConfirmDelete(false)} className={btn.secondary}>Keep</button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmDelete(false)
                setBusy(true)
                void onDelete().then(err => { setBusy(false); setError(err) })
              }}
              className={btn.danger}
            >
              Delete
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} aria-label={`Delete ${option.name}`}
            className={`flex items-center gap-1.5 ${btn.secondary}`}>
            <Trash2 size={15} /> Delete
          </button>
        )}
      </div>
      {confirmDelete && (
        <Hint>{inUse ? 'This one is in use; the original takes over once it is gone.' : 'The original and the other options are not affected.'}</Hint>
      )}
      {error && <Hint tone="error">{error}</Hint>}
    </div>
  )
}

// ── Per-model text ────────────────────────────────────────────────────────────

/**
 * What is silently added to every picture prompt, per drawing style: a prefix,
 * a booster after, the negative and its prefix.
 *
 * PER MODEL rather than global, for exactly the reason cfg is: this is
 * model-specific text. The booru terms NoobAI's card asks for are wasted on
 * FLUX, which has no negative at all; the house English prose is wasted on a
 * tag-trained model.
 *
 * Each field's PLACEHOLDER is the string actually in effect when the box is
 * left alone, not a hint: a blank box over a model that has a published
 * negative would read as "there isn't one".
 */
function StyleTextSection() {
  const { styles, fetchParams, setParamsForStyle } = useImages()
  const [style, setStyle] = useState('')
  const [data, setData] = useState<ParamsResponse | null>(null)
  const [draft, setDraft] = useState<Overrides>(BLANK)
  const [saved, setSaved] = useState(true)

  if (!style && styles.length > 0) setStyle(styles[0]!.id)

  // The cancelled guard is load-bearing: tapping through three models fires
  // three requests, and the slowest one winning would leave the fields
  // describing one model while the next save wrote them against another.
  useEffect(() => {
    if (!style) return
    let cancelled = false
    void fetchParams(style).then(j => {
      if (cancelled) return
      setData(j)
      setDraft({
        prefix:         j?.values?.prefix         ?? null,
        optimizations:  j?.values?.optimizations  ?? null,
        negative:       j?.values?.negative       ?? null,
        negativePrefix: j?.values?.negativePrefix ?? null,
      })
      setSaved(true)
    })
    return () => { cancelled = true }
  }, [style, fetchParams])

  const text = data?.text
  // Sampled at cfg 1: the negative is encoded and then ignored.
  const cfgOne = data?.defaults?.cfg === 1
  // No second text encode at all (FLUX). Undefined from an older server reads
  // as "it has one", the behaviour every style had before.
  const hasNegative = text?.usesNegative !== false

  const set = (key: keyof Overrides, v: string | null) => {
    setDraft(d => ({ ...d, [key]: v }))
    setSaved(false)
  }

  return (
    <Section
      title="Added to every picture prompt"
      description="For one drawing model at a time. A box left alone uses what that model's own documentation recommends, shown greyed inside it. Type to replace it, or empty a box you have taken over to add nothing."
    >
      {styles.length === 0 ? (
        <Card className="p-4"><Hint>No drawing styles yet; these appear once the image server answers.</Hint></Card>
      ) : (
        <Card className="p-4 space-y-5">
          {/* A horizontal scroller, not a dropdown: a native select opens an OS
              popup TouchKio renders badly. */}
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {styles.map(st => (
              <button key={st.id} type="button" onClick={() => setStyle(st.id)} className={`shrink-0 ${btn.chip(style === st.id)}`}>
                {st.label}
              </button>
            ))}
          </div>

          <OverrideField
            label="In front of your prompt"
            hint={'Used exactly as written, with a comma put in for you — unless it ends in punctuation like “>”, which some models use as a separator.'}
            value={draft.prefix}
            fallback={text?.prefix ?? ''}
            rows={2}
            onChange={v => set('prefix', v)}
            onReset={() => set('prefix', null)}
          />
          <OverrideField
            label="After your prompt"
            hint="Where quality tags go for models whose documentation puts them at the end."
            value={draft.optimizations}
            fallback={text?.optimizations ?? ''}
            rows={2}
            onChange={v => set('optimizations', v)}
            onReset={() => set('optimizations', null)}
          />

          {/* Absent rather than disabled: a model that cannot have a negative
              gets a sentence saying so instead of boxes whose contents could
              never reach a picture. */}
          {hasNegative ? (
            <>
              <OverrideField
                label="Negative prompt"
                hint={cfgOne
                  ? 'This style samples at guidance 1, so this has no effect yet. It is kept for the moment you raise Guidance in the Draw panel’s Advanced section.'
                  : ''}
                hintTone={cfgOne ? 'warn' : 'plain'}
                value={draft.negative}
                fallback={text?.negative ?? ''}
                rows={3}
                onChange={v => set('negative', v)}
                onReset={() => set('negative', null)}
              />
              <OverrideField
                label="In front of the negative"
                hint="Only instruction-tuned models ship one of these; most leave it empty."
                value={draft.negativePrefix}
                fallback={text?.negativePrefix ?? ''}
                rows={2}
                onChange={v => set('negativePrefix', v)}
                onReset={() => set('negativePrefix', null)}
              />
            </>
          ) : (
            <p className="text-[12px] text-white/45 leading-relaxed rounded-xl bg-white/[0.04] border border-hairline px-3 py-2.5">
              This model has no negative prompt at all. Its own guidance is to describe what you want
              rather than what you don't, so put anything you were going to avoid into the prompt as a
              positive description.
            </p>
          )}

          <button
            type="button"
            disabled={saved}
            onClick={() => { void setParamsForStyle(style, draft).then(() => setSaved(true)) }}
            className={`w-full ${btn.primary}`}
          >
            {saved ? 'Saved' : `Save for ${data?.styleLabel || 'this model'}`}
          </button>
        </Card>
      )}
    </Section>
  )
}

/** The four overridable strings, as the editor holds them. */
interface Overrides {
  prefix:         string | null
  optimizations:  string | null
  negative:       string | null
  negativePrefix: string | null
}

const BLANK: Overrides = { prefix: null, optimizations: null, negative: null, negativePrefix: null }

/**
 * One overridable piece of text, with its way back. `null` shows the model's
 * own string as a greyed placeholder; an override of '' must NOT show that
 * same placeholder — it would look like the built-in was still in effect when
 * the point of emptying the box was to switch it off.
 */
function OverrideField({
  label, hint, hintTone = 'plain', value, fallback, rows, onChange, onReset,
}: {
  label:     string
  hint?:     string
  hintTone?: 'plain' | 'warn'
  /** null = no override. */
  value:     string | null
  /** What the model itself specifies, shown when there is no override. */
  fallback:  string
  rows:      number
  onChange:  (v: string) => void
  onReset:   () => void
}) {
  const overridden = value !== null
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="set-label">{label}</span>
        {/* Absent rather than disabled while nothing is overridden: a dead
            control on a touchscreen is a tap that looks broken. */}
        {overridden && (
          <button type="button" onClick={onReset}
            className="shrink-0 text-[12px] font-semibold text-cyan-300/85 px-2 py-1 rounded-lg active:bg-white/10">
            Use the model's own
          </button>
        )}
      </div>
      <AutosaveInput
        value={value ?? ''}
        onSave={onChange}
        multiline
        rows={rows}
        placeholder={overridden ? 'nothing will be added' : (fallback || 'nothing by default')}
        ariaLabel={label}
        className="w-full bg-black/25 text-white rounded-xl px-3.5 py-3 text-[13px] leading-relaxed
                   placeholder:text-white/30 border border-hairline"
      />
      {overridden && value === '' && (
        <Hint tone="warn">Switched off: nothing will be added here. Tap "Use the model's own" to put it back.</Hint>
      )}
      {hint && <Hint tone={hintTone}>{hint}</Hint>}
    </div>
  )
}
