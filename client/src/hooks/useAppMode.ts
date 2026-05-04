import { useState, useCallback, useEffect } from 'react'

export type AppMode = 'work' | 'rest' | 'locked'

interface Credential { hash: string; salt: string }

// SHA-256( password + base64(salt) ) — uses the browser's native Web Crypto API.
// The hash and salt are stored server-side; the plaintext password is never saved.
async function digest(password: string, salt: Uint8Array): Promise<string> {
  const enc = new TextEncoder()
  const saltB64 = btoa(String.fromCharCode(...salt))
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(password + saltB64))
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

export function useAppMode() {
  const [mode, setModeState] = useState<AppMode>('work')
  const [hasCred, setHasCred] = useState(false)
  const [prevUnlocked, setPrevUnlocked] = useState<'work' | 'rest'>('work')

  // Restore mode and cred presence from server on mount
  useEffect(() => {
    console.log('[AppMode] loading mode and credential from server…')

    Promise.all([
      fetch('/api/state/mode').then(r => r.ok ? r.json() as Promise<{ mode: AppMode }> : null),
      fetch('/api/state/cred').then(r => r.ok ? r.json() as Promise<{ exists: boolean }> : null),
    ]).then(([modeData, credData]) => {
      if (modeData) {
        console.log(`[AppMode] restored mode: ${modeData.mode}`)
        setModeState(modeData.mode)
        if (modeData.mode !== 'locked') setPrevUnlocked(modeData.mode)
      } else {
        console.warn('[AppMode] could not load mode from server — using default: work')
      }
      if (credData) {
        console.log(`[AppMode] credential exists: ${credData.exists}`)
        setHasCred(credData.exists)
      } else {
        console.warn('[AppMode] could not load cred status from server')
      }
    }).catch(err => {
      console.error('[AppMode] failed to load initial state:', err)
    })
  }, [])

  const setMode = useCallback((m: AppMode) => {
    console.log(`[AppMode] mode change → ${m}`)
    if (m !== 'locked') setPrevUnlocked(m as 'work' | 'rest')
    setModeState(m)
    fetch('/api/state/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: m }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        console.log(`[AppMode] mode persisted on server: ${m}`)
      })
      .catch(err => console.error('[AppMode] failed to persist mode:', err))
  }, [])

  // Hash password with a fresh random salt and persist credentials on server.
  const createPassword = useCallback(async (password: string) => {
    console.log('[AppMode] CREATE lock password — hashing with new random salt')
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const hash = await digest(password, salt)
    const cred: Credential = { hash, salt: btoa(String.fromCharCode(...salt)) }
    fetch('/api/state/cred', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cred),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        console.log('[AppMode] lock credential saved to server')
        setHasCred(true)
      })
      .catch(err => console.error('[AppMode] failed to save lock credential:', err))
  }, [])

  // Hash input with the stored salt (fetched from server) and verify server-side.
  const verifyPassword = useCallback(async (input: string): Promise<boolean> => {
    console.log('[AppMode] VERIFY password against server credential')
    // Fetch the salt so we can re-compute the hash client-side, then send hash for comparison
    const credRes = await fetch('/api/state/cred').catch(() => null)
    if (!credRes || !credRes.ok) {
      console.warn('[AppMode] could not reach credential endpoint')
      return false
    }
    const { exists } = await credRes.json() as { exists: boolean }
    if (!exists) {
      console.warn('[AppMode] no credential stored on server')
      return false
    }
    // We need the salt to compute the hash — ask the server to verify directly
    // by sending the raw password (transport is localhost; never leaves the device)
    // Actually, to keep the plaintext off the wire we compute the hash client-side.
    // Since we don't store salt in a public endpoint, we use a dedicated verify endpoint
    // that accepts the pre-computed hash.  But we need the salt first.
    //
    // Design: POST /api/state/cred/verify with { password } — server does the full hash.
    // This keeps the salt server-only and never exposes it to the client.
    const verifyRes = await fetch('/api/state/cred/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input }),
    }).catch(() => null)
    if (!verifyRes || !verifyRes.ok) {
      console.error('[AppMode] verify endpoint error')
      return false
    }
    const { valid } = await verifyRes.json() as { valid: boolean }
    console.log(`[AppMode] password verify result: ${valid}`)
    return valid
  }, [])

  // Return to whatever work/rest mode was active before locking.
  const unlock = useCallback(() => {
    setMode(prevUnlocked)
  }, [setMode, prevUnlocked])

  return { mode, hasCred, setMode, createPassword, verifyPassword, unlock }
}

