// The user's own wording for the two system prompts that used to be read-only
// in Settings → Prompts: the assistant's (its personality per profile, and the
// instructions every profile shares) and the edit planner's.
//
// Both are partly STRUCTURAL — the assistant's lists the tools that are
// actually registered, the planner's lists what the image server has installed
// and ends in the JSON contract its answer is parsed against. So the editable
// text is a template, and the structural parts are placeholders filled in live
// on every request. A placeholder the user deleted is appended at the end
// rather than dropped (`fillTemplate`), because a planner that has lost its
// answer format, or an assistant that has lost its tool list, fails in ways
// nobody can debug from the screen they caused it on.
//
// `null` means "use the built-in" — the same contract as the per-style text in
// image-params.ts: an empty box is a reset, never "send nothing".

import fs from 'fs'
import path from 'path'

export interface PromptOverrides {
  /** The assistant's shared instructions, with {{…}} placeholders. */
  assistant: string | null
  /** Per assistant profile id: its personality. */
  personas:  Record<string, string>
  /** The edit planner's guidance, with {{tools}} {{styles}} {{answer}}. */
  planner:   string | null
}

const MAX_LEN = 40_000

function storePath(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* already there */ }
  return path.join(dir, 'prompts.json')
}

function clean(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.slice(0, MAX_LEN) : null
}

/** Read per request, like every other prompt store: a save takes effect on the next turn. */
export function readOverrides(): PromptOverrides {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Partial<PromptOverrides>
    const personas: Record<string, string> = {}
    if (raw.personas && typeof raw.personas === 'object') {
      for (const [id, text] of Object.entries(raw.personas)) {
        const t = clean(text)
        if (t && /^[a-z0-9_-]{1,40}$/.test(id)) personas[id] = t
      }
    }
    return { assistant: clean(raw.assistant), personas, planner: clean(raw.planner) }
  } catch {
    return { assistant: null, personas: {}, planner: null }
  }
}

/**
 * Patch one field. `null` or an empty string resets it to the built-in.
 * Write-then-rename, the memory.ts pattern.
 */
export function writeOverride(
  field: 'assistant' | 'planner' | 'persona', text: string | null, profile?: string,
): PromptOverrides {
  const next = readOverrides()
  const value = clean(text)
  if (field === 'persona') {
    if (!profile || !/^[a-z0-9_-]{1,40}$/.test(profile)) throw new Error('which assistant?')
    if (value) next.personas[profile] = value
    else delete next.personas[profile]
  } else {
    next[field] = value
  }
  const p = storePath()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    console.error('[prompts] failed to write overrides:', err)
    throw new Error('could not save the prompt')
  }
  return next
}

/**
 * Fill {{name}} placeholders from `parts`. A part whose placeholder is missing
 * from the template is appended at the end (when it has text), so the
 * structural half of a prompt survives any edit.
 */
export function fillTemplate(template: string, parts: Record<string, string>, joiner = '\n\n'): string {
  let out = template
  const missing: string[] = []
  for (const [name, value] of Object.entries(parts)) {
    const token = `{{${name}}}`
    if (out.includes(token)) out = out.split(token).join(value)
    else if (value.trim()) missing.push(value)
  }
  return missing.length > 0 ? `${out.trimEnd()}${joiner}${missing.join(joiner)}` : out
}
