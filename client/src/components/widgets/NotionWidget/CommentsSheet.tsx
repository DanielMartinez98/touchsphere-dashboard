import { useState, useEffect, useCallback } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import { TouchInput } from '../../TouchInput'

interface Comment { id: string; text: string; createdBy: any; createdAt: string }

export default function CommentsSheet({
  pageId, client, onClose,
}: {
  pageId: string
  client: NotionClient
  onClose: () => void
}) {
  const [comments, setComments] = useState<Comment[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [draft,    setDraft]    = useState('')
  const [posting,  setPosting]  = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { comments } = await client.getComments(pageId)
      setComments(comments)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load comments')
    } finally { setLoading(false) }
  }, [pageId, client])

  useEffect(() => { void load() }, [load])

  async function post() {
    const text = draft.trim()
    if (!text) return
    setPosting(true)
    try {
      await client.postComment(pageId, text)
      setDraft('')
      await load()
    } catch (e: any) {
      setError(e.message ?? 'Failed to post comment')
    } finally { setPosting(false) }
  }

  function fmtDate(iso: string): string {
    const d = new Date(iso)
    const today = new Date()
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl z-40 max-h-[85vh] flex flex-col"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-3 pb-2 flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
          <h3 className="text-sm font-bold text-white">Comments</h3>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-3 space-y-3">
          {loading && (
            <div className="flex justify-center py-8">
              <span className="w-6 h-6 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" />
            </div>
          )}
          {!loading && error && <p className="text-sm text-red-400">{error}</p>}
          {!loading && !error && comments.length === 0 && (
            <p className="text-sm text-white/30 italic text-center py-6">No comments yet.</p>
          )}
          {comments.map(c => (
            <div key={c.id} className="bg-white/[0.04] rounded-xl p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-white/70">
                  {c.createdBy?.name ?? c.createdBy?.id?.slice(0, 8) ?? 'Unknown'}
                </span>
                <span className="text-[10px] text-white/30">{fmtDate(c.createdAt)}</span>
              </div>
              <p className="text-sm text-white/85 whitespace-pre-wrap">{c.text}</p>
            </div>
          ))}
        </div>

        <div className="flex-shrink-0 px-5 pt-2 pb-6 border-t border-white/[0.06] flex gap-2">
          <TouchInput value={draft} onChange={setDraft} commitOn="change"
            placeholder="Add a comment…" ariaLabel="Comment text" multiline rows={1}
            className="flex-1 bg-white/[0.06] text-white text-sm rounded-xl px-3 py-2 outline-none placeholder-white/25 resize-none"
          />
          <button type="button" onClick={post} disabled={!draft.trim() || posting}
            className="px-4 rounded-xl bg-green-500 text-black text-sm font-bold disabled:opacity-30 active:bg-green-400">
            Post
          </button>
        </div>
      </div>
    </div>
  )
}
