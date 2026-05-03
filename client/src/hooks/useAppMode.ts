import { useState, useCallback } from 'react'

export type AppMode = 'work' | 'rest' | 'locked'

const LS_MODE = 'ts_mode'
const LS_CRED = 'ts_lock_cred'

interface Credential { hash: string; salt: string }

function readMode(): AppMode {
  try { return (localStorage.getItem(LS_MODE) as AppMode | null) ?? 'work' }
  catch { return 'work' }
}

function readCred(): Credential | null {
  try {
    const raw = localStorage.getItem(LS_CRED)
    return raw ? (JSON.parse(raw) as Credential) : null
  } catch { return null }
}

// SHA-256( password + base64(salt) ) — uses the browser's native Web Crypto API.
// The hash and salt are stored in localStorage; the plaintext password is never saved.
async function digest(password: string, salt: Uint8Array): Promise<string> {
  const enc = new TextEncoder()
  const saltB64 = btoa(String.fromCharCode(...salt))
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(password + saltB64))
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

export function useAppMode() {
  const [mode, setModeState] = useState<AppMode>(readMode)
  const [hasCred, setHasCred] = useState(() => readCred() !== null)

  // Track the last non-locked mode so we know where to return after unlock
  const [prevUnlocked, setPrevUnlocked] = useState<'work' | 'rest'>(() => {
    const m = readMode()
    return m === 'locked' ? 'work' : m
  })

  const setMode = useCallback((m: AppMode) => {
    if (m !== 'locked') setPrevUnlocked(m as 'work' | 'rest')
    setModeState(m)
    try { localStorage.setItem(LS_MODE, m) } catch {}
  }, [])

  // Hash password with a fresh random salt and persist credentials.
  const createPassword = useCallback(async (password: string) => {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const hash = await digest(password, salt)
    const cred: Credential = { hash, salt: btoa(String.fromCharCode(...salt)) }
    try { localStorage.setItem(LS_CRED, JSON.stringify(cred)) } catch {}
    setHasCred(true)
  }, [])

  // Hash input with stored salt and compare — returns true if correct.
  const verifyPassword = useCallback(async (input: string): Promise<boolean> => {
    const cred = readCred()
    if (!cred) return false
    const salt = Uint8Array.from(atob(cred.salt), c => c.charCodeAt(0))
    const hash = await digest(input, salt)
    return hash === cred.hash
  }, [])

  // Return to whatever work/rest mode was active before locking.
  const unlock = useCallback(() => {
    setMode(prevUnlocked)
  }, [setMode, prevUnlocked])

  return { mode, hasCred, setMode, createPassword, verifyPassword, unlock }
}
