import { useCallback, useEffect, useRef } from 'react'

/**
 * A callback that runs a moment after the last call, plus `flush` to run a
 * pending one now and `cancel` to drop it. For a field that saves to the
 * server as it is typed: every keystroke is a call, one POST goes out once the
 * typing pauses, and the flush on "editing ended" makes the last value land
 * without waiting. Always calls the latest `fn`, so a stale closure can't save
 * against last render's props. A call still pending on unmount is flushed
 * rather than lost.
 */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delayMs: number) {
  const latest = useRef(fn)
  useEffect(() => { latest.current = fn }, [fn])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<A | null>(null)

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    pending.current = null
  }, [])

  const flush = useCallback(() => {
    const args = pending.current
    cancel()
    if (args) latest.current(...args)
  }, [cancel])

  const call = useCallback((...args: A) => {
    pending.current = args
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, delayMs)
  }, [delayMs, flush])

  useEffect(() => () => { flush() }, [flush])

  return { call, flush, cancel }
}
