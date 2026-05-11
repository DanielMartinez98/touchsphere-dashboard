import type { NotionClient } from '../../../hooks/useNotionClient'

// Long-press action menu for a single DB row. Open, Duplicate, Copy link,
// Archive — all wired through the existing useNotionClient surface.

export default function RowContextSheet({
  rowId, rowTitle, rowUrl, client, onClose, onChanged,
}: {
  rowId:     string
  rowTitle:  string
  rowUrl?:   string | null
  client:    NotionClient
  onClose:   () => void
  onChanged: () => void
}) {
  async function duplicate() {
    try {
      const { id } = await client.duplicatePage(rowId)
      // After duplicating, jump straight into the copy so the user can edit
      // any defaults that were carried over.
      client.navigate({ kind: 'page', id })
    } catch { /* surfaced upstream if needed */ }
    onClose()
  }
  async function archive() {
    try { await client.archivePage(rowId) }
    finally { onChanged(); onClose() }
  }
  function copyLink() {
    if (!rowUrl) return
    try { navigator.clipboard?.writeText(rowUrl) } catch { /* no clipboard — ignore */ }
    onClose()
  }

  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl px-4 pt-3 pb-8 z-50"
           onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
        <p className="text-xs text-white/45 mb-3 px-1 truncate">{rowTitle}</p>

        <div className="flex flex-col gap-1.5">
          <button type="button" onClick={() => { client.navigate({ kind: 'page', id: rowId }); onClose() }}
            className="text-left text-sm text-white/85 px-3 py-3 rounded-lg bg-white/[0.04] active:bg-white/[0.08]">↗ Open</button>
          <button type="button" onClick={duplicate}
            className="text-left text-sm text-white/85 px-3 py-3 rounded-lg bg-white/[0.04] active:bg-white/[0.08]">📋 Duplicate</button>
          {rowUrl && (
            <button type="button" onClick={copyLink}
              className="text-left text-sm text-white/85 px-3 py-3 rounded-lg bg-white/[0.04] active:bg-white/[0.08]">🔗 Copy link</button>
          )}
          {rowUrl && (
            <a href={rowUrl} target="_blank" rel="noreferrer"
              className="text-left text-sm text-blue-400 px-3 py-3 rounded-lg bg-white/[0.04] active:bg-white/[0.08]">↗ Open in Notion</a>
          )}
          <button type="button" onClick={archive}
            className="text-left text-sm text-red-300 px-3 py-3 rounded-lg bg-red-500/10 active:bg-red-500/20">🗑️ Archive</button>
        </div>

        <button type="button" onClick={onClose}
          className="mt-4 w-full h-11 rounded-xl bg-white/[0.04] text-white/65 text-sm font-semibold active:bg-white/10">
          Cancel
        </button>
      </div>
    </div>
  )
}
